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

const API_FOOTBALL_KEY =
  process.env.API_FOOTBALL_KEY || "";

const SPORTS_API_KEY =
  process.env.SPORTS_API_KEY ||
  API_FOOTBALL_KEY;

const SPORTS_API_BASE =
  "https://v3.football.api-sports.io";

// =====================================================
// APP CONFIG
// =====================================================

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");


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
    root.data && typeof root.data === "object" ? root.data :
    root.order && typeof root.order === "object" ? root.order : root;

  return {
    orderId: payload.order_id || root.order_id || null,
    reference: payload.reference || root.reference || null,
    status: payload.status || root.status || null,
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
      ON CONFLICT (reference) DO NOTHING
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
      parsed.orderId || parsed.reference || null,
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

  try {
    const data = await kingflexyRequest("/airtime/purchase", {
      method: "POST",
      body: JSON.stringify({
        network: order.network,
        beneficiary_phone: order.phone,
        amount: Number(order.amount),
        reference: order.order_ref
      })
    });

    const parsed = parseKingflexyOrder(data);
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
        parsed.orderId || parsed.reference || null,
        parsed.status || null,
        parsed.reason || data.message || null,
        order.id
      ]
    );

    return applyKingflexyStatus(order.id, data);
  } catch (error) {
    console.error(
      "KingFlexy airtime purchase error for " + order.order_ref + ":",
      error.message
    );

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
        String(error.message || "KingFlexy request failed.").slice(0,1000),
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
        const data = await kingflexyRequest(
          "/airtime/orders/" + encodeURIComponent(order.order_ref),
          { method: "GET" }
        );
        await applyKingflexyStatus(order.id, data);
      } catch (error) {
        const isNotFound =
          Number(error?.status || error?.data?.code || 0) === 404;

        if (isNotFound) {
          try {
            await refundAirtimeOrder(
              order.id,
              "KingFlexy could not find this airtime order reference. The DGM wallet payment has been refunded."
            );
            console.warn(
              "KINGFLEXY AIRTIME ORDER NOT FOUND — REFUNDED: " +
              order.order_ref
            );
          } catch (refundError) {
            console.error(
              "KingFlexy airtime 404 refund failed for " +
              order.order_ref + ": " + refundError.message
            );
          }
        } else {
          console.error(
            "KingFlexy airtime status check failed for " +
            order.order_ref + ": " + error.message
          );
        }
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

  const body =
    JSON.stringify(payload);

  let primaryError =
    null;

  try {

    return await datamartRequest(
      DATAMART_BASE,
      "/purchase",
      {
        method: "POST",

        body,

        headers: {
          "X-Idempotency-Key":
            idempotencyKey
        }
      }
    );

  } catch (error) {

    primaryError =
      error;

    console.warn(
      "Primary DataMart endpoint failed:",
      error.message
    );
  }

  try {

    return await datamartRequest(
      DATAMART_DEVELOPER_BASE,
      "/purchase",
      {
        method: "POST",

        body,

        headers: {
          "X-Idempotency-Key":
            idempotencyKey
        }
      }
    );

  } catch (developerError) {

    const combinedError =
      new Error(
        `DataMart purchase failed. Primary: ${
          primaryError?.message ||
          "unknown error"
        } | Developer: ${
          developerError?.message ||
          "unknown error"
        }`
      );

    combinedError.primaryError =
      primaryError;

    combinedError.developerError =
      developerError;

    combinedError.status =
      developerError.status ||
      primaryError?.status ||
      null;

    combinedError.data =
      developerError.data ||
      primaryError?.data ||
      null;

    throw combinedError;
  }
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

    const possibleStatuses = [
      data.orderStatus,
      data.order_status,
      data.status,
      data.order?.orderStatus,
      data.order?.order_status,
      data.order?.status,
      data.transaction?.status,
      data.transactionStatus,
      data.transaction_status
    ];

    const datamartStatus =
      possibleStatuses.find(
        value =>
          value !== undefined &&
          value !== null &&
          String(value).trim() !== ""
      );

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
// ADMIN AUTHENTICATION
// =====================================================

app.post("/api/admin/login", async (req, res) => {
  try {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) return sendError(res, 503, "Admin login is not configured. Add ADMIN_EMAIL and ADMIN_PASSWORD in Render.");
    const email = cleanEmail(req.body?.email || "");
    const password = String(req.body?.password || "");
    if (!email || !password) return sendError(res, 400, "Enter the admin email and password.");
    if (email !== ADMIN_EMAIL) {
      await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
      return sendError(res, 401, "Invalid admin login details.");
    }
    if (!await bcrypt.compare(password, ADMIN_PASSWORD_HASH)) return sendError(res, 401, "Invalid admin login details.");
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
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

app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, phone, email, balance, created_at FROM customers ORDER BY created_at DESC LIMIT 100");
    return res.json({ success: true, customers: result.rows });
  } catch (error) { console.error("Admin customers error:", error); return sendError(res, 500, "Could not load customers."); }
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
// LOGIN
// =====================================================

app.post(
  "/api/login",
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
