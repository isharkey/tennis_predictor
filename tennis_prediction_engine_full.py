"""
tennis_prediction_engine_full.py

All-in-one starter tennis prediction engine.

Includes:
- Monte Carlo match simulator
- Analytical point/game/set/match model
- Poisson prop/count model
- Surface Elo
- Glicko-lite rating model
- Bradley-Terry style rating model
- Logistic regression model
- Gradient boosting model
- Markov-style live match simulator
- Bayesian live updating
- Market/no-vig odds model
- Weather, fatigue, injury, and matchup adjustments
- Calibration model
- Final ensemble prediction engine

Install optional ML dependencies:
    pip install pandas scikit-learn joblib

Run:
    python tennis_prediction_engine_full.py
"""

from __future__ import annotations

import json
import math
import random
from collections import Counter
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

try:
    import pandas as pd
except Exception:
    pd = None

try:
    import joblib
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.isotonic import IsotonicRegression
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    SKLEARN_AVAILABLE = True
except Exception:
    joblib = None
    SKLEARN_AVAILABLE = False


# ============================================================
# Utility functions
# ============================================================


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def american_odds_to_probability(odds: float) -> float:
    """Convert American odds into implied probability."""
    if odds < 0:
        return abs(odds) / (abs(odds) + 100)
    return 100 / (odds + 100)


def probability_to_american_odds(probability: float) -> int:
    """Convert probability into fair American odds."""
    probability = clamp(probability, 0.0001, 0.9999)
    if probability >= 0.5:
        return round(-100 * probability / (1 - probability))
    return round(100 * (1 - probability) / probability)


def probability_to_decimal_odds(probability: float) -> float:
    """Convert probability into fair decimal odds."""
    probability = clamp(probability, 0.0001, 0.9999)
    return round(1 / probability, 2)


def no_vig_two_way_probability(odds_a: float, odds_b: float) -> Dict[str, float]:
    """Remove sportsbook margin from a two-way market."""
    implied_a = american_odds_to_probability(odds_a)
    implied_b = american_odds_to_probability(odds_b)
    total = implied_a + implied_b
    return {
        "a_no_vig_probability": implied_a / total,
        "b_no_vig_probability": implied_b / total,
        "sportsbook_hold": total - 1,
        "a_raw_implied_probability": implied_a,
        "b_raw_implied_probability": implied_b,
    }


def elo_expected_probability(rating_a: float, rating_b: float) -> float:
    return 1 / (1 + 10 ** ((rating_b - rating_a) / 400))


def weighted_average(probabilities: Dict[str, Optional[float]], weights: Dict[str, float]) -> float:
    """Average only the models that produced a probability."""
    total_weight = 0.0
    weighted_sum = 0.0

    for key, probability in probabilities.items():
        if probability is None:
            continue

        weight = weights.get(key, 0.0)
        if weight <= 0:
            continue

        weighted_sum += probability * weight
        total_weight += weight

    if total_weight == 0:
        return 0.5

    return weighted_sum / total_weight


# ============================================================
# Data objects
# ============================================================


@dataclass
class PlayerSnapshot:
    name: str

    # Core serve/return stats.
    service_points_won: float = 0.62
    return_points_won: float = 0.38
    hold_pct: float = 0.80
    break_pct: float = 0.22

    # Ratings.
    rank: Optional[int] = None
    overall_elo: float = 1500.0
    surface_elo: Dict[str, float] = field(default_factory=dict)
    glicko_rating: float = 1500.0
    glicko_rd: float = 250.0

    # Form and surface stats.
    recent_win_pct: float = 0.50
    surface_win_pct: float = 0.50
    surface_hold_pct: float = 0.80
    surface_break_pct: float = 0.22

    # Weather, fatigue, schedule, and injury.
    rest_days: float = 2.0
    last_match_minutes: float = 90.0
    sets_played_last_7_days: float = 3.0
    matches_played_last_7_days: float = 1.0
    injury_flag: bool = False
    weather_sensitivity: float = 0.0

    # Props/counts.
    aces_avg: float = 5.0
    aces_allowed_avg: float = 5.0
    double_faults_avg: float = 3.0
    double_faults_allowed_avg: float = 3.0

    # Matchup.
    style: str = "balanced"
    h2h_wins: int = 0
    h2h_losses: int = 0

    def get_surface_elo(self, surface: str) -> float:
        return self.surface_elo.get(surface, self.overall_elo)


@dataclass
class WeatherContext:
    indoor: bool = False
    temperature_f: float = 72.0
    wind_mph: float = 0.0
    humidity_pct: float = 45.0
    precipitation_chance: float = 0.0


@dataclass
class PredictionResult:
    player_a: str
    player_b: str
    surface: str
    best_of: int
    component_probabilities: Dict[str, Optional[float]]
    final_probability_a: float
    final_probability_b: float
    fair_american_odds_a: int
    fair_american_odds_b: int
    fair_decimal_odds_a: float
    fair_decimal_odds_b: float
    sportsbook_odds_a: Optional[float] = None
    sportsbook_odds_b: Optional[float] = None
    no_vig_market_probability_a: Optional[float] = None
    edge_a_pct: Optional[float] = None
    edge_b_pct: Optional[float] = None
    recommendation: str = "No bet"


# ============================================================
# Serve point projection
# ============================================================


def project_serve_point_probability(
    server: PlayerSnapshot,
    returner: PlayerSnapshot,
    surface: str = "hard",
    surface_elo_adjustment: float = 0.0,
    fatigue_adjustment: float = 0.0,
    matchup_adjustment: float = 0.0,
    weather_adjustment: float = 0.0,
) -> float:
    """
    Core input used by Monte Carlo, analytical, and live models.

    Basic idea:
    projected server point win % = average of server serve strength
    and opponent return weakness, plus small context adjustments.
    """
    _ = surface
    base = (server.service_points_won + (1 - returner.return_points_won)) / 2
    surface_hold_signal = (server.surface_hold_pct - server.hold_pct) * 0.25
    adjusted = (
        base
        + surface_hold_signal
        + surface_elo_adjustment
        + fatigue_adjustment
        + matchup_adjustment
        + weather_adjustment
    )
    return clamp(adjusted, 0.45, 0.75)


# ============================================================
# 1. Monte Carlo model
# ============================================================


class MonteCarloTennisModel:
    def __init__(self, seed: Optional[int] = None):
        self.random = random.Random(seed)

    def simulate_service_game(self, p_server_wins_point: float) -> bool:
        """Return True if the server holds."""
        server_points = 0
        returner_points = 0

        while True:
            if self.random.random() < p_server_wins_point:
                server_points += 1
            else:
                returner_points += 1

            if server_points >= 4 and server_points - returner_points >= 2:
                return True
            if returner_points >= 4 and returner_points - server_points >= 2:
                return False

    def simulate_tiebreak(self, p_a_serve: float, p_b_serve: float, first_server: str) -> str:
        a_points = 0
        b_points = 0
        point_index = 0

        while True:
            if point_index == 0:
                server = first_server
            else:
                block = (point_index - 1) // 2
                if block % 2 == 0:
                    server = "B" if first_server == "A" else "A"
                else:
                    server = first_server

            if server == "A":
                a_wins_point = self.random.random() < p_a_serve
            else:
                a_wins_point = self.random.random() > p_b_serve

            if a_wins_point:
                a_points += 1
            else:
                b_points += 1

            if a_points >= 7 and a_points - b_points >= 2:
                return "A"
            if b_points >= 7 and b_points - a_points >= 2:
                return "B"

            point_index += 1

    def simulate_set(self, p_a_serve: float, p_b_serve: float, starting_server: str) -> Tuple[str, str, str]:
        a_games = 0
        b_games = 0
        server = starting_server

        while True:
            if a_games == 6 and b_games == 6:
                winner = self.simulate_tiebreak(p_a_serve, p_b_serve, server)
                next_server = "B" if server == "A" else "A"
                return winner, next_server, "7-6" if winner == "A" else "6-7"

            if server == "A":
                if self.simulate_service_game(p_a_serve):
                    a_games += 1
                else:
                    b_games += 1
            else:
                if self.simulate_service_game(p_b_serve):
                    b_games += 1
                else:
                    a_games += 1

            server = "B" if server == "A" else "A"

            if a_games >= 6 and a_games - b_games >= 2:
                return "A", server, f"{a_games}-{b_games}"
            if b_games >= 6 and b_games - a_games >= 2:
                return "B", server, f"{a_games}-{b_games}"

    def simulate_match(
        self,
        p_a_serve: float,
        p_b_serve: float,
        best_of: int = 3,
        first_server: Optional[str] = None,
    ) -> Tuple[str, str, List[str]]:
        sets_needed = best_of // 2 + 1
        a_sets = 0
        b_sets = 0
        set_scores = []
        server = first_server if first_server else self.random.choice(["A", "B"])

        while a_sets < sets_needed and b_sets < sets_needed:
            set_winner, server, set_score = self.simulate_set(p_a_serve, p_b_serve, server)
            set_scores.append(set_score)

            if set_winner == "A":
                a_sets += 1
            else:
                b_sets += 1

        winner = "A" if a_sets > b_sets else "B"
        return winner, f"{a_sets}-{b_sets}", set_scores

    def predict(
        self,
        p_a_serve: float,
        p_b_serve: float,
        best_of: int = 3,
        simulations: int = 100000,
    ) -> Dict[str, Any]:
        winners = []
        scores = Counter()

        for _ in range(simulations):
            winner, match_score, set_scores = self.simulate_match(p_a_serve, p_b_serve, best_of)
            winners.append(winner)
            scores[f"{winner} {match_score} ({', '.join(set_scores)})"] += 1

        p_a = winners.count("A") / simulations
        p_b = 1 - p_a

        return {
            "player_a_win_probability": p_a,
            "player_b_win_probability": p_b,
            "fair_decimal_odds_a": probability_to_decimal_odds(p_a),
            "fair_decimal_odds_b": probability_to_decimal_odds(p_b),
            "fair_american_odds_a": probability_to_american_odds(p_a),
            "fair_american_odds_b": probability_to_american_odds(p_b),
            "most_common_scores": scores.most_common(8),
            "simulations": simulations,
        }


# ============================================================
# 2. Analytical model
# ============================================================


class AnalyticalTennisModel:
    def service_game_hold_probability(self, p_server_wins_point: float) -> float:
        p = p_server_wins_point
        q = 1 - p

        win_before_deuce = p**4 * (1 + 4 * q + 10 * q**2)
        reach_deuce = 20 * p**3 * q**3
        win_from_deuce = p**2 / (p**2 + q**2)
        return win_before_deuce + reach_deuce * win_from_deuce

    def other_player(self, player: str) -> str:
        return "B" if player == "A" else "A"

    def tiebreak_server(self, first_server: str, point_index: int) -> str:
        if point_index == 0:
            return first_server

        block = (point_index - 1) // 2
        if block % 2 == 0:
            return self.other_player(first_server)
        return first_server

    def tiebreak_win_probability(
        self,
        p_a_serve: float,
        p_b_serve: float,
        first_server: str = "A",
        max_points: int = 80,
    ) -> float:
        states = {(0, 0): 1.0}
        a_win_probability = 0.0

        for point_index in range(max_points):
            new_states = {}

            for (a_points, b_points), state_probability in states.items():
                if a_points >= 7 and a_points - b_points >= 2:
                    a_win_probability += state_probability
                    continue
                if b_points >= 7 and b_points - a_points >= 2:
                    continue

                server = self.tiebreak_server(first_server, point_index)
                if server == "A":
                    p_a_wins_point = p_a_serve
                else:
                    p_a_wins_point = 1 - p_b_serve

                state_a = (a_points + 1, b_points)
                state_b = (a_points, b_points + 1)
                new_states[state_a] = new_states.get(state_a, 0.0) + state_probability * p_a_wins_point
                new_states[state_b] = new_states.get(state_b, 0.0) + state_probability * (1 - p_a_wins_point)

            states = new_states

        # Tiny unresolved tail after max_points. Splitting ties keeps the estimate stable.
        for (a_points, b_points), state_probability in states.items():
            if a_points > b_points:
                a_win_probability += state_probability
            elif a_points == b_points:
                a_win_probability += 0.5 * state_probability

        return a_win_probability

    def set_win_probability(self, p_a_serve: float, p_b_serve: float, starting_server: str = "A") -> float:
        hold_a = self.service_game_hold_probability(p_a_serve)
        hold_b = self.service_game_hold_probability(p_b_serve)

        @lru_cache(None)
        def dp(a_games: int, b_games: int, server: str) -> float:
            if a_games >= 6 and a_games - b_games >= 2:
                return 1.0
            if b_games >= 6 and b_games - a_games >= 2:
                return 0.0
            if a_games == 6 and b_games == 6:
                return self.tiebreak_win_probability(p_a_serve, p_b_serve, server)

            next_server = self.other_player(server)
            if server == "A":
                return hold_a * dp(a_games + 1, b_games, next_server) + (1 - hold_a) * dp(
                    a_games, b_games + 1, next_server
                )

            return (1 - hold_b) * dp(a_games + 1, b_games, next_server) + hold_b * dp(
                a_games, b_games + 1, next_server
            )

        return dp(0, 0, starting_server)

    def match_win_probability(self, set_win_probability_a: float, best_of: int = 3) -> float:
        sets_needed = best_of // 2 + 1
        p = set_win_probability_a
        q = 1 - p
        probability = 0.0

        for losses_before_final_set in range(sets_needed):
            probability += (
                math.comb(sets_needed - 1 + losses_before_final_set, losses_before_final_set)
                * p**sets_needed
                * q**losses_before_final_set
            )

        return probability

    def predict(self, p_a_serve: float, p_b_serve: float, best_of: int = 3) -> Dict[str, Any]:
        set_a_starts = self.set_win_probability(p_a_serve, p_b_serve, "A")
        set_b_starts = self.set_win_probability(p_a_serve, p_b_serve, "B")
        set_prob = (set_a_starts + set_b_starts) / 2
        match_prob = self.match_win_probability(set_prob, best_of)

        return {
            "player_a_set_probability": set_prob,
            "player_a_match_probability": match_prob,
            "player_b_match_probability": 1 - match_prob,
            "player_a_hold_probability": self.service_game_hold_probability(p_a_serve),
            "player_b_hold_probability": self.service_game_hold_probability(p_b_serve),
        }


# ============================================================
# 3. Poisson prop/count model
# ============================================================


class PoissonTennisModel:
    def pmf(self, k: int, lam: float) -> float:
        if k < 0:
            return 0.0
        return (math.exp(-lam) * lam**k) / math.factorial(k)

    def cdf(self, k: int, lam: float) -> float:
        if k < 0:
            return 0.0
        return sum(self.pmf(i, lam) for i in range(k + 1))

    def probability_at_least(self, k: int, lam: float) -> float:
        return 1 - self.cdf(k - 1, lam)

    def probability_over_line(self, line: float, lam: float) -> float:
        needed = math.floor(line) + 1
        return self.probability_at_least(needed, lam)

    def probability_under_line(self, line: float, lam: float) -> float:
        if line == int(line):
            max_result = int(line) - 1
        else:
            max_result = math.floor(line)
        return self.cdf(max_result, lam)

    def estimate_lambda(
        self,
        player_average: float,
        opponent_allowed_average: float,
        surface_adjustment: float = 0.0,
        form_adjustment: float = 0.0,
        matchup_adjustment: float = 0.0,
        pace_adjustment: float = 0.0,
        match_length_multiplier: float = 1.0,
    ) -> float:
        lam = (player_average + opponent_allowed_average) / 2
        lam = (lam + surface_adjustment + form_adjustment + matchup_adjustment + pace_adjustment) * match_length_multiplier
        return max(0.01, lam)

    def analyze_prop(
        self,
        event_name: str,
        player_name: str,
        projected_lambda: float,
        line: float,
        sportsbook_over_odds: Optional[float] = None,
        sportsbook_under_odds: Optional[float] = None,
    ) -> Dict[str, Any]:
        over = self.probability_over_line(line, projected_lambda)
        under = self.probability_under_line(line, projected_lambda)

        result = {
            "event_name": event_name,
            "player_name": player_name,
            "projected_lambda": round(projected_lambda, 3),
            "line": line,
            "over_probability": over,
            "under_probability": under,
            "fair_over_american_odds": probability_to_american_odds(over),
            "fair_under_american_odds": probability_to_american_odds(under),
        }

        if sportsbook_over_odds is not None:
            implied_over = american_odds_to_probability(sportsbook_over_odds)
            result["sportsbook_over_odds"] = sportsbook_over_odds
            result["over_edge_pct"] = round((over - implied_over) * 100, 2)

        if sportsbook_under_odds is not None:
            implied_under = american_odds_to_probability(sportsbook_under_odds)
            result["sportsbook_under_odds"] = sportsbook_under_odds
            result["under_edge_pct"] = round((under - implied_under) * 100, 2)

        return result

    def count_distribution(self, lam: float, max_count: int = 25) -> Dict[int, float]:
        return {k: self.pmf(k, lam) for k in range(max_count + 1)}

    def distribution_table(self, lam: float, max_count: int = 25) -> List[Dict[str, float]]:
        return [
            {
                "count": k,
                "probability": self.pmf(k, lam),
                "fair_american_odds": probability_to_american_odds(self.pmf(k, lam)),
            }
            for k in range(max_count + 1)
        ]

    def compare_two_counts(self, lambda_a: float, lambda_b: float, max_count: int = 40) -> Dict[str, float]:
        a_more = 0.0
        b_more = 0.0
        tie = 0.0

        for a_count in range(max_count + 1):
            for b_count in range(max_count + 1):
                probability = self.pmf(a_count, lambda_a) * self.pmf(b_count, lambda_b)
                if a_count > b_count:
                    a_more += probability
                elif b_count > a_count:
                    b_more += probability
                else:
                    tie += probability

        return {
            "a_more_probability": a_more,
            "b_more_probability": b_more,
            "tie_probability": tie,
            "a_support_probability": a_more + 0.5 * tie,
            "b_support_probability": b_more + 0.5 * tie,
        }


# ============================================================
# 4. Surface Elo model
# ============================================================


VALID_SURFACES = ["hard", "clay", "grass", "indoor_hard"]


@dataclass
class PlayerEloProfile:
    name: str
    overall_elo: float = 1500.0
    surface_elo: Dict[str, float] = field(default_factory=dict)
    overall_matches: int = 0
    surface_matches: Dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for surface in VALID_SURFACES:
            self.surface_elo.setdefault(surface, 1500.0)
            self.surface_matches.setdefault(surface, 0)


class SurfaceEloModel:
    def __init__(
        self,
        base_elo: float = 1500.0,
        k_overall: float = 24.0,
        k_surface: float = 32.0,
        max_surface_weight: float = 0.75,
        matches_for_full_surface_weight: int = 20,
    ):
        self.base_elo = base_elo
        self.k_overall = k_overall
        self.k_surface = k_surface
        self.max_surface_weight = max_surface_weight
        self.matches_for_full_surface_weight = matches_for_full_surface_weight
        self.players: Dict[str, PlayerEloProfile] = {}

    def normalize_surface(self, surface: str) -> str:
        surface = str(surface).lower().strip()
        mapping = {
            "hard court": "hard",
            "outdoor hard": "hard",
            "hardcourt": "hard",
            "indoor": "indoor_hard",
            "indoor hard court": "indoor_hard",
            "indoor hardcourt": "indoor_hard",
            "clay court": "clay",
            "grass court": "grass",
        }
        surface = mapping.get(surface, surface)
        return surface if surface in VALID_SURFACES else "hard"

    def get_player(self, player_name: str) -> PlayerEloProfile:
        if player_name not in self.players:
            self.players[player_name] = PlayerEloProfile(name=player_name, overall_elo=self.base_elo)
        return self.players[player_name]

    def surface_weight(self, player: PlayerEloProfile, surface: str) -> float:
        matches = player.surface_matches.get(surface, 0)
        weight = matches / self.matches_for_full_surface_weight
        return min(weight, self.max_surface_weight)

    def effective_rating(self, player_name: str, surface: str) -> float:
        surface = self.normalize_surface(surface)
        player = self.get_player(player_name)
        surface_weight = self.surface_weight(player, surface)
        return player.surface_elo[surface] * surface_weight + player.overall_elo * (1 - surface_weight)

    def predict_match(self, player_a: str, player_b: str, surface: str) -> Dict[str, Any]:
        surface = self.normalize_surface(surface)
        rating_a = self.effective_rating(player_a, surface)
        rating_b = self.effective_rating(player_b, surface)
        prob_a = elo_expected_probability(rating_a, rating_b)

        return {
            "player_a": player_a,
            "player_b": player_b,
            "surface": surface,
            "player_a_effective_elo": rating_a,
            "player_b_effective_elo": rating_b,
            "player_a_win_probability": prob_a,
            "player_b_win_probability": 1 - prob_a,
            "elo_diff": rating_a - rating_b,
        }

    def update_match(self, player_a: str, player_b: str, surface: str, winner: str) -> Dict[str, Any]:
        surface = self.normalize_surface(surface)
        a = self.get_player(player_a)
        b = self.get_player(player_b)

        rating_a = self.effective_rating(player_a, surface)
        rating_b = self.effective_rating(player_b, surface)
        expected_a = elo_expected_probability(rating_a, rating_b)
        expected_b = 1 - expected_a

        actual_a = 1 if winner == player_a else 0
        actual_b = 1 if winner == player_b else 0

        a.overall_elo += self.k_overall * (actual_a - expected_a)
        b.overall_elo += self.k_overall * (actual_b - expected_b)
        a.surface_elo[surface] += self.k_surface * (actual_a - expected_a)
        b.surface_elo[surface] += self.k_surface * (actual_b - expected_b)

        a.overall_matches += 1
        b.overall_matches += 1
        a.surface_matches[surface] += 1
        b.surface_matches[surface] += 1

        return {
            "player_a_expected": expected_a,
            "player_b_expected": expected_b,
            "player_a_overall_elo_after": a.overall_elo,
            "player_b_overall_elo_after": b.overall_elo,
            "player_a_surface_elo_after": a.surface_elo[surface],
            "player_b_surface_elo_after": b.surface_elo[surface],
        }

    def process_matches_csv(
        self,
        csv_path: str,
        date_column: str = "date",
        player_a_column: str = "player_a",
        player_b_column: str = "player_b",
        surface_column: str = "surface",
        winner_column: str = "winner",
    ) -> Any:
        if pd is None:
            raise ImportError("pandas is required to process CSV files.")

        matches = pd.read_csv(csv_path)
        if date_column in matches.columns:
            matches = matches.sort_values(date_column)

        history = []
        for _, row in matches.iterrows():
            player_a = row[player_a_column]
            player_b = row[player_b_column]
            surface = self.normalize_surface(row[surface_column])
            winner = row[winner_column]

            # Save pre-match ratings before updating to avoid data leakage.
            pre = self.predict_match(player_a, player_b, surface)
            pre["winner"] = winner
            pre["player_a_won"] = 1 if winner == player_a else 0
            history.append(pre)

            self.update_match(player_a, player_b, surface, winner)

        return pd.DataFrame(history)

    def export_current_ratings(self) -> Any:
        rows = []
        for player in self.players.values():
            rows.append(
                {
                    "player": player.name,
                    "overall_elo": player.overall_elo,
                    "overall_matches": player.overall_matches,
                    **{f"{surface}_elo": player.surface_elo[surface] for surface in VALID_SURFACES},
                    **{f"{surface}_matches": player.surface_matches[surface] for surface in VALID_SURFACES},
                }
            )

        if pd is not None:
            return pd.DataFrame(rows)
        return rows


# ============================================================
# 5. Glicko-lite model
# ============================================================


@dataclass
class GlickoLitePlayer:
    name: str
    rating: float = 1500.0
    rd: float = 250.0
    matches: int = 0


class GlickoLiteModel:
    """
    A beginner-friendly Glicko-style model.

    This is not a full official Glicko implementation. It uses Elo-like
    probabilities and lets rating deviation pull uncertain players closer to 50%.
    """

    def __init__(self, base_rating: float = 1500.0, base_rd: float = 250.0, k: float = 28.0):
        self.base_rating = base_rating
        self.base_rd = base_rd
        self.k = k
        self.players: Dict[str, GlickoLitePlayer] = {}

    def get_player(self, name: str) -> GlickoLitePlayer:
        if name not in self.players:
            self.players[name] = GlickoLitePlayer(name=name, rating=self.base_rating, rd=self.base_rd)
        return self.players[name]

    def predict_ratings(self, rating_a: float, rating_b: float, rd_a: float, rd_b: float) -> float:
        base = elo_expected_probability(rating_a, rating_b)
        uncertainty = clamp((rd_a + rd_b - 100) / 600, 0, 1)
        return base * (1 - 0.25 * uncertainty) + 0.5 * (0.25 * uncertainty)

    def predict_match(self, player_a: str, player_b: str) -> Dict[str, float]:
        a = self.get_player(player_a)
        b = self.get_player(player_b)
        prob_a = self.predict_ratings(a.rating, b.rating, a.rd, b.rd)
        return {
            "player_a_win_probability": prob_a,
            "player_b_win_probability": 1 - prob_a,
            "player_a_rating": a.rating,
            "player_b_rating": b.rating,
            "player_a_rd": a.rd,
            "player_b_rd": b.rd,
        }

    def update_match(self, player_a: str, player_b: str, winner: str) -> Dict[str, float]:
        a = self.get_player(player_a)
        b = self.get_player(player_b)
        expected_a = self.predict_ratings(a.rating, b.rating, a.rd, b.rd)
        actual_a = 1 if winner == player_a else 0
        actual_b = 1 - actual_a

        rd_multiplier_a = clamp(a.rd / 250, 0.5, 1.5)
        rd_multiplier_b = clamp(b.rd / 250, 0.5, 1.5)
        a.rating += self.k * rd_multiplier_a * (actual_a - expected_a)
        b.rating += self.k * rd_multiplier_b * (actual_b - (1 - expected_a))
        a.rd = clamp(a.rd * 0.94, 55, 350)
        b.rd = clamp(b.rd * 0.94, 55, 350)
        a.matches += 1
        b.matches += 1

        return {
            "player_a_rating_after": a.rating,
            "player_b_rating_after": b.rating,
            "player_a_rd_after": a.rd,
            "player_b_rd_after": b.rd,
        }


# ============================================================
# 6. Bradley-Terry model
# ============================================================


class BradleyTerryModel:
    def __init__(self, learning_rate: float = 0.08):
        self.learning_rate = learning_rate
        self.ratings: Dict[str, float] = {}

    def get_rating(self, player_name: str) -> float:
        self.ratings.setdefault(player_name, 0.0)
        return self.ratings[player_name]

    def predict_from_ratings(self, rating_a: float, rating_b: float) -> float:
        diff = clamp(rating_a - rating_b, -20, 20)
        return 1 / (1 + math.exp(-diff))

    def predict_match(self, player_a: str, player_b: str) -> Dict[str, float]:
        rating_a = self.get_rating(player_a)
        rating_b = self.get_rating(player_b)
        probability_a = self.predict_from_ratings(rating_a, rating_b)
        return {
            "player_a_win_probability": probability_a,
            "player_b_win_probability": 1 - probability_a,
            "player_a_bt_rating": rating_a,
            "player_b_bt_rating": rating_b,
        }

    def update_match(self, player_a: str, player_b: str, winner: str) -> Dict[str, float]:
        rating_a = self.get_rating(player_a)
        rating_b = self.get_rating(player_b)
        expected_a = self.predict_from_ratings(rating_a, rating_b)
        actual_a = 1 if winner == player_a else 0

        adjustment = self.learning_rate * (actual_a - expected_a)
        self.ratings[player_a] = rating_a + adjustment
        self.ratings[player_b] = rating_b - adjustment

        return {
            "player_a_bt_rating_after": self.ratings[player_a],
            "player_b_bt_rating_after": self.ratings[player_b],
        }


# ============================================================
# Shared feature helpers for ML models
# ============================================================


DEFAULT_FEATURE_COLUMNS = [
    "elo_diff",
    "surface_elo_diff",
    "glicko_rating_diff",
    "glicko_rd_diff",
    "rank_diff",
    "service_points_won_diff",
    "return_points_won_diff",
    "hold_pct_diff",
    "break_pct_diff",
    "recent_win_pct_diff",
    "surface_win_pct_diff",
    "surface_hold_pct_diff",
    "surface_break_pct_diff",
    "rest_days_diff",
    "sets_played_last_7_days_diff",
    "last_match_minutes_diff",
    "injury_diff",
    "weather_sensitivity_diff",
]


def add_difference_features(row: Dict[str, Any]) -> Dict[str, Any]:
    pairs = {
        "elo_diff": ("a_elo", "b_elo"),
        "surface_elo_diff": ("a_surface_elo", "b_surface_elo"),
        "glicko_rating_diff": ("a_glicko_rating", "b_glicko_rating"),
        "glicko_rd_diff": ("a_glicko_rd", "b_glicko_rd"),
        "rank_diff": ("b_rank", "a_rank"),
        "service_points_won_diff": ("a_service_points_won", "b_service_points_won"),
        "return_points_won_diff": ("a_return_points_won", "b_return_points_won"),
        "hold_pct_diff": ("a_hold_pct", "b_hold_pct"),
        "break_pct_diff": ("a_break_pct", "b_break_pct"),
        "recent_win_pct_diff": ("a_recent_win_pct", "b_recent_win_pct"),
        "surface_win_pct_diff": ("a_surface_win_pct", "b_surface_win_pct"),
        "surface_hold_pct_diff": ("a_surface_hold_pct", "b_surface_hold_pct"),
        "surface_break_pct_diff": ("a_surface_break_pct", "b_surface_break_pct"),
        "rest_days_diff": ("a_rest_days", "b_rest_days"),
        "sets_played_last_7_days_diff": ("b_sets_played_last_7_days", "a_sets_played_last_7_days"),
        "last_match_minutes_diff": ("b_last_match_minutes", "a_last_match_minutes"),
        "injury_diff": ("b_injury_flag", "a_injury_flag"),
        "weather_sensitivity_diff": ("a_weather_sensitivity", "b_weather_sensitivity"),
    }

    for new_column, (left, right) in pairs.items():
        if new_column not in row and left in row and right in row:
            row[new_column] = float(row[left]) - float(row[right])

    return row


def build_match_row(
    player_a: PlayerSnapshot,
    player_b: PlayerSnapshot,
    surface: str,
    market_no_vig_prob_a: Optional[float] = None,
    weather_context: Optional[WeatherContext] = None,
) -> Dict[str, Any]:
    a_surface_elo = player_a.get_surface_elo(surface)
    b_surface_elo = player_b.get_surface_elo(surface)
    weather_context = weather_context or WeatherContext()

    row = {
        "a_elo": player_a.overall_elo,
        "b_elo": player_b.overall_elo,
        "a_surface_elo": a_surface_elo,
        "b_surface_elo": b_surface_elo,
        "a_glicko_rating": player_a.glicko_rating,
        "b_glicko_rating": player_b.glicko_rating,
        "a_glicko_rd": player_a.glicko_rd,
        "b_glicko_rd": player_b.glicko_rd,
        "a_rank": player_a.rank if player_a.rank is not None else 999,
        "b_rank": player_b.rank if player_b.rank is not None else 999,
        "a_service_points_won": player_a.service_points_won,
        "b_service_points_won": player_b.service_points_won,
        "a_return_points_won": player_a.return_points_won,
        "b_return_points_won": player_b.return_points_won,
        "a_hold_pct": player_a.hold_pct,
        "b_hold_pct": player_b.hold_pct,
        "a_break_pct": player_a.break_pct,
        "b_break_pct": player_b.break_pct,
        "a_recent_win_pct": player_a.recent_win_pct,
        "b_recent_win_pct": player_b.recent_win_pct,
        "a_surface_win_pct": player_a.surface_win_pct,
        "b_surface_win_pct": player_b.surface_win_pct,
        "a_surface_hold_pct": player_a.surface_hold_pct,
        "b_surface_hold_pct": player_b.surface_hold_pct,
        "a_surface_break_pct": player_a.surface_break_pct,
        "b_surface_break_pct": player_b.surface_break_pct,
        "a_rest_days": player_a.rest_days,
        "b_rest_days": player_b.rest_days,
        "a_sets_played_last_7_days": player_a.sets_played_last_7_days,
        "b_sets_played_last_7_days": player_b.sets_played_last_7_days,
        "a_last_match_minutes": player_a.last_match_minutes,
        "b_last_match_minutes": player_b.last_match_minutes,
        "a_injury_flag": int(player_a.injury_flag),
        "b_injury_flag": int(player_b.injury_flag),
        "a_weather_sensitivity": player_a.weather_sensitivity,
        "b_weather_sensitivity": player_b.weather_sensitivity,
        "temperature_f": weather_context.temperature_f,
        "wind_mph": weather_context.wind_mph,
        "humidity_pct": weather_context.humidity_pct,
        "precipitation_chance": weather_context.precipitation_chance,
        "is_indoor": int(weather_context.indoor),
    }

    if market_no_vig_prob_a is not None:
        row["market_no_vig_prob_a"] = market_no_vig_prob_a

    return add_difference_features(row)


def ensure_difference_columns(dataframe: Any) -> Any:
    for _, row in dataframe.iterrows():
        add_difference_features(row.to_dict())

    for feature in DEFAULT_FEATURE_COLUMNS:
        if feature not in dataframe.columns:
            left_right = {
                "elo_diff": ("a_elo", "b_elo"),
                "surface_elo_diff": ("a_surface_elo", "b_surface_elo"),
                "glicko_rating_diff": ("a_glicko_rating", "b_glicko_rating"),
                "glicko_rd_diff": ("a_glicko_rd", "b_glicko_rd"),
                "rank_diff": ("b_rank", "a_rank"),
                "service_points_won_diff": ("a_service_points_won", "b_service_points_won"),
                "return_points_won_diff": ("a_return_points_won", "b_return_points_won"),
                "hold_pct_diff": ("a_hold_pct", "b_hold_pct"),
                "break_pct_diff": ("a_break_pct", "b_break_pct"),
                "recent_win_pct_diff": ("a_recent_win_pct", "b_recent_win_pct"),
                "surface_win_pct_diff": ("a_surface_win_pct", "b_surface_win_pct"),
                "surface_hold_pct_diff": ("a_surface_hold_pct", "b_surface_hold_pct"),
                "surface_break_pct_diff": ("a_surface_break_pct", "b_surface_break_pct"),
                "rest_days_diff": ("a_rest_days", "b_rest_days"),
                "sets_played_last_7_days_diff": ("b_sets_played_last_7_days", "a_sets_played_last_7_days"),
                "last_match_minutes_diff": ("b_last_match_minutes", "a_last_match_minutes"),
                "injury_diff": ("b_injury_flag", "a_injury_flag"),
                "weather_sensitivity_diff": ("a_weather_sensitivity", "b_weather_sensitivity"),
            }
            left, right = left_right[feature]
            if left in dataframe.columns and right in dataframe.columns:
                dataframe[feature] = dataframe[left] - dataframe[right]

    return dataframe


# ============================================================
# 7. Logistic regression model
# ============================================================


class TennisRegressionModel:
    def __init__(self):
        self.model = None
        self.feature_columns = DEFAULT_FEATURE_COLUMNS.copy()

    def train(
        self,
        csv_path: str,
        target_column: str = "player_a_won",
        feature_columns: Optional[List[str]] = None,
        test_size: float = 0.2,
        random_state: int = 42,
    ) -> Dict[str, Any]:
        if not SKLEARN_AVAILABLE or pd is None:
            raise ImportError("pandas, scikit-learn, and joblib are required to train this model.")

        data = pd.read_csv(csv_path)
        data = ensure_difference_columns(data)

        self.feature_columns = feature_columns or [column for column in DEFAULT_FEATURE_COLUMNS if column in data.columns]
        if "market_no_vig_prob_a" in data.columns:
            self.feature_columns.append("market_no_vig_prob_a")

        if target_column not in data.columns:
            raise ValueError(f"CSV must contain a target column named {target_column!r}.")
        if not self.feature_columns:
            raise ValueError("No usable feature columns were found.")

        clean = data[self.feature_columns + [target_column]].dropna()
        x = clean[self.feature_columns]
        y = clean[target_column].astype(int)

        self.model = Pipeline(
            steps=[
                ("scaler", StandardScaler()),
                ("model", LogisticRegression(max_iter=1000)),
            ]
        )

        if len(clean) >= 10 and len(y.unique()) > 1:
            x_train, x_test, y_train, y_test = train_test_split(
                x,
                y,
                test_size=test_size,
                random_state=random_state,
                stratify=y,
            )
            self.model.fit(x_train, y_train)
            probabilities = self.model.predict_proba(x_test)[:, 1]
            predictions = (probabilities >= 0.5).astype(int)

            metrics = {
                "rows_used": len(clean),
                "features": self.feature_columns,
                "accuracy": accuracy_score(y_test, predictions),
                "log_loss": log_loss(y_test, probabilities),
                "brier_score": brier_score_loss(y_test, probabilities),
            }

            if len(set(y_test)) > 1:
                metrics["roc_auc"] = roc_auc_score(y_test, probabilities)

            return metrics

        self.model.fit(x, y)
        return {
            "rows_used": len(clean),
            "features": self.feature_columns,
            "note": "Model trained without a holdout test set because the dataset is small.",
        }

    def predict_from_row(self, row: Dict[str, Any]) -> Optional[float]:
        if self.model is None or not SKLEARN_AVAILABLE or pd is None:
            return None

        row = add_difference_features(dict(row))
        data = pd.DataFrame([row])
        for column in self.feature_columns:
            if column not in data.columns:
                data[column] = 0.0

        return float(self.model.predict_proba(data[self.feature_columns])[:, 1][0])

    def save(self, path: str) -> None:
        if not SKLEARN_AVAILABLE or joblib is None:
            raise ImportError("joblib is required to save the model.")
        joblib.dump(
            {
                "model": self.model,
                "feature_columns": self.feature_columns,
            },
            path,
        )

    def load(self, path: str) -> None:
        if not SKLEARN_AVAILABLE or joblib is None:
            raise ImportError("joblib is required to load the model.")
        saved = joblib.load(path)
        self.model = saved["model"]
        self.feature_columns = saved["feature_columns"]


# ============================================================
# 8. Gradient boosting model
# ============================================================


class TennisBoostingModel:
    def __init__(self):
        self.model = None
        self.feature_columns = DEFAULT_FEATURE_COLUMNS.copy()

    def train(
        self,
        csv_path: str,
        target_column: str = "player_a_won",
        feature_columns: Optional[List[str]] = None,
        test_size: float = 0.2,
        random_state: int = 42,
    ) -> Dict[str, Any]:
        if not SKLEARN_AVAILABLE or pd is None:
            raise ImportError("pandas, scikit-learn, and joblib are required to train this model.")

        data = pd.read_csv(csv_path)
        data = ensure_difference_columns(data)

        self.feature_columns = feature_columns or [column for column in DEFAULT_FEATURE_COLUMNS if column in data.columns]
        if "market_no_vig_prob_a" in data.columns:
            self.feature_columns.append("market_no_vig_prob_a")

        if target_column not in data.columns:
            raise ValueError(f"CSV must contain a target column named {target_column!r}.")
        if not self.feature_columns:
            raise ValueError("No usable feature columns were found.")

        clean = data[self.feature_columns + [target_column]].dropna()
        x = clean[self.feature_columns]
        y = clean[target_column].astype(int)
        self.model = HistGradientBoostingClassifier(random_state=random_state)

        if len(clean) >= 10 and len(y.unique()) > 1:
            x_train, x_test, y_train, y_test = train_test_split(
                x,
                y,
                test_size=test_size,
                random_state=random_state,
                stratify=y,
            )
            self.model.fit(x_train, y_train)
            probabilities = self.model.predict_proba(x_test)[:, 1]
            predictions = (probabilities >= 0.5).astype(int)

            metrics = {
                "rows_used": len(clean),
                "features": self.feature_columns,
                "accuracy": accuracy_score(y_test, predictions),
                "log_loss": log_loss(y_test, probabilities),
                "brier_score": brier_score_loss(y_test, probabilities),
            }

            if len(set(y_test)) > 1:
                metrics["roc_auc"] = roc_auc_score(y_test, probabilities)

            return metrics

        self.model.fit(x, y)
        return {
            "rows_used": len(clean),
            "features": self.feature_columns,
            "note": "Model trained without a holdout test set because the dataset is small.",
        }

    def predict_from_row(self, row: Dict[str, Any]) -> Optional[float]:
        if self.model is None or not SKLEARN_AVAILABLE or pd is None:
            return None

        row = add_difference_features(dict(row))
        data = pd.DataFrame([row])
        for column in self.feature_columns:
            if column not in data.columns:
                data[column] = 0.0

        return float(self.model.predict_proba(data[self.feature_columns])[:, 1][0])

    def save(self, path: str) -> None:
        if not SKLEARN_AVAILABLE or joblib is None:
            raise ImportError("joblib is required to save the model.")
        joblib.dump(
            {
                "model": self.model,
                "feature_columns": self.feature_columns,
            },
            path,
        )

    def load(self, path: str) -> None:
        if not SKLEARN_AVAILABLE or joblib is None:
            raise ImportError("joblib is required to load the model.")
        saved = joblib.load(path)
        self.model = saved["model"]
        self.feature_columns = saved["feature_columns"]


# ============================================================
# 9. Markov-style live match simulator
# ============================================================


class MarkovLiveTennisModel:
    def __init__(self, seed: Optional[int] = None):
        self.mc = MonteCarloTennisModel(seed=seed)

    def continue_current_game(
        self,
        p_a_serve: float,
        p_b_serve: float,
        server: str,
        a_points: int,
        b_points: int,
    ) -> str:
        while True:
            if a_points >= 4 and a_points - b_points >= 2:
                return "A"
            if b_points >= 4 and b_points - a_points >= 2:
                return "B"

            if server == "A":
                a_wins_point = self.mc.random.random() < p_a_serve
            else:
                a_wins_point = self.mc.random.random() > p_b_serve

            if a_wins_point:
                a_points += 1
            else:
                b_points += 1

    def simulate_set_from_state(
        self,
        p_a_serve: float,
        p_b_serve: float,
        a_games: int,
        b_games: int,
        server: str,
        a_points: int = 0,
        b_points: int = 0,
    ) -> Tuple[str, str]:
        if a_games >= 6 and a_games - b_games >= 2:
            return "A", server
        if b_games >= 6 and b_games - a_games >= 2:
            return "B", server

        if a_points > 0 or b_points > 0:
            game_winner = self.continue_current_game(
                p_a_serve,
                p_b_serve,
                server,
                a_points,
                b_points,
            )

            if game_winner == "A":
                a_games += 1
            else:
                b_games += 1

            server = "B" if server == "A" else "A"

        while True:
            if a_games >= 6 and a_games - b_games >= 2:
                return "A", server
            if b_games >= 6 and b_games - a_games >= 2:
                return "B", server
            if a_games == 6 and b_games == 6:
                tb_winner = self.mc.simulate_tiebreak(p_a_serve, p_b_serve, server)
                next_server = "B" if server == "A" else "A"
                return tb_winner, next_server

            if server == "A":
                if self.mc.simulate_service_game(p_a_serve):
                    a_games += 1
                else:
                    b_games += 1
            else:
                if self.mc.simulate_service_game(p_b_serve):
                    b_games += 1
                else:
                    a_games += 1

            server = "B" if server == "A" else "A"

    def live_match_probability(
        self,
        p_a_serve: float,
        p_b_serve: float,
        best_of: int = 3,
        a_sets: int = 0,
        b_sets: int = 0,
        a_games: int = 0,
        b_games: int = 0,
        server: str = "A",
        a_points: int = 0,
        b_points: int = 0,
        simulations: int = 10000,
    ) -> Dict[str, Any]:
        sets_needed = best_of // 2 + 1

        if a_sets >= sets_needed:
            return {
                "live_player_a_win_probability": 1.0,
                "live_player_b_win_probability": 0.0,
                "simulations": simulations,
            }
        if b_sets >= sets_needed:
            return {
                "live_player_a_win_probability": 0.0,
                "live_player_b_win_probability": 1.0,
                "simulations": simulations,
            }

        a_wins = 0

        for _ in range(simulations):
            sim_a_sets = a_sets
            sim_b_sets = b_sets
            sim_server = server

            set_winner, sim_server = self.simulate_set_from_state(
                p_a_serve,
                p_b_serve,
                a_games,
                b_games,
                sim_server,
                a_points,
                b_points,
            )

            if set_winner == "A":
                sim_a_sets += 1
            else:
                sim_b_sets += 1

            while sim_a_sets < sets_needed and sim_b_sets < sets_needed:
                set_winner, sim_server, _ = self.mc.simulate_set(p_a_serve, p_b_serve, sim_server)
                if set_winner == "A":
                    sim_a_sets += 1
                else:
                    sim_b_sets += 1

            if sim_a_sets > sim_b_sets:
                a_wins += 1

        p_a = a_wins / simulations
        return {
            "live_player_a_win_probability": p_a,
            "live_player_b_win_probability": 1 - p_a,
            "simulations": simulations,
        }


# ============================================================
# 10. Bayesian live updating model
# ============================================================


class BayesianLiveUpdateModel:
    """Updates serve-point probabilities using live serve-point results."""

    def update_serve_probability(
        self,
        prior_probability: float,
        serve_points_won_live: int,
        serve_points_played_live: int,
        prior_strength: int = 40,
    ) -> float:
        if serve_points_played_live <= 0:
            return prior_probability

        alpha = prior_probability * prior_strength
        beta = (1 - prior_probability) * prior_strength
        posterior_alpha = alpha + serve_points_won_live
        posterior_beta = beta + (serve_points_played_live - serve_points_won_live)
        return posterior_alpha / (posterior_alpha + posterior_beta)

    def update_match_inputs(
        self,
        p_a_serve_prior: float,
        p_b_serve_prior: float,
        a_serve_points_won_live: int,
        a_serve_points_played_live: int,
        b_serve_points_won_live: int,
        b_serve_points_played_live: int,
        prior_strength: int = 40,
    ) -> Dict[str, float]:
        return {
            "updated_p_a_serve": self.update_serve_probability(
                p_a_serve_prior,
                a_serve_points_won_live,
                a_serve_points_played_live,
                prior_strength,
            ),
            "updated_p_b_serve": self.update_serve_probability(
                p_b_serve_prior,
                b_serve_points_won_live,
                b_serve_points_played_live,
                prior_strength,
            ),
        }


# ============================================================
# 11. Market odds model
# ============================================================


class MarketOddsModel:
    def no_vig_probability(self, odds_a: float, odds_b: float) -> Dict[str, float]:
        return no_vig_two_way_probability(odds_a, odds_b)

    def blend_model_with_market(
        self,
        model_probability_a: float,
        odds_a: float,
        odds_b: float,
        market_weight: float = 0.25,
    ) -> Dict[str, float]:
        market = self.no_vig_probability(odds_a, odds_b)
        market_probability_a = market["a_no_vig_probability"]
        blended = model_probability_a * (1 - market_weight) + market_probability_a * market_weight

        return {
            "model_probability_a": model_probability_a,
            "market_probability_a": market_probability_a,
            "blended_probability_a": blended,
            "blended_probability_b": 1 - blended,
            "sportsbook_hold": market["sportsbook_hold"],
        }


# ============================================================
# 12. Weather, fatigue, and matchup models
# ============================================================


class WeatherModel:
    """
    Small context adjustment for outdoor matches.

    Positive values help Player A. Negative values help Player B.
    Keep this conservative until you have enough historical data to learn weights.
    """

    def player_weather_penalty(self, player: PlayerSnapshot, weather: Optional[WeatherContext]) -> float:
        if weather is None or weather.indoor:
            return 0.0

        penalty = 0.0
        style = player.style.lower().strip()

        if weather.wind_mph >= 20:
            penalty += 0.010
        elif weather.wind_mph >= 14:
            penalty += 0.006

        if style == "big_server" and weather.wind_mph >= 14:
            penalty += 0.006
        if style in {"counterpuncher", "defensive_baseliner"} and weather.wind_mph >= 14:
            penalty -= 0.003

        heat_index_signal = weather.temperature_f + 0.05 * weather.humidity_pct
        if heat_index_signal >= 100:
            penalty += 0.008
        elif heat_index_signal >= 92:
            penalty += 0.004

        if weather.precipitation_chance >= 0.50 and style == "aggressive_baseliner":
            penalty += 0.004

        penalty += clamp(player.weather_sensitivity, -1.0, 1.0) * 0.006
        return clamp(penalty, -0.02, 0.03)

    def probability_adjustment_for_a(
        self,
        player_a: PlayerSnapshot,
        player_b: PlayerSnapshot,
        weather: Optional[WeatherContext],
    ) -> float:
        a_penalty = self.player_weather_penalty(player_a, weather)
        b_penalty = self.player_weather_penalty(player_b, weather)
        return clamp(b_penalty - a_penalty, -0.025, 0.025)


class FatigueModel:
    """Positive adjustment means Player A benefits. Negative means Player B benefits."""

    def fatigue_penalty(self, player: PlayerSnapshot) -> float:
        penalty = 0.0

        if player.rest_days < 1:
            penalty += 0.020
        elif player.rest_days < 2:
            penalty += 0.010

        if player.last_match_minutes >= 180:
            penalty += 0.020
        elif player.last_match_minutes >= 150:
            penalty += 0.012
        elif player.last_match_minutes >= 120:
            penalty += 0.006

        if player.sets_played_last_7_days >= 12:
            penalty += 0.020
        elif player.sets_played_last_7_days >= 9:
            penalty += 0.012
        elif player.sets_played_last_7_days >= 6:
            penalty += 0.006

        if player.matches_played_last_7_days >= 5:
            penalty += 0.015
        elif player.matches_played_last_7_days >= 4:
            penalty += 0.008

        if player.injury_flag:
            penalty += 0.030

        return penalty

    def probability_adjustment_for_a(self, player_a: PlayerSnapshot, player_b: PlayerSnapshot) -> float:
        a_penalty = self.fatigue_penalty(player_a)
        b_penalty = self.fatigue_penalty(player_b)
        return clamp(b_penalty - a_penalty, -0.05, 0.05)


class MatchupModel:
    def style_adjustment_for_a(self, player_a: PlayerSnapshot, player_b: PlayerSnapshot) -> float:
        adjustment = 0.0
        a_style = player_a.style.lower().strip()
        b_style = player_b.style.lower().strip()

        if a_style == "big_server" and player_b.return_points_won < 0.36:
            adjustment += 0.010
        if b_style == "big_server" and player_a.return_points_won < 0.36:
            adjustment -= 0.010

        if a_style == "counterpuncher" and b_style == "aggressive_baseliner":
            adjustment += 0.006
        if b_style == "counterpuncher" and a_style == "aggressive_baseliner":
            adjustment -= 0.006

        if a_style == "lefty_topspin" and b_style == "one_handed_backhand":
            adjustment += 0.008
        if b_style == "lefty_topspin" and a_style == "one_handed_backhand":
            adjustment -= 0.008

        return adjustment

    def h2h_adjustment_for_a(self, player_a: PlayerSnapshot) -> float:
        total = player_a.h2h_wins + player_a.h2h_losses
        if total < 2:
            return 0.0

        h2h_win_pct = player_a.h2h_wins / total
        raw = (h2h_win_pct - 0.5) * 0.04
        return clamp(raw, -0.02, 0.02)

    def probability_adjustment_for_a(self, player_a: PlayerSnapshot, player_b: PlayerSnapshot) -> float:
        return clamp(
            self.style_adjustment_for_a(player_a, player_b) + self.h2h_adjustment_for_a(player_a),
            -0.03,
            0.03,
        )


# ============================================================
# 13. Calibration model
# ============================================================


class CalibrationModel:
    def __init__(self):
        self.is_trained = False
        self.model = IsotonicRegression(out_of_bounds="clip") if SKLEARN_AVAILABLE else None

    def fit(self, predicted_probabilities: List[float], actual_results: List[int]) -> None:
        if not SKLEARN_AVAILABLE:
            raise ImportError("scikit-learn is required for calibration.")

        self.model.fit(predicted_probabilities, actual_results)
        self.is_trained = True

    def calibrate(self, probability: float) -> float:
        if not self.is_trained or not SKLEARN_AVAILABLE:
            return probability

        return float(self.model.predict([probability])[0])


# ============================================================
# 14. Final ensemble engine
# ============================================================


class TennisPredictionEngine:
    def __init__(self):
        self.monte_carlo = MonteCarloTennisModel()
        self.analytical = AnalyticalTennisModel()
        self.poisson = PoissonTennisModel()
        self.surface_elo = SurfaceEloModel()
        self.glicko = GlickoLiteModel()
        self.bradley_terry = BradleyTerryModel()
        self.regression = TennisRegressionModel()
        self.boosting = TennisBoostingModel()
        self.markov_live = MarkovLiveTennisModel()
        self.bayesian_live = BayesianLiveUpdateModel()
        self.market = MarketOddsModel()
        self.weather = WeatherModel()
        self.fatigue = FatigueModel()
        self.matchup = MatchupModel()
        self.calibration = CalibrationModel()

        self.default_weights = {
            "monte_carlo": 0.20,
            "analytical": 0.18,
            "surface_elo": 0.15,
            "glicko": 0.08,
            "bradley_terry": 0.05,
            "regression": 0.12,
            "boosting": 0.14,
            "poisson_support": 0.03,
            "market": 0.05,
        }

    def surface_elo_probability_from_snapshots(
        self,
        player_a: PlayerSnapshot,
        player_b: PlayerSnapshot,
        surface: str,
    ) -> float:
        return elo_expected_probability(player_a.get_surface_elo(surface), player_b.get_surface_elo(surface))

    def glicko_probability_from_snapshots(self, player_a: PlayerSnapshot, player_b: PlayerSnapshot) -> float:
        return self.glicko.predict_ratings(
            player_a.glicko_rating,
            player_b.glicko_rating,
            player_a.glicko_rd,
            player_b.glicko_rd,
        )

    def poisson_support_probability(
        self,
        player_a: PlayerSnapshot,
        player_b: PlayerSnapshot,
        best_of: int = 3,
    ) -> float:
        projected_sets = 2.4 if best_of == 3 else 3.8
        return_games_per_set = 5.0
        a_expected_breaks = max(0.05, player_a.break_pct * return_games_per_set * projected_sets)
        b_expected_breaks = max(0.05, player_b.break_pct * return_games_per_set * projected_sets)
        comparison = self.poisson.compare_two_counts(a_expected_breaks, b_expected_breaks)
        return comparison["a_support_probability"]

    def predict_match(
        self,
        player_a: PlayerSnapshot,
        player_b: PlayerSnapshot,
        surface: str = "hard",
        best_of: int = 3,
        sportsbook_odds_a: Optional[float] = None,
        sportsbook_odds_b: Optional[float] = None,
        simulations: int = 100000,
        weather_context: Optional[WeatherContext] = None,
        apply_market_blend: bool = True,
    ) -> PredictionResult:
        fatigue_adj = self.fatigue.probability_adjustment_for_a(player_a, player_b)
        matchup_adj = self.matchup.probability_adjustment_for_a(player_a, player_b)
        weather_adj = self.weather.probability_adjustment_for_a(player_a, player_b, weather_context)

        surface_elo_diff = player_a.get_surface_elo(surface) - player_b.get_surface_elo(surface)
        a_surface_point_adj = clamp(surface_elo_diff / 10000, -0.015, 0.015)
        b_surface_point_adj = -a_surface_point_adj

        a_point_fatigue_adj = fatigue_adj * 0.20
        b_point_fatigue_adj = -fatigue_adj * 0.20
        a_point_matchup_adj = matchup_adj * 0.20
        b_point_matchup_adj = -matchup_adj * 0.20
        a_point_weather_adj = weather_adj * 0.20
        b_point_weather_adj = -weather_adj * 0.20

        p_a_serve = project_serve_point_probability(
            player_a,
            player_b,
            surface=surface,
            surface_elo_adjustment=a_surface_point_adj,
            fatigue_adjustment=a_point_fatigue_adj,
            matchup_adjustment=a_point_matchup_adj,
            weather_adjustment=a_point_weather_adj,
        )
        p_b_serve = project_serve_point_probability(
            player_b,
            player_a,
            surface=surface,
            surface_elo_adjustment=b_surface_point_adj,
            fatigue_adjustment=b_point_fatigue_adj,
            matchup_adjustment=b_point_matchup_adj,
            weather_adjustment=b_point_weather_adj,
        )

        monte_carlo_result = self.monte_carlo.predict(p_a_serve, p_b_serve, best_of, simulations)
        analytical_result = self.analytical.predict(p_a_serve, p_b_serve, best_of)
        surface_elo_prob = self.surface_elo_probability_from_snapshots(player_a, player_b, surface)
        glicko_prob = self.glicko_probability_from_snapshots(player_a, player_b)
        bt_prob = elo_expected_probability(player_a.overall_elo, player_b.overall_elo)
        poisson_prob = self.poisson_support_probability(player_a, player_b, best_of)

        market_probability = None
        if sportsbook_odds_a is not None and sportsbook_odds_b is not None:
            market_data = self.market.no_vig_probability(sportsbook_odds_a, sportsbook_odds_b)
            market_probability = market_data["a_no_vig_probability"]

        row = build_match_row(player_a, player_b, surface, market_probability, weather_context)
        regression_prob = self.regression.predict_from_row(row)
        boosting_prob = self.boosting.predict_from_row(row)

        component_probabilities = {
            "monte_carlo": monte_carlo_result["player_a_win_probability"],
            "analytical": analytical_result["player_a_match_probability"],
            "surface_elo": surface_elo_prob,
            "glicko": glicko_prob,
            "bradley_terry": bt_prob,
            "regression": regression_prob,
            "boosting": boosting_prob,
            "poisson_support": poisson_prob,
            "market": market_probability if apply_market_blend else None,
        }

        raw_final = weighted_average(component_probabilities, self.default_weights)
        raw_final = clamp(raw_final + fatigue_adj + matchup_adj + weather_adj, 0.01, 0.99)
        final_a = clamp(self.calibration.calibrate(raw_final), 0.01, 0.99)
        final_b = 1 - final_a

        edge_a = None
        edge_b = None
        recommendation = "No bet"

        if sportsbook_odds_a is not None and sportsbook_odds_b is not None:
            implied_a = american_odds_to_probability(sportsbook_odds_a)
            implied_b = american_odds_to_probability(sportsbook_odds_b)
            edge_a = final_a - implied_a
            edge_b = final_b - implied_b

            if edge_a >= 0.035 and edge_a > edge_b:
                recommendation = f"Value lean: {player_a.name}"
            elif edge_b >= 0.035 and edge_b > edge_a:
                recommendation = f"Value lean: {player_b.name}"
            else:
                recommendation = "Pass / no clear edge"

        return PredictionResult(
            player_a=player_a.name,
            player_b=player_b.name,
            surface=surface,
            best_of=best_of,
            component_probabilities=component_probabilities,
            final_probability_a=final_a,
            final_probability_b=final_b,
            fair_american_odds_a=probability_to_american_odds(final_a),
            fair_american_odds_b=probability_to_american_odds(final_b),
            fair_decimal_odds_a=probability_to_decimal_odds(final_a),
            fair_decimal_odds_b=probability_to_decimal_odds(final_b),
            sportsbook_odds_a=sportsbook_odds_a,
            sportsbook_odds_b=sportsbook_odds_b,
            no_vig_market_probability_a=market_probability,
            edge_a_pct=round(edge_a * 100, 2) if edge_a is not None else None,
            edge_b_pct=round(edge_b * 100, 2) if edge_b is not None else None,
            recommendation=recommendation,
        )

    def predict_live_match(
        self,
        player_a: PlayerSnapshot,
        player_b: PlayerSnapshot,
        surface: str,
        best_of: int,
        a_sets: int,
        b_sets: int,
        a_games: int,
        b_games: int,
        server: str,
        a_points: int = 0,
        b_points: int = 0,
        a_serve_points_won_live: int = 0,
        a_serve_points_played_live: int = 0,
        b_serve_points_won_live: int = 0,
        b_serve_points_played_live: int = 0,
        weather_context: Optional[WeatherContext] = None,
        simulations: int = 10000,
    ) -> Dict[str, Any]:
        fatigue_adj = self.fatigue.probability_adjustment_for_a(player_a, player_b)
        matchup_adj = self.matchup.probability_adjustment_for_a(player_a, player_b)
        weather_adj = self.weather.probability_adjustment_for_a(player_a, player_b, weather_context)

        p_a_serve = project_serve_point_probability(
            player_a,
            player_b,
            surface,
            fatigue_adjustment=fatigue_adj * 0.20,
            matchup_adjustment=matchup_adj * 0.20,
            weather_adjustment=weather_adj * 0.20,
        )
        p_b_serve = project_serve_point_probability(
            player_b,
            player_a,
            surface,
            fatigue_adjustment=-fatigue_adj * 0.20,
            matchup_adjustment=-matchup_adj * 0.20,
            weather_adjustment=-weather_adj * 0.20,
        )

        updated = self.bayesian_live.update_match_inputs(
            p_a_serve,
            p_b_serve,
            a_serve_points_won_live,
            a_serve_points_played_live,
            b_serve_points_won_live,
            b_serve_points_played_live,
        )

        return self.markov_live.live_match_probability(
            updated["updated_p_a_serve"],
            updated["updated_p_b_serve"],
            best_of=best_of,
            a_sets=a_sets,
            b_sets=b_sets,
            a_games=a_games,
            b_games=b_games,
            server=server,
            a_points=a_points,
            b_points=b_points,
            simulations=simulations,
        )

    def train_regression(self, csv_path: str) -> Dict[str, Any]:
        return self.regression.train(csv_path)

    def train_boosting(self, csv_path: str) -> Dict[str, Any]:
        return self.boosting.train(csv_path)


# ============================================================
# Example usage
# ============================================================


def pretty_print_result(result: PredictionResult) -> None:
    data = asdict(result)
    data["component_probabilities"] = {
        key: None if value is None else round(value * 100, 2)
        for key, value in data["component_probabilities"].items()
    }
    data["final_probability_a"] = round(data["final_probability_a"] * 100, 2)
    data["final_probability_b"] = round(data["final_probability_b"] * 100, 2)

    if data["no_vig_market_probability_a"] is not None:
        data["no_vig_market_probability_a"] = round(data["no_vig_market_probability_a"] * 100, 2)

    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    engine = TennisPredictionEngine()

    player_a = PlayerSnapshot(
        name="Player A",
        service_points_won=0.655,
        return_points_won=0.389,
        hold_pct=0.835,
        break_pct=0.247,
        rank=24,
        overall_elo=1850,
        surface_elo={
            "hard": 1875,
            "clay": 1810,
            "grass": 1760,
            "indoor_hard": 1890,
        },
        glicko_rating=1840,
        glicko_rd=90,
        recent_win_pct=0.70,
        surface_win_pct=0.68,
        surface_hold_pct=0.84,
        surface_break_pct=0.25,
        rest_days=2,
        last_match_minutes=105,
        sets_played_last_7_days=5,
        matches_played_last_7_days=2,
        aces_avg=7.1,
        aces_allowed_avg=5.8,
        style="big_server",
        h2h_wins=2,
        h2h_losses=1,
        weather_sensitivity=0.10,
    )

    player_b = PlayerSnapshot(
        name="Player B",
        service_points_won=0.628,
        return_points_won=0.365,
        hold_pct=0.802,
        break_pct=0.221,
        rank=41,
        overall_elo=1785,
        surface_elo={
            "hard": 1800,
            "clay": 1840,
            "grass": 1710,
            "indoor_hard": 1775,
        },
        glicko_rating=1780,
        glicko_rd=110,
        recent_win_pct=0.55,
        surface_win_pct=0.57,
        surface_hold_pct=0.79,
        surface_break_pct=0.21,
        rest_days=1,
        last_match_minutes=155,
        sets_played_last_7_days=7,
        matches_played_last_7_days=3,
        aces_avg=5.9,
        aces_allowed_avg=6.4,
        style="balanced",
        h2h_wins=1,
        h2h_losses=2,
        weather_sensitivity=0.00,
    )

    weather = WeatherContext(
        indoor=False,
        temperature_f=84,
        wind_mph=11,
        humidity_pct=56,
        precipitation_chance=0.15,
    )

    result = engine.predict_match(
        player_a=player_a,
        player_b=player_b,
        surface="hard",
        best_of=3,
        sportsbook_odds_a=-130,
        sportsbook_odds_b=110,
        weather_context=weather,
        simulations=100000,
    )

    print("\nPRE-MATCH PREDICTION")
    pretty_print_result(result)

    projected_aces = engine.poisson.estimate_lambda(
        player_average=player_a.aces_avg,
        opponent_allowed_average=player_b.aces_allowed_avg,
        surface_adjustment=0.2,
        form_adjustment=0.1,
        match_length_multiplier=1.0,
    )
    aces_prop = engine.poisson.analyze_prop(
        event_name="Aces",
        player_name=player_a.name,
        projected_lambda=projected_aces,
        line=6.5,
        sportsbook_over_odds=-110,
        sportsbook_under_odds=-110,
    )

    print("\nACES PROP")
    print(json.dumps(aces_prop, indent=2))

    live = engine.predict_live_match(
        player_a=player_a,
        player_b=player_b,
        surface="hard",
        best_of=3,
        a_sets=0,
        b_sets=0,
        a_games=3,
        b_games=2,
        server="A",
        a_points=2,
        b_points=1,
        a_serve_points_won_live=18,
        a_serve_points_played_live=25,
        b_serve_points_won_live=15,
        b_serve_points_played_live=24,
        weather_context=weather,
        simulations=10000,
    )

    print("\nLIVE MATCH PREDICTION")
    print(json.dumps(live, indent=2))
