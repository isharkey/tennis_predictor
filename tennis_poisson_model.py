"""
Poisson model for tennis count-based betting props.

Use this as a supporting model for count markets such as:
- aces
- double faults
- breaks of serve
- tiebreak count
- other over/under stat props

Do not use this as the main match-winner model. Match winner projections should
come from the Monte Carlo, analytical, regression, or ensemble layers.
"""

import math
from dataclasses import asdict, dataclass

from tennis_context_factors import (
    ContextFactorWeights,
    PlayerContext,
    weighted_context_adjustment,
)


@dataclass
class PoissonPropResult:
    """
    Result object for one count-based prop.

    projected_lambda is the expected count. For example, if a player is expected
    to hit 7.4 aces, lambda is 7.4.
    """

    event_name: str
    player_name: str
    projected_lambda: float
    line: float
    over_probability: float
    under_probability: float
    fair_over_american_odds: int | None
    fair_under_american_odds: int | None
    sportsbook_over_odds: int | None = None
    sportsbook_under_odds: int | None = None
    over_edge_pct: float | None = None
    under_edge_pct: float | None = None

    def to_dict(self):
        """Return a plain dictionary for dashboards, APIs, or JSON output."""
        return asdict(self)


def validate_lambda(lam):
    """Make sure lambda is a usable expected count."""
    if lam < 0:
        raise ValueError("lambda must be 0 or greater")


def poisson_pmf(k, lam):
    """
    Probability that an event happens exactly k times.
    """
    validate_lambda(lam)

    if k < 0:
        return 0.0

    return (math.exp(-lam) * lam**k) / math.factorial(k)


def poisson_cdf(k, lam):
    """
    Probability that an event happens k times or fewer.
    """
    validate_lambda(lam)

    if k < 0:
        return 0.0

    return sum(poisson_pmf(i, lam) for i in range(k + 1))


def probability_at_least(k, lam):
    """
    Probability that an event happens at least k times.
    """
    validate_lambda(lam)
    return 1 - poisson_cdf(k - 1, lam)


def probability_over_line(line, lam):
    """
    For betting lines:
    Over 6.5 means 7 or more.
    Over 6 means 7 or more, with 6 as a push in real betting.
    This function treats over as strictly greater than the line.
    """
    validate_lambda(lam)
    needed = math.floor(line) + 1
    return probability_at_least(needed, lam)


def probability_under_line(line, lam):
    """
    Under 6.5 means 6 or fewer.
    Under 6 means 5 or fewer, with 6 as a push in real betting.
    This function treats under as strictly less than the line for whole numbers.
    """
    validate_lambda(lam)

    if line == int(line):
        max_result = int(line) - 1
    else:
        max_result = math.floor(line)

    return poisson_cdf(max_result, lam)


def probability_exactly(k, lam):
    """
    Probability of exactly k events.

    This is a small readability wrapper around poisson_pmf().
    """
    return poisson_pmf(k, lam)


def probability_to_american_odds(probability):
    """
    Convert a model probability into fair American odds.
    """
    if probability <= 0 or probability >= 1:
        return None

    if probability >= 0.5:
        return round(-100 * probability / (1 - probability))

    return round(100 * (1 - probability) / probability)


def american_odds_to_probability(odds):
    """
    Convert sportsbook American odds into implied probability.
    """
    if odds < 0:
        return abs(odds) / (abs(odds) + 100)

    return 100 / (odds + 100)


def estimate_lambda_basic(player_average, opponent_allowed_average):
    """
    Simple projection:
    Player average combined with opponent allowed average.
    """
    projected_lambda = (player_average + opponent_allowed_average) / 2
    return max(0.01, projected_lambda)


def estimate_lambda_with_adjustments(
    player_average,
    opponent_allowed_average,
    surface_adjustment=0.0,
    form_adjustment=0.0,
    matchup_adjustment=0.0,
    pace_adjustment=0.0,
    weather_adjustment=0.0,
    fatigue_adjustment=0.0,
    injury_adjustment=0.0,
    context_weights=None,
):
    """
    Example:
    player_average = Player averages 7.1 aces per match
    opponent_allowed_average = Opponent allows 6.5 aces per match

    Adjustments are added directly to lambda.
    """
    base_lambda = estimate_lambda_basic(
        player_average,
        opponent_allowed_average
    )

    adjusted_lambda = (
        base_lambda
        + surface_adjustment
        + form_adjustment
        + matchup_adjustment
        + pace_adjustment
        + weighted_context_adjustment(
            PlayerContext(
                weather_factor=weather_adjustment,
                fatigue_factor=fatigue_adjustment,
                injury_factor=injury_adjustment,
            ),
            context_weights or ContextFactorWeights(),
        )
    )

    return max(0.01, adjusted_lambda)


def analyze_poisson_prop(
    event_name,
    player_name,
    projected_lambda,
    line,
    sportsbook_over_odds=None,
    sportsbook_under_odds=None
):
    """
    Analyze one over/under count prop.

    Example:
    event_name = "Aces"
    player_name = "Player A"
    projected_lambda = 7.4
    line = 6.5
    """
    validate_lambda(projected_lambda)

    over_probability = probability_over_line(line, projected_lambda)
    under_probability = probability_under_line(line, projected_lambda)

    fair_over_odds = probability_to_american_odds(over_probability)
    fair_under_odds = probability_to_american_odds(under_probability)

    over_edge = None
    under_edge = None

    if sportsbook_over_odds is not None:
        implied_over = american_odds_to_probability(sportsbook_over_odds)
        over_edge = over_probability - implied_over

    if sportsbook_under_odds is not None:
        implied_under = american_odds_to_probability(sportsbook_under_odds)
        under_edge = under_probability - implied_under

    return PoissonPropResult(
        event_name=event_name,
        player_name=player_name,
        projected_lambda=round(projected_lambda, 3),
        line=line,
        over_probability=round(over_probability, 4),
        under_probability=round(under_probability, 4),
        fair_over_american_odds=fair_over_odds,
        fair_under_american_odds=fair_under_odds,
        sportsbook_over_odds=sportsbook_over_odds,
        sportsbook_under_odds=sportsbook_under_odds,
        over_edge_pct=round(over_edge * 100, 2) if over_edge is not None else None,
        under_edge_pct=round(under_edge * 100, 2) if under_edge is not None else None
    )


def poisson_count_distribution(lam, max_count=20):
    """
    Returns the probability for each exact count.
    Useful for dashboards.
    """
    validate_lambda(lam)

    distribution = {}

    for k in range(max_count + 1):
        distribution[k] = round(poisson_pmf(k, lam), 4)

    return distribution


def compare_two_poisson_counts(lambda_a, lambda_b, max_count=30):
    """
    Compares two expected counts.

    Example:
    Player A expected breaks = 2.3
    Player B expected breaks = 1.7

    Returns:
    Probability A has more breaks,
    Probability B has more breaks,
    Probability they tie.
    """
    validate_lambda(lambda_a)
    validate_lambda(lambda_b)

    a_more = 0.0
    b_more = 0.0
    tie = 0.0

    for a_count in range(max_count + 1):
        for b_count in range(max_count + 1):
            probability = poisson_pmf(a_count, lambda_a) * poisson_pmf(b_count, lambda_b)

            if a_count > b_count:
                a_more += probability
            elif b_count > a_count:
                b_more += probability
            else:
                tie += probability

    return {
        "a_more_probability": round(a_more, 4),
        "b_more_probability": round(b_more, 4),
        "tie_probability": round(tie, 4),
        "a_more_pct": round(a_more * 100, 2),
        "b_more_pct": round(b_more * 100, 2),
        "tie_pct": round(tie * 100, 2)
    }


if __name__ == "__main__":
    # Example 1:
    # Player A aces prop

    player_name = "Player A"
    event_name = "Aces"

    player_aces_average = 7.1
    opponent_aces_allowed = 6.5

    projected_aces = estimate_lambda_with_adjustments(
        player_average=player_aces_average,
        opponent_allowed_average=opponent_aces_allowed,
        surface_adjustment=0.4,
        form_adjustment=0.2,
        matchup_adjustment=0.0,
        pace_adjustment=0.0,
        weather_adjustment=0.1,
        fatigue_adjustment=-0.05,
        injury_adjustment=0.0,
    )

    aces_result = analyze_poisson_prop(
        event_name=event_name,
        player_name=player_name,
        projected_lambda=projected_aces,
        line=6.5,
        sportsbook_over_odds=-110,
        sportsbook_under_odds=-110
    )

    print("\nACES PROP RESULT")
    print(aces_result)

    print("\nEXACT ACES DISTRIBUTION")
    print(poisson_count_distribution(projected_aces, max_count=15))

    # Example 2:
    # Compare expected breaks of serve

    player_a_expected_breaks = 2.2
    player_b_expected_breaks = 1.7

    break_comparison = compare_two_poisson_counts(
        lambda_a=player_a_expected_breaks,
        lambda_b=player_b_expected_breaks
    )

    print("\nBREAK COMPARISON")
    print(break_comparison)
