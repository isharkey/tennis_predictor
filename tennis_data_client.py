"""
tennis_data_client.py

Small data clients for pulling real tennis data through RapidAPI.

Current sources:
- SofaScore via sofascore6
- Tennis API - ATP WTA ITF by jjrm365
- AllSportsAPI Tennis via tennisapi1
- LiveScore6 via livescore6

Setup:
1. Copy .env.example to .env.
2. Put your RapidAPI key(s) in .env:
       SOFASCORE_RAPIDAPI_KEY=your_key_here
       JJRM365_TENNIS_RAPIDAPI_KEY=your_key_here
       ALLSPORTS_TENNIS_RAPIDAPI_KEY=your_key_here
       LIVESCORE6_RAPIDAPI_KEY=your_key_here
3. Run:
       python tennis_data_client.py

This file intentionally does not hardcode your API key.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

try:
    from tennis_prediction_engine_full import PlayerSnapshot
except Exception:
    PlayerSnapshot = None


SOFASCORE_DEFAULT_HOST = "sofascore6.p.rapidapi.com"
SOFASCORE_DEFAULT_BASE_URL = "https://sofascore6.p.rapidapi.com/api/sofascore/v1"
ALLSPORTS_TENNIS_DEFAULT_HOST = "tennisapi1.p.rapidapi.com"
ALLSPORTS_TENNIS_DEFAULT_BASE_URL = "https://tennisapi1.p.rapidapi.com"
LIVESCORE6_DEFAULT_HOST = "livescore6.p.rapidapi.com"
LIVESCORE6_DEFAULT_BASE_URL = "https://livescore6.p.rapidapi.com"


def load_env_file(env_path: str = ".env") -> None:
    """Load a simple KEY=value .env file without adding a dependency."""
    path = Path(env_path)
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


class SofaScoreRapidAPIClient:
    """Tiny wrapper around SofaScore endpoints hosted on RapidAPI."""

    def __init__(
        self,
        api_key: str,
        host: str = SOFASCORE_DEFAULT_HOST,
        base_url: str = SOFASCORE_DEFAULT_BASE_URL,
        timeout_seconds: int = 20,
    ):
        if not api_key:
            raise ValueError("Missing RapidAPI key. Set SOFASCORE_RAPIDAPI_KEY in your .env file.")

        self.api_key = api_key
        self.host = host
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls, env_path: str = ".env") -> "SofaScoreRapidAPIClient":
        load_env_file(env_path)
        return cls(
            api_key=os.getenv("SOFASCORE_RAPIDAPI_KEY", ""),
            host=os.getenv("SOFASCORE_RAPIDAPI_HOST", SOFASCORE_DEFAULT_HOST),
        )

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Request any SofaScore endpoint path.

        Example:
            client.get("/player/statistics/seasons", {"player_id": 998697})
        """
        clean_path = path if path.startswith("/") else f"/{path}"
        url = f"{self.base_url}{clean_path}"

        if params:
            query = urllib.parse.urlencode(params)
            url = f"{url}?{query}"

        request = urllib.request.Request(
            url,
            headers={
                "Content-Type": "application/json",
                "x-rapidapi-host": self.host,
                "x-rapidapi-key": self.api_key,
            },
            method="GET",
        )

        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            body = response.read().decode("utf-8")
            return json.loads(body)

    def get_player_statistics_seasons(self, player_id: int) -> Dict[str, Any]:
        """Fetch the exact player season-statistics endpoint from your curl example."""
        return self.get(
            "/player/statistics/seasons",
            {"player_id": player_id},
        )

    def get_player_national_team_statistics(self, player_id: int) -> Dict[str, Any]:
        """Fetch the SofaScore player national-team-statistics endpoint."""
        return self.get(
            "/player/national-team-statistics",
            {"player_id": player_id},
        )

    def save_json(self, data: Dict[str, Any], output_path: str) -> None:
        Path(output_path).write_text(json.dumps(data, indent=2), encoding="utf-8")


class JJRM365TennisAPIClient:
    """
    Generic client for "Tennis API - ATP WTA ITF" by jjrm365 on RapidAPI.

    RapidAPI products can change endpoint paths over time. This wrapper lets you
    paste the host/base URL from RapidAPI into .env and call any documented path.
    """

    def __init__(
        self,
        api_key: str,
        host: str,
        base_url: Optional[str] = None,
        timeout_seconds: int = 20,
    ):
        if not api_key:
            raise ValueError("Missing RapidAPI key. Set JJRM365_TENNIS_RAPIDAPI_KEY in your .env file.")
        if not host or "put_" in host:
            raise ValueError("Missing JJRM365 RapidAPI host. Paste the x-rapidapi-host value into .env.")

        self.api_key = api_key
        self.host = host
        self.base_url = (base_url or f"https://{host}").rstrip("/")
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls, env_path: str = ".env") -> "JJRM365TennisAPIClient":
        load_env_file(env_path)
        return cls(
            api_key=(
                os.getenv("JJRM365_TENNIS_RAPIDAPI_KEY")
                or os.getenv("RAPIDAPI_KEY")
                or os.getenv("SOFASCORE_RAPIDAPI_KEY", "")
            ),
            host=os.getenv("JJRM365_TENNIS_RAPIDAPI_HOST", ""),
            base_url=os.getenv("JJRM365_TENNIS_RAPIDAPI_BASE_URL") or None,
        )

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Request any documented JJRM365 endpoint path.

        Example:
            client.get("/matches", {"date": "2026-07-03"})
        """
        clean_path = path if path.startswith("/") else f"/{path}"
        url = f"{self.base_url}{clean_path}"

        if params:
            query = urllib.parse.urlencode(params)
            url = f"{url}?{query}"

        request = urllib.request.Request(
            url,
            headers={
                "Content-Type": "application/json",
                "x-rapidapi-host": self.host,
                "x-rapidapi-key": self.api_key,
            },
            method="GET",
        )

        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            body = response.read().decode("utf-8")
            return json.loads(body)

    def get_configured_endpoint(
        self,
        endpoint_name: str,
        params: Optional[Dict[str, Any]] = None,
        env_path: str = ".env",
    ) -> Dict[str, Any]:
        """
        Call an endpoint path stored in .env.

        If endpoint_name is "today_matches", this reads:
            JJRM365_TENNIS_ENDPOINT_TODAY_MATCHES=/your/path
        """
        load_env_file(env_path)
        variable_name = f"JJRM365_TENNIS_ENDPOINT_{endpoint_name.upper()}"
        path = os.getenv(variable_name)
        if not path:
            raise ValueError(f"Missing {variable_name} in .env.")

        return self.get(path, params=params)

    def save_json(self, data: Dict[str, Any], output_path: str) -> None:
        Path(output_path).write_text(json.dumps(data, indent=2), encoding="utf-8")

    def get_arbitrage_odds(
        self,
        event_id: int,
        market_id: int = 1,
        use_cache: bool = True,
        cache_dir: str = "api_cache",
    ) -> Dict[str, Any]:
        """
        Fetch arbitrage odds from Tennis API - ATP WTA ITF.

        Example endpoint:
            /tennis/v2/extend/api/odds/arbitrage/3700653?market_id=1
        """
        cache_path = Path(cache_dir) / f"jjrm365_arbitrage_{event_id}_market_{market_id}.json"
        if use_cache and cache_path.exists():
            return json.loads(cache_path.read_text(encoding="utf-8"))

        data = self.get(
            f"/tennis/v2/extend/api/odds/arbitrage/{event_id}",
            {"market_id": market_id},
        )
        if use_cache:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return data


class AllSportsTennisAPIClient:
    """
    Client for the AllSportsAPI Tennis product on RapidAPI.

    Daily tennis matches use a two-step flow:
    1. /api/tennis/calendar/{day}/{month}/{year}/categories
    2. /api/tennis/category/{category_id}/events/{day}/{month}/{year}
    """

    def __init__(
        self,
        api_key: str,
        host: str = ALLSPORTS_TENNIS_DEFAULT_HOST,
        base_url: str = ALLSPORTS_TENNIS_DEFAULT_BASE_URL,
        timeout_seconds: int = 20,
    ):
        if not api_key:
            raise ValueError("Missing RapidAPI key. Set ALLSPORTS_TENNIS_RAPIDAPI_KEY in your .env file.")

        self.api_key = api_key
        self.host = host
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls, env_path: str = ".env") -> "AllSportsTennisAPIClient":
        load_env_file(env_path)
        return cls(
            api_key=(
                os.getenv("ALLSPORTS_TENNIS_RAPIDAPI_KEY")
                or os.getenv("RAPIDAPI_KEY")
                or os.getenv("SOFASCORE_RAPIDAPI_KEY", "")
            ),
            host=os.getenv("ALLSPORTS_TENNIS_RAPIDAPI_HOST", ALLSPORTS_TENNIS_DEFAULT_HOST),
            base_url=os.getenv("ALLSPORTS_TENNIS_RAPIDAPI_BASE_URL", ALLSPORTS_TENNIS_DEFAULT_BASE_URL),
        )

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        clean_path = path if path.startswith("/") else f"/{path}"
        url = f"{self.base_url}{clean_path}"

        if params:
            query = urllib.parse.urlencode(params)
            url = f"{url}?{query}"

        request = urllib.request.Request(
            url,
            headers={
                "Content-Type": "application/json",
                "X-RapidAPI-Host": self.host,
                "X-RapidAPI-Key": self.api_key,
            },
            method="GET",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                if response.status == 204:
                    return {}
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as error:
            if error.code == 204:
                return {}
            raise

    def get_daily_categories(self, day: int, month: int, year: int) -> Dict[str, Any]:
        return self.get(f"/api/tennis/calendar/{day}/{month}/{year}/categories")

    def get_category_events(self, category_id: int, day: int, month: int, year: int) -> Dict[str, Any]:
        return self.get(f"/api/tennis/category/{category_id}/events/{day}/{month}/{year}")

    def get_daily_matches(self, day: int, month: int, year: int) -> Dict[str, Any]:
        """
        Aggregate every tennis event for a date by walking the category index.
        """
        category_payload = self.get_daily_categories(day, month, year)
        categories = extract_api_list(category_payload, ["categories", "data"])
        events = []
        seen_event_ids = set()

        for category in categories:
            category_id = (
                category.get("id")
                or category.get("categoryId")
                or category.get("category_id")
                or category.get("category", {}).get("id")
            )
            if category_id is None:
                continue

            event_payload = self.get_category_events(int(category_id), day, month, year)
            for event in extract_api_list(event_payload, ["events", "matches", "data"]):
                event_id = event.get("id") or event.get("eventId") or event.get("matchId")
                if event_id in seen_event_ids:
                    continue
                if event_id is not None:
                    seen_event_ids.add(event_id)

                event.setdefault("category", category)
                events.append(event)

        return {
            "source": "AllSportsAPI Tennis",
            "categories": categories,
            "events": events,
        }

    def save_json(self, data: Dict[str, Any], output_path: str) -> None:
        Path(output_path).write_text(json.dumps(data, indent=2), encoding="utf-8")


class LiveScore6APIClient:
    """
    Generic client for LiveScore6 on RapidAPI.

    The sample endpoint provided is news-focused:
        /news/list?category=soccer

    Keep this separate from the tennis match slate until we have confirmed
    LiveScore6 tennis schedule, stats, or odds endpoints.
    """

    def __init__(
        self,
        api_key: str,
        host: str = LIVESCORE6_DEFAULT_HOST,
        base_url: str = LIVESCORE6_DEFAULT_BASE_URL,
        timeout_seconds: int = 20,
    ):
        if not api_key:
            raise ValueError("Missing RapidAPI key. Set LIVESCORE6_RAPIDAPI_KEY in your .env file.")

        self.api_key = api_key
        self.host = host
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls, env_path: str = ".env") -> "LiveScore6APIClient":
        load_env_file(env_path)
        return cls(
            api_key=(
                os.getenv("LIVESCORE6_RAPIDAPI_KEY")
                or os.getenv("RAPIDAPI_KEY")
                or os.getenv("SOFASCORE_RAPIDAPI_KEY", "")
            ),
            host=os.getenv("LIVESCORE6_RAPIDAPI_HOST", LIVESCORE6_DEFAULT_HOST),
            base_url=os.getenv("LIVESCORE6_RAPIDAPI_BASE_URL", LIVESCORE6_DEFAULT_BASE_URL),
        )

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        clean_path = path if path.startswith("/") else f"/{path}"
        url = f"{self.base_url}{clean_path}"

        if params:
            query = urllib.parse.urlencode(params)
            url = f"{url}?{query}"

        request = urllib.request.Request(
            url,
            headers={
                "Content-Type": "application/json",
                "x-rapidapi-host": self.host,
                "x-rapidapi-key": self.api_key,
            },
            method="GET",
        )

        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}

    def get_news_list(
        self,
        category: str = "soccer",
        use_cache: bool = True,
        cache_dir: str = "api_cache",
    ) -> Dict[str, Any]:
        """Fetch the LiveScore6 news list endpoint from the provided curl example."""
        safe_category = "".join(character for character in category.lower() if character.isalnum() or character in "-_")
        cache_path = Path(cache_dir) / f"livescore6_news_{safe_category}.json"
        if use_cache and cache_path.exists():
            return json.loads(cache_path.read_text(encoding="utf-8"))

        data = self.get("/news/list", {"category": category})
        if use_cache:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return data

    def save_json(self, data: Dict[str, Any], output_path: str) -> None:
        Path(output_path).write_text(json.dumps(data, indent=2), encoding="utf-8")


def extract_api_list(payload: Dict[str, Any], keys: Iterable[str]) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []

    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, dict):
            nested = extract_api_list(value, keys)
            if nested:
                return nested

    return []


def flatten_numeric_stats(data: Any, prefix: str = "") -> Dict[str, float]:
    """
    Flatten numeric values from an API response.

    SofaScore responses can be nested. This makes the raw response easier to inspect
    and gives the prediction engine a simple dictionary to map from later.
    """
    flattened: Dict[str, float] = {}

    if isinstance(data, dict):
        for key, value in data.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            flattened.update(flatten_numeric_stats(value, next_prefix))
    elif isinstance(data, list):
        for index, item in enumerate(data):
            next_prefix = f"{prefix}[{index}]"
            flattened.update(flatten_numeric_stats(item, next_prefix))
    elif isinstance(data, (int, float)) and not isinstance(data, bool):
        flattened[prefix] = float(data)

    return flattened


def find_first_numeric(flat_stats: Dict[str, float], candidate_names: Iterable[str]) -> Optional[float]:
    """Find the first stat whose flattened key contains one of the candidate names."""
    normalized_candidates = [name.lower().replace("_", "").replace("-", "") for name in candidate_names]

    for key, value in flat_stats.items():
        normalized_key = key.lower().replace("_", "").replace("-", "")
        if any(candidate in normalized_key for candidate in normalized_candidates):
            return value

    return None


def normalize_rate(value: Optional[float], fallback: float, is_percentage: bool = True) -> float:
    """
    Convert raw values into 0-1 rates with explicit percentage handling.
    
    Args:
        value: The raw stat value from API (can be None, 0-1, 0-100, etc.)
        fallback: Default rate if value is missing (e.g., 0.62)
        is_percentage: If True, values >1 are assumed to be percentages and divided by 100.
                      If False, value is used as-is in the 0-1 range.
    
    Returns:
        A float in the range [0.0, 1.0].
    
    Examples:
        normalize_rate(65, 0.62, is_percentage=True)   -> 0.65
        normalize_rate(0.65, 0.62, is_percentage=True)  -> 0.65
        normalize_rate(65, 0.62, is_percentage=False)   -> 0.0 (clipped)
        normalize_rate(None, 0.62)                       -> 0.62
    """
    if value is None:
        return fallback
    
    # Handle percentage conversion if needed
    if is_percentage and value > 1.0:
        value = value / 100.0
    
    # Clamp to valid probability range
    return max(0.0, min(1.0, value))


def build_player_snapshot_from_sofascore(
    player_name: str,
    sofascore_stats: Dict[str, Any],
    surface: str = "hard",
) -> PlayerSnapshot:
    """
    Best-effort converter from raw SofaScore stats into PlayerSnapshot.

    API field names can vary by endpoint/season. This function starts with safe
    defaults and fills what it can find. As you inspect real responses, add exact
    field names to the candidate lists below.
    
    Returns a PlayerSnapshot with data quality warnings printed to stdout.
    """
    if PlayerSnapshot is None:
        raise ImportError("PlayerSnapshot could not be imported from tennis_prediction_engine_full.py.")

    flat = flatten_numeric_stats(sofascore_stats)

    service_points_won = normalize_rate(
        find_first_numeric(
            flat,
            [
                "servicePointsWonPercentage",
                "servicePointsWonPct",
                "servePointsWonPercentage",
                "servePointsWonPct",
            ],
        ),
        0.62,
        is_percentage=True,
    )
    return_points_won = normalize_rate(
        find_first_numeric(
            flat,
            [
                "returnPointsWonPercentage",
                "returnPointsWonPct",
                "receiverPointsWonPercentage",
                "receiverPointsWonPct",
            ],
        ),
        0.38,
        is_percentage=True,
    )
    hold_pct = normalize_rate(
        find_first_numeric(flat, ["serviceGamesWonPercentage", "holdPercentage", "holdPct"]),
        0.80,
        is_percentage=True,
    )
    break_pct = normalize_rate(
        find_first_numeric(flat, ["returnGamesWonPercentage", "breakPercentage", "breakPct"]),
        0.22,
        is_percentage=True,
    )

    aces_avg = find_first_numeric(flat, ["acesPerMatch", "averageAces", "acesAvg"]) or 5.0
    double_faults_avg = (
        find_first_numeric(flat, ["doubleFaultsPerMatch", "averageDoubleFaults", "doubleFaultsAvg"]) or 3.0
    )

    snapshot = PlayerSnapshot(
        name=player_name,
        service_points_won=service_points_won,
        return_points_won=return_points_won,
        hold_pct=hold_pct,
        break_pct=break_pct,
        surface_hold_pct=hold_pct,
        surface_break_pct=break_pct,
        surface_elo={surface: 1500.0},
        aces_avg=aces_avg,
        double_faults_avg=double_faults_avg,
    )
    
    # Print data quality warnings
    warnings = validate_player_snapshot(snapshot)
    if warnings:
        print(f"\n⚠️  Data quality warnings for {player_name}:")
        for warning in warnings:
            print(f"   - {warning}")
    
    return snapshot


def validate_player_snapshot(snapshot: PlayerSnapshot) -> List[str]:
    """
    Validate a PlayerSnapshot and return list of data quality warnings.
    
    Warnings are generated for:
    - Out-of-range service/return stats
    - Default values (indicating missing data)
    - Logical inconsistencies
    """
    warnings = []
    
    # Check service points won
    if snapshot.service_points_won < 0.45:
        warnings.append(f"service_points_won={snapshot.service_points_won:.3f} (below 0.45, unusually weak serve)")
    elif snapshot.service_points_won > 0.75:
        warnings.append(f"service_points_won={snapshot.service_points_won:.3f} (above 0.75, unusually strong serve)")
    
    # Check return points won
    if snapshot.return_points_won < 0.25:
        warnings.append(f"return_points_won={snapshot.return_points_won:.3f} (below 0.25, unusually weak return)")
    elif snapshot.return_points_won > 0.50:
        warnings.append(f"return_points_won={snapshot.return_points_won:.3f} (above 0.50, unusually strong return)")
    
    # Check for default values (indicating missing data)
    if snapshot.recent_win_pct == 0.50:
        warnings.append("recent_win_pct=0.50 (default value, data likely missing from API)")
    
    if snapshot.aces_avg < 0:
        warnings.append(f"aces_avg={snapshot.aces_avg} (negative value, API error)")
    elif snapshot.aces_avg > 15:
        warnings.append(f"aces_avg={snapshot.aces_avg} (extremely high, verify API field)")
    
    if snapshot.double_faults_avg < 0:
        warnings.append(f"double_faults_avg={snapshot.double_faults_avg} (negative value, API error)")
    
    # Check hold/break consistency
    if snapshot.hold_pct + snapshot.break_pct > 1.05:
        warnings.append(f"hold_pct + break_pct = {snapshot.hold_pct + snapshot.break_pct:.2f} (should sum to ~1.0)")
    
    return warnings


def print_top_numeric_stats(data: Dict[str, Any], limit: int = 40) -> None:
    """Print a quick inspection table for figuring out API field names."""
    flat = flatten_numeric_stats(data)
    for key in sorted(flat.keys())[:limit]:
        print(f"{key}: {flat[key]}")


if __name__ == "__main__":
    try:
        client = SofaScoreRapidAPIClient.from_env()
    except ValueError as error:
        print(error)
        print("Create a .env file from .env.example, then add your RapidAPI key.")
    else:
        player_id = 998697
        stats = client.get_player_statistics_seasons(player_id)

        print(f"Fetched SofaScore season statistics for player_id={player_id}")
        print("\nTop numeric fields:")
        print_top_numeric_stats(stats)

        print("\nBuilding PlayerSnapshot with validation...")
        try:
            player = build_player_snapshot_from_sofascore(f"Player {player_id}", stats)
            print(f"\n✅ Successfully built snapshot for {player.name}")
            print(f"   Service points won: {player.service_points_won:.1%}")
            print(f"   Return points won: {player.return_points_won:.1%}")
            print(f"   Hold %: {player.hold_pct:.1%}")
            print(f"   Aces avg: {player.aces_avg:.1f}")
        except ImportError as import_error:
            print(f"⚠️  Could not import PlayerSnapshot: {import_error}")

        print("\nRaw response preview:")
        preview = json.dumps(stats, indent=2)
        print(preview[:2500])
