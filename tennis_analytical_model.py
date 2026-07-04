"""
Analytical tennis prediction model.

This model does not simulate random matches. Instead, it uses formulas and
dynamic programming to estimate:

1. Projected serve-point win probability
2. Hold probability
3. Set win probability
4. Match win probability
5. Fair decimal and American odds
6. Betting edge versus sportsbook odds

The output is a plain Python dictionary so it can be connected later to the
Monte Carlo simulator, a database, or a betting dashboard.
"""

from dataclasses import dataclass
from functools import lru_cache
from math import comb
from typing import Dict, Optional

from tennis_context_factors import (
    ContextFactorWeights,
    PlayerContext,
    weighted_context_adjustment,
)


PLAYER_A = "A"
PLAYER_B = "B"


@dataclass
class PlayerStats:
    """Inputs needed for one player."""

    name: str
    service_points_won: float
    return_points_won: float
    surface_adjustment: float = 0.0
    form_adjustment: float = 0.0
    weather_adjustment: float = 0.0
    fatigue_adjustment: float = 0.0
    injury_adjustment: float = 0.0


def clamp(value: float, low: float = 0.45, high: float = 0.75) -> float:
    """Keep projected serve-point probability in a realistic tennis range."""
    return max(low, min(high, value))


def validate_probability(value: float, name: str) -> None:
    """Make sure a probability is written as a decimal between 0 and 1."""
    if not 0 <= value <= 1:
        raise ValueError(f"{name} must be between 0 and 1. Example: 0.64")


def validate_best_of(best_of: int) -> None:
    """Only best-of-3 and best-of-5 are supported."""
    if best_of not in (3, 5):
        raise ValueError("best_of must be 3 or 5")


def validate_player_stats(player: PlayerStats) -> None:
    """Validate the stat fields that should be probabilities."""
    validate_probability(player.service_points_won, f"{player.name} service_points_won")
    validate_probability(player.return_points_won, f"{player.name} return_points_won")


def other_player(player: str) -> str:
    """Return the other player label."""
    return PLAYER_B if player == PLAYER_A else PLAYER_A


def project_serve_point_probability(server: PlayerStats, returner: PlayerStats) -> float:
    """
    Project how often the server wins a point on serve.

    The starter projection averages:
    - server's own service points won
    - opponent's return weakness

    Example:
    server.service_points_won = 0.65
    returner.return_points_won = 0.37

    Opponent return weakness = 1 - 0.37 = 0.63
    Projection = (0.65 + 0.63) / 2 = 0.64
    """
    validate_player_stats(server)
    validate_player_stats(returner)

    base_projection = (
        server.service_points_won
        + (1 - returner.return_points_won)
    ) / 2

    adjusted_projection = (
        base_projection
        + server.surface_adjustment
        + server.form_adjustment
        + weighted_context_adjustment(
            PlayerContext(
                weather_factor=server.weather_adjustment,
                fatigue_factor=server.fatigue_adjustment,
                injury_factor=server.injury_adjustment,
            ),
            ContextFactorWeights(),
        )
    )

    return clamp(adjusted_projection)


def service_game_hold_probability(p_server_wins_point: float) -> float:
    """
    Convert serve-point win probability into hold probability.

    This is an exact formula for a normal tennis service game with deuce.
    """
    validate_probability(p_server_wins_point, "p_server_wins_point")

    p = p_server_wins_point
    q = 1 - p

    # Server wins before deuce: 4-0, 4-1, or 4-2.
    win_before_deuce = p**4 * (1 + 4 * q + 10 * q**2)

    # Probability the game reaches 3-3.
    reach_deuce = 20 * p**3 * q**3

    # From deuce, server must win two points before losing two points.
    win_from_deuce = p**2 / (p**2 + q**2)

    return win_before_deuce + reach_deuce * win_from_deuce


def tiebreak_server(first_server: str, point_index: int) -> str:
    """
    Return who serves a tiebreak point.

    point_index is zero-based:
    - Point 0: first server
    - Then players alternate every two serves
    """
    if first_server not in (PLAYER_A, PLAYER_B):
        raise ValueError("first_server must be 'A' or 'B'")

    if point_index == 0:
        return first_server

    block = (point_index - 1) // 2
    if block % 2 == 0:
        return other_player(first_server)
    return first_server


def tiebreak_win_probability(
    p_a_serve: float,
    p_b_serve: float,
    first_server: str = PLAYER_A,
    max_points: int = 80,
) -> float:
    """
    Estimate Player A's tiebreak win probability with state enumeration.

    This is not random simulation. It walks through every reachable tiebreak
    score state until the tiebreak is won. max_points is only a safety cap for
    extremely long tiebreaks.
    """
    validate_probability(p_a_serve, "p_a_serve")
    validate_probability(p_b_serve, "p_b_serve")

    states = {(0, 0): 1.0}
    a_win_probability = 0.0

    for point_index in range(max_points):
        next_states = {}

        for (a_points, b_points), state_probability in states.items():
            if a_points >= 7 and a_points - b_points >= 2:
                a_win_probability += state_probability
                continue

            if b_points >= 7 and b_points - a_points >= 2:
                continue

            server = tiebreak_server(first_server, point_index)
            if server == PLAYER_A:
                p_a_wins_point = p_a_serve
            else:
                p_a_wins_point = 1 - p_b_serve

            a_wins_next = (a_points + 1, b_points)
            b_wins_next = (a_points, b_points + 1)

            next_states[a_wins_next] = (
                next_states.get(a_wins_next, 0.0)
                + state_probability * p_a_wins_point
            )
            next_states[b_wins_next] = (
                next_states.get(b_wins_next, 0.0)
                + state_probability * (1 - p_a_wins_point)
            )

        states = next_states

    # Any unresolved probability is tiny. Split tied states and assign leading
    # states to the current leader.
    for (a_points, b_points), state_probability in states.items():
        if a_points > b_points:
            a_win_probability += state_probability
        elif a_points == b_points:
            a_win_probability += state_probability * 0.5

    return a_win_probability


def set_win_probability(
    p_a_serve: float,
    p_b_serve: float,
    starting_server: str = PLAYER_A,
) -> float:
    """
    Estimate Player A's probability of winning one set.

    This uses dynamic programming over game score states. At 6-6, it uses the
    analytical tiebreak function above.
    """
    validate_probability(p_a_serve, "p_a_serve")
    validate_probability(p_b_serve, "p_b_serve")

    hold_a = service_game_hold_probability(p_a_serve)
    hold_b = service_game_hold_probability(p_b_serve)

    @lru_cache(maxsize=None)
    def dp(a_games: int, b_games: int, server: str) -> float:
        if a_games >= 6 and a_games - b_games >= 2:
            return 1.0

        if b_games >= 6 and b_games - a_games >= 2:
            return 0.0

        if a_games == 6 and b_games == 6:
            return tiebreak_win_probability(
                p_a_serve,
                p_b_serve,
                first_server=server,
            )

        next_server = other_player(server)

        if server == PLAYER_A:
            return (
                hold_a * dp(a_games + 1, b_games, next_server)
                + (1 - hold_a) * dp(a_games, b_games + 1, next_server)
            )

        # Player B is serving. If B is broken, Player A wins the game.
        return (
            (1 - hold_b) * dp(a_games + 1, b_games, next_server)
            + hold_b * dp(a_games, b_games + 1, next_server)
        )

    return dp(0, 0, starting_server)


def match_win_probability(set_win_probability_a: float, best_of: int = 3) -> float:
    """
    Convert Player A's set win probability into match win probability.

    best_of=3 means first to 2 sets.
    best_of=5 means first to 3 sets.
    """
    validate_probability(set_win_probability_a, "set_win_probability_a")
    validate_best_of(best_of)

    sets_needed = best_of // 2 + 1
    p = set_win_probability_a
    q = 1 - p
    probability = 0.0

    for losses_before_final_set in range(sets_needed):
        probability += (
            comb(sets_needed - 1 + losses_before_final_set, losses_before_final_set)
            * p**sets_needed
            * q**losses_before_final_set
        )

    return probability


def probability_to_decimal_odds(probability: float) -> Optional[float]:
    """Convert model probability to fair decimal odds."""
    if probability <= 0:
        return None
    return round(1 / probability, 2)


def probability_to_american_odds(probability: float) -> Optional[int]:
    """Convert model probability to fair American odds."""
    if probability <= 0 or probability >= 1:
        return None

    if probability >= 0.5:
        return round(-100 * probability / (1 - probability))
    return round(100 * (1 - probability) / probability)


def american_odds_to_probability(odds: int) -> float:
    """Convert American odds into implied probability."""
    if odds < 0:
        return abs(odds) / (abs(odds) + 100)
    return 100 / (odds + 100)


def betting_edge(model_probability: float, sportsbook_odds: int) -> Dict[str, float]:
    """
    Compare model probability to sportsbook implied probability.

    Positive edge means the model thinks the player is more likely to win than
    the sportsbook odds imply.
    """
    implied_probability = american_odds_to_probability(sportsbook_odds)
    edge = model_probability - implied_probability

    return {
        "sportsbook_odds": sportsbook_odds,
        "sportsbook_implied_probability": implied_probability,
        "sportsbook_implied_pct": round(implied_probability * 100, 2),
        "model_edge_probability": edge,
        "model_edge_pct": round(edge * 100, 2),
    }


def build_monte_carlo_inputs(player_a: PlayerStats, player_b: PlayerStats) -> Dict[str, float]:
    """
    Return serve probabilities in the shape the Monte Carlo simulator needs.

    These values can be passed into tennis_monte_carlo.run_monte_carlo().
    """
    return {
        "p_a_serve": project_serve_point_probability(player_a, player_b),
        "p_b_serve": project_serve_point_probability(player_b, player_a),
    }


def analyze_match(
    player_a: PlayerStats,
    player_b: PlayerStats,
    best_of: int = 3,
    sportsbook_odds_a: Optional[int] = None,
    sportsbook_odds_b: Optional[int] = None,
) -> Dict[str, object]:
    """
    Run the analytical model and return dashboard-friendly results.

    The returned dictionary keeps both rounded display fields and raw
    probabilities. Raw probabilities are useful for weighting this model against
    the Monte Carlo model later.
    """
    validate_best_of(best_of)

    monte_carlo_inputs = build_monte_carlo_inputs(player_a, player_b)
    p_a_serve = monte_carlo_inputs["p_a_serve"]
    p_b_serve = monte_carlo_inputs["p_b_serve"]

    hold_a = service_game_hold_probability(p_a_serve)
    hold_b = service_game_hold_probability(p_b_serve)

    set_prob_a_starts = set_win_probability(
        p_a_serve,
        p_b_serve,
        starting_server=PLAYER_A,
    )
    set_prob_b_starts = set_win_probability(
        p_a_serve,
        p_b_serve,
        starting_server=PLAYER_B,
    )

    # Average both serving orders when the first server is unknown.
    set_prob_a = (set_prob_a_starts + set_prob_b_starts) / 2
    match_prob_a = match_win_probability(set_prob_a, best_of=best_of)
    match_prob_b = 1 - match_prob_a

    result = {
        "model": "analytical",
        "best_of": best_of,
        "monte_carlo_inputs": monte_carlo_inputs,
        "players": {
            player_a.name: {
                "weather_adjustment": player_a.weather_adjustment,
                "fatigue_adjustment": player_a.fatigue_adjustment,
                "injury_adjustment": player_a.injury_adjustment,
                "projected_serve_point_win_probability": p_a_serve,
                "projected_serve_point_win_pct": round(p_a_serve * 100, 2),
                "projected_hold_probability": hold_a,
                "projected_hold_pct": round(hold_a * 100, 2),
                "set_win_probability": set_prob_a,
                "set_win_pct": round(set_prob_a * 100, 2),
                "match_win_probability": match_prob_a,
                "match_win_pct": round(match_prob_a * 100, 2),
                "fair_decimal_odds": probability_to_decimal_odds(match_prob_a),
                "fair_american_odds": probability_to_american_odds(match_prob_a),
            },
            player_b.name: {
                "weather_adjustment": player_b.weather_adjustment,
                "fatigue_adjustment": player_b.fatigue_adjustment,
                "injury_adjustment": player_b.injury_adjustment,
                "projected_serve_point_win_probability": p_b_serve,
                "projected_serve_point_win_pct": round(p_b_serve * 100, 2),
                "projected_hold_probability": hold_b,
                "projected_hold_pct": round(hold_b * 100, 2),
                "set_win_probability": 1 - set_prob_a,
                "set_win_pct": round((1 - set_prob_a) * 100, 2),
                "match_win_probability": match_prob_b,
                "match_win_pct": round(match_prob_b * 100, 2),
                "fair_decimal_odds": probability_to_decimal_odds(match_prob_b),
                "fair_american_odds": probability_to_american_odds(match_prob_b),
            },
        },
    }

    if sportsbook_odds_a is not None:
        result["players"][player_a.name].update(
            betting_edge(match_prob_a, sportsbook_odds_a)
        )

    if sportsbook_odds_b is not None:
        result["players"][player_b.name].update(
            betting_edge(match_prob_b, sportsbook_odds_b)
        )

    return result


def print_analysis(analysis: Dict[str, object]) -> None:
    """Print analysis results in a beginner-friendly command-line format."""
    print("Analytical Tennis Model")
    print("=" * 25)
    print(f"Format: Best of {analysis['best_of']}")
    print()

    for player_name, data in analysis["players"].items():
        print(player_name)
        print("-" * len(player_name))
        print(f"Projected serve-point win: {data['projected_serve_point_win_pct']}%")
        print(f"Projected hold: {data['projected_hold_pct']}%")
        print(f"Set win: {data['set_win_pct']}%")
        print(f"Match win: {data['match_win_pct']}%")
        print(f"Fair decimal odds: {data['fair_decimal_odds']}")
        print(f"Fair American odds: {data['fair_american_odds']}")

        if "sportsbook_odds" in data:
            print(f"Sportsbook odds: {data['sportsbook_odds']}")
            print(f"Sportsbook implied: {data['sportsbook_implied_pct']}%")
            print(f"Model edge: {data['model_edge_pct']}%")

        print()


if __name__ == "__main__":
    # Example inputs:
    # - service_points_won: percentage of service points won, written as decimal
    # - return_points_won: percentage of return points won, written as decimal
    # - adjustments: small decimal bumps for surface/form assumptions
    player_a = PlayerStats(
        name="Player A",
        service_points_won=0.65,
        return_points_won=0.39,
        surface_adjustment=0.01,
        form_adjustment=0.005,
        weather_adjustment=0.002,
        fatigue_adjustment=-0.004,
        injury_adjustment=0.0,
    )

    player_b = PlayerStats(
        name="Player B",
        service_points_won=0.62,
        return_points_won=0.37,
        surface_adjustment=0.0,
        form_adjustment=-0.005,
        weather_adjustment=-0.002,
        fatigue_adjustment=-0.008,
        injury_adjustment=-0.006,
    )

    analysis_result = analyze_match(
        player_a=player_a,
        player_b=player_b,
        best_of=3,
        sportsbook_odds_a=-130,
        sportsbook_odds_b=110,
    )

    print_analysis(analysis_result)

    # Later, these can be sent directly into tennis_monte_carlo.run_monte_carlo().
    print("Monte Carlo-ready inputs")
    print("-" * 24)
    print(analysis_result["monte_carlo_inputs"])
