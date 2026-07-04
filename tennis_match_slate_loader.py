"""
tennis_match_slate_loader.py

Refresh the app's preloaded match slate.

This script normalizes match data into the JSON shape used by the browser app:
    matches_preload.json

It can read:
- the existing app JSON
- a simple CSV export
- a raw API JSON response
- a configured JJRM365 RapidAPI endpoint

The API response mapper is intentionally flexible because different tennis APIs
name fields differently. Once you know the exact endpoint response shape, tighten
the aliases in this file for better stat coverage.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None

try:
    from tennis_data_client import AllSportsTennisAPIClient, JJRM365TennisAPIClient
except Exception:
    AllSportsTennisAPIClient = None
    JJRM365TennisAPIClient = None


OUTPUT_PATH = "matches_preload.json"
DEFAULT_TIME_ZONE = "America/New_York"

LEVEL_PRIORITY = {
    "Grand Slam": 1,
    "ATP 1000": 2,
    "WTA 1000": 2,
    "ATP 500": 3,
    "WTA 500": 3,
    "ATP 250": 4,
    "WTA 250": 4,
    "Challenger": 5,
    "ITF": 6,
}

SURFACE_ALIASES = {
    "hardcourt": "Hard",
    "hard court": "Hard",
    "hard": "Hard",
    "clay court": "Clay",
    "clay": "Clay",
    "grass court": "Grass",
    "grass": "Grass",
    "indoor": "Indoor",
    "indoor hard": "Indoor",
}

DEFAULT_STATS = {
    "rankA": 50,
    "rankB": 50,
    "holdA": 80.0,
    "holdB": 80.0,
    "aceA": 6.0,
    "aceB": 6.0,
    "formA": 70,
    "formB": 70,
    "weatherFactor": 0,
    "fatigueA": 0,
    "fatigueB": 0,
    "injuryA": 0,
    "injuryB": 0,
}

HISTORICAL_THREE_YEAR_STAT_AVERAGES = {
    "ATP": {
        "Hard": {"rank": 85, "hold": 82.3, "ace": 7.8, "form": 64},
        "Indoor": {"rank": 85, "hold": 84.1, "ace": 8.2, "form": 64},
        "Clay": {"rank": 85, "hold": 78.9, "ace": 5.9, "form": 64},
        "Grass": {"rank": 85, "hold": 85.0, "ace": 9.1, "form": 64},
    },
    "WTA": {
        "Hard": {"rank": 95, "hold": 66.8, "ace": 3.8, "form": 62},
        "Indoor": {"rank": 95, "hold": 68.4, "ace": 4.0, "form": 62},
        "Clay": {"rank": 95, "hold": 63.7, "ace": 2.9, "form": 62},
        "Grass": {"rank": 95, "hold": 70.4, "ace": 4.4, "form": 62},
    },
    "Challenger": {
        "Hard": {"rank": 215, "hold": 79.7, "ace": 6.1, "form": 59},
        "Indoor": {"rank": 215, "hold": 81.2, "ace": 6.4, "form": 59},
        "Clay": {"rank": 215, "hold": 76.2, "ace": 4.6, "form": 59},
        "Grass": {"rank": 215, "hold": 82.0, "ace": 7.2, "form": 59},
    },
    "ITF": {
        "Hard": {"rank": 430, "hold": 74.1, "ace": 3.9, "form": 55},
        "Indoor": {"rank": 430, "hold": 75.2, "ace": 4.1, "form": 55},
        "Clay": {"rank": 430, "hold": 70.8, "ace": 2.8, "form": 55},
        "Grass": {"rank": 430, "hold": 76.0, "ace": 4.7, "form": 55},
    },
}


def profile_tour(level: str, tour: str) -> str:
    if tour == "Challenger" or level == "Challenger":
        return "Challenger"
    if tour == "ITF" or level == "ITF":
        return "ITF"
    if tour == "WTA" or str(level).startswith("WTA"):
        return "WTA"
    return "ATP"


def historical_stat_profile(level: str, tour: str, surface: str) -> Dict[str, float]:
    canonical_tour = profile_tour(level, tour)
    tour_profiles = HISTORICAL_THREE_YEAR_STAT_AVERAGES.get(canonical_tour, HISTORICAL_THREE_YEAR_STAT_AVERAGES["ATP"])
    return tour_profiles.get(surface, tour_profiles["Hard"])


def read_json(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: str, payload: Dict[str, Any]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_csv_matches(path: str) -> List[Dict[str, Any]]:
    with Path(path).open("r", newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def extract_match_items(payload: Any) -> List[Dict[str, Any]]:
    """Find likely match objects in common API response shapes."""
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]

    if not isinstance(payload, dict):
        return []

    for key in ["matches", "events", "data", "fixtures", "results", "games"]:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, dict):
            nested = extract_match_items(value)
            if nested:
                return nested

    found: List[Dict[str, Any]] = []
    walk_for_matches(payload, found)
    return found


def walk_for_matches(value: Any, found: List[Dict[str, Any]]) -> None:
    if isinstance(value, dict):
        if looks_like_match(value):
            found.append(value)
            return
        for child in value.values():
            walk_for_matches(child, found)
    elif isinstance(value, list):
        for child in value:
            walk_for_matches(child, found)


def looks_like_match(item: Dict[str, Any]) -> bool:
    if get_player_name(item, "A") and get_player_name(item, "B"):
        return True

    participants = first_present(item, ["participants", "competitors", "players"])
    return isinstance(participants, list) and len(participants) >= 2


def normalize_matches(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    matches = []
    for index, item in enumerate(items):
        match = normalize_match(item, index)
        if match is not None:
            matches.append(match)

    return sorted(matches, key=sort_key)


def normalize_match(item: Dict[str, Any], index: int) -> Optional[Dict[str, Any]]:
    player_a = get_player_name(item, "A")
    player_b = get_player_name(item, "B")

    if not player_a or not player_b:
        return None

    tournament = string_value(
        first_present(
            item,
            [
                "tournament",
                "tournamentName",
                "competition",
                "competitionName",
                "league",
                "leagueName",
                "eventName",
                "uniqueTournament",
                "tournament.uniqueTournament",
            ],
        ),
        "Loaded Matches",
    )
    tournament = extract_name(tournament)
    level = normalize_level(
        first_present(item, ["level", "category", "tournament.category", "series", "tier"]),
        tournament,
    )
    tour = normalize_tour(
        first_present(item, ["tour", "category", "tournament.category", "gender", "leagueType", "circuit"]),
        level,
        tournament,
    )
    format_source = first_present(item, ["format", "bestOf", "best_of", "sets", "defaultPeriodCount"])
    is_doubles = event_looks_doubles(player_a, player_b, tournament)
    surface = normalize_surface(
        first_present(item, ["surface", "courtSurface", "groundType", "ground", "tournament.uniqueTournament.groundType"])
    )
    stat_profile = historical_stat_profile(level, tour, surface)

    match = {
        "id": string_value(first_present(item, ["id", "eventId", "matchId", "fixtureId"]), ""),
        "tournament": tournament,
        "level": level,
        "tour": tour,
        "round": string_value(first_present(item, ["round", "roundName", "roundInfo.name", "stage", "phase"]), "Match"),
        "court": string_value(first_present(item, ["court", "venue", "venue.name", "courtName"]), ""),
        "startTime": normalize_start_time(
            first_present(item, ["startTimestamp", "startTime", "start_time", "date", "time.currentPeriodStartTimestamp"])
        ),
        "playerA": player_a,
        "playerB": player_b,
        "surface": surface,
        "format": normalize_format(format_source, level, tour, is_doubles),
        **DEFAULT_STATS,
    }

    match["rankA"] = int_number(first_present(item, ["rankA", "playerARank", "homeRank", "homeTeam.ranking"]), stat_profile["rank"])
    match["rankB"] = int_number(first_present(item, ["rankB", "playerBRank", "awayRank", "awayTeam.ranking"]), stat_profile["rank"])
    match["holdA"] = float_number(first_present(item, ["holdA", "playerAHold", "homeHoldPct"]), stat_profile["hold"])
    match["holdB"] = float_number(first_present(item, ["holdB", "playerBHold", "awayHoldPct"]), stat_profile["hold"])
    match["aceA"] = float_number(first_present(item, ["aceA", "playerAAces", "homeAcesAvg"]), stat_profile["ace"])
    match["aceB"] = float_number(first_present(item, ["aceB", "playerBAces", "awayAcesAvg"]), stat_profile["ace"])
    match["formA"] = int_number(first_present(item, ["formA", "playerAForm", "homeForm"]), stat_profile["form"])
    match["formB"] = int_number(first_present(item, ["formB", "playerBForm", "awayForm"]), stat_profile["form"])
    match["weatherFactor"] = float_number(first_present(item, ["weatherFactor", "weather"]), match["weatherFactor"])
    match["fatigueA"] = int_number(first_present(item, ["fatigueA", "playerAFatigue", "homeFatigue"]), match["fatigueA"])
    match["fatigueB"] = int_number(first_present(item, ["fatigueB", "playerBFatigue", "awayFatigue"]), match["fatigueB"])
    match["injuryA"] = int_number(first_present(item, ["injuryA", "playerAInjury", "homeInjury"]), match["injuryA"])
    match["injuryB"] = int_number(first_present(item, ["injuryB", "playerBInjury", "awayInjury"]), match["injuryB"])

    if not match["id"]:
        match["id"] = slugify(f"{match['tournament']}-{player_a}-{player_b}-{index}")

    return match


def get_player_name(item: Dict[str, Any], side: str) -> Optional[str]:
    if side == "A":
        keys = [
            "playerA",
            "player_a",
            "homePlayer",
            "homeTeam",
            "home",
            "team1",
            "competitor1",
            "participant1",
        ]
        participant_index = 0
    else:
        keys = [
            "playerB",
            "player_b",
            "awayPlayer",
            "awayTeam",
            "away",
            "team2",
            "competitor2",
            "participant2",
        ]
        participant_index = 1

    value = first_present(item, keys)
    if value is not None:
        return extract_name(value)

    participants = first_present(item, ["participants", "competitors", "players"])
    if isinstance(participants, list) and len(participants) > participant_index:
        return extract_name(participants[participant_index])

    return None


def first_present(item: Dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        value = nested_value(item, key)
        if value not in [None, ""]:
            return value
    return None


def nested_value(item: Dict[str, Any], key: str) -> Any:
    if key in item:
        return item[key]

    current: Any = item
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def extract_name(value: Any) -> str:
    if isinstance(value, dict):
        for key in ["name", "fullName", "shortName", "displayName", "slug"]:
            if value.get(key):
                return str(value[key])
        for key in ["category", "uniqueTournament", "tournament"]:
            nested = value.get(key)
            if isinstance(nested, dict):
                nested_name = extract_name(nested)
                if nested_name and not nested_name.startswith("{"):
                    return nested_name
        return str(value)
    return str(value).strip()


def string_value(value: Any, fallback: str) -> str:
    if value in [None, ""]:
        return fallback
    return extract_name(value)


def float_number(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    return round(number, 2)


def int_number(value: Any, fallback: int) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return int(fallback)


def normalize_surface(value: Any) -> str:
    raw = extract_name(value).lower().strip() if value not in [None, ""] else "hard"
    return SURFACE_ALIASES.get(raw, "Hard")


def event_looks_doubles(player_a: str, player_b: str, tournament: str) -> bool:
    values = [player_a, player_b, tournament]
    return any(" / " in str(value).lower() for value in values) or "doubles" in tournament.lower()


def normalize_format(value: Any, level: str = "", tour: str = "", is_doubles: bool = False) -> str:
    number = int_number(value, 3)
    if level == "Grand Slam" and tour == "ATP" and not is_doubles:
        return "5"
    return "5" if number == 5 else "3"


def normalize_start_time(value: Any) -> str:
    if value in [None, ""]:
        return datetime.now(timezone.utc).isoformat()

    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 10_000_000_000:
            seconds = seconds / 1000
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()

    text = str(value).strip()
    if text.isdigit():
        return normalize_start_time(float(text))
    return text


def match_local_date(item: Dict[str, Any], time_zone: str = DEFAULT_TIME_ZONE) -> str:
    raw_start = first_present(item, ["startTimestamp", "startTime", "start_time", "date", "time.currentPeriodStartTimestamp"])
    if isinstance(raw_start, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", raw_start):
        return raw_start

    normalized = normalize_start_time(raw_start)
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return ""

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    if ZoneInfo is not None:
        try:
            return parsed.astimezone(ZoneInfo(time_zone)).date().isoformat()
        except Exception:
            pass

    return parsed.astimezone(timezone.utc).date().isoformat()


def normalize_level(value: Any, tournament: str) -> str:
    text = extract_name(value).strip() if value not in [None, ""] else tournament
    lowered = f"{text} {tournament}".lower()

    if "grand slam" in lowered or any(
        name in lowered for name in ["wimbledon", "roland garros", "french open", "us open", "australian open"]
    ):
        return "Grand Slam"
    if "1000" in lowered and "wta" in lowered:
        return "WTA 1000"
    if "1000" in lowered:
        return "ATP 1000"
    if "500" in lowered and "wta" in lowered:
        return "WTA 500"
    if "500" in lowered:
        return "ATP 500"
    if "250" in lowered and "wta" in lowered:
        return "WTA 250"
    if "250" in lowered:
        return "ATP 250"
    if "challenger" in lowered:
        return "Challenger"
    if "itf" in lowered or "m15" in lowered or "m25" in lowered or "w35" in lowered or "w75" in lowered:
        return "ITF"
    if "wta" in lowered:
        return "WTA 250"
    return "ATP 250"


def normalize_tour(value: Any, level: str, tournament: str) -> str:
    text = extract_name(value).upper().strip() if value not in [None, ""] else ""
    combined = f"{text} {level} {tournament}".upper()

    if "CHALLENGER" in combined:
        return "Challenger"
    if "ITF" in combined or re.search(r"\bM\d{2}\b|\bW\d{2,3}\b", combined):
        return "ITF"
    if "WTA" in combined:
        return "WTA"
    return "ATP"


def sort_key(match: Dict[str, Any]) -> tuple:
    return (
        LEVEL_PRIORITY.get(match.get("level", ""), 99),
        str(match.get("startTime", "")),
        str(match.get("tournament", "")),
    )


def slugify(value: str) -> str:
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))


def build_payload(matches: List[Dict[str, Any]], source: str) -> Dict[str, Any]:
    return {
        "source": source,
        "statFallback": "Three-year historical surface/tour averages",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "count": len(matches),
        "matches": matches,
    }


def parse_params(values: Optional[List[str]]) -> Dict[str, str]:
    params: Dict[str, str] = {}
    for value in values or []:
        if "=" not in value:
            raise ValueError(f"Parameter must use key=value format: {value}")
        key, raw = value.split("=", 1)
        params[key] = raw
    return params


def load_from_args(args: argparse.Namespace) -> tuple[List[Dict[str, Any]], str]:
    if args.csv:
        rows = read_csv_matches(args.csv)
        return normalize_matches(rows), f"CSV import: {args.csv}"

    if args.json:
        payload = read_json(args.json)
        items = extract_match_items(payload)
        return normalize_matches(items), f"JSON import: {args.json}"

    if args.jjrm365_endpoint:
        if JJRM365TennisAPIClient is None:
            raise RuntimeError("Could not import JJRM365TennisAPIClient from tennis_data_client.py.")
        client = JJRM365TennisAPIClient.from_env()
        params = parse_params(args.param)
        raw = client.get_configured_endpoint(args.jjrm365_endpoint, params=params)
        if args.raw_output:
            write_json(args.raw_output, raw)
        items = extract_match_items(raw)
        return normalize_matches(items), f"JJRM365 endpoint: {args.jjrm365_endpoint}"

    if args.allsports_date:
        if AllSportsTennisAPIClient is None:
            raise RuntimeError("Could not import AllSportsTennisAPIClient from tennis_data_client.py.")
        year, month, day = parse_iso_date(args.allsports_date)
        client = AllSportsTennisAPIClient.from_env()
        raw = client.get_daily_matches(day=day, month=month, year=year)
        if args.raw_output:
            write_json(args.raw_output, raw)
        items = [
            item for item in extract_match_items(raw)
            if match_local_date(item, args.time_zone) == args.allsports_date
        ]
        return normalize_matches(items), f"AllSportsAPI Tennis daily matches: {args.allsports_date}"

    existing_path = args.output if Path(args.output).exists() else OUTPUT_PATH
    payload = read_json(existing_path)
    items = extract_match_items(payload)
    return normalize_matches(items), f"Existing slate: {existing_path}"


def parse_iso_date(value: str) -> tuple[int, int, int]:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError as error:
        raise ValueError("Date must use YYYY-MM-DD format.") from error
    return parsed.year, parsed.month, parsed.day


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh matches_preload.json for the Tennis Edge app.")
    parser.add_argument("--csv", help="Path to a CSV file of matches.")
    parser.add_argument("--json", help="Path to a raw or normalized JSON file of matches.")
    parser.add_argument("--jjrm365-endpoint", help="Configured JJRM365 endpoint name, such as today_matches.")
    parser.add_argument("--allsports-date", help="Fetch AllSportsAPI Tennis matches for YYYY-MM-DD.")
    parser.add_argument("--param", action="append", help="Endpoint query parameter in key=value format.")
    parser.add_argument("--raw-output", help="Optional path to save the raw API response.")
    parser.add_argument("--output", default=OUTPUT_PATH, help="Output JSON file for the app.")
    parser.add_argument("--source", help="Override the source label shown in the app.")
    parser.add_argument("--time-zone", default=DEFAULT_TIME_ZONE, help="Local time zone for filtering daily API slates.")
    args = parser.parse_args()

    matches, detected_source = load_from_args(args)
    source = args.source or detected_source
    payload = build_payload(matches, source)
    write_json(args.output, payload)

    print(f"Wrote {len(matches)} matches to {args.output}")
    print(f"Source: {source}")


if __name__ == "__main__":
    main()
