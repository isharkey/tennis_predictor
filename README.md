# Tennis Prediction

Mobile-first tennis prediction project with a Monte Carlo simulator that can be expanded into a betting/value model.

## Web Deployment

The app can run from a cloud host so your computer does not need to stay on. Deployment files are included:

- `Dockerfile`
- `render.yaml`
- `.github/workflows/deploy-render.yml`
- `DEPLOYMENT.md`

The fastest path is to push this project to a private GitHub repo and create a Render Blueprint from it. Add your API keys and the optional password gate as host environment variables, not in the browser.

For a public deployment, set:

```text
APP_BASIC_AUTH_USER
APP_BASIC_AUTH_PASSWORD
RAPIDAPI_KEY
ALLSPORTS_TENNIS_RAPIDAPI_KEY
```

See `DEPLOYMENT.md` for the full checklist.

## Tennis Monte Carlo Simulator

The simulator lives in `tennis_monte_carlo.py`. It simulates points, games, sets, tiebreaks, and full matches from each player's projected serve-point win probability.

Run the example from the project folder:

```powershell
python tennis_monte_carlo.py --player-a Sinner --player-b Alcaraz --p-a-serve 0.64 --p-b-serve 0.61 --best-of 3 --simulations 100000
```

If your normal `python` command is not available, use the bundled runtime in Codex:

```powershell
& 'C:\Users\Liam\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' tennis_monte_carlo.py --player-a Sinner --player-b Alcaraz --p-a-serve 0.64 --p-b-serve 0.61 --best-of 3 --simulations 100000
```

The output includes:

- Player A win probability
- Player B win probability
- Fair decimal odds
- Fair American odds
- Most common match score outcomes
- Most common set-by-set scorelines

## Replacing Example Inputs With Real Player Stats

The two most important inputs are:

- `--p-a-serve`: Player A's projected probability of winning a point on serve.
- `--p-b-serve`: Player B's projected probability of winning a point on serve.

These should be decimals, not percentages. For example:

- `0.64` means 64%
- `0.615` means 61.5%

A simple way to create those serve-point projections is to average a player's serve strength with the opponent's return weakness:

```python
from tennis_monte_carlo import project_serve_point_probability

p_a_serve = project_serve_point_probability(
    player_service_points_won=0.65,
    opponent_return_points_won=0.37,
)

p_b_serve = project_serve_point_probability(
    player_service_points_won=0.62,
    opponent_return_points_won=0.39,
)
```

That means:

- Player A wins 65% of their service points.
- Player B wins 37% of return points, so Player B allows opponents to win about 63% of service points.
- Player A's projected serve-point win rate becomes `(0.65 + 0.63) / 2 = 0.64`.

Then run the simulator with those projected values:

```python
from tennis_monte_carlo import project_serve_point_probability, run_monte_carlo

player_a = "Sinner"
player_b = "Alcaraz"

p_a_serve = project_serve_point_probability(0.65, 0.37)
p_b_serve = project_serve_point_probability(0.62, 0.39)

results = run_monte_carlo(
    player_a=player_a,
    player_b=player_b,
    p_a_serve=p_a_serve,
    p_b_serve=p_b_serve,
    best_of=3,
    simulations=100000,
)

print(results)
```

For better real-world inputs later, replace the simple projection with your own model. Useful factors to add next are surface-specific serve/return stats, recent form, opponent quality, fatigue, indoor/outdoor conditions, and injury/news adjustments.

## Context Factors

Shared weather, fatigue, and injury helpers live in `tennis_context_factors.py`.

Use small decimal adjustments:

- `0.010` means the factor adds about one percentage point before weighting.
- `-0.020` means the factor subtracts about two percentage points before weighting.
- Negative fatigue and injury values usually mean the player is hurt by that factor.

Default factor weights are:

- weather: `0.35`
- fatigue: `0.40`
- injury: `0.70`

Basic usage:

```python
from tennis_context_factors import PlayerContext, weighted_context_adjustment

context = PlayerContext(
    weather_factor=0.01,
    fatigue_factor=-0.02,
    injury_factor=-0.03,
)

adjustment = weighted_context_adjustment(context)
```

## Analytical Tennis Model

The analytical model lives in `tennis_analytical_model.py`. It does not run random simulations. Instead, it uses formulas and dynamic programming to estimate hold probability, set win probability, match win probability, fair odds, and betting edge.

Run the example:

```powershell
python tennis_analytical_model.py
```

Use it from another Python file:

```python
from tennis_analytical_model import PlayerStats, analyze_match

player_a = PlayerStats(
    name="Sinner",
    service_points_won=0.65,
    return_points_won=0.39,
    surface_adjustment=0.01,
    form_adjustment=0.005,
    weather_adjustment=0.002,
    fatigue_adjustment=-0.004,
    injury_adjustment=0.0,
)

player_b = PlayerStats(
    name="Alcaraz",
    service_points_won=0.62,
    return_points_won=0.37,
)

analysis = analyze_match(
    player_a=player_a,
    player_b=player_b,
    best_of=3,
    sportsbook_odds_a=-130,
    sportsbook_odds_b=110,
)

print(analysis)
```

The analytical output includes `monte_carlo_inputs`, which can be passed later into the Monte Carlo simulator:

```python
from tennis_monte_carlo import run_monte_carlo

mc_inputs = analysis["monte_carlo_inputs"]

monte_carlo_results = run_monte_carlo(
    player_a="Sinner",
    player_b="Alcaraz",
    p_a_serve=mc_inputs["p_a_serve"],
    p_b_serve=mc_inputs["p_b_serve"],
    best_of=3,
    simulations=100000,
)
```

## Regression Model

The regression model lives in `tennis_regression_model.py`. It is designed to train a logistic regression model from historical match data with Player A / Player B stat columns.

It uses:

- `pandas`
- `scikit-learn`
- `joblib`

Run the file:

```powershell
python tennis_regression_model.py
```

If `scikit-learn` or `joblib` is not installed, the file will print the install command instead of crashing. Install the training dependencies with:

```powershell
pip install pandas scikit-learn joblib
```

Expected CSV target column:

- `a_won`: `1` if Player A won the match, `0` if Player B won.

Important CSV feature columns include:

- `a_elo`, `b_elo`
- `a_rank`, `b_rank`
- `a_service_points_won`, `b_service_points_won`
- `a_return_points_won`, `b_return_points_won`
- `a_hold_pct`, `b_hold_pct`
- `a_break_pct`, `b_break_pct`
- `a_recent_win_pct`, `b_recent_win_pct`
- `a_recent_matches_played`, `b_recent_matches_played`
- `a_rest_days`, `b_rest_days`
- optional `a_weather_factor`, `b_weather_factor`
- optional `a_fatigue_factor`, `b_fatigue_factor`
- optional `a_injury_factor`, `b_injury_factor`
- `a_surface_win_pct`, `b_surface_win_pct`
- `a_surface_hold_pct`, `b_surface_hold_pct`
- `a_surface_break_pct`, `b_surface_break_pct`
- optional `round_number`

Basic usage:

```python
from tennis_regression_model import TennisRegressionModel

model = TennisRegressionModel()
training_results = model.train("historical_tennis_matches.csv")
model.save_model()

prediction = model.analyze_betting_edge(
    match_data={
        "player_a": "Sinner",
        "player_b": "Alcaraz",
        "a_elo": 1900,
        "b_elo": 1885,
        "a_rank": 1,
        "b_rank": 2,
        "a_service_points_won": 0.66,
        "b_service_points_won": 0.64,
        "a_return_points_won": 0.39,
        "b_return_points_won": 0.38,
        "a_hold_pct": 0.86,
        "b_hold_pct": 0.84,
        "a_break_pct": 0.25,
        "b_break_pct": 0.24,
        "a_recent_win_pct": 0.80,
        "b_recent_win_pct": 0.76,
        "a_recent_matches_played": 10,
        "b_recent_matches_played": 9,
        "a_rest_days": 2,
        "b_rest_days": 2,
        "a_weather_factor": 0.01,
        "b_weather_factor": -0.01,
        "a_fatigue_factor": -0.02,
        "b_fatigue_factor": -0.05,
        "a_injury_factor": 0.0,
        "b_injury_factor": -0.03,
        "a_surface_win_pct": 0.78,
        "b_surface_win_pct": 0.75,
        "a_surface_hold_pct": 0.87,
        "b_surface_hold_pct": 0.85,
        "a_surface_break_pct": 0.26,
        "b_surface_break_pct": 0.24,
        "round_number": 3,
    },
    sportsbook_odds_a=-135,
    sportsbook_odds_b=115,
)
```

## Poisson Count Prop Model

The Poisson model lives in `tennis_poisson_model.py`. It is a supporting model for count-based props, not the main match-winner model.

Use it for markets such as:

- aces
- double faults
- breaks of serve
- tiebreak count
- other over/under count props

Run the example:

```powershell
python tennis_poisson_model.py
```

Basic usage:

```python
from tennis_poisson_model import analyze_poisson_prop, estimate_lambda_with_adjustments

projected_aces = estimate_lambda_with_adjustments(
    player_average=7.1,
    opponent_allowed_average=6.5,
    surface_adjustment=0.4,
    form_adjustment=0.2,
    weather_adjustment=0.1,
    fatigue_adjustment=-0.05,
    injury_adjustment=0.0,
)

aces_prop = analyze_poisson_prop(
    event_name="Aces",
    player_name="Sinner",
    projected_lambda=projected_aces,
    line=6.5,
    sportsbook_over_odds=-110,
    sportsbook_under_odds=-110,
)

print(aces_prop.to_dict())
```

## Surface Elo Model

The surface Elo model lives in `tennis_surface_elo.py`. It tracks overall Elo plus separate surface Elo ratings for:

- hard
- clay
- grass
- indoor hard

Historical CSV columns required:

- `date`
- `player_a`
- `player_b`
- `surface`
- `winner`

Run the example:

```powershell
python tennis_surface_elo.py
```

Basic usage:

```python
from tennis_surface_elo import SurfaceEloModel

elo_model = SurfaceEloModel()

history = elo_model.process_historical_matches(
    "historical_tennis_matches.csv"
)

training_features = elo_model.export_pre_match_history()
current_ratings = elo_model.export_player_ratings()

prediction = elo_model.predict_match(
    player_a="Sinner",
    player_b="Alcaraz",
    surface="clay",
)
```

`export_pre_match_history()` is the safer training export because it saves each match's Elo values before the model updates ratings with that match result.

## Full Prediction Engine

The all-in-one starter engine lives in `tennis_prediction_engine_full.py`. It combines the Monte Carlo, analytical, Poisson, surface Elo, Glicko-lite, Bradley-Terry, regression, gradient boosting, live Markov, Bayesian live update, market odds, weather, fatigue, injury, matchup, calibration, and ensemble pieces in one file for now.

Install the optional machine-learning dependencies:

```powershell
pip install -r requirements.txt
```

Run the example:

```powershell
python tennis_prediction_engine_full.py
```

The built-in pre-match example runs 100,000 simulations. To replace the sample inputs, edit the two `PlayerSnapshot(...)` blocks near the bottom of the file with real player stats such as service points won, return points won, Elo ratings, recent form, rest days, injury flag, aces average, and surface-specific stats. Edit the `WeatherContext(...)` block for outdoor conditions, or set `indoor=True` for indoor matches.

The regression and boosting models are included but stay inactive until you train them with a historical CSV. The rest of the engine runs immediately.

## Preloaded Match Slate

The browser app loads matches from `matches_preload.json` on startup. Each match includes:

- tournament
- start time
- level
- tour
- round and court
- player names
- model input stats

The app sorts and groups the slate by tournament, time, and level. Tap any match row to load it into the prediction form and rebuild the ensemble/parlay output.

Use the date picker and `Refresh Live` button in the app to pull the full daily tennis slate through the local server. The browser calls `/api/refresh-slate`, the server requests the AllSportsAPI Tennis daily slate, and `matches_preload.json` is replaced with the API slate. The RapidAPI key stays in `.env` on the computer and is never sent to the phone/browser.

The app also builds a `Players` tab from the loaded slate. It shows:

- selected-match player cards
- all loaded players
- rank, hold percentage, ace rate, form, fatigue, and injury values
- surfaces, tours, levels, tournaments, next match, and opponent
- player search and sorting

When API player profiles and stats are available, map them into the same match/player fields so they appear in this tab automatically.

### Automatic Learning From Finished Matches

When the live slate includes finished matches, the app now reads the API winner and set scores automatically. It updates the learning weights for the metrics available in the final score:

- winner
- total games
- tiebreak played
- sets played

Breaks and aces are only updated when a data source provides those finished-match stats. Each finished match is learned once and saved locally in the browser, so refreshing the same slate will not double-count it.

The Learning tab also shows:

- current algorithm weight percentages for every prediction metric
- each model's current reliability score by metric
- recent weight changes with the reason for the move

For example, a model can move up on `Total games` when its game projection scored better than the other models on a finished match. A model can move down when it was less accurate than the field average for that metric.

### Live And Odds Boards

The app includes a `Live` tab and an `Odds` tab.

The `Live` tab uses the loaded slate's in-progress score state to adjust the pre-match model probability while the match is happening. It shows a live pick, model probability, fair odds, and live book edge when live moneyline prices are available.

The `Odds` tab reads sportsbook prices from `odds_preload.json`, compares each price to the model probability, and flags +EV bets when:

```text
model probability > sportsbook implied probability
```

The starter `odds_preload.json` is example data. Replace it with real sportsbook lines from your odds provider using this shape:

```json
{
  "source": "Your odds provider",
  "generatedAt": "2026-07-03T22:45:00.000Z",
  "markets": [
    {
      "matchId": "16433366",
      "playerA": "Player A",
      "playerB": "Player B",
      "books": [
        {
          "name": "DraftKings",
          "markets": [
            {
              "marketType": "moneyline",
              "outcomes": [
                { "selection": "Player A", "side": "A", "odds": -120 },
                { "selection": "Player B", "side": "B", "odds": 100 }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

Supported market types are `moneyline`, `live_moneyline`, `total_games`, `tiebreak`, `sets`, `aces`, and `breaks`. Supported US book names in the app filter are DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, Fanatics, BetRivers, and Hard Rock.

Use `tennis_match_slate_loader.py` to refresh the slate file:

```powershell
python tennis_match_slate_loader.py
```

That rewrites the existing `matches_preload.json` with metadata and sorted matches.

Load matches from a CSV:

```powershell
python tennis_match_slate_loader.py --csv daily_matches.csv --output matches_preload.json
```

Load matches from a raw API JSON export:

```powershell
python tennis_match_slate_loader.py --json raw_matches.json --output matches_preload.json
```

Load matches from a configured JJRM365 endpoint:

```powershell
python tennis_match_slate_loader.py --jjrm365-endpoint today_matches --param date=2026-07-03
```

Load matches from the AllSportsAPI Tennis daily flow:

```powershell
python tennis_match_slate_loader.py --allsports-date 2026-07-03 --raw-output raw_allsports_tennis.json
```

The AllSportsAPI tennis flow uses:

```text
GET /api/tennis/calendar/{day}/{month}/{year}/categories
GET /api/tennis/category/{category_id}/events/{day}/{month}/{year}
```

The loader accepts flexible field names like `playerA`, `playerB`, `homeTeam`, `awayTeam`, `tournament`, `level`, `surface`, `startTime`, and common API alternatives. Missing model stats fall back to safe defaults until we map exact player-stat fields from the live API.

## Live Data API

The SofaScore/RapidAPI client lives in `tennis_data_client.py`. It includes the player season-statistics endpoint:

```text
/player/statistics/seasons?player_id=998697
```

Create a local `.env` file from `.env.example`:

```powershell
copy .env.example .env
```

Then add your RapidAPI key:

```env
SOFASCORE_RAPIDAPI_KEY=your_key_here
SOFASCORE_RAPIDAPI_HOST=sofascore6.p.rapidapi.com
```

Run the API example:

```powershell
python tennis_data_client.py
```

Basic usage:

```python
from tennis_data_client import SofaScoreRapidAPIClient, build_player_snapshot_from_sofascore

client = SofaScoreRapidAPIClient.from_env()
raw_stats = client.get_player_statistics_seasons(player_id=998697)
national_team_stats = client.get_player_national_team_statistics(player_id=837099)

player = build_player_snapshot_from_sofascore(
    player_name="Player A",
    sofascore_stats=raw_stats,
    surface="hard",
)
```

The converter uses safe defaults when the API response does not expose an exact field. After you inspect real responses, update the candidate field names inside `build_player_snapshot_from_sofascore()` so the app maps SofaScore stats into the prediction engine more accurately.

### JJRM365 Tennis API

`tennis_data_client.py` also supports `Tennis API - ATP WTA ITF` by `jjrm365` on RapidAPI. Use this as the secondary source because the free plan has a limited daily pull count.

```env
JJRM365_TENNIS_RAPIDAPI_KEY=your_key_here
JJRM365_TENNIS_RAPIDAPI_HOST=tennis-api-atp-wta-itf.p.rapidapi.com
JJRM365_TENNIS_RAPIDAPI_BASE_URL=https://tennis-api-atp-wta-itf.p.rapidapi.com
```

Generic usage:

```python
from tennis_data_client import JJRM365TennisAPIClient

client = JJRM365TennisAPIClient.from_env()
data = client.get("/endpoint/from/rapidapi/docs", {"league": "atp"})
```

Arbitrage odds usage:

```python
odds = client.get_arbitrage_odds(event_id=3700653, market_id=1)
```

You can also store common endpoint paths in `.env`:

```env
JJRM365_TENNIS_ENDPOINT_TODAY_MATCHES=/endpoint/from/docs
```

Then call:

```python
today = client.get_configured_endpoint("today_matches")
```

This keeps the app ready to use JJRM365 for extra ATP, WTA, and ITF match/player data once the exact endpoint paths are copied from RapidAPI.

### AllSportsAPI Tennis

The app also supports the AllSportsAPI Tennis RapidAPI source. Add this to `.env`:

```env
ALLSPORTS_TENNIS_RAPIDAPI_KEY=your_key_here
ALLSPORTS_TENNIS_RAPIDAPI_HOST=tennisapi1.p.rapidapi.com
ALLSPORTS_TENNIS_RAPIDAPI_BASE_URL=https://tennisapi1.p.rapidapi.com
```

Then refresh the app slate:

```powershell
python tennis_match_slate_loader.py --allsports-date 2026-07-03 --raw-output raw_allsports_tennis.json
```

The loader follows the documented daily tennis recipe: find the categories with play that day, then fetch each category's events and merge/dedupe them into `matches_preload.json`.

### LiveScore6

`tennis_data_client.py` also includes a generic LiveScore6 client. The endpoint you provided is a news endpoint:

```text
GET /news/list?category=soccer
```

Add this to `.env`:

```env
LIVESCORE6_RAPIDAPI_KEY=your_key_here
LIVESCORE6_RAPIDAPI_HOST=livescore6.p.rapidapi.com
LIVESCORE6_RAPIDAPI_BASE_URL=https://livescore6.p.rapidapi.com
```

Usage:

```python
from tennis_data_client import LiveScore6APIClient

client = LiveScore6APIClient.from_env()
news = client.get_news_list(category="soccer")
```

This source is not connected to the tennis prediction slate yet because the sample endpoint is soccer news. If you find LiveScore6 tennis schedule, player-stat, or odds endpoints, we can plug them into the same loader flow.

## Parlay Builder

The app now includes a `Parlays` tab. Run the ensemble, then open that tab to see:

- recommended parlay slip
- ranked player winner legs
- ranked match props
- ranked player props
- fair decimal and American odds
- estimated combined hit probability
- simple correlation risk warning

The parlay styles are:

- `Conservative`: higher probability threshold
- `Balanced`: default mix of confidence and upside
- `Aggressive`: allows lower-probability legs for bigger payouts

The browser app suggests lines like `Over 22.5 games` or `Player A over 6.5 aces` based on the model projection. Treat those as target lines to compare against the sportsbook. If the book offers a worse line, skip it.

There is also a Python helper in `tennis_parlay_builder.py`:

```powershell
python tennis_parlay_builder.py
```

Use it later when the full prediction engine starts outputting a pool of real sportsbook markets from the live data API.
