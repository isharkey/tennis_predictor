const METRICS = [
  { key: "winner", label: "Winner", scale: 1, kind: "binary" },
  { key: "totalGames", label: "Games", scale: 10, kind: "number" },
  { key: "tieBreaker", label: "TB", scale: 1, kind: "binary" },
  { key: "sets", label: "Sets", scale: 1.5, kind: "number" },
  { key: "breaks", label: "Breaks", scale: 6, kind: "number" },
  { key: "aces", label: "Aces", scale: 12, kind: "number" }
];

const MODEL_KEYS = ["eloPulse", "serveHold", "surfaceFit", "formCurve", "marketBlend"];
const STORAGE_KEY = "tennis-edge-state-v1";
const APP_ASSET_VERSION = "20260704-slate";
const HISTORY_LIMIT = 140;
const SLATE_REFRESH_CACHE_KEY = "tennis-edge-last-slate-refresh-v1";
const AUTO_SLATE_REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_SIMULATION_RUNS = 100000;
const MIN_SIMULATION_RUNS = 1000;
const MAX_SIMULATION_RUNS = 10000000;
const BULK_MAX_SIMULATION_RUNS = 100000;
const RUN_CHUNK_SIZE = 50000;
const AUTO_LEARNING_CHUNK_SIZE = 12;
const AUTO_LEARNING_RATE = 0.08;
const AUTO_SCORED_LIMIT = 1200;
const LEARNING_EVENT_LIMIT = 90;
const LIVE_REFRESH_MS = 45000;
const MAJOR_US_BOOKS = [
  "DraftKings",
  "FanDuel",
  "BetMGM",
  "Caesars",
  "ESPN BET",
  "Fanatics",
  "BetRivers",
  "Hard Rock"
];

const PARLAY_PROFILES = {
  conservative: {
    label: "Conservative",
    minProbability: 0.62,
    maxRisk: 0.14
  },
  balanced: {
    label: "Balanced",
    minProbability: 0.56,
    maxRisk: 0.22
  },
  aggressive: {
    label: "Aggressive",
    minProbability: 0.51,
    maxRisk: 0.34
  }
};

const LEVEL_PRIORITY = {
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

const DEFAULT_PERFORMANCE = Object.fromEntries(
  MODEL_KEYS.map((modelKey) => [
    modelKey,
    Object.fromEntries(METRICS.map((metric) => [metric.key, 0.58]))
  ])
);

const SAMPLE_MATCHES = [
  {
    playerA: "Aryna Sabalenka",
    playerB: "Iga Swiatek",
    surface: "Clay",
    format: "3",
    rankA: 2,
    rankB: 1,
    holdA: 78.2,
    holdB: 80.5,
    aceA: 5.9,
    aceB: 2.6,
    formA: 81,
    formB: 86,
    weatherFactor: 0,
    fatigueA: 12,
    fatigueB: 18,
    injuryA: 0,
    injuryB: 6
  },
  {
    playerA: "Taylor Fritz",
    playerB: "Daniil Medvedev",
    surface: "Hard",
    format: "3",
    rankA: 8,
    rankB: 7,
    holdA: 87.2,
    holdB: 84.8,
    aceA: 12.9,
    aceB: 8.2,
    formA: 75,
    formB: 72,
    weatherFactor: 1.5,
    fatigueA: 18,
    fatigueB: 22,
    injuryA: 4,
    injuryB: 7
  },
  {
    playerA: "Elena Rybakina",
    playerB: "Coco Gauff",
    surface: "Grass",
    format: "3",
    rankA: 4,
    rankB: 3,
    holdA: 80.4,
    holdB: 76.1,
    aceA: 8.8,
    aceB: 4.3,
    formA: 78,
    formB: 82,
    weatherFactor: -1,
    fatigueA: 15,
    fatigueB: 10,
    injuryA: 5,
    injuryB: 2
  }
];

const MODEL_DEFINITIONS = [
  {
    key: "eloPulse",
    name: "Elo Pulse",
    style: "Ranking and baseline strength",
    bias: 0.02,
    volatility: 0.08,
    project(match, random) {
      const rankEdge = normalizeRankEdge(match.rankA, match.rankB);
      const formEdge = (match.formA - match.formB) / 260;
      const holdEdge = (match.holdA - match.holdB) / 220;
      return projectFromEdges(match, random, {
        winEdge: rankEdge * 0.72 + formEdge + holdEdge,
        paceEdge: holdEdge * 0.75,
        aceEdge: (match.aceA - match.aceB) / 180,
        breakEdge: -holdEdge * 1.2,
        tieEdge: holdEdge * 1.7,
        noise: 0.95
      });
    }
  },
  {
    key: "serveHold",
    name: "Serve Hold",
    style: "Holds, breaks, and aces",
    bias: -0.01,
    volatility: 0.06,
    project(match, random) {
      const holdEdge = (match.holdA - match.holdB) / 145;
      const aceEdge = (match.aceA - match.aceB) / 120;
      return projectFromEdges(match, random, {
        winEdge: holdEdge * 0.95 + aceEdge * 0.2,
        paceEdge: (match.holdA + match.holdB - 168) / 160,
        aceEdge,
        breakEdge: -(match.holdA + match.holdB - 166) / 110,
        tieEdge: (match.holdA + match.holdB - 166) / 75,
        noise: 0.78
      });
    }
  },
  {
    key: "surfaceFit",
    name: "Surface Fit",
    style: "Surface-adjusted pace",
    bias: 0,
    volatility: 0.09,
    project(match, random) {
      const surface = surfaceProfile(match.surface);
      const holdEdge = (match.holdA - match.holdB) / 190;
      const aceEdge = (match.aceA - match.aceB) / 130;
      return projectFromEdges(match, random, {
        winEdge: holdEdge * surface.holdWeight + aceEdge * surface.aceWeight,
        paceEdge: surface.pace + (match.holdA + match.holdB - 170) / 185,
        aceEdge: aceEdge + surface.aceLift,
        breakEdge: surface.breakLift - holdEdge,
        tieEdge: surface.tieLift + (match.holdA + match.holdB - 170) / 95,
        noise: 1.03
      });
    }
  },
  {
    key: "formCurve",
    name: "Form Curve",
    style: "Recent level and fatigue proxy",
    bias: 0.01,
    volatility: 0.11,
    project(match, random) {
      const formEdge = (match.formA - match.formB) / 150;
      const rankEdge = normalizeRankEdge(match.rankA, match.rankB);
      return projectFromEdges(match, random, {
        winEdge: formEdge * 0.78 + rankEdge * 0.28,
        paceEdge: -Math.abs(match.formA - match.formB) / 340,
        aceEdge: (match.aceA - match.aceB) / 190,
        breakEdge: Math.abs(match.formA - match.formB) / 130,
        tieEdge: -Math.abs(match.formA - match.formB) / 150,
        noise: 1.18
      });
    }
  },
  {
    key: "marketBlend",
    name: "Market Blend",
    style: "Conservative consensus",
    bias: 0,
    volatility: 0.045,
    project(match, random) {
      const rankEdge = normalizeRankEdge(match.rankA, match.rankB);
      const holdEdge = (match.holdA - match.holdB) / 240;
      const formEdge = (match.formA - match.formB) / 290;
      return projectFromEdges(match, random, {
        winEdge: rankEdge * 0.46 + holdEdge * 0.34 + formEdge * 0.28,
        paceEdge: (match.holdA + match.holdB - 168) / 260,
        aceEdge: (match.aceA - match.aceB) / 230,
        breakEdge: -(match.holdA + match.holdB - 168) / 170,
        tieEdge: (match.holdA + match.holdB - 168) / 135,
        noise: 0.62
      });
    }
  }
];

let state = loadState();
let latestRun = null;
let runRequestId = 0;
let runInProgress = false;
let preloadedMatches = [];
let oddsMarkets = [];
let oddsMeta = {
  source: "No sportsbook odds loaded",
  generatedAt: null
};
let oddsRunCache = new Map();
let selectedMatchId = null;
let collapsedTournamentKeys = new Set();
let autoLearningInProgress = false;
let autoLearningMessage = "";
let liveRefreshTimer = null;
let matchSlateMeta = {
  source: "Built-in sample slate",
  generatedAt: null,
  count: 0
};

document.addEventListener("DOMContentLoaded", () => {
  bindControls();
  setDefaultSlateDate();
  preloadedMatches = normalizePreloadedMatches(SAMPLE_MATCHES);
  applyLearnedProfilesToPreloadedMatches();
  selectFirstLoadedMatch(false);
  renderMatchBoard();
  runEnsemble();
  renderLearning();
  renderHistory();
  renderParlays();
  renderPlayerData();
  renderLiveBoard();
  renderOddsBoard();
  renderGraphs();
  loadPreloadedMatches().finally(autoRefreshCurrentSlate);
  loadOddsBoard();
  registerServiceWorker();
});

function bindControls() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });

  document.getElementById("run-button").addEventListener("click", runEnsemble);
  document.getElementById("sample-button").addEventListener("click", loadSampleMatch);
  document.getElementById("metric-view").addEventListener("change", renderModels);
  document.getElementById("live-refresh").addEventListener("click", refreshLiveSlate);
  document.getElementById("live-auto-refresh").addEventListener("change", toggleLiveAutoRefresh);
  document.getElementById("odds-book-filter").addEventListener("change", renderOddsBoard);
  document.getElementById("odds-min-edge").addEventListener("change", renderOddsBoard);
  document.getElementById("odds-refresh").addEventListener("click", loadOddsBoard);
  document.getElementById("parlay-profile").addEventListener("change", renderParlays);
  document.getElementById("parlay-leg-count").addEventListener("change", renderParlays);
  document.getElementById("player-search").addEventListener("input", renderPlayerData);
  document.getElementById("player-sort").addEventListener("change", renderPlayerData);
  document.getElementById("match-sort").addEventListener("change", renderMatchBoard);
  document.getElementById("match-tour-filter").addEventListener("change", renderMatchBoard);
  document.getElementById("match-level-filter").addEventListener("change", renderMatchBoard);
  document.getElementById("match-search").addEventListener("input", renderMatchBoard);
  document.getElementById("reload-slate").addEventListener("click", refreshLiveSlate);
  document.getElementById("match-board-list").addEventListener("click", handleMatchBoardClick);
  document.getElementById("player-data-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-player-match-id]");
    if (button) selectPreloadedMatch(button.dataset.playerMatchId);
  });
  document.getElementById("save-result").addEventListener("click", saveActualResult);
  document.getElementById("clear-history").addEventListener("click", clearHistory);
  document.getElementById("reset-demo").addEventListener("click", resetLearning);
  document.getElementById("simulations").addEventListener("input", handleSimulationRunsInput);

  document.querySelectorAll("#match-form input, #match-form select, #simulations").forEach((control) => {
    control.addEventListener("change", runOrQueueEnsemble);
  });
}

function handleSimulationRunsInput() {
  const rawRuns = Number(document.getElementById("simulations")?.value);
  if (!Number.isFinite(rawRuns) || rawRuns <= BULK_MAX_SIMULATION_RUNS) return;

  const roundedRuns = Math.round(rawRuns / 1000) * 1000;
  const runs = clamp(roundedRuns || DEFAULT_SIMULATION_RUNS, MIN_SIMULATION_RUNS, MAX_SIMULATION_RUNS);
  queueHighRun(runs);
}

function handleMatchBoardClick(event) {
  const toggleButton = event.target.closest("[data-tournament-toggle]");
  if (toggleButton) {
    toggleTournamentGroup(toggleButton.dataset.tournamentToggle);
    return;
  }

  const matchButton = event.target.closest("[data-match-id]");
  if (matchButton) selectPreloadedMatch(matchButton.dataset.matchId);
}

function activateTab(tabName) {
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${tabName}-tab`);
  });
}

function setDefaultSlateDate() {
  const input = document.getElementById("slate-date");
  if (!input || input.value) return;

  input.value = currentSlateDate();
}

function currentSlateDate() {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

async function autoRefreshCurrentSlate() {
  const today = currentSlateDate();
  const input = document.getElementById("slate-date");
  if (input) input.value = today;

  const staleDate = matchSlateMeta.date !== today;
  const generatedAtTime = new Date(matchSlateMeta.generatedAt || "").getTime();
  const staleGeneratedAt = !Number.isFinite(generatedAtTime) || Date.now() - generatedAtTime > AUTO_SLATE_REFRESH_MS;
  if (!staleDate && (!staleGeneratedAt || recentlyAutoRefreshedSlate(today))) return;

  await refreshLiveSlate({ auto: true });
}

function recentlyAutoRefreshedSlate(date) {
  try {
    const saved = JSON.parse(localStorage.getItem(SLATE_REFRESH_CACHE_KEY) || "{}");
    return saved.date === date && Date.now() - Number(saved.refreshedAt || 0) < AUTO_SLATE_REFRESH_MS;
  } catch {
    return false;
  }
}

function rememberAutoRefreshedSlate(date) {
  localStorage.setItem(SLATE_REFRESH_CACHE_KEY, JSON.stringify({
    date,
    refreshedAt: Date.now()
  }));
}

async function refreshLiveSlate(options = {}) {
  const button = document.getElementById("reload-slate");
  const meta = document.getElementById("match-board-meta");
  const date = document.getElementById("slate-date")?.value || currentSlateDate();
  const originalText = button?.textContent || "Refresh Live";
  const isAuto = Boolean(options.auto);

  if (button) {
    button.disabled = true;
    button.textContent = isAuto ? "Checking" : "Refreshing";
  }
  if (meta) meta.textContent = isAuto ? `Checking today's tennis slate for ${date}` : `Pulling full tennis slate for ${date}`;

  try {
    const response = await fetch(`/api/refresh-slate?date=${encodeURIComponent(date)}`, {
      cache: "no-store"
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Refresh failed with status ${response.status}`);
    }

    await loadPreloadedMatches(true);
    if (isAuto) rememberAutoRefreshedSlate(date);
    if (meta) {
      const profileStatus = result.playerStatPullsConfigured
        ? ` - profiles ${result.playerStatProfilesLoaded}/${result.playerStatPullsRequested}`
        : " - profiles disabled";
      const errorStatus = Number(result.partialErrorCount) > 0 ? ` - ${result.partialErrorCount} pull errors` : "";
      const gated = Number(result.inputQualitySummary?.predictionGatedCount ?? 0);
      const qualityStatus = result.inputQualitySummary ? ` - gated ${gated}` : "";
      meta.textContent = `${result.source} - ${result.count} total${profileStatus}${qualityStatus}${errorStatus} - updated ${formatSlateDate(result.generatedAt)}`;
    }
  } catch (error) {
    await loadPreloadedMatches(true);
    if (meta) meta.textContent = `Live refresh failed: ${error.message}`;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function loadPreloadedMatches(forceReload = false) {
  try {
    const response = await fetch(`matches_preload.json?v=${APP_ASSET_VERSION}`, { cache: "no-store" });
    if (!response.ok) return;

    const payload = await response.json();
    const loaded = normalizePreloadedMatches(extractMatchesFromPayload(payload));
    if (!loaded.length) return;

    preloadedMatches = loaded;
    applyLearnedProfilesToPreloadedMatches();
    oddsRunCache = new Map();
    matchSlateMeta = extractMetaFromPayload(payload, loaded.length);
    if (!selectedMatchId || !preloadedMatches.some((match) => match.id === selectedMatchId)) {
      selectFirstLoadedMatch(false);
      runOrQueueEnsemble();
    } else if (forceReload) {
      renderMatchBoard();
      renderPlayerData();
      runOrQueueEnsemble();
    }
    renderMatchBoard();
    renderPlayerData();
    renderLiveBoard();
    renderOddsBoard();
    scheduleAutoLearning();
  } catch {
    renderMatchBoard();
    renderPlayerData();
    renderLiveBoard();
    renderOddsBoard();
  }
}

async function loadOddsBoard() {
  const status = document.getElementById("odds-status");

  try {
    const response = await fetch(`odds_preload.json?v=${APP_ASSET_VERSION}`, { cache: "no-store" });
    if (!response.ok) throw new Error("No local sportsbook board found.");

    const payload = await response.json();
    oddsMarkets = normalizeOddsPayload(payload);
    oddsMeta = {
      source: payload?.source || "Local sportsbook board",
      generatedAt: payload?.generatedAt || payload?.generated_at || null
    };
    if (status) {
      status.textContent = `${oddsMeta.source} - ${oddsMarkets.length} markets${oddsMeta.generatedAt ? ` - updated ${formatSlateDate(oddsMeta.generatedAt)}` : ""}`;
    }
  } catch (error) {
    oddsMarkets = [];
    oddsMeta = {
      source: "No sportsbook odds loaded",
      generatedAt: null
    };
    if (status) status.textContent = error.message;
  }

  renderOddsBoard();
}

function toggleLiveAutoRefresh(event) {
  if (liveRefreshTimer) {
    window.clearInterval(liveRefreshTimer);
    liveRefreshTimer = null;
  }

  if (event.target.checked) {
    liveRefreshTimer = window.setInterval(refreshLiveSlate, LIVE_REFRESH_MS);
  }
}

function extractMatchesFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function extractMetaFromPayload(payload, count) {
  if (Array.isArray(payload)) {
    return {
      source: "Local preloaded JSON",
      generatedAt: null,
      date: null,
      count
    };
  }

  return {
    source: payload?.source || "Preloaded JSON",
    generatedAt: payload?.generatedAt || payload?.generated_at || null,
    date: payload?.date || payload?.slateDate || null,
    count: payload?.count || count
  };
}

function normalizePreloadedMatches(matches) {
  return (Array.isArray(matches) ? matches : []).map((match, index) => {
    const playerA = String(match.playerA || `Player A ${index + 1}`);
    const playerB = String(match.playerB || `Player B ${index + 1}`);
    const startTime = match.startTime || new Date(Date.now() + index * 60 * 60 * 1000).toISOString();
    const statusType = String(match.statusType || match.status?.type || match.status || "scheduled").toLowerCase();
    const live = Boolean(match.live || match.liveState?.isLive || ["inprogress", "in_progress", "live"].includes(statusType));
    const completed = Boolean(match.completed || match.liveState?.isCompleted || ["finished", "ended", "complete", "completed"].includes(statusType));
    const winnerSide = normalizeWinnerSide(match.winnerSide || match.actual?.winner || match.winner);
    const actual = normalizeActualResult(match.actual || match.result || {}, winnerSide);
    const liveState = normalizeLiveState(match.liveState || match.live || {}, live, completed);

    const normalized = {
      id: match.id || `${slugify(playerA)}-${slugify(playerB)}-${index}`,
      tournament: match.tournament || "Loaded Matches",
      level: match.level || "ATP 250",
      tour: match.tour || "ATP",
      round: match.round || "Match",
      court: match.court || "",
      startTime,
      statusType,
      statusDescription: match.statusDescription || match.status?.description || (completed ? "Finished" : "Scheduled"),
      live,
      completed,
      liveState,
      winnerSide,
      scoreline: match.scoreline || actual.scoreline || "",
      actual,
      playerA,
      playerB,
      surface: match.surface || "Hard",
      format: String(match.format || 3),
      rankA: Number(match.rankA ?? 50),
      rankB: Number(match.rankB ?? 50),
      holdA: Number(match.holdA ?? 80),
      holdB: Number(match.holdB ?? 80),
      aceA: Number(match.aceA ?? 6),
      aceB: Number(match.aceB ?? 6),
      formA: Number(match.formA ?? 70),
      formB: Number(match.formB ?? 70),
      weatherFactor: Number(match.weatherFactor ?? 0),
      fatigueA: Number(match.fatigueA ?? 0),
      fatigueB: Number(match.fatigueB ?? 0),
      injuryA: Number(match.injuryA ?? 0),
      injuryB: Number(match.injuryB ?? 0),
      inputQuality: match.inputQuality || null,
      missingKeyStats: Array.isArray(match.missingKeyStats) ? match.missingKeyStats : [],
      fallbackInputCount: Number(match.fallbackInputCount ?? 0),
      predictionEligible: match.predictionEligible !== false
    };
    normalized.baseStats = {
      rankA: normalized.rankA,
      rankB: normalized.rankB,
      holdA: normalized.holdA,
      holdB: normalized.holdB,
      aceA: normalized.aceA,
      aceB: normalized.aceB,
      formA: normalized.formA,
      formB: normalized.formB,
      fatigueA: normalized.fatigueA,
      fatigueB: normalized.fatigueB,
      injuryA: normalized.injuryA,
      injuryB: normalized.injuryB
    };
    return normalized;
  });
}

function playerProfileKey(name) {
  return String(name || "").trim().toLowerCase();
}

function usableHistoryMetric(match, key, fallbackValue) {
  const value = Number(match?.[key]);
  if (!Number.isFinite(value)) return false;

  const quality = match?.inputQuality?.[key]?.quality;
  if (quality === "fallback") return false;
  if (quality === "direct" || quality === "derived") return true;
  return value !== fallbackValue;
}

function needsLearnedMetric(match, key, fallbackValue) {
  const value = Number(match?.[key]);
  const quality = match?.inputQuality?.[key]?.quality;
  if (!Number.isFinite(value)) return true;
  if (quality === "fallback") return true;
  if (quality === "direct" || quality === "derived") return false;
  return value === fallbackValue;
}

function averagePair(total, count, fallback) {
  return count ? total / count : fallback;
}

function playerLearningProfileFromHistory(history) {
  const profiles = new Map();
  const metricFallbacks = {
    rank: 50,
    hold: 80,
    ace: 6,
    form: 70,
    fatigue: 0,
    injury: 0
  };

  function ensureProfile(name) {
    const key = playerProfileKey(name);
    if (!key) return null;
    if (!profiles.has(key)) {
      profiles.set(key, {
        name,
        rankTotal: 0,
        rankCount: 0,
        holdTotal: 0,
        holdCount: 0,
        aceTotal: 0,
        aceCount: 0,
        formTotal: 0,
        formCount: 0,
        fatigueTotal: 0,
        fatigueCount: 0,
        injuryTotal: 0,
        injuryCount: 0,
        wins: 0,
        played: 0
      });
    }
    return profiles.get(key);
  }

  (Array.isArray(history) ? history : []).forEach((entry) => {
    const match = entry?.match;
    if (!match?.playerA || !match?.playerB) return;

    const players = [
      {
        profile: ensureProfile(match.playerA),
        winnerCode: "A",
        rankKey: "rankA",
        holdKey: "holdA",
        aceKey: "aceA",
        formKey: "formA",
        fatigueKey: "fatigueA",
        injuryKey: "injuryA"
      },
      {
        profile: ensureProfile(match.playerB),
        winnerCode: "B",
        rankKey: "rankB",
        holdKey: "holdB",
        aceKey: "aceB",
        formKey: "formB",
        fatigueKey: "fatigueB",
        injuryKey: "injuryB"
      }
    ];

    players.forEach((player) => {
      const profile = player.profile;
      if (!profile) return;

      if (usableHistoryMetric(match, player.rankKey, metricFallbacks.rank)) {
        profile.rankTotal += Number(match[player.rankKey]);
        profile.rankCount += 1;
      }
      if (usableHistoryMetric(match, player.holdKey, metricFallbacks.hold)) {
        profile.holdTotal += Number(match[player.holdKey]);
        profile.holdCount += 1;
      }
      if (usableHistoryMetric(match, player.aceKey, metricFallbacks.ace)) {
        profile.aceTotal += Number(match[player.aceKey]);
        profile.aceCount += 1;
      }
      if (usableHistoryMetric(match, player.formKey, metricFallbacks.form)) {
        profile.formTotal += Number(match[player.formKey]);
        profile.formCount += 1;
      }
      if (usableHistoryMetric(match, player.fatigueKey, metricFallbacks.fatigue)) {
        profile.fatigueTotal += Number(match[player.fatigueKey]);
        profile.fatigueCount += 1;
      }
      if (usableHistoryMetric(match, player.injuryKey, metricFallbacks.injury)) {
        profile.injuryTotal += Number(match[player.injuryKey]);
        profile.injuryCount += 1;
      }

      const winner = entry?.actual?.winner;
      if (winner === "A" || winner === "B") {
        profile.played += 1;
        if (winner === player.winnerCode) profile.wins += 1;
      }
    });
  });

  const learned = new Map();
  profiles.forEach((profile, key) => {
    const winRateForm = profile.played ? (profile.wins / profile.played) * 100 : null;
    const historicalForm = averagePair(profile.formTotal, profile.formCount, null);
    const blendedForm = Number.isFinite(historicalForm) && Number.isFinite(winRateForm)
      ? historicalForm * 0.6 + winRateForm * 0.4
      : (Number.isFinite(historicalForm) ? historicalForm : winRateForm);

    learned.set(key, {
      rank: averagePair(profile.rankTotal, profile.rankCount, null),
      hold: averagePair(profile.holdTotal, profile.holdCount, null),
      ace: averagePair(profile.aceTotal, profile.aceCount, null),
      form: Number.isFinite(blendedForm) ? blendedForm : null,
      fatigue: averagePair(profile.fatigueTotal, profile.fatigueCount, null),
      injury: averagePair(profile.injuryTotal, profile.injuryCount, null)
    });
  });

  return learned;
}

function applyLearnedProfilesToPreloadedMatches() {
  const learnedProfiles = playerLearningProfileFromHistory(state.history || []);
  let changed = false;

  preloadedMatches = preloadedMatches.map((match) => {
    const baseStats = match.baseStats || {
      rankA: Number(match.rankA ?? 50),
      rankB: Number(match.rankB ?? 50),
      holdA: Number(match.holdA ?? 80),
      holdB: Number(match.holdB ?? 80),
      aceA: Number(match.aceA ?? 6),
      aceB: Number(match.aceB ?? 6),
      formA: Number(match.formA ?? 70),
      formB: Number(match.formB ?? 70),
      fatigueA: Number(match.fatigueA ?? 0),
      fatigueB: Number(match.fatigueB ?? 0),
      injuryA: Number(match.injuryA ?? 0),
      injuryB: Number(match.injuryB ?? 0)
    };
    const next = { ...match, ...baseStats, baseStats };

    const sideConfigs = [
      {
        profile: learnedProfiles.get(playerProfileKey(match.playerA)),
        rankKey: "rankA",
        holdKey: "holdA",
        aceKey: "aceA",
        formKey: "formA",
        fatigueKey: "fatigueA",
        injuryKey: "injuryA"
      },
      {
        profile: learnedProfiles.get(playerProfileKey(match.playerB)),
        rankKey: "rankB",
        holdKey: "holdB",
        aceKey: "aceB",
        formKey: "formB",
        fatigueKey: "fatigueB",
        injuryKey: "injuryB"
      }
    ];

    sideConfigs.forEach((side) => {
      if (!side.profile || match.completed) return;

      if (needsLearnedMetric(next, side.rankKey, 50) && Number.isFinite(side.profile.rank)) next[side.rankKey] = side.profile.rank;
      if (needsLearnedMetric(next, side.holdKey, 80) && Number.isFinite(side.profile.hold)) next[side.holdKey] = side.profile.hold;
      if (needsLearnedMetric(next, side.aceKey, 6) && Number.isFinite(side.profile.ace)) next[side.aceKey] = side.profile.ace;
      if (needsLearnedMetric(next, side.formKey, 70) && Number.isFinite(side.profile.form)) next[side.formKey] = side.profile.form;
      if (needsLearnedMetric(next, side.fatigueKey, 0) && Number.isFinite(side.profile.fatigue)) next[side.fatigueKey] = side.profile.fatigue;
      if (needsLearnedMetric(next, side.injuryKey, 0) && Number.isFinite(side.profile.injury)) next[side.injuryKey] = side.profile.injury;
    });

    const changedForMatch = [
      "rankA", "rankB", "holdA", "holdB", "aceA", "aceB",
      "formA", "formB", "fatigueA", "fatigueB", "injuryA", "injuryB"
    ].some((key) => Number(next[key]) !== Number(match[key]));
    if (changedForMatch) changed = true;
    return next;
  });

  const selected = preloadedMatches.find((match) => match.id === selectedMatchId);
  if (selected) loadMatchIntoForm(selected);
  if (changed) oddsRunCache = new Map();
}

function normalizeWinnerSide(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["a", "1", "home", "player a", "team1", "team 1"].includes(text)) return "A";
  if (["b", "2", "away", "player b", "team2", "team 2"].includes(text)) return "B";
  return "";
}

function normalizeActualResult(actual, winnerSide = "") {
  const result = {};
  const winner = normalizeWinnerSide(actual?.winner || winnerSide);
  if (winner) result.winner = winner;

  const totalGames = finiteNumber(actual?.totalGames);
  if (totalGames !== null) result.totalGames = totalGames;

  const setsPlayed = finiteNumber(actual?.setsPlayed ?? actual?.sets);
  if (setsPlayed !== null) result.sets = setsPlayed;

  if (typeof actual?.tieBreaker === "boolean") {
    result.tieBreaker = actual.tieBreaker;
  }

  const breaks = finiteNumber(actual?.breaks);
  if (breaks !== null) result.breaks = breaks;

  const aces = finiteNumber(actual?.aces);
  if (aces !== null) result.aces = aces;

  if (actual?.scoreline) result.scoreline = String(actual.scoreline);
  return result;
}

function normalizeLiveState(liveState, live, completed) {
  const sets = Array.isArray(liveState?.sets)
    ? liveState.sets.map((set, index) => ({
      set: Number(set.set ?? index + 1),
      a: Number(set.a ?? 0),
      b: Number(set.b ?? 0),
      tieBreakA: finiteNumber(set.tieBreakA),
      tieBreakB: finiteNumber(set.tieBreakB)
    }))
    : [];

  return {
    isLive: Boolean(live),
    isCompleted: Boolean(completed),
    status: liveState?.status || "",
    currentPeriod: liveState?.currentPeriod || "",
    pointA: liveState?.pointA !== undefined ? String(liveState.pointA) : "",
    pointB: liveState?.pointB !== undefined ? String(liveState.pointB) : "",
    setsA: finiteNumber(liveState?.setsA),
    setsB: finiteNumber(liveState?.setsB),
    firstToServe: finiteNumber(liveState?.firstToServe),
    currentPeriodStartTimestamp: finiteNumber(liveState?.currentPeriodStartTimestamp),
    sets,
    scoreline: liveState?.scoreline || sets.map((set) => `${set.a}-${set.b}`).join(" ")
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function selectFirstLoadedMatch(shouldRun = true) {
  const first = getSortedMatches()[0] ?? preloadedMatches[0];
  if (first) selectPreloadedMatch(first.id, shouldRun);
}

function selectPreloadedMatch(matchId, shouldRun = true) {
  const match = preloadedMatches.find((item) => item.id === matchId);
  if (!match) return;

  selectedMatchId = match.id;
  loadMatchIntoForm(match);
  renderMatchBoard();
  renderPlayerData();
  renderLiveBoard();
  renderOddsBoard();
  if (shouldRun) runOrQueueEnsemble();
}

function loadMatchIntoForm(match) {
  setFormValue("player-a", match.playerA);
  setFormValue("player-b", match.playerB);
  setFormValue("surface", match.surface);
  setFormValue("format", match.format);
  setFormValue("rank-a", match.rankA);
  setFormValue("rank-b", match.rankB);
  setFormValue("hold-a", match.holdA);
  setFormValue("hold-b", match.holdB);
  setFormValue("ace-a", match.aceA);
  setFormValue("ace-b", match.aceB);
  setFormValue("form-a", match.formA);
  setFormValue("form-b", match.formB);
  setFormValue("weather-factor", match.weatherFactor);
  setFormValue("fatigue-a", match.fatigueA);
  setFormValue("fatigue-b", match.fatigueB);
  setFormValue("injury-a", match.injuryA);
  setFormValue("injury-b", match.injuryB);
}

function renderMatchBoard() {
  const list = document.getElementById("match-board-list");
  const count = document.getElementById("match-board-count");
  const meta = document.getElementById("match-board-meta");
  if (!list || !count || !meta) return;

  const matches = getSortedMatches();
  count.textContent = `${matches.length} loaded`;
  meta.textContent = slateMetaText(matches.length);

  if (!matches.length) {
    list.innerHTML = `<div class="empty-state">No loaded matches match these filters.</div>`;
    return;
  }

  const grouped = groupMatchesByTournament(matches);
  list.innerHTML = grouped.map((group) => {
    const collapsed = collapsedTournamentKeys.has(group.key);
    const panelId = `tournament-${group.key}`;
    return `
    <section class="tournament-group ${collapsed ? "collapsed" : ""}">
      <button class="tournament-head" type="button" data-tournament-toggle="${escapeHtml(group.key)}" aria-expanded="${collapsed ? "false" : "true"}" aria-controls="${escapeHtml(panelId)}">
        <div>
          <div class="tournament-title">${escapeHtml(group.tournament)}</div>
          <div class="model-meta">${escapeHtml(group.level)} - ${escapeHtml(group.tour)} - ${group.matches.length} ${group.matches.length === 1 ? "match" : "matches"}</div>
        </div>
        <span class="tournament-head-actions">
          <span class="pill">${formatMatchTime(group.matches[0].startTime)}</span>
          <span class="tournament-toggle-icon" aria-hidden="true">${collapsed ? "+" : "-"}</span>
        </span>
      </button>
      <div class="tournament-matches" id="${escapeHtml(panelId)}" ${collapsed ? "hidden" : ""}>
        ${group.matches.map(renderMatchRow).join("")}
      </div>
    </section>
  `;
  }).join("");
}

function toggleTournamentGroup(key) {
  if (!key) return;
  if (collapsedTournamentKeys.has(key)) {
    collapsedTournamentKeys.delete(key);
  } else {
    collapsedTournamentKeys.add(key);
  }
  renderMatchBoard();
}

function slateMetaText(visibleCount) {
  const source = matchSlateMeta.source || "Local slate";
  const total = matchSlateMeta.count || preloadedMatches.length;
  const finals = preloadedMatches.filter((match) => match.completed).length;
  const slateDate = matchSlateMeta.date ? ` - slate ${matchSlateMeta.date}` : "";
  const generated = matchSlateMeta.generatedAt ? ` - updated ${formatSlateDate(matchSlateMeta.generatedAt)}` : "";
  const filtered = visibleCount === total ? "" : ` - ${visibleCount} shown`;
  const finished = finals ? ` - ${finals} finals` : "";
  return `${source}${slateDate}${generated} - ${total} total${finished}${filtered}`;
}

function renderPlayerData() {
  const selectedCards = document.getElementById("selected-player-cards");
  const selectedMeta = document.getElementById("selected-player-meta");
  const playerList = document.getElementById("player-data-list");
  const playerCount = document.getElementById("player-count");
  if (!selectedCards || !selectedMeta || !playerList || !playerCount) return;

  const catalog = buildPlayerCatalog();
  const players = Array.from(catalog.values());
  const selectedMatch = preloadedMatches.find((match) => match.id === selectedMatchId) ?? preloadedMatches[0];

  if (!players.length) {
    selectedCards.innerHTML = `<div class="empty-state">Load matches to see player data.</div>`;
    playerList.innerHTML = "";
    playerCount.textContent = "0 players";
    selectedMeta.textContent = "-";
    return;
  }

  if (selectedMatch) {
    selectedMeta.textContent = `${selectedMatch.tournament} - ${formatMatchTime(selectedMatch.startTime)} - ${selectedMatch.surface}`;
    selectedCards.innerHTML = ["A", "B"].map((side) => {
      const appearance = playerAppearance(selectedMatch, side);
      const record = catalog.get(appearance.name) ?? playerRecordFromAppearance(appearance);
      return renderSelectedPlayerCard(record, appearance);
    }).join("");
  } else {
    selectedCards.innerHTML = `<div class="empty-state">Select a match to see both player profiles.</div>`;
    selectedMeta.textContent = "-";
  }

  const visiblePlayers = filterAndSortPlayers(players);
  playerCount.textContent = `${visiblePlayers.length} players`;
  playerList.innerHTML = visiblePlayers.length
    ? visiblePlayers.map(renderPlayerRow).join("")
    : `<div class="empty-state">No players match that search.</div>`;
}

function buildPlayerCatalog() {
  const catalog = new Map();

  preloadedMatches.forEach((match) => {
    ["A", "B"].forEach((side) => {
      const appearance = playerAppearance(match, side);
      if (!catalog.has(appearance.name)) {
        catalog.set(appearance.name, playerRecordFromAppearance(appearance));
      } else {
        addAppearanceToPlayerRecord(catalog.get(appearance.name), appearance);
      }
    });
  });

  return catalog;
}

function playerAppearance(match, side) {
  const isA = side === "A";
  return {
    name: isA ? match.playerA : match.playerB,
    opponent: isA ? match.playerB : match.playerA,
    side,
    matchId: match.id,
    tournament: match.tournament,
    level: match.level,
    tour: match.tour,
    round: match.round,
    court: match.court,
    startTime: match.startTime,
    surface: match.surface,
    format: match.format,
    rank: isA ? match.rankA : match.rankB,
    opponentRank: isA ? match.rankB : match.rankA,
    hold: isA ? match.holdA : match.holdB,
    opponentHold: isA ? match.holdB : match.holdA,
    ace: isA ? match.aceA : match.aceB,
    opponentAce: isA ? match.aceB : match.aceA,
    form: isA ? match.formA : match.formB,
    opponentForm: isA ? match.formB : match.formA,
    fatigue: isA ? match.fatigueA : match.fatigueB,
    opponentFatigue: isA ? match.fatigueB : match.fatigueA,
    injury: isA ? match.injuryA : match.injuryB,
    opponentInjury: isA ? match.injuryB : match.injuryA,
    weatherFactor: match.weatherFactor
  };
}

function playerRecordFromAppearance(appearance) {
  const record = {
    name: appearance.name,
    appearances: [],
    tournaments: new Set(),
    levels: new Set(),
    tours: new Set(),
    surfaces: new Set()
  };
  addAppearanceToPlayerRecord(record, appearance);
  return record;
}

function addAppearanceToPlayerRecord(record, appearance) {
  record.appearances.push(appearance);
  record.tournaments.add(appearance.tournament);
  record.levels.add(appearance.level);
  record.tours.add(appearance.tour);
  record.surfaces.add(appearance.surface);
  record.bestRank = minNumber(record.bestRank, appearance.rank);
  record.averageHold = averageAppearanceMetric(record.appearances, "hold");
  record.averageAce = averageAppearanceMetric(record.appearances, "ace");
  record.averageForm = averageAppearanceMetric(record.appearances, "form");
  record.averageFatigue = averageAppearanceMetric(record.appearances, "fatigue");
  record.averageInjury = averageAppearanceMetric(record.appearances, "injury");
  record.nextAppearance = nextAppearance(record.appearances);
}

function filterAndSortPlayers(players) {
  const search = (document.getElementById("player-search")?.value ?? "").trim().toLowerCase();
  const sortBy = document.getElementById("player-sort")?.value ?? "rank";

  return players
    .filter((player) => {
      if (!search) return true;
      const haystack = [
        player.name,
        ...player.tournaments,
        ...player.levels,
        ...player.tours,
        ...player.surfaces,
        player.nextAppearance?.opponent ?? ""
      ].join(" ").toLowerCase();
      return haystack.includes(search);
    })
    .sort((a, b) => comparePlayers(a, b, sortBy));
}

function comparePlayers(a, b, sortBy) {
  if (sortBy === "name") return a.name.localeCompare(b.name);
  if (sortBy === "form") return b.averageForm - a.averageForm || a.name.localeCompare(b.name);
  if (sortBy === "hold") return b.averageHold - a.averageHold || a.name.localeCompare(b.name);
  if (sortBy === "next") {
    return new Date(a.nextAppearance?.startTime ?? 0) - new Date(b.nextAppearance?.startTime ?? 0);
  }
  return (a.bestRank ?? 9999) - (b.bestRank ?? 9999) || a.name.localeCompare(b.name);
}

function renderSelectedPlayerCard(record, appearance) {
  return `
    <article class="player-card">
      <div class="player-card-head">
        <div>
          <div class="player-name">${escapeHtml(record.name)}</div>
          <div class="model-meta">vs ${escapeHtml(appearance.opponent)} - ${escapeHtml(appearance.round)}</div>
        </div>
        <span class="pill">Rank ${formatMissing(appearance.rank)}</span>
      </div>
      <div class="player-stat-grid">
        ${playerStat("Hold", `${round(appearance.hold, 1)}%`)}
        ${playerStat("Ace", `${round(appearance.ace, 1)}%`)}
        ${playerStat("Form", round(appearance.form, 0))}
        ${playerStat("Fatigue", round(appearance.fatigue, 0))}
        ${playerStat("Injury", round(appearance.injury, 0))}
        ${playerStat("Surface", appearance.surface)}
        ${playerStat("Level", appearance.level)}
        ${playerStat("Tour", appearance.tour)}
      </div>
      <div class="player-raw">
        <span>All loaded appearances: ${record.appearances.length}</span>
        <span>Tournaments: ${escapeHtml(Array.from(record.tournaments).join(", "))}</span>
      </div>
    </article>
  `;
}

function renderPlayerRow(record) {
  const next = record.nextAppearance;
  const source = `${Array.from(record.tours).join("/")} - ${Array.from(record.levels).join(", ")}`;
  return `
    <button class="player-row" type="button" data-player-match-id="${escapeHtml(next?.matchId ?? "")}">
      <span>
        <span class="player-name">${escapeHtml(record.name)}</span>
        <span class="model-meta">${escapeHtml(source)} - ${record.appearances.length} loaded ${record.appearances.length === 1 ? "match" : "matches"}</span>
      </span>
      <span class="player-row-stats">
        <span>Rank ${formatMissing(record.bestRank)}</span>
        <span>Hold ${round(record.averageHold, 1)}%</span>
        <span>Ace ${round(record.averageAce, 1)}%</span>
        <span>Form ${round(record.averageForm, 0)}</span>
      </span>
      <span class="player-next">
        ${next ? `${formatMatchTime(next.startTime)} vs ${escapeHtml(next.opponent)}` : "No match"}
      </span>
    </button>
  `;
}

function playerStat(label, value) {
  return `
    <span>
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `;
}

function averageAppearanceMetric(appearances, key) {
  if (!appearances.length) return 0;
  return appearances.reduce((sum, appearance) => sum + Number(appearance[key] ?? 0), 0) / appearances.length;
}

function nextAppearance(appearances) {
  return [...appearances].sort((a, b) => new Date(a.startTime) - new Date(b.startTime))[0] ?? null;
}

function minNumber(current, next) {
  if (!Number.isFinite(Number(current))) return Number(next);
  if (!Number.isFinite(Number(next))) return Number(current);
  return Math.min(Number(current), Number(next));
}

function formatMissing(value) {
  return Number.isFinite(Number(value)) ? String(value) : "-";
}

function getSortedMatches() {
  const sortBy = document.getElementById("match-sort")?.value ?? "level";
  const tourFilter = document.getElementById("match-tour-filter")?.value ?? "all";
  const levelFilter = document.getElementById("match-level-filter")?.value ?? "all";
  const search = (document.getElementById("match-search")?.value ?? "").trim().toLowerCase();

  return preloadedMatches
    .filter((match) => tourFilter === "all" || match.tour === tourFilter)
    .filter((match) => levelFilter === "all" || match.level === levelFilter)
    .filter((match) => {
      if (!search) return true;
      const haystack = [
        match.tournament,
        match.level,
        match.tour,
        match.round,
        match.playerA,
        match.playerB,
        match.surface
      ].join(" ").toLowerCase();
      return haystack.includes(search);
    })
    .sort((a, b) => compareMatches(a, b, sortBy));
}

function compareMatches(a, b, sortBy) {
  const byLevel = levelRank(a.level) - levelRank(b.level);
  const byTime = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  const byTournament = a.tournament.localeCompare(b.tournament);

  if (sortBy === "time") {
    return byTime || byLevel || byTournament;
  }
  if (sortBy === "tournament") {
    return byTournament || byLevel || byTime;
  }
  return byLevel || byTime || byTournament;
}

function groupMatchesByTournament(matches) {
  const groups = [];
  const byTournament = new Map();

  matches.forEach((match) => {
    if (!byTournament.has(match.tournament)) {
      const group = {
        key: slugify(`${match.tournament}-${match.level}-${match.tour}`),
        tournament: match.tournament,
        level: match.level,
        tour: match.tour,
        matches: []
      };
      byTournament.set(match.tournament, group);
      groups.push(group);
    }
    byTournament.get(match.tournament).matches.push(match);
  });

  return groups;
}

function renderMatchRow(match) {
  const selected = match.id === selectedMatchId;
  const statusTag = match.completed
    ? `<span>Final${match.scoreline ? ` ${escapeHtml(match.scoreline)}` : ""}</span>`
    : "";
  return `
    <button class="match-row ${selected ? "selected" : ""}" type="button" data-match-id="${escapeHtml(match.id)}">
      <span class="match-time">${formatMatchTime(match.startTime)}</span>
      <span class="match-players">${escapeHtml(match.playerA)} <span>vs</span> ${escapeHtml(match.playerB)}</span>
      <span class="match-meta">${escapeHtml(match.round)}${match.court ? ` - ${escapeHtml(match.court)}` : ""}</span>
      <span class="match-tags">
        <span>${escapeHtml(match.level)}</span>
        <span>${escapeHtml(match.surface)}</span>
        <span>${match.format === "5" ? "BO5" : "BO3"}</span>
        ${statusTag}
      </span>
    </button>
  `;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { performance: cloneDefaultPerformance(), history: [], autoScoredMatchIds: [], learningEvents: [] };
    }

    const parsed = JSON.parse(raw);
    return {
      performance: mergePerformance(parsed.performance),
      history: Array.isArray(parsed.history) ? parsed.history : [],
      autoScoredMatchIds: Array.isArray(parsed.autoScoredMatchIds) ? parsed.autoScoredMatchIds : [],
      learningEvents: Array.isArray(parsed.learningEvents) ? parsed.learningEvents : []
    };
  } catch {
    return { performance: cloneDefaultPerformance(), history: [], autoScoredMatchIds: [], learningEvents: [] };
  }
}

function mergePerformance(performance) {
  const merged = cloneDefaultPerformance();
  if (!performance) return merged;

  MODEL_KEYS.forEach((modelKey) => {
    METRICS.forEach((metric) => {
      const value = Number(performance?.[modelKey]?.[metric.key]);
      if (Number.isFinite(value)) {
        merged[modelKey][metric.key] = clamp(value, 0.05, 0.98);
      }
    });
  });
  return merged;
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function readMatchForm() {
  return {
    playerA: textValue("player-a", "Player A"),
    playerB: textValue("player-b", "Player B"),
    surface: document.getElementById("surface").value,
    format: Number(document.getElementById("format").value),
    rankA: numberValue("rank-a", 50),
    rankB: numberValue("rank-b", 50),
    holdA: numberValue("hold-a", 80),
    holdB: numberValue("hold-b", 80),
    aceA: numberValue("ace-a", 6),
    aceB: numberValue("ace-b", 6),
    formA: numberValue("form-a", 70),
    formB: numberValue("form-b", 70),
    weatherFactor: numberValue("weather-factor", 0),
    fatigueA: numberValue("fatigue-a", 0),
    fatigueB: numberValue("fatigue-b", 0),
    injuryA: numberValue("injury-a", 0),
    injuryB: numberValue("injury-b", 0)
  };
}

async function runEnsemble() {
  const requestId = ++runRequestId;
  const match = readMatchForm();
  syncActualWinnerOptions(match);
  const runs = currentSimulationRuns();

  setRunInProgress(true, runs);

  try {
    const run = await buildEnsembleRunAsync(match, runs, (progress) => {
      if (requestId === runRequestId) updateRunProgress(progress);
    }, () => requestId === runRequestId);

    if (requestId !== runRequestId) return;

    latestRun = run;
    renderPrediction();
    renderModels();
    renderGraphs();
    renderParlays();
    renderLearning();
    renderLiveBoard();
    renderOddsBoard();
    setRunStatus(`Completed ${formatRunCount(runs)} runs.`);
  } catch (error) {
    if (requestId !== runRequestId || error.message === "Run canceled") return;
    setRunStatus(`Run failed: ${error.message}`);
  } finally {
    if (requestId === runRequestId) setRunInProgress(false, runs);
  }
}

function runOrQueueEnsemble() {
  const runs = currentSimulationRuns();
  if (runs > BULK_MAX_SIMULATION_RUNS) {
    queueHighRun(runs);
    return;
  }

  runEnsemble();
}

function queueHighRun(runs) {
  cancelActiveRun();
  latestRun = null;
  clearPredictionCards();
  renderModels();
  renderGraphs();
  renderParlays();
  renderLearning();
  renderLiveBoard();
  renderOddsBoard();
  setRunStatus(`Ready for ${formatRunCount(runs)} runs. Press Run Ensemble.`);
}

function cancelActiveRun() {
  if (!runInProgress) return;
  runRequestId += 1;
  setRunInProgress(false, currentSimulationRuns());
}

function clearPredictionCards() {
  setText("winner-pick", "-");
  setText("winner-probability", "Run the ensemble");
  setText("games-pick", "-");
  setText("games-range", "-");
  setText("tiebreak-pick", "-");
  setText("tiebreak-probability", "-");
  setText("sets-pick", "-");
  setText("sets-range", "-");
  setText("breaks-pick", "-");
  setText("breaks-range", "-");
  setText("aces-pick", "-");
  setText("aces-range", "-");
}

function currentSimulationRuns() {
  const input = document.getElementById("simulations");
  const rawRuns = Number(input?.value);
  const roundedRuns = Math.round((Number.isFinite(rawRuns) ? rawRuns : DEFAULT_SIMULATION_RUNS) / 1000) * 1000;
  const runs = clamp(roundedRuns || DEFAULT_SIMULATION_RUNS, MIN_SIMULATION_RUNS, MAX_SIMULATION_RUNS);

  if (input && Number(input.value) !== runs) {
    input.value = String(runs);
  }

  return runs;
}

function bulkSimulationRuns() {
  return Math.min(currentSimulationRuns(), BULK_MAX_SIMULATION_RUNS);
}

function autoLearningChunkSize(runs) {
  if (runs >= 75000) return 2;
  if (runs >= 40000) return 4;
  if (runs >= 15000) return 6;
  return AUTO_LEARNING_CHUNK_SIZE;
}

function setRunInProgress(active, runs) {
  runInProgress = active;
  const button = document.getElementById("run-button");
  if (button) {
    button.disabled = active;
    button.textContent = active ? "Running" : "Run Ensemble";
  }
  if (active) {
    setRunStatus(`Running ${formatRunCount(runs)} simulations...`);
  }
}

function updateRunProgress(progress) {
  const percentComplete = progress.total
    ? Math.floor((progress.completed / progress.total) * 100)
    : 0;
  const modelText = progress.modelName ? ` - ${progress.modelName}` : "";
  setRunStatus(`Running ${formatRunCount(progress.completed)} of ${formatRunCount(progress.total)}${modelText} (${percentComplete}%).`);
}

function setRunStatus(message) {
  const status = document.getElementById("run-status");
  if (status) status.textContent = message;
}

async function buildEnsembleRunAsync(match, runs, onProgress = () => {}, shouldContinue = () => true) {
  const modelMatch = modelReadyMatch(match);
  const modelOutputs = [];
  const totalWork = runs * MODEL_DEFINITIONS.length;
  let completedWork = 0;

  for (const model of MODEL_DEFINITIONS) {
    const accumulator = createModelAccumulator(model, modelMatch, runs);

    while (accumulator.count < runs) {
      if (!shouldContinue()) throw new Error("Run canceled");

      const batchSize = Math.min(RUN_CHUNK_SIZE, runs - accumulator.count);
      runModelSamples(accumulator, batchSize);
      completedWork += batchSize;

      onProgress({
        completed: completedWork,
        total: totalWork,
        modelName: model.name
      });

      if (runs > RUN_CHUNK_SIZE) {
        await yieldToBrowser();
      }
    }

    modelOutputs.push(finalizeModelAccumulator(accumulator));
  }

  const weights = buildWeights();
  const ensemble = combineOutputs(modelMatch, modelOutputs, weights);

  return {
    id: makeId(),
    createdAt: new Date().toISOString(),
    match: modelMatch,
    runs,
    modelOutputs,
    weights,
    ensemble
  };
}

function buildEnsembleRun(match, runs) {
  const modelMatch = modelReadyMatch(match);
  const modelOutputs = MODEL_DEFINITIONS.map((model) => runModel(model, modelMatch, runs));
  const weights = buildWeights();
  const ensemble = combineOutputs(modelMatch, modelOutputs, weights);

  return {
    id: makeId(),
    createdAt: new Date().toISOString(),
    match: modelMatch,
    runs,
    modelOutputs,
    weights,
    ensemble
  };
}

function modelReadyMatch(match) {
  return {
    ...match,
    format: Number(match.format) === 5 ? 5 : 3,
    rankA: Number(match.rankA ?? 50),
    rankB: Number(match.rankB ?? 50),
    holdA: Number(match.holdA ?? 80),
    holdB: Number(match.holdB ?? 80),
    aceA: Number(match.aceA ?? 6),
    aceB: Number(match.aceB ?? 6),
    formA: Number(match.formA ?? 70),
    formB: Number(match.formB ?? 70),
    weatherFactor: Number(match.weatherFactor ?? 0),
    fatigueA: Number(match.fatigueA ?? 0),
    fatigueB: Number(match.fatigueB ?? 0),
    injuryA: Number(match.injuryA ?? 0),
    injuryB: Number(match.injuryB ?? 0)
  };
}

function runModel(model, match, runs) {
  const accumulator = createModelAccumulator(model, match, runs);
  runModelSamples(accumulator, runs);
  return finalizeModelAccumulator(accumulator);
}

function createModelAccumulator(model, match, runs) {
  const seedText = `${model.key}:${match.playerA}:${match.playerB}:${match.surface}:${match.format}:${runs}:${JSON.stringify(state.performance[model.key])}`;
  return {
    model,
    match,
    runs,
    random: mulberry32(hashString(seedText)),
    count: 0,
    totals: {
      probA: 0,
      totalGames: 0,
      tieBreakerProb: 0,
      sets: 0,
      breaks: 0,
      aces: 0
    },
    meanGames: 0,
    gamesM2: 0,
    histograms: createRunHistograms()
  };
}

function runModelSamples(accumulator, sampleCount) {
  const { model, match, random, totals, histograms } = accumulator;

  for (let i = 0; i < sampleCount; i += 1) {
    const sample = model.project(match, random);
    accumulator.count += 1;

    totals.probA += sample.probA;
    totals.totalGames += sample.totalGames;
    totals.tieBreakerProb += sample.tieBreakerProb;
    totals.sets += sample.sets;
    totals.breaks += sample.breaks;
    totals.aces += sample.aces;

    const delta = sample.totalGames - accumulator.meanGames;
    accumulator.meanGames += delta / accumulator.count;
    accumulator.gamesM2 += delta * (sample.totalGames - accumulator.meanGames);

    recordRunLanding(histograms, sample, random);
  }
}

function finalizeModelAccumulator(accumulator) {
  const { model, totals, count, meanGames, gamesM2, histograms } = accumulator;
  const safeCount = Math.max(count, 1);
  const spread = Math.sqrt(gamesM2 / safeCount);

  return {
    key: model.key,
    name: model.name,
    style: model.style,
    probA: totals.probA / safeCount,
    totalGames: totals.totalGames / safeCount,
    gamesLow: Math.max(12, meanGames - spread),
    gamesHigh: meanGames + spread,
    tieBreakerProb: totals.tieBreakerProb / safeCount,
    sets: totals.sets / safeCount,
    breaks: totals.breaks / safeCount,
    aces: totals.aces / safeCount,
    histograms
  };
}

function createRunHistograms() {
  return {
    winner: { A: 0, B: 0 },
    totalGames: {},
    tieBreaker: { Yes: 0, No: 0 },
    sets: {},
    breaks: {},
    aces: {}
  };
}

function recordRunLanding(histograms, sample, random) {
  addHistogramCount(histograms.winner, random() < sample.probA ? "A" : "B");
  addHistogramCount(histograms.totalGames, Math.round(sample.totalGames));
  addHistogramCount(histograms.tieBreaker, random() < sample.tieBreakerProb ? "Yes" : "No");
  addHistogramCount(histograms.sets, Math.round(sample.sets));
  addHistogramCount(histograms.breaks, Math.round(sample.breaks));
  addHistogramCount(histograms.aces, Math.round(sample.aces));
}

function addHistogramCount(histogram, bucket, amount = 1) {
  const key = String(bucket);
  histogram[key] = (histogram[key] || 0) + amount;
}

function projectFromEdges(match, random, edges) {
  const bestOfFive = match.format === 5;
  const surface = surfaceProfile(match.surface);
  const context = contextProfile(match);
  const noise = (edges.noise ?? 1) * normal(random);
  const winLogit = (edges.winEdge + context.winEdge) * 5.2 + noise * 0.18;
  const probA = clamp(logistic(winLogit), 0.04, 0.96);
  const closeness = 1 - Math.abs(probA - 0.5) * 2;
  const baseSets = bestOfFive ? 3.7 : 2.35;
  const setLift = bestOfFive ? 1.3 : 0.75;
  const sets = clamp(baseSets + closeness * setLift + normal(random) * 0.22, bestOfFive ? 3 : 2, bestOfFive ? 5 : 3);
  const gamesPerSet = 9.1 + closeness * 2.55 + edges.paceEdge * 2.1 + surface.pace * 0.9 + context.paceLift + normal(random) * 0.55;
  const totalGames = clamp(gamesPerSet * sets, bestOfFive ? 26 : 16, bestOfFive ? 65 : 39);
  const tieBreakerProb = clamp(0.19 + closeness * 0.33 + edges.tieEdge * 0.22 + surface.tieLift * 0.12 + context.tieLift + normal(random) * 0.06, 0.03, 0.92);
  const breaks = clamp((sets * 2.15) + edges.breakEdge * 2.4 + (1 - closeness) * 1.1 + context.breakLift + normal(random) * 1.05, 0, bestOfFive ? 22 : 14);
  const acesBase = ((match.aceA + match.aceB) / 100) * totalGames * 2.05;
  const aces = clamp(acesBase * surface.aceMultiplier + edges.aceEdge * 5 + context.aceLift + normal(random) * 2.1, 0, bestOfFive ? 70 : 42);

  return {
    probA,
    totalGames,
    tieBreakerProb,
    sets,
    breaks,
    aces
  };
}

function combineOutputs(match, outputs, weights) {
  const byKey = Object.fromEntries(outputs.map((output) => [output.key, output]));

  const probA = weightedAverage(outputs, weights.winner, (output) => output.probA);
  const totalGames = weightedAverage(outputs, weights.totalGames, (output) => output.totalGames);
  const tieBreakerProb = weightedAverage(outputs, weights.tieBreaker, (output) => output.tieBreakerProb);
  const sets = weightedAverage(outputs, weights.sets, (output) => output.sets);
  const breaks = weightedAverage(outputs, weights.breaks, (output) => output.breaks);
  const aces = weightedAverage(outputs, weights.aces, (output) => output.aces);

  return {
    winner: probA >= 0.5 ? match.playerA : match.playerB,
    winnerSide: probA >= 0.5 ? "A" : "B",
    probA,
    winnerProbability: Math.max(probA, 1 - probA),
    totalGames,
    gamesLow: weightedAverage(outputs, weights.totalGames, (output) => output.gamesLow),
    gamesHigh: weightedAverage(outputs, weights.totalGames, (output) => output.gamesHigh),
    tieBreakerProb,
    tieBreaker: tieBreakerProb >= 0.5,
    sets,
    breaks,
    aces,
    byKey
  };
}

function buildWeights() {
  const weights = {};
  METRICS.forEach((metric) => {
    const scores = MODEL_KEYS.map((modelKey) => Math.pow(state.performance[modelKey][metric.key], 2.4));
    const total = scores.reduce((sum, score) => sum + score, 0) || 1;
    weights[metric.key] = Object.fromEntries(
      MODEL_KEYS.map((modelKey, index) => [modelKey, scores[index] / total])
    );
  });
  return weights;
}

function weightedAverage(outputs, metricWeights, getter) {
  return outputs.reduce((sum, output) => sum + getter(output) * metricWeights[output.key], 0);
}

function renderPrediction() {
  if (!latestRun) return;
  const { ensemble, match } = latestRun;
  const underdog = ensemble.winnerSide === "A" ? match.playerB : match.playerA;
  const underdogProb = ensemble.winnerSide === "A" ? 1 - ensemble.probA : ensemble.probA;

  setText("winner-pick", ensemble.winner);
  setText("winner-probability", `${percent(ensemble.winnerProbability)} vs ${underdog} ${percent(underdogProb)}`);
  setText("games-pick", round(ensemble.totalGames, 1));
  setText("games-range", `${round(ensemble.gamesLow, 1)}-${round(ensemble.gamesHigh, 1)} range`);
  setText("tiebreak-pick", ensemble.tieBreaker ? "Yes" : "No");
  setText("tiebreak-probability", percent(ensemble.tieBreakerProb));
  setText("sets-pick", round(ensemble.sets, 1));
  setText("sets-range", `${Math.round(ensemble.sets)} likely`);
  setText("breaks-pick", round(ensemble.breaks, 1));
  setText("breaks-range", `${Math.round(ensemble.breaks)} projected`);
  setText("aces-pick", round(ensemble.aces, 1));
  setText("aces-range", `${Math.round(ensemble.aces)} projected`);
}

function renderModels() {
  const container = document.getElementById("model-list");
  if (!latestRun) {
    container.innerHTML = `<div class="empty-state">Run the ensemble to see model output.</div>`;
    return;
  }

  const metricKey = document.getElementById("metric-view").value;
  const metricWeights = latestRun.weights[metricKey];
  const metricLabel = METRICS.find((metric) => metric.key === metricKey)?.label ?? "Metric";

  container.innerHTML = latestRun.modelOutputs
    .map((output) => {
      const weight = metricWeights[output.key] ?? 0;
      return `
        <article class="model-row">
          <div>
            <div class="model-name">${escapeHtml(output.name)}</div>
            <div class="model-meta">${escapeHtml(output.style)}</div>
          </div>
          <div>
            <span class="model-meta">${metricLabel} weight</span>
            <span class="pill">${percent(weight)}</span>
          </div>
          <div>
            <span class="model-meta">Winner</span>
            <span class="pill">${percent(output.probA)} A</span>
          </div>
          <div>
            <span class="model-meta">Games</span>
            <span class="pill">${round(output.totalGames, 1)}</span>
          </div>
          <div>
            <span class="model-meta">TB / Sets</span>
            <span class="pill">${percent(output.tieBreakerProb)} / ${round(output.sets, 1)}</span>
          </div>
          <div class="bar" aria-label="${output.name} ${metricLabel} weight">
            <span style="--value: ${Math.round(weight * 100)}%"></span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderGraphs() {
  const runCount = document.getElementById("graph-run-count");
  const summary = document.getElementById("graph-summary");
  const board = document.getElementById("graph-board");
  if (!runCount || !summary || !board) return;

  if (!latestRun) {
    runCount.textContent = "No run";
    summary.innerHTML = `<div class="empty-state">Run the ensemble to build the landing graphs.</div>`;
    board.innerHTML = "";
    return;
  }

  const { match, ensemble, runs } = latestRun;
  runCount.textContent = `${formatRunCount(runs)} runs`;
  summary.innerHTML = `
    <div>
      <span>Match</span>
      <strong>${escapeHtml(match.playerA)} vs ${escapeHtml(match.playerB)}</strong>
      <small>${escapeHtml(match.surface)} - ${match.format === 5 ? "Best of 5" : "Best of 3"}</small>
    </div>
    <div>
      <span>Winner lean</span>
      <strong>${escapeHtml(ensemble.winner)}</strong>
      <small>${percent(ensemble.winnerProbability)} model probability</small>
    </div>
    <div>
      <span>Stored landings</span>
      <strong>${formatRunCount(runs)}</strong>
      <small>Binned by outcome, not raw rows</small>
    </div>
  `;

  board.innerHTML = graphDefinitions().map((definition) => {
    const rows = weightedHistogramRows(latestRun, definition.key);
    return renderGraphCard(definition, rows, latestRun);
  }).join("");
}

function graphDefinitions() {
  return [
    { key: "winner", label: "Winner", unit: "" },
    { key: "totalGames", label: "Total Games", unit: "games" },
    { key: "tieBreaker", label: "Tiebreak", unit: "" },
    { key: "sets", label: "Sets", unit: "sets" },
    { key: "breaks", label: "Breaks", unit: "breaks" },
    { key: "aces", label: "Aces", unit: "aces" }
  ];
}

function weightedHistogramRows(run, metricKey) {
  const weights = run.weights[metricKey] ?? {};
  const combined = {};

  run.modelOutputs.forEach((output) => {
    const weight = weights[output.key] ?? 0;
    const histogram = output.histograms?.[metricKey] ?? {};
    Object.entries(histogram).forEach(([bucket, count]) => {
      combined[bucket] = (combined[bucket] || 0) + count * weight;
    });
  });

  const total = Object.values(combined).reduce((sum, count) => sum + count, 0) || 1;
  return Object.entries(combined)
    .map(([bucket, count]) => ({
      bucket,
      count,
      probability: count / total
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => graphBucketSort(metricKey, a.bucket, b.bucket));
}

function graphBucketSort(metricKey, a, b) {
  if (metricKey === "winner") return ["A", "B"].indexOf(a) - ["A", "B"].indexOf(b);
  if (metricKey === "tieBreaker") return ["Yes", "No"].indexOf(a) - ["Yes", "No"].indexOf(b);
  return Number(a) - Number(b);
}

function renderGraphCard(definition, rows, run) {
  const maxProbability = Math.max(...rows.map((row) => row.probability), 0.01);
  const rowMarkup = rows.map((row) => {
    const width = Math.max(1, (row.probability / maxProbability) * 100);
    return `
      <div class="graph-row">
        <div class="graph-label">${escapeHtml(graphBucketLabel(definition, row.bucket, run.match))}</div>
        <div class="graph-track" aria-label="${escapeHtml(definition.label)} ${escapeHtml(row.bucket)} ${percent(row.probability)}">
          <span class="graph-fill" style="--value: ${width}%"></span>
        </div>
        <div class="graph-value">
          <strong>${percent(row.probability)}</strong>
          <span>${formatRunCount(row.count)}</span>
        </div>
      </div>
    `;
  }).join("");

  return `
    <article class="graph-card">
      <div class="graph-card-head">
        <div>
          <h3>${escapeHtml(definition.label)}</h3>
          <span class="model-meta">Where the simulated runs landed</span>
        </div>
        <span class="pill">${rows.length} spots</span>
      </div>
      <div class="graph-rows">${rowMarkup}</div>
    </article>
  `;
}

function graphBucketLabel(definition, bucket, match) {
  if (definition.key === "winner") {
    return bucket === "A" ? match.playerA : match.playerB;
  }
  if (definition.unit) return `${bucket} ${definition.unit}`;
  return bucket;
}

function renderLiveBoard() {
  const summary = document.getElementById("live-summary");
  const list = document.getElementById("live-match-list");
  if (!summary || !list) return;

  const liveMatches = preloadedMatches
    .filter((match) => match.live && !match.completed)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const finishedCount = preloadedMatches.filter((match) => match.completed).length;
  const runs = bulkSimulationRuns();
  const selectedRuns = currentSimulationRuns();
  const projections = liveMatches.slice(0, 24).map((match) => buildLiveProjection(match, runs));
  const bestProjection = projections
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence)[0];

  summary.innerHTML = `
    <article class="live-tile">
      <span>Live matches</span>
      <strong>${liveMatches.length}</strong>
    </article>
    <article class="live-tile">
      <span>Finished</span>
      <strong>${finishedCount}</strong>
    </article>
    <article class="live-tile">
      <span>Top live lean</span>
      <strong>${bestProjection ? escapeHtml(bestProjection.pick) : "-"}</strong>
    </article>
    <article class="live-tile">
      <span>${selectedRuns > runs ? "Bulk runs" : "Runs used"}</span>
      <strong>${formatRunCount(runs)}</strong>
    </article>
  `;

  if (!liveMatches.length) {
    list.innerHTML = `<div class="empty-state">No live matches in the loaded slate.</div>`;
    return;
  }

  list.innerHTML = projections
    .filter(Boolean)
    .map(renderLiveRow)
    .join("");
}

function buildLiveProjection(match, runs) {
  const run = getModelRunForMatch(match, runs);
  const liveProbA = liveAdjustedProbability(match, run.ensemble.probA);
  const pickSide = liveProbA >= 0.5 ? "A" : "B";
  const probability = pickSide === "A" ? liveProbA : 1 - liveProbA;
  const pick = pickSide === "A" ? match.playerA : match.playerB;
  const bestBook = bestMoneylineBook(match, liveProbA, true);

  return {
    match,
    pick,
    pickSide,
    probability,
    liveProbA,
    prematchProbA: run.ensemble.probA,
    confidence: Math.abs(probability - 0.5),
    fairAmericanOdds: probabilityToAmericanOdds(probability),
    fairDecimalOdds: probabilityToDecimalOdds(probability),
    bestBook
  };
}

function liveAdjustedProbability(match, prematchProbA) {
  if (match.completed) return match.winnerSide === "A" ? 0.995 : 0.005;

  const liveState = match.liveState || {};
  const setsA = finiteNumber(liveState.setsA) ?? countWonSets(liveState.sets, "A");
  const setsB = finiteNumber(liveState.setsB) ?? countWonSets(liveState.sets, "B");
  const currentSet = lastSet(liveState.sets);
  const setDiff = (setsA ?? 0) - (setsB ?? 0);
  const gameDiff = currentSet ? currentSet.a - currentSet.b : 0;
  const pointDiff = pointRank(liveState.pointA) - pointRank(liveState.pointB);
  const bestOfFive = Number(match.format) === 5;
  const adjustment = setDiff * (bestOfFive ? 0.78 : 0.96) + gameDiff * 0.12 + pointDiff * 0.18;

  return clamp(logistic(logit(prematchProbA) + adjustment), 0.01, 0.99);
}

function countWonSets(sets, side) {
  if (!Array.isArray(sets)) return 0;
  return sets.filter((set) => side === "A" ? set.a > set.b : set.b > set.a).length;
}

function lastSet(sets) {
  if (!Array.isArray(sets) || !sets.length) return null;
  return sets[sets.length - 1];
}

function pointRank(value) {
  const text = String(value || "").toUpperCase();
  if (text === "A" || text === "AD") return 4;
  if (text === "40") return 3;
  if (text === "30") return 2;
  if (text === "15") return 1;
  return 0;
}

function renderLiveRow(projection) {
  const { match, bestBook } = projection;
  const liveState = match.liveState || {};
  const pointText = liveState.pointA || liveState.pointB
    ? `${escapeHtml(liveState.pointA || "0")}-${escapeHtml(liveState.pointB || "0")}`
    : "-";
  const bookText = bestBook
    ? `${escapeHtml(bestBook.book)} ${formatAmericanOdds(bestBook.odds)}`
    : "No live book";
  const edgeText = bestBook
    ? `${formatSignedPercent(bestBook.edge)} edge`
    : "Fair only";

  return `
    <article class="live-row">
      <div>
        <div class="model-name">${escapeHtml(match.playerA)} vs ${escapeHtml(match.playerB)}</div>
        <div class="model-meta">${escapeHtml(match.tournament)} - ${escapeHtml(match.statusDescription || "Live")}</div>
      </div>
      <div>
        <span class="model-meta">Score</span>
        <span class="live-scoreline">${escapeHtml(liveState.scoreline || match.scoreline || "-")} ${pointText}</span>
      </div>
      <div>
        <span class="model-meta">Live pick</span>
        <span class="pill">${escapeHtml(projection.pick)}</span>
      </div>
      <div>
        <span class="model-meta">Model</span>
        <span class="pill">${percent(projection.probability)}</span>
      </div>
      <div>
        <span class="model-meta">${escapeHtml(bookText)}</span>
        <span class="pill ${bestBook && bestBook.edge > 0 ? "edge-positive" : "edge-watch"}">${escapeHtml(edgeText)}</span>
      </div>
    </article>
  `;
}

function renderOddsBoard() {
  const summary = document.getElementById("odds-summary");
  const board = document.getElementById("odds-board");
  const status = document.getElementById("odds-status");
  if (!summary || !board || !status) return;

  const bookFilter = document.getElementById("odds-book-filter")?.value ?? "all";
  const minEdge = (Number(document.getElementById("odds-min-edge")?.value) || 0) / 100;
  const runs = bulkSimulationRuns();
  const selectedRuns = currentSimulationRuns();
  const runLabel = selectedRuns > runs
    ? `${formatRunCount(runs)} bulk runs; main graph run set to ${formatRunCount(selectedRuns)}`
    : `${formatRunCount(runs)} runs`;
  const rows = buildOddsRows(runs)
    .filter((row) => bookFilter === "all" || row.book === bookFilter)
    .sort((a, b) => b.ev - a.ev || b.edge - a.edge);
  const plusEvRows = rows.filter((row) => row.ev > 0 && row.edge >= minEdge);
  const visibleRows = plusEvRows.length ? plusEvRows : buildOddsWatchlist(runs);
  const best = plusEvRows[0];

  status.textContent = oddsMarkets.length
    ? `${oddsMeta.source} - ${oddsMarkets.length} sportsbook outcomes - ${runLabel}${oddsMeta.generatedAt ? ` - updated ${formatSlateDate(oddsMeta.generatedAt)}` : ""}`
    : `No sportsbook odds feed loaded. Model watchlist is using ${runLabel}.`;

  summary.innerHTML = `
    <div>
      <span>+EV spots</span>
      <strong>${plusEvRows.length}</strong>
      <small>${bookFilter === "all" ? "All books" : escapeHtml(bookFilter)}</small>
    </div>
    <div>
      <span>Best edge</span>
      <strong>${best ? formatSignedPercent(best.edge) : "-"}</strong>
      <small>${best ? `${escapeHtml(best.book)} ${formatAmericanOdds(best.odds)}` : "No qualifying book price"}</small>
    </div>
    <div>
      <span>Model markets</span>
      <strong>${preloadedMatches.length}</strong>
      <small>${MAJOR_US_BOOKS.length} US books configured</small>
    </div>
  `;

  board.innerHTML = visibleRows.length
    ? visibleRows.slice(0, 36).map(renderOddsRow).join("")
    : `<div class="empty-state">No +EV prices cleared the current filter.</div>`;
}

function buildOddsRows(runs) {
  return oddsMarkets
    .map((outcome) => {
      const match = findMatchForOdds(outcome);
      if (!match) return null;
      if (match.completed) return null;

      const run = getModelRunForMatch(match, runs);
      const modelProbability = modelProbabilityForOutcome(match, run, outcome);
      if (!Number.isFinite(modelProbability)) return null;

      const impliedProbability = americanToImpliedProbability(outcome.odds);
      const edge = modelProbability - impliedProbability;
      const ev = expectedValue(modelProbability, outcome.odds);

      return {
        ...outcome,
        match,
        modelProbability,
        impliedProbability,
        edge,
        ev,
        fairAmericanOdds: probabilityToAmericanOdds(modelProbability),
        fairDecimalOdds: probabilityToDecimalOdds(modelProbability)
      };
    })
    .filter(Boolean);
}

function buildOddsWatchlist(runs) {
  return preloadedMatches
    .filter((match) => !match.completed)
    .slice(0, 18)
    .map((match) => {
      const run = getModelRunForMatch(match, runs);
      const side = run.ensemble.probA >= 0.5 ? "A" : "B";
      const probability = side === "A" ? run.ensemble.probA : 1 - run.ensemble.probA;
      return {
        kind: "watch",
        match,
        book: "No market",
        marketLabel: "Moneyline",
        selectionLabel: side === "A" ? match.playerA : match.playerB,
        modelProbability: probability,
        impliedProbability: null,
        edge: 0,
        ev: 0,
        odds: null,
        fairAmericanOdds: probabilityToAmericanOdds(probability),
        fairDecimalOdds: probabilityToDecimalOdds(probability)
      };
    });
}

function renderOddsRow(row) {
  const isWatch = row.kind === "watch";
  const bookPrice = isWatch ? "Load odds" : `${formatAmericanOdds(row.odds)}`;
  const edge = isWatch ? "Fair line" : formatSignedPercent(row.edge);
  const ev = isWatch ? "-" : `${row.ev >= 0 ? "+" : ""}${round(row.ev, 2)}`;

  return `
    <article class="odds-row">
      <div>
        <div class="model-name">${escapeHtml(row.selectionLabel)}</div>
        <div class="model-meta">${escapeHtml(row.match.playerA)} vs ${escapeHtml(row.match.playerB)} - ${escapeHtml(row.marketLabel)}</div>
      </div>
      <div>
        <span class="model-meta">Book</span>
        <span class="pill">${escapeHtml(row.book)}</span>
      </div>
      <div>
        <span class="model-meta">Book odds</span>
        <span class="pill">${escapeHtml(bookPrice)}</span>
      </div>
      <div>
        <span class="model-meta">Model</span>
        <span class="pill">${percent(row.modelProbability)}</span>
      </div>
      <div>
        <span class="model-meta">Fair</span>
        <span class="pill">${formatAmericanOdds(row.fairAmericanOdds)}</span>
      </div>
      <div>
        <span class="model-meta">EV / Edge</span>
        <span class="pill ${row.ev > 0 ? "edge-positive" : "edge-watch"}">${escapeHtml(ev)} / ${escapeHtml(edge)}</span>
      </div>
    </article>
  `;
}

function renderParlays() {
  const summary = document.getElementById("parlay-summary");
  const legList = document.getElementById("parlay-leg-list");
  const candidatesList = document.getElementById("parlay-candidates");
  const riskBadge = document.getElementById("parlay-risk");

  if (!latestRun) {
    summary.innerHTML = `<div class="empty-state">Run the ensemble to build parlay legs.</div>`;
    legList.innerHTML = "";
    candidatesList.innerHTML = "";
    riskBadge.textContent = "-";
    return;
  }

  const profileKey = document.getElementById("parlay-profile").value;
  const profile = PARLAY_PROFILES[profileKey] ?? PARLAY_PROFILES.balanced;
  const legCount = Math.round(clamp(Number(document.getElementById("parlay-leg-count").value) || 3, 2, 6));
  const candidates = buildParlayCandidates(latestRun);
  const parlay = buildRecommendedParlay(candidates, profile, legCount);

  if (!parlay.legs.length) {
    summary.innerHTML = `<div class="empty-state">No parlay candidates cleared this profile yet.</div>`;
    legList.innerHTML = "";
    candidatesList.innerHTML = candidates.map(renderParlayCandidate).join("");
    riskBadge.textContent = "No slip";
    return;
  }

  riskBadge.textContent = `${parlay.riskLabel} correlation`;
  summary.innerHTML = `
    <div>
      <span>${escapeHtml(profile.label)} ${parlay.legs.length}-leg</span>
      <strong>${percent(parlay.combinedProbability)}</strong>
      <small>Estimated hit probability after correlation haircut</small>
    </div>
    <div>
      <span>Fair odds</span>
      <strong>${parlay.fairDecimalOdds}x</strong>
      <small>${formatAmericanOdds(parlay.fairAmericanOdds)} American</small>
    </div>
    <div>
      <span>Average leg</span>
      <strong>${percent(parlay.averageLegProbability)}</strong>
      <small>${round(parlay.averageReliability * 100, 0)} model reliability score</small>
    </div>
  `;

  legList.innerHTML = parlay.legs.map(renderParlayLeg).join("");
  candidatesList.innerHTML = candidates.slice(0, 18).map(renderParlayCandidate).join("");
}

function buildParlayCandidates(run) {
  const { match, ensemble } = run;
  const candidates = [];
  const bestOfFive = match.format === 5;

  const addCandidate = (candidate) => {
    const probability = clamp(candidate.probability, 0.01, 0.99);
    if (probability <= 0.5) return;

    const reliability = metricReliability(run, candidate.metricKey);
    const probabilityScore = (probability - 0.5) * 2;
    const reliabilityScore = clamp(reliability, 0, 1);
    const score = probabilityScore * 0.72 + reliabilityScore * 0.28;

    candidates.push({
      ...candidate,
      probability,
      reliability,
      confidence: clamp(probability * 0.72 + reliability * 0.28, 0.01, 0.99),
      fairDecimalOdds: probabilityToDecimalOdds(probability),
      fairAmericanOdds: probabilityToAmericanOdds(probability),
      score
    });
  };

  addCandidate({
    id: "winner-a",
    category: "Winner",
    metricKey: "winner",
    group: "winner",
    family: "winner",
    player: match.playerA,
    market: "Match winner",
    pick: match.playerA,
    probability: ensemble.probA,
    note: "Best straight winner side from the ensemble."
  });
  addCandidate({
    id: "winner-b",
    category: "Winner",
    metricKey: "winner",
    group: "winner",
    family: "winner",
    player: match.playerB,
    market: "Match winner",
    pick: match.playerB,
    probability: 1 - ensemble.probA,
    note: "Best straight winner side from the ensemble."
  });

  const gamesSigma = clamp((ensemble.gamesHigh - ensemble.gamesLow) / 2, bestOfFive ? 3.2 : 2.0, bestOfFive ? 8.5 : 5.5);
  addOverUnderCandidates(candidates, addCandidate, {
    category: "Match prop",
    metricKey: "totalGames",
    family: "games",
    group: "total-games",
    market: "Total games",
    mean: ensemble.totalGames,
    sigma: gamesSigma,
    lowerLine: halfLineBelow(ensemble.totalGames, bestOfFive ? 2.0 : 1.0),
    upperLine: halfLineAbove(ensemble.totalGames, bestOfFive ? 2.0 : 1.0),
    units: "games"
  });

  addCandidate({
    id: "tiebreak-yes",
    category: "Match prop",
    metricKey: "tieBreaker",
    group: "tiebreak",
    family: "tiebreak",
    market: "Tiebreak played",
    pick: "Yes",
    probability: ensemble.tieBreakerProb,
    note: "Uses serve hold, surface pace, and closeness from the ensemble."
  });
  addCandidate({
    id: "tiebreak-no",
    category: "Match prop",
    metricKey: "tieBreaker",
    group: "tiebreak",
    family: "tiebreak",
    market: "Tiebreak played",
    pick: "No",
    probability: 1 - ensemble.tieBreakerProb,
    note: "Uses serve hold, surface pace, and closeness from the ensemble."
  });

  const setsLine = bestOfFive ? 3.5 : 2.5;
  addCandidate({
    id: "sets-over",
    category: "Match prop",
    metricKey: "sets",
    group: "sets",
    family: "sets",
    market: "Total sets",
    pick: `Over ${formatLine(setsLine)} sets`,
    probability: probabilityOverLine(ensemble.sets, setsLine, bestOfFive ? 0.72 : 0.48),
    note: "Better when the match projects close."
  });
  addCandidate({
    id: "sets-under",
    category: "Match prop",
    metricKey: "sets",
    group: "sets",
    family: "sets",
    market: "Total sets",
    pick: `Under ${formatLine(setsLine)} sets`,
    probability: probabilityUnderLine(ensemble.sets, setsLine, bestOfFive ? 0.72 : 0.48),
    note: "Better when the winner projection is stronger."
  });

  addOverUnderCandidates(candidates, addCandidate, {
    category: "Match prop",
    metricKey: "breaks",
    family: "breaks",
    group: "total-breaks",
    market: "Total breaks",
    mean: ensemble.breaks,
    sigma: clamp(Math.sqrt(Math.max(ensemble.breaks, 1)) * 0.95, 1.2, bestOfFive ? 4.8 : 3.5),
    lowerLine: halfLineBelow(ensemble.breaks, 0.8),
    upperLine: halfLineAbove(ensemble.breaks, 0.8),
    units: "breaks"
  });

  addOverUnderCandidates(candidates, addCandidate, {
    category: "Match prop",
    metricKey: "aces",
    family: "aces",
    group: "total-aces",
    market: "Total aces",
    mean: ensemble.aces,
    sigma: clamp(Math.sqrt(Math.max(ensemble.aces, 1)) * 1.15, 1.8, bestOfFive ? 8.0 : 5.5),
    lowerLine: halfLineBelow(ensemble.aces, 1.0),
    upperLine: halfLineAbove(ensemble.aces, 1.0),
    units: "aces"
  });

  const aceShareA = clamp(match.aceA / Math.max(match.aceA + match.aceB, 0.1), 0.22, 0.78);
  const playerAcesA = ensemble.aces * aceShareA;
  const playerAcesB = ensemble.aces * (1 - aceShareA);
  addPlayerCountCandidates(candidates, addCandidate, {
    player: match.playerA,
    metricKey: "aces",
    family: "player-aces",
    group: "player-a-aces",
    market: `${match.playerA} aces`,
    mean: playerAcesA,
    sigma: clamp(Math.sqrt(Math.max(playerAcesA, 1)) * 0.95, 1.1, 5.5),
    units: "aces"
  });
  addPlayerCountCandidates(candidates, addCandidate, {
    player: match.playerB,
    metricKey: "aces",
    family: "player-aces",
    group: "player-b-aces",
    market: `${match.playerB} aces`,
    mean: playerAcesB,
    sigma: clamp(Math.sqrt(Math.max(playerAcesB, 1)) * 0.95, 1.1, 5.5),
    units: "aces"
  });

  const breakShareA = clamp((100 - match.holdB) / Math.max((100 - match.holdA) + (100 - match.holdB), 0.1), 0.22, 0.78);
  const playerBreaksA = ensemble.breaks * breakShareA;
  const playerBreaksB = ensemble.breaks * (1 - breakShareA);
  addPlayerCountCandidates(candidates, addCandidate, {
    player: match.playerA,
    metricKey: "breaks",
    family: "player-breaks",
    group: "player-a-breaks",
    market: `${match.playerA} breaks`,
    mean: playerBreaksA,
    sigma: clamp(Math.sqrt(Math.max(playerBreaksA, 1)) * 0.8, 0.9, 3.2),
    units: "breaks"
  });
  addPlayerCountCandidates(candidates, addCandidate, {
    player: match.playerB,
    metricKey: "breaks",
    family: "player-breaks",
    group: "player-b-breaks",
    market: `${match.playerB} breaks`,
    mean: playerBreaksB,
    sigma: clamp(Math.sqrt(Math.max(playerBreaksB, 1)) * 0.8, 0.9, 3.2),
    units: "breaks"
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function addOverUnderCandidates(_candidates, addCandidate, config) {
  const lowerLine = Math.max(0.5, config.lowerLine);
  const upperLine = Math.max(0.5, config.upperLine);

  addCandidate({
    id: `${config.group}-over`,
    category: config.category,
    metricKey: config.metricKey,
    group: config.group,
    family: config.family,
    market: config.market,
    pick: `Over ${formatLine(lowerLine)} ${config.units}`,
    probability: probabilityOverLine(config.mean, lowerLine, config.sigma),
    note: `Model projection: ${round(config.mean, 1)} ${config.units}. Look for this line or lower.`
  });

  addCandidate({
    id: `${config.group}-under`,
    category: config.category,
    metricKey: config.metricKey,
    group: config.group,
    family: config.family,
    market: config.market,
    pick: `Under ${formatLine(upperLine)} ${config.units}`,
    probability: probabilityUnderLine(config.mean, upperLine, config.sigma),
    note: `Model projection: ${round(config.mean, 1)} ${config.units}. Look for this line or higher.`
  });
}

function addPlayerCountCandidates(_candidates, addCandidate, config) {
  addOverUnderCandidates(_candidates, addCandidate, {
    category: "Player prop",
    metricKey: config.metricKey,
    family: config.family,
    group: config.group,
    market: config.market,
    mean: config.mean,
    sigma: config.sigma,
    lowerLine: halfLineBelow(config.mean, 0.6),
    upperLine: halfLineAbove(config.mean, 0.6),
    units: config.units
  });
}

function buildRecommendedParlay(candidates, profile, legCount) {
  const minimum = profile.minProbability;
  let pool = candidates.filter((candidate) => candidate.probability >= minimum);
  if (pool.length < legCount) {
    pool = candidates.filter((candidate) => candidate.probability >= Math.max(0.51, minimum - 0.06));
  }

  const selected = [];
  const priorityCategories = legCount >= 3
    ? ["Winner", "Match prop", "Player prop"]
    : ["Winner", "Player prop"];

  priorityCategories.slice(0, legCount).forEach((category) => {
    const best = pool.find((candidate) => candidate.category === category && isCompatibleLeg(candidate, selected));
    if (best) selected.push(best);
  });

  pool.forEach((candidate) => {
    if (selected.length >= legCount) return;
    if (isCompatibleLeg(candidate, selected)) selected.push(candidate);
  });

  if (selected.length < legCount) {
    candidates.forEach((candidate) => {
      if (selected.length >= legCount) return;
      if (candidate.probability > 0.5 && isCompatibleLeg(candidate, selected)) selected.push(candidate);
    });
  }

  let risk = estimateParlayCorrelationRisk(selected);
  while (risk > profile.maxRisk && selected.length > 2) {
    const removableIndex = selected.reduce((lowestIndex, leg, index) => (
      leg.score < selected[lowestIndex].score ? index : lowestIndex
    ), 0);
    selected.splice(removableIndex, 1);
    risk = estimateParlayCorrelationRisk(selected);
  }

  const rawProbability = selected.reduce((product, leg) => product * leg.probability, 1);
  const combinedProbability = selected.length
    ? clamp(rawProbability * (1 - risk), 0.001, 0.99)
    : 0;
  const averageLegProbability = selected.length
    ? selected.reduce((sum, leg) => sum + leg.probability, 0) / selected.length
    : 0;
  const averageReliability = selected.length
    ? selected.reduce((sum, leg) => sum + leg.reliability, 0) / selected.length
    : 0;

  return {
    legs: selected,
    risk,
    riskLabel: risk < 0.08 ? "Low" : risk < 0.18 ? "Medium" : "High",
    combinedProbability,
    averageLegProbability,
    averageReliability,
    fairDecimalOdds: probabilityToDecimalOdds(combinedProbability),
    fairAmericanOdds: probabilityToAmericanOdds(combinedProbability)
  };
}

function isCompatibleLeg(candidate, selected) {
  return !selected.some((leg) => leg.group === candidate.group);
}

function estimateParlayCorrelationRisk(legs) {
  let risk = 0;

  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      const a = legs[i];
      const b = legs[j];
      const families = new Set([a.family, b.family]);

      if (families.has("games") && families.has("sets")) risk += 0.07;
      if (families.has("games") && families.has("tiebreak")) risk += 0.08;
      if (families.has("games") && families.has("aces")) risk += 0.04;
      if (families.has("tiebreak") && families.has("aces")) risk += 0.04;
      if (families.has("breaks") && families.has("sets")) risk += 0.04;
      if (families.has("winner") && families.has("player-breaks")) risk += 0.05;
      if (families.has("winner") && families.has("player-aces")) risk += 0.03;
    }
  }

  return clamp(risk, 0, 0.45);
}

function renderParlayLeg(leg, index) {
  return `
    <article class="parlay-leg">
      <div class="leg-index">${index + 1}</div>
      <div>
        <div class="model-name">${escapeHtml(leg.pick)}</div>
        <div class="model-meta">${escapeHtml(leg.market)} - ${escapeHtml(leg.category)}</div>
      </div>
      <div>
        <span class="model-meta">Model probability</span>
        <span class="pill">${percent(leg.probability)}</span>
      </div>
      <div>
        <span class="model-meta">Fair odds</span>
        <span class="pill">${leg.fairDecimalOdds}x / ${formatAmericanOdds(leg.fairAmericanOdds)}</span>
      </div>
      <small>${escapeHtml(leg.note)}</small>
    </article>
  `;
}

function renderParlayCandidate(candidate) {
  return `
    <article class="candidate-row">
      <div>
        <div class="model-name">${escapeHtml(candidate.pick)}</div>
        <div class="model-meta">${escapeHtml(candidate.market)} - ${escapeHtml(candidate.category)}</div>
      </div>
      <span class="pill">${percent(candidate.probability)}</span>
      <span class="pill">${candidate.fairDecimalOdds}x</span>
      <div class="bar" aria-label="${candidate.pick} confidence">
        <span style="--value: ${Math.round(candidate.confidence * 100)}%"></span>
      </div>
    </article>
  `;
}

function normalizeOddsPayload(payload) {
  const rawMarkets = Array.isArray(payload) ? payload : (payload?.markets || payload?.odds || []);
  const outcomes = [];

  rawMarkets.forEach((market, marketIndex) => {
    if (!market || typeof market !== "object") return;

    if (market.book && (market.odds !== undefined || market.price !== undefined)) {
      outcomes.push(normalizeOddsOutcome(market, market, marketIndex));
      return;
    }

    const books = market.books || market.bookmakers || [];
    books.forEach((book, bookIndex) => {
      const bookName = book.book || book.name || book.key || "Sportsbook";
      const bookMarkets = book.markets || book.outcomes || [];

      bookMarkets.forEach((bookMarket, bookMarketIndex) => {
        if (Array.isArray(bookMarket.outcomes)) {
          bookMarket.outcomes.forEach((outcome, outcomeIndex) => {
            outcomes.push(normalizeOddsOutcome({
              ...outcome,
              book: bookName,
              marketType: outcome.marketType || bookMarket.marketType || bookMarket.type,
              line: outcome.line ?? bookMarket.line,
              live: outcome.live ?? bookMarket.live ?? market.live
            }, market, `${marketIndex}-${bookIndex}-${bookMarketIndex}-${outcomeIndex}`));
          });
          return;
        }

        outcomes.push(normalizeOddsOutcome({
          ...bookMarket,
          book: bookName,
          live: bookMarket.live ?? market.live
        }, market, `${marketIndex}-${bookIndex}-${bookMarketIndex}`));
      });
    });
  });

  return outcomes.filter((outcome) => Number.isFinite(outcome.odds));
}

function normalizeOddsOutcome(outcome, market, index) {
  const marketType = normalizeMarketType(outcome.marketType || outcome.type || market.marketType || market.type || "moneyline");
  const selection = outcome.selection || outcome.name || outcome.player || outcome.side || "";
  const side = normalizeMarketSide(outcome.side || selection);
  const odds = Number(outcome.odds ?? outcome.price ?? outcome.americanOdds);

  return {
    id: String(outcome.id || `${market.matchId || market.eventId || "market"}-${index}`),
    matchId: String(outcome.matchId || market.matchId || market.eventId || market.id || ""),
    playerA: outcome.playerA || market.playerA || "",
    playerB: outcome.playerB || market.playerB || "",
    book: outcome.book || market.book || "Sportsbook",
    marketType,
    marketLabel: marketLabel(marketType, outcome.line ?? market.line),
    selection,
    selectionLabel: outcome.selectionLabel || selection || side.toUpperCase(),
    side,
    line: finiteNumber(outcome.line ?? market.line),
    odds,
    live: Boolean(outcome.live || market.live)
  };
}

function normalizeMarketType(value) {
  const text = String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["h2h", "match_winner", "winner", "money_line", "moneyline", "live_moneyline"].includes(text)) return text === "live_moneyline" ? "live_moneyline" : "moneyline";
  if (["total_games", "games_total", "match_total_games"].includes(text)) return "total_games";
  if (["tiebreak", "tie_break", "tie_break_played"].includes(text)) return "tiebreak";
  if (["sets", "total_sets", "match_sets"].includes(text)) return "sets";
  if (["aces", "total_aces", "match_aces"].includes(text)) return "aces";
  if (["breaks", "total_breaks", "breaks_of_serve"].includes(text)) return "breaks";
  return text || "moneyline";
}

function normalizeMarketSide(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["a", "player a", "home", "team1", "team 1"].includes(text)) return "a";
  if (["b", "player b", "away", "team2", "team 2"].includes(text)) return "b";
  if (text.includes("over")) return "over";
  if (text.includes("under")) return "under";
  if (["yes", "true"].includes(text)) return "yes";
  if (["no", "false"].includes(text)) return "no";
  return text;
}

function marketLabel(type, line) {
  const lineText = Number.isFinite(Number(line)) ? ` ${line}` : "";
  const labels = {
    moneyline: "Moneyline",
    live_moneyline: "Live moneyline",
    total_games: `Total games${lineText}`,
    tiebreak: "Tiebreak",
    sets: `Total sets${lineText}`,
    aces: `Total aces${lineText}`,
    breaks: `Total breaks${lineText}`
  };
  return labels[type] || type;
}

function findMatchForOdds(outcome) {
  if (outcome.matchId) {
    const byId = preloadedMatches.find((match) => String(match.id) === String(outcome.matchId));
    if (byId) return byId;
  }

  const a = normalizeName(outcome.playerA);
  const b = normalizeName(outcome.playerB);
  if (!a || !b) return null;

  return preloadedMatches.find((match) => (
    (normalizeName(match.playerA) === a && normalizeName(match.playerB) === b)
    || (normalizeName(match.playerA) === b && normalizeName(match.playerB) === a)
  )) || null;
}

function modelProbabilityForOutcome(match, run, outcome) {
  const type = outcome.marketType;

  if (type === "moneyline" || type === "live_moneyline") {
    const side = selectionSideForOutcome(match, outcome);
    if (type === "live_moneyline" && match.live && !match.completed) {
      const liveProbA = liveAdjustedProbability(match, run.ensemble.probA);
      if (side === "A") return liveProbA;
      if (side === "B") return 1 - liveProbA;
    }
    if (side === "A") return run.ensemble.probA;
    if (side === "B") return 1 - run.ensemble.probA;
    return NaN;
  }

  if (type === "total_games") {
    return overUnderProbability(run.ensemble.totalGames, outcome.line, outcome.side, Math.max((run.ensemble.gamesHigh - run.ensemble.gamesLow) / 3.2, 2.2));
  }

  if (type === "tiebreak") {
    if (outcome.side === "yes") return run.ensemble.tieBreakerProb;
    if (outcome.side === "no") return 1 - run.ensemble.tieBreakerProb;
  }

  if (type === "sets") {
    return overUnderProbability(run.ensemble.sets, outcome.line, outcome.side, 0.55);
  }

  if (type === "aces") {
    return overUnderProbability(run.ensemble.aces, outcome.line, outcome.side, Math.max(Math.sqrt(Math.max(run.ensemble.aces, 1)), 1.5));
  }

  if (type === "breaks") {
    return overUnderProbability(run.ensemble.breaks, outcome.line, outcome.side, Math.max(Math.sqrt(Math.max(run.ensemble.breaks, 1)) * 0.8, 1.1));
  }

  return NaN;
}

function selectionSideForOutcome(match, outcome) {
  if (outcome.side === "a") return "A";
  if (outcome.side === "b") return "B";

  const selection = normalizeName(outcome.selection || outcome.selectionLabel);
  if (selection && selection === normalizeName(match.playerA)) return "A";
  if (selection && selection === normalizeName(match.playerB)) return "B";
  return "";
}

function overUnderProbability(mean, line, side, sigma) {
  if (!Number.isFinite(Number(line))) return NaN;
  if (side === "over") return probabilityOverLine(mean, Number(line), sigma);
  if (side === "under") return probabilityUnderLine(mean, Number(line), sigma);
  return NaN;
}

function bestMoneylineBook(match, probA, liveOnly = false) {
  const rows = oddsMarkets
    .filter((outcome) => {
      if (liveOnly && !outcome.live) return false;
      if (!["moneyline", "live_moneyline"].includes(outcome.marketType)) return false;
      return findMatchForOdds(outcome)?.id === match.id;
    })
    .map((outcome) => {
      const side = selectionSideForOutcome(match, outcome);
      const probability = side === "A" ? probA : side === "B" ? 1 - probA : NaN;
      if (!Number.isFinite(probability)) return null;
      return {
        ...outcome,
        modelProbability: probability,
        impliedProbability: americanToImpliedProbability(outcome.odds),
        edge: probability - americanToImpliedProbability(outcome.odds),
        ev: expectedValue(probability, outcome.odds)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.ev - a.ev);

  return rows[0] || null;
}

function getModelRunForMatch(match, runs) {
  const performanceHash = hashString(JSON.stringify(state.performance));
  const key = `${match.id}:${runs}:${performanceHash}`;
  if (!oddsRunCache.has(key)) {
    oddsRunCache.set(key, buildEnsembleRun(match, runs));
  }
  return oddsRunCache.get(key);
}

function americanToImpliedProbability(odds) {
  const number = Number(odds);
  if (!Number.isFinite(number) || number === 0) return NaN;
  if (number > 0) return 100 / (number + 100);
  return Math.abs(number) / (Math.abs(number) + 100);
}

function profitPerDollar(odds) {
  const number = Number(odds);
  if (!Number.isFinite(number) || number === 0) return 0;
  if (number > 0) return number / 100;
  return 100 / Math.abs(number);
}

function expectedValue(probability, odds) {
  const profit = profitPerDollar(odds);
  return probability * profit - (1 - probability);
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function metricReliability(run, metricKey) {
  const weights = run.weights[metricKey] ?? {};
  let total = 0;
  let weighted = 0;

  MODEL_KEYS.forEach((modelKey) => {
    const weight = weights[modelKey] ?? 0;
    weighted += state.performance[modelKey][metricKey] * weight;
    total += weight;
  });

  if (total <= 0) {
    return MODEL_KEYS.reduce((sum, modelKey) => sum + state.performance[modelKey][metricKey], 0) / MODEL_KEYS.length;
  }

  return weighted / total;
}

function renderLearning() {
  const grid = document.getElementById("weights-grid");
  const currentWeightsGrid = document.getElementById("current-weights-grid");
  const changeList = document.getElementById("learning-change-list");
  if (!grid) return;

  const scored = state.history.length;
  const autoCount = state.autoScoredMatchIds?.length ?? 0;
  const baseStatus = scored
    ? `${scored} scored ${scored === 1 ? "match" : "matches"} in memory. ${autoCount} learned automatically.`
    : "No scored matches yet.";
  document.getElementById("learning-status").textContent = autoLearningMessage || baseStatus;

  if (currentWeightsGrid) {
    currentWeightsGrid.innerHTML = renderCurrentWeightCards();
  }

  grid.innerHTML = MODEL_DEFINITIONS.map((model) => {
    const performance = state.performance[model.key];
    const average = METRICS.reduce((sum, metric) => sum + performance[metric.key], 0) / METRICS.length;
    return `
      <article class="weight-card">
        <div class="weight-head">
          <div>
            <div class="weight-title">${escapeHtml(model.name)}</div>
            <div class="model-meta">${escapeHtml(model.style)}</div>
          </div>
          <span class="pill">${percent(average)}</span>
        </div>
        <div class="weight-metrics">
          ${METRICS.map((metric) => {
            const value = performance[metric.key];
            return `<span style="--alpha: ${round(0.12 + value * 0.58, 2)}">${metric.label}<br>${percent(value)}</span>`;
          }).join("")}
        </div>
      </article>
    `;
  }).join("");

  if (changeList) {
    changeList.innerHTML = renderLearningChangeCards();
  }
}

function renderCurrentWeightCards() {
  const weights = buildWeights();
  return METRICS.map((metric) => {
    const modelWeights = MODEL_DEFINITIONS
      .map((model) => ({
        model,
        weight: weights[metric.key]?.[model.key] ?? 0
      }))
      .sort((a, b) => b.weight - a.weight);
    const topModel = modelWeights[0];

    return `
      <article class="metric-weight-card">
        <div class="metric-weight-head">
          <div>
            <div class="weight-title">${escapeHtml(metric.label)}</div>
            <div class="model-meta">Top algorithm: ${escapeHtml(topModel.model.name)}</div>
          </div>
          <span class="pill">${percent(topModel.weight)}</span>
        </div>
        <div class="metric-weight-bars">
          ${modelWeights.map(({ model, weight }) => `
            <div class="metric-weight-row">
              <span>${escapeHtml(model.name)}</span>
              <div class="bar" aria-label="${model.name} ${metric.label} weight">
                <span style="--value: ${Math.round(weight * 100)}%"></span>
              </div>
              <span>${percent(weight)}</span>
            </div>
          `).join("")}
        </div>
      </article>
    `;
  }).join("");
}

function renderLearningChangeCards() {
  const events = state.learningEvents || [];
  if (!events.length) {
    return `<div class="empty-state">Weight changes will appear here after the app learns from finished matches or saved results.</div>`;
  }

  return events.slice(0, 12).map((event) => {
    const source = event.source === "auto" ? "Auto" : "Manual";
    const changes = Array.isArray(event.changes) ? event.changes.slice(0, 5) : [];
    return `
      <article class="learning-change-card">
        <div class="learning-change-head">
          <div>
            <div class="learning-change-title">${escapeHtml(event.matchLabel || "Learned match")}</div>
            <div class="model-meta">${source} learning - ${formatDate(event.createdAt)} - ${escapeHtml(event.metricsUsed || "available metrics")}</div>
          </div>
          <span class="pill">${changes.length} changes</span>
        </div>
        ${changes.length ? `
          <ul>
            ${changes.map((change) => `<li>${escapeHtml(change.reason)}</li>`).join("")}
          </ul>
        ` : `<div class="model-meta">The match was scored, but no model moved enough to call out.</div>`}
      </article>
    `;
  }).join("");
}

async function saveActualResult() {
  if (runInProgress) {
    setRunStatus("Wait for the current run to finish before saving a result.");
    return;
  }

  if (!latestRun && currentSimulationRuns() > BULK_MAX_SIMULATION_RUNS) {
    setRunStatus(`Run the ${formatRunCount(currentSimulationRuns())}-simulation ensemble before saving a result.`);
    return;
  }

  if (!latestRun) {
    await runEnsemble();
  }

  if (!latestRun) {
    setRunStatus("Run the ensemble before saving a result.");
    return;
  }

  const runToScore = latestRun;

  const actual = {
    winner: document.getElementById("actual-winner").value,
    totalGames: numberValue("actual-games", 0),
    tieBreaker: document.getElementById("actual-tiebreak").value === "true",
    sets: numberValue("actual-sets", 0),
    breaks: numberValue("actual-breaks", 0),
    aces: numberValue("actual-aces", 0)
  };

  const scorecard = scoreModels(runToScore.modelOutputs, actual);
  const learningAudit = applyLearning(scorecard);
  const learningEvent = buildLearningEvent({
    source: "manual",
    run: runToScore,
    actual,
    scorecard,
    learningAudit
  });
  recordLearningEvent(learningEvent);

  state.history.unshift({
    id: runToScore.id,
    createdAt: runToScore.createdAt,
    scoredAt: new Date().toISOString(),
    source: "manual",
    match: runToScore.match,
    ensemble: runToScore.ensemble,
    actual,
    scorecard,
    learningEventId: learningEvent.id
  });
  state.history = state.history.slice(0, HISTORY_LIMIT);
  persistState();
  applyLearnedProfilesToPreloadedMatches();

  runOrQueueEnsemble();
  renderHistory();
  activateTab("learning");
}

function scoreModels(outputs, actual) {
  return Object.fromEntries(outputs.map((output) => {
    const scores = {};
    if (actual.winner === "A" || actual.winner === "B") {
      scores.winner = binaryScore(output.probA, actual.winner === "A");
    }
    if (Number.isFinite(Number(actual.totalGames))) {
      scores.totalGames = numericScore(output.totalGames, actual.totalGames, "totalGames");
    }
    if (typeof actual.tieBreaker === "boolean") {
      scores.tieBreaker = binaryScore(output.tieBreakerProb, actual.tieBreaker);
    }
    if (Number.isFinite(Number(actual.sets))) {
      scores.sets = numericScore(output.sets, actual.sets, "sets");
    }
    if (Number.isFinite(Number(actual.breaks))) {
      scores.breaks = numericScore(output.breaks, actual.breaks, "breaks");
    }
    if (Number.isFinite(Number(actual.aces))) {
      scores.aces = numericScore(output.aces, actual.aces, "aces");
    }
    return [output.key, scores];
  }));
}

function applyLearning(scorecard, learningRate = 0.18) {
  const beforeWeights = buildWeights();
  MODEL_KEYS.forEach((modelKey) => {
    METRICS.forEach((metric) => {
      const previous = state.performance[modelKey][metric.key];
      const score = scorecard[modelKey][metric.key];
      if (!Number.isFinite(score)) return;
      state.performance[modelKey][metric.key] = clamp(previous * (1 - learningRate) + score * learningRate, 0.05, 0.98);
    });
  });
  const afterWeights = buildWeights();
  return buildLearningAudit(scorecard, beforeWeights, afterWeights, learningRate);
}

function buildLearningAudit(scorecard, beforeWeights, afterWeights, learningRate) {
  return METRICS.map((metric) => {
    const modelScores = MODEL_KEYS
      .map((modelKey) => scorecard[modelKey]?.[metric.key])
      .filter((score) => Number.isFinite(score));
    if (!modelScores.length) return null;

    const fieldAverage = modelScores.reduce((sum, score) => sum + score, 0) / modelScores.length;
    const changes = MODEL_DEFINITIONS
      .map((model) => {
        const score = scorecard[model.key]?.[metric.key];
        if (!Number.isFinite(score)) return null;

        const before = beforeWeights[metric.key]?.[model.key] ?? 0;
        const after = afterWeights[metric.key]?.[model.key] ?? 0;
        const delta = after - before;

        return {
          modelKey: model.key,
          modelName: model.name,
          metricKey: metric.key,
          metricLabel: metric.label,
          score,
          fieldAverage,
          before,
          after,
          delta,
          learningRate,
          reason: learningReason(model.name, metric.label, score, fieldAverage, before, after, delta)
        };
      })
      .filter(Boolean)
      .filter((change) => Math.abs(change.delta) >= 0.0005)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return {
      metricKey: metric.key,
      metricLabel: metric.label,
      fieldAverage,
      changes
    };
  }).filter(Boolean);
}

function learningReason(modelName, metricLabel, score, fieldAverage, before, after, delta) {
  const direction = delta >= 0 ? "up" : "down";
  const deltaText = formatSignedPercent(delta);
  const beforeText = percent(before);
  const afterText = percent(after);
  const scoreText = percent(score);
  const averageText = percent(fieldAverage);

  if (delta >= 0 && score >= fieldAverage) {
    return `${modelName} moved ${direction} on ${metricLabel} from ${beforeText} to ${afterText} (${deltaText}) because it scored ${scoreText}, above the model average of ${averageText}.`;
  }
  if (delta < 0 && score < fieldAverage) {
    return `${modelName} moved ${direction} on ${metricLabel} from ${beforeText} to ${afterText} (${deltaText}) because it scored ${scoreText}, below the model average of ${averageText}.`;
  }
  return `${modelName} moved ${direction} on ${metricLabel} from ${beforeText} to ${afterText} (${deltaText}) after the other algorithms shifted around a ${averageText} field score.`;
}

function buildLearningEvent({ source, run, actual, scorecard, learningAudit }) {
  const changes = learningAudit
    .flatMap((metric) => metric.changes)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 8);
  const metricsUsed = METRICS
    .filter((metric) => MODEL_KEYS.some((modelKey) => Number.isFinite(scorecard[modelKey]?.[metric.key])))
    .map((metric) => metric.label)
    .join(", ");

  return {
    id: makeId(),
    createdAt: new Date().toISOString(),
    source,
    matchLabel: `${run.match.playerA} vs ${run.match.playerB}`,
    actualWinner: actual.winner || "",
    metricsUsed,
    changes
  };
}

function recordLearningEvent(event) {
  state.learningEvents = [event, ...(state.learningEvents || [])].slice(0, LEARNING_EVENT_LIMIT);
}

function scheduleAutoLearning() {
  if (autoLearningInProgress) return;
  const eligible = unlearnedFinishedMatches();
  if (!eligible.length) {
    autoLearningMessage = "";
    renderLearning();
    return;
  }

  autoLearningInProgress = true;
  autoLearningMessage = `Auto-learning from ${eligible.length} finished ${eligible.length === 1 ? "match" : "matches"} with ${formatRunCount(bulkSimulationRuns())} runs...`;
  renderLearning();
  window.setTimeout(processAutoLearningChunk, 40);
}

function processAutoLearningChunk() {
  const eligible = unlearnedFinishedMatches();
  const runs = bulkSimulationRuns();
  const batch = eligible.slice(0, autoLearningChunkSize(runs));
  let learned = 0;

  batch.forEach((match) => {
    const actual = actualFromFinishedMatch(match);
    if (!actual) return;

    const run = buildEnsembleRun(match, runs);
    const scorecard = scoreModels(run.modelOutputs, actual);
    const learningAudit = applyLearning(scorecard, AUTO_LEARNING_RATE);
    const learningEvent = buildLearningEvent({
      source: "auto",
      run,
      actual,
      scorecard,
      learningAudit
    });
    recordLearningEvent(learningEvent);

    const key = autoLearningKey(match);
    state.history.unshift({
      id: key,
      createdAt: run.createdAt,
      scoredAt: new Date().toISOString(),
      source: "auto",
      match: run.match,
      ensemble: run.ensemble,
      actual,
      scorecard,
      learningEventId: learningEvent.id
    });
    state.autoScoredMatchIds.unshift(key);
    learned += 1;
  });

  state.autoScoredMatchIds = Array.from(new Set(state.autoScoredMatchIds)).slice(0, AUTO_SCORED_LIMIT);
  state.history = state.history.slice(0, HISTORY_LIMIT);
  persistState();
  applyLearnedProfilesToPreloadedMatches();

  const remaining = unlearnedFinishedMatches().length;
  autoLearningMessage = remaining
    ? `Auto-learned ${learned} more using ${formatRunCount(runs)} runs. ${remaining} finished ${remaining === 1 ? "match" : "matches"} left in this slate.`
    : `Auto-learning complete using ${formatRunCount(runs)} runs. ${state.autoScoredMatchIds.length} finished ${state.autoScoredMatchIds.length === 1 ? "match" : "matches"} learned.`;
  renderLearning();
  renderHistory();

  if (remaining) {
    window.setTimeout(processAutoLearningChunk, 60);
    return;
  }

  autoLearningInProgress = false;
  runOrQueueEnsemble();
  window.setTimeout(() => {
    autoLearningMessage = "";
    renderLearning();
  }, 1800);
}

function unlearnedFinishedMatches() {
  const learned = new Set(state.autoScoredMatchIds || []);
  return preloadedMatches.filter((match) => {
    const actual = actualFromFinishedMatch(match);
    return actual && !learned.has(autoLearningKey(match));
  });
}

function actualFromFinishedMatch(match) {
  if (!match.completed) return null;
  const actual = normalizeActualResult(match.actual || {}, match.winnerSide);
  if (!actual.winner) return null;

  const metricCount = ["winner", "totalGames", "tieBreaker", "sets", "breaks", "aces"]
    .filter((key) => actual[key] !== undefined).length;
  return metricCount ? actual : null;
}

function autoLearningKey(match) {
  return `auto:${match.id}:${match.winnerSide || match.actual?.winner || ""}:${match.scoreline || match.startTime}`;
}

function binaryScore(probability, happened) {
  const target = happened ? 1 : 0;
  const brier = Math.pow(probability - target, 2);
  return clamp(1 - brier, 0, 1);
}

function numericScore(predicted, actual, metricKey) {
  const metric = METRICS.find((item) => item.key === metricKey);
  const scale = metric?.scale ?? 10;
  return clamp(1 - Math.abs(predicted - actual) / scale, 0, 1);
}

function renderHistory() {
  const list = document.getElementById("history-list");
  if (!state.history.length) {
    list.innerHTML = `<div class="empty-state">Saved results will appear here.</div>`;
    return;
  }

  list.innerHTML = state.history.map((entry) => {
    const actualWinner = entry.actual.winner === "A" ? entry.match.playerA : entry.match.playerB;
    const predicted = entry.ensemble.winner;
    const correct = actualWinner === predicted;
    const source = entry.source === "auto" ? "Auto-learned" : "Manual";
    const games = Number.isFinite(Number(entry.actual.totalGames))
      ? `${round(entry.actual.totalGames, 0)} games`
      : (entry.actual.scoreline || "Final learned");
    return `
      <article class="history-row">
        <div>
          <div class="history-title">${escapeHtml(entry.match.playerA)} vs ${escapeHtml(entry.match.playerB)}</div>
          <div class="history-meta">${source} - ${formatDate(entry.scoredAt)} - ${escapeHtml(entry.match.surface)} - ${entry.match.format === 5 ? "Best of 5" : "Best of 3"}</div>
        </div>
        <span class="pill">${correct ? "Winner hit" : "Winner miss"}</span>
        <span class="pill">${escapeHtml(games)}</span>
      </article>
    `;
  }).join("");
}

function clearHistory() {
  state.history = [];
  state.autoScoredMatchIds = [];
  state.learningEvents = [];
  autoLearningMessage = "";
  persistState();
  applyLearnedProfilesToPreloadedMatches();
  runOrQueueEnsemble();
  renderMatchBoard();
  renderPlayerData();
  renderHistory();
  renderLearning();
}

function resetLearning() {
  state = { performance: cloneDefaultPerformance(), history: [], autoScoredMatchIds: [], learningEvents: [] };
  autoLearningMessage = "";
  persistState();
  applyLearnedProfilesToPreloadedMatches();
  runOrQueueEnsemble();
  renderMatchBoard();
  renderPlayerData();
  renderLearning();
  renderHistory();
}

function loadSampleMatch() {
  const matches = getSortedMatches();
  const sample = matches[Math.floor(Math.random() * matches.length)] ?? preloadedMatches[0];
  if (!sample) return;

  selectedMatchId = sample.id;
  loadMatchIntoForm(sample);
  renderMatchBoard();
  renderPlayerData();
  runOrQueueEnsemble();
}

function halfLineBelow(mean, cushion) {
  return Math.max(0.5, Math.floor(mean - cushion) + 0.5);
}

function halfLineAbove(mean, cushion) {
  return Math.max(0.5, Math.ceil(mean + cushion) - 0.5);
}

function probabilityOverLine(mean, line, sigma) {
  return clamp(1 - normalCdf((line - mean) / Math.max(sigma, 0.1)), 0.01, 0.99);
}

function probabilityUnderLine(mean, line, sigma) {
  return clamp(normalCdf((line - mean) / Math.max(sigma, 0.1)), 0.01, 0.99);
}

function logit(value) {
  const safe = clamp(value, 0.0001, 0.9999);
  return Math.log(safe / (1 - safe));
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.sqrt(2)));
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function probabilityToDecimalOdds(probability) {
  return round(1 / clamp(probability, 0.0001, 0.9999), 2);
}

function probabilityToAmericanOdds(probability) {
  const safeProbability = clamp(probability, 0.0001, 0.9999);
  if (safeProbability >= 0.5) {
    return Math.round(-100 * safeProbability / (1 - safeProbability));
  }
  return Math.round(100 * (1 - safeProbability) / safeProbability);
}

function formatAmericanOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function formatSignedPercent(value) {
  const percentValue = round(value * 100, 1);
  return `${value >= 0 ? "+" : ""}${percentValue}%`;
}

function formatRunCount(value) {
  return Math.round(Number(value) || 0).toLocaleString();
}

function formatLine(value) {
  return Number(value).toFixed(1);
}

function levelRank(level) {
  return LEVEL_PRIORITY[level] ?? 99;
}

function formatMatchTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "TBD";

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatSlateDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function surfaceProfile(surface) {
  const profiles = {
    Clay: { pace: -0.24, aceMultiplier: 0.78, holdWeight: 0.82, aceWeight: 0.38, aceLift: -0.04, breakLift: 0.22, tieLift: -0.12 },
    Grass: { pace: 0.28, aceMultiplier: 1.24, holdWeight: 1.12, aceWeight: 0.72, aceLift: 0.08, breakLift: -0.18, tieLift: 0.2 },
    Indoor: { pace: 0.18, aceMultiplier: 1.15, holdWeight: 1.02, aceWeight: 0.64, aceLift: 0.05, breakLift: -0.08, tieLift: 0.14 },
    Hard: { pace: 0.04, aceMultiplier: 1, holdWeight: 1, aceWeight: 0.52, aceLift: 0, breakLift: 0, tieLift: 0.02 }
  };
  return profiles[surface] ?? profiles.Hard;
}

function contextProfile(match) {
  const fatigueEdge = (match.fatigueB - match.fatigueA) / 260;
  const injuryEdge = (match.injuryB - match.injuryA) / 180;
  const weather = clamp(match.weatherFactor, -10, 10);
  const badConditions = Math.max(0, -weather);
  const fastConditions = Math.max(0, weather);

  return {
    winEdge: fatigueEdge * 0.45 + injuryEdge * 0.7,
    paceLift: fastConditions * 0.12 - badConditions * 0.16,
    tieLift: fastConditions * 0.012 - badConditions * 0.018,
    breakLift: badConditions * 0.15 + (match.fatigueA + match.fatigueB + match.injuryA + match.injuryB) / 190,
    aceLift: fastConditions * 0.45 - badConditions * 0.55 - (match.injuryA + match.injuryB) / 30
  };
}

function normalizeRankEdge(rankA, rankB) {
  const safeA = Math.max(1, rankA);
  const safeB = Math.max(1, rankB);
  return clamp((Math.log(safeB + 1) - Math.log(safeA + 1)) / 4.8, -0.7, 0.7);
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}

function normal(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function round(value, decimals) {
  return Number(value).toFixed(decimals);
}

function numberValue(id, fallback) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) ? value : fallback;
}

function textValue(id, fallback) {
  const value = document.getElementById(id).value.trim();
  return value || fallback;
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function setFormValue(id, value) {
  document.getElementById(id).value = value;
}

function syncActualWinnerOptions(match) {
  const select = document.getElementById("actual-winner");
  select.options[0].textContent = match.playerA;
  select.options[1].textContent = match.playerB;
}

function cloneDefaultPerformance() {
  return JSON.parse(JSON.stringify(DEFAULT_PERFORMANCE));
}

function makeId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `match-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;

  navigator.serviceWorker.register("service-worker.js").catch(() => {
    // Local browser settings can block service workers during early prototyping.
  });
}
