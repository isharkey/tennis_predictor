"""
Shared context-factor helpers for tennis models.

These helpers keep weather, fatigue, and injury adjustments consistent across
the analytical, Monte Carlo, Poisson, regression, and dashboard layers.

Use small decimal adjustments:
- 0.010 means add one percentage point
- -0.015 means subtract one and a half percentage points
"""

from dataclasses import dataclass


@dataclass
class ContextFactorWeights:
    """
    Weights for turning raw context scores into model adjustments.

    The defaults are intentionally conservative. They can be tuned later from
    historical prediction accuracy.
    """

    weather: float = 0.35
    fatigue: float = 0.40
    injury: float = 0.70


@dataclass
class PlayerContext:
    """
    Player-specific context scores.

    Scores are decimals where 0.00 means no impact. Negative values hurt the
    player and positive values help the player.
    """

    weather_factor: float = 0.0
    fatigue_factor: float = 0.0
    injury_factor: float = 0.0


def weighted_context_adjustment(
    context: PlayerContext,
    weights: ContextFactorWeights | None = None,
) -> float:
    """Combine weather, fatigue, and injury into one decimal adjustment."""
    if weights is None:
        weights = ContextFactorWeights()

    return (
        context.weather_factor * weights.weather
        + context.fatigue_factor * weights.fatigue
        + context.injury_factor * weights.injury
    )


def clamp_adjustment(value: float, low: float = -0.05, high: float = 0.05) -> float:
    """
    Keep context impact in a sane range.

    By default, the combined adjustment cannot move a probability by more than
    five percentage points.
    """
    return max(low, min(high, value))


def apply_context_to_probability(
    base_probability: float,
    context: PlayerContext,
    weights: ContextFactorWeights | None = None,
    low: float = 0.45,
    high: float = 0.75,
) -> float:
    """Apply a weighted context adjustment to a probability."""
    adjustment = clamp_adjustment(weighted_context_adjustment(context, weights))
    return max(low, min(high, base_probability + adjustment))
