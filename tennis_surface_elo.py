"""
Surface-specific Elo model for tennis.

This model tracks both overall Elo and separate surface Elo ratings for hard,
clay, grass, and indoor hard. When processing historical matches, it records
pre-match Elo features before updating ratings after the match, which avoids
data leakage when the history is used for model training.
"""

import pandas as pd
from dataclasses import dataclass, field


VALID_SURFACES = ["hard", "clay", "grass", "indoor_hard"]
REQUIRED_HISTORY_COLUMNS = ["date", "player_a", "player_b", "surface", "winner"]


@dataclass
class PlayerEloProfile:
    name: str
    overall_elo: float = 1500.0
    surface_elo: dict = field(default_factory=dict)
    overall_matches: int = 0
    surface_matches: dict = field(default_factory=dict)

    def __post_init__(self):
        for surface in VALID_SURFACES:
            self.surface_elo.setdefault(surface, 1500.0)
            self.surface_matches.setdefault(surface, 0)


class SurfaceEloModel:
    def __init__(
        self,
        base_elo=1500.0,
        k_overall=24,
        k_surface=32,
        max_surface_weight=0.75,
        matches_for_full_surface_weight=20
    ):
        self.base_elo = base_elo
        self.k_overall = k_overall
        self.k_surface = k_surface
        self.max_surface_weight = max_surface_weight
        self.matches_for_full_surface_weight = matches_for_full_surface_weight
        self.players = {}
        self.elo_history = []

    def get_player(self, player_name):
        if player_name not in self.players:
            self.players[player_name] = PlayerEloProfile(
                name=player_name,
                overall_elo=self.base_elo
            )

        return self.players[player_name]

    def normalize_surface(self, surface):
        """
        Convert source-data surface names into one supported surface key.
        """
        surface = str(surface).lower().strip()

        if surface in ["hard court", "outdoor hard", "hardcourt"]:
            return "hard"

        if surface in ["indoor", "indoor hard court", "indoor hardcourt"]:
            return "indoor_hard"

        if surface in ["clay court"]:
            return "clay"

        if surface in ["grass court"]:
            return "grass"

        if surface not in VALID_SURFACES:
            return "hard"

        return surface

    def expected_win_probability(self, player_rating, opponent_rating):
        """
        Converts two Elo ratings into Player A's expected win probability.
        """
        return 1 / (1 + 10 ** ((opponent_rating - player_rating) / 400))

    def surface_weight(self, player, surface):
        """
        The more matches a player has on a surface,
        the more we trust the surface-specific Elo.
        """
        surface_match_count = player.surface_matches.get(surface, 0)

        weight = surface_match_count / self.matches_for_full_surface_weight
        weight = min(weight, self.max_surface_weight)

        return weight

    def effective_rating(self, player_name, surface):
        """
        Blends overall Elo and surface Elo.

        Early in a player's history, surface Elo may be unreliable.
        So we do not use 100% surface Elo immediately.
        """
        surface = self.normalize_surface(surface)
        player = self.get_player(player_name)

        s_weight = self.surface_weight(player, surface)
        overall_weight = 1 - s_weight

        return (
            player.surface_elo[surface] * s_weight
            + player.overall_elo * overall_weight
        )

    def predict_match(self, player_a, player_b, surface):
        surface = self.normalize_surface(surface)

        rating_a = self.effective_rating(player_a, surface)
        rating_b = self.effective_rating(player_b, surface)

        prob_a = self.expected_win_probability(rating_a, rating_b)
        prob_b = 1 - prob_a

        return {
            "player_a": player_a,
            "player_b": player_b,
            "surface": surface,
            "player_a_effective_elo": round(rating_a, 2),
            "player_b_effective_elo": round(rating_b, 2),
            "player_a_win_probability": round(prob_a, 4),
            "player_b_win_probability": round(prob_b, 4),
            "player_a_win_pct": round(prob_a * 100, 2),
            "player_b_win_pct": round(prob_b * 100, 2),
            "elo_diff": round(rating_a - rating_b, 2)
        }

    def update_match(self, player_a, player_b, surface, winner):
        """
        Updates overall Elo and surface Elo after a completed match.

        winner must match player_a or player_b.
        """
        if winner not in [player_a, player_b]:
            raise ValueError("winner must match player_a or player_b")

        surface = self.normalize_surface(surface)

        a = self.get_player(player_a)
        b = self.get_player(player_b)

        rating_a_before = self.effective_rating(player_a, surface)
        rating_b_before = self.effective_rating(player_b, surface)

        expected_a = self.expected_win_probability(
            rating_a_before,
            rating_b_before
        )

        expected_b = 1 - expected_a

        actual_a = 1 if winner == player_a else 0
        actual_b = 1 if winner == player_b else 0

        # Update overall Elo
        a.overall_elo += self.k_overall * (actual_a - expected_a)
        b.overall_elo += self.k_overall * (actual_b - expected_b)

        # Update surface Elo
        a.surface_elo[surface] += self.k_surface * (actual_a - expected_a)
        b.surface_elo[surface] += self.k_surface * (actual_b - expected_b)

        # Update match counts
        a.overall_matches += 1
        b.overall_matches += 1

        a.surface_matches[surface] += 1
        b.surface_matches[surface] += 1

        return {
            "surface": surface,
            "player_a": player_a,
            "player_b": player_b,
            "winner": winner,
            "player_a_expected_win_probability": round(expected_a, 4),
            "player_b_expected_win_probability": round(expected_b, 4),
            "player_a_overall_elo_after": round(a.overall_elo, 2),
            "player_b_overall_elo_after": round(b.overall_elo, 2),
            "player_a_surface_elo_after": round(a.surface_elo[surface], 2),
            "player_b_surface_elo_after": round(b.surface_elo[surface], 2),
        }

    def validate_history_dataframe(self, df):
        """
        Confirms the historical match data has the required columns.
        """
        missing_columns = [
            column for column in REQUIRED_HISTORY_COLUMNS
            if column not in df.columns
        ]

        if missing_columns:
            missing_text = ", ".join(missing_columns)
            raise ValueError(f"Missing required columns: {missing_text}")

    def process_historical_matches(self, csv_path):
        """
        Reads a historical match CSV and updates Elo chronologically.

        Required columns:
        date, player_a, player_b, surface, winner
        """
        df = pd.read_csv(csv_path)
        return self.process_historical_matches_from_dataframe(df)

    def process_historical_matches_from_dataframe(self, df):
        """
        Updates Elo from an already-loaded DataFrame in chronological order.

        This is useful for notebooks, tests, and app integrations.
        """
        self.validate_history_dataframe(df)

        df["date"] = pd.to_datetime(df["date"])
        df = df.sort_values("date")

        history = []

        for _, row in df.iterrows():
            player_a = row["player_a"]
            player_b = row["player_b"]
            surface = row["surface"]
            winner = row["winner"]

            pre_match_prediction = self.predict_match(
                player_a,
                player_b,
                surface
            )

            # Save features before update_match() runs. These are the values
            # that were knowable before the match, so they are safe for training.
            pre_match_record = {
                "date": row["date"],
                "player_a": player_a,
                "player_b": player_b,
                "surface": self.normalize_surface(surface),
                "winner": winner,
                "player_a_pre_match_elo": pre_match_prediction["player_a_effective_elo"],
                "player_b_pre_match_elo": pre_match_prediction["player_b_effective_elo"],
                "pre_match_elo_diff": pre_match_prediction["elo_diff"],
                "player_a_pre_match_win_probability": pre_match_prediction["player_a_win_probability"],
                "player_b_pre_match_win_probability": pre_match_prediction["player_b_win_probability"],
                "player_a_won": 1 if winner == player_a else 0,
            }

            update_result = self.update_match(
                player_a,
                player_b,
                surface,
                winner
            )

            audit_record = {
                **pre_match_record,
                "player_a_overall_elo_after": update_result["player_a_overall_elo_after"],
                "player_b_overall_elo_after": update_result["player_b_overall_elo_after"],
                "player_a_surface_elo_after": update_result["player_a_surface_elo_after"],
                "player_b_surface_elo_after": update_result["player_b_surface_elo_after"],
            }

            history.append(audit_record)
            self.elo_history.append(pre_match_record)

        return pd.DataFrame(history)

    def export_pre_match_history(self):
        """
        Export leakage-safe pre-match Elo history for model training.

        This intentionally excludes post-match Elo columns.
        """
        return pd.DataFrame(self.elo_history)

    def get_player_profile(self, player_name):
        player = self.get_player(player_name)

        return {
            "name": player.name,
            "overall_elo": round(player.overall_elo, 2),
            "overall_matches": player.overall_matches,
            "surface_elo": {
                surface: round(rating, 2)
                for surface, rating in player.surface_elo.items()
            },
            "surface_matches": player.surface_matches
        }

    def export_player_ratings(self):
        """
        Export current overall and surface Elo ratings for every tracked player.
        """
        rows = []

        for player_name, player in self.players.items():
            row = {
                "player": player_name,
                "overall_elo": round(player.overall_elo, 2),
                "overall_matches": player.overall_matches,
            }

            for surface in VALID_SURFACES:
                row[f"{surface}_elo"] = round(player.surface_elo[surface], 2)
                row[f"{surface}_matches"] = player.surface_matches[surface]

            rows.append(row)

        if not rows:
            return pd.DataFrame()

        return pd.DataFrame(rows).sort_values("overall_elo", ascending=False)


def probability_to_american_odds(probability):
    if probability <= 0 or probability >= 1:
        return None

    if probability >= 0.5:
        return round(-100 * probability / (1 - probability))

    return round(100 * (1 - probability) / probability)


if __name__ == "__main__":
    elo_model = SurfaceEloModel()

    # Manual example match updates
    elo_model.update_match(
        player_a="Player A",
        player_b="Player B",
        surface="clay",
        winner="Player A"
    )

    elo_model.update_match(
        player_a="Player A",
        player_b="Player C",
        surface="grass",
        winner="Player C"
    )

    prediction = elo_model.predict_match(
        player_a="Player A",
        player_b="Player B",
        surface="clay"
    )

    print("\nMATCH PREDICTION")
    print(prediction)

    print("\nPLAYER A PROFILE")
    print(elo_model.get_player_profile("Player A"))

    print("\nALL RATINGS")
    print(elo_model.export_player_ratings())

    # Mini historical-data example. In real use, call:
    # elo_model.process_historical_matches("historical_tennis_matches.csv")
    historical_matches = pd.DataFrame([
        {
            "date": "2024-01-01",
            "player_a": "Player A",
            "player_b": "Player B",
            "surface": "hard",
            "winner": "Player A",
        },
        {
            "date": "2024-01-08",
            "player_a": "Player B",
            "player_b": "Player C",
            "surface": "indoor hard",
            "winner": "Player C",
        },
    ])

    history_model = SurfaceEloModel()
    audit_history = history_model.process_historical_matches_from_dataframe(
        historical_matches
    )

    print("\nAUDIT HISTORY WITH POST-MATCH RATINGS")
    print(audit_history)

    print("\nLEAKAGE-SAFE PRE-MATCH HISTORY")
    print(history_model.export_pre_match_history())

    # To process a real CSV:
    # history = elo_model.process_historical_matches("historical_tennis_matches.csv")
    # history.to_csv("surface_elo_history.csv", index=False)
    #
    # ratings = elo_model.export_player_ratings()
    # ratings.to_csv("current_surface_elo_ratings.csv", index=False)
