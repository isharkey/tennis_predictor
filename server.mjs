import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "0.0.0.0";
const defaultAllSportsHost = "tennisapi1.p.rapidapi.com";
const defaultAllSportsBaseUrl = "https://tennisapi1.p.rapidapi.com";
const allSportsBundleHost = "allsportsapi2.p.rapidapi.com";
const allSportsBundleBaseUrl = "https://allsportsapi2.p.rapidapi.com";
const defaultSofaScoreHost = "sofascore6.p.rapidapi.com";
const defaultSofaScoreBaseUrl = "https://sofascore6.p.rapidapi.com/api/sofascore/v1";
const defaultJjrmHost = "tennis-api-atp-wta-itf.p.rapidapi.com";
const defaultJjrmBaseUrl = "https://tennis-api-atp-wta-itf.p.rapidapi.com";
const defaultTennisApi5Host = "tennis-api5.p.rapidapi.com";
const defaultTennisApi5BaseUrl = "https://tennis-api5.p.rapidapi.com";
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
const historicalThreeYearStatAverages = {
  ATP: {
    Hard: { rank: 85, hold: 82.3, ace: 7.8, form: 64 },
    Indoor: { rank: 85, hold: 84.1, ace: 8.2, form: 64 },
    Clay: { rank: 85, hold: 78.9, ace: 5.9, form: 64 },
    Grass: { rank: 85, hold: 85.0, ace: 9.1, form: 64 }
  },
  WTA: {
    Hard: { rank: 95, hold: 66.8, ace: 3.8, form: 62 },
    Indoor: { rank: 95, hold: 68.4, ace: 4.0, form: 62 },
    Clay: { rank: 95, hold: 63.7, ace: 2.9, form: 62 },
    Grass: { rank: 95, hold: 70.4, ace: 4.4, form: 62 }
  },
  Challenger: {
    Hard: { rank: 215, hold: 79.7, ace: 6.1, form: 59 },
    Indoor: { rank: 215, hold: 81.2, ace: 6.4, form: 59 },
    Clay: { rank: 215, hold: 76.2, ace: 4.6, form: 59 },
    Grass: { rank: 215, hold: 82.0, ace: 7.2, form: 59 }
  },
  ITF: {
    Hard: { rank: 430, hold: 74.1, ace: 3.9, form: 55 },
    Indoor: { rank: 430, hold: 75.2, ace: 4.1, form: 55 },
    Clay: { rank: 430, hold: 70.8, ace: 2.8, form: 55 },
    Grass: { rank: 430, hold: 76.0, ace: 4.7, form: 55 }
  }
};
const defaultPlayerStatsMaxPulls = 40;

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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function basicAuthEnabled() {
  const { username, password } = basicAuthCredentials();
  return Boolean(username && password);
}

function basicAuthCredentials() {
  const env = readEnvFile();
  return {
    username: String(env.APP_BASIC_AUTH_USER ?? "").trim(),
    password: String(env.APP_BASIC_AUTH_PASSWORD ?? "").trim()
  };
}

function authorized(request) {
  if (!basicAuthEnabled()) return true;

  const { username: basicAuthUser, password: basicAuthPassword } = basicAuthCredentials();

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

async function fetchAllSportsJson(path, source) {
  const targetUrl = resolveApiUrl(path, source.baseUrl);
  const apiResponse = await fetch(targetUrl, {
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

function tennisApi5Source(env) {
  const apiKey = env.TENNIS_API5_RAPIDAPI_KEY
    || env.RAPIDAPI_KEY
    || env.ALLSPORTS_TENNIS_RAPIDAPI_KEY
    || env.SOFASCORE_RAPIDAPI_KEY;
  if (!apiKey) {
    throw new Error("Missing TENNIS_API5_RAPIDAPI_KEY or RAPIDAPI_KEY in .env.");
  }

  return {
    apiKey,
    rapidHost: env.TENNIS_API5_RAPIDAPI_HOST || defaultTennisApi5Host,
    baseUrl: (env.TENNIS_API5_RAPIDAPI_BASE_URL || defaultTennisApi5BaseUrl).replace(/\/$/, "")
  };
}

async function fetchTennisApi5Json(path, source) {
  const targetUrl = resolveApiUrl(path, source.baseUrl);
  const apiResponse = await fetch(targetUrl, {
    headers: {
      "Content-Type": "application/json",
      "X-RapidAPI-Key": source.apiKey,
      "X-RapidAPI-Host": source.rapidHost
    }
  });

  if (apiResponse.status === 204) return {};

  const body = await apiResponse.text();
  if (!apiResponse.ok) {
    throw new Error(`Tennis API5 ${apiResponse.status}: ${body.slice(0, 300)}`);
  }

  return body ? JSON.parse(body) : {};
}

function resolveApiUrl(path, baseUrl) {
  return /^https?:\/\//i.test(path) ? path : `${baseUrl}${path}`;
}

function configuredPlayerProfileSources(env, allSportsSource) {
  const profileSources = [];
  const allSportsTemplate = (
    env.ALLSPORTS_TENNIS_PLAYER_STATS_PATH_TEMPLATE
    || env.ALLSPORTS_TENNIS_PLAYER_STATS_PATH
    || ""
  ).trim();
  if (allSportsTemplate) {
    profileSources.push({
      provider: "allsports",
      pathTemplate: allSportsTemplate,
      source: allSportsSource
    });
  }

  const sofascoreTemplate = (env.SOFASCORE_PLAYER_STATS_PATH_TEMPLATE || "").trim();
  const sofascoreKey = env.SOFASCORE_RAPIDAPI_KEY || env.RAPIDAPI_KEY || env.ALLSPORTS_TENNIS_RAPIDAPI_KEY;
  if (sofascoreTemplate && sofascoreKey) {
    profileSources.push({
      provider: "sofascore",
      pathTemplate: sofascoreTemplate,
      source: {
        apiKey: sofascoreKey,
        rapidHost: env.SOFASCORE_RAPIDAPI_HOST || defaultSofaScoreHost,
        baseUrl: (env.SOFASCORE_RAPIDAPI_BASE_URL || defaultSofaScoreBaseUrl).replace(/\/$/, "")
      }
    });
  }

  const jjrmTemplate = (env.JJRM365_TENNIS_PLAYER_STATS_PATH_TEMPLATE || "").trim();
  const jjrmKey = env.JJRM365_TENNIS_RAPIDAPI_KEY || env.RAPIDAPI_KEY || env.ALLSPORTS_TENNIS_RAPIDAPI_KEY;
  if (jjrmTemplate && jjrmKey) {
    profileSources.push({
      provider: "jjrm365",
      pathTemplate: jjrmTemplate,
      source: {
        apiKey: jjrmKey,
        rapidHost: env.JJRM365_TENNIS_RAPIDAPI_HOST || defaultJjrmHost,
        baseUrl: (env.JJRM365_TENNIS_RAPIDAPI_BASE_URL || defaultJjrmBaseUrl).replace(/\/$/, "")
      }
    });
  }

  return profileSources;
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

function numericLoose(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.includes("/") || trimmed.includes(":")) return null;
    const match = trimmed.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function firstNumericValue(item, keys) {
  for (const key of keys) {
    const parsed = numericLoose(valueAt(item, key));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function statPairFromContainer(container) {
  const sideAKeys = ["home", "playerA", "player1", "competitor1", "participant1", "team1", "first", "left", "a", "value1", "p1"];
  const sideBKeys = ["away", "playerB", "player2", "competitor2", "participant2", "team2", "second", "right", "b", "value2", "p2"];
  let a = firstNumericValue(container, sideAKeys);
  let b = firstNumericValue(container, sideBKeys);

  const values = valueAt(container, "values");
  if ((!Number.isFinite(a) || !Number.isFinite(b)) && Array.isArray(values) && values.length >= 2) {
    if (!Number.isFinite(a)) a = numericLoose(values[0]);
    if (!Number.isFinite(b)) b = numericLoose(values[1]);
  }

  return { a, b };
}

function findStatPairByLabel(payload, labels) {
  const queue = [payload];

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      current.forEach((entry) => queue.push(entry));
      continue;
    }

    const label = nameOf(firstValue(current, ["name", "label", "title", "key", "type", "slug"]), "").toLowerCase();
    if (label && labels.some((target) => label.includes(target))) {
      const pair = statPairFromContainer(current);
      if (Number.isFinite(pair.a) || Number.isFinite(pair.b)) return pair;
    }

    Object.values(current).forEach((value) => {
      if (value && typeof value === "object") queue.push(value);
    });
  }

  return { a: null, b: null };
}

function mergeStatPairs(primary, secondary) {
  return {
    a: Number.isFinite(primary.a) ? primary.a : secondary.a,
    b: Number.isFinite(primary.b) ? primary.b : secondary.b
  };
}

function extractPredictionSimulationInputs(payload) {
  const playerA = nameOf(firstValue(payload, [
    "homeTeam.name",
    "home.name",
    "playerA",
    "player1.name",
    "competitor1.name",
    "participants.0.name"
  ]), "Player A");
  const playerB = nameOf(firstValue(payload, [
    "awayTeam.name",
    "away.name",
    "playerB",
    "player2.name",
    "competitor2.name",
    "participants.1.name"
  ]), "Player B");

  const rankPair = mergeStatPairs(
    {
      a: firstNumericValue(payload, ["homeRank", "rankA", "home.rank", "homeTeam.rank", "homeTeam.ranking", "statistics.home.rank"]),
      b: firstNumericValue(payload, ["awayRank", "rankB", "away.rank", "awayTeam.rank", "awayTeam.ranking", "statistics.away.rank"])
    },
    findStatPairByLabel(payload, ["rank", "ranking"])
  );
  const holdPair = mergeStatPairs(
    {
      a: firstNumericValue(payload, ["holdA", "homeHoldPct", "home.holdPct", "statistics.home.serviceGamesWonPercentage", "homeTeam.statistics.serviceGamesWonPercentage"]),
      b: firstNumericValue(payload, ["holdB", "awayHoldPct", "away.holdPct", "statistics.away.serviceGamesWonPercentage", "awayTeam.statistics.serviceGamesWonPercentage"])
    },
    findStatPairByLabel(payload, ["hold", "service games won", "service won"])
  );
  const acePair = mergeStatPairs(
    {
      a: firstNumericValue(payload, ["aceA", "homeAces", "home.aces", "statistics.home.acesPerMatch", "homeTeam.statistics.acesPerMatch"]),
      b: firstNumericValue(payload, ["aceB", "awayAces", "away.aces", "statistics.away.acesPerMatch", "awayTeam.statistics.acesPerMatch"])
    },
    findStatPairByLabel(payload, ["aces", "ace"])
  );
  const formPair = mergeStatPairs(
    {
      a: firstNumericValue(payload, ["formA", "homeForm", "home.form", "statistics.home.form", "homeTeam.statistics.form"]),
      b: firstNumericValue(payload, ["formB", "awayForm", "away.form", "statistics.away.form", "awayTeam.statistics.form"])
    },
    findStatPairByLabel(payload, ["form", "win %", "win percentage", "wins"])
  );
  const fatiguePair = mergeStatPairs(
    {
      a: firstNumericValue(payload, ["fatigueA", "homeFatigue", "home.fatigue", "statistics.home.fatigue"]),
      b: firstNumericValue(payload, ["fatigueB", "awayFatigue", "away.fatigue", "statistics.away.fatigue"])
    },
    findStatPairByLabel(payload, ["fatigue", "rest"])
  );
  const injuryPair = mergeStatPairs(
    {
      a: firstNumericValue(payload, ["injuryA", "homeInjury", "home.injury", "statistics.home.injury"]),
      b: firstNumericValue(payload, ["injuryB", "awayInjury", "away.injury", "statistics.away.injury"])
    },
    findStatPairByLabel(payload, ["injury"])
  );

  return {
    playerA,
    playerB,
    extracted: {
      rankA: rankPair.a,
      rankB: rankPair.b,
      holdA: holdPair.a,
      holdB: holdPair.b,
      aceA: acePair.a,
      aceB: acePair.b,
      formA: formPair.a,
      formB: formPair.b,
      fatigueA: fatiguePair.a,
      fatigueB: fatiguePair.b,
      injuryA: injuryPair.a,
      injuryB: injuryPair.b
    },
    simulationInputs: {
      playerA,
      playerB,
      rankA: Number.isFinite(rankPair.a) ? rankPair.a : 50,
      rankB: Number.isFinite(rankPair.b) ? rankPair.b : 50,
      holdA: Number.isFinite(holdPair.a) ? holdPair.a : 80,
      holdB: Number.isFinite(holdPair.b) ? holdPair.b : 80,
      aceA: Number.isFinite(acePair.a) ? acePair.a : 6,
      aceB: Number.isFinite(acePair.b) ? acePair.b : 6,
      formA: Number.isFinite(formPair.a) ? formPair.a : 70,
      formB: Number.isFinite(formPair.b) ? formPair.b : 70,
      fatigueA: Number.isFinite(fatiguePair.a) ? fatiguePair.a : 0,
      fatigueB: Number.isFinite(fatiguePair.b) ? fatiguePair.b : 0,
      injuryA: Number.isFinite(injuryPair.a) ? injuryPair.a : 0,
      injuryB: Number.isFinite(injuryPair.b) ? injuryPair.b : 0
    }
  };
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

function profileTour(level, tour) {
  if (tour === "Challenger" || level === "Challenger") return "Challenger";
  if (tour === "ITF" || level === "ITF") return "ITF";
  if (tour === "WTA" || String(level).startsWith("WTA")) return "WTA";
  return "ATP";
}

function historicalStatProfile(level, tour, surface) {
  const canonicalTour = profileTour(level, tour);
  const tourProfiles = historicalThreeYearStatAverages[canonicalTour] || historicalThreeYearStatAverages.ATP;
  return tourProfiles[surface] || tourProfiles.Hard;
}

function playerId(event, side) {
  const keys = side === "A"
    ? ["playerAId", "homePlayerId", "homeTeam.id", "home.id", "participant1.id", "competitor1.id"]
    : ["playerBId", "awayPlayerId", "awayTeam.id", "away.id", "participant2.id", "competitor2.id"];
  const direct = firstValue(event, keys);
  if (direct !== undefined && direct !== null && direct !== "") return String(direct);

  const participants = firstValue(event, ["participants", "competitors", "players"]);
  if (Array.isArray(participants)) {
    const participant = participants[side === "A" ? 0 : 1];
    if (participant && participant.id !== undefined && participant.id !== null && participant.id !== "") {
      return String(participant.id);
    }
  }

  return "";
}

function playerProviderId(event, side, provider) {
  if (provider === "sofascore") {
    const keys = side === "A"
      ? ["playerASofaScoreId", "homePlayerSofaScoreId", "homeTeam.sofascoreId", "home.sofascoreId", "participant1.sofascoreId", "competitor1.sofascoreId"]
      : ["playerBSofaScoreId", "awayPlayerSofaScoreId", "awayTeam.sofascoreId", "away.sofascoreId", "participant2.sofascoreId", "competitor2.sofascoreId"];
    const value = firstValue(event, keys);
    if (value !== undefined && value !== null && value !== "") return String(value);
  }

  if (provider === "jjrm365") {
    const keys = side === "A"
      ? ["playerAJjrmId", "homePlayerJjrmId", "homeTeam.jjrmId", "home.jjrmId", "participant1.jjrmId", "competitor1.jjrmId"]
      : ["playerBJjrmId", "awayPlayerJjrmId", "awayTeam.jjrmId", "away.jjrmId", "participant2.jjrmId", "competitor2.jjrmId"];
    const value = firstValue(event, keys);
    if (value !== undefined && value !== null && value !== "") return String(value);
  }

  return playerId(event, side);
}

function flattenNumericStats(value, prefix = "", output = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenNumericStats(item, `${prefix}[${index}]`, output));
    return output;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nested]) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenNumericStats(nested, nextPrefix, output);
    });
    return output;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    output[prefix] = value;
  }

  return output;
}

function normalizedStatKey(value) {
  return String(value).toLowerCase().replace(/[_\-\s]/g, "");
}

function firstMatchingNumeric(flat, candidates) {
  const lookup = candidates.map((candidate) => normalizedStatKey(candidate));
  for (const [key, value] of Object.entries(flat)) {
    const normalized = normalizedStatKey(key);
    if (lookup.some((candidate) => normalized.includes(candidate))) return Number(value);
  }
  return null;
}

function normalizeRate(value) {
  if (!Number.isFinite(value)) return null;
  const rate = value > 1 && value <= 100 ? value / 100 : value;
  return Math.max(0, Math.min(1, rate));
}

function extractLivePlayerProfile(payload) {
  const flat = flattenNumericStats(payload);
  const rank = firstMatchingNumeric(flat, [
    "rank",
    "ranking",
    "position",
    "worldRank",
    "currentRank"
  ]);
  const holdRate = normalizeRate(firstMatchingNumeric(flat, [
    "serviceGamesWonPercentage",
    "holdPercentage",
    "holdPct",
    "serviceGamesWonPct"
  ]));
  const ace = firstMatchingNumeric(flat, [
    "acesPerMatch",
    "averageAces",
    "acesAvg",
    "acePercentage",
    "acesPerSet",
    "aces"
  ]);
  const formRate = normalizeRate(firstMatchingNumeric(flat, [
    "recentWinPercentage",
    "recentWinPct",
    "last5WinPercentage",
    "last10WinPercentage",
    "winPercentage",
    "winPct",
    "winRate",
    "form"
  ]));
  const fatigue = firstMatchingNumeric(flat, [
    "fatigue",
    "fatigueIndex",
    "loadIndex",
    "recoveryIndex",
    "restDisadvantage"
  ]);

  return {
    rank: Number.isFinite(rank) ? rank : null,
    hold: Number.isFinite(holdRate) ? holdRate * 100 : null,
    ace: Number.isFinite(ace) ? ace : null,
    form: Number.isFinite(formRate) ? formRate * 100 : null,
    fatigue: Number.isFinite(fatigue) ? fatigue : null,
    sourceByField: {}
  };
}

function emptyLiveProfile() {
  return {
    rank: null,
    hold: null,
    ace: null,
    form: null,
    fatigue: null,
    sourceByField: {}
  };
}

function mergeLiveProfile(target, incoming, provider) {
  let changed = false;
  ["rank", "hold", "ace", "form", "fatigue"].forEach((fieldName) => {
    if (Number.isFinite(incoming[fieldName]) && !Number.isFinite(target[fieldName])) {
      target[fieldName] = incoming[fieldName];
      target.sourceByField[fieldName] = provider;
      changed = true;
    }
  });
  return changed;
}

function formatPlayerStatsPath(pathTemplate, currentPlayerId) {
  if (!String(currentPlayerId || "").trim()) {
    throw new Error("Missing player id for player stats request.");
  }
  const encoded = encodeURIComponent(currentPlayerId);
  const hasPlaceholder = /\{playerId\}|\{player_id\}/.test(pathTemplate);
  if (hasPlaceholder) return pathTemplate.replace(/\{playerId\}|\{player_id\}/g, encoded);
  return `${pathTemplate}${pathTemplate.includes("?") ? "&" : "?"}player_id=${encoded}`;
}

async function fetchPlayerStatProfiles(events, env, apiSource) {
  const profileSources = configuredPlayerProfileSources(env, apiSource);
  if (!profileSources.length) {
    return {
      profiles: new Map(),
      configured: false,
      errors: [],
      requestedCount: 0,
      loadedCount: 0,
      providers: []
    };
  }
  const maxPullsRaw = Number.parseInt(env.ALLSPORTS_TENNIS_PLAYER_STATS_MAX_PULLS || "", 10);
  const maxPulls = Number.isFinite(maxPullsRaw) && maxPullsRaw > 0 ? maxPullsRaw : defaultPlayerStatsMaxPulls;

  const errors = [];
  const profiles = new Map();
  const providers = [];
  const providerPriority = ["sofascore", "jjrm365", "allsports"];

  for (const providerName of providerPriority) {
    const profileSource = profileSources.find((candidate) => candidate.provider === providerName);
    if (!profileSource) continue;

    const providerSeenIds = new Set();
    const requests = [];
    events.forEach((event) => {
      ["A", "B"].forEach((side) => {
        const eventKey = firstValue(event, ["id", "eventId", "matchId", "fixtureId"]) || slugify(`${nameOf(firstValue(event, ["tournament", "competition", "league", "uniqueTournament"]), "match")}-${startTime(firstValue(event, ["startTimestamp", "startTime", "start_time", "date"]))}`);
        const canonicalId = playerId(event, side) || slugify(`${playerName(event, side)}-${eventKey}-${side}`);
        const providerId = playerProviderId(event, side, providerName);
        if (!providerId) return;
        const dedupeKey = `${canonicalId}|${providerId}`;
        if (providerSeenIds.has(dedupeKey)) return;
        providerSeenIds.add(dedupeKey);
        requests.push({ canonicalId, providerId });
      });
    });

    const requestsToLoad = requests.slice(0, maxPulls);
    const providerErrors = [];
    let loadedCount = 0;

    for (const request of requestsToLoad) {
      try {
        const payload = await fetchAllSportsJson(
          formatPlayerStatsPath(profileSource.pathTemplate, request.providerId),
          profileSource.source
        );
        const profile = extractLivePlayerProfile(payload);
        if ([profile.rank, profile.hold, profile.ace, profile.form, profile.fatigue].some((value) => Number.isFinite(value))) {
          const existing = profiles.get(request.canonicalId) || emptyLiveProfile();
          const changed = mergeLiveProfile(existing, profile, providerName);
          profiles.set(request.canonicalId, existing);
          if (changed) loadedCount += 1;
        }
      } catch (error) {
        const errorRecord = { provider: providerName, playerId: request.providerId, canonicalId: request.canonicalId, error: error.message };
        providerErrors.push(errorRecord);
        errors.push(errorRecord);
      }
    }

    providers.push({
      provider: providerName,
      host: profileSource.source.rapidHost,
      configured: true,
      requestedCount: requestsToLoad.length,
      loadedCount,
      errorCount: providerErrors.length
    });
  }

  return {
    profiles,
    configured: true,
    errors,
    requestedCount: providers.reduce((sum, provider) => sum + provider.requestedCount, 0),
    loadedCount: profiles.size,
    providers
  };
}

function resolveStatValue(event, keys, liveValue, fallback, sourceHint = "") {
  const rawValue = firstValue(event, keys);
  if (rawValue !== undefined && rawValue !== null && rawValue !== "") {
    return { value: numeric(rawValue, fallback), quality: "direct", detail: "event" };
  }
  if (Number.isFinite(liveValue)) {
    return { value: liveValue, quality: "derived", detail: sourceHint || "player_profile" };
  }
  return { value: fallback, quality: "fallback", detail: "historical_baseline" };
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

function normalizeEvent(event, index, liveProfiles) {
  const playerA = playerName(event, "A");
  const playerB = playerName(event, "B");
  if (!playerA || !playerB) return null;

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
  const surface = normalizeSurface(firstValue(event, ["surface", "courtSurface", "groundType", "ground", "tournament.uniqueTournament.groundType"]));
  const statProfile = historicalStatProfile(level, tour, surface);
  const liveProfileA = liveProfiles.get(playerId(event, "A")) || emptyLiveProfile();
  const liveProfileB = liveProfiles.get(playerId(event, "B")) || emptyLiveProfile();
  const rankAInfo = resolveStatValue(event, ["rankA", "playerARank", "homeRank", "homeTeam.ranking"], liveProfileA.rank, statProfile.rank, liveProfileA.sourceByField.rank);
  const rankBInfo = resolveStatValue(event, ["rankB", "playerBRank", "awayRank", "awayTeam.ranking"], liveProfileB.rank, statProfile.rank, liveProfileB.sourceByField.rank);
  const holdAInfo = resolveStatValue(event, [
    "holdA",
    "playerAHold",
    "homeHoldPct",
    "homeTeam.holdPct",
    "homeTeam.statistics.holdPct",
    "homeTeam.statistics.serviceGamesWonPercentage",
    "home.stats.serviceGamesWonPercentage",
    "statistics.home.serviceGamesWonPercentage"
  ], liveProfileA.hold, statProfile.hold, liveProfileA.sourceByField.hold);
  const holdBInfo = resolveStatValue(event, [
    "holdB",
    "playerBHold",
    "awayHoldPct",
    "awayTeam.holdPct",
    "awayTeam.statistics.holdPct",
    "awayTeam.statistics.serviceGamesWonPercentage",
    "away.stats.serviceGamesWonPercentage",
    "statistics.away.serviceGamesWonPercentage"
  ], liveProfileB.hold, statProfile.hold, liveProfileB.sourceByField.hold);
  const aceAInfo = resolveStatValue(event, [
    "aceA",
    "playerAAces",
    "homeAcesAvg",
    "homeAces",
    "homeTeam.statistics.acesPerMatch",
    "home.stats.acesPerMatch",
    "statistics.home.acesPerMatch"
  ], liveProfileA.ace, statProfile.ace, liveProfileA.sourceByField.ace);
  const aceBInfo = resolveStatValue(event, [
    "aceB",
    "playerBAces",
    "awayAcesAvg",
    "awayAces",
    "awayTeam.statistics.acesPerMatch",
    "away.stats.acesPerMatch",
    "statistics.away.acesPerMatch"
  ], liveProfileB.ace, statProfile.ace, liveProfileB.sourceByField.ace);
  const formAInfo = resolveStatValue(event, [
    "formA",
    "playerAForm",
    "homeForm",
    "homeTeam.form",
    "homeTeam.statistics.form",
    "homeTeam.statistics.recentWinPercentage",
    "home.stats.recentWinPercentage",
    "statistics.home.recentWinPercentage"
  ], liveProfileA.form, statProfile.form, liveProfileA.sourceByField.form);
  const formBInfo = resolveStatValue(event, [
    "formB",
    "playerBForm",
    "awayForm",
    "awayTeam.form",
    "awayTeam.statistics.form",
    "awayTeam.statistics.recentWinPercentage",
    "away.stats.recentWinPercentage",
    "statistics.away.recentWinPercentage"
  ], liveProfileB.form, statProfile.form, liveProfileB.sourceByField.form);
  const fatigueAInfo = resolveStatValue(event, [
    "fatigueA",
    "playerAFatigue",
    "homeFatigue",
    "homeTeam.fatigue",
    "homeTeam.statistics.fatigue",
    "home.stats.fatigue",
    "statistics.home.fatigue"
  ], liveProfileA.fatigue, 0, liveProfileA.sourceByField.fatigue);
  const fatigueBInfo = resolveStatValue(event, [
    "fatigueB",
    "playerBFatigue",
    "awayFatigue",
    "awayTeam.fatigue",
    "awayTeam.statistics.fatigue",
    "away.stats.fatigue",
    "statistics.away.fatigue"
  ], liveProfileB.fatigue, 0, liveProfileB.sourceByField.fatigue);
  const injuryAInfo = resolveStatValue(event, ["injuryA", "playerAInjury", "homeInjury"], null, 0);
  const injuryBInfo = resolveStatValue(event, ["injuryB", "playerBInjury", "awayInjury"], null, 0);
  const keyStatsMissingBothPlayers = ["hold", "ace", "form"].filter((key) => (
    key === "hold" ? holdAInfo.quality === "fallback" && holdBInfo.quality === "fallback"
      : key === "ace" ? aceAInfo.quality === "fallback" && aceBInfo.quality === "fallback"
        : formAInfo.quality === "fallback" && formBInfo.quality === "fallback"
  ));
  const inputQuality = {
    rankA: rankAInfo,
    rankB: rankBInfo,
    holdA: holdAInfo,
    holdB: holdBInfo,
    aceA: aceAInfo,
    aceB: aceBInfo,
    formA: formAInfo,
    formB: formBInfo,
    fatigueA: fatigueAInfo,
    fatigueB: fatigueBInfo,
    injuryA: injuryAInfo,
    injuryB: injuryBInfo
  };
  const fallbackInputCount = Object.values(inputQuality).filter((entry) => entry.quality === "fallback").length;
  const predictionEligible = keyStatsMissingBothPlayers.length === 0;

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
    rankA: rankAInfo.value,
    rankB: rankBInfo.value,
    holdA: holdAInfo.value,
    holdB: holdBInfo.value,
    aceA: aceAInfo.value,
    aceB: aceBInfo.value,
    formA: formAInfo.value,
    formB: formBInfo.value,
    weatherFactor: numeric(firstValue(event, [
      "weatherFactor",
      "weather",
      "weather.factor",
      "conditions.weatherFactor",
      "venue.weatherFactor",
      "environment.weatherFactor"
    ]), 0),
    fatigueA: fatigueAInfo.value,
    fatigueB: fatigueBInfo.value,
    injuryA: injuryAInfo.value,
    injuryB: injuryBInfo.value,
    inputQuality,
    missingKeyStats: keyStatsMissingBothPlayers,
    fallbackInputCount,
    predictionEligible
  };
}

function summarizeInputQuality(matches) {
  const missingBothPlayersByStat = { hold: 0, ace: 0, form: 0 };
  let predictionEligibleCount = 0;
  let fallbackInputTotal = 0;

  matches.forEach((match) => {
    if (match.predictionEligible) predictionEligibleCount += 1;
    fallbackInputTotal += Number(match.fallbackInputCount || 0);
    (match.missingKeyStats || []).forEach((stat) => {
      if (stat in missingBothPlayersByStat) missingBothPlayersByStat[stat] += 1;
    });
  });

  return {
    predictionEligibleCount,
    predictionGatedCount: matches.length - predictionEligibleCount,
    averageFallbackInputsPerMatch: matches.length ? Number((fallbackInputTotal / matches.length).toFixed(2)) : 0,
    missingBothPlayersByStat
  };
}

async function fetchDailyTennisSlate(date, options = {}) {
  const [year, month, day] = date.split("-").map(Number);
  const env = readEnvFile();
  const timeZone = env.SLATE_TIME_ZONE || defaultSlateTimeZone;
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

  const dateMatchedEvents = events.filter((event) => eventLocalDate(event, timeZone) === date);
  const usedDateEndpointFallback = !dateMatchedEvents.length && events.length > 0;
  const eventsForDate = usedDateEndpointFallback ? events : dateMatchedEvents;
  const playerStatProfiles = await fetchPlayerStatProfiles(eventsForDate, env, apiSource);
  const partialErrors = [...categoryErrors, ...playerStatProfiles.errors];
  const matches = eventsForDate
    .map((event, index) => normalizeEvent(event, index, playerStatProfiles.profiles))
    .filter(Boolean)
    .sort((a, b) => (
      (levelPriority[a.level] ?? 99) - (levelPriority[b.level] ?? 99)
      || new Date(a.startTime) - new Date(b.startTime)
      || a.tournament.localeCompare(b.tournament)
    ));
  const inputQualitySummary = summarizeInputQuality(matches);

  const payload = {
    source: `AllSportsAPI Tennis live slate (${apiSource.rapidHost})`,
    statFallback: "Per-player live historical pulls when configured, then three-year historical surface/tour averages",
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
    playerStatPullsConfigured: playerStatProfiles.configured,
    playerStatPullsRequested: playerStatProfiles.requestedCount,
    playerStatProfilesLoaded: playerStatProfiles.loadedCount,
    playerStatProviders: playerStatProfiles.providers,
    inputQualitySummary,
    partialErrors,
    matches
  };

  mkdirSync(join(root, "api_cache"), { recursive: true });
  writeFileSync(
    join(root, "api_cache", `raw_allsports_tennis_${date}.json`),
    JSON.stringify({ categories, events, eventsForDate, categoryErrors, playerStatErrors: playerStatProfiles.errors }, null, 2),
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

  async function handlePredictionInputs(primaryId, secondaryId, response) {
    if (!primaryId || !secondaryId) {
      sendJson(response, 400, {
        ok: false,
        error: "Both path IDs are required."
      });
      return;
    }

    try {
      const env = readEnvFile();
      const source = tennisApi5Source(env);
      const path = `/matchstats/${encodeURIComponent(primaryId)}/${encodeURIComponent(secondaryId)}`;
      const payload = await fetchTennisApi5Json(path, source);
      const extracted = extractPredictionSimulationInputs(payload);

      sendJson(response, 200, {
        ok: true,
        source: `Tennis API5 (${source.rapidHost})`,
        path,
        ...extracted
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error.message
      });
    }
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
      generatedAt: payload.generatedAt ?? new Date().toISOString(),
      playerStatPullsConfigured: payload.playerStatPullsConfigured ?? false,
      playerStatPullsRequested: payload.playerStatPullsRequested ?? 0,
      playerStatProfilesLoaded: payload.playerStatProfilesLoaded ?? 0,
      playerStatProviders: payload.playerStatProviders ?? [],
      partialErrorCount: Array.isArray(payload.partialErrors) ? payload.partialErrors.length : 0,
      inputQualitySummary: payload.inputQualitySummary ?? null
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

  const predictionInputPath = url.pathname.match(/^\/api\/prediction-inputs\/([^/]+)\/([^/]+)$/);
  if (predictionInputPath) {
    await handlePredictionInputs(
      decodeURIComponent(predictionInputPath[1]),
      decodeURIComponent(predictionInputPath[2]),
      response
    );
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
