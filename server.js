const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);

// =====================================================
// ENVIRONMENT
// =====================================================

const NODE_ENV =
  process.env.NODE_ENV || "development";

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const DATAMART_API_KEY =
  process.env.DATAMART_API_KEY || "";

const DATAMART_API_SECRET =
  process.env.DATAMART_API_SECRET || "";

const DATAMART_REF_PREFIX =
  String(
    process.env.DATAMART_REF_PREFIX || "dgm-"
  ).trim();

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "dgm-change-this-secret";

const BASE_URL =
  process.env.BASE_URL ||
  "https://dhe-genius-media.onrender.com";

const RESEND_API_KEY =
  process.env.RESEND_API_KEY || "";

const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ||
  "DHE GENIUS MEDIA <onboarding@resend.dev>";

const RESET_EMAIL_PROVIDER =
  String(process.env.RESET_EMAIL_PROVIDER || "resend")
    .trim()
    .toLowerCase();

const RESET_TEST_MODE =
  String(process.env.RESET_TEST_MODE || "false").toLowerCase() === "true";

const SMTP_HOST =
  String(process.env.SMTP_HOST || "").trim();

const SMTP_PORT =
  Number(process.env.SMTP_PORT || 465);

const SMTP_SECURE =
  String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";

const SMTP_USER =
  String(process.env.SMTP_USER || "").trim();

const SMTP_PASSWORD =
  String(process.env.SMTP_PASSWORD || "");

const SMTP_FROM_EMAIL =
  String(
    process.env.SMTP_FROM_EMAIL ||
      SMTP_USER ||
      ""
  ).trim();

const DGM_API_KEY =
  process.env.DGM_API_KEY || "";

// =====================================================
// KINGFLEXY AIRTIME API
// =====================================================

const KINGFLEXY_API_KEY =
  process.env.KINGFLEXY_API_KEY || "";

const KINGFLEXY_API_BASE =
  String(
    process.env.KINGFLEXY_API_BASE ||
      "https://api.kingflexygh.com/api/v2"
  ).replace(/\/$/, "");

// KingFlexy Airtime is a Commission Services API.
// The provider requires a kf_cs_live_* key for /airtime/*.
const KINGFLEXY_AIRTIME_KEY_TYPE =
  String(KINGFLEXY_API_KEY || "").startsWith("kf_cs_live_")
    ? "commission_services"
    : String(KINGFLEXY_API_KEY || "").startsWith("kf_live_")
      ? "standard"
      : "unknown";

function kingflexyAirtimeNetwork(network) {
  const value = String(network || "").trim();

  if (value === "AirtelTigo") return "AT";
  if (value === "AT-iShare") return "AT";
  if (value === "AT-BigTime") return "AT";

  return value;
}

const FOOTBALL_DATA_API_TOKEN = process.env.SPORTS_API_KEY || process.env.FOOTBALL_DATA_API_TOKEN || "";
const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const FOOTBALL_DATA_COMPETITIONS = {
  39: "PL",
  140: "PD",
  135: "SA",
  78: "BL1",
  61: "FL1"
};
const footballDataCache = new Map();

async function footballDataRequest(path, params = {}) {
  if (!FOOTBALL_DATA_API_TOKEN) {
    const error = new Error("Football data is not configured yet. Add FOOTBALL_DATA_API_TOKEN in Render environment variables.");
    error.status = 503;
    throw error;
  }

  const url = new URL(FOOTBALL_DATA_BASE + path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_API_TOKEN,
        "X-Unfold-Goals": "true",
        Accept: "application/json"
      },
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!response.ok) {
      const error = new Error(
        "Football-Data HTTP " + response.status + ": " +
        (data?.message || data?.errorCode || "Request failed")
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Football data request timed out.");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeFootballDataMatch(match) {
  const m = match || {};
  const statusMap = {
    SCHEDULED: { short: "NS", long: "Not Started", elapsed: null },
    TIMED: { short: "NS", long: "Scheduled", elapsed: null },
    IN_PLAY: { short: "LIVE", long: "In Play", elapsed: m.minute ?? null },
    PAUSED: { short: "HT", long: "Half Time", elapsed: m.minute ?? 45 },
    FINISHED: { short: "FT", long: "Match Finished", elapsed: 90 },
    POSTPONED: { short: "PST", long: "Postponed", elapsed: null },
    SUSPENDED: { short: "SUSP", long: "Suspended", elapsed: null },
    CANCELLED: { short: "CANC", long: "Cancelled", elapsed: null }
  };
  const status = statusMap[m.status] || { short: m.status || "NS", long: m.status || "Scheduled", elapsed: null };
  return {
    fixture: {
      id: m.id,
      date: m.utcDate,
      timestamp: m.utcDate ? Math.floor(new Date(m.utcDate).getTime() / 1000) : null,
      status,
      venue: { name: m.venue || null }
    },
    league: {
      id: m.competition?.id,
      name: m.competition?.name,
      code: m.competition?.code,
      emblem: m.competition?.emblem
    },
    teams: {
      home: {
        id: m.homeTeam?.id,
        name: m.homeTeam?.name,
        shortName: m.homeTeam?.shortName,
        logo: m.homeTeam?.crest
      },
      away: {
        id: m.awayTeam?.id,
        name: m.awayTeam?.name,
        shortName: m.awayTeam?.shortName,
        logo: m.awayTeam?.crest
      }
    },
    goals: {
      home: m.score?.fullTime?.home ?? null,
      away: m.score?.fullTime?.away ?? null
    },
    score: {
      fulltime: {
        home: m.score?.fullTime?.home ?? null,
        away: m.score?.fullTime?.away ?? null
      },
      halftime: {
        home: m.score?.halfTime?.home ?? null,
        away: m.score?.halfTime?.away ?? null
      }
    },
    status: status
  };
}

function footballDataCompetitionCode(league) {
  return FOOTBALL_DATA_COMPETITIONS[Number(league)] || String(league || "").trim();
}

async function getCachedCompetitionTeams(code) {
  const cached = footballDataCache.get("teams:" + code);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const data = await footballDataRequest("/competitions/" + encodeURIComponent(code) + "/teams");
  const teams = data.teams || [];
  footballDataCache.set("teams:" + code, { value: teams, expiresAt: Date.now() + 30 * 60 * 1000 });
  return teams;
}

function sendSportsApiError(res, error) {
  const status = Number.isInteger(error.status) && error.status >= 400 ? error.status : 500;
  return res.status(status).json({
    success: false,
    provider: "Football-Data.org",
    configured: Boolean(FOOTBALL_DATA_API_TOKEN),
    message: error.message || "Sports data request failed."
  });
}

// =====================================================
// LIVE SPORTS API — FOOTBALL-DATA.ORG
// =====================================================

app.get("/api/sports/status", (req, res) => {
  res.json({
    success: true,
    provider: "Football-Data.org",
    configured: Boolean(FOOTBALL_DATA_API_TOKEN),
    competitions: FOOTBALL_DATA_COMPETITIONS,
    updated_at: new Date().toISOString()
  });
});

app.get("/api/sports/live", async (req, res) => {
  try {
    const codes = Object.values(FOOTBALL_DATA_COMPETITIONS);
    const results = await Promise.all(
      codes.map(code => footballDataRequest("/competitions/" + code + "/matches", { status: "IN_PLAY" }).catch(() => ({ matches: [] })))
    );
    const matches = results.flatMap(data => (data.matches || []).map(normalizeFootballDataMatch));
    return res.json({
      success: true,
      provider: "Football-Data.org",
      updated_at: new Date().toISOString(),
      count: matches.length,
      matches
    });
  } catch (error) {
    console.error("Football-Data live error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/fixtures", async (req, res) => {
  try {
    const requestedDate = String(req.query.date || "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
      ? requestedDate
      : new Date().toISOString().slice(0, 10);

    const codes = Object.values(FOOTBALL_DATA_COMPETITIONS);
    const results = await Promise.all(
      codes.map(code => footballDataRequest("/competitions/" + code + "/matches", {
        dateFrom: date,
        dateTo: date
      }).catch(() => ({ matches: [] })))
    );
    const matches = results.flatMap(data => (data.matches || []).map(normalizeFootballDataMatch));

    return res.json({
      success: true,
      provider: "Football-Data.org",
      date,
      updated_at: new Date().toISOString(),
      count: matches.length,
      matches
    });
  } catch (error) {
    console.error("Football-Data fixtures error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/teams", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    if (search.length < 3) {
      return res.status(400).json({ success: false, message: "Enter at least 3 characters to search teams." });
    }

    const allTeams = [];
    for (const code of Object.values(FOOTBALL_DATA_COMPETITIONS)) {
      try {
        allTeams.push(...await getCachedCompetitionTeams(code));
      } catch {}
    }

    const seen = new Set();
    const teams = allTeams
      .filter(team => {
        const key = team.id || team.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return String(team.name || "").toLowerCase().includes(search.toLowerCase()) ||
          String(team.shortName || "").toLowerCase().includes(search.toLowerCase());
      })
      .slice(0, 20)
      .map(team => ({
        team: {
          id: team.id,
          name: team.name,
          shortName: team.shortName,
          tla: team.tla,
          logo: team.crest,
          country: team.area?.name,
          founded: team.founded,
          national: false
        },
        venue: { name: team.venue || null }
      }));

    return res.json({
      success: true,
      provider: "Football-Data.org",
      search,
      count: teams.length,
      teams
    });
  } catch (error) {
    console.error("Football-Data team search error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/team/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "A valid team ID is required." });
    }
    const data = await footballDataRequest("/teams/" + id);
    return res.json({
      success: true,
      provider: "Football-Data.org",
      team: {
        id: data.id,
        name: data.name,
        shortName: data.shortName,
        tla: data.tla,
        logo: data.crest,
        country: data.area?.name,
        founded: data.founded,
        national: false
      },
      venue: { name: data.venue || null }
    });
  } catch (error) {
    console.error("Football-Data team detail error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/standings", async (req, res) => {
  try {
    const league = Number(req.query.league || 39);
    const code = footballDataCompetitionCode(league);
    if (!code) {
      return res.status(400).json({ success: false, message: "A valid league is required." });
    }

    const data = await footballDataRequest("/competitions/" + encodeURIComponent(code) + "/standings");
    const standings = (data.standings || []).map(item => ({
      league: {
        id: data.competition?.id,
        name: data.competition?.name,
        code: data.competition?.code,
        emblem: data.competition?.emblem
      },
      group: (item.table || []).map(row => ({
        rank: row.position,
        team: {
          id: row.team?.id,
          name: row.team?.name,
          logo: row.team?.crest
        },
        points: row.points,
        goalsDiff: row.goalDifference,
        all: {
          played: row.playedGames,
          win: row.won,
          draw: row.draw,
          lose: row.lost,
          goals: { for: row.goalsFor, against: row.goalsAgainst }
        }
      }))
    }));

    return res.json({
      success: true,
      provider: "Football-Data.org",
      league,
      season: data.season?.startDate ? Number(data.season.startDate.slice(0, 4)) : null,
      updated_at: new Date().toISOString(),
      standings
    });
  } catch (error) {
    console.error("Football-Data standings error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/match/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "A valid fixture ID is required." });
    }

    const data = await footballDataRequest("/matches/" + id);
    if (!data || !data.id) {
      return res.status(404).json({
        success: false,
        provider: "Football-Data.org",
        message: "Match not found."
      });
    }

    const match = normalizeFootballDataMatch(data);
    const events = (data.goals || []).map(goal => ({
      time: { elapsed: goal.minute },
      team: { id: goal.team?.id, name: goal.team?.name },
      player: { name: goal.scorer?.name },
      assist: { name: goal.assist?.name },
      type: "Goal",
      detail: goal.type || "Normal Goal"
    }));

    return res.json({
      success: true,
      provider: "Football-Data.org",
      updated_at: new Date().toISOString(),
      match,
      events,
      statistics: [],
      lineups: []
    });
  } catch (error) {
    console.error("Football-Data match detail error:", error.message);
    return sendSportsApiError(res, error);
  }
});

// =====================================================
// YOUTUBE INTEGRATION
// =====================================================

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "";
const YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3";

async function youtubeRequest(endpoint, params = {}) {
  if (!YOUTUBE_API_KEY) {
    const error = new Error("YouTube integration is not configured yet. Add YOUTUBE_API_KEY in Render environment variables.");
    error.status = 503;
    throw error;
  }
  const url = new URL(YOUTUBE_BASE + endpoint);
  Object.entries({ ...params, key: YOUTUBE_API_KEY }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error("YouTube API HTTP " + response.status + ": " + (data?.error?.message || "Request failed"));
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("YouTube API request timed out.");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally { clearTimeout(timeout); }
}

function normalizeYoutubeVideo(item) {
  const snippet = item?.snippet || {};
  const resourceId = item?.contentDetails?.videoId || item?.id?.videoId || item?.id || "";
  return {
    id: resourceId,
    title: snippet.title || "",
    description: snippet.description || "",
    published_at: snippet.publishedAt || "",
    channel_id: snippet.channelId || YOUTUBE_CHANNEL_ID,
    channel_title: snippet.channelTitle || "",
    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
    watch_url: resourceId ? "https://www.youtube.com/watch?v=" + encodeURIComponent(resourceId) : "",
    embed_url: resourceId ? "https://www.youtube.com/embed/" + encodeURIComponent(resourceId) : ""
  };
}

app.get("/api/youtube/status", (req, res) => {
  res.json({
    success: true,
    provider: "YouTube Data API v3",
    configured: Boolean(YOUTUBE_API_KEY),
    channel_configured: Boolean(YOUTUBE_CHANNEL_ID)
  });
});

app.get("/api/youtube/videos", async (req, res) => {
  try {
    const channelId = String(req.query.channel_id || YOUTUBE_CHANNEL_ID).trim();
    if (!channelId) return res.status(400).json({ success: false, message: "YOUTUBE_CHANNEL_ID is not configured." });
    const maxResults = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    const data = await youtubeRequest("/search", { part: "snippet", channelId, order: "date", type: "video", maxResults });
    return res.json({
      success: true,
      provider: "YouTube Data API v3",
      channel_id: channelId,
      count: (data.items || []).length,
      videos: (data.items || []).map(normalizeYoutubeVideo)
    });
  } catch (error) {
    console.error("YouTube videos error:", error.message);
    return res.status(Number(error.status) || 500).json({ success: false, provider: "YouTube Data API v3", message: error.message || "YouTube request failed." });
  }
});

app.get("/api/youtube/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (query.length < 2) return res.status(400).json({ success: false, message: "Enter at least 2 characters to search YouTube." });
    const maxResults = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    const data = await youtubeRequest("/search", { part: "snippet", q: query, type: "video", maxResults });
    return res.json({ success: true, provider: "YouTube Data API v3", query, count: (data.items || []).length, videos: (data.items || []).map(normalizeYoutubeVideo) });
  } catch (error) {
    console.error("YouTube search error:", error.message);
    return res.status(Number(error.status) || 500).json({ success: false, provider: "YouTube Data API v3", message: error.message || "YouTube search failed." });
  }
});

app.get("/api/youtube/live", async (req, res) => {
  try {
    const channelId = String(req.query.channel_id || YOUTUBE_CHANNEL_ID).trim();
    if (!channelId) return res.status(400).json({ success: false, message: "YOUTUBE_CHANNEL_ID is not configured." });
    const data = await youtubeRequest("/search", { part: "snippet", channelId, eventType: "live", type: "video", maxResults: 10 });
    return res.json({ success: true, provider: "YouTube Data API v3", channel_id: channelId, count: (data.items || []).length, live: (data.items || []).map(normalizeYoutubeVideo) });
  } catch (error) {
    console.error("YouTube live error:", error.message);
    return res.status(Number(error.status) || 500).json({ success: false, provider: "YouTube Data API v3", message: error.message || "YouTube live request failed." });
  }
});

// =====================================================
// APP CONFIG
// =====================================================

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

const loginAttempts = new Map();
function loginRateLimit(req,res,next) {
  const key = String(req.ip || "unknown").replace(/::ffff:/g,"");
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count:0, resetAt:now + 15*60*1000 };
  if (now > entry.resetAt) { entry.count=0; entry.resetAt=now + 15*60*1000; }
  if (entry.count >= 10) {
    return res.status(429).json({success:false,message:"Too many login attempts. Please wait 15 minutes and try again."});
  }
  req._loginRateKey = key;
  req._loginRateEntry = entry;
  next();
}
function recordLoginFailure(req) {
  if (!req._loginRateKey || !req._loginRateEntry) return;
  req._loginRateEntry.count += 1;
  loginAttempts.set(req._loginRateKey, req._loginRateEntry);
}
function clearLoginFailures(req) {
  if (req._loginRateKey) loginAttempts.delete(req._loginRateKey);
}

app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy","geolocation=(),camera=(),microphone=()");
  if (NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
  }
  next();
});


// =====================================================
// TMDB MOVIE DISCOVERY
// =====================================================

const TMDB_API_KEY =
  process.env.TMDB_API_KEY || "";

const TMDB_BASE =
  "https://api.themoviedb.org/3";

const TMDB_IMAGE_BASE =
  "https://image.tmdb.org/t/p";

async function tmdbRequest(endpoint, params = {}) {
  if (!TMDB_API_KEY) {
    const error = new Error("TMDB_API_KEY is not configured.");
    error.status = 503;
    throw error;
  }

  const url = new URL(TMDB_BASE + endpoint);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  url.searchParams.set("api_key", TMDB_API_KEY);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(
        `TMDB HTTP ${response.status}: ${data.status_message || data.message || "Request failed"}`
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("TMDB request timed out.");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function tmdbMovie(movie) {
  return {
    id: movie.id,
    title: movie.title || movie.name || "",
    original_title: movie.original_title || movie.original_name || "",
    overview: movie.overview || "",
    poster_path: movie.poster_path || null,
    backdrop_path: movie.backdrop_path || null,
    poster_url: movie.poster_path
      ? `${TMDB_IMAGE_BASE}/w500${movie.poster_path}`
      : null,
    backdrop_url: movie.backdrop_path
      ? `${TMDB_IMAGE_BASE}/w1280${movie.backdrop_path}`
      : null,
    release_date: movie.release_date || "",
    rating: Number(movie.vote_average || 0),
    vote_count: Number(movie.vote_count || 0),
    popularity: Number(movie.popularity || 0),
    adult: Boolean(movie.adult),
    genre_ids: Array.isArray(movie.genre_ids) ? movie.genre_ids : []
  };
}

function tmdbDetail(movie) {
  const base = tmdbMovie(movie);

  return {
    ...base,
    runtime: movie.runtime || null,
    tagline: movie.tagline || "",
    genres: Array.isArray(movie.genres)
      ? movie.genres.map((genre) => ({
          id: genre.id,
          name: genre.name
        }))
      : [],
    homepage: movie.homepage || "",
    status: movie.status || "",
    budget: Number(movie.budget || 0),
    revenue: Number(movie.revenue || 0),
    production_companies: Array.isArray(movie.production_companies)
      ? movie.production_companies.map((company) => ({
          id: company.id,
          name: company.name,
          logo_path: company.logo_path || null
        }))
      : []
  };
}

function sendMovieApiError(res, error) {
  const status =
    Number.isInteger(error.status) && error.status >= 400
      ? error.status
      : 500;

  return res.status(status).json({
    success: false,
    message:
      status === 503
        ? "Movie discovery is not configured yet. Add TMDB_API_KEY in Render environment variables."
        : error.message || "Movie service request failed."
  });
}

// =====================================================
// MOVIE API
// =====================================================

app.get("/api/movies/status", (req, res) => {
  res.json({
    success: true,
    provider: "TMDB",
    configured: Boolean(TMDB_API_KEY)
  });
});

app.get("/api/movies/genres", async (req, res) => {
  try {
    const data = await tmdbRequest("/genre/movie/list", {
      language: "en-US"
    });

    return res.json({
      success: true,
      provider: "TMDB",
      genres: (data.genres || []).map((genre) => ({
        id: genre.id,
        name: genre.name
      }))
    });
  } catch (error) {
    console.error("TMDB genres error:", error.message);
    return sendMovieApiError(res, error);
  }
});

app.get("/api/movies/discover", async (req, res) => {
  try {
    const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 20);
    const genre = String(req.query.genre || "").trim();
    const sort = String(req.query.sort || "popularity.desc").trim();

    const allowedSorts = new Set([
      "popularity.desc",
      "vote_average.desc",
      "primary_release_date.desc",
      "primary_release_date.asc",
      "revenue.desc"
    ]);

    const data = await tmdbRequest("/discover/movie", {
      language: "en-US",
      include_adult: false,
      include_video: true,
      page,
      sort_by: allowedSorts.has(sort) ? sort : "popularity.desc",
      with_genres: /^\d+$/.test(genre) ? genre : undefined,
      "vote_count.gte": sort === "vote_average.desc" ? 150 : undefined
    });

    return res.json({
      success: true,
      provider: "TMDB",
      page: data.page || page,
      total_pages: Math.min(data.total_pages || 0, 20),
      total_results: data.total_results || 0,
      results: (data.results || [])
        .filter((movie) => !movie.adult)
        .map(tmdbMovie)
    });
  } catch (error) {
    console.error("TMDB discover error:", error.message);
    return sendMovieApiError(res, error);
  }
});

app.get("/api/movies/recommendations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid movie ID is required."
      });
    }

    const data = await tmdbRequest("/movie/" + id + "/recommendations", {
      language: "en-US",
      page: 1
    });

    return res.json({
      success: true,
      provider: "TMDB",
      results: (data.results || [])
        .filter((movie) => !movie.adult)
        .map(tmdbMovie)
        .slice(0, 12)
    });
  } catch (error) {
    console.error("TMDB recommendations error:", error.message);
    return sendMovieApiError(res, error);
  }
});

app.get("/api/movies/home", async (req, res) => {
  try {
    const [trending, popular, nowPlaying, upcoming] =
      await Promise.all([
        tmdbRequest("/trending/movie/week"),
        tmdbRequest("/movie/popular", {
          language: "en-US",
          page: 1
        }),
        tmdbRequest("/movie/now_playing", {
          language: "en-US",
          page: 1
        }),
        tmdbRequest("/movie/upcoming", {
          language: "en-US",
          page: 1
        })
      ]);

    res.json({
      success: true,
      provider: "TMDB",
      updated_at: new Date().toISOString(),
      sections: {
        trending: (trending.results || [])
          .filter((movie) => !movie.adult)
          .map(tmdbMovie),
        popular: (popular.results || [])
          .filter((movie) => !movie.adult)
          .map(tmdbMovie),
        now_playing: (nowPlaying.results || [])
          .filter((movie) => !movie.adult)
          .map(tmdbMovie),
        upcoming: (upcoming.results || [])
          .filter((movie) => !movie.adult)
          .map(tmdbMovie)
      }
    });
  } catch (error) {
    console.error("TMDB home error:", error.message);
    return sendMovieApiError(res, error);
  }
});

app.get("/api/movies/search", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();
    const page = Math.min(
      Math.max(Number(req.query.page) || 1, 1),
      10
    );

    if (query.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Enter at least 2 characters to search for a movie."
      });
    }

    const data = await tmdbRequest("/search/movie", {
      query,
      language: "en-US",
      include_adult: false,
      page
    });

    res.json({
      success: true,
      provider: "TMDB",
      query,
      page: data.page || page,
      total_pages: data.total_pages || 0,
      total_results: data.total_results || 0,
      results: (data.results || [])
        .filter((movie) => !movie.adult)
        .map(tmdbMovie)
    });
  } catch (error) {
    console.error("TMDB search error:", error.message);
    return sendMovieApiError(res, error);
  }
});

app.get("/api/movies/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid movie ID is required."
      });
    }

    const movie = await tmdbRequest(`/movie/${id}`, {
      language: "en-US"
    });

    if (movie.adult) {
      return res.status(404).json({
        success: false,
        message: "Movie not found."
      });
    }

    const [credits, videos, watchProviders] =
      await Promise.all([
        tmdbRequest(`/movie/${id}/credits`, {
          language: "en-US"
        }),
        tmdbRequest(`/movie/${id}/videos`, {
          language: "en-US"
        }),
        tmdbRequest(`/movie/${id}/watch/providers`)
      ]);

    const cast = (credits.cast || [])
      .filter((person) => person && person.name)
      .slice(0, 12)
      .map((person) => ({
        id: person.id,
        name: person.name,
        character: person.character || "",
        profile_url: person.profile_path
          ? `${TMDB_IMAGE_BASE}/w185${person.profile_path}`
          : null
      }));

    const trailers = (videos.results || [])
      .filter(
        (video) =>
          video.site === "YouTube" &&
          ["Trailer", "Teaser"].includes(video.type)
      )
      .sort((a, b) => {
        const aOfficial = a.official ? 1 : 0;
        const bOfficial = b.official ? 1 : 0;
        return bOfficial - aOfficial;
      })
      .slice(0, 8)
      .map((video) => ({
        id: video.id,
        name: video.name,
        type: video.type,
        official: Boolean(video.official),
        url: `https://www.youtube.com/watch?v=${video.key}`,
        youtube_embed_url: `https://www.youtube.com/embed/${video.key}`
      }));

    const providerResults = watchProviders.results || {};
    const country =
      String(req.query.country || "GH")
        .trim()
        .toUpperCase();

    const selectedProviders =
      providerResults[country] ||
      providerResults.US ||
      null;

    res.json({
      success: true,
      provider: "TMDB",
      playback: {
        full_movie_hosted_by_dgm: false,
        message:
          "DGM provides movie discovery and official availability information. Full movies are not hosted by DGM.",
        trailer_playback: "embedded"
      },
      movie: tmdbDetail(movie),
      cast,
      trailers,
      watch_providers: selectedProviders
        ? {
            country,
            link: selectedProviders.link || "",
            flatrate: selectedProviders.flatrate || [],
            rent: selectedProviders.rent || [],
            buy: selectedProviders.buy || []
          }
        : {
            country,
            link: "",
            flatrate: [],
            rent: [],
            buy: []
          }
    });
  } catch (error) {
    console.error("TMDB movie detail error:", error.message);
    return sendMovieApiError(res, error);
  }
});

// =====================================================
// DATABASE
// =====================================================

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is missing.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl:
    NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,

  max: 10,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error(
    "PostgreSQL pool error:",
    error
  );
});

// =====================================================
// DATABASE SETUP
// IMPORTANT:
// THIS DOES NOT RESET OR DELETE EXISTING ORDERS.
// =====================================================

async function initDatabase() {

  // ---------------------------------------------------
  // CUSTOMERS
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ---------------------------------------------------
  // MOVIE PLAYBACK SOURCES
  // Stores only authorized DGM-controlled/licensed playback URLs.
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL
        REFERENCES customers(id)
        ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_customer
    ON password_reset_tokens(customer_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
    ON password_reset_tokens(expires_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movie_playback (
      id SERIAL PRIMARY KEY,
      tmdb_id INTEGER UNIQUE NOT NULL,
      title TEXT,
      playback_url TEXT NOT NULL,
      playback_type TEXT NOT NULL DEFAULT 'hls',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ---------------------------------------------------
  // ORDERS
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_ref TEXT UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL
        REFERENCES customers(id)
        ON DELETE CASCADE,
      service TEXT NOT NULL,
      network TEXT,
      phone TEXT,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Pending Payment',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ---------------------------------------------------
  // WALLET WITHDRAWALS
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_withdrawals (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL
        REFERENCES customers(id)
        ON DELETE CASCADE,
      reference TEXT UNIQUE NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      momo_network TEXT NOT NULL,
      momo_phone TEXT NOT NULL,
      momo_name TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Approval',
      admin_note TEXT,
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_withdrawals_customer
    ON wallet_withdrawals(customer_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_withdrawals_status
    ON wallet_withdrawals(status);
  `);

  // ---------------------------------------------------
  // WALLET TRANSACTIONS
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,

      customer_id INTEGER NOT NULL
        REFERENCES customers(id)
        ON DELETE CASCADE,

      type TEXT NOT NULL,

      amount NUMERIC(12,2) NOT NULL,

      balance_before NUMERIC(12,2) NOT NULL DEFAULT 0,

      balance_after NUMERIC(12,2) NOT NULL DEFAULT 0,

      description TEXT,

      transaction_ref TEXT,

      status TEXT DEFAULT 'Completed',

      reference TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ---------------------------------------------------
  // WALLET TRANSACTION MIGRATIONS
  // ---------------------------------------------------

  await pool.query(`
    ALTER TABLE wallet_transactions
    ADD COLUMN IF NOT EXISTS transaction_ref TEXT;
  `);

  await pool.query(`
    ALTER TABLE wallet_transactions
    ADD COLUMN IF NOT EXISTS reference TEXT;
  `);

  await pool.query(`
    ALTER TABLE wallet_transactions
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Completed';
  `);

  await pool.query(`
    ALTER TABLE wallet_transactions
    ADD COLUMN IF NOT EXISTS balance_before NUMERIC(12,2);
  `);

  await pool.query(`
    ALTER TABLE wallet_transactions
    ADD COLUMN IF NOT EXISTS balance_after NUMERIC(12,2);
  `);

  // ---------------------------------------------------
  // SAFELY HANDLE BALANCE COLUMNS
  // ---------------------------------------------------

  await pool.query(`
    ALTER TABLE wallet_transactions
    ALTER COLUMN balance_before
    SET DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE wallet_transactions
    ALTER COLUMN balance_after
    SET DEFAULT 0;
  `);

  // ---------------------------------------------------
  // BACKFILL NULL BALANCE VALUES
  // ---------------------------------------------------

  await pool.query(`
    UPDATE wallet_transactions
    SET balance_before =
      CASE
        WHEN LOWER(COALESCE(type, '')) IN
          ('debit', 'withdrawal', 'purchase')
        THEN GREATEST(
          COALESCE(balance_after, 0) +
          COALESCE(amount, 0),
          0
        )
        ELSE 0
      END
    WHERE balance_before IS NULL;
  `);

  await pool.query(`
    UPDATE wallet_transactions
    SET balance_after =
      CASE
        WHEN LOWER(COALESCE(type, '')) IN
          ('debit', 'withdrawal', 'purchase')
        THEN GREATEST(
          COALESCE(balance_before, 0) -
          COALESCE(amount, 0),
          0
        )
        ELSE COALESCE(amount, 0)
      END
    WHERE balance_after IS NULL;
  `);

  // ---------------------------------------------------
  // ENSURE NEW TRANSACTIONS CANNOT HAVE NULL BALANCES
  // ---------------------------------------------------

  await pool.query(`
    ALTER TABLE wallet_transactions
    ALTER COLUMN balance_before
    SET NOT NULL;
  `);

  await pool.query(`
    ALTER TABLE wallet_transactions
    ALTER COLUMN balance_after
    SET NOT NULL;
  `);

  // ---------------------------------------------------
  // BACKFILL TRANSACTION REFERENCES
  // ---------------------------------------------------

  await pool.query(`
    UPDATE wallet_transactions
    SET transaction_ref = reference
    WHERE transaction_ref IS NULL
      AND reference IS NOT NULL;
  `);

  await pool.query(`
    UPDATE wallet_transactions
    SET reference = transaction_ref
    WHERE reference IS NULL
      AND transaction_ref IS NOT NULL;
  `);

  // ---------------------------------------------------
  // USER SESSIONS
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
  `);

  // ---------------------------------------------------
  // WALLET TOPUPS
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_topups (
      id SERIAL PRIMARY KEY,

      customer_id INTEGER NOT NULL
        REFERENCES customers(id)
        ON DELETE CASCADE,

      reference TEXT UNIQUE NOT NULL,

      amount NUMERIC(12,2) NOT NULL,

      status TEXT NOT NULL DEFAULT 'Pending',

      payment_status TEXT NOT NULL DEFAULT 'Pending',

      paid_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ---------------------------------------------------
  // DGM PUBLIC AIRTIME API ORDERS
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_airtime_orders (
      id SERIAL PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      idempotency_key TEXT UNIQUE,
      network TEXT NOT NULL,
      phone TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      message TEXT,
      provider_reference TEXT,
      provider_status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    api_airtime_orders_status_created_idx
    ON api_airtime_orders(status, created_at);
  `);

  // ===================================================
  // ORDER COLUMN MIGRATIONS
  // ===================================================

  const orderColumns = [
    ["datamart_purchase_id", "TEXT"],
    ["datamart_reference", "TEXT"],
    ["datamart_transaction_reference", "TEXT"],
    ["datamart_status", "TEXT"],
    ["capacity", "TEXT"],
    ["paystack_reference", "TEXT"],
    ["payment_status", "TEXT DEFAULT 'Pending'"],
    ["paid_at", "TIMESTAMPTZ"],
    ["provider_reference", "TEXT"],
    ["provider_status", "TEXT"],
    ["provider_message", "TEXT"],
    ["provider_updated_at", "TIMESTAMPTZ"],
    ["completed_at", "TIMESTAMPTZ"]
  ];

  for (
    const [column, definition]
    of orderColumns
  ) {

    await pool.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS
      ${column} ${definition};
    `);
  }

  // ===================================================
  // IMPORTANT:
  // DO NOT DELETE EXISTING WALLET TRANSACTIONS.
  //
  // The old duplicate-cleanup query has intentionally
  // been removed so existing wallet/order history is
  // preserved.
  // ===================================================

  // ===================================================
  // UNIQUE WALLET REFERENCE
  // ===================================================

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    wallet_transactions_reference_unique
    ON wallet_transactions(reference)
    WHERE reference IS NOT NULL;
  `);

  // ===================================================
  // INDEXES
  // ===================================================

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    orders_customer_created_idx
    ON orders(customer_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    wallet_transactions_customer_created_idx
    ON wallet_transactions(customer_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    wallet_topups_customer_created_idx
    ON wallet_topups(customer_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    orders_datamart_processing_idx
    ON orders(status, payment_status, created_at);
  `);

  // ---------------------------------------------------
  // REWARDS, REFERRALS, PROMOS, AGENTS & API KEYS
  // ---------------------------------------------------
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'customer';`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS cashback_balance NUMERIC(12,2) NOT NULL DEFAULT 0;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      referred_id INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
      reward_points INTEGER NOT NULL DEFAULT 0,
      reward_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rewarded_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      points INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL DEFAULT 'percent',
      discount_value NUMERIC(12,2) NOT NULL,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      min_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_promo_uses (
      id SERIAL PRIMARY KEY,
      promo_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(promo_id, customer_id, order_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_recipients (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      phone TEXT NOT NULL,
      network TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(customer_id,label)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_api_keys (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id,created_at DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS saved_recipients_customer_idx ON saved_recipients(customer_id,created_at DESC);
  `);

  // ---------------------------------------------------
  // CUSTOMER NOTIFICATIONS
  // ---------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_notifications (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS customer_notifications_customer_created_idx
    ON customer_notifications(customer_id, created_at DESC);
  `);

  // ---------------------------------------------------
  // CUSTOMER SUPPORT TICKETS
  // ---------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open',
      admin_reply TEXT,
      replied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS support_tickets_customer_created_idx
    ON support_tickets(customer_id, created_at DESC);
  `);

  console.log(
    "Database initialized successfully."
  );
}

// =====================================================
// POSTGRES SESSION STORE
// =====================================================

class PostgresSessionStore
  extends session.Store {

  async get(sid, callback) {

    try {

      const result =
        await pool.query(
          `
          SELECT sess
          FROM user_sessions
          WHERE sid = $1
            AND expire > NOW()
          `,
          [sid]
        );

      if (!result.rows.length) {
        return callback(null, null);
      }

      return callback(
        null,
        result.rows[0].sess
      );

    } catch (error) {

      console.error(
        "Session GET error:",
        error
      );

      return callback(error);
    }
  }

  async set(
    sid,
    sess,
    callback
  ) {

    try {

      const maxAge =
        sess.cookie &&
        sess.cookie.maxAge
          ? sess.cookie.maxAge
          : 1000 *
            60 *
            60 *
            24 *
            7;

      const expire =
        new Date(
          Date.now() + maxAge
        );

      await pool.query(
        `
        INSERT INTO user_sessions
          (sid, sess, expire)
        VALUES
          ($1, $2::jsonb, $3)
        ON CONFLICT (sid)
        DO UPDATE SET
          sess = EXCLUDED.sess,
          expire = EXCLUDED.expire
        `,
        [
          sid,
          JSON.stringify(sess),
          expire
        ]
      );

      if (callback) {
        callback(null);
      }

    } catch (error) {

      console.error(
        "Session SET error:",
        error
      );

      if (callback) {
        callback(error);
      }
    }
  }

  async destroy(
    sid,
    callback
  ) {

    try {

      await pool.query(
        `
        DELETE FROM user_sessions
        WHERE sid = $1
        `,
        [sid]
      );

      if (callback) {
        callback(null);
      }

    } catch (error) {

      console.error(
        "Session DESTROY error:",
        error
      );

      if (callback) {
        callback(error);
      }
    }
  }

  async touch(
    sid,
    sess,
    callback
  ) {

    try {

      const maxAge =
        sess.cookie &&
        sess.cookie.maxAge
          ? sess.cookie.maxAge
          : 1000 *
            60 *
            60 *
            24 *
            7;

      const expire =
        new Date(
          Date.now() + maxAge
        );

      await pool.query(
        `
        UPDATE user_sessions
        SET
          expire = $2,
          sess = $3::jsonb
        WHERE sid = $1
        `,
        [
          sid,
          expire,
          JSON.stringify(sess)
        ]
      );

      if (callback) {
        callback(null);
      }

    } catch (error) {

      console.error(
        "Session TOUCH error:",
        error
      );

      if (callback) {
        callback(error);
      }
    }
  }
}

const sessionStore =
  new PostgresSessionStore();

// =====================================================
// SESSION
// =====================================================

app.use(
  session({
    name: "dgm.sid",

    store: sessionStore,

    secret: SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    rolling: true,

    cookie: {
      httpOnly: true,

      secure:
        NODE_ENV === "production",

      sameSite: "lax",

      path: "/",

      maxAge:
        1000 *
        60 *
        60 *
        24 *
        7
    }
  })
);

// =====================================================
// HELPERS
// =====================================================

function cleanPhone(value) {

  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[-()]/g, "");
}

function normalizeGhanaPhone(value) {

  let phone =
    cleanPhone(value);

  if (phone.startsWith("+233")) {

    phone =
      "0" +
      phone.slice(4);
  }

  if (phone.startsWith("233")) {

    phone =
      "0" +
      phone.slice(3);
  }

  return phone;
}

function validGhanaPhone(value) {

  return /^0(20|23|24|25|26|27|50|51|53|54|55|59)\d{7}$/.test(
    normalizeGhanaPhone(value)
  );
}

function cleanEmail(value) {

  return String(value || "")
    .trim()
    .toLowerCase();
}

function createOrderReference() {

  return (
    "DGM-" +
    Date.now()
      .toString(36)
      .toUpperCase() +
    "-" +
    crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()
  );
}


// =====================================================
// KINGFLEXY AIRTIME HELPERS
// =====================================================

function normalizeKingflexyStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["completed","success","successful"].includes(status)) return "Completed";
  if (status === "failed") return "Failed";
  if (["refunded","refund"].includes(status)) return "Refunded";
  if (status === "pending") return "Pending";
  return "Processing";
}

function parseKingflexyOrder(data) {
  const root = data && typeof data === "object" ? data : {};
  const payload =
    root.data && typeof root.data === "object"
      ? root.data.order && typeof root.data.order === "object"
        ? root.data.order
        : root.data
      : root.order && typeof root.order === "object"
        ? root.order
        : root;

  return {
    orderId:
      payload.order_id ||
      payload.orderId ||
      payload.id ||
      root.order_id ||
      root.orderId ||
      root.id ||
      null,
    reference:
      payload.reference ||
      payload.reference_code ||
      payload.referenceCode ||
      payload.order_reference ||
      payload.orderReference ||
      root.reference ||
      root.reference_code ||
      root.referenceCode ||
      root.order_reference ||
      root.orderReference ||
      null,
    status:
      payload.status ||
      payload.order_status ||
      root.status ||
      root.order_status ||
      null,
    reason:
      payload.reason ||
      payload.message ||
      root.reason ||
      root.message ||
      null
  };
}

async function kingflexyRequest(endpoint, options = {}) {
  if (!KINGFLEXY_API_KEY) {
    const error = new Error("KINGFLEXY_API_KEY is not configured.");
    error.code = "KINGFLEXY_NOT_CONFIGURED";
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(KINGFLEXY_API_BASE + endpoint, {
      ...options,
      headers: {
        Authorization: KINGFLEXY_API_KEY,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { raw: text }; }

    if (!response.ok) {
      const rawMessage =
        data && typeof data === "object"
          ? (data.message ?? data.error ?? data.reason ?? null)
          : null;

      const message =
        typeof rawMessage === "string"
          ? rawMessage
          : rawMessage
            ? JSON.stringify(rawMessage)
            : "KingFlexy HTTP " + response.status;

      const error = new Error(String(message));
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        "KingFlexy request timed out. The order will remain Processing."
      );
      timeoutError.code = "KINGFLEXY_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function refundAirtimeOrder(orderId, reason) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId]
    );

    if (!orderResult.rows.length) throw new Error("Airtime order not found.");
    const order = orderResult.rows[0];

    if (order.payment_status === "Refunded") {
      await client.query("COMMIT");
      return order;
    }

    const customerResult = await client.query(
      `
      SELECT id, balance
      FROM customers
      WHERE id = $1
      FOR UPDATE
      `,
      [order.customer_id]
    );

    if (!customerResult.rows.length) {
      throw new Error("Customer account not found for refund.");
    }

    const before = Number(customerResult.rows[0].balance || 0);
    const amount = Number(order.amount || 0);
    const after = Math.round((before + amount) * 100) / 100;
    const refundRef = "DGM-REFUND-" + order.order_ref;

    await client.query(
      "UPDATE customers SET balance = $1 WHERE id = $2",
      [after, order.customer_id]
    );

    await client.query(
      `
      INSERT INTO wallet_transactions
      (customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference)
      VALUES ($1,'Credit',$2,$3,$4,$5,$6,'Completed',$7)
      `,
      [
        order.customer_id,
        amount,
        before,
        after,
        "Airtime refund - " + order.order_ref,
        refundRef,
        refundRef
      ]
    );

    const updated = await client.query(
      `
      UPDATE orders
      SET status = 'Refunded',
          payment_status = 'Refunded',
          provider_message = $1,
          provider_updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [
        String(reason || "KingFlexy refunded the airtime transaction.").slice(0,1000),
        orderId
      ]
    );

    await client.query("COMMIT");
    console.log(
      "KINGFLEXY AIRTIME REFUND: " + order.order_ref +
      " | GH₵" + amount.toFixed(2)
    );
    return updated.rows[0];
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function applyKingflexyStatus(orderId, data) {
  const parsed = parseKingflexyOrder(data);
  const status = normalizeKingflexyStatus(parsed.status);

  if (status === "Failed" || status === "Refunded") {
    return refundAirtimeOrder(
      orderId,
      parsed.reason || ("KingFlexy status: " + status)
    );
  }

  const result = await pool.query(
    `
    UPDATE orders
    SET status = $1,
        provider_reference = COALESCE($2, provider_reference),
        provider_status = $3,
        provider_message = $4,
        provider_updated_at = NOW(),
        completed_at =
          CASE WHEN $1 = 'Completed' THEN NOW()
               ELSE completed_at END
    WHERE id = $5
    RETURNING *
    `,
    [
      status,
      parsed.reference || parsed.orderId || null,
      parsed.status || status,
      parsed.reason || null,
      orderId
    ]
  );

  return result.rows[0] || null;
}

async function submitKingflexyAirtime(order) {
  if (!KINGFLEXY_API_KEY) {
    await pool.query(
      `
      UPDATE orders
      SET status = 'Processing',
          provider_status = 'not_configured',
          provider_message = $1,
          provider_updated_at = NOW()
      WHERE id = $2
      `,
      [
        "KingFlexy Airtime API is not configured. Add KINGFLEXY_API_KEY in Render.",
        order.id
      ]
    );

    return {
      success: false,
      pending: true,
      status: "Processing",
      message: "KingFlexy Airtime API is not configured."
    };
  }

  if (KINGFLEXY_AIRTIME_KEY_TYPE !== "commission_services") {
    const message =
      "KingFlexy Airtime requires a Commission Services API key (kf_cs_live_...). The configured key is not an Airtime key.";

    await pool.query(
      `
      UPDATE orders
      SET status = 'Processing',
          provider_status = 'invalid_api_key_type',
          provider_message = $1,
          provider_updated_at = NOW()
      WHERE id = $2
      `,
      [message, order.id]
    );

    return {
      success: false,
      pending: true,
      status: "Processing",
      message
    };
  }

  try {
    const requestReference = String(order.order_ref).trim();

    const data = await kingflexyRequest("/airtime/purchase", {
      method: "POST",
      body: JSON.stringify({
        network: kingflexyAirtimeNetwork(order.network),
        beneficiary_phone: order.phone,
        amount: Number(order.amount),
        reference: requestReference
      })
    });

    const parsed = parseKingflexyOrder(data);

    console.log(
      "KINGFLEXY AIRTIME PURCHASE RESPONSE: " +
      order.order_ref + " | " +
      JSON.stringify(data)
    );

    console.log(
      "KINGFLEXY AIRTIME PARSED: " +
      order.order_ref +
      " | provider_reference: " +
      String(parsed.reference || parsed.orderId || "none") +
      " | order_id: " +
      String(parsed.orderId || "none") +
      " | status: " +
      String(parsed.status || "none")
    );

    // KingFlexy v2 documents the supplied reference as the idempotency
    // and status-lookup key. Prefer that reference over the provider UUID.
    const providerReference =
      parsed.reference ||
      parsed.orderId ||
      requestReference;

    const providerStatus =
      parsed.status ||
      (data && data.success === false ? "failed" : "pending");

    const providerMessage =
      parsed.reason ||
      data?.message ||
      data?.error?.message ||
      null;

    await pool.query(
      `
      UPDATE orders
      SET provider_reference = COALESCE($1, provider_reference),
          provider_status = COALESCE($2, provider_status),
          provider_message = COALESCE($3, provider_message),
          provider_updated_at = NOW()
      WHERE id = $4
      `,
      [
        providerReference,
        providerStatus,
        providerMessage,
        order.id
      ]
    );

    // A successful HTTP response with success:false is still a failed
    // provider purchase. Do not leave a paid customer order polling forever.
    if (data && data.success === false) {
      return refundAirtimeOrder(
        order.id,
        providerMessage ||
          "KingFlexy rejected the airtime purchase."
      );
    }

    return applyKingflexyStatus(order.id, data);
  } catch (error) {
    console.error(
      "KingFlexy airtime purchase error for " + order.order_ref + ":",
      error.message
    );

    const statusCode = Number(error.status || 0);

    // Definitive client-side/provider validation errors mean the purchase
    // was not accepted. Refund the DGM wallet immediately.
    // 429 is retryable, while 5xx/timeout/network errors are kept pending.
    const definitiveFailure =
      statusCode >= 400 &&
      statusCode < 500 &&
      statusCode !== 429;

    if (definitiveFailure) {
      try {
        return await refundAirtimeOrder(
          order.id,
          "KingFlexy rejected the airtime purchase (HTTP " +
            statusCode +
            "): " +
            String(error.message || "Provider request rejected.")
        );
      } catch (refundError) {
        console.error(
          "KingFlexy airtime automatic refund failed for " +
            order.order_ref +
            ": " +
            refundError.message
        );
      }
    }

    await pool.query(
      `
      UPDATE orders
      SET status = 'Processing',
          payment_status = 'Paid',
          provider_message = $1,
          provider_updated_at = NOW()
      WHERE id = $2
      `,
      [
        String(
          error.message ||
          "KingFlexy request failed. The order will be retried."
        ).slice(0,1000),
        order.id
      ]
    );

    return {
      success: false,
      pending: true,
      status: "Processing",
      message:
        "Wallet payment confirmed. KingFlexy fulfillment is being checked automatically."
    };
  }
}

async function syncKingflexyAirtimeOrders() {
  if (!KINGFLEXY_API_KEY) return;

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE service = 'Airtime'
        AND payment_status = 'Paid'
        AND status IN ('Pending','Processing')
      ORDER BY created_at ASC
      LIMIT 25
      `
    );

    for (const order of result.rows) {
      try {
        const lookupReferences = [
          order.provider_reference,
          order.order_ref
        ].filter(Boolean).filter(
          (value, index, array) => array.indexOf(value) === index
        );

        let data = null;
        let lastError = null;

        // First try the exact provider/DGM reference endpoint.
        for (const lookupReference of lookupReferences) {
          try {
            data = await kingflexyRequest(
              "/airtime/orders/" + encodeURIComponent(lookupReference),
              { method: "GET" }
            );

            console.log(
              "KINGFLEXY AIRTIME STATUS LOOKUP: " +
              order.order_ref +
              " | reference used: " +
              lookupReference
            );

            break;
          } catch (lookupError) {
            lastError = lookupError;

            const isNotFound =
              Number(lookupError?.status || lookupError?.data?.code || 0) === 404;

            if (!isNotFound) throw lookupError;

            console.warn(
              "KINGFLEXY AIRTIME STATUS 404: " +
              order.order_ref +
              " | reference tried: " +
              lookupReference
            );
          }
        }

        // A 404 does NOT immediately mean the airtime order failed.
        // KingFlexy may expose the order in the recent-orders endpoint
        // under its provider reference/order ID instead.
        if (!data) {
          try {
            const recent = await kingflexyRequest(
              "/airtime/orders",
              { method: "GET" }
            );

            const root = recent && typeof recent === "object"
              ? recent
              : {};

            const candidates = [];

            const addCandidates = (value) => {
              if (Array.isArray(value)) candidates.push(...value);
            };

            addCandidates(root.orders);
            addCandidates(root.results);
            addCandidates(root.data);
            addCandidates(root.data?.orders);
            addCandidates(root.data?.results);

            const wanted = new Set(
              lookupReferences.map((value) => String(value))
            );

            const matched = candidates.find((item) => {
              const parsed = parseKingflexyOrder(item);
              const itemNetwork = String(
                item?.network || item?.data?.network || ""
              ).trim().toLowerCase();
              const itemPhone = String(
                item?.beneficiary_phone ||
                item?.beneficiaryPhone ||
                item?.phone ||
                item?.recipient ||
                item?.data?.beneficiary_phone ||
                ""
              ).trim();
              const itemAmount = Number(
                item?.airtime_amount ??
                item?.amount ??
                item?.total_paid ??
                item?.data?.airtime_amount ??
                NaN
              );

              const referenceMatch = [
                parsed.orderId,
                parsed.reference
              ]
                .filter(Boolean)
                .some((value) => wanted.has(String(value)));

              const detailMatch =
                itemNetwork &&
                itemNetwork === String(order.network || "").trim().toLowerCase() &&
                itemPhone &&
                itemPhone === String(order.phone || "").trim() &&
                Number.isFinite(itemAmount) &&
                Math.round(itemAmount * 100) ===
                  Math.round(Number(order.amount || 0) * 100);

              return referenceMatch || detailMatch;
            });

            if (matched) {
              data = matched;

              console.log(
                "KINGFLEXY AIRTIME STATUS FOUND IN RECENT ORDERS: " +
                order.order_ref
              );
            }
          } catch (listError) {
            console.warn(
              "KINGFLEXY AIRTIME RECENT ORDERS LOOKUP FAILED: " +
              order.order_ref +
              " | " +
              listError.message
            );
          }
        }

        if (!data) {
          const isNotFound =
            Number(lastError?.status || lastError?.data?.code || 0) === 404;

          if (isNotFound) {
            const ageMs =
              Date.now() -
              new Date(order.created_at).getTime();

            // Never refund immediately on a provider 404. Give the
            // provider time to expose a newly-created order.
            // After 10 minutes with no matching provider order,
            // refund the customer rather than leaving funds stranded.
            if (Number.isFinite(ageMs) && ageMs >= 10 * 60 * 1000) {
              await refundAirtimeOrder(
                order.id,
                "KingFlexy could not find this airtime order after repeated status checks for 10 minutes. The DGM wallet payment has been refunded."
              );

              console.warn(
                "KINGFLEXY AIRTIME ORDER NOT FOUND AFTER 10 MINUTES — REFUNDED: " +
                order.order_ref
              );
            } else {
              console.warn(
                "KINGFLEXY AIRTIME ORDER NOT FOUND YET — KEEPING PROCESSING: " +
                order.order_ref
              );
            }

            continue;
          }

          throw lastError || new Error("KingFlexy status lookup failed.");
        }

        await applyKingflexyStatus(order.id, data);

      } catch (error) {
        console.error(
          "KingFlexy airtime status check failed for " +
          order.order_ref +
          ": " +
          error.message
        );
      }
    }
  } catch (error) {
    console.error("KingFlexy airtime sync error:", error);
  }
}

function createWalletReference() {

  return (
    "DGM-WALLET-" +
    Date.now()
      .toString(36)
      .toUpperCase() +
    "-" +
    crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase()
  );
}

function sendError(
  res,
  status,
  message
) {

  return res
    .status(status)
    .json({
      success: false,
      message
    });
}

function getDgmApiKey(req) {
  const key = String(req.get("X-DGM-API-Key") || "").trim();
  if (key) return key;

  const authorization = String(req.get("Authorization") || "").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

function requireDgmApiKey(req, res, next) {
  if (!DGM_API_KEY) {
    return sendError(res, 503, "DGM API authentication is not configured.");
  }

  const supplied = getDgmApiKey(req);

  if (
    !supplied ||
    supplied.length !== DGM_API_KEY.length ||
    !crypto.timingSafeEqual(
      Buffer.from(supplied),
      Buffer.from(DGM_API_KEY)
    )
  ) {
    return sendError(res, 401, "Invalid or missing DGM API key.");
  }

  next();
}

const dgmApiRateState = new Map();

function dgmApiRateLimit(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 60;
  const existing = dgmApiRateState.get(ip);

  if (!existing || now - existing.startedAt >= windowMs) {
    dgmApiRateState.set(ip, {
      startedAt: now,
      count: 1
    });
    return next();
  }

  existing.count += 1;

  if (existing.count > maxRequests) {
    return res.status(429).json({
      success: false,
      message: "Too many API requests. Please try again later."
    });
  }

  next();
}

function createAirtimeApiReference() {
  return (
    "DGM-AIR-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

const ADMIN_EMAIL = cleanEmail(process.env.ADMIN_EMAIL || "");
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
let ADMIN_PASSWORD_HASH = "";

async function initializeAdminCredentials() {
  if (ADMIN_PASSWORD) ADMIN_PASSWORD_HASH = await bcrypt.hash(ADMIN_PASSWORD, 12);
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.adminAuthenticated) return sendError(res, 401, "Admin authentication required.");
  next();
}

function requireLogin(
  req,
  res,
  next
) {

  if (
    !req.session ||
    !req.session.customerId
  ) {

    return sendError(
      res,
      401,
      "Please login to continue."
    );
  }

  next();
}

async function getCustomer(
  customerId
) {

  const result =
    await pool.query(
      `
      SELECT
        id,
        name,
        phone,
        email,
        balance,
        created_at
      FROM customers
      WHERE id = $1
      `,
      [customerId]
    );

  return (
    result.rows[0] ||
    null
  );
}

function publicCustomer(
  customer
) {

  if (!customer) {
    return null;
  }

  return {
    id: customer.id,

    name: customer.name,

    phone: customer.phone,

    email: customer.email,

    balance:
      Number(
        customer.balance || 0
      ),

    created_at:
      customer.created_at
  };
}

function normalizeCapacity(
  value
) {

  const cleaned =
    String(value || "")
      .toUpperCase()
      .replace(/GB/g, "")
      .trim();

  const number =
    Number(cleaned);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {

    return null;
  }

  return number;
}

function escapeHtml(value) {

  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const passwordResetRateState = new Map();

function passwordResetRateLimit(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxRequests = 5;
  const existing = passwordResetRateState.get(ip);

  if (!existing || now - existing.startedAt >= windowMs) {
    passwordResetRateState.set(ip, { startedAt: now, count: 1 });
    return next();
  }

  existing.count += 1;
  if (existing.count > maxRequests) {
    return sendError(res, 429, "Too many password reset requests. Please try again later.");
  }
  next();
}

function createPasswordResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashPasswordResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function sendPasswordResetEmail(customer, resetUrl) {
  const subject = "Reset your DHE GENIUS MEDIA password";
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#17202a">
    <h2>DHE GENIUS MEDIA</h2>
    <p>Hello ${escapeHtml(customer.name)},</p>
    <p>We received a request to reset your DGM account password.</p>
    <p><a href="${resetUrl}" style="display:inline-block;padding:13px 20px;background:#168cff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Reset Password</a></p>
    <p>This link expires in 30 minutes and can only be used once.</p>
    <p>If you did not request this, you can safely ignore this email.</p>
    <p style="color:#667085;font-size:12px">DHE GENIUS MEDIA • Accra - Spintex</p>
  </div>`;

  const canUseSmtp =
    SMTP_HOST &&
    SMTP_USER &&
    SMTP_PASSWORD &&
    SMTP_FROM_EMAIL;

  if (RESET_EMAIL_PROVIDER === "smtp" || (!RESEND_API_KEY && canUseSmtp)) {
    if (!canUseSmtp) {
      throw new Error(
        "SMTP password reset email is not fully configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM_EMAIL."
      );
    }

    let nodemailer;
    try {
      nodemailer = require("nodemailer");
    } catch {
      throw new Error(
        "SMTP email support is unavailable because the nodemailer package is missing."
      );
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASSWORD
      }
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM_EMAIL,
      to: customer.email,
      subject,
      html
    });

    return {
      provider: "smtp",
      messageId: info.messageId
    };
  }

  if (!RESEND_API_KEY) {
    throw new Error(
      "No password reset email provider is configured. Set RESEND_API_KEY or configure SMTP."
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [customer.email],
      subject,
      html
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const providerMessage =
      data.message ||
      data.error?.message ||
      data.name ||
      `Resend returned HTTP ${response.status}.`;

    throw new Error(providerMessage);
  }

  return {
    provider: "resend",
    ...data
  };
}

// =====================================================
// DATA SERVICE CHECK
// =====================================================

function isDataService(
  service
) {

  const value =
    String(service || "")
      .trim()
      .toLowerCase();

  return (
    value === "data" ||
    value === "data bundle" ||
    value === "data bundles"
  );
}

// =====================================================
// DGM PRICES
// =====================================================

const DGM_PRICES = {

  MTN: {
    1: 5,
    2: 10,
    3: 15,
    4: 20,
    5: 24,
    6: 28,
    8: 36,
    10: 45,
    15: 64,
    20: 84,
    25: 100,
    30: 128,
    40: 168,
    50: 207
  },

  AirtelTigo: {
    1: 5,
    2: 10,
    3: 15,
    4: 20,
    5: 24,
    6: 26,
    8: 35,
    10: 45,
    12: 48,
    15: 65,
    25: 100,
    30: 120,
    40: 160,
    50: 200
  },

  Telecel: {
    10: 45,
    15: 60,
    20: 76,
    25: 100,
    30: 115,
    35: 136,
    40: 150,
    45: 165,
    50: 185,
    100: 407
  }
};

const NETWORK_MAP = {

  MTN: "YELLO",

  AirtelTigo:
    "AT_PREMIUM",

  Telecel:
    "TELECEL"
};

// =====================================================
// DATAMART REFERENCE
// DataMart Reference Rule is configured to require
// references beginning with: dgm-
// =====================================================

function createDataMartReference(
  orderRef
) {

  const prefix =
    DATAMART_REF_PREFIX || "dgm-";

  const normalizedPrefix =
    prefix.endsWith("-")
      ? prefix
      : `${prefix}-`;

  return (
    normalizedPrefix +
    String(orderRef || "").trim()
  );
}

// =====================================================
// DATAMART CONFIG
// =====================================================

const DATAMART_BASE =
  "https://api.datamartgh.shop/api";

const DATAMART_DEVELOPER_BASE =
  "https://api.datamartgh.shop/api/developer";

// =====================================================
// DATAMART REQUEST
// =====================================================

async function datamartRequest(
  baseUrl,
  endpoint,
  options = {}
) {

  if (!DATAMART_API_KEY) {

    throw new Error(
      "DATAMART_API_KEY is not configured."
    );
  }

  if (!DATAMART_API_SECRET) {

    throw new Error(
      "DATAMART_API_SECRET is not configured."
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      30000
    );

  try {

    const response =
      await fetch(
        `${baseUrl}${endpoint}`,
        {
          ...options,

          signal:
            controller.signal,

          headers: {
            "Content-Type":
              "application/json",

            "X-API-Key":
              DATAMART_API_KEY,

            "X-API-Secret":
              DATAMART_API_SECRET,

            ...(options.headers || {})
          }
        }
      );

    const text =
      await response.text();

    let data;

    try {

      data =
        JSON.parse(text);

    } catch {

      data = {
        raw: text
      };
    }

    if (!response.ok) {

      const error =
        new Error(
          `DataMart HTTP ${response.status}: ${
            data.message ||
            data.error ||
            data.code ||
            text ||
            "Request failed"
          }`
        );

      error.status =
        response.status;

      error.data =
        data;

      throw error;
    }

    return data;

  } catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {

      throw new Error(
        "DataMart request timed out after 30 seconds."
      );
    }

    throw error;

  } finally {

    clearTimeout(timeout);
  }
}

// =====================================================
// DATAMART PURCHASE
// =====================================================

async function datamartPurchase(
  payload,
  idempotencyKey
) {

  // DataMart's documented Developer API lives under
  // /api/developer. Do not fall back to the consumer /api/purchase
  // route: that route is not part of the Developer API and previously
  // caused avoidable 404s before the real request was attempted.
  return await datamartRequest(
    DATAMART_DEVELOPER_BASE,
    "/purchase",
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        "X-Idempotency-Key": idempotencyKey
      }
    }
  );
}

// =====================================================
// DATAMART ORDER STATUS
// =====================================================

async function datamartOrderStatus(
  reference
) {

  if (!reference) {

    throw new Error(
      "DataMart order reference is required."
    );
  }

  const encodedReference =
    encodeURIComponent(
      reference
    );

  return await datamartRequest(
    DATAMART_DEVELOPER_BASE,
    `/order-status/${encodedReference}`,
    {
      method: "GET"
    }
  );
}

// =====================================================
// MAP DATAMART STATUS
// =====================================================

function mapDataMartStatus(
  datamartStatus
) {

  const status =
    String(
      datamartStatus || ""
    )
      .trim()
      .toLowerCase();

  if (
    status === "completed" ||
    status === "complete" ||
    status === "success" ||
    status === "successful" ||
    status === "delivered" ||
    status === "delivery_success" ||
    status === "delivery_successful" ||
    status === "fulfilled" ||
    status === "successful_delivery"
  ) {

    return "Completed";
  }

  if (
    status === "failed" ||
    status === "failure" ||
    status === "refunded" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "reversed" ||
    status === "declined"
  ) {

    return "Failed";
  }

  if (
    status === "pending" ||
    status === "waiting" ||
    status === "processing" ||
    status === "queued" ||
    status === "in_progress" ||
    status === "in-progress" ||
    status === "initiated"
  ) {

    return "Processing";
  }

  return "Processing";
}

async function processCompletedOrderRewards(orderId){
  const client=await pool.connect();
  try{await client.query("BEGIN");
    const o=(await client.query("SELECT id,customer_id,order_ref,amount,status FROM orders WHERE id=$1 FOR UPDATE",[orderId])).rows[0];
    if(!o||o.status!=="Completed"){await client.query("ROLLBACK");return;}
    const points=Math.max(1,Math.floor(Number(o.amount||0)*10));
    const existing=await client.query("SELECT id FROM loyalty_transactions WHERE reference=$1 LIMIT 1",["ORDER:"+o.id]);
    if(!existing.rows.length){
      await client.query("UPDATE customers SET loyalty_points=loyalty_points+$1 WHERE id=$2",[points,o.customer_id]);
      await client.query("INSERT INTO loyalty_transactions(customer_id,points,reason,reference) VALUES($1,$2,$3,$4)",[o.customer_id,points,"Completed order "+o.order_ref,"ORDER:"+o.id]);
    }
    const ref=(await client.query("SELECT * FROM referrals WHERE referred_id=$1 AND status='Pending' LIMIT 1 FOR UPDATE",[o.customer_id])).rows[0];
    if(ref){
      const refPoints=50, refAmount=1;
      await client.query("UPDATE customers SET loyalty_points=loyalty_points+$1,cashback_balance=cashback_balance+$2 WHERE id=$3",[refPoints,refAmount,ref.referrer_id]);
      await client.query("INSERT INTO loyalty_transactions(customer_id,points,reason,reference) VALUES($1,$2,$3,$4)",[ref.referrer_id,refPoints,"Referral reward for "+o.order_ref,"REFERRAL:"+ref.id]);
      await client.query("UPDATE referrals SET reward_points=$1,reward_amount=$2,status='Rewarded',rewarded_at=NOW() WHERE id=$3",[refPoints,refAmount,ref.id]);
    }
    await client.query("COMMIT");
    await createCustomerNotification(o.customer_id,"Order completed",o.order_ref+" has been completed. You earned "+points+" loyalty points.","reward");
    if(ref) await createCustomerNotification(ref.referrer_id,"Referral reward earned","Your referral reward has been credited.","reward");
  }catch(e){try{await client.query("ROLLBACK")}catch{};console.error("Reward processing error:",e.message)}finally{client.release()}
}

async function refundFailedCustomerOrder(orderId,reason){
  const client=await pool.connect();
  try{await client.query("BEGIN");
    const o=(await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE",[orderId])).rows[0];
    if(!o||String(o.payment_status||"").toLowerCase()==="refunded"){await client.query("ROLLBACK");return;}
    const cust=(await client.query("SELECT id,balance FROM customers WHERE id=$1 FOR UPDATE",[o.customer_id])).rows[0];
    if(!cust) throw new Error("Customer not found");
    const before=Number(cust.balance||0), amount=Number(o.amount||0), after=Math.round((before+amount)*100)/100, ref="DGM-REFUND-"+o.order_ref;
    await client.query("UPDATE customers SET balance=$1 WHERE id=$2",[after,o.customer_id]);
    await client.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'Credit',$2,$3,$4,$5,$6,'Completed',$7)",[o.customer_id,amount,before,after,"Automatic failed-order refund - "+o.order_ref,ref,ref]);
    await client.query("UPDATE orders SET status='Refunded',payment_status='Refunded',provider_message=$1,provider_updated_at=NOW() WHERE id=$2",[String(reason||"Provider reported a failed transaction.").slice(0,1000),orderId]);
    await client.query("COMMIT");
    await createCustomerNotification(o.customer_id,"Order refunded","GH₵"+amount.toFixed(2)+" was refunded for "+o.order_ref+" because the order failed.","refund");
  }catch(e){try{await client.query("ROLLBACK")}catch{};console.error("Automatic refund error:",e.message)}finally{client.release()}
}

// =====================================================
// SYNCHRONIZE DATAMART ORDER
// =====================================================

async function syncDataMartOrder(
  order
) {

  try {

    if (!order) {

      throw new Error(
        "Order not found."
      );
    }

    if (
      !isDataService(
        order.service
      )
    ) {

      return {
        success: false,
        skipped: true,
        reason:
          "Not a data bundle order."
      };
    }

    if (
      String(
        order.payment_status || ""
      ).toLowerCase() !== "paid"
    ) {

      return {
        success: false,
        skipped: true,
        reason:
          "Payment has not been completed."
      };
    }

    if (
      !order.datamart_reference
    ) {

      return {
        success: false,
        skipped: true,
        reason:
          "DataMart reference is not available."
      };
    }

    const result =
      await datamartOrderStatus(
        order.datamart_reference
      );

    const data =
      result?.data ||
      result ||
      {};

    // DataMart can return a generic parent status such as
    // "processing" alongside a more specific delivery status.
    // Always prefer a terminal delivery result when one exists.
    const possibleStatuses = [
      data.deliveryStatus,
      data.delivery_status,
      data.delivery?.status,
      data.delivery?.deliveryStatus,
      data.delivery?.delivery_status,
      data.delivery?.state,
      data.orderStatus,
      data.order_status,
      data.order?.orderStatus,
      data.order?.order_status,
      data.order?.status,
      data.transaction?.status,
      data.transactionStatus,
      data.transaction_status,
      data.status,
      data.state
    ];

    const terminalStatuses = new Set([
      "completed",
      "complete",
      "success",
      "successful",
      "delivered",
      "delivery_success",
      "delivery_successful",
      "fulfilled",
      "successful_delivery",
      "failed",
      "failure",
      "refunded",
      "cancelled",
      "canceled",
      "reversed",
      "declined"
    ]);

    const firstStatus =
      possibleStatuses.find(
        value =>
          value !== undefined &&
          value !== null &&
          String(value).trim() !== ""
      );

    const terminalStatus =
      possibleStatuses.find(
        value =>
          terminalStatuses.has(
            String(value || "")
              .trim()
              .toLowerCase()
          )
      );

    const deliveredFlag =
      data.delivered === true ||
      data.delivery?.delivered === true ||
      data.delivery?.completed === true;

    const datamartStatus =
      deliveredFlag
        ? "delivered"
        : terminalStatus || firstStatus;

    const normalizedStatus =
      String(
        datamartStatus || ""
      )
        .trim()
        .toLowerCase();

    console.log(
      `DataMart status response: ${order.order_ref} | status: ${normalizedStatus || "unknown"} | reference: ${order.datamart_reference}`
    );

    const localStatus =
      mapDataMartStatus(
        normalizedStatus
      );

    await pool.query(
      `
      UPDATE orders
      SET
        datamart_status = $1,
        status = $2
      WHERE id = $3
      `,
      [
        normalizedStatus ||
          "unknown",

        localStatus,

        order.id
      ]
    );

    if (localStatus === "Completed") {
      await processCompletedOrderRewards(order.id);
    } else if (localStatus === "Failed") {
      await refundFailedCustomerOrder(order.id, "DataMart reported: " + (normalizedStatus || "failed"));
    }

    console.log(
      `DataMart status sync: ${order.order_ref} -> ${normalizedStatus || "unknown"} -> ${localStatus}`
    );

    return {
      success: true,

      orderStatus:
        localStatus,

      datamartStatus:
        normalizedStatus ||
        "unknown",

      data
    };

  } catch (error) {

    console.error(
      `DataMart status sync failed for ${
        order?.order_ref ||
        "unknown order"
      }:`,
      error.message
    );

    return {
      success: false,

      error:
        error.message
    };
  }
}

// =====================================================
// BACKGROUND DATAMART STATUS SYNC
// =====================================================

let dataMartSyncRunning = false;

async function syncPendingDataMartOrders() {

  if (dataMartSyncRunning) return;

  if (!DATAMART_API_KEY || !DATAMART_API_SECRET) {
    return;
  }

  dataMartSyncRunning = true;

  try {

    const result = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE payment_status = 'Paid'
        AND status IN ('Pending', 'Processing')
        AND datamart_reference IS NOT NULL
        AND datamart_reference <> ''
        AND service IN ('Data', 'Data Bundle', 'MTN Data', 'Telecel Data', 'AirtelTigo Data')
      ORDER BY created_at ASC
      LIMIT 50
      `
    );

    for (const order of result.rows) {

      try {

        const syncResult =
          await syncDataMartOrder(order);

        if (syncResult.success) {
          console.log(
            `DataMart background sync: ${order.order_ref} -> ${syncResult.orderStatus} (${syncResult.datamartStatus})`
          );
        }

      } catch (error) {

        console.error(
          `DataMart background sync failed for ${order.order_ref}:`,
          error.message
        );
      }

    }

  } catch (error) {

    console.error(
      "DataMart background query failed:",
      error.message
    );

  } finally {

    dataMartSyncRunning = false;
  }
}

// =====================================================
// FULFILL DATA ORDER
// =====================================================

async function fulfillDataOrder(
  order
) {

  if (!order) {

    throw new Error(
      "Order not found."
    );
  }

  if (
    String(
      order.payment_status || ""
    ).toLowerCase() !== "paid"
  ) {

    throw new Error(
      "Order has not been paid."
    );
  }

  if (
    !isDataService(
      order.service
    )
  ) {

    return {
      success: true,

      skipped: true,

      reason:
        "Not a data order."
    };
  }

  if (
    order.datamart_reference
  ) {

    const syncResult =
      await syncDataMartOrder(
        order
      );

    return {
      success:
        syncResult.success,

      status:
        syncResult.orderStatus ||
        order.status ||
        "Processing",

      alreadyFulfilled: true,

      datamart:
        syncResult
    };
  }

  if (
    order.datamart_purchase_id
  ) {

    await pool.query(
      `
      UPDATE orders
      SET
        status = 'Processing',
        datamart_status =
          COALESCE(
            datamart_status,
            'processing'
          )
      WHERE id = $1
      `,
      [order.id]
    );

    return {
      success: true,

      status: "Processing",

      alreadyFulfilled: true,

      message:
        "DataMart purchase exists but tracking reference is not available yet."
    };
  }

  const capacity =
    normalizeCapacity(
      order.capacity
    );

  if (!order.network) {

    throw new Error(
      "Network is missing."
    );
  }

  if (
    !validGhanaPhone(
      order.phone
    )
  ) {

    throw new Error(
      "Invalid Ghana phone number."
    );
  }

  if (!capacity) {

    throw new Error(
      "Data capacity is missing."
    );
  }

  const datamartNetwork =
    NETWORK_MAP[
      order.network
    ];

  if (!datamartNetwork) {

    throw new Error(
      `Unsupported network: ${order.network}`
    );
  }

  const networkPrices =
    DGM_PRICES[
      order.network
    ];

  if (!networkPrices) {

    throw new Error(
      "Invalid DGM network."
    );
  }

  const expectedAmount =
    networkPrices[
      capacity
    ];

  if (
    typeof expectedAmount !==
    "number"
  ) {

    throw new Error(
      "Selected data bundle is not available."
    );
  }

  if (
    Math.round(
      Number(order.amount) * 100
    ) !==
    Math.round(
      expectedAmount * 100
    )
  ) {

    throw new Error(
      "Order price does not match the current DGM price."
    );
  }

  // -------------------------------------------------
  // DATAMART REFERENCE
  //
  // Example:
  // dgm-DGM-MF8ABC-123456
  // -------------------------------------------------

  const datamartReference =
    createDataMartReference(
      order.order_ref
    );

  const payload = {

    phoneNumber:
      normalizeGhanaPhone(
        order.phone
      ),

    network:
      datamartNetwork,

    capacity:
      String(capacity),

    gateway:
      "wallet",

    ref:
      datamartReference
  };

  const idempotencyKey =
    `dgm-${order.order_ref}`;

  try {

    console.log(
      `Sending DataMart purchase for ${order.order_ref} | DataMart ref: ${datamartReference}`
    );

    const result =
      await datamartPurchase(
        payload,
        idempotencyKey
      );

    const purchaseId =
      result?.purchaseId ||
      result?.purchase_id ||
      result?.id ||
      result?.data?.purchaseId ||
      result?.data?.purchase_id ||
      result?.data?.id ||
      null;

    const reference =
      result?.reference ||
      result?.orderReference ||
      result?.order_reference ||
      result?.data?.reference ||
      result?.data?.orderReference ||
      result?.data?.order_reference ||
      null;

    const transactionReference =
      result?.transactionReference ||
      result?.transaction_reference ||
      result?.data?.transactionReference ||
      result?.data?.transaction_reference ||
      null;

    const externalStatus =
      String(
        result?.orderStatus ||
        result?.order_status ||
        result?.status ||
        result?.data?.orderStatus ||
        result?.data?.order_status ||
        result?.data?.status ||
        ""
      )
        .trim()
        .toLowerCase();

    if (!reference) {

      const diagnostic =
        [
          "DataMart purchase response did not contain an order reference.",

          purchaseId
            ? `purchaseId=${purchaseId}`
            : "purchaseId=none",

          externalStatus
            ? `status=${externalStatus}`
            : "status=unknown"
        ].join(" ");

      console.error(
        `DataMart invalid purchase response for ${order.order_ref}:`,
        result
      );

      await pool.query(
        `
        UPDATE orders
        SET
          datamart_purchase_id = $1,
          datamart_transaction_reference = $2,
          datamart_status = $3,
          status = 'Failed'
        WHERE id = $4
        `,
        [
          purchaseId,

          transactionReference,

          `failed: ${diagnostic}`,

          order.id
        ]
      );

      return {
        success: false,

        status: "Failed",

        error:
          diagnostic,

        datamart:
          result
      };
    }

    const localStatus =
      mapDataMartStatus(
        externalStatus ||
          "processing"
      );

    await pool.query(
      `
      UPDATE orders
      SET
        datamart_purchase_id = $1,
        datamart_reference = $2,
        datamart_transaction_reference = $3,
        datamart_status = $4,
        status = $5
      WHERE id = $6
      `,
      [
        purchaseId,

        reference,

        transactionReference,

        externalStatus ||
          "processing",

        localStatus,

        order.id
      ]
    );

    console.log(
      `DataMart purchase created: ${order.order_ref} | reference: ${reference} | request ref: ${datamartReference} | status: ${
        externalStatus ||
        "processing"
      }`
    );

    const updatedResult =
      await pool.query(
        `
        SELECT *
        FROM orders
        WHERE id = $1
        `,
        [order.id]
      );

    const updatedOrder =
      updatedResult.rows[0];

    const syncResult =
      await syncDataMartOrder(
        updatedOrder
      );

    if (
      syncResult.success
    ) {

      const finalResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE id = $1
          `,
          [order.id]
        );

      const finalOrder =
        finalResult.rows[0] ||
        updatedOrder;

      return {
        success: true,

        status:
          finalOrder.status,

        datamart:
          syncResult,

        order:
          finalOrder
      };
    }

    await pool.query(
      `
      UPDATE orders
      SET
        status = 'Processing',
        datamart_status =
          COALESCE(
            datamart_status,
            'processing'
          )
      WHERE id = $1
      `,
      [order.id]
    );

    return {
      success: true,

      status: "Processing",

      datamart:
        syncResult,

      order:
        updatedOrder
    };

  } catch (error) {

    console.error(
      `DataMart fulfillment failed for ${order.order_ref}:`,
      error
    );

    await pool.query(
      `
      UPDATE orders
      SET
        datamart_status = $1,
        status = 'Failed'
      WHERE id = $2
      `,
      [
        `failed: ${error.message}`,

        order.id
      ]
    );

    return {
      success: false,

      status: "Failed",

      error:
        error.message,

      orderRef:
        order.order_ref
    };
  }
}

// =====================================================
// WALLET CREDIT
// IMPORTANT FIX:
// - Checks existing transaction BEFORE changing balance.
// - Explicitly records balance_before.
// - Explicitly records balance_after.
// - Prevents duplicate wallet credits.
// - Uses one database transaction.
// =====================================================

async function creditWalletFromTopup(
  reference
) {

  const client =
    await pool.connect();

  try {

    await client.query(
      "BEGIN"
    );

    const walletReference =
      String(reference || "").trim();

    if (!walletReference) {

      throw new Error(
        "Wallet top-up reference is required."
      );
    }

    // -------------------------------------------------
    // LOCK WALLET TOP-UP
    // -------------------------------------------------

    const topupResult =
      await client.query(
        `
        SELECT *
        FROM wallet_topups
        WHERE reference = $1
        FOR UPDATE
        `,
        [walletReference]
      );

    if (
      !topupResult.rows.length
    ) {

      await client.query(
        "ROLLBACK"
      );

      return {
        success: false,

        message:
          "Wallet top-up not found."
      };
    }

    const topup =
      topupResult.rows[0];

    // -------------------------------------------------
    // ALREADY PAID / ALREADY CREDITED
    // -------------------------------------------------

    if (
      String(
        topup.payment_status || ""
      ).toLowerCase() ===
      "paid"
    ) {

      await client.query(
        "COMMIT"
      );

      return {
        success: true,

        alreadyCredited: true,

        amount:
          Number(topup.amount),

        customerId:
          topup.customer_id
      };
    }

    // -------------------------------------------------
    // LOCK CUSTOMER
    // -------------------------------------------------

    const customerResult =
      await client.query(
        `
        SELECT
          id,
          balance
        FROM customers
        WHERE id = $1
        FOR UPDATE
        `,
        [topup.customer_id]
      );

    if (
      !customerResult.rows.length
    ) {

      throw new Error(
        "Customer account not found."
      );
    }

    const customer =
      customerResult.rows[0];

    // -------------------------------------------------
    // VALIDATE AMOUNT
    // -------------------------------------------------

    const amount =
      Number(topup.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      throw new Error(
        "Invalid wallet top-up amount."
      );
    }

    // -------------------------------------------------
    // CHECK FOR EXISTING TRANSACTION
    // -------------------------------------------------

    const existingTransactionResult =
      await client.query(
        `
        SELECT
          id,
          customer_id,
          amount,
          balance_before,
          balance_after,
          status,
          reference,
          transaction_ref
        FROM wallet_transactions
        WHERE reference = $1
        FOR UPDATE
        `,
        [walletReference]
      );

    if (
      existingTransactionResult.rows.length
    ) {

      const existingTransaction =
        existingTransactionResult.rows[0];

      await client.query(
        `
        UPDATE wallet_topups
        SET
          status = 'Completed',
          payment_status = 'Paid',
          paid_at = COALESCE(
            paid_at,
            NOW()
          )
        WHERE id = $1
        `,
        [topup.id]
      );

      await client.query(
        "COMMIT"
      );

      console.log(
        `WALLET DUPLICATE IGNORED: ${walletReference} | Existing transaction ID: ${existingTransaction.id}`
      );

      return {
        success: true,

        alreadyCredited: true,

        amount:
          Number(
            existingTransaction.amount
          ),

        customerId:
          topup.customer_id,

        transactionId:
          existingTransaction.id
      };
    }

    // -------------------------------------------------
    // CURRENT BALANCE
    // -------------------------------------------------

    const balanceBefore =
      Number(
        customer.balance || 0
      );

    if (
      !Number.isFinite(
        balanceBefore
      ) ||
      balanceBefore < 0
    ) {

      throw new Error(
        "Customer wallet balance is invalid."
      );
    }

    // -------------------------------------------------
    // CALCULATE NEW BALANCE
    // -------------------------------------------------

    const balanceAfter =
      Math.round(
        (
          balanceBefore +
          amount
        ) * 100
      ) / 100;

    // -------------------------------------------------
    // UPDATE CUSTOMER BALANCE
    // -------------------------------------------------

    const balanceUpdateResult =
      await client.query(
        `
        UPDATE customers
        SET balance = $1
        WHERE id = $2
        RETURNING
          id,
          balance
        `,
        [
          balanceAfter,

          topup.customer_id
        ]
      );

    if (
      !balanceUpdateResult.rows.length
    ) {

      throw new Error(
        "Customer wallet balance could not be updated."
      );
    }

    // -------------------------------------------------
    // CREATE WALLET TRANSACTION
    // -------------------------------------------------

    const transactionResult =
      await client.query(
        `
        INSERT INTO wallet_transactions
        (
          customer_id,
          type,
          amount,
          balance_before,
          balance_after,
          description,
          transaction_ref,
          status,
          reference
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9
        )
        RETURNING
          id,
          customer_id,
          type,
          amount,
          balance_before,
          balance_after,
          description,
          transaction_ref,
          status,
          reference,
          created_at
        `,
        [
          topup.customer_id,

          "Credit",

          amount,

          balanceBefore,

          balanceAfter,

          "Wallet top-up via Paystack",

          walletReference,

          "Completed",

          walletReference
        ]
      );

    if (
      !transactionResult.rows.length
    ) {

      throw new Error(
        "Wallet transaction could not be created."
      );
    }

    const walletTransaction =
      transactionResult.rows[0];

    // -------------------------------------------------
    // MARK TOP-UP AS PAID
    // -------------------------------------------------

    await client.query(
      `
      UPDATE wallet_topups
      SET
        status = 'Completed',
        payment_status = 'Paid',
        paid_at = COALESCE(
          paid_at,
          NOW()
        )
      WHERE id = $1
      `,
      [topup.id]
    );

    // -------------------------------------------------
    // COMMIT EVERYTHING AT ONCE
    // -------------------------------------------------

    await client.query(
      "COMMIT"
    );

    console.log(
      `WALLET CREDITED: ${walletReference} | ` +
      `GH₵${amount.toFixed(2)} | ` +
      `Before: GH₵${balanceBefore.toFixed(2)} | ` +
      `After: GH₵${balanceAfter.toFixed(2)} | ` +
      `Transaction ID: ${walletTransaction.id}`
    );

    return {
      success: true,

      alreadyCredited: false,

      amount,

      balanceBefore,

      balanceAfter,

      customerId:
        topup.customer_id,

      transactionId:
        walletTransaction.id
    };

  } catch (error) {

    try {

      await client.query(
        "ROLLBACK"
      );

    } catch (rollbackError) {

      console.error(
        "Wallet rollback error:",
        rollbackError
      );
    }

    console.error(
      "Wallet credit error:",
      error
    );

    throw error;

  } finally {

    client.release();
  }
}

// =====================================================
// PAYSTACK WEBHOOK
// =====================================================

app.post(
  "/api/paystack/webhook",

  express.raw({
    type: "application/json"
  }),

  async (req, res) => {

    try {

      if (!PAYSTACK_SECRET_KEY) {
        return res.sendStatus(200);
      }

      const signature =
        req.headers[
          "x-paystack-signature"
        ];

      if (!signature) {
        return res.sendStatus(401);
      }

      const rawBody =
        Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from("");

      const expectedSignature =
        crypto
          .createHmac(
            "sha512",
            PAYSTACK_SECRET_KEY
          )
          .update(rawBody)
          .digest("hex");

      if (
        signature.length !==
        expectedSignature.length
      ) {

        return res.sendStatus(401);
      }

      const valid =
        crypto.timingSafeEqual(
          Buffer.from(
            signature,
            "utf8"
          ),
          Buffer.from(
            expectedSignature,
            "utf8"
          )
        );

      if (!valid) {
        return res.sendStatus(401);
      }

      let event;

      try {

        event =
          JSON.parse(
            rawBody.toString("utf8")
          );

      } catch {

        return res.sendStatus(400);
      }

      if (
        event.event !==
        "charge.success"
      ) {

        return res.sendStatus(200);
      }

      const reference =
        String(
          event?.data?.reference ||
          ""
        ).trim();

      if (!reference) {
        return res.sendStatus(200);
      }

      // =================================================
      // WALLET PAYMENT
      // =================================================

      const walletResult =
        await pool.query(
          `
          SELECT *
          FROM wallet_topups
          WHERE reference = $1
          LIMIT 1
          `,
          [reference]
        );

      if (
        walletResult.rows.length
      ) {

        const topup =
          walletResult.rows[0];

        const amountFromPaystack =
          Number(
            event?.data?.amount ||
            0
          ) / 100;

        const currency =
          String(
            event?.data?.currency ||
            ""
          ).toUpperCase();

        if (
          currency !== "GHS"
        ) {

          console.error(
            "Wallet webhook currency mismatch:",
            reference
          );

          return res.sendStatus(400);
        }

        if (
          Math.round(
            amountFromPaystack * 100
          ) !==
          Math.round(
            Number(topup.amount) * 100
          )
        ) {

          console.error(
            "Wallet amount mismatch:",
            reference
          );

          return res.sendStatus(400);
        }

        const creditResult =
          await creditWalletFromTopup(
            reference
          );

        console.log(
          "Paystack wallet webhook processed:",
          reference,
          creditResult
        );

        return res.sendStatus(200);
      }

      // =================================================
      // NORMAL ORDER
      // =================================================

      const result =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE paystack_reference = $1
             OR order_ref = $1
          LIMIT 1
          `,
          [reference]
        );

      if (!result.rows.length) {

        return res.sendStatus(200);
      }

      const order =
        result.rows[0];

      const amountFromPaystack =
        Number(
          event?.data?.amount ||
          0
        ) / 100;

      const currency =
        String(
          event?.data?.currency ||
          ""
        ).toUpperCase();

      if (
        currency !== "GHS"
      ) {

        return res.sendStatus(400);
      }

      if (
        Math.round(
          amountFromPaystack * 100
        ) !==
        Math.round(
          Number(order.amount) * 100
        )
      ) {

        console.error(
          "Paystack order amount mismatch:",
          reference
        );

        return res.sendStatus(400);
      }

      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'Paid',
          paid_at =
            COALESCE(
              paid_at,
              NOW()
            ),
          status =
            CASE
              WHEN status =
                'Pending Payment'
              THEN 'Processing'
              ELSE status
            END,
          paystack_reference =
            COALESCE(
              paystack_reference,
              $1
            )
        WHERE id = $2
        `,
        [
          reference,

          order.id
        ]
      );

      const updatedResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE id = $1
          `,
          [order.id]
        );

      const fulfillmentResult =
        await fulfillDataOrder(
          updatedResult.rows[0]
        );

      if (
        !fulfillmentResult.success
      ) {

        console.error(
          `DataMart fulfillment failed after Paystack payment: ${order.order_ref}`,
          fulfillmentResult.error
        );

        return res.sendStatus(500);
      }

      return res.sendStatus(200);

    } catch (error) {

      console.error(
        "Paystack webhook error:",
        error
      );

      return res.sendStatus(500);
    }
  }
);

// =====================================================
// BODY PARSERS
// WEBHOOK ABOVE MUST REMAIN BEFORE express.json()
// =====================================================

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

// =====================================================
// WALLET DEPOSIT / PAYSTACK INITIALIZATION
// =====================================================

app.post(
  "/api/wallet/deposit",
  requireLogin,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return sendError(
          res,
          503,
          "Wallet payments are not configured yet. Add PAYSTACK_SECRET_KEY in Render environment variables."
        );
      }

      const amount = Math.round(Number(req.body?.amount || 0) * 100) / 100;

      if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
        return sendError(
          res,
          400,
          "Wallet top-up amount must be between GH₵1.00 and GH₵10,000.00."
        );
      }

      const customer = await getCustomer(req.session.customerId);

      if (!customer) {
        return sendError(res, 404, "Customer account not found.");
      }

      const email = cleanEmail(customer.email);

      if (!email || !email.includes("@")) {
        return sendError(
          res,
          400,
          "Your account does not have a valid email address for Paystack."
        );
      }

      const reference = "DGM-WALLET-" +
        Date.now().toString(36).toUpperCase() +
        "-" +
        crypto.randomBytes(4).toString("hex").toUpperCase();

      await pool.query(
        `
        INSERT INTO wallet_topups
          (customer_id, reference, amount, status, payment_status)
        VALUES
          ($1, $2, $3, 'Pending', 'Pending')
        `,
        [customer.id, reference, amount]
      );

      const callbackUrl =
        BASE_URL.replace(/\/$/, "") +
        "/api/paystack/wallet-callback";

      const paystackResponse = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            email,
            amount: String(Math.round(amount * 100)),
            currency: "GHS",
            reference,
            callback_url: callbackUrl,
            metadata: {
              type: "wallet_topup",
              customer_id: customer.id,
              reference
            }
          })
        }
      );

      const raw = await paystackResponse.text();
      let data = {};

      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }

      if (!paystackResponse.ok || !data.status || !data.data?.authorization_url) {
        await pool.query(
          `
          UPDATE wallet_topups
          SET status = 'Failed',
              payment_status = 'Failed'
          WHERE reference = $1
          `,
          [reference]
        );

        console.error(
          "Paystack wallet initialization failed:",
          paystackResponse.status,
          data || raw
        );

        return sendError(
          res,
          502,
          data?.message || "Paystack could not initialize the wallet payment."
        );
      }

      console.log(
        `WALLET TOPUP INITIALIZED: ${reference} | GH₵${amount.toFixed(2)} | Customer: ${customer.id}`
      );

      return res.json({
        success: true,
        reference,
        amount,
        authorization_url: data.data.authorization_url,
        access_code: data.data.access_code || null
      });
    } catch (error) {
      console.error("Wallet deposit initialization error:", error);
      return sendError(
        res,
        500,
        error.message || "Unable to start wallet payment."
      );
    }
  }
);

// =====================================================
// PAYSTACK WALLET CALLBACK / SERVER-SIDE VERIFICATION
// =====================================================

app.get(
  "/api/paystack/wallet-callback",
  async (req, res) => {
    const reference = String(req.query.reference || "").trim();

    if (!reference) {
      return res.redirect(
        "/add-money.html?payment=failed&message=" +
        encodeURIComponent("Payment reference was not returned by Paystack.")
      );
    }

    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.redirect(
          "/add-money.html?payment=failed&message=" +
          encodeURIComponent("Wallet payments are not configured.")
        );
      }

      const verifyResponse = await fetch(
        "https://api.paystack.co/transaction/verify/" +
        encodeURIComponent(reference),
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            Accept: "application/json"
          }
        }
      );

      const raw = await verifyResponse.text();
      let data = {};

      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }

      const payment = data?.data || {};
      const status = String(payment.status || "").toLowerCase();
      const currency = String(payment.currency || "").toUpperCase();
      const paidAmount = Number(payment.amount || 0) / 100;

      const topupResult = await pool.query(
        `
        SELECT *
        FROM wallet_topups
        WHERE reference = $1
        LIMIT 1
        `,
        [reference]
      );

      if (!topupResult.rows.length) {
        return res.redirect(
          "/add-money.html?payment=failed&message=" +
          encodeURIComponent("Wallet top-up record was not found.")
        );
      }

      const topup = topupResult.rows[0];
      const expectedAmount = Number(topup.amount);

      if (
        !verifyResponse.ok ||
        !data.status ||
        status !== "success" ||
        currency !== "GHS" ||
        Math.round(paidAmount * 100) !== Math.round(expectedAmount * 100)
      ) {
        console.error(
          "Paystack wallet verification failed:",
          reference,
          {
            httpStatus: verifyResponse.status,
            status,
            currency,
            paidAmount,
            expectedAmount
          }
        );

        return res.redirect(
          "/add-money.html?payment=failed&message=" +
          encodeURIComponent("Payment was not verified as successful.")
        );
      }

      const creditResult =
        await creditWalletFromTopup(reference);

      console.log(
        "Paystack wallet callback processed:",
        reference,
        creditResult
      );

      return res.redirect(
        "/add-money.html?payment=success&reference=" +
        encodeURIComponent(reference)
      );
    } catch (error) {
      console.error(
        "Paystack wallet callback error:",
        error
      );

      return res.redirect(
        "/add-money.html?payment=failed&message=" +
        encodeURIComponent("Payment verification failed. Please contact DGM support.")
      );
    }
  }
);

// =====================================================
// ADMIN AUTHENTICATION
// =====================================================

app.post("/api/admin/login", loginRateLimit, async (req, res) => {
  try {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) return sendError(res, 503, "Admin login is not configured. Add ADMIN_EMAIL and ADMIN_PASSWORD in Render.");
    const email = cleanEmail(req.body?.email || "");
    const password = String(req.body?.password || "");
    if (!email || !password) return sendError(res, 400, "Enter the admin email and password.");
    if (email !== ADMIN_EMAIL) {
      await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
      return sendError(res, 401, "Invalid admin login details.");
    }
    if (!await bcrypt.compare(password, ADMIN_PASSWORD_HASH)) {
      recordLoginFailure(req);
      return sendError(res, 401, "Invalid admin login details.");
    }
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    clearLoginFailures(req);
    req.session.adminAuthenticated = true;
    req.session.adminEmail = ADMIN_EMAIL;
    req.session.adminLoginAt = new Date().toISOString();
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    return res.json({ success: true, message: "Admin login successful.", admin: { email: ADMIN_EMAIL } });
  } catch (error) {
    console.error("Admin login error:", error);
    return sendError(res, 500, "Admin login failed.");
  }
});

app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ success: true, admin: { email: req.session.adminEmail || ADMIN_EMAIL }, logged_in_at: req.session.adminLoginAt || null }));

app.post("/api/admin/logout", (req, res) => {
  const clear = () => {
    res.clearCookie("dgm.sid", { httpOnly: true, secure: NODE_ENV === "production", sameSite: "lax", path: "/" });
    return res.json({ success: true });
  };
  if (!req.session) return clear();
  req.session.destroy(error => {
    if (error) { console.error("Admin logout error:", error); return res.status(500).json({ success: false, message: "Admin logout failed." }); }
    return clear();
  });
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const [customers, orders, completed, pending, revenue] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM customers"),
      pool.query("SELECT COUNT(*)::int AS count FROM orders"),
      pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE LOWER(status) IN ('completed','success','successful')"),
      pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE LOWER(status) IN ('pending','processing','pending payment')"),
      pool.query("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM orders WHERE LOWER(status) IN ('completed','success','successful')")
    ]);
    return res.json({ success: true, stats: { customers: customers.rows[0].count, orders: orders.rows[0].count, completed: completed.rows[0].count, pending: pending.rows[0].count, completed_value: Number(revenue.rows[0].total || 0) } });
  } catch (error) { console.error("Admin stats error:", error); return sendError(res, 500, "Could not load admin statistics."); }
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT o.order_ref, o.service, o.network, o.phone, o.amount, o.status, o.created_at, c.name AS customer_name, c.email AS customer_email FROM orders o LEFT JOIN customers c ON c.id = o.customer_id ORDER BY o.created_at DESC LIMIT 100");
    return res.json({ success: true, orders: result.rows });
  } catch (error) { console.error("Admin orders error:", error); return sendError(res, 500, "Could not load orders."); }
});

app.get("/api/admin/customers/:id/details", requireAdmin, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) return sendError(res, 400, "Invalid customer ID.");

  try {
    const customerResult = await pool.query(
      "SELECT id, name, phone, email, balance, created_at FROM customers WHERE id = $1 LIMIT 1",
      [customerId]
    );
    if (!customerResult.rows.length) return sendError(res, 404, "Customer not found.");

    const [orders, transactions, topups] = await Promise.all([
      pool.query(
        "SELECT id, order_ref, service, network, phone, amount, status, payment_status, provider_status, datamart_reference, created_at, paid_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200",
        [customerId]
      ),
      pool.query(
        "SELECT id, type, amount, balance_before, balance_after, description, transaction_ref, status, reference, created_at FROM wallet_transactions WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200",
        [customerId]
      ),
      pool.query(
        "SELECT id, reference, amount, status, payment_status, created_at, paid_at FROM wallet_topups WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200",
        [customerId]
      )
    ]);

    return res.json({
      success: true,
      customer: customerResult.rows[0],
      orders: orders.rows,
      wallet_transactions: transactions.rows,
      wallet_topups: topups.rows
    });
  } catch (error) {
    console.error("Admin customer details error:", error);
    return sendError(res, 500, "Could not load customer details.");
  }
});

app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM wallet_withdrawals w
       JOIN customers c ON c.id = w.customer_id
       ORDER BY CASE WHEN w.status = 'Pending Approval' THEN 0 ELSE 1 END, w.created_at DESC
       LIMIT 200`
    );
    const pending = await pool.query(
      `SELECT COUNT(*)::int AS count FROM wallet_withdrawals WHERE status = 'Pending Approval'`
    );
    return res.json({ success: true, withdrawals: result.rows, pending_count: pending.rows[0].count });
  } catch (error) {
    console.error("Admin withdrawals error:", error);
    return sendError(res, 500, "Could not load withdrawal requests.");
  }
});

app.post("/api/admin/withdrawals/:id/approve", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const note = String(req.body?.note || "").trim().slice(0, 250);
  if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, "Invalid withdrawal ID.");

  try {
    const result = await pool.query(
      `UPDATE wallet_withdrawals
       SET status = 'Approved', admin_note = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'Pending Approval'
       RETURNING *`,
      [id, note]
    );
    if (!result.rows.length) return sendError(res, 409, "Withdrawal is no longer pending approval.");
    await createCustomerNotification(result.rows[0].customer_id, "Withdrawal approved", "Your MoMo withdrawal of GH₵" + Number(result.rows[0].amount).toFixed(2) + " was approved. Payment will be sent by DGM.", "withdrawal");
    return res.json({ success: true, message: "Withdrawal approved. Send the approved amount to the customer's MoMo account, then mark it as paid.", withdrawal: result.rows[0] });
  } catch (error) {
    console.error("Admin approve withdrawal error:", error);
    return sendError(res, 500, "Could not approve withdrawal.");
  }
});

app.post("/api/admin/withdrawals/:id/reject", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const note = String(req.body?.note || "").trim().slice(0, 250);
  if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, "Invalid withdrawal ID.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT * FROM wallet_withdrawals WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Withdrawal not found.");
    }
    const w = result.rows[0];
    if (w.status !== "Pending Approval") {
      await client.query("ROLLBACK");
      return sendError(res, 409, "Only pending withdrawals can be rejected.");
    }

    const customerResult = await client.query(
      "SELECT id, balance FROM customers WHERE id = $1 FOR UPDATE",
      [w.customer_id]
    );
    if (!customerResult.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Customer account no longer exists.");
    }

    const before = Number(customerResult.rows[0].balance || 0);
    const after = Math.round((before + Number(w.amount)) * 100) / 100;
    await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [after, w.customer_id]);

    await client.query(
      `UPDATE wallet_withdrawals
       SET status = 'Rejected', admin_note = $2, rejected_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, note]
    );

    const refundRef = "DGM-WD-REFUND-" + Date.now().toString(36).toUpperCase() + "-" + w.id;
    await client.query(
      `INSERT INTO wallet_transactions
       (customer_id, type, amount, balance_before, balance_after, description, transaction_ref, status, reference)
       VALUES ($1,'withdrawal_refund',$2,$3,$4,$5,$6,'Completed',$6)`,
      [w.customer_id, Number(w.amount), before, after, "Rejected MoMo withdrawal refund - " + w.reference, refundRef]
    );

    await client.query("COMMIT");
    await createCustomerNotification(w.customer_id, "Withdrawal rejected", "Your MoMo withdrawal of GH₵" + Number(w.amount).toFixed(2) + " was rejected and the funds were returned to your wallet." + (note ? " Note: " + note : ""), "withdrawal");
    return res.json({ success: true, message: "Withdrawal rejected and wallet refunded.", balance: after });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Admin reject withdrawal error:", error);
    return sendError(res, 500, "Could not reject withdrawal.");
  } finally {
    client.release();
  }
});

app.post("/api/admin/withdrawals/:id/paid", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const note = String(req.body?.note || "").trim().slice(0, 250);
  if (!Number.isInteger(id) || id <= 0) return sendError(res, 400, "Invalid withdrawal ID.");
  try {
    const result = await pool.query(
      `UPDATE wallet_withdrawals
       SET status = 'Paid', admin_note = COALESCE(NULLIF($2,''), admin_note), paid_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'Approved'
       RETURNING *`,
      [id, note]
    );
    if (!result.rows.length) return sendError(res, 409, "Only approved withdrawals can be marked as paid.");
    await createCustomerNotification(result.rows[0].customer_id, "Withdrawal paid", "Your MoMo withdrawal of GH₵" + Number(result.rows[0].amount).toFixed(2) + " has been marked as paid by DGM.", "withdrawal");
    return res.json({ success: true, message: "Withdrawal marked as paid.", withdrawal: result.rows[0] });
  } catch (error) {
    console.error("Admin paid withdrawal error:", error);
    return sendError(res, 500, "Could not mark withdrawal as paid.");
  }
});

app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, phone, email, balance, created_at FROM customers ORDER BY created_at DESC LIMIT 100");
    return res.json({ success: true, customers: result.rows });
  } catch (error) {
    console.error("Admin customers error:", error);
    return sendError(res, 500, "Could not load customers.");
  }
});

// ADMIN: adjust a customer's wallet balance.
// Positive amount credits the wallet; negative amount debits it.
// Every adjustment is recorded in wallet_transactions for auditability.
app.post("/api/admin/customers/:id/balance", requireAdmin, async (req, res) => {
  const customerId = Number(req.params.id);
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || "Admin wallet adjustment").trim().slice(0, 250);

  if (!Number.isInteger(customerId) || customerId <= 0) return sendError(res, 400, "Invalid customer ID.");
  if (!Number.isFinite(amount) || Math.round(amount * 100) !== amount * 100 || amount === 0) {
    return sendError(res, 400, "Enter a valid non-zero balance adjustment.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customerResult = await client.query(
      "SELECT id, name, email, balance FROM customers WHERE id = $1 FOR UPDATE",
      [customerId]
    );
    if (!customerResult.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Customer not found.");
    }

    const customer = customerResult.rows[0];
    const before = Number(customer.balance || 0);
    const after = Math.round((before + amount) * 100) / 100;
    if (after < 0) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "Balance cannot be negative.");
    }

    await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [after, customerId]);

    const reference = "DGM-ADMIN-" + Date.now() + "-" + customerId;
    await client.query(
      `INSERT INTO wallet_transactions
        (customer_id, type, amount, balance_before, balance_after, description, transaction_ref, status, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $7)`,
      [customerId, amount >= 0 ? "admin_credit" : "admin_debit", amount, before, after, description, reference]
    );

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: amount >= 0 ? "Wallet credited successfully." : "Wallet debited successfully.",
      customer: { id: customer.id, name: customer.name, email: customer.email, balance: after },
      adjustment: amount
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Admin balance adjustment error:", error);
    return sendError(res, 500, "Could not update customer balance.");
  } finally {
    client.release();
  }
});

// ADMIN: permanently remove a customer and their dependent records.
// Orders and wallet history are removed only for that customer.
app.delete("/api/admin/customers/:id", requireAdmin, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) return sendError(res, 400, "Invalid customer ID.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customerResult = await client.query(
      "SELECT id, name, email FROM customers WHERE id = $1 FOR UPDATE",
      [customerId]
    );
    if (!customerResult.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Customer not found.");
    }

    // Remove dependent customer-owned records first so the delete is safe
    // even when foreign keys do not use ON DELETE CASCADE.
    await client.query("DELETE FROM wallet_transactions WHERE customer_id = $1", [customerId]);
    await client.query("DELETE FROM wallet_topups WHERE customer_id = $1", [customerId]);
    await client.query("DELETE FROM orders WHERE customer_id = $1", [customerId]);
    await client.query("DELETE FROM user_sessions WHERE sess->>'customerId' = $1", [String(customerId)]);
    await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
    await client.query("COMMIT");

    return res.json({ success: true, message: "Customer removed successfully." });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Admin customer delete error:", error);
    return sendError(res, 500, "Could not remove customer. No changes were committed.");
  } finally {
    client.release();
  }
});

// =====================================================
// REGISTER
// =====================================================

app.post(
  "/api/register",
  async (req, res) => {

    try {

      const name =
        String(
          req.body.name || ""
        ).trim();

      const phone =
        normalizeGhanaPhone(
          req.body.phone
        );

      const email =
        cleanEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password || ""
        );

      if (!name) {

        return sendError(
          res,
          400,
          "Please enter your name."
        );
      }

      if (
        !validGhanaPhone(phone)
      ) {

        return sendError(
          res,
          400,
          "Enter a valid Ghana phone number."
        );
      }

      if (!email) {

        return sendError(
          res,
          400,
          "Please enter your email."
        );
      }

      if (
        password.length < 6
      ) {

        return sendError(
          res,
          400,
          "Password must be at least 6 characters."
        );
      }

      const existing =
        await pool.query(
          `
          SELECT id
          FROM customers
          WHERE phone = $1
             OR email = $2
          LIMIT 1
          `,
          [
            phone,
            email
          ]
        );

      if (
        existing.rows.length
      ) {

        return sendError(
          res,
          409,
          "An account with that phone or email already exists."
        );
      }

      const hashedPassword =
        await bcrypt.hash(
          password,
          12
        );

      const result =
        await pool.query(
          `
          INSERT INTO customers
          (
            name,
            phone,
            email,
            password
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4
          )
          RETURNING
            id,
            name,
            phone,
            email,
            balance,
            created_at
          `,
          [
            name,
            phone,
            email,
            hashedPassword
          ]
        );

      const customer =
        result.rows[0];

      await new Promise(
        (
          resolve,
          reject
        ) => {

          req.session.regenerate(
            (error) => {

              if (error) {
                reject(error);
              } else {
                resolve();
              }
            }
          );
        }
      );

      clearLoginFailures(req);

      req.session.customerId =
        customer.id;

      await new Promise(
        (
          resolve,
          reject
        ) => {

          req.session.save(
            (error) => {

              if (error) {
                reject(error);
              } else {
                resolve();
              }
            }
          );
        }
      );

      return res.json({
        success: true,

        message:
          "Registration successful.",

        customer:
          publicCustomer(
            customer
          )
      });

    } catch (error) {

      console.error(
        "Register error:",
        error
      );

      return sendError(
        res,
        500,
        "Registration failed."
      );
    }
  }
);

// =====================================================
// FORGOT PASSWORD / PASSWORD RESET
// =====================================================

app.post("/api/forgot-password", passwordResetRateLimit, async (req, res) => {
  try {
    const identifier = String(req.body.identifier || req.body.email || "").trim();
    const genericMessage = "If an account matches those details, a password reset link has been sent.";

    if (!identifier) return res.json({ success: true, message: genericMessage });

    const email = cleanEmail(identifier);
    const phone = normalizeGhanaPhone(identifier);
    const result = await pool.query(
      `SELECT id, name, phone, email FROM customers
       WHERE email = $1 OR phone = $2 LIMIT 1`,
      [email, phone]
    );

    if (!result.rows.length) return res.json({ success: true, message: genericMessage });
    const smtpReady =
      SMTP_HOST &&
      SMTP_USER &&
      SMTP_PASSWORD &&
      SMTP_FROM_EMAIL;

    const emailServiceReady =
      RESET_EMAIL_PROVIDER === "smtp"
        ? Boolean(smtpReady)
        : Boolean(RESEND_API_KEY || smtpReady);

    if (!emailServiceReady && !RESET_TEST_MODE) {
      return sendError(
        res,
        503,
        "Password reset email service is not configured yet."
      );
    }

    const customer = result.rows[0];
    const token = createPasswordResetToken();
    const tokenHash = hashPasswordResetToken(token);

    await pool.query(
      `UPDATE password_reset_tokens SET used_at = COALESCE(used_at, NOW())
       WHERE customer_id = $1 AND used_at IS NULL`,
      [customer.id]
    );

    await pool.query(
      `INSERT INTO password_reset_tokens (customer_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
      [customer.id, tokenHash]
    );

    const resetUrl = BASE_URL.replace(/\/$/, "") +
      "/reset-password.html?token=" + encodeURIComponent(token);

    if (RESET_TEST_MODE) {
      console.warn("Password reset TEST MODE is enabled. No email was sent.");
      return res.json({
        success: true,
        message: "Test mode: password reset link generated. Open the link below to continue.",
        reset_url: resetUrl,
        test_mode: true
      });
    }

    try {
      await sendPasswordResetEmail(customer, resetUrl);
    } catch (emailError) {
      await pool.query(
        `UPDATE password_reset_tokens SET used_at = COALESCE(used_at, NOW())
         WHERE token_hash = $1`,
        [tokenHash]
      );
      console.error("Password reset email error:", emailError);
      return sendError(res, 502, "We could not send the password reset email. Please try again later.");
    }

    return res.json({ success: true, message: genericMessage });
  } catch (error) {
    console.error("Forgot password error:", error);
    return sendError(res, 500, "Could not process the password reset request.");
  }
});

app.get("/api/reset-password/verify", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token || token.length !== 64) return sendError(res, 400, "Invalid or expired reset link.");

    const tokenHash = hashPasswordResetToken(token);
    const result = await pool.query(
      `SELECT id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [tokenHash]
    );

    if (!result.rows.length) return sendError(res, 400, "Invalid or expired reset link.");
    return res.json({ success: true, message: "Reset link is valid." });
  } catch (error) {
    console.error("Reset password verify error:", error);
    return sendError(res, 500, "Could not verify reset link.");
  }
});

app.post("/api/reset-password", async (req, res) => {
  const client = await pool.connect();
  try {
    const token = String(req.body.token || "").trim();
    const newPassword = String(req.body.newPassword || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    if (!token || token.length !== 64) return sendError(res, 400, "Invalid or expired reset link.");
    if (newPassword.length < 8) return sendError(res, 400, "New password must be at least 8 characters.");
    if (newPassword !== confirmPassword) return sendError(res, 400, "Passwords do not match.");

    const tokenHash = hashPasswordResetToken(token);
    await client.query("BEGIN");

    const tokenResult = await client.query(
      `SELECT id, customer_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [tokenHash]
    );

    if (!tokenResult.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "Invalid or expired reset link.");
    }

    const resetRecord = tokenResult.rows[0];
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await client.query(
      "UPDATE customers SET password = $1 WHERE id = $2",
      [hashedPassword, resetRecord.customer_id]
    );

    await client.query(
      "UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1",
      [resetRecord.id]
    );

    await client.query("COMMIT");

    if (req.session) {
      await new Promise((resolve) => req.session.destroy(() => resolve()));
    }

    return res.json({ success: true, message: "Password reset successfully. You can now log in." });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Reset password error:", error);
    return sendError(res, 500, "Could not reset your password.");
  } finally {
    client.release();
  }
});

// =====================================================
// LOGIN
// =====================================================

app.post(
  "/api/login",
  loginRateLimit,
  async (req, res) => {

    try {

      const identifier =
        String(
          req.body.identifier ||
          req.body.login ||
          ""
        ).trim();

      const password =
        String(
          req.body.password || ""
        );

      if (
        !identifier ||
        !password
      ) {

        return sendError(
          res,
          400,
          "Enter your phone number/email and password."
        );
      }

      const phone =
        normalizeGhanaPhone(
          identifier
        );

      const email =
        cleanEmail(
          identifier
        );

      const result =
        await pool.query(
          `
          SELECT *
          FROM customers
          WHERE phone = $1
             OR email = $2
          LIMIT 1
          `,
          [
            phone,
            email
          ]
        );

      if (
        !result.rows.length
      ) {

        recordLoginFailure(req);
        recordLoginFailure(req);
        return sendError(
          res,
          401,
          "Invalid login details."
        );
      }

      const customer =
        result.rows[0];

      const passwordMatches =
        await bcrypt.compare(
          password,
          customer.password
        );

      if (!passwordMatches) {

        return sendError(
          res,
          401,
          "Invalid login details."
        );
      }

      await new Promise(
        (
          resolve,
          reject
        ) => {

          req.session.regenerate(
            (error) => {

              if (error) {
                reject(error);
              } else {
                resolve();
              }
            }
          );
        }
      );

      req.session.customerId =
        customer.id;

      await new Promise(
        (
          resolve,
          reject
        ) => {

          req.session.save(
            (error) => {

              if (error) {
                reject(error);
              } else {
                resolve();
              }
            }
          );
        }
      );

      return res.json({
        success: true,

        message:
          "Login successful.",

        customer:
          publicCustomer(
            customer
          )
      });

    } catch (error) {

      console.error(
        "Login error:",
        error
      );

      return sendError(
        res,
        500,
        "Login failed. Please try again."
      );
    }
  }
);

// =====================================================
// ME
// =====================================================

app.get(
  "/api/me",
  async (req, res) => {

    try {

      if (
        !req.session ||
        !req.session.customerId
      ) {

        return sendError(
          res,
          401,
          "Not logged in."
        );
      }

      const customer =
        await getCustomer(
          req.session.customerId
        );

      if (!customer) {

        req.session.destroy(
          () => {}
        );

        return sendError(
          res,
          401,
          "Account not found."
        );
      }

      return res.json({
        success: true,

        customer:
          publicCustomer(
            customer
          )
      });

    } catch (error) {

      console.error(
        "ME error:",
        error
      );

      return sendError(
        res,
        500,
        "Could not load account."
      );
    }
  }
);

// =====================================================
// WALLET BALANCE
// =====================================================

app.get(
  "/api/wallet",
  requireLogin,
  async (req, res) => {
    try {
      const customer = await getCustomer(req.session.customerId);

      if (!customer) {
        return sendError(res, 404, "Account not found.");
      }

      return res.json({
        success: true,
        balance: Number(customer.balance || 0)
      });
    } catch (error) {
      console.error("Wallet balance error:", error);
      return sendError(res, 500, "Could not load wallet balance.");
    }
  }
);

// =====================================================
// WALLET TRANSACTIONS
// =====================================================

app.get(
  "/api/wallet/transactions",
  requireLogin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          id,
          type,
          amount,
          balance_before,
          balance_after,
          description,
          transaction_ref,
          status,
          reference,
          created_at
        FROM wallet_transactions
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [req.session.customerId]
      );

      return res.json({
        success: true,
        transactions: result.rows
      });
    } catch (error) {
      console.error("Wallet transactions error:", error);
      return sendError(res, 500, "Could not load wallet transactions.");
    }
  }
);

// =====================================================
// WALLET WITHDRAWALS
// =====================================================

app.get("/api/wallet/withdrawals", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, reference, amount, momo_network, momo_phone, momo_name, status, admin_note, approved_at, rejected_at, paid_at, created_at
       FROM wallet_withdrawals
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.session.customerId]
    );
    return res.json({ success: true, withdrawals: result.rows });
  } catch (error) {
    console.error("Wallet withdrawals error:", error);
    return sendError(res, 500, "Could not load withdrawal requests.");
  }
});

app.post("/api/wallet/withdraw", requireLogin, async (req, res) => {
  const amount = Math.round(Number(req.body?.amount || 0) * 100) / 100;
  const network = String(req.body?.network || "").trim();
  const momoPhone = normalizeGhanaPhone(req.body?.momo_phone || req.body?.phone || "");
  const momoName = String(req.body?.momo_name || req.body?.name || "").trim().slice(0, 120);

  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
    return sendError(res, 400, "Withdrawal amount must be between GH₵1.00 and GH₵10,000.00.");
  }
  if (!["MTN", "Telecel", "AirtelTigo"].includes(network)) {
    return sendError(res, 400, "Select a valid MoMo network.");
  }
  if (!validGhanaPhone(momoPhone)) {
    return sendError(res, 400, "Enter a valid Ghana MoMo phone number.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customerResult = await client.query(
      "SELECT id, name, balance FROM customers WHERE id = $1 FOR UPDATE",
      [req.session.customerId]
    );
    if (!customerResult.rows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Customer account not found.");
    }

    const customer = customerResult.rows[0];
    const before = Number(customer.balance || 0);
    if (before < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        code: "INSUFFICIENT_WALLET_BALANCE",
        message: "Insufficient wallet balance.",
        balance: before
      });
    }

    const after = Math.round((before - amount) * 100) / 100;
    const reference = "DGM-WD-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();

    await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [after, customer.id]);

    await client.query(
      `INSERT INTO wallet_withdrawals
       (customer_id, reference, amount, momo_network, momo_phone, momo_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,'Pending Approval')`,
      [customer.id, reference, amount, network, momoPhone, momoName]
    );

    await client.query(
      `INSERT INTO wallet_transactions
       (customer_id, type, amount, balance_before, balance_after, description, transaction_ref, status, reference)
       VALUES ($1,'withdrawal_pending',$2,$3,$4,$5,$6,'Pending',$6)`,
      [customer.id, amount, before, after, "MoMo withdrawal request - " + network + " - " + momoPhone, reference]
    );

    await client.query("COMMIT");

    console.log("WALLET WITHDRAWAL REQUEST:", {
      reference,
      customerId: customer.id,
      amount,
      network,
      momoPhone,
      status: "Pending Approval"
    });

    await createCustomerNotification(customer.id, "Withdrawal submitted", "Your MoMo withdrawal of GH₵" + amount.toFixed(2) + " is pending admin approval.", "withdrawal");

    return res.json({
      success: true,
      message: "Withdrawal request submitted. DGM admin approval is required before payment.",
      withdrawal: {
        reference,
        amount,
        momo_network: network,
        momo_phone: momoPhone,
        momo_name: momoName,
        status: "Pending Approval"
      },
      balance: after
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Wallet withdrawal error:", error);
    return sendError(res, 500, "Could not submit withdrawal request.");
  } finally {
    client.release();
  }
});

// =====================================================
// CHANGE PASSWORD
// =====================================================

app.post(
  "/api/account/change-password",
  async (req, res) => {
    try {
      if (!req.session || !req.session.customerId) {
        return sendError(res, 401, "Not logged in.");
      }

      const currentPassword = String(req.body.currentPassword || "");
      const newPassword = String(req.body.newPassword || "");
      const confirmPassword = String(req.body.confirmPassword || "");

      if (!currentPassword || !newPassword || !confirmPassword) {
        return sendError(res, 400, "Please complete all password fields.");
      }

      if (newPassword.length < 8) {
        return sendError(res, 400, "New password must be at least 8 characters.");
      }

      if (newPassword !== confirmPassword) {
        return sendError(res, 400, "New passwords do not match.");
      }

      const result = await pool.query(
        `
        SELECT id, password
        FROM customers
        WHERE id = $1
        LIMIT 1
        `,
        [req.session.customerId]
      );

      if (!result.rows.length) {
        return sendError(res, 404, "Account not found.");
      }

      const customer = result.rows[0];
      const matches = await bcrypt.compare(
        currentPassword,
        customer.password
      );

      if (!matches) {
        return sendError(res, 401, "Current password is incorrect.");
      }

      const hashedPassword = await bcrypt.hash(newPassword, 12);

      await pool.query(
        `
        UPDATE customers
        SET password = $1
        WHERE id = $2
        `,
        [hashedPassword, customer.id]
      );

      return res.json({
        success: true,
        message: "Password changed successfully."
      });
    } catch (error) {
      console.error("Change password error:", error);
      return sendError(res, 500, "Could not change password.");
    }
  }
);

// =====================================================
// ACCOUNT SETTINGS
// =====================================================

app.put(
  "/api/account/settings",
  async (req, res) => {
    try {
      if (!req.session || !req.session.customerId) {
        return sendError(res, 401, "Not logged in.");
      }

      const name = String(req.body.name || "").trim();
      const email = cleanEmail(req.body.email || "");
      const phone = normalizeGhanaPhone(req.body.phone || "");

      if (!name) {
        return sendError(res, 400, "Full name is required.");
      }

      if (!email || !email.includes("@")) {
        return sendError(res, 400, "Enter a valid email address.");
      }

      if (!phone || phone.length < 10) {
        return sendError(res, 400, "Enter a valid Ghana phone number.");
      }

      const existing = await pool.query(
        `
        SELECT id
        FROM customers
        WHERE (phone = $1 OR email = $2)
          AND id <> $3
        LIMIT 1
        `,
        [
          phone,
          email,
          req.session.customerId
        ]
      );

      if (existing.rows.length) {
        return sendError(
          res,
          409,
          "That phone number or email is already used by another account."
        );
      }

      const result = await pool.query(
        `
        UPDATE customers
        SET
          name = $1,
          phone = $2,
          email = $3
        WHERE id = $4
        RETURNING
          id,
          name,
          phone,
          email,
          balance,
          created_at
        `,
        [
          name,
          phone,
          email,
          req.session.customerId
        ]
      );

      if (!result.rows.length) {
        return sendError(res, 404, "Account not found.");
      }

      return res.json({
        success: true,
        message: "Account settings updated successfully.",
        customer: publicCustomer(result.rows[0])
      });
    } catch (error) {
      console.error("Account settings error:", error);

      if (error.code === "23505") {
        return sendError(
          res,
          409,
          "That phone number or email is already in use."
        );
      }

      return sendError(res, 500, "Could not update account settings.");
    }
  }
);

// =====================================================
// LOGOUT
// =====================================================

app.post(
  "/api/logout",
  (req, res) => {

    const clearCookies =
      () => {

        res.clearCookie(
          "dgm.sid",
          {
            httpOnly: true,

            secure:
              NODE_ENV ===
              "production",

            sameSite: "lax",

            path: "/"
          }
        );

        res.clearCookie(
          "connect.sid",
          {
            httpOnly: true,

            secure:
              NODE_ENV ===
              "production",

            sameSite: "lax",

            path: "/"
          }
        );

        return res.json({
          success: true
        });
      };

    if (!req.session) {
      return clearCookies();
    }

    req.session.destroy(
      (error) => {

        if (error) {

          console.error(
            "Logout error:",
            error
          );

          return res
            .status(500)
            .json({
              success: false,
              message:
                "Logout failed."
            });
        }

        return clearCookies();
      }
    );
  }
);

// =====================================================
// CUSTOMER ORDERS
// =====================================================

app.get(
  "/api/orders",
  requireLogin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          id, order_ref, service, network, phone, amount, status,
          capacity, payment_status, paid_at, provider_reference,
          provider_status, provider_message, provider_updated_at,
          datamart_reference, datamart_status, completed_at, created_at
        FROM orders
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 100
        `,
        [req.session.customerId]
      );

      return res.json({ success: true, orders: result.rows });
    } catch (error) {
      console.error("Customer orders error:", error);
      return sendError(res, 500, "Could not load orders.");
    }
  }
);

// =====================================================
// CREATE DATA ORDER
// =====================================================

app.post(
  "/api/orders",
  requireLogin,
  async (req, res) => {

    try {

      const service =
        String(
          req.body.service ||
          "Data"
        ).trim();

      const network =
        String(
          req.body.network ||
          ""
        ).trim();

      const phone =
        normalizeGhanaPhone(
          req.body.phone
        );

      const capacity =
        normalizeCapacity(
          req.body.capacity
        );

      if (!network) {

        return sendError(
          res,
          400,
          "Please select a network."
        );
      }

      if (
        !validGhanaPhone(phone)
      ) {

        return sendError(
          res,
          400,
          "Enter a valid Ghana phone number."
        );
      }

      if (!capacity) {

        return sendError(
          res,
          400,
          "Please select a data bundle."
        );
      }

      const networkPrices =
        DGM_PRICES[
          network
        ];

      if (!networkPrices) {

        return sendError(
          res,
          400,
          "Invalid network."
        );
      }

      const amount =
        networkPrices[
          capacity
        ];

      if (
        typeof amount !==
        "number"
      ) {

        return sendError(
          res,
          400,
          "This data bundle is unavailable."
        );
      }

      const orderRef =
        createOrderReference();

      const result =
        await pool.query(
          `
          INSERT INTO orders
          (
            order_ref,
            customer_id,
            service,
            network,
            phone,
            amount,
            status,
            capacity,
            payment_status
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'Pending Payment',
            $7,
            'Pending'
          )
          RETURNING *
          `,
          [
            orderRef,

            req.session.customerId,

            service,

            network,

            phone,

            amount,

            String(capacity)
          ]
        );

      return res.json({
        success: true,

        order:
          result.rows[0]
      });

    } catch (error) {

      console.error(
        "Create order error:",
        error
      );

      return sendError(
        res,
        500,
        "Could not create order."
      );
    }
  }
);

// =====================================================
// PAY FOR DATA ORDER FROM WALLET
// =====================================================

app.post(
  "/api/orders/:orderRef/pay-wallet",
  requireLogin,
  async (req, res) => {

    const client =
      await pool.connect();

    let order = null;

    try {

      await client.query(
        "BEGIN"
      );

      const orderRef =
        String(
          req.params.orderRef || ""
        ).trim();

      if (!orderRef) {

        await client.query(
          "ROLLBACK"
        );

        return sendError(
          res,
          400,
          "Order reference is required."
        );
      }

      const orderResult =
        await client.query(
          `
          SELECT *
          FROM orders
          WHERE order_ref = $1
            AND customer_id = $2
          FOR UPDATE
          `,
          [
            orderRef,
            req.session.customerId
          ]
        );

      if (
        !orderResult.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );

        return sendError(
          res,
          404,
          "Order not found."
        );
      }

      order =
        orderResult.rows[0];

      if (
        !isDataService(
          order.service
        )
      ) {

        await client.query(
          "ROLLBACK"
        );

        return sendError(
          res,
          400,
          "This payment method is only available for data orders."
        );
      }

      if (
        String(
          order.payment_status || ""
        ).toLowerCase() ===
        "paid"
      ) {

        await client.query(
          "COMMIT"
        );

        const currentCustomer =
          await getCustomer(
            req.session.customerId
          );

        return res.json({
          success: true,

          alreadyPaid: true,

          paymentMethod:
            order.paystack_reference
              ? "Paystack"
              : "Wallet",

          balance:
            Number(
              currentCustomer?.balance ||
              0
            ),

          order
        });
      }

      const capacity =
        normalizeCapacity(
          order.capacity
        );

      const networkPrices =
        DGM_PRICES[
          order.network
        ];

      if (!networkPrices) {

        throw new Error(
          "Invalid order network."
        );
      }

      if (!capacity) {

        throw new Error(
          "Invalid order data capacity."
        );
      }

      const expectedAmount =
        networkPrices[
          capacity
        ];

      if (
        typeof expectedAmount !==
        "number"
      ) {

        throw new Error(
          "This data bundle is unavailable."
        );
      }

      const orderAmount =
        Number(order.amount);

      if (
        !Number.isFinite(
          orderAmount
        ) ||
        Math.round(
          orderAmount * 100
        ) !==
        Math.round(
          expectedAmount * 100
        )
      ) {

        throw new Error(
          "Order amount does not match the current DGM price."
        );
      }

      const customerResult =
        await client.query(
          `
          SELECT
            id,
            name,
            phone,
            email,
            balance
          FROM customers
          WHERE id = $1
          FOR UPDATE
          `,
          [
            req.session.customerId
          ]
        );

      if (
        !customerResult.rows.length
      ) {

        throw new Error(
          "Customer account not found."
        );
      }

      const customer =
        customerResult.rows[0];

      const balanceBefore =
        Number(
          customer.balance || 0
        );

      if (
        !Number.isFinite(
          balanceBefore
        ) ||
        balanceBefore < 0
      ) {

        throw new Error(
          "Your wallet balance is invalid."
        );
      }

      if (
        balanceBefore <
        orderAmount
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          code:
            "INSUFFICIENT_WALLET_BALANCE",

          message:
            `Insufficient wallet balance. You need GH₵${orderAmount.toFixed(2)} but your wallet has GH₵${balanceBefore.toFixed(2)}.`,

          balance:
            balanceBefore,

          required:
            orderAmount,

          shortfall:
            Math.round(
              (
                orderAmount -
                balanceBefore
              ) * 100
            ) / 100
        });
      }

      const walletReference =
        `DGM-DATA-${order.order_ref}`;

      const existingTransaction =
        await client.query(
          `
          SELECT
            id,
            customer_id,
            amount,
            balance_before,
            balance_after,
            status,
            reference,
            transaction_ref
          FROM wallet_transactions
          WHERE reference = $1
          FOR UPDATE
          `,
          [
            walletReference
          ]
        );

      if (
        existingTransaction.rows.length
      ) {

        const transaction =
          existingTransaction.rows[0];

        if (
          Number(
            transaction.customer_id
          ) !==
          Number(
            customer.id
          )
        ) {

          throw new Error(
            "Wallet transaction ownership mismatch."
          );
        }

        if (
          Math.round(
            Number(
              transaction.amount
            ) * 100
          ) !==
          Math.round(
            orderAmount * 100
          )
        ) {

          throw new Error(
            "Existing wallet transaction amount does not match this order."
          );
        }

        await client.query(
          `
          UPDATE orders
          SET
            payment_status = 'Paid',
            paid_at =
              COALESCE(
                paid_at,
                NOW()
              ),
            status =
              CASE
                WHEN status = 'Pending Payment'
                THEN 'Processing'
                ELSE status
              END,
            paystack_reference = NULL
          WHERE id = $1
          `,
          [
            order.id
          ]
        );

        await client.query(
          "COMMIT"
        );

        const refreshed =
          await pool.query(
            `
            SELECT *
            FROM orders
            WHERE id = $1
            `,
            [order.id]
          );

        order =
          refreshed.rows[0];

      } else {

        const balanceAfter =
          Math.round(
            (
              balanceBefore -
              orderAmount
            ) * 100
          ) / 100;

        const balanceUpdate =
          await client.query(
            `
            UPDATE customers
            SET balance = $1
            WHERE id = $2
            RETURNING
              id,
              balance
            `,
            [
              balanceAfter,

              customer.id
            ]
          );

        if (
          !balanceUpdate.rows.length
        ) {

          throw new Error(
            "Wallet balance could not be updated."
          );
        }

        const transactionResult =
          await client.query(
            `
            INSERT INTO wallet_transactions
            (
              customer_id,
              type,
              amount,
              balance_before,
              balance_after,
              description,
              transaction_ref,
              status,
              reference
            )
            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9
            )
            RETURNING
              id,
              customer_id,
              type,
              amount,
              balance_before,
              balance_after,
              description,
              transaction_ref,
              status,
              reference,
              created_at
            `,
            [
              customer.id,

              "Debit",

              orderAmount,

              balanceBefore,

              balanceAfter,

              `Data purchase - ${order.network} ${order.capacity} - ${order.phone}`,

              order.order_ref,

              "Completed",

              walletReference
            ]
          );

        if (
          !transactionResult.rows.length
        ) {

          throw new Error(
            "Wallet debit transaction could not be created."
          );
        }

        await client.query(
          `
          UPDATE orders
          SET
            payment_status = 'Paid',
            paid_at =
              COALESCE(
                paid_at,
                NOW()
              ),
            status = 'Processing',
            paystack_reference = NULL
          WHERE id = $1
          `,
          [
            order.id
          ]
        );

        await client.query(
          "COMMIT"
        );

        console.log(
          `WALLET DATA PAYMENT: ${order.order_ref} | ` +
          `${order.network} ${order.capacity} | ` +
          `GH₵${orderAmount.toFixed(2)} | ` +
          `Before: GH₵${balanceBefore.toFixed(2)} | ` +
          `After: GH₵${balanceAfter.toFixed(2)} | ` +
          `Transaction: ${transactionResult.rows[0].id}`
        );

        const refreshed =
          await pool.query(
            `
            SELECT *
            FROM orders
            WHERE id = $1
            `,
            [order.id]
          );

        order =
          refreshed.rows[0];
      }

      let fulfillmentResult;

      try {

        fulfillmentResult =
          await fulfillDataOrder(
            order
          );

      } catch (fulfillmentError) {

        console.error(
          `Wallet-paid DataMart fulfillment error for ${order.order_ref}:`,
          fulfillmentError
        );

        await pool.query(
          `
          UPDATE orders
          SET
            status = 'Processing',
            datamart_status = $1
          WHERE id = $2
            AND payment_status = 'Paid'
          `,
          [
            `payment_confirmed_pending_fulfillment: ${fulfillmentError.message}`,

            order.id
          ]
        );

        fulfillmentResult = {
          success: false,

          status: "Processing",

          pendingFulfillment: true,

          error:
            fulfillmentError.message
        };
      }

      if (
        fulfillmentResult &&
        fulfillmentResult.status ===
          "Failed"
      ) {

        await pool.query(
          `
          UPDATE orders
          SET
            status = 'Processing',
            datamart_status = $1
          WHERE id = $2
            AND payment_status = 'Paid'
          `,
          [
            `payment_confirmed_pending_fulfillment: ${
              fulfillmentResult.error ||
              "DataMart fulfillment requires retry."
            }`,

            order.id
          ]
        );

        fulfillmentResult = {
          ...fulfillmentResult,

          success: false,

          status: "Processing",

          pendingFulfillment: true
        };
      }

      const finalResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE id = $1
          `,
          [
            order.id
          ]
        );

      const finalOrder =
        finalResult.rows[0];

      const finalCustomer =
        await getCustomer(
          req.session.customerId
        );

      const finalBalance =
        Number(
          finalCustomer?.balance ||
          0
        );

      return res.json({

        success: true,

        paid: true,

        paymentMethod:
          "Wallet",

        amount:
          orderAmount,

        balance:
          finalBalance,

        order:
          finalOrder,

        fulfillment:
          fulfillmentResult
      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch (rollbackError) {

        console.error(
          "Wallet data rollback error:",
          rollbackError
        );
      }

      console.error(
        "Wallet data payment error:",
        error
      );

      return sendError(
        res,
        500,
        error.message ||
          "Wallet payment failed."
      );

    } finally {

      client.release();
    }
  }
);

// =====================================================
// CREATE AIRTIME ORDER
// Airtime is paid from the customer's DGM wallet.
// Delivery remains Pending until an approved airtime
// fulfillment provider is connected.
// =====================================================

app.post(
  "/api/airtime/orders",
  requireLogin,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const network = String(req.body.network || "").trim();
      const phone = normalizeGhanaPhone(req.body.phone);
      const amount = Number(req.body.amount);

      if (!["MTN","AirtelTigo","Telecel"].includes(network)) {
        await client.query("ROLLBACK");
        return sendError(res,400,"Invalid airtime network.");
      }

      if (!validGhanaPhone(phone)) {
        await client.query("ROLLBACK");
        return sendError(res,400,"Enter a valid Ghana phone number.");
      }

      if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
        await client.query("ROLLBACK");
        return sendError(
          res,400,"Airtime amount must be between GH₵1 and GH₵500."
        );
      }

      const roundedAmount = Math.round(amount * 100) / 100;

      const customerResult = await client.query(
        `
        SELECT id,balance
        FROM customers
        WHERE id = $1
        FOR UPDATE
        `,
        [req.session.customerId]
      );

      if (!customerResult.rows.length) {
        await client.query("ROLLBACK");
        return sendError(res,404,"Customer account not found.");
      }

      const customer = customerResult.rows[0];
      const balanceBefore = Number(customer.balance || 0);

      if (balanceBefore < roundedAmount) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success:false,
          code:"INSUFFICIENT_WALLET_BALANCE",
          message:
            "Insufficient wallet balance. You need GH₵" +
            roundedAmount.toFixed(2) +
            " but your wallet has GH₵" +
            balanceBefore.toFixed(2) + ".",
          balance:balanceBefore,
          required:roundedAmount,
          shortfall:
            Math.round((roundedAmount - balanceBefore) * 100) / 100
        });
      }

      const orderRef = createOrderReference();
      const walletReference = "DGM-AIRTIME-" + orderRef;
      const balanceAfter =
        Math.round((balanceBefore - roundedAmount) * 100) / 100;

      await client.query(
        "UPDATE customers SET balance = $1 WHERE id = $2",
        [balanceAfter,customer.id]
      );

      const orderResult = await client.query(
        `
        INSERT INTO orders
        (order_ref,customer_id,service,network,phone,amount,status,payment_status,paid_at,provider_status)
        VALUES ($1,$2,'Airtime',$3,$4,$5,'Pending','Paid',NOW(),'pending')
        RETURNING *
        `,
        [
          orderRef,
          customer.id,
          network,
          phone,
          roundedAmount
        ]
      );

      const transactionResult = await client.query(
        `
        INSERT INTO wallet_transactions
        (customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference)
        VALUES ($1,'Debit',$2,$3,$4,$5,$6,'Completed',$7)
        RETURNING id,amount,balance_before,balance_after,description,transaction_ref,status,reference,created_at
        `,
        [
          customer.id,
          roundedAmount,
          balanceBefore,
          balanceAfter,
          "Airtime purchase - " + network + " - " + phone,
          orderRef,
          walletReference
        ]
      );

      await client.query("COMMIT");

      const fulfillment =
        await submitKingflexyAirtime(orderResult.rows[0]);

      const finalResult = await pool.query(
        "SELECT * FROM orders WHERE id = $1 LIMIT 1",
        [orderResult.rows[0].id]
      );

      const finalOrder =
        finalResult.rows[0] || orderResult.rows[0];

      return res.json({
        success:true,
        paid:true,
        paymentMethod:"Wallet",
        order:finalOrder,
        transaction:transactionResult.rows[0],
        balance:balanceAfter,
        fulfillment,
        message:
          finalOrder.status === "Completed"
            ? "Airtime delivered successfully."
            : finalOrder.status === "Refunded"
              ? "Airtime provider refunded the transaction and your wallet was credited."
              : "Wallet payment confirmed. KingFlexy is processing the airtime."
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("Create airtime order error:",error);
      return sendError(
        res,500,error.message || "Could not create airtime order."
      );
    } finally {
      client.release();
    }
  }
);

// =====================================================
// DGM USSD STORE
// Provider-neutral webhook. A Ghana USSD provider can POST
// sessionId, phoneNumber, text and serviceCode to /api/ussd.
// =====================================================

const ussdSessions = new Map();

const DGM_USSD_PRICES = {
  MTN: { "1": 5, "2": 10, "3": 15, "4": 20, "5": 24, "6": 28, "8": 36, "10": 45, "15": 64, "20": 84, "25": 100, "30": 128, "40": 168, "50": 207 },
  AirtelTigo: { "1": 5, "2": 10, "3": 15, "4": 20, "5": 24, "6": 26, "8": 35, "10": 45, "12": 48, "15": 65, "25": 100, "30": 120, "40": 160, "50": 200 },
  Telecel: { "10": 45, "15": 60, "20": 76, "25": 100, "30": 115, "35": 136, "40": 150, "45": 165, "50": 185, "100": 407 }
};

function ussdClean(value) {
  return String(value || "").trim();
}

function ussdSessionKey(req) {
  return ussdClean(req.body?.sessionId || req.body?.session_id || req.body?.phoneNumber || req.body?.phone || "unknown");
}

function ussdResponse(res, message, end = false) {
  return res.type("text/plain").send((end ? "END " : "CON ") + message);
}

function ussdMenu(state) {
  if (!state.step) {
    return "DHE GENIUS MEDIA\\n1. Buy Data\\n2. Buy Airtime\\n3. Check Balance\\n4. My Orders\\n5. Support";
  }
  if (state.step === "data_network") return "Select network:\\n1. MTN\\n2. Telecel\\n3. AirtelTigo";
  if (state.step === "data_package") {
    const prices = DGM_USSD_PRICES[state.network] || {};
    return state.network + " bundles:\\n" + Object.entries(prices).map(([gb, price], i) => (i + 1) + ". " + gb + "GB - GH₵" + price).join("\\n");
  }
  if (state.step === "data_phone") return "Enter recipient Ghana phone number:";
  if (state.step === "data_confirm") return "Buy " + state.capacity + "GB " + state.network + " for GH₵" + state.amount + " to " + state.phone + "?\\n1. Confirm\\n2. Cancel";
  if (state.step === "airtime_network") return "Select network:\\n1. MTN\\n2. Telecel\\n3. AirtelTigo";
  if (state.step === "airtime_amount") return "Enter airtime amount (GH₵1-500):";
  if (state.step === "airtime_phone") return "Enter recipient Ghana phone number:";
  if (state.step === "airtime_confirm") return "Buy GH₵" + state.amount + " airtime on " + state.network + " for " + state.phone + "?\\n1. Confirm\\n2. Cancel";
  return "DHE GENIUS MEDIA\\n1. Buy Data\\n2. Buy Airtime\\n3. Check Balance\\n4. My Orders\\n5. Support";
}

function ussdNetwork(choice) {
  return ({ "1": "MTN", "2": "Telecel", "3": "AirtelTigo" })[choice] || null;
}

function ussdDataNetwork(choice) {
  return ({ "1": "MTN", "2": "Telecel", "3": "AirtelTigo" })[choice] || null;
}

function ussdPhone(value) {
  const digits = ussdClean(value).replace(/[^0-9+]/g, "");
  const normalized = typeof normalizeGhanaPhone === "function" ? normalizeGhanaPhone(digits) : digits;
  return normalized;
}

app.post("/api/ussd", async (req, res) => {
  const sessionKey = ussdSessionKey(req);
  const text = ussdClean(req.body?.text || "");
  const phoneNumber = ussdPhone(req.body?.phoneNumber || req.body?.phone || "");

  let state = ussdSessions.get(sessionKey) || { step: "", phoneNumber };
  if (phoneNumber) state.phoneNumber = phoneNumber;

  const parts = text ? text.split("*").map(ussdClean).filter(Boolean) : [];
  const choice = parts.length ? parts[parts.length - 1] : "";

  try {
    if (!text) {
      state = { step: "", phoneNumber };
      ussdSessions.set(sessionKey, state);
      return ussdResponse(res, ussdMenu(state));
    }

    if (state.step === "") {
      if (choice === "1") state.step = "data_network";
      else if (choice === "2") state.step = "airtime_network";
      else if (choice === "3") {
        if (!validGhanaPhone(phoneNumber)) return ussdResponse(res, "Please use the Ghana phone number registered on your DGM account.", true);
        const customer = await pool.query("SELECT balance FROM customers WHERE phone = $1 LIMIT 1", [phoneNumber]);
        if (!customer.rows.length) return ussdResponse(res, "No DGM account found for " + phoneNumber + ". Register on the DGM website first.", true);
        return ussdResponse(res, "DGM Wallet Balance: GH₵" + Number(customer.rows[0].balance || 0).toFixed(2), true);
      } else if (choice === "4") {
        if (!validGhanaPhone(phoneNumber)) return ussdResponse(res, "Please use your registered Ghana phone number.", true);
        const customer = await pool.query("SELECT id FROM customers WHERE phone = $1 LIMIT 1", [phoneNumber]);
        if (!customer.rows.length) return ussdResponse(res, "No DGM account found for this number.", true);
        const orders = await pool.query("SELECT order_ref, service, amount, status FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 3", [customer.rows[0].id]);
        if (!orders.rows.length) return ussdResponse(res, "No orders found.", true);
        return ussdResponse(res, "Recent orders:\\n" + orders.rows.map(o => o.order_ref + " " + o.service + " GH₵" + Number(o.amount).toFixed(2) + " " + o.status).join("\\n"), true);
      } else if (choice === "5") {
        return ussdResponse(res, "DGM Support: WhatsApp 0241518385\\nCall 0508667776", true);
      } else return ussdResponse(res, ussdMenu({}));
    } else if (state.step === "data_network") {
      const network = ussdDataNetwork(choice);
      if (!network) return ussdResponse(res, "Invalid network.\\n" + ussdMenu(state));
      state.network = network; state.step = "data_package"; ussdSessions.set(sessionKey, state);
      return ussdResponse(res, ussdMenu(state));
    } else if (state.step === "data_package") {
      const entries = Object.entries(DGM_USSD_PRICES[state.network] || {});
      const index = Number(choice) - 1;
      if (!entries[index]) return ussdResponse(res, ussdMenu(state));
      const [capacity, amount] = entries[index];
      state.capacity = capacity; state.amount = amount; state.step = "data_phone"; ussdSessions.set(sessionKey, state);
      return ussdResponse(res, ussdMenu(state));
    } else if (state.step === "data_phone") {
      const phone = ussdPhone(choice);
      if (!validGhanaPhone(phone)) return ussdResponse(res, "Invalid Ghana phone number. Try again.");
      state.phone = phone; state.step = "data_confirm"; ussdSessions.set(sessionKey, state);
      return ussdResponse(res, ussdMenu(state));
    } else if (state.step === "data_confirm") {
      if (choice !== "1") { ussdSessions.delete(sessionKey); return ussdResponse(res, "Transaction cancelled.", true); }
      if (!validGhanaPhone(state.phone) || !validGhanaPhone(phoneNumber)) return ussdResponse(res, "A valid registered DGM phone number is required.", true);
      const customerResult = await pool.query("SELECT id,balance FROM customers WHERE phone = $1 LIMIT 1", [phoneNumber]);
      if (!customerResult.rows.length) return ussdResponse(res, "No DGM account found. Register on the website first.", true);
      const customer = customerResult.rows[0];
      const amount = Number(state.amount);
      if (Number(customer.balance || 0) < amount) return ussdResponse(res, "Insufficient wallet balance. Please top up your DGM wallet first.", true);
      return ussdResponse(res, "USSD purchase is ready. For safety, data fulfillment is completed through the authenticated DGM checkout until your USSD provider is connected.", true);
    } else if (state.step === "airtime_network") {
      const network = ussdNetwork(choice);
      if (!network) return ussdResponse(res, "Invalid network.\\n" + ussdMenu(state));
      state.network = network; state.step = "airtime_amount"; ussdSessions.set(sessionKey, state);
      return ussdResponse(res, ussdMenu(state));
    } else if (state.step === "airtime_amount") {
      const amount = Number(choice);
      if (!Number.isFinite(amount) || amount < 1 || amount > 500) return ussdResponse(res, "Enter an amount from GH₵1 to GH₵500.");
      state.amount = Math.round(amount * 100) / 100; state.step = "airtime_phone"; ussdSessions.set(sessionKey, state);
      return ussdResponse(res, ussdMenu(state));
    } else if (state.step === "airtime_phone") {
      const phone = ussdPhone(choice);
      if (!validGhanaPhone(phone)) return ussdResponse(res, "Invalid Ghana phone number. Try again.");
      state.phone = phone; state.step = "airtime_confirm"; ussdSessions.set(sessionKey, state);
      return ussdResponse(res, ussdMenu(state));
    } else if (state.step === "airtime_confirm") {
      ussdSessions.delete(sessionKey);
      return ussdResponse(res, choice === "1" ? "USSD airtime purchase is ready. Connect your approved USSD provider to enable live wallet debit and delivery." : "Transaction cancelled.", true);
    }

    ussdSessions.delete(sessionKey);
    return ussdResponse(res, "Session expired. Dial the DGM USSD code again.", true);
  } catch (error) {
    console.error("USSD error:", error);
    ussdSessions.delete(sessionKey);
    return ussdResponse(res, "DGM USSD service is temporarily unavailable. Please try again.", true);
  }
});

// =====================================================
// =====================================================
 // TRANSACTION CENTER / NOTIFICATIONS / SUPPORT / RECEIPTS
 // =====================================================

async function createCustomerNotification(customerId, title, message, type = "info") {
  try {
    await pool.query(
      `INSERT INTO customer_notifications
       (customer_id,title,message,type)
       VALUES ($1,$2,$3,$4)`,
      [customerId, String(title).slice(0,160), String(message).slice(0,2000), String(type).slice(0,40)]
    );
  } catch (error) {
    console.error("Notification creation error:", error.message);
  }
}

function requireCustomer(req, res, next) {
  if (!req.session || !req.session.customerId) {
    return res.status(401).json({ success:false, message:"Please log in to continue." });
  }
  next();
}

app.get("/api/notifications", requireCustomer, async (req,res) => {
  try {
    const result = await pool.query(
      `SELECT id,title,message,type,read_at,created_at
       FROM customer_notifications
       WHERE customer_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.session.customerId]
    );
    return res.json({success:true,notifications:result.rows,unread_count:result.rows.filter(n=>!n.read_at).length});
  } catch (error) {
    console.error("Notifications load error:",error);
    return res.status(500).json({success:false,message:"Could not load notifications."});
  }
});

app.post("/api/notifications/:id/read", requireCustomer, async (req,res) => {
  try {
    const result=await pool.query(
      `UPDATE customer_notifications SET read_at=COALESCE(read_at,NOW())
       WHERE id=$1 AND customer_id=$2 RETURNING id,read_at`,
      [Number(req.params.id),req.session.customerId]
    );
    if(!result.rows.length) return res.status(404).json({success:false,message:"Notification not found."});
    return res.json({success:true,notification:result.rows[0]});
  } catch(error) {
    console.error("Notification read error:",error);
    return res.status(500).json({success:false,message:"Could not update notification."});
  }
});

app.get("/api/transactions", requireCustomer, async (req,res) => {
  try {
    const [wallet,topups,withdrawals,orders]=await Promise.all([
      pool.query(`SELECT id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference,created_at FROM wallet_transactions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.session.customerId]),
      pool.query(`SELECT id,reference,amount,status,payment_status,paid_at,created_at FROM wallet_topups WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.session.customerId]),
      pool.query(`SELECT id,reference,amount,momo_network,momo_phone,momo_name,status,admin_note,created_at,updated_at FROM wallet_withdrawals WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.session.customerId]),
      pool.query(`SELECT id,order_ref,service,network,phone,amount,status,payment_status,provider_reference,created_at,completed_at FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.session.customerId])
    ]);
    return res.json({success:true,wallet_transactions:wallet.rows,wallet_topups:topups.rows,withdrawals:withdrawals.rows,orders:orders.rows});
  } catch(error) {
    console.error("Transaction center error:",error);
    return res.status(500).json({success:false,message:"Could not load your transaction center."});
  }
});

app.get("/api/receipts/order/:id", requireCustomer, async (req,res) => {
  try {
    const result=await pool.query(
      `SELECT id,order_ref,service,network,phone,amount,status,payment_status,provider_reference,created_at,completed_at FROM orders WHERE id=$1 AND customer_id=$2 LIMIT 1`,
      [Number(req.params.id),req.session.customerId]
    );
    if(!result.rows.length) return res.status(404).json({success:false,message:"Order not found."});
    return res.json({success:true,receipt:result.rows[0]});
  } catch(error) {
    console.error("Receipt error:",error);
    return res.status(500).json({success:false,message:"Could not load receipt."});
  }
});

app.get("/api/support/tickets", requireCustomer, async (req,res) => {
  try {
    const result=await pool.query(
      `SELECT id,subject,message,status,admin_reply,replied_at,created_at,updated_at FROM support_tickets WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.session.customerId]
    );
    return res.json({success:true,tickets:result.rows});
  } catch(error) {
    console.error("Support load error:",error);
    return res.status(500).json({success:false,message:"Could not load support tickets."});
  }
});

app.post("/api/support/tickets", requireCustomer, async (req,res) => {
  try {
    const subject=String(req.body?.subject||"").trim();
    const message=String(req.body?.message||"").trim();
    if(subject.length<3 || message.length<5) return res.status(400).json({success:false,message:"Please enter a subject and message."});
    const result=await pool.query(
      `INSERT INTO support_tickets(customer_id,subject,message) VALUES($1,$2,$3) RETURNING id,subject,message,status,created_at`,
      [req.session.customerId,subject.slice(0,160),message.slice(0,5000)]
    );
    await createCustomerNotification(req.session.customerId,"Support request received","Your support request has been received. Our team will review it.","support");
    return res.status(201).json({success:true,ticket:result.rows[0]});
  } catch(error) {
    console.error("Support create error:",error);
    return res.status(500).json({success:false,message:"Could not create support request."});
  }
});

app.get("/api/admin/support/tickets", async (req,res) => {
  if(!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
  try {
    const result=await pool.query(
      `SELECT t.id,t.subject,t.message,t.status,t.admin_reply,t.replied_at,t.created_at,t.updated_at,
              c.name AS customer_name,c.email AS customer_email,c.phone AS customer_phone
       FROM support_tickets t JOIN customers c ON c.id=t.customer_id
       ORDER BY CASE WHEN t.status='Open' THEN 0 ELSE 1 END,t.created_at DESC
       LIMIT 200`
    );
    return res.json({success:true,tickets:result.rows});
  } catch(error) {
    console.error("Admin support load error:",error);
    return res.status(500).json({success:false,message:"Could not load support tickets."});
  }
});

app.post("/api/admin/support/tickets/:id/reply", async (req,res) => {
  if(!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
  try {
    const id=Number(req.params.id);
    const reply=String(req.body?.reply||"").trim().slice(0,5000);
    if(!Number.isInteger(id)||id<=0||reply.length<2) return res.status(400).json({success:false,message:"Enter a valid reply."});
    const result=await pool.query(
      `UPDATE support_tickets SET admin_reply=$2,status='Closed',replied_at=NOW(),updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id,reply]
    );
    if(!result.rows.length) return res.status(404).json({success:false,message:"Support ticket not found."});
    await createCustomerNotification(result.rows[0].customer_id,"Support reply received",reply,"support");
    return res.json({success:true,message:"Reply sent and ticket closed.",ticket:result.rows[0]});
  } catch(error) {
    console.error("Admin support reply error:",error);
    return res.status(500).json({success:false,message:"Could not send support reply."});
  }
});

app.get("/api/admin/analytics", async (req,res) => {
  if(!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
  try {
    const [sales,wallet,withdrawals,customers]=await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('Completed','completed')),0) AS completed_sales, COALESCE(SUM(amount),0) AS total_order_value, COUNT(*) AS order_count FROM orders WHERE created_at >= NOW()-INTERVAL '30 days'`),
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE LOWER(type) IN ('credit','admin_credit','topup')),0) AS wallet_in, COALESCE(SUM(amount) FILTER (WHERE LOWER(type) IN ('debit','admin_debit','purchase','withdrawal_pending')),0) AS wallet_out FROM wallet_transactions WHERE created_at >= NOW()-INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='Pending Approval') AS pending, COALESCE(SUM(amount) FILTER (WHERE status IN ('Approved','Paid')),0) AS approved_value FROM wallet_withdrawals WHERE created_at >= NOW()-INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) AS total FROM customers`)
    ]);
    return res.json({success:true,period:"30 days",sales:sales.rows[0],wallet:wallet.rows[0],withdrawals:withdrawals.rows[0],customers:customers.rows[0]});
  } catch(error) {
    console.error("Admin analytics error:",error);
    return res.status(500).json({success:false,message:"Could not load analytics."});
  }
});

// =====================================================
// REWARDS / REFERRALS / SAVED RECIPIENTS / DEVELOPER API
// =====================================================
function makeReferralCode(id){ return "DGM" + String(id).padStart(4,"0") + crypto.randomBytes(2).toString("hex").toUpperCase(); }
async function ensureReferralCode(customerId){
  const r=await pool.query("SELECT referral_code FROM customers WHERE id=$1",[customerId]);
  if(!r.rows.length) return null;
  if(r.rows[0].referral_code) return r.rows[0].referral_code;
  let code; for(let i=0;i<5;i++){ code=makeReferralCode(customerId); try{ const u=await pool.query("UPDATE customers SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL RETURNING referral_code",[code,customerId]); if(u.rows.length)return u.rows[0].referral_code; }catch{} }
  return null;
}
app.get("/api/rewards", requireCustomer, async(req,res)=>{try{
  const id=req.session.customerId; const code=await ensureReferralCode(id);
  const [c,r,l]=await Promise.all([
    pool.query("SELECT balance,loyalty_points,cashback_balance,account_type FROM customers WHERE id=$1",[id]),
    pool.query("SELECT COUNT(*)::int AS count,COALESCE(SUM(reward_points),0)::int AS points,COALESCE(SUM(reward_amount),0)::numeric AS amount FROM referrals WHERE referrer_id=$1 AND status='Rewarded'",[id]),
    pool.query("SELECT points,reason,reference,created_at FROM loyalty_transactions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50",[id])
  ]); return res.json({success:true,referral_code:code,customer:c.rows[0],referrals:r.rows[0],loyalty:l.rows});
}catch(e){console.error("Rewards error",e);res.status(500).json({success:false,message:"Could not load rewards."});}});
app.post("/api/rewards/apply-referral", requireCustomer, async(req,res)=>{try{
  const code=String(req.body?.code||"").trim().toUpperCase(); const id=req.session.customerId;
  if(!code) return res.status(400).json({success:false,message:"Enter a referral code."});
  const rr=await pool.query("SELECT id FROM customers WHERE referral_code=$1 LIMIT 1",[code]);
  if(!rr.rows.length||Number(rr.rows[0].id)===Number(id)) return res.status(400).json({success:false,message:"Invalid referral code."});
  const ins=await pool.query("INSERT INTO referrals(referrer_id,referred_id) VALUES($1,$2) ON CONFLICT(referred_id) DO NOTHING RETURNING id",[rr.rows[0].id,id]);
  if(!ins.rows.length) return res.status(400).json({success:false,message:"A referral has already been applied to this account."});
  return res.json({success:true,message:"Referral applied. Rewards are issued after the qualifying purchase."});
}catch(e){console.error("Referral apply error",e);res.status(500).json({success:false,message:"Could not apply referral."});}});
app.get("/api/saved-recipients",requireCustomer,async(req,res)=>{const r=await pool.query("SELECT id,label,phone,network,created_at FROM saved_recipients WHERE customer_id=$1 ORDER BY created_at DESC",[req.session.customerId]);res.json({success:true,recipients:r.rows});});
app.post("/api/saved-recipients",requireCustomer,async(req,res)=>{try{const label=String(req.body?.label||"").trim().slice(0,80),phone=String(req.body?.phone||"").trim(),network=String(req.body?.network||"").trim();if(label.length<1||!validGhanaPhone(phone))return res.status(400).json({success:false,message:"Enter a valid label and Ghana phone number."});const r=await pool.query("INSERT INTO saved_recipients(customer_id,label,phone,network) VALUES($1,$2,$3,$4) ON CONFLICT(customer_id,label) DO UPDATE SET phone=EXCLUDED.phone,network=EXCLUDED.network RETURNING *",[req.session.customerId,label,phone,network||null]);res.status(201).json({success:true,recipient:r.rows[0]});}catch(e){res.status(500).json({success:false,message:"Could not save recipient."});}});
app.delete("/api/saved-recipients/:id",requireCustomer,async(req,res)=>{await pool.query("DELETE FROM saved_recipients WHERE id=$1 AND customer_id=$2",[Number(req.params.id),req.session.customerId]);res.json({success:true});});
app.post("/api/admin/promo-codes",async(req,res)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});try{const code=String(req.body?.code||"").trim().toUpperCase();const value=Number(req.body?.discount_value);if(!code||!Number.isFinite(value)||value<=0)return res.status(400).json({success:false,message:"Invalid promotion."});const r=await pool.query("INSERT INTO promo_codes(code,discount_type,discount_value,max_uses,min_amount,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[code,req.body?.discount_type||"percent",value,req.body?.max_uses?Number(req.body.max_uses):null,Number(req.body?.min_amount||0),req.body?.expires_at||null]);res.status(201).json({success:true,promo:r.rows[0]});}catch(e){res.status(400).json({success:false,message:e.message});}});
app.get("/api/admin/promo-codes",async(req,res)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});const r=await pool.query("SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 200");res.json({success:true,promos:r.rows});});
app.post("/api/admin/api-keys",async(req,res)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});try{const customerId=Number(req.body?.customer_id);const name=String(req.body?.name||"DGM API").slice(0,80);if(!Number.isInteger(customerId))return res.status(400).json({success:false,message:"Valid customer_id required."});const raw="dgm_live_"+crypto.randomBytes(24).toString("hex");const hash=crypto.createHash("sha256").update(raw).digest("hex");const r=await pool.query("INSERT INTO customer_api_keys(customer_id,name,key_hash,key_prefix) VALUES($1,$2,$3,$4) RETURNING id,name,key_prefix,created_at",[customerId,name,hash,raw.slice(0,16)]);res.status(201).json({success:true,key:raw,record:r.rows[0],warning:"Save this key now. It cannot be shown again."});}catch(e){res.status(400).json({success:false,message:e.message});}});
app.get("/api/admin/api-keys",async(req,res)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});const r=await pool.query("SELECT k.id,k.customer_id,k.name,k.key_prefix,k.active,k.last_used_at,k.created_at,c.email,c.name AS customer_name FROM customer_api_keys k JOIN customers c ON c.id=k.customer_id ORDER BY k.created_at DESC LIMIT 200");res.json({success:true,keys:r.rows});});


// =====================================================
// DGM MY DEVICES SMS — AUTHORIZED DEVICE SYNC
// =====================================================
const SMS_CIPHER_KEY = crypto.createHash("sha256").update(String(SESSION_SECRET)).digest();

function smsEncrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SMS_CIPHER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value ?? ""), "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}
function smsDecrypt(value) {
  try {
    const [ivB64, tagB64, dataB64] = String(value || "").split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", SMS_CIPHER_KEY, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch { return ""; }
}
async function ensureSmsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_devices (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      phone VARCHAR(40),
      token_hash CHAR(64) NOT NULL UNIQUE,
      token_prefix VARCHAR(20) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sms_messages (
      id SERIAL PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES sms_devices(id) ON DELETE CASCADE,
      external_id VARCHAR(180),
      direction VARCHAR(20) NOT NULL DEFAULT 'received',
      sender_enc TEXT,
      body_enc TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(device_id, external_id)
    );
    CREATE INDEX IF NOT EXISTS sms_messages_device_time_idx ON sms_messages(device_id, received_at DESC);
  `);
}

app.get("/api/sms/devices", requireCustomer, async (req,res) => {
  try {
    const r = await pool.query(
      `SELECT id,name,phone,active,last_seen_at,created_at,
        (SELECT COUNT(*) FROM sms_messages m WHERE m.device_id=d.id) AS message_count
       FROM sms_devices d WHERE customer_id=$1 ORDER BY created_at DESC`,
      [req.session.customerId]
    );
    res.json({success:true,devices:r.rows});
  } catch(e) {
    console.error("SMS devices error",e);
    res.status(500).json({success:false,message:"Could not load SMS devices."});
  }
});

app.post("/api/sms/devices", requireCustomer, async (req,res) => {
  try {
    const name=String(req.body?.name||"My Android").trim().slice(0,120);
    const phone=String(req.body?.phone||"").trim().slice(0,40);
    if(name.length<1) return res.status(400).json({success:false,message:"Device name is required."});
    const raw="dgm_sms_"+crypto.randomBytes(30).toString("hex");
    const hash=crypto.createHash("sha256").update(raw).digest("hex");
    const prefix=raw.slice(0,18);
    const r=await pool.query(
      `INSERT INTO sms_devices(customer_id,name,phone,token_hash,token_prefix)
       VALUES($1,$2,$3,$4,$5) RETURNING id,name,phone,active,created_at`,
      [req.session.customerId,name,phone||null,hash,prefix]
    );
    res.status(201).json({success:true,device:r.rows[0],device_token:raw,warning:"Save this token in the authorized DGM SMS companion app. It is shown only once."});
  } catch(e) {
    console.error("SMS device create error",e);
    res.status(500).json({success:false,message:"Could not register device."});
  }
});

app.post("/api/sms/devices/:id/revoke", requireCustomer, async (req,res) => {
  try {
    await pool.query("UPDATE sms_devices SET active=false WHERE id=$1 AND customer_id=$2",[Number(req.params.id),req.session.customerId]);
    res.json({success:true,message:"Device access revoked."});
  } catch(e) { res.status(500).json({success:false,message:"Could not revoke device."}); }
});

app.get("/api/sms/messages", requireCustomer, async (req,res) => {
  try {
    const deviceId=Number(req.query.device_id||0);
    const limit=Math.min(Math.max(Number(req.query.limit)||100,1),500);
    const params=[req.session.customerId];
    let where="d.customer_id=$1 AND d.active=true";
    if(Number.isInteger(deviceId)&&deviceId>0){ params.push(deviceId); where+=" AND d.id=$2"; }
    const r=await pool.query(
      `SELECT m.id,m.device_id,d.name AS device_name,m.direction,m.sender_enc,m.body_enc,m.received_at
       FROM sms_messages m JOIN sms_devices d ON d.id=m.device_id
       WHERE ${where} ORDER BY m.received_at DESC LIMIT ${limit}`,
      params
    );
    res.json({success:true,messages:r.rows.map(m=>({
      id:m.id,device_id:m.device_id,device_name:m.device_name,direction:m.direction,
      sender:smsDecrypt(m.sender_enc),body:smsDecrypt(m.body_enc),received_at:m.received_at
    }))});
  } catch(e) {
    console.error("SMS messages error",e);
    res.status(500).json({success:false,message:"Could not load messages."});
  }
});

app.get("/api/sms/summary", requireCustomer, async (req,res) => {
  try {
    const r=await pool.query(
      `SELECT COUNT(*)::int AS messages,
        COUNT(DISTINCT d.id)::int AS devices,
        COUNT(*) FILTER (WHERE m.received_at >= NOW()-INTERVAL '24 hours')::int AS today
       FROM sms_devices d LEFT JOIN sms_messages m ON m.device_id=d.id
       WHERE d.customer_id=$1 AND d.active=true`,
      [req.session.customerId]
    );
    res.json({success:true,summary:r.rows[0]});
  } catch(e) { res.status(500).json({success:false,message:"Could not load SMS summary."}); }
});

app.post("/api/sms/ingest", async (req,res) => {
  try {
    const auth=String(req.get("Authorization")||"");
    const raw=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
    if(!raw) return res.status(401).json({success:false,message:"Device token required."});
    const hash=crypto.createHash("sha256").update(raw).digest("hex");
    const d=await pool.query("SELECT id FROM sms_devices WHERE token_hash=$1 AND active=true LIMIT 1",[hash]);
    if(!d.rows.length) return res.status(401).json({success:false,message:"Invalid or revoked device token."});
    const deviceId=d.rows[0].id;
    const sender=String(req.body?.sender||"").slice(0,300);
    const body=String(req.body?.body||"").slice(0,10000);
    const externalId=String(req.body?.external_id||"").slice(0,180)||null;
    const direction=String(req.body?.direction||"received").slice(0,20);
    if(!body) return res.status(400).json({success:false,message:"SMS body is required."});
    const receivedAt=req.body?.received_at ? new Date(req.body.received_at) : new Date();
    const when=Number.isNaN(receivedAt.getTime())?new Date():receivedAt;
    const r=await pool.query(
      `INSERT INTO sms_messages(device_id,external_id,direction,sender_enc,body_enc,received_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(device_id,external_id) DO NOTHING
       RETURNING id`,
      [deviceId,externalId,direction,smsEncrypt(sender),smsEncrypt(body),when]
    );
    await pool.query("UPDATE sms_devices SET last_seen_at=NOW() WHERE id=$1",[deviceId]);
    res.status(201).json({success:true,stored:Boolean(r.rows.length)});
  } catch(e) {
    console.error("SMS ingest error",e);
    res.status(500).json({success:false,message:"Could not store SMS."});
  }
});

app.post("/api/sms/heartbeat", async (req,res) => {
  try {
    const auth=String(req.get("Authorization")||"");
    const raw=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
    const hash=crypto.createHash("sha256").update(raw).digest("hex");
    const r=await pool.query("UPDATE sms_devices SET last_seen_at=NOW() WHERE token_hash=$1 AND active=true RETURNING id",[hash]);
    if(!r.rows.length) return res.status(401).json({success:false,message:"Invalid device token."});
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:"Heartbeat failed."}); }
});

// FRONTEND STATIC FILES + HEALTH CHECK
// =====================================================

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  index: "index.html"
}));

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({
      success: true,
      status: "online",
      database: "online",
      paystack: Boolean(PAYSTACK_SECRET_KEY),
      datamart: Boolean(DATAMART_API_KEY && DATAMART_API_SECRET),
      airtime: Boolean(KINGFLEXY_API_KEY),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Health check failed:", error.message);
    return res.status(503).json({
      success: false,
      status: "offline",
      database: "offline",
      message: "Database unavailable."
    });
  }
});

// =====================================================
// API 404
// =====================================================

app.use(
  "/api",
  (req, res) => {

    return res
      .status(404)
      .json({
        success: false,

        message:
          "API endpoint not found."
      });
  }
);

// =====================================================
// FRONTEND 404
// =====================================================

app.use(
  (req, res) => {

    if (
      req.path.endsWith(
        ".html"
      ) ||
      req.path.includes(".")
    ) {

      return res
        .status(404)
        .send(`
          <!DOCTYPE html>

          <html>

          <head>

            <meta charset="UTF-8">

            <meta
              name="viewport"
              content="width=device-width, initial-scale=1.0"
            >

            <title>
              Page Not Found
            </title>

          </head>

          <body style="
            margin:0;
            min-height:100vh;
            display:flex;
            align-items:center;
            justify-content:center;
            background:#07110d;
            color:white;
            font-family:Arial,sans-serif;
            text-align:center;
            padding:20px;
          ">

            <div>

              <h1 style="
                font-size:70px;
                margin:0;
                color:#25d366;
              ">
                404
              </h1>

              <h2>
                Page Not Found
              </h2>

              <p style="
                color:#aebdb5;
              ">
                The page you requested
                does not exist.
              </p>

              <a
                href="/dashboard.html"
                style="
                  display:inline-block;
                  padding:13px 22px;
                  background:#25d366;
                  color:#07110d;
                  text-decoration:none;
                  border-radius:10px;
                  font-weight:bold;
                "
              >
                Back to Dashboard
              </a>

            </div>

          </body>

          </html>
        `);
    }

    return res.redirect("/");
  }
);

// =====================================================
// START SERVER
// =====================================================

async function startServer() {

  try {

    await initDatabase();
    await ensureSmsTables();
    await initializeAdminCredentials();

    app.listen(
      PORT,
      () => {

        console.log(
          `DHE GENIUS MEDIA running on port ${PORT}`
        );

        console.log(
          `Environment: ${NODE_ENV}`
        );

        console.log(
          `Database: ${
            DATABASE_URL
              ? "configured"
              : "MISSING"
          }`
        );

        console.log(
          `Paystack: ${
            PAYSTACK_SECRET_KEY
              ? "configured"
              : "MISSING"
          }`
        );

        console.log(
          `DataMart: ${
            DATAMART_API_KEY &&
            DATAMART_API_SECRET &&
            DATAMART_REF_PREFIX
              ? "configured"
              : "INCOMPLETE"
          }`
        );

        console.log(
          `DataMart reference prefix: ${
            DATAMART_REF_PREFIX || "MISSING"
          }`
        );

        console.log(
          `DataMart second secret: ${
            DATAMART_API_SECRET
              ? "configured"
              : "MISSING"
          }`
        );

        setTimeout(
          () => {

            // Start DataMart reconciliation immediately, then every 15 seconds.
            // This updates existing paid orders from Processing to Completed
            // when DataMart reports delivery completion.
            syncPendingDataMartOrders();

            setInterval(
              syncPendingDataMartOrders,
              15000
            );

            syncKingflexyAirtimeOrders();

            setInterval(
              syncKingflexyAirtimeOrders,
              20000
            );

          },
          5000
        );

        // Session cleanup timer removed: cleanupExpiredSessions is not
        // defined in the current PostgreSQL/session implementation.
        // Express-session handles active session expiry through the
        // configured store; the missing legacy cleanup job must not
        // terminate the production server.

        const smtpReady =
          SMTP_HOST &&
          SMTP_USER &&
          SMTP_PASSWORD &&
          SMTP_FROM_EMAIL;

        console.log(
          "Password reset email: " +
          (RESEND_API_KEY || smtpReady ? "configured" : "MISSING") +
          " | provider=" +
          RESET_EMAIL_PROVIDER
        );
      }
    );

  } catch (error) {

    console.error(
      "SERVER STARTUP FAILED:",
      error
    );

    process.exit(1);
  }
}

startServer();
