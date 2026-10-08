const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const { install: installSusuEnhancements } = require("./susu-enhancements");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");
const { installBridge } = require("./bridge-routes");
const { installMarket } = require("./market-routes");
const { installBwmXmd } = require("./bwm-xmd-routes");
const { installMashup } = require("./mashup-routes");
const { initAgentDatabase, installAgent } = require("./agent-routes");
const { installStaff } = require("./staff-routes");

const app = express();

const PORT = Number(process.env.PORT || 10000);

// Startup state is intentionally independent from the HTTP listener.
// Render must be able to reach the health endpoint during cold starts
// while PostgreSQL/Susu migrations are still initializing.
let databaseReady = false;
let startupError = null;

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
  String(process.env.SESSION_SECRET || "").trim();

if (NODE_ENV === "production" && SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be configured with at least 32 characters in production.");
}

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

const CRON_SECRET =
  String(process.env.CRON_SECRET || "").trim();

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

const SPORTS_API_KEY = process.env.SPORTS_API_KEY || process.env.API_FOOTBALL_KEY || "";
const SPORTS_BASE = "https://v3.football.api-sports.io";
const SPORTS_LEAGUES = [39, 140, 135, 78, 61];
const SPORTS_SEASON = Number(
  process.env.SPORTS_SEASON ||
  (new Date().getUTCMonth() >= 7 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1)
);

async function sportsRequest(path, params = {}) {
  if (!SPORTS_API_KEY) {
    const error = new Error("API-Football is not configured yet. Add SPORTS_API_KEY in Render environment variables.");
    error.status = 503;
    throw error;
  }
  const url = new URL(SPORTS_BASE + path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: {
        "x-apisports-key": SPORTS_API_KEY,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const message = data?.errors && Object.values(data.errors).length
        ? Object.values(data.errors).join("; ")
        : "Request failed";
      const error = new Error("API-Football HTTP " + response.status + ": " + message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    if (data.errors && Object.keys(data.errors).length) {
      const error = new Error(Object.values(data.errors).join("; "));
      error.status = 502;
      error.data = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("API-Football request timed out.");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSportsFixture(item) {
  const f = item?.fixture || {};
  const l = item?.league || {};
  const t = item?.teams || {};
  const g = item?.goals || {};
  const s = item?.score || {};
  const status = f.status || {};
  const short = status.short || "NS";
  const longMap = Object.freeze({
    "TBD": "To Be Defined",
    "NS": "Not Started",
    "LIVE": "In Play",
    "1H": "First Half",
    "HT": "Half Time",
    "2H": "Second Half",
    "ET": "Extra Time",
    "BT": "Break Time",
    "P": "Penalties",
    "FT": "Match Finished",
    "AET": "After Extra Time",
    "PEN": "After Penalties",
    "PST": "Postponed",
    "CANC": "Cancelled",
    "ABD": "Abandoned",
    "AWD": "Awarded",
    "WO": "Walkover"
  });
  return {
    fixture: {
      id: f.id,
      date: f.date,
      timestamp: f.timestamp || (f.date ? Math.floor(new Date(f.date).getTime() / 1000) : null),
      status: {
        short,
        long: longMap[short] || status.long || short,
        elapsed: status.elapsed ?? null
      },
      venue: { name: f.venue?.name || null }
    },
    league: {
      id: l.id,
      name: l.name,
      country: l.country,
      logo: l.logo,
      emblem: l.logo
    },
    teams: {
      home: { id: t.home?.id, name: t.home?.name, shortName: t.home?.name, logo: t.home?.logo },
      away: { id: t.away?.id, name: t.away?.name, shortName: t.away?.name, logo: t.away?.logo }
    },
    goals: {
      home: g.home ?? null,
      away: g.away ?? null
    },
    score: {
      fulltime: { home: s.fulltime?.home ?? g.home ?? null, away: s.fulltime?.away ?? g.away ?? null },
      halftime: { home: s.halftime?.home ?? null, away: s.halftime?.away ?? null }
    },
    status: {
      short,
      long: longMap[short] || status.long || short,
      elapsed: status.elapsed ?? null
    }
  };
}

function sendSportsApiError(res, error) {
  const status = Number.isInteger(error.status) && error.status >= 400 ? error.status : 500;
  return res.status(status).json({
    success: false,
    provider: "API-Football",
    configured: Boolean(SPORTS_API_KEY),
    message: error.message || "Sports data request failed."
  });
}

app.get("/api/sports/status", (req, res) => {
  res.json({
    success: true,
    provider: "API-Football",
    configured: Boolean(SPORTS_API_KEY),
    season: SPORTS_SEASON,
    leagues: SPORTS_LEAGUES,
    updated_at: new Date().toISOString()
  });
});

app.get("/api/sports/live", async (req, res) => {
  try {
    const data = await sportsRequest("/fixtures", { live: "all" });
    const matches = (data.response || [])
      .filter(item => SPORTS_LEAGUES.includes(Number(item?.league?.id)))
      .map(normalizeSportsFixture);
    return res.json({
      success: true,
      provider: "API-Football",
      updated_at: new Date().toISOString(),
      count: matches.length,
      matches
    });
  } catch (error) {
    console.error("API-Football live error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/fixtures", async (req, res) => {
  try {
    const requestedDate = String(req.query.date || "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
      ? requestedDate
      : new Date().toISOString().slice(0, 10);
    const data = await sportsRequest("/fixtures", { date, timezone: "UTC" });
    const matches = (data.response || [])
      .filter(item => SPORTS_LEAGUES.includes(Number(item?.league?.id)))
      .map(normalizeSportsFixture);
    return res.json({
      success: true,
      provider: "API-Football",
      date,
      season: SPORTS_SEASON,
      updated_at: new Date().toISOString(),
      count: matches.length,
      matches
    });
  } catch (error) {
    console.error("API-Football fixtures error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/teams", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    if (search.length < 3) {
      return res.status(400).json({ success: false, message: "Enter at least 3 characters to search teams." });
    }
    const data = await sportsRequest("/teams", { search });
    const teams = (data.response || []).slice(0, 20).map(item => ({
      team: {
        id: item.team?.id,
        name: item.team?.name,
        shortName: item.team?.name,
        tla: item.team?.code,
        logo: item.team?.logo,
        country: item.team?.country,
        founded: item.team?.founded,
        national: Boolean(item.team?.national)
      },
      venue: { name: item.venue?.name || null }
    }));
    return res.json({
      success: true,
      provider: "API-Football",
      search,
      count: teams.length,
      teams
    });
  } catch (error) {
    console.error("API-Football team search error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/team/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: "A valid team ID is required." });
    const data = await sportsRequest("/teams", { id });
    const item = data.response?.[0];
    if (!item) return res.status(404).json({ success: false, provider: "API-Football", message: "Team not found." });
    return res.json({
      success: true,
      provider: "API-Football",
      team: {
        id: item.team?.id,
        name: item.team?.name,
        shortName: item.team?.name,
        tla: item.team?.code,
        logo: item.team?.logo,
        country: item.team?.country,
        founded: item.team?.founded,
        national: Boolean(item.team?.national)
      },
      venue: { name: item.venue?.name || null }
    });
  } catch (error) {
    console.error("API-Football team detail error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/standings", async (req, res) => {
  try {
    const league = Number(req.query.league || 39);
    if (!SPORTS_LEAGUES.includes(league)) {
      return res.status(400).json({ success: false, message: "Unsupported league." });
    }
    const data = await sportsRequest("/standings", { league, season: SPORTS_SEASON });
    const rows = data.response?.[0]?.league?.standings?.[0] || [];
    const leagueInfo = data.response?.[0]?.league || {};
    const standings = [{
      league: {
        id: leagueInfo.id || league,
        name: leagueInfo.name || "League",
        code: leagueInfo.name || "",
        emblem: leagueInfo.logo || null,
        logo: leagueInfo.logo || null
      },
      group: rows.map(row => ({
        rank: row.rank,
        team: { id: row.team?.id, name: row.team?.name, logo: row.team?.logo },
        points: row.points,
        goalsDiff: row.goalsDiff,
        all: {
          played: row.all?.played,
          win: row.all?.win,
          draw: row.all?.draw,
          lose: row.all?.lose,
          goals: { for: row.all?.goals?.for, against: row.all?.goals?.against }
        }
      }))
    }];
    return res.json({
      success: true,
      provider: "API-Football",
      league,
      season: SPORTS_SEASON,
      updated_at: new Date().toISOString(),
      standings
    });
  } catch (error) {
    console.error("API-Football standings error:", error.message);
    return sendSportsApiError(res, error);
  }
});

app.get("/api/sports/match/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: "A valid fixture ID is required." });
    const [fixtureData, eventsData, statsData, lineupsData] = await Promise.all([
      sportsRequest("/fixtures", { id }),
      sportsRequest("/fixtures/events", { fixture: id }).catch(() => ({ response: [] })),
      sportsRequest("/fixtures/statistics", { fixture: id }).catch(() => ({ response: [] })),
      sportsRequest("/fixtures/lineups", { fixture: id }).catch(() => ({ response: [] }))
    ]);
    const item = fixtureData.response?.[0];
    if (!item) return res.status(404).json({ success: false, provider: "API-Football", message: "Match not found." });
    const match = normalizeSportsFixture(item);
    const events = (eventsData.response || []).map(event => ({
      time: { elapsed: event.time?.elapsed ?? null },
      team: { id: event.team?.id, name: event.team?.name },
      player: { name: event.player?.name || null },
      assist: { name: event.assist?.name || null },
      type: event.type || "Event",
      detail: event.detail || ""
    }));
    const statistics = (statsData.response || []).map(item => ({
      team: { id: item.team?.id, name: item.team?.name, logo: item.team?.logo },
      statistics: item.statistics || []
    }));
    const lineups = (lineupsData.response || []).map(item => ({
      team: { id: item.team?.id, name: item.team?.name, logo: item.team?.logo },
      startXI: item.startXI || [],
      substitutes: item.substitutes || []
    }));
    return res.json({
      success: true,
      provider: "API-Football",
      updated_at: new Date().toISOString(),
      match,
      events,
      statistics,
      lineups
    });
  } catch (error) {
    console.error("API-Football match detail error:", error.message);
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
  // DGM COMPANION MESSAGING
  // ===================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companion_devices (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      device_name TEXT NOT NULL DEFAULT 'Android Device',
      token_hash TEXT UNIQUE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_seen TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companion_messages (
      id BIGSERIAL PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES companion_devices(id) ON DELETE CASCADE,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      sender TEXT,
      body TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'incoming',
      status TEXT NOT NULL DEFAULT 'received',
      client_id TEXT UNIQUE,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_companion_messages_customer_created ON companion_messages(customer_id, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_companion_messages_device_created ON companion_messages(device_id, created_at DESC);`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE companion_devices ALTER COLUMN customer_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS phone TEXT`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS enrollment_token_hash TEXT`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS enrollment_expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS platform TEXT`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS app_version TEXT`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS authorization_status TEXT NOT NULL DEFAULT 'approved'`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS approved_by TEXT`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE companion_devices ADD COLUMN IF NOT EXISTS rejected_by TEXT`);
  await pool.query(`UPDATE companion_devices SET authorization_status='approved' WHERE authorization_status IS NULL`);
  await pool.query(`ALTER TABLE companion_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS companion_devices_enrollment_hash_idx ON companion_devices(enrollment_token_hash) WHERE enrollment_token_hash IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS companion_devices_phone_idx ON companion_devices(phone)`);
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
    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      message TEXT,
      cta_label TEXT NOT NULL DEFAULT 'Shop DGM',
      cta_url TEXT NOT NULL DEFAULT '/data.html',
      promo_code TEXT,
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS marketing_campaigns_active_idx
    ON marketing_campaigns(active, starts_at, ends_at);
  `);
  await pool.query(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS network TEXT;`);
  await pool.query(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS capacity TEXT;`);
  await pool.query(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'none';`);
  await pool.query(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2) NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS max_uses INTEGER;`);
  await pool.query(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS uses INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS base_amount NUMERIC(12,2);`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount NUMERIC(12,2) NOT NULL DEFAULT 0;`);

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

  // Broadcast flag distinguishes admin-wide announcements from ordinary notifications.
  await pool.query(`ALTER TABLE customer_notifications ADD COLUMN IF NOT EXISTS is_broadcast BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS customer_notifications_broadcast_idx ON customer_notifications(is_broadcast, created_at DESC);`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      admin_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx
    ON admin_audit_log(created_at DESC);
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

// DGM Bridge routes are registered after the session middleware so the
// protected /api/admin/bridge/* endpoints can see req.session.
installBridge(app);

// DGM Staff & Permissions authorization is registered before admin endpoints.
// Super Admin remains the environment-backed ADMIN_EMAIL/ADMIN_PASSWORD account.
const staffInit = installStaff(app, pool);

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
  if (req.session.staffId) return sendError(res, 403, "Super Admin access required.");
  next();
}

// DGM Market: customer storefront, wallet checkout, and admin catalog/order APIs.
installMarket(app);
installBwmXmd(app);
installMashup(app);


const COMPANION_TOKEN_TTL_DAYS = 365;

function getCompanionToken(req) {
  const authorization = String(req.get("Authorization") || "").trim();
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  return authorization.slice(7).trim();
}
function hashCompanionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
async function getCompanionDevice(req) {
  const token = getCompanionToken(req);
  if (!token) return null;
  const result = await pool.query(
    `SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
     FROM companion_devices d
     LEFT JOIN customers c ON c.id = d.customer_id
     WHERE d.token_hash = $1 AND d.active = TRUE
       AND (d.expires_at IS NULL OR d.expires_at > NOW())`,
    [hashCompanionToken(token)]
  );
  if (!result.rows.length) return null;
  await pool.query("UPDATE companion_devices SET last_seen = NOW() WHERE id = $1", [result.rows[0].id]);
  return result.rows[0];
}
async function requireCompanion(req,res,next){
  try {
    const device=await getCompanionDevice(req);
    if(!device) return sendError(res,401,"Companion is not connected or its access has been revoked.");
    req.companionDevice=device; next();
  } catch(error){ console.error("Companion authentication error:",error); return sendError(res,500,"Companion authentication failed."); }
}

app.post("/api/admin/companion/devices/enroll", requireAdmin, async (req,res)=>{
  try {
    const phone=String(req.body?.phone||"").trim().replace(/[^0-9+]/g,"").slice(0,30);
    const deviceName=String(req.body?.device_name||"My Android").trim().slice(0,80)||"My Android";
    if(phone.length<7) return sendError(res,400,"Enter a valid phone number.");
    const enrollmentToken=String(crypto.randomInt(10000000,100000000));
    const expiresAt=new Date(Date.now()+15*60*1000);
    const customer=await pool.query("SELECT id,name,email,phone FROM customers WHERE phone=$1 LIMIT 1",[phone]);
    await pool.query("UPDATE companion_devices SET active=FALSE WHERE phone=$1",[phone]);
    const result=await pool.query(
      `INSERT INTO companion_devices
        (customer_id,device_name,phone,token_hash,enrollment_token_hash,enrollment_expires_at,expires_at,active)
       VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '365 days',TRUE)
       RETURNING id,device_name,phone,active,authorization_status,enrollment_expires_at,expires_at`,
      [customer.rows[0]?.id||null,deviceName,phone,hashCompanionToken(crypto.randomBytes(32).toString("hex")),hashCompanionToken(enrollmentToken),expiresAt]
    );
    await pool.query(
      `INSERT INTO admin_audit_log(admin_email,action,target_type,target_id,details)
       VALUES($1,'companion_enrollment_created','companion_device',$2,$3)`,
      [req.session.adminEmail||ADMIN_EMAIL||"admin",result.rows[0].id,JSON.stringify({phone,device_name:deviceName})]
    );
    return res.json({success:true,enrollment_token:enrollmentToken,expires_at:expiresAt.toISOString(),device:result.rows[0]});
  } catch(error){console.error("Admin Companion enrollment error:",error);return sendError(res,500,"Could not generate the Companion enrollment token.");}
});

app.get("/api/admin/companion/devices", requireAdmin, async (req,res)=>{
  try {
    const r=await pool.query(
      `SELECT d.id,d.device_name,d.phone,d.active,d.last_seen,d.created_at,d.enrolled_at,d.enrollment_expires_at,d.expires_at,
              d.platform,d.app_version,d.authorization_status,d.approved_at,d.approved_by,d.rejected_at,d.rejected_by,c.name AS customer_name,c.email AS customer_email
       FROM companion_devices d LEFT JOIN customers c ON c.id=d.customer_id
       ORDER BY d.created_at DESC LIMIT 100`);
    return res.json({success:true,devices:r.rows});
  } catch(error){console.error(error);return sendError(res,500,"Could not load Companion devices.");}
});

app.post("/api/admin/companion/devices/:id/approve", requireAdmin, async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isInteger(id)||id<1)return sendError(res,400,"Invalid device.");
  const admin=req.session.adminEmail||ADMIN_EMAIL||"admin";
  const r=await pool.query(
    `UPDATE companion_devices SET authorization_status='approved',approved_at=NOW(),approved_by=$1,rejected_at=NULL,rejected_by=NULL
     WHERE id=$2 AND active=TRUE RETURNING id,device_name,authorization_status`,[admin,id]);
  if(!r.rows.length)return sendError(res,404,"Active Companion device not found.");
  await pool.query(`INSERT INTO admin_audit_log(admin_email,action,target_type,target_id,details) VALUES($1,'companion_device_approved','companion_device',$2,'{}')`,[admin,id]);
  return res.json({success:true,message:"Companion device authorized.",device:r.rows[0]});
});

app.post("/api/admin/companion/devices/:id/reject", requireAdmin, async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isInteger(id)||id<1)return sendError(res,400,"Invalid device.");
  const admin=req.session.adminEmail||ADMIN_EMAIL||"admin";
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query(
      `DELETE FROM companion_devices
       WHERE id=$1
       RETURNING id,device_name,phone,authorization_status`,[id]);
    if(!r.rows.length){
      await client.query("ROLLBACK");
      return sendError(res,404,"Device not found.");
    }
    await client.query(
      `INSERT INTO admin_audit_log(admin_email,action,target_type,target_id,details)
       VALUES($1,'companion_device_rejected_and_deleted','companion_device',$2,$3)`,
      [admin,id,JSON.stringify({device_name:r.rows[0].device_name,phone:r.rows[0].phone,reason:"Admin rejected registration"})]
    );
    await client.query("COMMIT");
    return res.json({success:true,message:"Companion registration rejected and device deleted."});
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    console.error("Admin Companion rejection error:",error);
    return sendError(res,500,"Could not reject and delete the Companion device.");
  }finally{client.release();}
});

app.post("/api/admin/companion/devices/:id/reauthorize", requireAdmin, async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isInteger(id)||id<1)return sendError(res,400,"Invalid device.");
  const admin=req.session.adminEmail||ADMIN_EMAIL||"admin";
  const token=crypto.randomBytes(6).toString("hex").toUpperCase();
  const expiresAt=new Date(Date.now()+15*60*1000);
  const r=await pool.query(
    `UPDATE companion_devices SET active=TRUE,authorization_status='pending',enrollment_token_hash=$1,enrollment_expires_at=$2,rejected_at=NULL,rejected_by=NULL
     WHERE id=$3 RETURNING id,device_name,phone,enrollment_expires_at`,[hashCompanionToken(token),expiresAt,id]);
  if(!r.rows.length)return sendError(res,404,"Device not found.");
  await pool.query(`INSERT INTO admin_audit_log(admin_email,action,target_type,target_id,details) VALUES($1,'companion_device_reauthorized','companion_device',$2,$3)`,
    [admin,id,JSON.stringify({expires_at:expiresAt.toISOString()})]);
  return res.json({success:true,enrollment_token:token,expires_at:expiresAt.toISOString(),device:r.rows[0]});
});

app.post("/api/admin/companion/devices/:id/revoke", requireAdmin, async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isInteger(id)||id<1)return sendError(res,400,"Invalid device.");
  const r=await pool.query("UPDATE companion_devices SET active=FALSE,enrollment_token_hash=NULL,enrollment_expires_at=NULL WHERE id=$1 RETURNING id,device_name",[id]);
  if(!r.rows.length)return sendError(res,404,"Device not found.");
  await pool.query(`INSERT INTO admin_audit_log(admin_email,action,target_type,target_id,details) VALUES($1,'companion_device_revoked','companion_device',$2,'{}')`,
    [req.session.adminEmail||ADMIN_EMAIL||"admin",id]);
  return res.json({success:true,message:"Companion device revoked."});
});

app.post("/api/companion/enroll", async (req,res)=>{
  try {
    const enrollmentToken=String(req.body?.enrollment_token||"").trim().toUpperCase();
    const deviceName=String(req.body?.device_name||"Android Device").trim().slice(0,80)||"Android Device";
    const platform=String(req.body?.platform||"Android").trim().slice(0,40);
    const appVersion=String(req.body?.app_version||"").trim().slice(0,40);
    if(!enrollmentToken)return sendError(res,400,"Enrollment token is required.");
    const r=await pool.query(
      `SELECT * FROM companion_devices WHERE enrollment_token_hash=$1 AND active=TRUE
       AND enrollment_expires_at>NOW() LIMIT 1`,[hashCompanionToken(enrollmentToken)]);
    if(!r.rows.length)return sendError(res,401,"Enrollment token is invalid or expired.");
    const device=r.rows[0];
    if(device.authorization_status==="denied")return sendError(res,403,"This Companion registration was denied by DGM Admin.");
    await pool.query(
      `UPDATE companion_devices SET device_name=$1,platform=$2,app_version=$3,
       enrolled_at=COALESCE(enrolled_at,NOW()),last_seen=NOW(),authorization_status='pending'
       WHERE id=$4`,
      [deviceName,platform,appVersion,device.id]);
    return res.json({success:true,pending_approval:true,message:"Registration received. DGM Admin must authorize this device before it can connect.",device:{
      id:device.id,device_name:deviceName,phone:device.phone,authorization_status:"pending"
    }});
  } catch(error){console.error("Companion enrollment error:",error);return sendError(res,500,"Unable to register this device.");}
});

app.post("/api/companion/enroll/status", async (req,res)=>{
  try {
    const enrollmentToken=String(req.body?.enrollment_token||"").trim().toUpperCase();
    if(!enrollmentToken)return sendError(res,400,"Enrollment token is required.");
    const r=await pool.query(
      `SELECT id,device_name,phone,active,authorization_status,enrollment_expires_at
       FROM companion_devices WHERE enrollment_token_hash=$1 LIMIT 1`,
      [hashCompanionToken(enrollmentToken)]);
    if(!r.rows.length)return sendError(res,401,"Registration token is invalid or expired.");
    const device=r.rows[0];
    if(!device.active)return sendError(res,403,"This Companion device has been revoked.");
    if(device.authorization_status==="denied")return sendError(res,403,"DGM Admin denied this Companion registration.");
    if(device.authorization_status!=="approved"){
      return res.json({success:true,pending_approval:true,authorized:false,message:"Awaiting DGM Admin authorization.",device});
    }
    const authToken=crypto.randomBytes(32).toString("hex");
    const updated=await pool.query(
      `UPDATE companion_devices SET token_hash=$1,last_seen=NOW(),enrollment_token_hash=NULL,enrollment_expires_at=NULL,
       approved_at=COALESCE(approved_at,NOW())
       WHERE id=$2 RETURNING id,device_name,phone,active,enrolled_at,expires_at,authorization_status`,
      [hashCompanionToken(authToken),device.id]);
    return res.json({success:true,pending_approval:false,authorized:true,token:authToken,device:updated.rows[0]});
  } catch(error){console.error("Companion enrollment status error:",error);return sendError(res,500,"Unable to check Companion authorization.");}
});

app.get("/api/companion/heartbeat",requireCompanion,async(req,res)=>res.json({success:true,connected:true,device:{id:req.companionDevice.id,name:req.companionDevice.device_name,last_seen:new Date().toISOString(),phone:req.companionDevice.phone}}));

app.post("/api/companion/messages",requireCompanion,async(req,res)=>{
  try{
    const channel=["sms","whatsapp","call_log"].includes(String(req.body?.channel||"").toLowerCase())?String(req.body.channel).toLowerCase():null;
    const sender=String(req.body?.sender||"").trim().slice(0,200);
    const body=String(req.body?.body||"").trim().slice(0,10000);
    const clientId=String(req.body?.client_id||"").trim().slice(0,120)||null;
    const metadata=req.body?.metadata && typeof req.body.metadata==="object"?req.body.metadata:{};
    if(!channel||!body)return sendError(res,400,"Message channel and body are required.");
    const result=await pool.query(
      `INSERT INTO companion_messages(device_id,customer_id,channel,sender,body,direction,status,client_id,metadata)
       VALUES($1,$2,$3,$4,$5,'incoming','received',$6,$7)
       ON CONFLICT(client_id) DO NOTHING RETURNING id,created_at`,
      [req.companionDevice.id,req.companionDevice.customer_id,channel,sender,body,clientId,JSON.stringify(metadata)]);
    return res.json({success:true,stored:Boolean(result.rows.length),message:result.rows[0]||null});
  }catch(error){console.error("Companion message ingestion error:",error);return sendError(res,500,"Unable to store the message.");}
});

app.get("/api/companion/outbox",requireCompanion,async(req,res)=>{
  const result=await pool.query(`SELECT id,channel,sender,body,direction,status,created_at FROM companion_messages WHERE device_id=$1 AND direction='outgoing' AND status='queued' ORDER BY id ASC LIMIT 50`,[req.companionDevice.id]);
  return res.json({success:true,messages:result.rows});
});
app.post("/api/companion/outbox/:id/ack",requireCompanion,async(req,res)=>{
  const status=["sent","failed"].includes(String(req.body?.status||""))?String(req.body.status):"sent";
  const result=await pool.query(`UPDATE companion_messages SET status=$1 WHERE id=$2 AND device_id=$3 AND direction='outgoing' RETURNING id,status`,[status,Number(req.params.id),req.companionDevice.id]);
  if(!result.rows.length)return sendError(res,404,"Message not found.");
  return res.json({success:true,message:result.rows[0]});
});

app.get("/api/admin/companion/messages",requireAdmin,async(req,res)=>{
  const limit=Math.min(Math.max(Number(req.query.limit)||200,1),500);
  const channel=["sms","whatsapp","call_log"].includes(String(req.query.channel||"").toLowerCase())?String(req.query.channel).toLowerCase():null;
  const params=[]; let where="";
  if(channel){params.push(channel);where="WHERE m.channel=$1";}
  params.push(limit);
  const result=await pool.query(
    `SELECT m.id,m.channel,m.sender,m.body,m.direction,m.status,m.created_at,m.metadata,
            d.id AS device_id,d.device_name,d.phone,d.last_seen
     FROM companion_messages m JOIN companion_devices d ON d.id=m.device_id ${where}
     ORDER BY m.created_at DESC LIMIT $${params.length}`,params);
  return res.json({success:true,messages:result.rows});
});
app.post("/api/admin/companion/reply",requireAdmin,async(req,res)=>{
  const deviceId=Number(req.body?.device_id),channel=String(req.body?.channel||"").toLowerCase(),sender=String(req.body?.sender||"").trim().slice(0,200),body=String(req.body?.body||"").trim().slice(0,10000);
  if(!Number.isInteger(deviceId)||deviceId<1||!["sms","whatsapp"].includes(channel)||!body)return sendError(res,400,"Device, channel and message are required.");
  const device=await pool.query("SELECT id,customer_id,active FROM companion_devices WHERE id=$1 AND active=TRUE",[deviceId]);
  if(!device.rows.length)return sendError(res,404,"Active Companion device not found.");
  const result=await pool.query(`INSERT INTO companion_messages(device_id,customer_id,channel,sender,body,direction,status) VALUES($1,$2,$3,$4,$5,'outgoing','queued') RETURNING id,created_at`,[deviceId,device.rows[0].customer_id,channel,sender,body]);
  return res.json({success:true,message:result.rows[0]});
});

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
  MTN: {1:4.20,2:8.80,3:12.80,4:17.80,5:22.30,6:25.00,8:33.00,10:41.00,15:59.50,20:79.00,25:99.00,30:121.00,40:158.00,50:200.00},
  AirtelTigo: {1:4.50,2:10.00,3:15.00,4:19.50,5:23.50,6:30.60,8:38.50,10:45.50,12:56.00,15:65.50,25:106.00,30:128.50,40:165.00,50:215.00},
  Telecel: {10:47.70,15:69.90,20:92.00,25:101.00,30:121.00,35:142.00,40:154.00,45:169.00,50:201.00,100:425.00}
};

// DataMart public prices are the source of truth for the DGM customer catalogue.
// The last successful values remain in memory if DataMart is temporarily unavailable.
const DATAMART_PUBLIC_PRICE_URL = "https://www.datamartgh.shop/";
const DATAMART_CATALOGUE_URLS = {
  MTN: "https://www.datamartgh.shop/mtnup2u",
  AirtelTigo: "https://www.datamartgh.shop/ishare",
  Telecel: "https://www.datamartgh.shop/telecel"
};
const DATAMART_AGENT_PRICE_URL = String(process.env.DATAMART_AGENT_PRICE_URL || "").trim();
let dataMartPriceCache = { checked_at: 0, customer: {}, agent: {} };
let dataMartAvailabilityCache = { checked_at: 0, networks: {} };

function normalizePublicStoreText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8373;/gi, "₵")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDataMartCatalogue(text, referencePrices = DGM_PRICES) {
  const lower = String(text || "").toLowerCase();
  const result = {};
  const aliases = {
    MTN: ["mtn up2u", "mtn data", "mtn"],
    AirtelTigo: ["airteltigo", "airtel tigo", "airteligo", "ishare"],
    Telecel: ["telecel"]
  };

  for (const [network, prices] of Object.entries(referencePrices)) {
    result[network] = {};
    const labels = aliases[network] || [network];
    const positions = labels.map(x => lower.indexOf(x)).filter(x => x >= 0).sort((a,b) => a-b);
    if (!positions.length) {
      for (const gb of Object.keys(prices)) result[network][gb] = null;
      continue;
    }
    const startPos = positions[0];
    const nextNetworkPositions = Object.entries(aliases)
      .filter(([n]) => n !== network)
      .flatMap(([, ls]) => ls.map(x => lower.indexOf(x)).filter(x => x > startPos));
    const endPos = nextNetworkPositions.length ? Math.min(...nextNetworkPositions) : lower.length;
    const section = lower.slice(startPos, endPos);

    for (const gb of Object.keys(prices)) {
      const sizeRe = new RegExp("\\b" + String(gb).replace(".", "\\.") + "\\s*gb\\b", "i");
      const match = sizeRe.exec(section);
      if (!match) { result[network][gb] = null; continue; }
      const card = section.slice(Math.max(0, match.index - 300), match.index + 700);
      const currency = [...card.matchAll(/(?:gh\s*)?₵\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)]
        .map(m => Number(m[1]))
        .filter(Number.isFinite);
      const numeric = [...card.matchAll(/\b([0-9]+\.[0-9]{2})\b/g)]
        .map(m => Number(m[1]))
        .filter(Number.isFinite);
      const candidates = [...currency, ...numeric];
      const price = candidates.length ? candidates[0] : null;
      result[network][gb] = Number.isFinite(price) && price > 0 ? Number(price.toFixed(2)) : null;
    }
  }
  return result;
}

async function fetchDataMartCataloguePage(url) {
  const response = await fetch(url, {
    headers: { Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("DataMart catalogue HTTP " + response.status);
  return await response.text();
}

async function refreshDataMartPrices(force = false) {
  const now = Date.now();
  if (!force && now - Number(dataMartPriceCache.checked_at || 0) < 60000) return dataMartPriceCache;

  try {
    const customer = {};
    for (const [network, fallback] of Object.entries(DGM_PRICES)) {
      try {
        const html = await fetchDataMartCataloguePage(DATAMART_CATALOGUE_URLS[network] || DATAMART_PUBLIC_PRICE_URL);
        const parsed = parseDataMartCatalogue(html, fallback);
        customer[network] = {};
        for (const gb of Object.keys(fallback)) {
          customer[network][gb] = Number(parsed?.[network]?.[gb]) > 0
            ? Number(parsed[network][gb])
            : Number(fallback[gb]);
        }
      } catch (networkError) {
        console.error("DataMart " + network + " price sync failed:", networkError.message);
        customer[network] = { ...fallback };
      }
    }

    // DataMart's authenticated agent dashboard is not publicly readable.
    // Until a legitimate agent catalogue endpoint is configured, agents use
    // the same verified public catalogue as their DGM base catalogue.
    let agent = customer;
    if (DATAMART_AGENT_PRICE_URL) {
      try {
        const ar = await fetch(DATAMART_AGENT_PRICE_URL, {
          headers: { Accept: "text/html,application/json" },
          signal: AbortSignal.timeout(10000)
        });
        if (ar.ok) {
          const raw = await ar.text();
          try {
            const json = JSON.parse(raw);
            agent = json.prices || json.networks || json.catalogue || customer;
          } catch {
            agent = parseDataMartCatalogue(raw, customer);
          }
        }
      } catch (agentError) {
        console.error("DataMart agent price sync failed:", agentError.message);
      }
    }

    dataMartPriceCache = { checked_at: now, customer, agent };
    for (const [network, prices] of Object.entries(customer)) {
      for (const [gb, price] of Object.entries(prices)) {
        if (Number(price) > 0) DGM_PRICES[network][gb] = Number(price);
      }
    }
  } catch (error) {
    console.error("DataMart price sync failed:", error.message);
  }

  return dataMartPriceCache;
}

async function refreshDataMartBundleAvailability(force = false) {
  const prices = await refreshDataMartPrices(force);
  const now = Date.now();
  if (!force && now - Number(dataMartAvailabilityCache.checked_at || 0) < 60000) {
    return dataMartAvailabilityCache.networks;
  }

  try {
    const response = await fetch(DATAMART_PUBLIC_PRICE_URL, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("DataMart storefront HTTP " + response.status);
    const text = normalizePublicStoreText(await response.text());
    const lower = text.toLowerCase();
    const next = {};

    for (const [network, priceMap] of Object.entries(DGM_PRICES)) {
      next[network] = {};
      const aliases = {MTN:["mtn up2u","mtn data","mtn"],AirtelTigo:["airteltigo","airtel tigo","airteligo","ishare"],Telecel:["telecel"]}[network] || [network];
      const networkPos = aliases.map(label=>lower.indexOf(label)).filter(pos=>pos>=0).sort((a,b)=>a-b)[0];
      if (networkPos === undefined) {
        for (const gb of Object.keys(priceMap)) next[network][gb] = null;
        continue;
      }
      const otherPositions = Object.entries({MTN:["mtn up2u","mtn data","mtn"],AirtelTigo:["airteltigo","airtel tigo","airteligo","ishare"],Telecel:["telecel"]})
        .filter(([name])=>name!==network)
        .flatMap(([,labels])=>labels.map(label=>lower.indexOf(label)).filter(pos=>pos>networkPos));
      const section = lower.slice(networkPos, otherPositions.length ? Math.min(...otherPositions) : lower.length);
      for (const gb of Object.keys(priceMap)) {
        const sizeMatch = new RegExp("\\b"+String(gb).replace(".","\\.")+"\\s*gb\\b","i").exec(section);
        if (!sizeMatch) { next[network][gb] = null; continue; }
        const card = section.slice(Math.max(0,sizeMatch.index-250), sizeMatch.index+500).replace(/\s+/g," ");
        const explicitlyOut = /out\s*of\s*stock/i.test(card);
        const explicitlyAvailable = /in\s*stock|available|buy now|order now/i.test(card);
        next[network][gb] = explicitlyOut ? false : (explicitlyAvailable ? true : null);
      }
    }
    dataMartAvailabilityCache = { checked_at: now, networks: next };
  } catch (error) {
    console.error("DataMart availability sync failed:", error.message);
  }
  return dataMartAvailabilityCache.networks;
}

app.get("/api/data-bundles", async (req, res) => {
  const prices = await refreshDataMartPrices();
  const availability = await refreshDataMartBundleAvailability();
  const bundles = Object.fromEntries(
    Object.entries(prices.customer).map(([network, priceMap]) => [
      network,
      Object.entries(priceMap).map(([gb, price]) => ({
        size: gb + "GB",
        price: Number(price),
        available: availability?.[network]?.[gb] !== false,
        availability_synced: availability?.[network]?.[gb] !== undefined
      }))
    ])
  );
  return res.json({
    success: true,
    currency: "GHS",
    validity_days: 90,
    price_source: DATAMART_PUBLIC_PRICE_URL,
    price_checked_at: prices.checked_at ? new Date(prices.checked_at).toISOString() : null,
    availability_source: DATAMART_PUBLIC_PRICE_URL,
    availability_checked_at: dataMartAvailabilityCache.checked_at ? new Date(dataMartAvailabilityCache.checked_at).toISOString() : null,
    networks: bundles
  });
});

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

  const availability =
    await refreshDataMartBundleAvailability();

  if (
    availability?.[order.network]?.[capacity] === false
  ) {
    throw new Error(
      "This data bundle is currently unavailable."
    );
  }

  const expectedAmount =
    networkPrices[
      capacity
    ];
  const chargedBaseAmount = Number(order.base_amount ?? order.amount);

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
      chargedBaseAmount * 100
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

      let fulfillmentResult;
      try {
        fulfillmentResult = await fulfillDataOrder(updatedResult.rows[0]);
      } catch (fulfillmentError) {
        fulfillmentResult = {
          success: false,
          status: "Failed",
          error: fulfillmentError.message
        };
      }

      if (!fulfillmentResult.success || fulfillmentResult.status === "Failed") {
        console.error(
          `Data fulfillment failed after Paystack payment: ${order.order_ref}`,
          fulfillmentResult.error
        );
        await refundFailedCustomerOrder(
          order.id,
          fulfillmentResult.error || "Data bundle could not be placed."
        );
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
      recordLoginFailure(req);
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

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma","no-cache");
  return res.json({
    success: true,
    admin: { email: req.session.adminEmail || ADMIN_EMAIL },
    logged_in_at: req.session.adminLoginAt || null
  });
});

app.post("/api/admin/logout", (req, res) => {
  // Expire the browser session cookie immediately. This makes logout effective
  // even if the database-backed session store is temporarily unavailable.
  res.clearCookie("dgm.sid", {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0)
  });
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");

  if (!req.session) return res.json({ success: true });

  req.session.destroy(error => {
    if (error) {
      console.error("Admin logout session cleanup error:", error);
      // The client cookie has already been expired, so the authenticated
      // browser session is no longer reusable.
    }
    return res.json({ success: true });
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

    const [orders, transactions, topups, support] = await Promise.all([
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
      ),
      pool.query(
        "SELECT id,subject,message,status,admin_reply,replied_at,created_at,updated_at FROM support_tickets WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50",
        [customerId]
      )
    ]);

    return res.json({
      success: true,
      customer: customerResult.rows[0],
      orders: orders.rows,
      wallet_transactions: transactions.rows,
      wallet_topups: topups.rows,
      support: support.rows
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
  const targetBalance = Number(req.body?.target_balance);
  const legacyAmount = Number(req.body?.amount);
  const description = String(req.body?.description || "Admin set wallet balance").trim().slice(0, 250);

  if (!Number.isInteger(customerId) || customerId <= 0) return sendError(res, 400, "Invalid customer ID.");
  const hasTarget = Number.isFinite(targetBalance);
  const hasLegacyAmount = Number.isFinite(legacyAmount) && legacyAmount !== 0;
  if (!hasTarget && !hasLegacyAmount) return sendError(res, 400, "Enter a valid target wallet balance.");
  if (hasTarget && (targetBalance < 0 || targetBalance > 1000000 || Math.round(targetBalance * 100) !== targetBalance * 100)) {
    return sendError(res, 400, "Wallet balance must be between GH₵0 and GH₵1,000,000.");
  }
  if (!hasTarget && Math.round(legacyAmount * 100) !== legacyAmount * 100) {
    return sendError(res, 400, "Enter a valid balance adjustment.");
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
    const after = hasTarget
      ? Math.round(targetBalance * 100) / 100
      : Math.round((before + legacyAmount) * 100) / 100;

    if (after < 0 || after > 1000000) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "Wallet balance must be between GH₵0 and GH₵1,000,000.");
    }

    const adjustment = Math.round((after - before) * 100) / 100;
    if (adjustment === 0) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "The customer already has that wallet balance.");
    }

    await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [after, customerId]);

    const reference = "DGM-ADMIN-" + Date.now() + "-" + customerId;
    await client.query(
      `INSERT INTO wallet_transactions
        (customer_id, type, amount, balance_before, balance_after, description, transaction_ref, status, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $7)`,
      [customerId, adjustment >= 0 ? "admin_credit" : "admin_debit", adjustment, before, after, description, reference]
    );

    await client.query("COMMIT");
    await writeAdminAudit(req, "Wallet balance adjustment", "customer", customerId, {adjustment, previous_balance: before, new_balance: after, description});
    return res.json({
      success: true,
      message: "Wallet balance set successfully.",
      customer: { id: customer.id, name: customer.name, email: customer.email, balance: after },
      previous_balance: before,
      balance: after,
      adjustment
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
        recordLoginFailure(req);
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

      if (!validGhanaPhone(phone)) {
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
// LOAD DGM ORDER CODE
// =====================================================
app.get(
  "/api/order-code/:code",
  requireLogin,
  async (req, res) => {
    try {
      const code = String(req.params.code || "").trim().toUpperCase();
      if (!/^DGM-[A-Z0-9]+-[A-Z0-9]+$/.test(code)) {
        return sendError(res, 400, "Invalid DGM code.");
      }

      const customerId = req.session.customerId;

      const orderResult = await pool.query(
        "SELECT id, order_ref, service, network, phone, amount, status, capacity, payment_status, paid_at, provider_reference, provider_status, provider_message, created_at, completed_at FROM orders WHERE customer_id = $1 AND UPPER(order_ref) = $2 LIMIT 1",
        [customerId, code]
      );

      if (orderResult.rows.length) {
        return res.json({ success: true, source: "orders", order: orderResult.rows[0] });
      }

      const socialTable = await pool.query(
        "SELECT to_regclass('public.bwm_xmd_orders') IS NOT NULL AS exists"
      );
      if (socialTable.rows[0].exists) {
        const social = await pool.query(
          "SELECT id, order_ref, service_name, link, quantity, customer_price, status, provider_order_id, provider_status, created_at FROM bwm_xmd_orders WHERE customer_id = $1 AND UPPER(order_ref) = $2 LIMIT 1",
          [customerId, code]
        );
        if (social.rows.length) {
          const o = social.rows[0];
          return res.json({ success: true, source: "social_boosting", order: { ...o, service: "Social Boosting", amount: Number(o.customer_price || 0), phone: o.link || null, payment_status: "paid" } });
        }
      }

      const marketTable = await pool.query(
        "SELECT to_regclass('public.market_orders') IS NOT NULL AS exists"
      );
      if (marketTable.rows[0].exists) {
        const market = await pool.query(
          "SELECT id, order_ref, total_amount, status, created_at FROM market_orders WHERE customer_id = $1 AND UPPER(order_ref) = $2 LIMIT 1",
          [customerId, code]
        );
        if (market.rows.length) {
          const o = market.rows[0];
          return res.json({ success: true, source: "market", order: { ...o, service: "DGM Market", amount: Number(o.total_amount || 0), payment_status: "paid" } });
        }
      }

      return sendError(res, 404, "DGM code not found.");
    } catch (error) {
      console.error("DGM code lookup error:", error);
      return sendError(res, 500, "Could not load DGM code.");
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

      const availability =
        await refreshDataMartBundleAvailability();

      if (
        availability?.[network]?.[capacity] === false
      ) {
        return sendError(
          res,
          409,
          "This data bundle is currently unavailable."
        );
      }

      const baseAmount =
        networkPrices[
          capacity
        ];

      if (
        typeof baseAmount !==
        "number"
      ) {

        return sendError(
          res,
          400,
          "This data bundle is unavailable."
        );
      }

      const campaign = await getAutomaticCampaign(network, capacity, baseAmount, req.session.customerId);
      const amount = campaign ? campaign.sale_amount : baseAmount;
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
            payment_status,
            base_amount,
            campaign_id,
            promo_discount
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
            'Pending',
            $8,
            $9,
            $10
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

            String(capacity),
            baseAmount,
            campaign ? campaign.id : null,
            campaign ? campaign.discount : 0
          ]
        );

      if(campaign){
        await pool.query("UPDATE marketing_campaigns SET uses=uses+1,updated_at=NOW() WHERE id=$1",[campaign.id]);
        await pool.query("INSERT INTO customer_promo_uses(promo_id,customer_id,order_id,discount_amount) SELECT id,$1,$2,$3 FROM promo_codes WHERE code=$4 ON CONFLICT DO NOTHING",[req.session.customerId,result.rows[0].id,campaign.discount,campaign.promo_code]).catch(()=>{});
      }
      return res.json({
        success: true,
        promotion: campaign ? {id:campaign.id,title:campaign.title,discount:campaign.discount,promo_code:campaign.promo_code} : null,
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

      const availability =
        await refreshDataMartBundleAvailability();

      if (
        availability?.[order.network]?.[capacity] === false
      ) {
        throw new Error(
          "This data bundle is currently unavailable."
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
          `Wallet-paid data fulfillment error for ${order.order_ref}:`,
          fulfillmentError
        );

        await refundFailedCustomerOrder(
          order.id,
          fulfillmentError.message || "Data bundle could not be placed."
        );

        fulfillmentResult = {
          success: false,
          status: "Refunded",
          refunded: true,
          error: fulfillmentError.message
        };
      }

      if (
        fulfillmentResult &&
        fulfillmentResult.status ===
          "Failed"
      ) {
        // Payment succeeded, but the bundle could not be placed.
        // Mark the order failed and immediately return the customer's money.
        await refundFailedCustomerOrder(
          order.id,
          fulfillmentResult.error || "Data bundle could not be placed."
        );

        fulfillmentResult = {
          ...fulfillmentResult,
          success: false,
          status: "Refunded",
          refunded: true
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

async function writeAdminAudit(req, action, targetType = null, targetId = null, details = {}) {
  try {
    if (!req.session?.adminAuthenticated) return;
    await pool.query(
      `INSERT INTO admin_audit_log
       (admin_email, action, target_type, target_id, details)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        req.session.adminEmail || ADMIN_EMAIL || "admin",
        String(action).slice(0,120),
        targetType ? String(targetType).slice(0,80) : null,
        targetId != null ? String(targetId).slice(0,120) : null,
        JSON.stringify(details || {})
      ]
    );
  } catch (error) {
    console.error("Admin audit log error:", error.message);
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
      `SELECT id,title,message,type,is_broadcast,read_at,created_at
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

app.get("/api/admin/system", requireAdmin, async (req,res) => {
  const checks = {};
  try { await pool.query("SELECT 1"); checks.database = {status:"online"}; }
  catch (e) { checks.database = {status:"offline",message:e.message}; }
  checks.paystack = {status: PAYSTACK_SECRET_KEY ? "configured" : "missing"};
  checks.datamart = {status: DATAMART_API_KEY && DATAMART_API_SECRET ? "configured" : "missing"};
  checks.sports = {status: SPORTS_API_KEY ? "configured" : "missing"};
  checks.youtube = {status: YOUTUBE_API_KEY ? "configured" : "missing"};
  const smtpReady = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASSWORD && SMTP_FROM_EMAIL);
  checks.email = {status: RESEND_API_KEY || smtpReady ? "configured" : "missing"};
  checks.session = {status: SESSION_SECRET.length >= 32 ? "configured" : "invalid"};
  return res.json({success:true,checked_at:new Date().toISOString(),checks});
});

app.get("/api/admin/movies/playback", requireAdmin, async (req,res) => {
  try {
    const result = await pool.query("SELECT id, tmdb_id, title, playback_url, playback_type, active, expires_at, created_at, updated_at FROM movie_playback ORDER BY updated_at DESC");
    return res.json({success:true,movies:result.rows});
  } catch(error) { console.error("Admin movie playback load error:",error); return sendError(res,500,"Could not load movie playback sources."); }
});
app.post("/api/admin/movies/playback", requireAdmin, async (req,res) => {
  const tmdbId=Number(req.body?.tmdb_id), title=String(req.body?.title||"").trim().slice(0,250), playbackType=String(req.body?.playback_type||"hls").toLowerCase(), playbackUrl=String(req.body?.playback_url||"").trim();
  if(!Number.isInteger(tmdbId)||tmdbId<=0) return sendError(res,400,"A valid TMDB movie ID is required.");
  if(!["hls","mp4"].includes(playbackType)) return sendError(res,400,"Playback type must be HLS or MP4.");
  let parsed; try { parsed=new URL(playbackUrl); } catch { return sendError(res,400,"Enter a valid playback URL."); }
  if(parsed.protocol!=="https:") return sendError(res,400,"Playback URL must use HTTPS.");
  try {
    const result=await pool.query(`INSERT INTO movie_playback (tmdb_id,title,playback_url,playback_type,active,updated_at)
      VALUES ($1,$2,$3,$4,TRUE,NOW()) ON CONFLICT (tmdb_id) DO UPDATE SET title=EXCLUDED.title,playback_url=EXCLUDED.playback_url,playback_type=EXCLUDED.playback_type,active=TRUE,updated_at=NOW()
      RETURNING id,tmdb_id,title,playback_url,playback_type,active,expires_at,created_at,updated_at`,[tmdbId,title||null,playbackUrl,playbackType]);
    await writeAdminAudit(req,"Movie playback source saved","movie",tmdbId,{title,playback_type:playbackType});
    return res.json({success:true,message:"Playback source saved.",movie:result.rows[0]});
  } catch(error) { console.error("Admin movie playback save error:",error); return sendError(res,500,"Could not save movie playback source."); }
});

app.get("/api/admin/audit", requireAdmin, async (req,res) => {
  try {
    const result = await pool.query(
      `SELECT id,admin_email,action,target_type,target_id,details,created_at
       FROM admin_audit_log ORDER BY created_at DESC LIMIT 300`
    );
    return res.json({success:true,audit:result.rows});
  } catch (error) {
    console.error("Admin audit load error:",error);
    return sendError(res,500,"Could not load admin audit log.");
  }
});

app.get("/api/admin/analytics", async (req,res) => {
  if(!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
  try {
    const [sales,wallet,withdrawals,customers,topServices,topNetworks]=await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('Completed','completed')),0) AS completed_sales, COALESCE(SUM(amount),0) AS total_order_value, COUNT(*) AS order_count FROM orders WHERE created_at >= NOW()-INTERVAL '30 days'`),
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE LOWER(type) IN ('credit','admin_credit','topup')),0) AS wallet_in, COALESCE(SUM(amount) FILTER (WHERE LOWER(type) IN ('debit','admin_debit','purchase','withdrawal_pending')),0) AS wallet_out FROM wallet_transactions WHERE created_at >= NOW()-INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='Pending Approval') AS pending, COALESCE(SUM(amount) FILTER (WHERE status IN ('Approved','Paid')),0) AS approved_value FROM wallet_withdrawals WHERE created_at >= NOW()-INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) AS total FROM customers`),
      pool.query(`SELECT COALESCE(service,'Unknown') AS service,COUNT(*)::int AS orders,COALESCE(SUM(amount),0)::numeric AS value FROM orders WHERE created_at >= NOW()-INTERVAL '30 days' GROUP BY service ORDER BY value DESC LIMIT 10`),
      pool.query(`SELECT COALESCE(NULLIF(network,''),'Unknown') AS network,COUNT(*)::int AS orders,COALESCE(SUM(amount),0)::numeric AS value FROM orders WHERE created_at >= NOW()-INTERVAL '30 days' GROUP BY network ORDER BY value DESC LIMIT 10`)
    ]);
    return res.json({success:true,period:"30 days",sales:sales.rows[0],wallet:wallet.rows[0],withdrawals:withdrawals.rows[0],customers:customers.rows[0],top_services:topServices.rows,top_networks:topNetworks.rows});
  } catch(error) {
    console.error("Admin analytics error:",error);
    return res.status(500).json({success:false,message:"Could not load analytics."});
  }
});


// =====================================================
// ADMIN BUSINESS CONTROL CENTER
// =====================================================
app.get("/api/admin/savings", requireAdmin, async (req,res) => {
  try {
    const [accounts,groups,summary] = await Promise.all([
      pool.query(`SELECT s.id,s.goal_name,s.target_amount,s.balance,s.frequency,s.status,s.created_at,c.name AS customer_name,c.email
                  FROM savings_accounts s JOIN customers c ON c.id=s.customer_id
                  ORDER BY s.created_at DESC LIMIT 200`),
      pool.query(`SELECT g.id,g.name,g.icon,g.member_limit,g.contribution_amount,g.status,g.created_at,
                  COUNT(DISTINCT m.id)::int AS members,
                  COALESCE((SELECT SUM(gc.amount) FROM susu_group_contributions gc WHERE gc.group_id=g.id AND gc.status='Completed'),0)::numeric AS collected
                  FROM susu_groups g
                  LEFT JOIN susu_group_members m ON m.group_id=g.id AND m.status='Active'
                  GROUP BY g.id ORDER BY g.created_at DESC LIMIT 200`),
      pool.query(`SELECT
        (SELECT COUNT(*) FROM savings_accounts)::int AS personal_accounts,
        (SELECT COALESCE(SUM(balance),0) FROM savings_accounts)::numeric AS personal_balance,
        (SELECT COUNT(*) FROM susu_groups)::int AS groups,
        (SELECT COALESCE(SUM(amount),0) FROM susu_group_contributions WHERE status='Completed')::numeric AS group_contributions,
        (SELECT COALESCE(SUM(amount),0) FROM susu_group_payouts WHERE status IN ('Pending','Processing'))::numeric AS pending_payouts`)
    ]);
    return res.json({success:true,summary:summary.rows[0],accounts:accounts.rows,groups:groups.rows});
  } catch(error) {
    console.error("Admin savings error:",error);
    return sendError(res,500,"Could not load Savings/Susu administration.");
  }
});

app.post("/api/admin/notifications/broadcast", requireAdmin, async (req,res) => {
  try {
    const title=String(req.body?.title||"").trim().slice(0,160);
    const message=String(req.body?.message||"").trim().slice(0,2000);
    const type=String(req.body?.type||"info").trim().slice(0,40);
    if(title.length<2||message.length<2) return sendError(res,400,"Enter a title and message.");
    const result=await pool.query(`INSERT INTO customer_notifications(customer_id,title,message,type,is_broadcast)
      SELECT id,$1,$2,$3,TRUE FROM customers RETURNING id`,[title,message,type]);
    await writeAdminAudit(req,"notification_broadcast","customers","all",{title,type,sent:result.rowCount});
    return res.json({success:true,sent:result.rowCount,message:"Notification sent to"});
  } catch(error) {
    console.error("Admin notification broadcast error:",error);
    return sendError(res,500,"Could not send notification.");
  }
});

app.get("/api/admin/notifications/broadcasts", requireAdmin, async (req,res) => {
  try {
    const result=await pool.query(`SELECT title,message,type,COUNT(*)::int AS recipients,
      MIN(created_at) AS sent_at
      FROM customer_notifications WHERE is_broadcast=TRUE
      GROUP BY title,message,type,DATE_TRUNC('second',created_at)
      ORDER BY sent_at DESC LIMIT 50`);
    return res.json({success:true,broadcasts:result.rows});
  } catch(error) {
    console.error("Admin broadcast history error:",error);
    return sendError(res,500,"Could not load broadcast history.");
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
async function getAutomaticCampaign(network, capacity, baseAmount, customerId=null){
  const params=[network, String(capacity)];
  const r=await pool.query(`
    SELECT * FROM marketing_campaigns
    WHERE active=TRUE AND starts_at<=NOW() AND (ends_at IS NULL OR ends_at>=NOW())
      AND (network IS NULL OR network='' OR network=$1)
      AND (capacity IS NULL OR capacity='' OR capacity=$2)
      AND (max_uses IS NULL OR uses < max_uses)
    ORDER BY
      CASE WHEN network=$1 AND capacity=$2 THEN 0 WHEN network=$1 THEN 1 WHEN capacity=$2 THEN 2 ELSE 3 END,
      starts_at DESC, id DESC
    LIMIT 1`,params);
  if(!r.rows.length) return null;
  const c=r.rows[0];
  let discount=0;
  const type=String(c.discount_type||'none').toLowerCase();
  const value=Number(c.discount_value||0);
  if(type==='percent') discount=Math.min(baseAmount,baseAmount*(Math.max(0,Math.min(value,100))/100));
  else if(type==='fixed') discount=Math.min(baseAmount,Math.max(0,value));
  discount=Math.round(discount*100)/100;
  return {...c,discount,sale_amount:Math.round((baseAmount-discount)*100)/100};
}

app.get("/api/marketing/campaigns",async(req,res)=>{
  try{
    const r=await pool.query(`SELECT id,title,subtitle,message,cta_label,cta_url,promo_code,network,capacity,discount_type,discount_value,starts_at,ends_at,impressions,clicks
      FROM marketing_campaigns
      WHERE active=TRUE AND starts_at<=NOW() AND (ends_at IS NULL OR ends_at>=NOW())
      ORDER BY starts_at DESC LIMIT 6`);
    return res.json({success:true,campaigns:r.rows});
  }catch(e){console.error("Marketing campaigns error",e);return res.status(500).json({success:false,message:"Could not load campaigns."});}
});
app.post("/api/marketing/campaigns/:id/impression",async(req,res)=>{
  try{await pool.query("UPDATE marketing_campaigns SET impressions=impressions+1 WHERE id=$1 AND active=TRUE",[Number(req.params.id)]);return res.json({success:true});}
  catch(e){return res.status(500).json({success:false});}
});
app.post("/api/marketing/campaigns/:id/click",async(req,res)=>{
  try{await pool.query("UPDATE marketing_campaigns SET clicks=clicks+1 WHERE id=$1 AND active=TRUE",[Number(req.params.id)]);return res.json({success:true});}
  catch(e){return res.status(500).json({success:false});}
});
app.post("/api/admin/marketing/campaigns",async(req,res)=>{
  if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});
  try{
    const title=String(req.body?.title||"").trim().slice(0,120);
    const subtitle=String(req.body?.subtitle||"").trim().slice(0,180);
    const message=String(req.body?.message||"").trim().slice(0,500);
    const ctaLabel=String(req.body?.cta_label||"Shop DGM").trim().slice(0,60);
    const ctaUrl=String(req.body?.cta_url||"/data.html").trim().slice(0,300);
    const promoCode=String(req.body?.promo_code||"").trim().toUpperCase().slice(0,50)||null;
    const network=String(req.body?.network||"").trim()||null;
    const capacity=String(req.body?.capacity||"").trim()||null;
    const discountType=["none","percent","fixed"].includes(String(req.body?.discount_type||"none"))?String(req.body.discount_type):"none";
    const discountValue=Math.max(0,Number(req.body?.discount_value||0));
    const maxUses=req.body?.max_uses===null||req.body?.max_uses===""||req.body?.max_uses===undefined?null:Math.max(1,Number(req.body.max_uses));
    const startsAt=req.body?.starts_at||new Date().toISOString();
    const endsAt=req.body?.ends_at||null;
    if(!title)return res.status(400).json({success:false,message:"Campaign title is required."});
    const r=await pool.query("INSERT INTO marketing_campaigns(title,subtitle,message,cta_label,cta_url,promo_code,network,capacity,discount_type,discount_value,max_uses,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",[title,subtitle||null,message||null,ctaLabel,ctaUrl,promoCode,network,capacity,discountType,discountValue,maxUses,startsAt,endsAt]);
    return res.status(201).json({success:true,campaign:r.rows[0]});
  }catch(e){console.error("Create campaign error",e);return res.status(400).json({success:false,message:e.message});}
});
app.get("/api/admin/marketing/campaigns",async(req,res)=>{
  if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});
  try{const r=await pool.query("SELECT * FROM marketing_campaigns ORDER BY created_at DESC LIMIT 200");return res.json({success:true,campaigns:r.rows});}
  catch(e){return res.status(500).json({success:false,message:"Could not load campaigns."});}
});
app.patch("/api/admin/marketing/campaigns/:id",async(req,res)=>{
  if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});
  try{const r=await pool.query("UPDATE marketing_campaigns SET active=COALESCE($1,active),updated_at=NOW() WHERE id=$2 RETURNING *",[req.body?.active===undefined?null:Boolean(req.body.active),Number(req.params.id)]);if(!r.rows.length)return res.status(404).json({success:false,message:"Campaign not found."});return res.json({success:true,campaign:r.rows[0]});}
  catch(e){return res.status(400).json({success:false,message:e.message});}
});
app.delete("/api/admin/marketing/campaigns/:id",async(req,res)=>{
  if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});
  try{await pool.query("DELETE FROM marketing_campaigns WHERE id=$1",[Number(req.params.id)]);return res.json({success:true});}
  catch(e){return res.status(400).json({success:false,message:e.message});}
});

app.post("/api/admin/promo-codes",async(req,res)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});try{const code=String(req.body?.code||"").trim().toUpperCase();const value=Number(req.body?.discount_value);if(!code||!Number.isFinite(value)||value<=0)return res.status(400).json({success:false,message:"Invalid promotion."});const r=await pool.query("INSERT INTO promo_codes(code,discount_type,discount_value,max_uses,min_amount,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[code,req.body?.discount_type||"percent",value,req.body?.max_uses?Number(req.body.max_uses):null,Number(req.body?.min_amount||0),req.body?.expires_at||null]);res.status(201).json({success:true,promo:r.rows[0]});}catch(e){res.status(400).json({success:false,message:e.message});}});
app.get("/api/admin/promo-codes",async(req,res)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});const r=await pool.query("SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 200");res.json({success:true,promos:r.rows});});
app.post("/api/admin/api-keys",async(req,res)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});try{const customerId=Number(req.body?.customer_id);const name=String(req.body?.name||"DGM API").slice(0,80);if(!Number.isInteger(customerId))return res.status(400).json({success:false,message:"Valid customer_id required."});const raw="dgm_live_"+crypto.randomBytes(24).toString("hex");const hash=crypto.createHash("sha256").update(raw).digest("hex");const r=await pool.query("INSERT INTO customer_api_keys(customer_id,name,key_hash,key_prefix) VALUES($1,$2,$3,$4) RETURNING id,name,key_prefix,created_at",[customerId,name,hash,raw.slice(0,16)]);res.status(201).json({success:true,key:raw,record:r.rows[0],warning:"Save this key now. It cannot be shown again."});}catch(e){res.status(400).json({success:false,message:e.message});}});
app.get("/api/admin/api-keys",async(req,res)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false});const r=await pool.query("SELECT k.id,k.customer_id,k.name,k.key_prefix,k.active,k.last_used_at,k.created_at,c.email,c.name AS customer_name FROM customer_api_keys k JOIN customers c ON c.id=k.customer_id ORDER BY k.created_at DESC LIMIT 200");res.json({success:true,keys:r.rows});});



async function initSusuDatabase() {
  const q = async (sql) => pool.query(sql);
  await q("CREATE TABLE IF NOT EXISTS savings_accounts (id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE, goal_name TEXT NOT NULL, target_amount NUMERIC(12,2) NOT NULL DEFAULT 0, target_date DATE, balance NUMERIC(12,2) NOT NULL DEFAULT 0, frequency TEXT NOT NULL DEFAULT 'Flexible', contribution_amount NUMERIC(12,2) NOT NULL DEFAULT 0, auto_enabled BOOLEAN NOT NULL DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'Active', withdrawal_code_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await q("CREATE TABLE IF NOT EXISTS savings_transactions (id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, savings_account_id INTEGER NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE, type TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, balance_before NUMERIC(12,2) NOT NULL DEFAULT 0, balance_after NUMERIC(12,2) NOT NULL DEFAULT 0, reference TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'Completed', description TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await q("CREATE TABLE IF NOT EXISTS savings_schedules (id SERIAL PRIMARY KEY, savings_account_id INTEGER NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE, frequency TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, next_run_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await q("CREATE TABLE IF NOT EXISTS savings_topups (id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, savings_account_id INTEGER NOT NULL REFERENCES savings_accounts(id) ON DELETE CASCADE, reference TEXT UNIQUE NOT NULL, amount NUMERIC(12,2) NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', payment_status TEXT NOT NULL DEFAULT 'Pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ)");
  await q("CREATE TABLE IF NOT EXISTS susu_groups (id SERIAL PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '👥', creator_id INTEGER NOT NULL REFERENCES customers(id), member_limit INTEGER NOT NULL, contribution_amount NUMERIC(12,2) NOT NULL, frequency TEXT NOT NULL, start_date DATE NOT NULL, end_date DATE, admin_code_hash TEXT, invite_code TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'Active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await q("CREATE TABLE IF NOT EXISTS susu_group_members (id SERIAL PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES susu_groups(id) ON DELETE CASCADE, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'Member', status TEXT NOT NULL DEFAULT 'Active', joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(group_id,customer_id))");
  await q("CREATE TABLE IF NOT EXISTS susu_group_contributions (id SERIAL PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES susu_groups(id) ON DELETE CASCADE, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, amount NUMERIC(12,2) NOT NULL, reference TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'Completed', due_date DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await q("CREATE TABLE IF NOT EXISTS susu_group_periods (id SERIAL PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES susu_groups(id) ON DELETE CASCADE, period_no INTEGER NOT NULL, recipient_customer_id INTEGER REFERENCES customers(id), due_date DATE, amount NUMERIC(12,2) NOT NULL, status TEXT NOT NULL DEFAULT 'Upcoming', paid_at TIMESTAMPTZ, UNIQUE(group_id,period_no))");
  await q("CREATE TABLE IF NOT EXISTS susu_group_payouts (id SERIAL PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES susu_groups(id) ON DELETE CASCADE, period_id INTEGER NOT NULL REFERENCES susu_group_periods(id) ON DELETE CASCADE, recipient_customer_id INTEGER NOT NULL REFERENCES customers(id), amount NUMERIC(12,2) NOT NULL, reference TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ)");
  await q("CREATE TABLE IF NOT EXISTS susu_notifications (id SERIAL PRIMARY KEY, group_id INTEGER REFERENCES susu_groups(id) ON DELETE CASCADE, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, title TEXT NOT NULL, message TEXT NOT NULL, type TEXT, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await q("ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS withdrawal_code_hash TEXT");
  await q("ALTER TABLE savings_topups ADD COLUMN IF NOT EXISTS savings_account_id INTEGER");
  await q("ALTER TABLE savings_topups ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ");
  await q("ALTER TABLE susu_groups ADD COLUMN IF NOT EXISTS creator_id INTEGER");
  await q("ALTER TABLE susu_groups ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '👥'");
  await q("ALTER TABLE susu_groups ADD COLUMN IF NOT EXISTS start_date DATE");
  await q("ALTER TABLE susu_groups ADD COLUMN IF NOT EXISTS end_date DATE");
  await q("ALTER TABLE susu_groups ADD COLUMN IF NOT EXISTS admin_code_hash TEXT");
  // New Group Susu groups are independent of a personal savings account.
  // The legacy schema required savings_account_id, so allow it to be NULL for new groups.
  await q("ALTER TABLE susu_groups ALTER COLUMN savings_account_id DROP NOT NULL");
  // Repair legacy groups created before creator memberships were marked Active.
  await q("UPDATE susu_group_members m SET status='Active', joined_at=COALESCE(m.joined_at,NOW()), turn_order=COALESCE(m.turn_order,1) FROM susu_groups g WHERE m.group_id=g.id AND m.customer_id=g.creator_id AND m.role='Admin' AND m.status<>'Active'");
  await q("ALTER TABLE susu_groups ADD COLUMN IF NOT EXISTS invite_code TEXT");
  await q("ALTER TABLE susu_group_contributions ADD COLUMN IF NOT EXISTS due_date DATE");
  await q("ALTER TABLE susu_group_payouts ADD COLUMN IF NOT EXISTS period_id INTEGER");
  await q("ALTER TABLE susu_group_payouts ADD COLUMN IF NOT EXISTS recipient_customer_id INTEGER");
  await q("ALTER TABLE susu_group_payouts ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ");
  await q("UPDATE susu_groups SET creator_id=owner_customer_id WHERE creator_id IS NULL AND owner_customer_id IS NOT NULL");
  await q("UPDATE susu_groups SET icon='👥' WHERE icon IS NULL");
  await q("UPDATE susu_groups SET invite_code='DGM-SUSU-'||UPPER(SUBSTRING(MD5(id::text||random()::text) FROM 1 FOR 8)) WHERE invite_code IS NULL");
  await q("CREATE INDEX IF NOT EXISTS savings_tx_customer_created_idx ON savings_transactions(customer_id,created_at DESC)");
  await q("CREATE INDEX IF NOT EXISTS susu_contrib_group_created_idx ON susu_group_contributions(group_id,created_at DESC)");
  console.log("Savings/Susu database initialized.");
}


function susuRef(prefix){ return "DGM-"+prefix+"-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(4).toString("hex").toUpperCase(); }
function nextSusuDate(freq){ const d=new Date(); if(freq==="Daily")d.setDate(d.getDate()+1); else if(freq==="Weekly")d.setDate(d.getDate()+7); else if(freq==="Monthly")d.setMonth(d.getMonth()+1); else return null; return d; }
app.get("/api/savings",requireCustomer,async(req,res)=>{try{const a=(await pool.query("SELECT * FROM savings_accounts WHERE customer_id=$1",[req.session.customerId])).rows[0];if(!a)return res.status(404).json({success:false,message:"Personal Savings has not been created yet."});const [t,s]=await Promise.all([pool.query("SELECT * FROM savings_transactions WHERE savings_account_id=$1 ORDER BY created_at DESC LIMIT 200",[a.id]),pool.query("SELECT * FROM savings_schedules WHERE savings_account_id=$1 ORDER BY id DESC LIMIT 1",[a.id])]);const target=Number(a.target_amount),bal=Number(a.balance);res.json({success:true,account:{...a,balance:bal,target_amount:target,progress_percent:target?Math.min(100,Math.round(bal/target*10000)/100):0,amount_remaining:Math.max(0,target-bal)},schedule:s.rows[0]||null,transactions:t.rows});}catch(e){res.status(500).json({success:false,message:"Could not load savings."});}});
app.post("/api/savings/create",requireCustomer,async(req,res)=>{const goal=String(req.body?.goal_name||"").trim(),target=Number(req.body?.target_amount||0),date=String(req.body?.target_date||"").trim(),freq=String(req.body?.frequency||"Flexible"),amt=Number(req.body?.contribution_amount||0),code=String(req.body?.withdrawal_code||"");if(goal.length<2||target<1||!Number.isFinite(target)||!/^\d{4,8}$/.test(code)||!["Daily","Weekly","Monthly","Flexible"].includes(freq)||(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)))return res.status(400).json({success:false,message:"Complete the Savings setup correctly."});const c=await pool.connect();try{await c.query("BEGIN");if((await c.query("SELECT id FROM savings_accounts WHERE customer_id=$1 FOR UPDATE",[req.session.customerId])).rows.length){await c.query("ROLLBACK");return res.status(409).json({success:false,message:"Personal Savings already exists."});}const cr=(await c.query("SELECT balance FROM customers WHERE id=$1 FOR UPDATE",[req.session.customerId])).rows[0],wallet=Number(cr?.balance||0);if(wallet<5){await c.query("ROLLBACK");return res.status(400).json({success:false,message:"You need GH₵5.00 in your DGM Wallet for setup."});}const hash=await bcrypt.hash(code,12),a=(await c.query("INSERT INTO savings_accounts(customer_id,goal_name,target_amount,target_date,frequency,contribution_amount,withdrawal_code_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[req.session.customerId,goal,target,date||null,freq,amt||0,hash])).rows[0],ref=susuRef("SAVINGS");await c.query("UPDATE customers SET balance=balance-5 WHERE id=$1",[req.session.customerId]);await c.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'debit',5,$2,$2-5,'Personal Savings setup fee',$3,'Completed',$3)",[req.session.customerId,wallet,ref]);await c.query("INSERT INTO savings_transactions(customer_id,savings_account_id,type,amount,reference,description) VALUES($1,$2,'Setup Fee',5,$3,'Personal Savings setup fee')",[req.session.customerId,a.id,ref]);if(freq!=="Flexible"&&amt>0)await c.query("INSERT INTO savings_schedules(savings_account_id,frequency,amount,next_run_at) VALUES($1,$2,$3,$4)",[a.id,freq,amt,nextSusuDate(freq)]);await c.query("COMMIT");res.status(201).json({success:true,message:"Personal Savings created. GH₵5.00 setup fee charged.",account:a});}catch(e){await c.query("ROLLBACK").catch(()=>{});console.error(e);res.status(500).json({success:false,message:"Could not create Personal Savings."});}finally{c.release();}});
app.post("/api/savings/wallet-contribute",requireCustomer,async(req,res)=>{const amount=Number(req.body?.amount||0),password=String(req.body?.password||"");const c=await pool.connect();try{await c.query("BEGIN");const cust=(await c.query("SELECT * FROM customers WHERE id=$1 FOR UPDATE",[req.session.customerId])).rows[0],a=(await c.query("SELECT * FROM savings_accounts WHERE customer_id=$1 FOR UPDATE",[req.session.customerId])).rows[0];if(!a){await c.query("ROLLBACK");return res.status(404).json({success:false,message:"Create Personal Savings first."});}if(!(await bcrypt.compare(password,cust.password))){await c.query("ROLLBACK");return res.status(401).json({success:false,message:"Account password is incorrect."});}if(amount<1||Number(cust.balance)<amount){await c.query("ROLLBACK");return res.status(400).json({success:false,message:"Insufficient DGM Wallet balance."});}const before=Number(a.balance),after=before+amount,ref=susuRef("SAVINGS");await c.query("UPDATE customers SET balance=balance-$1 WHERE id=$2",[amount,cust.id]);await c.query("UPDATE savings_accounts SET balance=$1,updated_at=NOW() WHERE id=$2",[after,a.id]);await c.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'debit',$2,$3,$4,'Transfer to Personal Savings',$5,'Completed',$5)",[cust.id,amount,cust.balance,Number(cust.balance)-amount,ref]);await c.query("INSERT INTO savings_transactions(customer_id,savings_account_id,type,amount,balance_before,balance_after,reference,description) VALUES($1,$2,'Deposit',$3,$4,$5,$6,'Saved from DGM Wallet')",[cust.id,a.id,amount,before,after,ref]);await c.query("COMMIT");res.json({success:true,message:"Contribution completed.",reference:ref,balance:after});}catch(e){await c.query("ROLLBACK").catch(()=>{});res.status(500).json({success:false,message:"Could not save from wallet."});}finally{c.release();}});
app.post("/api/savings/settings",requireCustomer,async(req,res)=>{try{const a=(await pool.query("SELECT * FROM savings_accounts WHERE customer_id=$1",[req.session.customerId])).rows[0];if(!a)return res.status(404).json({success:false,message:"Create Personal Savings first."});const f=String(req.body?.frequency||"Flexible"),amt=Number(req.body?.contribution_amount||0),on=Boolean(req.body?.auto_enabled);if(!["Daily","Weekly","Monthly","Flexible"].includes(f)||amt<0)return res.status(400).json({success:false,message:"Invalid schedule."});await pool.query("UPDATE savings_accounts SET frequency=$1,contribution_amount=$2,auto_enabled=$3,updated_at=NOW() WHERE id=$4",[f,amt,on,a.id]);await pool.query("DELETE FROM savings_schedules WHERE savings_account_id=$1",[a.id]);if(on&&f!=="Flexible"&&amt>0)await pool.query("INSERT INTO savings_schedules(savings_account_id,frequency,amount,next_run_at) VALUES($1,$2,$3,$4)",[a.id,f,amt,nextSusuDate(f)]);res.json({success:true,message:"Automatic contribution schedule updated."});}catch(e){res.status(500).json({success:false,message:"Could not update schedule."});}});
app.post("/api/savings/withdraw",requireCustomer,async(req,res)=>{const amount=Number(req.body?.amount||0),code=String(req.body?.withdrawal_code||""),c=await pool.connect();try{await c.query("BEGIN");const a=(await c.query("SELECT * FROM savings_accounts WHERE customer_id=$1 FOR UPDATE",[req.session.customerId])).rows[0];if(!a){await c.query("ROLLBACK");return res.status(404).json({success:false,message:"Create Personal Savings first."});}if(!(await bcrypt.compare(code,a.withdrawal_code_hash))){await c.query("ROLLBACK");return res.status(401).json({success:false,message:"Withdrawal code is incorrect."});}if(amount<1||Number(a.balance)<amount){await c.query("ROLLBACK");return res.status(400).json({success:false,message:"Insufficient savings balance."});}const cust=(await c.query("SELECT balance FROM customers WHERE id=$1 FOR UPDATE",[req.session.customerId])).rows[0],ref=susuRef("SAVINGS"),before=Number(a.balance),after=before-amount;await c.query("UPDATE savings_accounts SET balance=$1,updated_at=NOW() WHERE id=$2",[after,a.id]);await c.query("UPDATE customers SET balance=balance+$1 WHERE id=$2",[amount,req.session.customerId]);await c.query("INSERT INTO savings_transactions(customer_id,savings_account_id,type,amount,balance_before,balance_after,reference,description) VALUES($1,$2,'Withdrawal',$3,$4,$5,$6,'Transferred to DGM Wallet')",[req.session.customerId,a.id,amount,before,after,ref]);await c.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'credit',$2,$3,$4,'Personal Savings withdrawal',$5,'Completed',$5)",[req.session.customerId,amount,Number(cust.balance),Number(cust.balance)+amount,ref]);await c.query("COMMIT");res.json({success:true,message:"Withdrawal completed.",reference:ref,balance:after});}catch(e){await c.query("ROLLBACK").catch(()=>{});res.status(500).json({success:false,message:"Could not complete withdrawal."});}finally{c.release();}});
app.post("/api/savings/paystack/initialize",requireCustomer,async(req,res)=>{try{if(!PAYSTACK_SECRET_KEY)return res.status(503).json({success:false,message:"Paystack is not configured."});const a=(await pool.query("SELECT * FROM savings_accounts WHERE customer_id=$1",[req.session.customerId])).rows[0],amount=Number(req.body?.amount||0),cust=await getCustomer(req.session.customerId);if(!a||!cust)return res.status(404).json({success:false,message:"Savings account not found."});if(amount<1||amount>100000)return res.status(400).json({success:false,message:"Invalid amount."});const ref=susuRef("SAVINGS");await pool.query("INSERT INTO savings_topups(customer_id,savings_account_id,reference,amount) VALUES($1,$2,$3,$4)",[cust.id,a.id,ref,amount]);const r=await fetch("https://api.paystack.co/transaction/initialize",{method:"POST",headers:{Authorization:"Bearer "+PAYSTACK_SECRET_KEY,"Content-Type":"application/json"},body:JSON.stringify({email:cust.email,amount:String(Math.round(amount*100)),currency:"GHS",reference:ref,callback_url:BASE_URL.replace(/\/$/,"")+"/api/savings/paystack-callback"})}),j=await r.json().catch(()=>({}));if(!r.ok||!j.status||!j.data?.authorization_url){await pool.query("UPDATE savings_topups SET status='Failed',payment_status='Failed' WHERE reference=$1",[ref]);return res.status(502).json({success:false,message:j.message||"Paystack initialization failed."});}res.json({success:true,reference:ref,authorization_url:j.data.authorization_url});}catch(e){res.status(500).json({success:false,message:"Could not start Paystack payment."});}});
app.get("/api/savings/paystack-callback",async(req,res)=>{const ref=String(req.query.reference||"");try{if(!PAYSTACK_SECRET_KEY)throw Error("Paystack unavailable");const r=await fetch("https://api.paystack.co/transaction/verify/"+encodeURIComponent(ref),{headers:{Authorization:"Bearer "+PAYSTACK_SECRET_KEY}}),j=await r.json().catch(()=>({})),p=j.data||{},top=(await pool.query("SELECT * FROM savings_topups WHERE reference=$1",[ref])).rows[0];if(!top||!r.ok||!j.status||String(p.status).toLowerCase()!=="success"||String(p.currency).toUpperCase()!=="GHS"||Number(p.amount)!==Math.round(Number(top.amount)*100))throw Error("Payment verification failed");const c=await pool.connect();try{await c.query("BEGIN");const a=(await c.query("SELECT balance FROM savings_accounts WHERE id=$1 FOR UPDATE",[top.savings_account_id])).rows[0],before=Number(a.balance),after=before+Number(top.amount);await c.query("UPDATE savings_accounts SET balance=$1,updated_at=NOW() WHERE id=$2",[after,top.savings_account_id]);await c.query("UPDATE savings_topups SET status='Completed',payment_status='Success',completed_at=NOW() WHERE reference=$1",[ref]);await c.query("INSERT INTO savings_transactions(customer_id,savings_account_id,type,amount,balance_before,balance_after,reference,description) VALUES($1,$2,'Direct Contribution',$3,$4,$5,$6,'Paystack contribution')",[top.customer_id,top.savings_account_id,top.amount,before,after,ref]);await c.query("COMMIT");}finally{c.release();}res.redirect("/personal-savings.html?payment=success&reference="+encodeURIComponent(ref));}catch(e){await pool.query("UPDATE savings_topups SET status='Failed',payment_status='Failed' WHERE reference=$1",[ref]).catch(()=>{});res.redirect("/personal-savings.html?payment=failed");}});
app.post("/api/susu/groups",requireCustomer,async(req,res)=>{const name=String(req.body?.name||"").trim(),icon=String(req.body?.icon||"👥"),limit=Number(req.body?.member_limit||0),amount=Number(req.body?.contribution_amount||0),freq=String(req.body?.frequency||"Weekly"),start=String(req.body?.start_date||""),end=String(req.body?.end_date||""),code=String(req.body?.admin_code||"");if(name.length<2||limit<2||limit>100||amount<1||!["Daily","Weekly","Monthly"].includes(freq)||!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4,8}$/.test(code))return res.status(400).json({success:false,message:"Complete Group Susu setup correctly."});const h=await bcrypt.hash(code,12),invite="DGM-SUSU-"+crypto.randomBytes(4).toString("hex").toUpperCase(),c=await pool.connect();try{await c.query("BEGIN");const g=(await c.query("INSERT INTO susu_groups(savings_account_id,owner_customer_id,name,icon,creator_id,member_limit,contribution_amount,frequency,start_date,end_date,admin_code_hash,invite_code) VALUES(NULL,$3,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",[name,icon,req.session.customerId,limit,amount,freq,start,end||null,h,invite])).rows[0];await c.query("INSERT INTO susu_group_members(group_id,customer_id,role,status,display_name,turn_order,joined_at) VALUES($1,$2,'Admin','Active',$3,1,NOW())",[g.id,req.session.customerId,req.session.customerName||"Admin"]);const step=freq==="Daily"?1:freq==="Weekly"?7:30;for(let i=1;i<=limit;i++){const dd=new Date(start);dd.setDate(dd.getDate()+step*(i-1));await c.query("INSERT INTO susu_group_periods(group_id,period_no,amount,due_date) VALUES($1,$2,$3,$4)",[g.id,i,amount*limit,dd]);}await c.query("COMMIT");res.status(201).json({success:true,group:g,invite_code:invite});}catch(e){await c.query("ROLLBACK").catch(()=>{});res.status(500).json({success:false,message:"Could not create group."});}finally{c.release();}});
app.post("/api/susu/join",requireCustomer,async(req,res)=>{const code=String(req.body?.invite_code||"").trim().toUpperCase();try{const g=(await pool.query("SELECT * FROM susu_groups WHERE invite_code=$1 AND status='Active'",[code])).rows[0];if(!g)return res.status(404).json({success:false,message:"Group not found."});const count=Number((await pool.query("SELECT COUNT(*) FROM susu_group_members WHERE group_id=$1 AND status='Active'",[g.id])).rows[0].count);if(count>=g.member_limit)return res.status(400).json({success:false,message:"Group is full."});await pool.query("INSERT INTO susu_group_members(group_id,customer_id) VALUES($1,$2) ON CONFLICT(group_id,customer_id) DO UPDATE SET status='Active'",[g.id,req.session.customerId]);res.json({success:true,message:"You joined "+g.name+".",group_id:g.id});}catch(e){res.status(500).json({success:false,message:"Could not join group."});}});
app.get("/api/susu/groups",requireCustomer,async(req,res)=>{try{const r=await pool.query("SELECT g.*,m.role,(SELECT COUNT(*) FROM susu_group_members x WHERE x.group_id=g.id AND x.status='Active')::int member_count,(SELECT COALESCE(SUM(amount),0) FROM susu_group_contributions c WHERE c.group_id=g.id AND c.status='Completed') collected FROM susu_groups g JOIN susu_group_members m ON m.group_id=g.id WHERE m.customer_id=$1 ORDER BY g.created_at DESC",[req.session.customerId]);res.json({success:true,groups:r.rows});}catch(e){res.status(500).json({success:false,message:"Could not load groups."});}});
app.get("/api/susu/groups/:id",requireCustomer,async(req,res)=>{try{const id=Number(req.params.id),mem=(await pool.query("SELECT role FROM susu_group_members WHERE group_id=$1 AND customer_id=$2 AND status='Active'",[id,req.session.customerId])).rows[0];if(!mem)return res.status(403).json({success:false,message:"Not a group member."});const [g,m,p,c]=await Promise.all([pool.query("SELECT * FROM susu_groups WHERE id=$1",[id]),pool.query("SELECT m.*,c.name,c.phone FROM susu_group_members m JOIN customers c ON c.id=m.customer_id WHERE m.group_id=$1 AND m.status='Active' ORDER BY m.joined_at",[id]),pool.query("SELECT p.*,c.name recipient_name FROM susu_group_periods p LEFT JOIN customers c ON c.id=p.recipient_customer_id WHERE p.group_id=$1 ORDER BY p.period_no",[id]),pool.query("SELECT c.*,u.name member_name FROM susu_group_contributions c JOIN customers u ON u.id=c.customer_id WHERE c.group_id=$1 ORDER BY c.created_at DESC",[id])]);res.json({success:true,group:g.rows[0],members:m.rows,periods:p.rows,contributions:c.rows,viewer_role:mem.role,collected:c.rows.reduce((n,x)=>n+Number(x.amount),0)});}catch(e){res.status(500).json({success:false,message:"Could not load group."});}});
app.post("/api/susu/groups/:id/contribute",requireCustomer,async(req,res)=>{const id=Number(req.params.id),amount=Number(req.body?.amount||0),password=String(req.body?.password||""),c=await pool.connect();try{await c.query("BEGIN");const mem=(await c.query("SELECT 1 FROM susu_group_members WHERE group_id=$1 AND customer_id=$2 AND status='Active'",[id,req.session.customerId])).rows[0],cust=(await c.query("SELECT * FROM customers WHERE id=$1 FOR UPDATE",[req.session.customerId])).rows[0];if(!mem){await c.query("ROLLBACK");return res.status(403).json({success:false,message:"Not a group member."});}if(!(await bcrypt.compare(password,cust.password))){await c.query("ROLLBACK");return res.status(401).json({success:false,message:"Account password is incorrect."});}if(amount<1||Number(cust.balance)<amount){await c.query("ROLLBACK");return res.status(400).json({success:false,message:"Insufficient DGM Wallet balance."});}const ref=susuRef("SUSU"),g=(await c.query("SELECT name FROM susu_groups WHERE id=$1",[id])).rows[0];await c.query("UPDATE customers SET balance=balance-$1 WHERE id=$2",[amount,cust.id]);await c.query("INSERT INTO susu_group_contributions(group_id,customer_id,amount,reference,due_date) VALUES($1,$2,$3,$4,CURRENT_DATE)",[id,cust.id,amount,ref]);await c.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'debit',$2,$3,$4,$5,$6,'Completed',$6)",[cust.id,amount,cust.balance,Number(cust.balance)-amount,"Susu contribution - "+(g?.name||""),ref]);await c.query("COMMIT");res.json({success:true,message:"Susu contribution completed.",reference:ref});}catch(e){await c.query("ROLLBACK").catch(()=>{});res.status(500).json({success:false,message:"Could not complete contribution."});}finally{c.release();}});
app.post("/api/susu/groups/:id/rotate",requireCustomer,async(req,res)=>{const id=Number(req.params.id),code=String(req.body?.admin_code||"");try{const g=(await pool.query("SELECT * FROM susu_groups WHERE id=$1",[id])).rows[0];if(!g||g.creator_id!==req.session.customerId)return res.status(403).json({success:false,message:"Only the group admin can set rotation."});if(!(await bcrypt.compare(code,g.admin_code_hash)))return res.status(401).json({success:false,message:"Admin code is incorrect."});const m=(await pool.query("SELECT customer_id FROM susu_group_members WHERE group_id=$1 AND status='Active' ORDER BY joined_at",[id])).rows,p=await pool.query("SELECT id,period_no FROM susu_group_periods WHERE group_id=$1 ORDER BY period_no",[id]);for(let i=0;i<p.rows.length;i++)if(m[i])await pool.query("UPDATE susu_group_periods SET recipient_customer_id=$1 WHERE id=$2",[m[i].customer_id,p.rows[i].id]);res.json({success:true,message:"Rotation assigned."});}catch(e){res.status(500).json({success:false,message:"Could not assign rotation."});}});
app.post("/api/susu/groups/:id/payout/:periodId",requireCustomer,async(req,res)=>{const id=Number(req.params.id),pid=Number(req.params.periodId),code=String(req.body?.admin_code||""),c=await pool.connect();try{await c.query("BEGIN");const g=(await c.query("SELECT * FROM susu_groups WHERE id=$1 FOR UPDATE",[id])).rows[0],p=(await c.query("SELECT * FROM susu_group_periods WHERE id=$1 AND group_id=$2 FOR UPDATE",[pid,id])).rows[0];if(!g||!p||g.creator_id!==req.session.customerId)throw Error("Only the group admin can complete this payout.");if(!(await bcrypt.compare(code,g.admin_code_hash)))throw Error("Admin code is incorrect.");if(!p.recipient_customer_id||p.status==="Paid")throw Error("Invalid payout period.");const total=Number((await c.query("SELECT COALESCE(SUM(amount),0) total FROM susu_group_contributions WHERE group_id=$1 AND status='Completed'",[id])).rows[0].total);if(total<Number(p.amount))throw Error("Group has not collected enough for this payout.");const ref=susuRef("SUSU");await c.query("UPDATE customers SET balance=balance+$1 WHERE id=$2",[p.amount,p.recipient_customer_id]);await c.query("UPDATE susu_group_periods SET status='Paid',paid_at=NOW() WHERE id=$1",[pid]);await c.query("INSERT INTO susu_group_payouts(group_id,period_id,recipient_customer_id,amount,reference,status,completed_at) VALUES($1,$2,$3,$4,$5,'Completed',NOW())",[id,pid,p.recipient_customer_id,p.amount,ref]);await c.query("COMMIT");res.json({success:true,message:"Payout completed.",reference:ref});}catch(e){await c.query("ROLLBACK").catch(()=>{});res.status(400).json({success:false,message:e.message});}finally{c.release();}});


async function processAutomaticSavings() {
  try {
    const due = await pool.query("SELECT s.id,s.savings_account_id,s.amount,s.frequency,a.customer_id FROM savings_schedules s JOIN savings_accounts a ON a.id=s.savings_account_id WHERE s.active=true AND a.auto_enabled=true AND s.next_run_at IS NOT NULL AND s.next_run_at<=NOW() LIMIT 50");
    for (const row of due.rows) {
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        const a=(await client.query("SELECT * FROM savings_accounts WHERE id=$1 FOR UPDATE",[row.savings_account_id])).rows[0];
        const c=(await client.query("SELECT * FROM customers WHERE id=$1 FOR UPDATE",[row.customer_id])).rows[0];
        const sch=(await client.query("SELECT * FROM savings_schedules WHERE id=$1 FOR UPDATE",[row.id])).rows[0];
        if(!a||!c||!sch||!sch.active){await client.query("ROLLBACK");continue;}
        const amount=Number(sch.amount),wallet=Number(c.balance);
        if(wallet>=amount && amount>0){
          const before=Number(a.balance),after=before+amount,ref=susuRef("SAVINGS");
          await client.query("UPDATE customers SET balance=balance-$1 WHERE id=$2",[amount,c.id]);
          await client.query("UPDATE savings_accounts SET balance=$1,updated_at=NOW() WHERE id=$2",[after,a.id]);
          await client.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'debit',$2,$3,$4,$5,$6,'Completed',$6)",[c.id,amount,wallet,wallet-amount,"Automatic Personal Savings contribution",ref]);
          await client.query("INSERT INTO savings_transactions(customer_id,savings_account_id,type,amount,balance_before,balance_after,reference,description) VALUES($1,$2,'Automatic Deposit',$3,$4,$5,$6,'Scheduled contribution from DGM Wallet')",[c.id,a.id,amount,before,after,ref]);
          await client.query("UPDATE savings_schedules SET next_run_at=$1,updated_at=NOW() WHERE id=$2",[nextSusuDate(sch.frequency),sch.id]);
          await client.query("COMMIT");
          await createCustomerNotification(c.id,"Automatic savings contribution","GH₵"+amount.toFixed(2)+" was automatically moved to Personal Savings.","savings");
        } else {
          await client.query("UPDATE savings_schedules SET next_run_at=$1,updated_at=NOW() WHERE id=$2",[nextSusuDate(sch.frequency),sch.id]);
          await client.query("COMMIT");
          await createCustomerNotification(c.id,"Savings contribution missed","Your scheduled contribution could not be completed because your DGM Wallet balance was insufficient.","savings");
        }
      } catch(e){await client.query("ROLLBACK").catch(()=>{});console.error("Automatic savings error",e.message);}
      finally{client.release();}
    }
  } catch(e){console.error("Automatic savings scan error",e.message);}
}

// =====================================================
// DGM BUSINESS CONTROL CENTER ENTRY\n// Staff-facing business operations always begin at the dedicated staff login.\n// An already-authenticated staff member goes directly to the Staff Workspace.\napp.get("/business-control-center", (req, res) => {\n  if (req.session?.staffId) return res.redirect(302, "/staff.html");\n  return res.redirect(302, "/staff-login.html");\n});\n\n// STAFF / SUPER ADMIN DASHBOARD ROUTING
// =====================================================
// Keep the two portals separate at the URL level while sharing the
// permission-aware dashboard implementation. Staff must never be able
// to open the Super Admin portal directly; the server redirects them
// to the staff portal before static-file handling.
app.get("/admin.html", (req, res, next) => {
  if (req.session?.staffId) return res.redirect(302, "/staff.html");
  next();
});

app.get("/staff.html", (req, res) => {
  if (!req.session?.staffId) return res.redirect(302, "/staff-login.html");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return res.sendFile(path.join(__dirname, "public", "staff.html"));
});

// =====================================================
// FRONTEND STATIC FILES + HEALTH CHECK
// =====================================================
// Prevent browsers/CDNs from serving stale HTML after dashboard deployments.
app.use((req,res,next)=>{
  if(req.path.endsWith(".html") || req.path==="/"){
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma","no-cache");
    res.setHeader("Expires","0");
  }
  next();
});

// DGM PWA bootstrap for customer-facing pages.
app.get(/\.html$/, async (req, res, next) => {
  const excluded = new Set(["/admin.html", "/admin-login.html", "/movie-admin.html", ""]);
  if (excluded.has(req.path)) return next();
  try {
    const filePath = path.join(__dirname, "public", req.path.replace(/^\//, ""));
    if (!filePath.startsWith(path.join(__dirname, "public"))) return next();
    let html = await fs.promises.readFile(filePath, "utf8");
    if (!html.includes('rel="manifest"')) {
      html = html.replace(/<head([^>]*)>/i, '<head$1>\n  <meta name="theme-color" content="#07131f">\n  <meta name="mobile-web-app-capable" content="yes">\n  <meta name="apple-mobile-web-app-capable" content="yes">\n  <link rel="manifest" href="/manifest.webmanifest">');
    }
    if (!html.includes('src="/pwa.js"')) {
      html = html.replace(/<\/body>/i, '<script src="/pwa.js" defer></script>\n</body>');
    }
    res.type("html").send(html);
  } catch (error) {
    if (error.code === "ENOENT") return next();
    console.error("PWA HTML bootstrap error:", error.message);
    next();
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  index: "index.html",
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

app.get("/api/health", async (req, res) => {
  if (!databaseReady && !startupError) {
    return res.status(200).json({
      success: true,
      status: "starting",
      database: "starting",
      paystack: Boolean(PAYSTACK_SECRET_KEY),
      datamart: Boolean(DATAMART_API_KEY && DATAMART_API_SECRET),
      airtime: Boolean(KINGFLEXY_API_KEY),
      timestamp: new Date().toISOString()
    });
  }

  if (startupError) {
    return res.status(503).json({
      success: false,
      status: "offline",
      database: databaseReady ? "online" : "offline",
      message: "Server initialization failed."
    });
  }

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
    console.error("Health check database probe failed:", error.message);
    return res.status(200).json({
      success: true,
      status: "degraded",
      database: "offline",
      paystack: Boolean(PAYSTACK_SECRET_KEY),
      datamart: Boolean(DATAMART_API_KEY && DATAMART_API_SECRET),
      airtime: Boolean(KINGFLEXY_API_KEY),
      timestamp: new Date().toISOString()
    });
  }
});


// Group Susu invitation endpoints (must be registered before API 404)
app.get("/api/susu/v2/invitations", requireLogin, async (req,res)=>{
  try {
    const r=await pool.query("SELECT i.*,g.name group_name,g.icon FROM susu_group_invitations i JOIN susu_groups g ON g.id=i.group_id WHERE i.invited_customer_id=$1 OR i.inviter_customer_id=$1 ORDER BY i.created_at DESC",[req.session.customerId]);
    res.json({success:true,invitations:r.rows});
  } catch(e){ console.error("Susu invitations:",e.message); res.status(500).json({success:false,message:"Could not load invitations."}); }
});
app.post("/api/susu/v2/groups/:id/invitations", requireLogin, async (req,res)=>{
  try {
    const id=Number(req.params.id), identifier=String(req.body?.identifier||"").trim();
    if(!identifier) return res.status(400).json({success:false,message:"Enter phone or email."});
    const g=(await pool.query("SELECT * FROM susu_groups WHERE id=$1",[id])).rows[0];
    const m=(await pool.query("SELECT * FROM susu_group_members WHERE group_id=$1 AND customer_id=$2 AND status='Active'",[id,req.session.customerId])).rows[0];
    if(!g||m?.role!=="Admin") return res.status(403).json({success:false,message:"Admin access required."});
    if(g.frozen) return res.status(423).json({success:false,message:"Group is frozen."});
    const count=Number((await pool.query("SELECT COUNT(*) FROM susu_group_members WHERE group_id=$1 AND status='Active'",[id])).rows[0].count);
    if(count>=Number(g.member_limit)) return res.status(400).json({success:false,message:"Group is full."});
    const digits=identifier.replace(/[^0-9]/g,"");
    const phoneCandidates=[identifier];
    if(/^\+?233\d{9}$/.test(digits)){ phoneCandidates.push("0"+digits.slice(3),digits); }
    else if(/^0\d{9}$/.test(digits)){ phoneCandidates.push("233"+digits.slice(1),"+"+"233"+digits.slice(1)); }
    const target=(await pool.query("SELECT id FROM customers WHERE phone = ANY($1::text[]) OR LOWER(email)=LOWER($2) LIMIT 1",[phoneCandidates,identifier])).rows[0];
    const code="DGM-SUSU-"+crypto.randomBytes(6).toString("hex").toUpperCase();
    await pool.query("INSERT INTO susu_group_invitations(group_id,inviter_customer_id,invited_customer_id,invited_identifier,invite_code) VALUES($1,$2,$3,$4,$5)",[id,req.session.customerId,target?.id||null,identifier,code]);
    if(target) await pool.query("INSERT INTO susu_group_notifications(group_id,customer_id,type,title,message,reference) VALUES($1,$2,'invitation','New Susu invitation',$3,$4)",[id,target.id,"You were invited to join "+g.name,code]);
    res.json({success:true,share_code:code,share_link:(process.env.BASE_URL||"https://dhe-genius-media.onrender.com")+"/susu.html?invite="+encodeURIComponent(code)});
  } catch(e){ console.error("Create Susu invitation:",e.message); res.status(500).json({success:false,message:"Could not create invitation."}); }
});
app.post("/api/susu/v2/invitations/:id/respond", requireLogin, async (req,res)=>{
  try {
    const id=Number(req.params.id);
    const i=(await pool.query("SELECT i.*,g.name,g.member_limit,g.frozen FROM susu_group_invitations i JOIN susu_groups g ON g.id=i.group_id WHERE i.id=$1",[id])).rows[0];
    if(!i) return res.status(404).json({success:false,message:"Invitation not found."});
    if(i.status!=="Pending") return res.status(400).json({success:false,message:"Invitation is no longer pending."});

    const customer=(await pool.query("SELECT id,phone,email,name FROM customers WHERE id=$1",[req.session.customerId])).rows[0];
    const normalized=(v)=>String(v||"").replace(/[^0-9]/g,"").replace(/^233/,"0");
    const targetMatches=Number(i.invited_customer_id)===Number(req.session.customerId) ||
      (!i.invited_customer_id && customer && (
        (customer.email && i.invited_identifier && String(customer.email).trim().toLowerCase()===String(i.invited_identifier).trim().toLowerCase()) ||
        (customer.phone && i.invited_identifier && normalized(customer.phone)===normalized(i.invited_identifier))
      ));
    if(!targetMatches) return res.status(403).json({success:false,message:"This invitation was not issued to this account."});

    if(i.frozen) return res.status(423).json({success:false,message:"Group is frozen."});
    const active=Number((await pool.query("SELECT COUNT(*) FROM susu_group_members WHERE group_id=$1 AND status='Active'",[i.group_id])).rows[0].count);
    if(active>=Number(i.member_limit)) return res.status(400).json({success:false,message:"Group is full."});

    await pool.query("INSERT INTO susu_group_members(group_id,customer_id,role,status,display_name,turn_order,joined_at) VALUES($1,$2,'Member','Pending',$3,COALESCE((SELECT MAX(turn_order)+1 FROM susu_group_members WHERE group_id=$1),1),NOW()) ON CONFLICT(group_id,customer_id) DO UPDATE SET status='Pending'",[i.group_id,req.session.customerId,customer?.name||"Member"]);
    await pool.query("UPDATE susu_group_invitations SET status='Accepted',invited_customer_id=$1,responded_at=NOW() WHERE id=$2",[req.session.customerId,i.id]);
    res.json({success:true,message:"Invitation accepted; waiting for group admin approval.",group_id:i.group_id});
  } catch(e){ console.error("Respond Susu invitation:",e.message); res.status(500).json({success:false,message:e.message||"Could not process invitation."}); }
});

// DGM Agent System
installAgent(app, {
  pool,
  requireCustomer: requireLogin,
  requireAdmin,
  getRetailPrice: async (network, capacity) => {
    try { await refreshDataMartPrices(); } catch {}
    const prices = DGM_PRICES[network];
    return prices ? Number(prices[capacity]) || 0 : 0;
  },
  fulfillDataOrder
});

// START SERVER
// =====================================================

async function startServer() {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`DHE GENIUS MEDIA HTTP listener active on port ${PORT}`);
    console.log(`Environment: ${NODE_ENV}`);
    console.log(`Database: ${DATABASE_URL ? "configured" : "MISSING"}`);
    console.log(`Paystack: ${PAYSTACK_SECRET_KEY ? "configured" : "MISSING"}`);
    console.log(`DataMart: ${DATAMART_API_KEY && DATAMART_API_SECRET && DATAMART_REF_PREFIX ? "configured" : "INCOMPLETE"}`);
    console.log(`DataMart reference prefix: ${DATAMART_REF_PREFIX || "MISSING"}`);
    console.log(`DataMart second secret: ${DATAMART_API_SECRET ? "configured" : "MISSING"}`);
  });

  try {
    await initDatabase();
    await staffInit;
    await initAgentDatabase(pool);
    databaseReady = true;
    await initSusuDatabase();
    await installSusuEnhancements(app);
    await initializeAdminCredentials();

    app.use("/api", (req, res) => {
      return res.status(404).json({
        success: false,
        message: "API endpoint not found."
      });
    });

    app.use((req, res) => {
      if (req.path.endsWith(".html") || req.path.includes(".")) {
        return res.status(404).send(
          "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"><title>Page Not Found</title></head>" +
          "<body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07110d;color:white;font-family:Arial,sans-serif;text-align:center;padding:20px;\"><div>" +
          "<h1 style=\"font-size:70px;margin:0;color:#25d366;\">404</h1><h2>Page Not Found</h2><p style=\"color:#aebdb5;\">The page you requested does not exist.</p>" +
          "<a href=\"/dashboard.html\" style=\"display:inline-block;padding:13px 22px;background:#25d366;color:#07110d;text-decoration:none;border-radius:10px;font-weight:bold;\">Back to Dashboard</a></div></body></html>"
        );
      }
      return res.redirect("/");
    });

    startupError = null;

    setTimeout(() => {
      syncPendingDataMartOrders();
      setInterval(syncPendingDataMartOrders, 15000);
      processAutomaticSavings();
      setInterval(processAutomaticSavings, 60000);
      syncKingflexyAirtimeOrders();
      setInterval(syncKingflexyAirtimeOrders, 20000);
    }, 5000);

    console.log("DHE GENIUS MEDIA application initialization complete.");
  } catch (error) {
    startupError = error;
    console.error("SERVER STARTUP FAILED:", error);
  }
}

startServer();
