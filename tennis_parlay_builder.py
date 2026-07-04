"""
tennis_parlay_builder.py

Beginner-friendly parlay builder for tennis predictions.

Use this as a supporting layer after your models produce probabilities for:
- player winners
- player props
- match props

The builder ranks legs, keeps one leg per market group, prefers category diversity,
and applies a simple correlation haircut to the combined parlay probability.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import reduce
from operator import mul
from typing import Dict, Iterable, List, Optional


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def american_odds_to_probability(odds: float) -> float:
    if odds < 0:
        return abs(odds) / (abs(odds) + 100)
    return 100 / (odds + 100)


def probability_to_decimal_odds(probability: float) -> float:
    probability = clamp(probability, 0.0001, 0.9999)
    return round(1 / probability, 2)


def probability_to_american_odds(probability: float) -> int:
    probability = clamp(probability, 0.0001, 0.9999)
    if probability >= 0.5:
        return round(-100 * probability / (1 - probability))
    return round(100 * (1 - probability) / probability)


def american_to_decimal_odds(odds: float) -> float:
    if odds > 0:
        return round(1 + odds / 100, 2)
    return round(1 + 100 / abs(odds), 2)


@dataclass
class ParlayLeg:
    category: str
    market: str
    pick: str
    probability: float
    group: str
    family: str
    reliability: float = 0.60
    sportsbook_american_odds: Optional[float] = None
    note: str = ""

    def __post_init__(self) -> None:
        self.probability = clamp(self.probability, 0.01, 0.99)
        self.reliability = clamp(self.reliability, 0.01, 0.99)

    @property
    def fair_decimal_odds(self) -> float:
        return probability_to_decimal_odds(self.probability)

    @property
    def fair_american_odds(self) -> int:
        return probability_to_american_odds(self.probability)

    @property
    def edge_pct(self) -> Optional[float]:
        if self.sportsbook_american_odds is None:
            return None
        implied = american_odds_to_probability(self.sportsbook_american_odds)
        return round((self.probability - implied) * 100, 2)

    @property
    def score(self) -> float:
        probability_score = (self.probability - 0.5) * 2
        reliability_score = self.reliability
        edge_bonus = 0.0
        if self.edge_pct is not None:
            edge_bonus = clamp(self.edge_pct / 10, -0.15, 0.20)
        return probability_score * 0.68 + reliability_score * 0.24 + edge_bonus

    def to_dict(self) -> Dict[str, object]:
        return {
            "category": self.category,
            "market": self.market,
            "pick": self.pick,
            "probability": round(self.probability, 4),
            "fair_decimal_odds": self.fair_decimal_odds,
            "fair_american_odds": self.fair_american_odds,
            "sportsbook_american_odds": self.sportsbook_american_odds,
            "edge_pct": self.edge_pct,
            "reliability": round(self.reliability, 4),
            "group": self.group,
            "family": self.family,
            "note": self.note,
        }


@dataclass
class ParlaySlip:
    legs: List[ParlayLeg]
    combined_probability: float
    fair_decimal_odds: float
    fair_american_odds: int
    correlation_risk: float
    risk_label: str
    sportsbook_decimal_odds: Optional[float] = None
    sportsbook_implied_probability: Optional[float] = None
    edge_pct: Optional[float] = None

    def to_dict(self) -> Dict[str, object]:
        return {
            "legs": [leg.to_dict() for leg in self.legs],
            "combined_probability": round(self.combined_probability, 4),
            "fair_decimal_odds": self.fair_decimal_odds,
            "fair_american_odds": self.fair_american_odds,
            "correlation_risk": round(self.correlation_risk, 4),
            "risk_label": self.risk_label,
            "sportsbook_decimal_odds": self.sportsbook_decimal_odds,
            "sportsbook_implied_probability": self.sportsbook_implied_probability,
            "edge_pct": self.edge_pct,
        }


class ParlayBuilder:
    profiles = {
        "conservative": {"min_probability": 0.62, "max_risk": 0.14},
        "balanced": {"min_probability": 0.56, "max_risk": 0.22},
        "aggressive": {"min_probability": 0.51, "max_risk": 0.34},
    }

    def rank_legs(self, legs: Iterable[ParlayLeg]) -> List[ParlayLeg]:
        return sorted(legs, key=lambda leg: leg.score, reverse=True)

    def build_best_slip(
        self,
        legs: Iterable[ParlayLeg],
        leg_count: int = 3,
        profile: str = "balanced",
        require_category_diversity: bool = True,
    ) -> ParlaySlip:
        settings = self.profiles.get(profile, self.profiles["balanced"])
        leg_count = int(clamp(leg_count, 2, 8))
        ranked = self.rank_legs(legs)

        pool = [leg for leg in ranked if leg.probability >= settings["min_probability"]]
        if len(pool) < leg_count:
            relaxed_min = max(0.51, settings["min_probability"] - 0.06)
            pool = [leg for leg in ranked if leg.probability >= relaxed_min]

        selected: List[ParlayLeg] = []
        if require_category_diversity:
            priority = ["Winner", "Match prop", "Player prop"]
            for category in priority[:leg_count]:
                best = next((leg for leg in pool if leg.category == category and self.compatible(leg, selected)), None)
                if best is not None:
                    selected.append(best)

        for leg in pool:
            if len(selected) >= leg_count:
                break
            if self.compatible(leg, selected):
                selected.append(leg)

        for leg in ranked:
            if len(selected) >= leg_count:
                break
            if leg.probability > 0.5 and self.compatible(leg, selected):
                selected.append(leg)

        risk = self.estimate_correlation_risk(selected)
        while risk > settings["max_risk"] and len(selected) > 2:
            weakest_index = min(range(len(selected)), key=lambda index: selected[index].score)
            selected.pop(weakest_index)
            risk = self.estimate_correlation_risk(selected)

        raw_probability = reduce(mul, (leg.probability for leg in selected), 1.0)
        combined_probability = clamp(raw_probability * (1 - risk), 0.001, 0.99) if selected else 0.0
        sportsbook_decimal_odds = self.combined_sportsbook_decimal_odds(selected)
        sportsbook_implied = None
        edge_pct = None

        if sportsbook_decimal_odds is not None:
            sportsbook_implied = round(1 / sportsbook_decimal_odds, 4)
            edge_pct = round((combined_probability - sportsbook_implied) * 100, 2)

        return ParlaySlip(
            legs=selected,
            combined_probability=combined_probability,
            fair_decimal_odds=probability_to_decimal_odds(combined_probability),
            fair_american_odds=probability_to_american_odds(combined_probability),
            correlation_risk=risk,
            risk_label=self.risk_label(risk),
            sportsbook_decimal_odds=sportsbook_decimal_odds,
            sportsbook_implied_probability=sportsbook_implied,
            edge_pct=edge_pct,
        )

    def compatible(self, candidate: ParlayLeg, selected: List[ParlayLeg]) -> bool:
        return all(candidate.group != leg.group for leg in selected)

    def estimate_correlation_risk(self, legs: List[ParlayLeg]) -> float:
        risk = 0.0
        for index, first in enumerate(legs):
            for second in legs[index + 1 :]:
                families = {first.family, second.family}

                if {"games", "sets"} <= families:
                    risk += 0.07
                if {"games", "tiebreak"} <= families:
                    risk += 0.08
                if {"games", "aces"} <= families:
                    risk += 0.04
                if {"tiebreak", "aces"} <= families:
                    risk += 0.04
                if {"breaks", "sets"} <= families:
                    risk += 0.04
                if {"winner", "player-breaks"} <= families:
                    risk += 0.05
                if {"winner", "player-aces"} <= families:
                    risk += 0.03

        return clamp(risk, 0.0, 0.45)

    def risk_label(self, risk: float) -> str:
        if risk < 0.08:
            return "Low"
        if risk < 0.18:
            return "Medium"
        return "High"

    def combined_sportsbook_decimal_odds(self, legs: List[ParlayLeg]) -> Optional[float]:
        if not legs or any(leg.sportsbook_american_odds is None for leg in legs):
            return None

        decimal_odds = reduce(
            mul,
            (american_to_decimal_odds(float(leg.sportsbook_american_odds)) for leg in legs),
            1.0,
        )
        return round(decimal_odds, 2)


if __name__ == "__main__":
    sample_legs = [
        ParlayLeg(
            category="Winner",
            market="Match winner",
            pick="Player A moneyline",
            probability=0.68,
            group="winner",
            family="winner",
            reliability=0.64,
            sportsbook_american_odds=-145,
        ),
        ParlayLeg(
            category="Match prop",
            market="Total games",
            pick="Over 22.5 games",
            probability=0.61,
            group="total-games",
            family="games",
            reliability=0.59,
            sportsbook_american_odds=-110,
            note="Model projects 24.1 total games.",
        ),
        ParlayLeg(
            category="Match prop",
            market="Tiebreak played",
            pick="Yes",
            probability=0.57,
            group="tiebreak",
            family="tiebreak",
            reliability=0.56,
            sportsbook_american_odds=120,
        ),
        ParlayLeg(
            category="Player prop",
            market="Player A aces",
            pick="Over 6.5 aces",
            probability=0.63,
            group="player-a-aces",
            family="player-aces",
            reliability=0.61,
            sportsbook_american_odds=-105,
        ),
        ParlayLeg(
            category="Player prop",
            market="Player B breaks",
            pick="Under 2.5 breaks",
            probability=0.59,
            group="player-b-breaks",
            family="player-breaks",
            reliability=0.58,
            sportsbook_american_odds=-115,
        ),
    ]

    builder = ParlayBuilder()
    slip = builder.build_best_slip(sample_legs, leg_count=3, profile="balanced")

    print("BEST PARLAY")
    for leg in slip.legs:
        print(f"- {leg.pick}: {leg.probability:.1%}, fair odds {leg.fair_american_odds}")

    print("\nSLIP SUMMARY")
    print(slip.to_dict())
