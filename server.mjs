import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "0.0.0.0";
const basicAuthUser = process.env.APP_BASIC_AUTH_USER || "";
const basicAuthPassword = process.env.APP_BASIC_AUTH_PASSWORD || "";
const defaultAllSportsHost = "tennisapi1.p.rapidapi.com";
const defaultAllSportsBaseUrl = "https://tennisapi1.p.rapidapi.com";
const allSportsBundleHost = "allsportsapi2.p.rapidapi.com";
const allSportsBundleBaseUrl = "https://allsportsapi2.p.rapidapi.com";
const defaultSofaScoreHost = "sofascore6.p.rapidapi.com";
const defaultSofaScoreBaseUrl = "https://sofascore6.p.rapidapi.com/api/sofascore/v1";
const defaultSlateTimeZone = process.env.SLATE_TIME_ZONE || "America/New_York";
const levelPriority = {
  "Grand Slam": 1,
  "ATP 1000": 2,
  "WTA 1000": 2,
  "ATP 500": 3,
  "WTA 500": 3,
  "ATP 250": 4,
  "WTA 250": 4,
  Challenger: 5,
  ITF: 6
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};
const publicFiles = new Set([
  "index.html",
  "styles.css",
  "app.js",
  "matches_preload.json",
  "odds_preload.json",
  "manifest.webmanifest",
  "service-worker.js"
]);

function localNetworkUrls() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((network) => network && network.family === "IPv4" && !network.internal)
    .map((network) => `http://${network.address}:${port}`);
}

function applySofaDerivedStat(current, derivedValue, label, playerIdValue, note) {
  if (!current || current.trace?.status !== "fallback" || !Number.isFinite(derivedValue)) return current;
  return {
    value: derivedValue,
    trace: traceEntry(
      label,
      derivedValue,
      "derived",
      `SofaScore /player/statistics/seasons player_id=${playerIdValue}`,
      note
    )
  };
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = [];
  const size = Math.max(1, limit);

  for (let index = 0; index < size; index += 1) {
    workers.push((async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) continue;
        await worker(item);
      }
    })());
  }

  await Promise.all(workers);
}

async function buildSofaScorePlayerStatsMap(events, env) {
  const source = sofaScoreSourceCandidate(env);
  if (!source) {
    return {
      playerStatsById: new Map(),
      metadata: {
        enabled: false,
        reason: "Missing SOFASCORE_RAPIDAPI_KEY (or RAPIDAPI_KEY) in .env."
      }
    };
  }

  const allPlayerIds = [...new Set(
    events.flatMap((event) => [playerId(event, "A"), playerId(event, "B")].filter((id) => id !== null))
  )];
  const configuredLimit = Number(env.SOFASCORE_SLATE_MAX_PLAYERS);
  const maxPlayers = Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.floor(configuredLimit)
    : 80;
  const playerReferenceStartTime = new Map();
  events.forEach((event) => {
    const eventStart = eventStartIso(event);
    if (!eventStart) return;
    [playerId(event, "A"), playerId(event, "B")].forEach((id) => {
      if (!id) return;
      const current = playerReferenceStartTime.get(id);
      if (!current || new Date(eventStart) < new Date(current)) {
        playerReferenceStartTime.set(id, eventStart);
      }
    });
  });
  const idsToFetch = allPlayerIds.slice(0, maxPlayers);
  const playerStatsById = new Map();
  const errors = [];
  let fatigueDerivedCount = 0;
  let injuryDerivedCount = 0;

  await runWithConcurrency(idsToFetch, 4, async (currentPlayerId) => {
    try {
      const payload = await fetchSofaScoreJson("/player/statistics/seasons", { player_id: currentPlayerId }, source);
      const baseStats = extractSofaScorePlayerStats(payload);
      const recent = await fetchSofaScoreRecentEvents(currentPlayerId, source);
      const fatigue = deriveSofaFatigueAndInjury(recent.events, currentPlayerId, playerReferenceStartTime.get(currentPlayerId));
      if (Number.isFinite(fatigue.fatigueScore)) fatigueDerivedCount += 1;
      if (Number.isFinite(fatigue.injuryScore) && fatigue.injuryScore > 0) injuryDerivedCount += 1;
      playerStatsById.set(currentPlayerId, {
        ...baseStats,
        fatigueScore: fatigue.fatigueScore,
        injuryScore: fatigue.injuryScore,
        fatigueDetails: fatigue.fatigueDetails,
        recentEventsPath: recent.sourcePath
      });
    } catch (error) {
      errors.push({
        playerId: currentPlayerId,
        error: error.message
      });
    }
  });

  return {
    playerStatsById,
    metadata: {
      enabled: true,
      source: `SofaScore (${source.rapidHost})`,
      totalPlayerIdsSeen: allPlayerIds.length,
      playerIdsRequested: idsToFetch.length,
      playerIdsFetched: playerStatsById.size,
      playerIdsFailed: errors.length,
      fatiguePlayersDerived: fatigueDerivedCount,
      injuryPlayersDerived: injuryDerivedCount,
      requestLimited: idsToFetch.length < allPlayerIds.length,
      requestLimit: maxPlayers,
      errors: errors.slice(0, 25)
    }
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function basicAuthEnabled() {
  return Boolean(basicAuthUser && basicAuthPassword);
}

function authorized(request) {
  if (!basicAuthEnabled()) return true;

  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return false;

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return username === basicAuthUser && password === basicAuthPassword;
}

function requestBasicAuth(response) {
  response.writeHead(401, {
    "www-authenticate": 'Basic realm="Tennis Edge"',
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end("Authentication required");
}

function publicFileAllowed(requestedPath) {
  const cleanPath = requestedPath.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (publicFiles.has(cleanPath)) return true;
  return cleanPath.startsWith("icons/") && !cleanPath.includes("..");
}

function shouldServeAppShell(request, requestedPath) {
  if (request.method !== "GET") return false;

  const cleanPath = requestedPath.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (!cleanPath || cleanPath.endsWith("/")) return true;
  if (cleanPath.includes("..")) return false;
  if (cleanPath.split("/").some((segment) => segment.startsWith("."))) return false;

  // Let real file requests fail closed, but allow app-style paths such as
  // /dashboard or /match/123 to load the same single-page app shell.
  return extname(cleanPath) === "";
}

function todayIsoDate() {
  const env = readEnvFile();
  return isoDateInTimeZone(new Date(), env.SLATE_TIME_ZONE || defaultSlateTimeZone);
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function readEnvFile() {
  const envPath = join(root, ".env");
  const values = { ...process.env };
  if (!existsSync(envPath)) return values;

  readFileSync(envPath, "utf-8").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
    const [key, ...rest] = trimmed.split("=");
    values[key.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
  });
  return values;
}

function allSportsSourceCandidates(env) {
  const apiKey = env.ALLSPORTS_TENNIS_RAPIDAPI_KEY || env.RAPIDAPI_KEY || env.SOFASCORE_RAPIDAPI_KEY;
  if (!apiKey) {
    throw new Error("Missing ALLSPORTS_TENNIS_RAPIDAPI_KEY or RAPIDAPI_KEY in .env.");
  }

  const primary = {
    apiKey,
    rapidHost: env.ALLSPORTS_TENNIS_RAPIDAPI_HOST || defaultAllSportsHost,
    baseUrl: (env.ALLSPORTS_TENNIS_RAPIDAPI_BASE_URL || defaultAllSportsBaseUrl).replace(/\/$/, "")
  };
  const bundle = {
    apiKey,
    rapidHost: allSportsBundleHost,
    baseUrl: allSportsBundleBaseUrl
  };
  const seen = new Set();

  return [primary, bundle].filter((source) => {
    const key = `${source.rapidHost}|${source.baseUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sofaScoreSourceCandidate(env) {
  const apiKey = env.SOFASCORE_RAPIDAPI_KEY || env.RAPIDAPI_KEY || env.ALLSPORTS_TENNIS_RAPIDAPI_KEY;
  if (!apiKey) return null;

  return {
    apiKey,
    rapidHost: env.SOFASCORE_RAPIDAPI_HOST || defaultSofaScoreHost,
    baseUrl: (env.SOFASCORE_RAPIDAPI_BASE_URL || defaultSofaScoreBaseUrl).replace(/\/$/, "")
  };
}

async function fetchAllSportsJson(path, source) {
  const apiResponse = await fetch(`${source.baseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-RapidAPI-Key": source.apiKey,
      "X-RapidAPI-Host": source.rapidHost
    }
  });

  if (apiResponse.status === 204) return {};

  const body = await apiResponse.text();
  if (!apiResponse.ok) {
    throw new Error(`AllSportsAPI ${apiResponse.status}: ${body.slice(0, 300)}`);
  }

  return body ? JSON.parse(body) : {};
}

async function fetchSofaScoreJson(path, params, source) {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  const apiResponse = await fetch(`${source.baseUrl}${path}${query}`, {
    headers: {
      "Content-Type": "application/json",
      "X-RapidAPI-Key": source.apiKey,
      "X-RapidAPI-Host": source.rapidHost
    }
  });

  if (apiResponse.status === 204) return {};

  const body = await apiResponse.text();
  if (!apiResponse.ok) {
    throw new Error(`SofaScore ${apiResponse.status}: ${body.slice(0, 300)}`);
  }

  return body ? JSON.parse(body) : {};
}

async function fetchAllSportsJsonWithFallback(path, env) {
  const errors = [];

  for (const source of allSportsSourceCandidates(env)) {
    try {
      const payload = await fetchAllSportsJson(path, source);
      return { payload, source };
    } catch (error) {
      errors.push(`${source.rapidHost}: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

function dedupeEvents(events) {
  const seen = new Set();
  const output = [];
  events.forEach((event, index) => {
    if (!event || typeof event !== "object") return;
    const eventId = firstValue(event, ["id", "eventId", "matchId", "fixtureId"]) || `event-${index}`;
    if (seen.has(eventId)) return;
    seen.add(eventId);
    output.push(event);
  });
  return output;
}

async function fetchSofaScoreDailyEvents(date, env) {
  const source = sofaScoreSourceCandidate(env);
  if (!source) {
    return {
      events: [],
      metadata: {
        enabled: false,
        reason: "Missing SOFASCORE_RAPIDAPI_KEY (or RAPIDAPI_KEY) in .env."
      }
    };
  }

  const endpointAttempts = [
    { path: `/sport/tennis/scheduled-events/${date}`, params: null },
    { path: "/sport/tennis/scheduled-events", params: { date } },
    { path: `/sport/tennis/events/${date}`, params: null },
    { path: "/sport/tennis/events", params: { date } },
    { path: "/sport/tennis/events/date", params: { date } }
  ];
  const errors = [];

  for (const attempt of endpointAttempts) {
    try {
      const payload = await fetchSofaScoreJson(attempt.path, attempt.params, source);
      const events = dedupeEvents(extractList(payload, ["events", "matches", "data"]));
      if (events.length) {
        return {
          events,
          metadata: {
            enabled: true,
            source: `SofaScore (${source.rapidHost})`,
            endpoint: `${attempt.path}${attempt.params ? `?${new URLSearchParams(attempt.params).toString()}` : ""}`,
            eventCount: events.length,
            errors
          }
        };
      }
      errors.push(`${attempt.path}: returned no events`);
    } catch (error) {
      errors.push(`${attempt.path}: ${error.message}`);
    }
  }

  return {
    events: [],
    metadata: {
      enabled: true,
      source: `SofaScore (${source.rapidHost})`,
      endpoint: null,
      eventCount: 0,
      errors
    }
  };
}

async function fetchAllSportsDailyEvents(date, options = {}, env) {
  const [year, month, day] = date.split("-").map(Number);
  const categoryResult = await fetchAllSportsJsonWithFallback(`/api/tennis/calendar/${day}/${month}/${year}/categories`, env);
  const categoriesPayload = categoryResult.payload;
  const apiSource = categoryResult.source;
  const categories = extractList(categoriesPayload, ["categories", "data"]);
  const maxCategories = Number.isFinite(options.maxCategories) ? Math.max(0, options.maxCategories) : null;
  const categoriesToLoad = maxCategories === null ? categories : categories.slice(0, maxCategories);
  const events = [];
  const categoryErrors = [];
  const seen = new Set();

  for (const category of categoriesToLoad) {
    const categoryId = category.id || category.categoryId || category.category_id || category.category?.id;
    if (!categoryId) continue;

    try {
      const eventPayload = await fetchAllSportsJson(`/api/tennis/category/${categoryId}/events/${day}/${month}/${year}`, apiSource);
      extractList(eventPayload, ["events", "matches", "data"]).forEach((event) => {
        const eventId = event.id || event.eventId || event.matchId || `${categoryId}-${events.length}`;
        if (seen.has(eventId)) return;
        seen.add(eventId);
        events.push({ ...event, category: event.category || category });
      });
    } catch (error) {
      categoryErrors.push({
        categoryId,
        category: nameOf(category, String(categoryId)),
        error: error.message
      });
    }
  }

  return {
    source: apiSource,
    categories,
    categoriesToLoad,
    events,
    categoryErrors
  };
}

function flattenNumericStats(value, path = "", output = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenNumericStats(item, `${path}[${index}]`, output);
    });
    return output;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => {
      flattenNumericStats(child, path ? `${path}.${key}` : key, output);
    });
    return output;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    output[path] = value;
  }
  return output;
}

function normalizeStatToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findFirstNumeric(flatStats, candidateNames) {
  const candidates = candidateNames.map(normalizeStatToken);
  for (const [key, value] of Object.entries(flatStats)) {
    if (!Number.isFinite(value)) continue;
    const normalizedKey = normalizeStatToken(key);
    if (candidates.some((candidate) => normalizedKey.includes(candidate))) {
      return value;
    }
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePercentStat(value) {
  if (!Number.isFinite(value)) return null;
  const raw = Number(value);
  const percent = raw <= 1 ? raw * 100 : raw;
  return clamp(percent, 0, 100);
}

function deriveFormPercent(flatStats) {
  const direct = normalizePercentStat(findFirstNumeric(flatStats, [
    "formPercentage",
    "recentWinPercentage",
    "winRate",
    "matchWinPercentage",
    "recentForm"
  ]));
  if (Number.isFinite(direct)) return direct;

  const wins = findFirstNumeric(flatStats, ["matchesWon", "wonMatches", "wins", "victories"]);
  const losses = findFirstNumeric(flatStats, ["matchesLost", "lostMatches", "losses", "defeats"]);
  if (Number.isFinite(wins) && Number.isFinite(losses) && wins + losses > 0) {
    return clamp((wins / (wins + losses)) * 100, 0, 100);
  }

  return null;
}

function extractSofaScorePlayerStats(payload) {
  const flatStats = flattenNumericStats(payload);
  return {
    rank: findFirstNumeric(flatStats, ["worldRanking", "atpRanking", "wtaRanking", "ranking", "rank"]),
    holdPct: normalizePercentStat(findFirstNumeric(flatStats, [
      "serviceGamesWonPercentage",
      "holdPercentage",
      "holdPct"
    ])),
    acesAvg: findFirstNumeric(flatStats, ["acesPerMatch", "averageAces", "acesAvg"]),
    formPct: deriveFormPercent(flatStats)
  };
}

function numericField(item, keys, fallback = null) {
  const value = firstValue(item, keys);
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseEventDurationMinutes(event) {
  const directMinutes = numericField(event, [
    "time.duration",
    "time.durationMinutes",
    "duration",
    "durationMinutes",
    "matchDuration",
    "matchDurationMinutes",
    "statistics.matchDuration",
    "status.matchTime",
    "status.time"
  ]);
  if (Number.isFinite(directMinutes) && directMinutes > 0) return directMinutes;

  const seconds = numericField(event, [
    "time.durationSeconds",
    "durationSeconds",
    "matchDurationSeconds",
    "statistics.matchDurationSeconds"
  ]);
  if (Number.isFinite(seconds) && seconds > 0) return seconds / 60;

  return null;
}

function setsPlayedForEvent(event) {
  const winner = winnerSide(event);
  const result = buildMatchResult(event, winner);
  if (Number.isFinite(result.setsPlayed) && result.setsPlayed > 0) return result.setsPlayed;

  const periods = firstValue(event, ["periods", "score.periods"]);
  if (Array.isArray(periods)) {
    const completed = periods.filter((period) => {
      const home = Number(period?.home ?? period?.homeScore ?? period?.team1 ?? period?.a);
      const away = Number(period?.away ?? period?.awayScore ?? period?.team2 ?? period?.b);
      return Number.isFinite(home) && Number.isFinite(away) && (home > 0 || away > 0);
    });
    if (completed.length) return completed.length;
  }

  return 0;
}

function eventHasInjurySignal(event) {
  const values = [
    nameOf(firstValue(event, ["status.description", "statusDescription", "status.type", "statusType"]), ""),
    nameOf(firstValue(event, ["reason", "note", "commentary", "incidentType"]), "")
  ].join(" ").toLowerCase();

  return ["injury", "retired", "retirement", "walkover", "medical", "withdraw"].some((term) => values.includes(term));
}

function dayDiff(laterIso, earlierIso) {
  const later = new Date(laterIso);
  const earlier = new Date(earlierIso);
  if (Number.isNaN(later.getTime()) || Number.isNaN(earlier.getTime())) return null;
  return (later.getTime() - earlier.getTime()) / 86_400_000;
}

function eventStartIso(event) {
  const rawStart = firstValue(event, ["startTimestamp", "startTime", "start_time", "date", "time.currentPeriodStartTimestamp"]);
  if (rawStart === undefined || rawStart === null || rawStart === "") return null;
  return startTime(rawStart);
}

function deriveSofaFatigueAndInjury(recentEvents, playerIdValue, referenceStartTime) {
  if (!Array.isArray(recentEvents) || !recentEvents.length) {
    return { fatigueScore: null, injuryScore: null, fatigueDetails: null };
  }

  const reference = referenceStartTime || new Date().toISOString();
  const involved = recentEvents
    .filter((event) => playerId(event, "A") === playerIdValue || playerId(event, "B") === playerIdValue)
    .map((event) => ({ event, start: eventStartIso(event) }))
    .filter((entry) => entry.start)
    .sort((a, b) => new Date(b.start) - new Date(a.start));

  if (!involved.length) {
    return { fatigueScore: null, injuryScore: null, fatigueDetails: null };
  }

  let latestEvent = null;
  let setsPlayedLast7Days = 0;
  let matchesPlayedLast7Days = 0;
  let injuryFlag = false;

  involved.forEach(({ event, start }) => {
    const diffDays = dayDiff(reference, start);
    if (!Number.isFinite(diffDays) || diffDays < 0) return;
    if (!latestEvent || new Date(start) > new Date(latestEvent.start)) latestEvent = { event, start };
    if (diffDays <= 7) {
      matchesPlayedLast7Days += 1;
      setsPlayedLast7Days += setsPlayedForEvent(event);
    }
    if (!injuryFlag && eventHasInjurySignal(event)) injuryFlag = true;
  });

  const restDays = latestEvent ? dayDiff(reference, latestEvent.start) : null;
  const lastMatchMinutes = latestEvent ? parseEventDurationMinutes(latestEvent.event) : null;

  let fatiguePenalty = 0;
  if (Number.isFinite(restDays)) {
    if (restDays < 1) fatiguePenalty += 0.020;
    else if (restDays < 2) fatiguePenalty += 0.010;
  }
  if (Number.isFinite(lastMatchMinutes)) {
    if (lastMatchMinutes >= 180) fatiguePenalty += 0.020;
    else if (lastMatchMinutes >= 150) fatiguePenalty += 0.012;
    else if (lastMatchMinutes >= 120) fatiguePenalty += 0.006;
  }
  if (setsPlayedLast7Days >= 12) fatiguePenalty += 0.020;
  else if (setsPlayedLast7Days >= 9) fatiguePenalty += 0.012;
  else if (setsPlayedLast7Days >= 6) fatiguePenalty += 0.006;

  if (matchesPlayedLast7Days >= 5) fatiguePenalty += 0.015;
  else if (matchesPlayedLast7Days >= 4) fatiguePenalty += 0.008;

  const injuryPenalty = injuryFlag ? 0.030 : 0;
  const fatigueScore = round(clamp(fatiguePenalty * 400, 0, 100), 2);
  const injuryScore = round(clamp(injuryPenalty * 200, 0, 100), 2);

  const hasSignals = Number.isFinite(restDays)
    || Number.isFinite(lastMatchMinutes)
    || setsPlayedLast7Days > 0
    || matchesPlayedLast7Days > 0
    || injuryFlag;

  return {
    fatigueScore: hasSignals ? fatigueScore : null,
    injuryScore: hasSignals ? injuryScore : null,
    fatigueDetails: hasSignals ? {
      restDays: Number.isFinite(restDays) ? round(restDays, 2) : null,
      lastMatchMinutes: Number.isFinite(lastMatchMinutes) ? round(lastMatchMinutes, 1) : null,
      setsPlayedLast7Days,
      matchesPlayedLast7Days,
      injuryFlag
    } : null
  };
}

async function fetchSofaScoreRecentEvents(playerIdValue, source) {
  const paths = [
    `/player/${playerIdValue}/events/last/0`,
    `/player/${playerIdValue}/matches/last/0`,
    `/player/${playerIdValue}/events/last`
  ];
  const errors = [];

  for (const path of paths) {
    try {
      const payload = await fetchSofaScoreJson(path, null, source);
      const events = extractList(payload, ["events", "matches", "data"]);
      if (events.length) {
        return { events, sourcePath: path };
      }
    } catch (error) {
      errors.push(`${path}: ${error.message}`);
    }
  }

  return { events: [], sourcePath: "", errors };
}

function extractList(payload, keys) {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === "object");
  if (!payload || typeof payload !== "object") return [];

  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
    if (value && typeof value === "object") {
      const nested = extractList(value, keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

function valueAt(item, key) {
  if (!item || typeof item !== "object") return undefined;
  if (key in item) return item[key];
  return key.split(".").reduce((value, part) => (
    value && typeof value === "object" ? value[part] : undefined
  ), item);
}

function firstValue(item, keys) {
  for (const key of keys) {
    const value = valueAt(item, key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function firstValueWithKey(item, keys) {
  for (const key of keys) {
    const value = valueAt(item, key);
    if (value !== undefined && value !== null && value !== "") return { key, value };
  }
  return { key: "", value: undefined };
}

function nameOf(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") {
    return String(
      value.name
      || value.fullName
      || value.shortName
      || value.displayName
      || value.category?.name
      || value.uniqueTournament?.name
      || value.tournament?.name
      || value.slug
      || fallback
    );
  }
  return String(value);
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function numeric(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSurface(value) {
  const raw = nameOf(value, "hard").toLowerCase();
  if (raw.includes("grass")) return "Grass";
  if (raw.includes("clay")) return "Clay";
  if (raw.includes("indoor")) return "Indoor";
  return "Hard";
}

function normalizeLevel(value, tournament) {
  const text = `${nameOf(value, "")} ${tournament}`.toLowerCase();
  if (text.includes("grand slam") || ["wimbledon", "roland garros", "french open", "us open", "australian open"].some((name) => text.includes(name))) return "Grand Slam";
  if (text.includes("1000") && text.includes("wta")) return "WTA 1000";
  if (text.includes("1000")) return "ATP 1000";
  if (text.includes("500") && text.includes("wta")) return "WTA 500";
  if (text.includes("500")) return "ATP 500";
  if (text.includes("250") && text.includes("wta")) return "WTA 250";
  if (text.includes("250")) return "ATP 250";
  if (text.includes("challenger")) return "Challenger";
  if (text.includes("itf") || /\b[MW]\d{2,3}\b/i.test(text)) return "ITF";
  if (text.includes("wta")) return "WTA 250";
  return "ATP 250";
}

function normalizeTour(value, level, tournament) {
  const text = `${nameOf(value, "")} ${level} ${tournament}`.toUpperCase();
  if (text.includes("CHALLENGER")) return "Challenger";
  if (text.includes("ITF") || /\b[MW]\d{2,3}\b/.test(text)) return "ITF";
  if (text.includes("WTA")) return "WTA";
  return "ATP";
}

function playerName(event, side) {
  const keys = side === "A"
    ? ["playerA", "player_a", "homePlayer", "homeTeam", "home", "team1", "competitor1", "participant1"]
    : ["playerB", "player_b", "awayPlayer", "awayTeam", "away", "team2", "competitor2", "participant2"];
  const direct = firstValue(event, keys);
  if (direct) return nameOf(direct);

  const participants = firstValue(event, ["participants", "competitors", "players"]);
  if (Array.isArray(participants)) return nameOf(participants[side === "A" ? 0 : 1]);
  return "";
}

function playerId(event, side) {
  const index = side === "A" ? 0 : 1;
  const keys = side === "A"
    ? [
      "playerAId",
      "homePlayerId",
      "homeTeamId",
      "participant1Id",
      "competitor1Id",
      "team1Id",
      "playerA.id",
      "homePlayer.id",
      "homePlayer.player.id",
      "homePlayer.playerId",
      "homeTeam.id",
      "homeTeam.player.id",
      "homeTeam.playerId"
    ]
    : [
      "playerBId",
      "awayPlayerId",
      "awayTeamId",
      "participant2Id",
      "competitor2Id",
      "team2Id",
      "playerB.id",
      "awayPlayer.id",
      "awayPlayer.player.id",
      "awayPlayer.playerId",
      "awayTeam.id",
      "awayTeam.player.id",
      "awayTeam.playerId"
    ];
  const indexedKeys = [
    `participants.${index}.id`,
    `participants.${index}.player.id`,
    `participants.${index}.playerId`,
    `players.${index}.id`,
    `players.${index}.player.id`,
    `players.${index}.playerId`,
    `competitors.${index}.id`,
    `competitors.${index}.player.id`,
    `competitors.${index}.playerId`
  ];
  const found = firstValue(event, [...keys, ...indexedKeys]);
  const number = Number(found);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function startTime(value) {
  if (typeof value === "number") {
    const seconds = value > 10_000_000_000 ? value / 1000 : value;
    return new Date(seconds * 1000).toISOString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return startTime(Number(value));
  return value ? String(value) : new Date().toISOString();
}

function isoDateInTimeZone(value, timeZone) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function eventLocalDate(event, timeZone) {
  const rawStart = firstValue(event, ["startTimestamp", "startTime", "start_time", "date", "time.currentPeriodStartTimestamp"]);
  return isoDateInTimeZone(startTime(rawStart), timeZone);
}

function eventLooksDoubles(playerA, playerB, tournament) {
  return [playerA, playerB, tournament].some((value) => String(value).toLowerCase().includes(" / "))
    || String(tournament).toLowerCase().includes("doubles");
}

function matchStatus(event) {
  const code = numeric(firstValue(event, ["status.code", "statusCode"]), 0);
  const type = nameOf(firstValue(event, ["status.type", "statusType"]), "").toLowerCase();
  const description = nameOf(firstValue(event, ["status.description", "statusDescription"]), type || "Scheduled");
  const completed = code === 100 || ["finished", "ended", "complete", "completed"].includes(type);
  const live = ["inprogress", "in_progress", "live"].includes(type) || (code > 0 && code < 100);

  return {
    code,
    type: type || (completed ? "finished" : "scheduled"),
    description,
    completed,
    live
  };
}

function winnerSide(event) {
  const raw = firstValue(event, ["winnerSide", "winner", "winnerCode", "winner_code"]);
  const number = Number(raw);
  if (number === 1) return "A";
  if (number === 2) return "B";

  const text = nameOf(raw, "").toLowerCase();
  if (["a", "home", "home team", "player a", "team1", "team 1"].includes(text)) return "A";
  if (["b", "away", "away team", "player b", "team2", "team 2"].includes(text)) return "B";
  return "";
}

function scoreNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function setScore(homeScore, awayScore, setNumber) {
  const a = scoreNumber(homeScore?.[`period${setNumber}`]);
  const b = scoreNumber(awayScore?.[`period${setNumber}`]);
  if (a === null || b === null) return null;
  if (a === 0 && b === 0) return null;

  return {
    set: setNumber,
    a,
    b,
    tieBreakA: scoreNumber(homeScore?.[`period${setNumber}TieBreak`]),
    tieBreakB: scoreNumber(awayScore?.[`period${setNumber}TieBreak`])
  };
}

function buildMatchResult(event, resultWinnerSide) {
  const homeScore = firstValue(event, ["homeScore", "score.home", "home_score"]) || {};
  const awayScore = firstValue(event, ["awayScore", "score.away", "away_score"]) || {};
  const sets = [];

  for (let setNumber = 1; setNumber <= 5; setNumber += 1) {
    const score = setScore(homeScore, awayScore, setNumber);
    if (score) sets.push(score);
  }

  const totalGames = sets.length
    ? sets.reduce((sum, score) => sum + score.a + score.b, 0)
    : null;
  const tieBreaker = sets.some((score) => (
    score.tieBreakA !== null
    || score.tieBreakB !== null
    || (score.a === 7 && score.b === 6)
    || (score.a === 6 && score.b === 7)
  ));

  return {
    winner: resultWinnerSide,
    aSets: scoreNumber(homeScore.current ?? homeScore.display ?? homeScore.normaltime),
    bSets: scoreNumber(awayScore.current ?? awayScore.display ?? awayScore.normaltime),
    totalGames,
    tieBreaker,
    setsPlayed: sets.length || null,
    scoreline: sets.map((score) => {
      const tieBreak = score.tieBreakA !== null || score.tieBreakB !== null
        ? `(${score.tieBreakA ?? ""}-${score.tieBreakB ?? ""})`
        : "";
      return `${score.a}-${score.b}${tieBreak}`;
    }).join(" "),
    sets
  };
}

function buildLiveState(event, status) {
  const homeScore = firstValue(event, ["homeScore", "score.home", "home_score"]) || {};
  const awayScore = firstValue(event, ["awayScore", "score.away", "away_score"]) || {};
  const periods = firstValue(event, ["periods"]) || {};
  const time = firstValue(event, ["time"]) || {};
  const sets = [];

  for (let setNumber = 1; setNumber <= 5; setNumber += 1) {
    const score = setScore(homeScore, awayScore, setNumber);
    if (score) sets.push(score);
  }

  return {
    isLive: status.live,
    isCompleted: status.completed,
    status: status.description,
    currentPeriod: nameOf(periods.current, ""),
    pointA: homeScore.point !== undefined ? String(homeScore.point) : "",
    pointB: awayScore.point !== undefined ? String(awayScore.point) : "",
    setsA: scoreNumber(homeScore.current ?? homeScore.display ?? homeScore.normaltime),
    setsB: scoreNumber(awayScore.current ?? awayScore.display ?? awayScore.normaltime),
    firstToServe: scoreNumber(firstValue(event, ["firstToServe", "first_to_serve"])),
    currentPeriodStartTimestamp: scoreNumber(time.currentPeriodStartTimestamp),
    sets,
    scoreline: sets.map((score) => `${score.a}-${score.b}`).join(" ")
  };
}

function tracedNumber(event, keys, fallback, label) {
  const found = firstValueWithKey(event, keys);
  const number = Number(found.value);
  if (Number.isFinite(number)) {
    return {
      value: number,
      trace: traceEntry(label, number, "verified", `API field: ${found.key}`, "Value was present in the live match payload.")
    };
  }

  return {
    value: fallback,
    trace: traceEntry(label, fallback, "fallback", "Neutral model fallback", "The live slate did not include this player stat.")
  };
}

function traceEntry(label, value, status, source, note = "") {
  return { label, value, status, source, note };
}

function buildDataQuality(trace) {
  const entries = Object.values(trace || {});
  const verified = entries.filter((entry) => ["verified", "manual", "inferred", "derived"].includes(entry.status)).length;
  const fallback = entries.filter((entry) => ["fallback", "missing", "example"].includes(entry.status)).length;
  const total = entries.length;
  return {
    verified,
    fallback,
    total,
    score: total ? verified / total : 0
  };
}

function normalizeEvent(event, index, context = {}) {
  const playerA = playerName(event, "A");
  const playerB = playerName(event, "B");
  if (!playerA || !playerB) return null;
  const playerAId = playerId(event, "A");
  const playerBId = playerId(event, "B");
  const sofaStatsA = playerAId ? context.playerStatsById?.get(playerAId) : null;
  const sofaStatsB = playerBId ? context.playerStatsById?.get(playerBId) : null;

  const tournament = nameOf(firstValue(event, [
    "tournament",
    "tournamentName",
    "competition",
    "competitionName",
    "league",
    "leagueName",
    "eventName",
    "uniqueTournament",
    "tournament.uniqueTournament"
  ]), "Loaded Matches");
  const level = normalizeLevel(firstValue(event, ["level", "category", "tournament.category", "series", "tier"]), tournament);
  const tour = normalizeTour(firstValue(event, ["tour", "category", "tournament.category", "gender", "leagueType", "circuit"]), level, tournament);
  const rawFormat = numeric(firstValue(event, ["format", "bestOf", "best_of", "sets", "defaultPeriodCount"]), 0);
  const isDoubles = eventLooksDoubles(playerA, playerB, tournament);
  const inferredFormat = rawFormat === 5 || (level === "Grand Slam" && tour === "ATP" && !isDoubles) ? 5 : 3;
  const status = matchStatus(event);
  const resultWinnerSide = winnerSide(event);
  const result = buildMatchResult(event, resultWinnerSide);
  const live = buildLiveState(event, status);
  let rankA = tracedNumber(event, ["rankA", "playerARank", "homeRank", "homeTeam.ranking"], 50, "A rank");
  let rankB = tracedNumber(event, ["rankB", "playerBRank", "awayRank", "awayTeam.ranking"], 50, "B rank");
  let holdA = tracedNumber(event, ["holdA", "playerAHold", "homeHoldPct"], 80, "A hold %");
  let holdB = tracedNumber(event, ["holdB", "playerBHold", "awayHoldPct"], 80, "B hold %");
  let aceA = tracedNumber(event, ["aceA", "playerAAces", "homeAcesAvg"], 6, "A ace %");
  let aceB = tracedNumber(event, ["aceB", "playerBAces", "awayAcesAvg"], 6, "B ace %");
  let formA = tracedNumber(event, ["formA", "playerAForm", "homeForm"], 70, "A form");
  let formB = tracedNumber(event, ["formB", "playerBForm", "awayForm"], 70, "B form");
  const weatherFactor = tracedNumber(event, ["weatherFactor", "weather"], 0, "Weather");
  const fatigueA = tracedNumber(event, ["fatigueA", "playerAFatigue", "homeFatigue"], 0, "A fatigue");
  const fatigueB = tracedNumber(event, ["fatigueB", "playerBFatigue", "awayFatigue"], 0, "B fatigue");
  const injuryA = tracedNumber(event, ["injuryA", "playerAInjury", "homeInjury"], 0, "A injury");
  const injuryB = tracedNumber(event, ["injuryB", "playerBInjury", "awayInjury"], 0, "B injury");

  rankA = applySofaDerivedStat(
    rankA,
    Number.isFinite(sofaStatsA?.rank) ? Math.max(1, Math.round(sofaStatsA.rank)) : null,
    "A rank",
    playerAId,
    "Ranking was derived from SofaScore player season statistics."
  );
  rankB = applySofaDerivedStat(
    rankB,
    Number.isFinite(sofaStatsB?.rank) ? Math.max(1, Math.round(sofaStatsB.rank)) : null,
    "B rank",
    playerBId,
    "Ranking was derived from SofaScore player season statistics."
  );
  holdA = applySofaDerivedStat(
    holdA,
    Number.isFinite(sofaStatsA?.holdPct) ? round(sofaStatsA.holdPct, 2) : null,
    "A hold %",
    playerAId,
    "Hold percentage was derived from SofaScore player season statistics."
  );
  holdB = applySofaDerivedStat(
    holdB,
    Number.isFinite(sofaStatsB?.holdPct) ? round(sofaStatsB.holdPct, 2) : null,
    "B hold %",
    playerBId,
    "Hold percentage was derived from SofaScore player season statistics."
  );
  aceA = applySofaDerivedStat(
    aceA,
    Number.isFinite(sofaStatsA?.acesAvg) ? round(clamp(sofaStatsA.acesAvg, 0, 25), 2) : null,
    "A ace %",
    playerAId,
    "Aces average was derived from SofaScore player season statistics."
  );
  aceB = applySofaDerivedStat(
    aceB,
    Number.isFinite(sofaStatsB?.acesAvg) ? round(clamp(sofaStatsB.acesAvg, 0, 25), 2) : null,
    "B ace %",
    playerBId,
    "Aces average was derived from SofaScore player season statistics."
  );
  formA = applySofaDerivedStat(
    formA,
    Number.isFinite(sofaStatsA?.formPct) ? Math.round(sofaStatsA.formPct) : null,
    "A form",
    playerAId,
    "Form was derived from SofaScore player season statistics."
  );
  const fatigueANormalized = applySofaDerivedStat(
    fatigueA,
    Number.isFinite(sofaStatsA?.fatigueScore) ? sofaStatsA.fatigueScore : null,
    "A fatigue",
    playerAId,
    "Fatigue was derived from recent SofaScore match schedule and workload signals."
  );
  const fatigueBNormalized = applySofaDerivedStat(
    fatigueB,
    Number.isFinite(sofaStatsB?.fatigueScore) ? sofaStatsB.fatigueScore : null,
    "B fatigue",
    playerBId,
    "Fatigue was derived from recent SofaScore match schedule and workload signals."
  );
  const injuryANormalized = applySofaDerivedStat(
    injuryA,
    Number.isFinite(sofaStatsA?.injuryScore) ? sofaStatsA.injuryScore : null,
    "A injury",
    playerAId,
    "Injury risk was derived from recent SofaScore status/retirement signals."
  );
  const injuryBNormalized = applySofaDerivedStat(
    injuryB,
    Number.isFinite(sofaStatsB?.injuryScore) ? sofaStatsB.injuryScore : null,
    "B injury",
    playerBId,
    "Injury risk was derived from recent SofaScore status/retirement signals."
  );
  formB = applySofaDerivedStat(
    formB,
    Number.isFinite(sofaStatsB?.formPct) ? Math.round(sofaStatsB.formPct) : null,
    "B form",
    playerBId,
    "Form was derived from SofaScore player season statistics."
  );
  const surfaceFound = firstValueWithKey(event, ["surface", "courtSurface", "groundType", "ground", "tournament.uniqueTournament.groundType"]);
  const surface = normalizeSurface(surfaceFound.value);
  const dataTrace = {
    playerA: traceEntry("Player A", playerA, "verified", "API participant", "Player name came from the live match payload."),
    playerB: traceEntry("Player B", playerB, "verified", "API participant", "Player name came from the live match payload."),
    surface: traceEntry(
      "Surface",
      surface,
      surfaceFound.key ? "verified" : "fallback",
      surfaceFound.key ? `API field: ${surfaceFound.key}` : "Neutral model fallback",
      surfaceFound.key ? "Surface was normalized from the event or tournament payload." : "The live slate did not include a surface, so Hard is used only as a model fallback."
    ),
    format: traceEntry("Format", inferredFormat, rawFormat ? "verified" : "inferred", rawFormat ? "API match format" : "Tournament rules", rawFormat ? "Best-of format came from the event payload." : "Best-of format was inferred from tour and tournament level."),
    rankA: rankA.trace,
    rankB: rankB.trace,
    holdA: holdA.trace,
    holdB: holdB.trace,
    aceA: aceA.trace,
    aceB: aceB.trace,
    formA: formA.trace,
    formB: formB.trace,
    weatherFactor: weatherFactor.trace,
    fatigueA: fatigueANormalized.trace,
    fatigueB: fatigueBNormalized.trace,
    injuryA: injuryANormalized.trace,
    injuryB: injuryBNormalized.trace
  };

  return {
    id: String(firstValue(event, ["id", "eventId", "matchId", "fixtureId"]) || slugify(`${tournament}-${playerA}-${playerB}-${index}`)),
    tournament,
    level,
    tour,
    round: nameOf(firstValue(event, ["round", "roundName", "roundInfo.name", "stage", "phase"]), "Match"),
    court: nameOf(firstValue(event, ["court", "venue", "venue.name", "courtName"]), ""),
    startTime: startTime(firstValue(event, ["startTimestamp", "startTime", "start_time", "date", "time.currentPeriodStartTimestamp"])),
    statusCode: status.code,
    statusType: status.type,
    statusDescription: status.description,
    completed: status.completed,
    live: status.live,
    liveState: live,
    winnerSide: status.completed ? resultWinnerSide : "",
    scoreline: status.completed ? result.scoreline : "",
    actual: status.completed ? result : null,
    playerA,
    playerB,
    surface,
    format: String(inferredFormat),
    rankA: rankA.value,
    rankB: rankB.value,
    holdA: holdA.value,
    holdB: holdB.value,
    aceA: aceA.value,
    aceB: aceB.value,
    formA: formA.value,
    formB: formB.value,
    weatherFactor: weatherFactor.value,
    fatigueA: fatigueANormalized.value,
    fatigueB: fatigueBNormalized.value,
    injuryA: injuryANormalized.value,
    injuryB: injuryBNormalized.value,
    dataTrace,
    dataQuality: buildDataQuality(dataTrace)
  };
}

async function fetchDailyTennisSlate(date, options = {}) {
  const env = readEnvFile();
  const timeZone = env.SLATE_TIME_ZONE || defaultSlateTimeZone;
  const sofaPrimary = await fetchSofaScoreDailyEvents(date, env);
  let sourceLabel = "Live slate";
  let sourceDetails = {};
  let categories = [];
  let categoriesToLoad = [];
  let events = [];
  let categoryErrors = [];

  // SofaScore only—no AllSports fallback to avoid quota issues
  sourceLabel = `SofaScore Tennis live slate (${env.SOFASCORE_RAPIDAPI_HOST || defaultSofaScoreHost})`;
  sourceDetails = {
    primary: "sofascore",
    fallbackUsed: false,
    sofaScoreSlate: sofaPrimary.metadata
  };
  events = sofaPrimary.events;

  const dateMatchedEvents = events.filter((event) => eventLocalDate(event, timeZone) === date);
  const usedDateEndpointFallback = !dateMatchedEvents.length && events.length > 0;
  const eventsForDate = usedDateEndpointFallback ? events : dateMatchedEvents;
  const sofaScoreEnrichment = await buildSofaScorePlayerStatsMap(eventsForDate, env);
  const matches = eventsForDate
    .map((event, index) => normalizeEvent(event, index, sofaScoreEnrichment))
    .filter(Boolean)
    .sort((a, b) => (
      (levelPriority[a.level] ?? 99) - (levelPriority[b.level] ?? 99)
      || new Date(a.startTime) - new Date(b.startTime)
      || a.tournament.localeCompare(b.tournament)
    ));

  const payload = {
    source: sourceLabel,
    date,
    generatedAt: new Date().toISOString(),
    timeZone,
    categoryCount: categories.length,
    loadedCategoryCount: categoriesToLoad.length,
    rawEventCount: events.length,
    dateMatchedEventCount: dateMatchedEvents.length,
    usedDateEndpointFallback,
    filteredOutCount: events.length - eventsForDate.length,
    count: matches.length,
    partialErrors: categoryErrors,
    sourceDetails,
    sofaScore: sofaScoreEnrichment.metadata,
    matches
  };

  mkdirSync(join(root, "api_cache"), { recursive: true });
  writeFileSync(
    join(root, "api_cache", `raw_live_tennis_${date}.json`),
    JSON.stringify({
      source: sourceLabel,
      sourceDetails,
      categories,
      events,
      eventsForDate,
      categoryErrors,
      sofaScore: sofaScoreEnrichment.metadata
    }, null, 2),
    "utf-8"
  );
  writeFileSync(join(root, "matches_preload.json"), JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

async function handleRefreshSlate(url, response) {
  const date = url.searchParams.get("date") || todayIsoDate();
  const maxCategoriesParam = url.searchParams.get("maxCategories");
  const maxCategories = maxCategoriesParam === null ? null : Number.parseInt(maxCategoriesParam, 10);

  if (!validIsoDate(date)) {
    sendJson(response, 400, {
      ok: false,
      error: "Date must use YYYY-MM-DD format."
    });
    return;
  }
  if (maxCategoriesParam !== null && (!Number.isFinite(maxCategories) || maxCategories < 0)) {
    sendJson(response, 400, {
      ok: false,
      error: "maxCategories must be a positive whole number."
    });
    return;
  }

  try {
    const payload = await fetchDailyTennisSlate(date, { maxCategories });
    sendJson(response, 200, {
      ok: true,
      date,
      count: payload.count ?? payload.matches?.length ?? 0,
      categoryCount: payload.categoryCount ?? null,
      loadedCategoryCount: payload.loadedCategoryCount ?? null,
      rawEventCount: payload.rawEventCount ?? null,
      dateMatchedEventCount: payload.dateMatchedEventCount ?? null,
      usedDateEndpointFallback: payload.usedDateEndpointFallback ?? false,
      filteredOutCount: payload.filteredOutCount ?? null,
      timeZone: payload.timeZone ?? null,
      source: payload.source ?? "Live slate",
      sourceDetails: payload.sourceDetails ?? null,
      sofaScore: payload.sofaScore ?? null,
      generatedAt: payload.generatedAt ?? new Date().toISOString()
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      date,
      error: error.message
    });
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      service: "tennis-edge",
      generatedAt: new Date().toISOString()
    });
    return;
  }

  if (!authorized(request)) {
    requestBasicAuth(response);
    return;
  }

  if (url.pathname === "/api/refresh-slate") {
    await handleRefreshSlate(url, response);
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalizedPath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, normalizedPath);

  if (!publicFileAllowed(normalizedPath) || !filePath.startsWith(root) || !existsSync(filePath)) {
    if (shouldServeAppShell(request, normalizedPath)) {
      response.writeHead(200, {
        "content-type": types[".html"],
        "cache-control": "no-store"
      });
      createReadStream(join(root, "index.html")).pipe(response);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": types[extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(filePath).pipe(response);
}).listen(port, host, () => {
  console.log(`Tennis Edge running at http://localhost:${port}`);
  localNetworkUrls().forEach((url) => {
    console.log(`Phone URL: ${url}`);
  });
});
