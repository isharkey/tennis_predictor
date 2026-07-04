"""
Tennis Monte Carlo simulator.

This module simulates tennis point by point using projected serve-point win
probabilities for Player A and Player B. It is intentionally simple and easy
to expand later into a betting or value model.

Example:
    python tennis_monte_carlo.py --p-a-serve 0.64 --p-b-serve 0.61 --best-of 3 --simulations 100000
"""

from __future__ import annotations

import argparse
import random
from collections import Counter
from dataclasses import dataclass
from typing import Dict, List, Optional


PLAYER_A = "A"
PLAYER_B = "B"


@dataclass
class SetResult:
    """Result of one simulated set."""

    winner: str
    games_a: int
    games_b: int
    next_server: str
    had_tiebreak: bool


@dataclass
class MatchResult:
    """Result of one simulated match."""

    winner: str
    sets_a: int
    sets_b: int
    set_scores: List[SetResult]


def other_player(player: str) -> str:
    """Return the other player's label."""
    return PLAYER_B if player == PLAYER_A else PLAYER_A


def validate_probability(value: float, name: str) -> None:
    """Make sure a probability is written as a decimal between 0 and 1."""
    if not 0 <= value <= 1:
        raise ValueError(f"{name} must be between 0 and 1. Example: 0.64")


def simulate_point(
    server: str,
    p_a_serve_point_win: float,
    p_b_serve_point_win: float,
    rng: random.Random,
) -> str:
    """
    Simulate one point and return the point winner.

    p_a_serve_point_win is Player A's chance to win a point when Player A serves.
    p_b_serve_point_win is Player B's chance to win a point when Player B serves.
    """
    if server == PLAYER_A:
        server_wins = rng.random() < p_a_serve_point_win
    else:
        server_wins = rng.random() < p_b_serve_point_win

    return server if server_wins else other_player(server)


def simulate_game(
    server: str,
    p_a_serve_point_win: float,
    p_b_serve_point_win: float,
    rng: random.Random,
) -> str:
    """Simulate one standard game and return the game winner."""
    points_a = 0
    points_b = 0

    while True:
        point_winner = simulate_point(
            server,
            p_a_serve_point_win,
            p_b_serve_point_win,
            rng,
        )

        if point_winner == PLAYER_A:
            points_a += 1
        else:
            points_b += 1

        player_has_four_points = points_a >= 4 or points_b >= 4
        player_leads_by_two = abs(points_a - points_b) >= 2

        if player_has_four_points and player_leads_by_two:
            return PLAYER_A if points_a > points_b else PLAYER_B


def tiebreak_server(first_server: str, point_number: int) -> str:
    """
    Return who serves a tiebreak point.

    The first point is served by the next scheduled server. After that, players
    serve two points at a time.
    """
    if point_number == 1:
        return first_server

    two_point_block = (point_number - 2) // 2
    if two_point_block % 2 == 0:
        return other_player(first_server)
    return first_server


def simulate_tiebreak(
    first_server: str,
    p_a_serve_point_win: float,
    p_b_serve_point_win: float,
    rng: random.Random,
    points_to_win: int = 7,
) -> str:
    """Simulate a tiebreak and return the tiebreak winner."""
    points_a = 0
    points_b = 0
    point_number = 1

    while True:
        server = tiebreak_server(first_server, point_number)
        point_winner = simulate_point(
            server,
            p_a_serve_point_win,
            p_b_serve_point_win,
            rng,
        )

        if point_winner == PLAYER_A:
            points_a += 1
        else:
            points_b += 1

        player_reached_target = points_a >= points_to_win or points_b >= points_to_win
        player_leads_by_two = abs(points_a - points_b) >= 2

        if player_reached_target and player_leads_by_two:
            return PLAYER_A if points_a > points_b else PLAYER_B

        point_number += 1


def simulate_set(
    first_server: str,
    p_a_serve_point_win: float,
    p_b_serve_point_win: float,
    rng: random.Random,
    tiebreak_at_six_all: bool = True,
) -> SetResult:
    """
    Simulate one set and return the set result.

    By default, this uses the modern common rule: a tiebreak at 6-6.
    """
    games_a = 0
    games_b = 0
    server = first_server

    while True:
        if tiebreak_at_six_all and games_a == 6 and games_b == 6:
            tiebreak_winner = simulate_tiebreak(
                server,
                p_a_serve_point_win,
                p_b_serve_point_win,
                rng,
            )

            if tiebreak_winner == PLAYER_A:
                games_a += 1
            else:
                games_b += 1

            return SetResult(
                winner=tiebreak_winner,
                games_a=games_a,
                games_b=games_b,
                next_server=other_player(server),
                had_tiebreak=True,
            )

        game_winner = simulate_game(
            server,
            p_a_serve_point_win,
            p_b_serve_point_win,
            rng,
        )

        if game_winner == PLAYER_A:
            games_a += 1
        else:
            games_b += 1

        server = other_player(server)

        player_has_six_games = games_a >= 6 or games_b >= 6
        player_leads_by_two_games = abs(games_a - games_b) >= 2

        if player_has_six_games and player_leads_by_two_games:
            return SetResult(
                winner=PLAYER_A if games_a > games_b else PLAYER_B,
                games_a=games_a,
                games_b=games_b,
                next_server=server,
                had_tiebreak=False,
            )


def simulate_match(
    p_a_serve_point_win: float,
    p_b_serve_point_win: float,
    best_of: int = 3,
    first_server: Optional[str] = PLAYER_A,
    rng: Optional[random.Random] = None,
) -> MatchResult:
    """Simulate a full best-of-3 or best-of-5 match."""
    validate_probability(p_a_serve_point_win, "p_a_serve_point_win")
    validate_probability(p_b_serve_point_win, "p_b_serve_point_win")

    if best_of not in (3, 5):
        raise ValueError("best_of must be 3 or 5")
    if first_server is not None and first_server not in (PLAYER_A, PLAYER_B):
        raise ValueError("first_server must be 'A', 'B', or None")

    if rng is None:
        rng = random.Random()

    sets_needed = best_of // 2 + 1
    sets_a = 0
    sets_b = 0
    server = first_server if first_server is not None else rng.choice([PLAYER_A, PLAYER_B])
    set_scores: List[SetResult] = []

    while sets_a < sets_needed and sets_b < sets_needed:
        set_result = simulate_set(
            server,
            p_a_serve_point_win,
            p_b_serve_point_win,
            rng,
        )
        set_scores.append(set_result)
        server = set_result.next_server

        if set_result.winner == PLAYER_A:
            sets_a += 1
        else:
            sets_b += 1

    return MatchResult(
        winner=PLAYER_A if sets_a > sets_b else PLAYER_B,
        sets_a=sets_a,
        sets_b=sets_b,
        set_scores=set_scores,
    )


def probability_to_decimal_odds(probability: float) -> Optional[float]:
    """Convert win probability to fair decimal odds."""
    if probability <= 0:
        return None
    return 1 / probability


def probability_to_american_odds(probability: float) -> Optional[int]:
    """Convert win probability to fair American odds."""
    if probability <= 0 or probability >= 1:
        return None

    decimal_odds = probability_to_decimal_odds(probability)
    if decimal_odds is None:
        return None

    if decimal_odds >= 2:
        return round((decimal_odds - 1) * 100)
    return round(-100 / (decimal_odds - 1))


def decimal_to_american(decimal_odds: Optional[float]) -> Optional[int]:
    """
    Convert decimal odds to American odds.

    This helper mirrors the naming from the simple pasted example, so later code
    can call either this function or probability_to_american_odds().
    """
    if decimal_odds is None or decimal_odds <= 1:
        return None
    if decimal_odds >= 2:
        return round((decimal_odds - 1) * 100)
    return round(-100 / (decimal_odds - 1))


def format_american_odds(odds: Optional[int]) -> str:
    """Format American odds with the usual plus/minus sign."""
    if odds is None:
        return "N/A"
    if odds > 0:
        return f"+{odds}"
    return str(odds)


def format_decimal_odds(odds: Optional[float]) -> str:
    """Format decimal odds for command-line output."""
    if odds is None:
        return "N/A"
    return f"{odds:.2f}"


def round_optional(value: Optional[float], digits: int) -> Optional[float]:
    """Round a number if it exists."""
    if value is None:
        return None
    return round(value, digits)


def format_match_score(
    match: MatchResult,
    player_a_name: str = "Player A",
    player_b_name: str = "Player B",
) -> str:
    """Return a simple match score, such as 'Player A wins 2-1'."""
    if match.winner == PLAYER_A:
        return f"{player_a_name} wins {match.sets_a}-{match.sets_b}"
    return f"{player_b_name} wins {match.sets_b}-{match.sets_a}"


def format_set_scoreline(
    match: MatchResult,
    player_a_name: str = "Player A",
    player_b_name: str = "Player B",
) -> str:
    """Return the set-by-set score from the match winner's perspective."""
    if match.winner == PLAYER_A:
        set_scores = [f"{set_result.games_a}-{set_result.games_b}" for set_result in match.set_scores]
        winner_name = player_a_name
    else:
        set_scores = [f"{set_result.games_b}-{set_result.games_a}" for set_result in match.set_scores]
        winner_name = player_b_name

    return f"{winner_name}: {' '.join(set_scores)}"


def counter_to_summary(counter: Counter, simulations: int, limit: int) -> List[Dict[str, object]]:
    """Turn a Counter into a beginner-friendly list of dictionaries."""
    return [
        {
            "outcome": outcome,
            "count": count,
            "probability": count / simulations,
        }
        for outcome, count in counter.most_common(limit)
    ]


def project_serve_point_probability(
    player_service_points_won: float,
    opponent_return_points_won: float,
) -> float:
    """
    Project serve-point win probability from service and return stats.

    Basic projection:
    Player serve-point win rate =
    average of the player's service points won and the opponent's return weakness.

    Example:
        If Player A wins 65% of service points and Player B wins 37% of return
        points, Player A's projected serve-point win probability is:

        (0.65 + (1 - 0.37)) / 2 = 0.64
    """
    validate_probability(player_service_points_won, "player_service_points_won")
    validate_probability(opponent_return_points_won, "opponent_return_points_won")
    return (player_service_points_won + (1 - opponent_return_points_won)) / 2


def run_simulations(
    p_a_serve_point_win: float,
    p_b_serve_point_win: float,
    best_of: int = 3,
    simulations: int = 100_000,
    first_server: Optional[str] = PLAYER_A,
    seed: Optional[int] = None,
    top_n_scores: int = 8,
    player_a_name: str = "Player A",
    player_b_name: str = "Player B",
) -> Dict[str, object]:
    """
    Run many simulated matches and return win probabilities, fair odds, and scores.

    Use decimal probabilities, not percentages:
        0.64 means Player A wins 64% of points on Player A's serve.
    """
    if simulations <= 0:
        raise ValueError("simulations must be greater than 0")

    rng = random.Random(seed)
    wins = Counter()
    match_score_counter = Counter()
    set_scoreline_counter = Counter()

    for _ in range(simulations):
        match = simulate_match(
            p_a_serve_point_win=p_a_serve_point_win,
            p_b_serve_point_win=p_b_serve_point_win,
            best_of=best_of,
            first_server=first_server,
            rng=rng,
        )
        wins[match.winner] += 1
        match_score_counter[format_match_score(match, player_a_name, player_b_name)] += 1
        set_scoreline_counter[format_set_scoreline(match, player_a_name, player_b_name)] += 1

    p_a_win = wins[PLAYER_A] / simulations
    p_b_win = wins[PLAYER_B] / simulations

    return {
        "simulations": simulations,
        "best_of": best_of,
        "inputs": {
            "p_a_serve_point_win": p_a_serve_point_win,
            "p_b_serve_point_win": p_b_serve_point_win,
            "first_server": first_server,
        },
        "players": {
            "player_a": player_a_name,
            "player_b": player_b_name,
        },
        "player_a": {
            "win_probability": p_a_win,
            "fair_decimal_odds": probability_to_decimal_odds(p_a_win),
            "fair_american_odds": probability_to_american_odds(p_a_win),
        },
        "player_b": {
            "win_probability": p_b_win,
            "fair_decimal_odds": probability_to_decimal_odds(p_b_win),
            "fair_american_odds": probability_to_american_odds(p_b_win),
        },
        "most_common_match_scores": counter_to_summary(
            match_score_counter,
            simulations,
            top_n_scores,
        ),
        "most_common_set_scorelines": counter_to_summary(
            set_scoreline_counter,
            simulations,
            top_n_scores,
        ),
    }


def run_monte_carlo(
    player_a: str,
    player_b: str,
    p_a_serve: float,
    p_b_serve: float,
    best_of: int = 3,
    simulations: int = 100_000,
    first_server: Optional[str] = None,
    seed: Optional[int] = None,
) -> Dict[str, object]:
    """
    Friendly wrapper based on the pasted example.

    This returns a compact dictionary keyed by the actual player names. It is
    useful for quick scripts, notebooks, and eventually a betting/value model.
    """
    results = run_simulations(
        p_a_serve_point_win=p_a_serve,
        p_b_serve_point_win=p_b_serve,
        best_of=best_of,
        simulations=simulations,
        first_server=first_server,
        seed=seed,
        top_n_scores=5,
        player_a_name=player_a,
        player_b_name=player_b,
    )

    player_a_results = results["player_a"]
    player_b_results = results["player_b"]

    return {
        player_a: {
            "win_probability": round(player_a_results["win_probability"], 4),
            "win_percentage": round(player_a_results["win_probability"] * 100, 2),
            "fair_decimal_odds": round_optional(player_a_results["fair_decimal_odds"], 2),
            "fair_american_odds": player_a_results["fair_american_odds"],
        },
        player_b: {
            "win_probability": round(player_b_results["win_probability"], 4),
            "win_percentage": round(player_b_results["win_probability"] * 100, 2),
            "fair_decimal_odds": round_optional(player_b_results["fair_decimal_odds"], 2),
            "fair_american_odds": player_b_results["fair_american_odds"],
        },
        "most_common_match_scores": [
            (row["outcome"], row["count"])
            for row in results["most_common_match_scores"]
        ],
    }


def print_simulation_summary(results: Dict[str, object]) -> None:
    """Print results in a readable command-line format."""
    player_a = results["player_a"]
    player_b = results["player_b"]
    player_names = results.get("players", {})
    player_a_name = player_names.get("player_a", "Player A")
    player_b_name = player_names.get("player_b", "Player B")

    print("Tennis Monte Carlo Results")
    print("=" * 28)
    print(f"Simulations: {results['simulations']:,}")
    print(f"Format: Best of {results['best_of']}")
    print()

    print("Win Probabilities and Fair Odds")
    print("-" * 32)
    print(
        f"{player_a_name}: "
        f"{player_a['win_probability']:.2%} | "
        f"Decimal {format_decimal_odds(player_a['fair_decimal_odds'])} | "
        f"American {format_american_odds(player_a['fair_american_odds'])}"
    )
    print(
        f"{player_b_name}: "
        f"{player_b['win_probability']:.2%} | "
        f"Decimal {format_decimal_odds(player_b['fair_decimal_odds'])} | "
        f"American {format_american_odds(player_b['fair_american_odds'])}"
    )
    print()

    print("Most Common Match Score Outcomes")
    print("-" * 32)
    for row in results["most_common_match_scores"]:
        print(f"{row['outcome']}: {row['probability']:.2%} ({row['count']:,})")
    print()

    print("Most Common Set-by-Set Scorelines")
    print("-" * 32)
    for row in results["most_common_set_scorelines"]:
        print(f"{row['outcome']}: {row['probability']:.2%} ({row['count']:,})")


def build_argument_parser() -> argparse.ArgumentParser:
    """Create the command-line options for the example runner."""
    parser = argparse.ArgumentParser(
        description="Run a tennis Monte Carlo simulation from serve-point win probabilities."
    )
    parser.add_argument(
        "--player-a",
        default="Player A",
        help="Display name for Player A. Default: Player A",
    )
    parser.add_argument(
        "--player-b",
        default="Player B",
        help="Display name for Player B. Default: Player B",
    )
    parser.add_argument(
        "--p-a-serve",
        type=float,
        default=0.64,
        help="Player A serve-point win probability, written as a decimal. Default: 0.64",
    )
    parser.add_argument(
        "--p-b-serve",
        type=float,
        default=0.61,
        help="Player B serve-point win probability, written as a decimal. Default: 0.61",
    )
    parser.add_argument(
        "--best-of",
        type=int,
        choices=(3, 5),
        default=3,
        help="Match format. Use 3 for best-of-3 or 5 for best-of-5. Default: 3",
    )
    parser.add_argument(
        "--simulations",
        type=int,
        default=100_000,
        help="Number of matches to simulate. Default: 100000",
    )
    parser.add_argument(
        "--first-server",
        choices=(PLAYER_A, PLAYER_B),
        default=PLAYER_A,
        help="Player who serves first. Default: A",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Optional random seed for repeatable results.",
    )
    return parser


if __name__ == "__main__":
    # Simple command-line example:
    # python tennis_monte_carlo.py --p-a-serve 0.64 --p-b-serve 0.61 --best-of 3 --simulations 100000
    #
    # Simple projection example for your own scripts:
    # p_a_serve = project_serve_point_probability(0.65, 0.37)
    # p_b_serve = project_serve_point_probability(0.62, 0.39)
    # results = run_monte_carlo("Player A", "Player B", p_a_serve, p_b_serve)
    args = build_argument_parser().parse_args()
    simulation_results = run_simulations(
        p_a_serve_point_win=args.p_a_serve,
        p_b_serve_point_win=args.p_b_serve,
        best_of=args.best_of,
        simulations=args.simulations,
        first_server=args.first_server,
        seed=args.seed,
        player_a_name=args.player_a,
        player_b_name=args.player_b,
    )
    print_simulation_summary(simulation_results)
