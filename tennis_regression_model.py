"""
Logistic regression tennis match winner model.

This file trains from historical match data, builds Player A minus Player B
difference features, predicts Player A win probability, converts probabilities
to fair odds, and compares the model to sportsbook prices.

It is built to sit beside the Monte Carlo and analytical models in this project.
"""

import pandas as pd

try:
    import joblib
except ModuleNotFoundError:
    joblib = None

try:
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, log_loss, roc_auc_score
except ModuleNotFoundError:
    train_test_split = None
    Pipeline = None
    StandardScaler = None
    LogisticRegression = None
    accuracy_score = None
    log_loss = None
    roc_auc_score = None


def require_ml_dependencies():
    """
    Confirm the regression training dependencies are installed.

    Install them later with:
    pip install pandas scikit-learn joblib
    """
    if Pipeline is None or StandardScaler is None or LogisticRegression is None:
        raise ImportError(
            "scikit-learn is required for TennisRegressionModel. "
            "Install it with: pip install scikit-learn"
        )

    if joblib is None:
        raise ImportError(
            "joblib is required to save/load TennisRegressionModel. "
            "Install it with: pip install joblib"
        )


TARGET_COLUMN = "a_won"

REQUIRED_COLUMNS = [
    "a_elo",
    "b_elo",
    "a_rank",
    "b_rank",
    "a_service_points_won",
    "b_service_points_won",
    "a_return_points_won",
    "b_return_points_won",
    "a_hold_pct",
    "b_hold_pct",
    "a_break_pct",
    "b_break_pct",
    "a_recent_win_pct",
    "b_recent_win_pct",
    "a_recent_matches_played",
    "b_recent_matches_played",
    "a_rest_days",
    "b_rest_days",
    "a_surface_win_pct",
    "b_surface_win_pct",
    "a_surface_hold_pct",
    "b_surface_hold_pct",
    "a_surface_break_pct",
    "b_surface_break_pct",
]

OPTIONAL_COLUMNS = [
    "round_number",
    "a_weather_factor",
    "b_weather_factor",
    "a_fatigue_factor",
    "b_fatigue_factor",
    "a_injury_factor",
    "b_injury_factor",
]


def validate_columns(df, include_target=False):
    """Raise a friendly error if the input data is missing required columns."""
    required = REQUIRED_COLUMNS.copy()
    if include_target:
        required.append(TARGET_COLUMN)

    missing_columns = [column for column in required if column not in df.columns]
    if missing_columns:
        missing_text = ", ".join(missing_columns)
        raise ValueError(f"Missing required columns: {missing_text}")


def american_odds_to_probability(odds):
    if odds < 0:
        return abs(odds) / (abs(odds) + 100)
    return 100 / (odds + 100)


def probability_to_american_odds(probability):
    if probability <= 0 or probability >= 1:
        return None

    if probability >= 0.5:
        return round(-100 * probability / (1 - probability))

    return round(100 * (1 - probability) / probability)


def probability_to_decimal_odds(probability):
    if probability <= 0:
        return None
    return round(1 / probability, 2)


class TennisRegressionModel:
    def __init__(self):
        require_ml_dependencies()

        self.model = Pipeline([
            ("scaler", StandardScaler()),
            ("logistic_regression", LogisticRegression(max_iter=1000))
        ])

        self.feature_columns = None

    def create_features(self, df):
        """
        Converts raw Player A / Player B stats into model-ready difference features.
        """
        validate_columns(df, include_target=False)

        features = pd.DataFrame()

        # Rating / ranking features
        features["elo_diff"] = df["a_elo"] - df["b_elo"]

        # Lower ranking is better, so B rank - A rank favors Player A
        features["rank_diff"] = df["b_rank"] - df["a_rank"]

        # Serve / return features
        features["serve_points_won_diff"] = (
            df["a_service_points_won"] - df["b_service_points_won"]
        )

        features["return_points_won_diff"] = (
            df["a_return_points_won"] - df["b_return_points_won"]
        )

        features["hold_pct_diff"] = df["a_hold_pct"] - df["b_hold_pct"]
        features["break_pct_diff"] = df["a_break_pct"] - df["b_break_pct"]

        # Form / fatigue features
        features["recent_win_pct_diff"] = (
            df["a_recent_win_pct"] - df["b_recent_win_pct"]
        )

        features["recent_matches_played_diff"] = (
            df["a_recent_matches_played"] - df["b_recent_matches_played"]
        )

        features["rest_days_diff"] = df["a_rest_days"] - df["b_rest_days"]

        # Surface-specific features
        features["surface_win_pct_diff"] = (
            df["a_surface_win_pct"] - df["b_surface_win_pct"]
        )

        features["surface_hold_pct_diff"] = (
            df["a_surface_hold_pct"] - df["b_surface_hold_pct"]
        )

        features["surface_break_pct_diff"] = (
            df["a_surface_break_pct"] - df["b_surface_break_pct"]
        )

        # Optional tournament round feature
        if "round_number" in df.columns:
            features["round_number"] = df["round_number"]

        # Optional context features. Positive values should favor that player.
        if "a_weather_factor" in df.columns and "b_weather_factor" in df.columns:
            features["weather_factor_diff"] = (
                df["a_weather_factor"] - df["b_weather_factor"]
            )

        if "a_fatigue_factor" in df.columns and "b_fatigue_factor" in df.columns:
            features["fatigue_factor_diff"] = (
                df["a_fatigue_factor"] - df["b_fatigue_factor"]
            )

        if "a_injury_factor" in df.columns and "b_injury_factor" in df.columns:
            features["injury_factor_diff"] = (
                df["a_injury_factor"] - df["b_injury_factor"]
            )

        return features

    def align_features_to_training(self, features):
        """
        Keep prediction columns in the exact same order used during training.

        This protects us when optional features such as round_number are present
        in training data but missing from a single future match.
        """
        if self.feature_columns is None:
            raise ValueError("Train or load the model before predicting a match.")

        return features.reindex(columns=self.feature_columns, fill_value=0)

    def train(self, csv_path, test_size=0.2, random_state=42):
        """
        Trains the regression model from a historical tennis match CSV.
        """

        df = pd.read_csv(csv_path)
        return self.train_from_dataframe(
            df,
            test_size=test_size,
            random_state=random_state,
        )

    def train_from_dataframe(self, df, test_size=0.2, random_state=42):
        """
        Trains the regression model from an already-loaded DataFrame.

        This is useful for notebooks, tests, and the runnable example below.
        """

        validate_columns(df, include_target=True)

        X = self.create_features(df)
        y = df[TARGET_COLUMN]

        self.feature_columns = X.columns.tolist()

        X_train, X_test, y_train, y_test = train_test_split(
            X,
            y,
            test_size=test_size,
            random_state=random_state,
            stratify=y
        )

        self.model.fit(X_train, y_train)

        predictions = self.model.predict(X_test)
        probabilities = self.model.predict_proba(X_test)[:, 1]

        accuracy = accuracy_score(y_test, predictions)
        loss = log_loss(y_test, probabilities)
        auc = roc_auc_score(y_test, probabilities)

        results = {
            "accuracy": round(accuracy, 4),
            "log_loss": round(loss, 4),
            "roc_auc": round(auc, 4),
            "training_rows": len(X_train),
            "testing_rows": len(X_test),
            "features_used": self.feature_columns
        }

        return results

    def predict_match(self, match_data):
        """
        Predicts Player A win probability for one match.

        match_data should be a dictionary with the same stat columns used in training.
        """

        df = pd.DataFrame([match_data])
        X = self.create_features(df)
        X = self.align_features_to_training(X)

        probability_a = self.model.predict_proba(X)[0][1]
        probability_b = 1 - probability_a

        return {
            "player_a": match_data.get("player_a", "Player A"),
            "player_b": match_data.get("player_b", "Player B"),
            "player_a_win_probability": round(probability_a, 4),
            "player_a_win_pct": round(probability_a * 100, 2),
            "player_a_fair_decimal_odds": probability_to_decimal_odds(probability_a),
            "player_a_fair_american_odds": probability_to_american_odds(probability_a),
            "player_b_win_probability": round(probability_b, 4),
            "player_b_win_pct": round(probability_b * 100, 2),
            "player_b_fair_decimal_odds": probability_to_decimal_odds(probability_b),
            "player_b_fair_american_odds": probability_to_american_odds(probability_b)
        }

    def analyze_betting_edge(self, match_data, sportsbook_odds_a, sportsbook_odds_b):
        """
        Compares model probability against sportsbook odds.
        """

        prediction = self.predict_match(match_data)

        model_prob_a = prediction["player_a_win_probability"]
        model_prob_b = prediction["player_b_win_probability"]

        implied_prob_a = american_odds_to_probability(sportsbook_odds_a)
        implied_prob_b = american_odds_to_probability(sportsbook_odds_b)

        edge_a = model_prob_a - implied_prob_a
        edge_b = model_prob_b - implied_prob_b

        prediction["player_a_sportsbook_odds"] = sportsbook_odds_a
        prediction["player_a_sportsbook_implied_pct"] = round(implied_prob_a * 100, 2)
        prediction["player_a_model_edge_pct"] = round(edge_a * 100, 2)

        prediction["player_b_sportsbook_odds"] = sportsbook_odds_b
        prediction["player_b_sportsbook_implied_pct"] = round(implied_prob_b * 100, 2)
        prediction["player_b_model_edge_pct"] = round(edge_b * 100, 2)

        if edge_a > edge_b and edge_a > 0:
            prediction["best_value_side"] = prediction["player_a"]
        elif edge_b > edge_a and edge_b > 0:
            prediction["best_value_side"] = prediction["player_b"]
        else:
            prediction["best_value_side"] = "No clear value"

        return prediction

    def save_model(self, file_path="tennis_regression_model.pkl"):
        if self.feature_columns is None:
            raise ValueError("Train the model before saving it.")

        joblib.dump({
            "model": self.model,
            "feature_columns": self.feature_columns
        }, file_path)

    def load_model(self, file_path="tennis_regression_model.pkl"):
        saved = joblib.load(file_path)
        self.model = saved["model"]
        self.feature_columns = saved["feature_columns"]


def create_example_training_data():
    """
    Create a tiny example dataset so this file can run before real data exists.

    Replace this with a historical tennis match CSV when you are ready:
    model.train("historical_tennis_matches.csv")
    """
    rows = [
        [1850, 1785, 24, 41, 0.655, 0.628, 0.389, 0.365, 0.835, 0.802, 0.247, 0.221, 0.70, 0.55, 10, 8, 2, 1, 0.68, 0.57, 0.84, 0.79, 0.25, 0.21, 2, 1],
        [1785, 1850, 41, 24, 0.628, 0.655, 0.365, 0.389, 0.802, 0.835, 0.221, 0.247, 0.55, 0.70, 8, 10, 1, 2, 0.57, 0.68, 0.79, 0.84, 0.21, 0.25, 2, 0],
        [1910, 1810, 8, 18, 0.670, 0.621, 0.402, 0.358, 0.855, 0.790, 0.268, 0.214, 0.82, 0.61, 9, 11, 3, 1, 0.74, 0.59, 0.86, 0.78, 0.27, 0.20, 3, 1],
        [1810, 1910, 18, 8, 0.621, 0.670, 0.358, 0.402, 0.790, 0.855, 0.214, 0.268, 0.61, 0.82, 11, 9, 1, 3, 0.59, 0.74, 0.78, 0.86, 0.20, 0.27, 3, 0],
        [1740, 1765, 52, 47, 0.606, 0.612, 0.344, 0.351, 0.762, 0.774, 0.198, 0.205, 0.48, 0.52, 12, 7, 0, 4, 0.50, 0.53, 0.75, 0.77, 0.19, 0.20, 1, 0],
        [1765, 1740, 47, 52, 0.612, 0.606, 0.351, 0.344, 0.774, 0.762, 0.205, 0.198, 0.52, 0.48, 7, 12, 4, 0, 0.53, 0.50, 0.77, 0.75, 0.20, 0.19, 1, 1],
        [1888, 1880, 11, 12, 0.642, 0.640, 0.381, 0.379, 0.821, 0.819, 0.241, 0.239, 0.67, 0.65, 6, 7, 2, 2, 0.69, 0.68, 0.82, 0.82, 0.24, 0.24, 4, 1],
        [1880, 1888, 12, 11, 0.640, 0.642, 0.379, 0.381, 0.819, 0.821, 0.239, 0.241, 0.65, 0.67, 7, 6, 2, 2, 0.68, 0.69, 0.82, 0.82, 0.24, 0.24, 4, 0],
        [1685, 1825, 83, 31, 0.585, 0.632, 0.331, 0.372, 0.724, 0.803, 0.176, 0.226, 0.40, 0.64, 14, 8, 1, 3, 0.44, 0.61, 0.72, 0.80, 0.17, 0.22, 1, 0],
        [1825, 1685, 31, 83, 0.632, 0.585, 0.372, 0.331, 0.803, 0.724, 0.226, 0.176, 0.64, 0.40, 8, 14, 3, 1, 0.61, 0.44, 0.80, 0.72, 0.22, 0.17, 1, 1],
        [1930, 1840, 5, 22, 0.681, 0.635, 0.410, 0.363, 0.872, 0.807, 0.282, 0.219, 0.86, 0.60, 8, 9, 4, 1, 0.78, 0.58, 0.88, 0.80, 0.29, 0.21, 5, 1],
        [1840, 1930, 22, 5, 0.635, 0.681, 0.363, 0.410, 0.807, 0.872, 0.219, 0.282, 0.60, 0.86, 9, 8, 1, 4, 0.58, 0.78, 0.80, 0.88, 0.21, 0.29, 5, 0],
    ]

    columns = [
        "a_elo", "b_elo", "a_rank", "b_rank",
        "a_service_points_won", "b_service_points_won",
        "a_return_points_won", "b_return_points_won",
        "a_hold_pct", "b_hold_pct",
        "a_break_pct", "b_break_pct",
        "a_recent_win_pct", "b_recent_win_pct",
        "a_recent_matches_played", "b_recent_matches_played",
        "a_rest_days", "b_rest_days",
        "a_surface_win_pct", "b_surface_win_pct",
        "a_surface_hold_pct", "b_surface_hold_pct",
        "a_surface_break_pct", "b_surface_break_pct",
        "round_number",
        "a_won",
    ]

    df = pd.DataFrame(rows, columns=columns)
    df["a_weather_factor"] = [0.01, -0.01, 0.02, -0.02, 0.0, 0.0, 0.01, -0.01, -0.02, 0.02, 0.01, -0.01]
    df["b_weather_factor"] = [-0.01, 0.01, -0.02, 0.02, 0.0, 0.0, -0.01, 0.01, 0.02, -0.02, -0.01, 0.01]
    df["a_fatigue_factor"] = [-0.02, -0.04, -0.01, -0.03, -0.05, -0.02, -0.01, -0.02, -0.04, -0.01, -0.01, -0.03]
    df["b_fatigue_factor"] = [-0.04, -0.02, -0.03, -0.01, -0.02, -0.05, -0.02, -0.01, -0.01, -0.04, -0.03, -0.01]
    df["a_injury_factor"] = [0.0, -0.02, 0.0, -0.01, -0.03, 0.0, 0.0, -0.01, -0.04, 0.0, 0.0, -0.02]
    df["b_injury_factor"] = [-0.02, 0.0, -0.01, 0.0, 0.0, -0.03, -0.01, 0.0, 0.0, -0.04, -0.02, 0.0]

    return df


if __name__ == "__main__":
    try:
        model = TennisRegressionModel()

        # Real training later:
        # training_results = model.train("historical_tennis_matches.csv")
        # model.save_model()

        training_data = create_example_training_data()
        training_results = model.train_from_dataframe(
            training_data,
            test_size=0.25,
            random_state=7,
        )
        print("Training results")
        print(training_results)

        example_match = {
            "player_a": "Player A",
            "player_b": "Player B",

            "a_elo": 1850,
            "b_elo": 1785,

            "a_rank": 24,
            "b_rank": 41,

            "a_service_points_won": 0.655,
            "b_service_points_won": 0.628,

            "a_return_points_won": 0.389,
            "b_return_points_won": 0.365,

            "a_hold_pct": 0.835,
            "b_hold_pct": 0.802,

            "a_break_pct": 0.247,
            "b_break_pct": 0.221,

            "a_recent_win_pct": 0.70,
            "b_recent_win_pct": 0.55,

            "a_recent_matches_played": 10,
            "b_recent_matches_played": 8,

            "a_rest_days": 2,
            "b_rest_days": 1,

            "a_surface_win_pct": 0.68,
            "b_surface_win_pct": 0.57,

            "a_surface_hold_pct": 0.84,
            "b_surface_hold_pct": 0.79,

            "a_surface_break_pct": 0.25,
            "b_surface_break_pct": 0.21,

            "round_number": 2,
            "a_weather_factor": 0.01,
            "b_weather_factor": -0.01,
            "a_fatigue_factor": -0.02,
            "b_fatigue_factor": -0.05,
            "a_injury_factor": 0.0,
            "b_injury_factor": -0.03,
        }

        prediction = model.analyze_betting_edge(
            example_match,
            sportsbook_odds_a=-135,
            sportsbook_odds_b=115
        )

        print("\nExample prediction")
        print(prediction)
    except ImportError as error:
        print(error)
