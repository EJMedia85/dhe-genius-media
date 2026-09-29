const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

module.exports = function installAviatorApi(app) {
  app.use(express.json({ limit: "1mb" }));
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "",
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    max: 3
  });

  const INGEST_KEY = String(
    process.env.AVIATOR_INGEST_KEY || process.env.DGM_API_KEY || ""
  ).trim();

  let schemaReady = null;

  async function ensureSchema() {
    if (schemaReady) return schemaReady;
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not configured.");
    }
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS aviator_rounds (
        id BIGSERIAL PRIMARY KEY,
        round_id VARCHAR(180),
        multiplier NUMERIC(12,4) NOT NULL CHECK (multiplier >= 1),
        source VARCHAR(80) NOT NULL DEFAULT 'manual',
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(source, round_id)
      );
      CREATE INDEX IF NOT EXISTS aviator_rounds_observed_idx
        ON aviator_rounds(observed_at DESC);
    `).catch(error => {
      schemaReady = null;
      throw error;
    });
    return schemaReady;
  }

  function authorized(req) {
    if (!INGEST_KEY) return false;
    const supplied = String(req.get("X-Aviator-Ingest-Key") || "").trim();
    const bearer = String(req.get("Authorization") || "");
    const token = supplied || (bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "");
    if (!token || token.length !== INGEST_KEY.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(INGEST_KEY));
  }

  app.get("/api/aviator/status", async (req, res) => {
    try {
      await ensureSchema();
      const r = await pool.query(`
        SELECT COUNT(*)::int AS rounds,
               MAX(observed_at) AS latest
        FROM aviator_rounds
      `);
      res.json({
        success: true,
        provider: "DGM Aviator Analytics",
        ingestion_configured: Boolean(INGEST_KEY),
        rounds: Number(r.rows[0]?.rounds || 0),
        latest: r.rows[0]?.latest || null,
        server_time: new Date().toISOString()
      });
    } catch (error) {
      console.error("Aviator status error:", error.message);
      res.status(503).json({ success: false, message: "Aviator storage is unavailable." });
    }
  });

  app.get("/api/aviator/rounds", async (req, res) => {
    try {
      await ensureSchema();
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 5000);
      const r = await pool.query(`
        SELECT id, round_id, multiplier::float AS multiplier, source,
               observed_at, created_at
        FROM aviator_rounds
        ORDER BY observed_at DESC, id DESC
        LIMIT $1
      `, [limit]);
      res.json({
        success: true,
        count: r.rows.length,
        rounds: r.rows
      });
    } catch (error) {
      console.error("Aviator rounds error:", error.message);
      res.status(503).json({ success: false, message: "Could not load Aviator rounds." });
    }
  });

  app.post("/api/aviator/ingest", async (req, res) => {
    try {
      if (!authorized(req)) {
        return res.status(401).json({
          success: false,
          message: "Valid Aviator ingestion key required."
        });
      }

      await ensureSchema();

      const payload = Array.isArray(req.body) ? req.body : [req.body];
      if (payload.length > 500) {
        return res.status(400).json({ success: false, message: "Maximum 500 rounds per request." });
      }

      const client = await pool.connect();
      let stored = 0;
      let duplicates = 0;

      try {
        await client.query("BEGIN");
        for (const item of payload) {
          const multiplier = Number(item?.multiplier);
          if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 1000000) continue;

          const roundId = String(item?.round_id || "").trim().slice(0, 180) || null;
          const source = String(item?.source || "external_feed").trim().slice(0, 80) || "external_feed";
          const observed = item?.observed_at ? new Date(item.observed_at) : new Date();
          const observedAt = Number.isNaN(observed.getTime()) ? new Date() : observed;

          const result = await client.query(`
            INSERT INTO aviator_rounds(round_id, multiplier, source, observed_at)
            VALUES($1,$2,$3,$4)
            ON CONFLICT(source, round_id) DO NOTHING
            RETURNING id
          `, [roundId, multiplier, source, observedAt]);

          if (result.rows.length) stored++;
          else if (roundId) duplicates++;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      res.status(201).json({
        success: true,
        received: payload.length,
        stored,
        duplicates
      });
    } catch (error) {
      console.error("Aviator ingest error:", error.message);
      res.status(500).json({ success: false, message: "Could not ingest Aviator rounds." });
    }
  });
};
