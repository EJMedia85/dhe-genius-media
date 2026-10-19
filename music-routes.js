const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const MUSIC_UPLOAD_DIR = String(process.env.MUSIC_UPLOAD_DIR || "").trim();
const AUDIO_TYPES = Object.freeze({
  "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".m4a",
  "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/wav": ".wav",
  "audio/x-wav": ".wav", "audio/flac": ".flac", "audio/x-flac": ".flac",
  "audio/webm": ".webm"
});
const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = MUSIC_UPLOAD_DIR || path.join(__dirname, "uploads", "music");
      fs.mkdir(dir, { recursive: true }, error => cb(error, dir));
    },
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + (AUDIO_TYPES[file.mimetype] || ".audio"))
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 8, fieldSize: 8192 },
  fileFilter: (req, file, cb) => cb(null, Boolean(AUDIO_TYPES[file.mimetype]))
});



const AUDIOMACK_API_BASE = String(process.env.AUDIOMACK_API_BASE || "https://api.audiomack.com/v1").trim().replace(/\\/$/, "");
function audiomackConfig() {
  return {
    consumerKey: String(process.env.AUDIOMACK_CONSUMER_KEY || "").trim(),
    consumerSecret: String(process.env.AUDIOMACK_CONSUMER_SECRET || "").trim(),
    searchPath: String(process.env.AUDIOMACK_SEARCH_PATH || "/search"),
    trendingPath: String(process.env.AUDIOMACK_TRENDING_PATH || "/music/trending"),
    recentPath: String(process.env.AUDIOMACK_RECENT_PATH || "/music/recent")
  };
}
function audiomackReady() {
  const c = audiomackConfig();
  return Boolean(c.consumerKey && c.consumerSecret);
}
function oauthEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
}
async function audiomackRequest(pathname, query = {}, method = "GET") {
  if (!audiomackReady()) throw Object.assign(new Error("Audiomack API credentials are not configured yet."), { code: "NOT_CONFIGURED" });
  const c = audiomackConfig();
  const url = new URL(pathname.replace(/^\\//, ""), AUDIOMACK_API_BASE + "/");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value) !== "") url.searchParams.set(key, String(value));
  }
  const oauth = {
    oauth_consumer_key: c.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0"
  };
  const pairs = [...url.searchParams.entries(), ...Object.entries(oauth)];
  pairs.sort((a, b) => oauthEncode(a[0]).localeCompare(oauthEncode(b[0])) || oauthEncode(a[1]).localeCompare(oauthEncode(b[1])));
  const normalized = pairs.map(([key, value]) => oauthEncode(key) + "=" + oauthEncode(value)).join("&");
  const baseString = method.toUpperCase() + "&" + oauthEncode(url.origin + url.pathname) + "&" + oauthEncode(normalized);
  oauth.oauth_signature = crypto.createHmac("sha1", oauthEncode(c.consumerSecret) + "&").update(baseString).digest("base64");
  const authorization = "OAuth " + Object.entries(oauth).map(([key, value]) => oauthEncode(key) + '="' + oauthEncode(value) + '"').join(", ");
  const response = await fetch(url, {
    method,
    headers: { Authorization: authorization, Accept: "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("Audiomack API request failed:", response.status, pathname);
    throw Object.assign(new Error(response.status === 401 || response.status === 403
      ? "Audiomack has not authorized these credentials for this endpoint."
      : "Audiomack could not complete the request right now."), { status: response.status });
  }
  return body;
}
function audiomackItems(payload) {
  const candidates = [payload?.results, payload?.data?.results, payload?.data, payload?.tracks, payload?.items, payload?.results?.results];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.items)) return value.items;
    if (value && Array.isArray(value.data)) return value.data;
  }
  return Array.isArray(payload) ? payload : [];
}
function normalizeAudiomackTrack(track) {
  const artist = track?.artist || track?.artist_name || track?.artistName || track?.user?.name || "";
  const title = track?.title || track?.name || track?.track_title || "Untitled track";
  const link = track?.url || track?.permalink || track?.link || track?.web_url || "";
  const id = track?.id ?? track?.uid ?? track?.slug ?? "";
  const artwork = track?.image || track?.cover_art || track?.cover || track?.thumbnail || track?.artwork_url || "";
  return {
    id: String(id),
    title: cleanText(title, 160),
    artist: cleanText(typeof artist === "string" ? artist : artist?.name || "", 120),
    artworkUrl: validHttpsUrl(artwork) ? artwork : null,
    audiomackUrl: validHttpsUrl(link) ? link : (typeof track?.slug === "string" ? "https://audiomack.com/" + track.slug.replace(/^\\/+/, "") : "https://audiomack.com"),
    duration: Number(track?.duration || 0) || null
  };
}
\nconst SPOTIFY_AUTHORIZE = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

function cleanText(value, max = 160) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}
function validHttpsUrl(value) {
  try { const u = new URL(String(value)); return u.protocol === "https:" && !u.username && !u.password; }
  catch { return false; }
}
function spotifyConfig() {
  return {
    clientId: String(process.env.SPOTIFY_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.SPOTIFY_CLIENT_SECRET || "").trim(),
    redirectUri: String(process.env.SPOTIFY_REDIRECT_URI || "").trim()
  };
}
function spotifyReady() {
  const c = spotifyConfig();
  return Boolean(c.clientId && c.clientSecret && c.redirectUri && validHttpsUrl(c.redirectUri));
}

async function installMusic(app, { pool, requireLogin, requireAdmin }) {
  const ensureTables = async () => {
    if (!pool) throw new Error("Database is not configured.");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dgm_music_tracks (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(160) NOT NULL,
        artist VARCHAR(120) NOT NULL,
        genre VARCHAR(80) NOT NULL DEFAULT '',
        audio_url TEXT NOT NULL,
        artwork_url TEXT,
        download_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        rights_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(24) NOT NULL DEFAULT 'pending',
        submitted_by BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      )
    `);
  };

  app.get("/music.html", (req, res) => res.sendFile(require("path").join(__dirname, "public", "music.html")));


  // Audiomack API proxy: credentials and OAuth 1.0a signatures stay server-side.
  app.get("/api/music/audiomack/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, configured: audiomackReady(), provider: "Audiomack", playback: "subject to Audiomack API access and streaming permissions" });
  });

  app.get("/api/music/audiomack/search", async (req, res) => {
    const q = cleanText(req.query.q, 100);
    if (!q) return res.status(400).json({ success: false, message: "Enter a song, artist, or genre to search." });
    try {
      const c = audiomackConfig();
      const data = await audiomackRequest(c.searchPath, { q, term: q, type: "music", limit: 20 });
      return res.set("Cache-Control", "private, max-age=60").json({ success: true, tracks: audiomackItems(data).map(normalizeAudiomackTrack).filter(t => t.title) });
    } catch (error) {
      const status = error.code === "NOT_CONFIGURED" ? 503 : (error.status === 401 || error.status === 403 ? 502 : 502);
      return res.status(status).json({ success: false, message: error.code === "NOT_CONFIGURED" ? "Audiomack access is waiting for approved API credentials." : error.message || "Audiomack search is temporarily unavailable." });
    }
  });

  app.get("/api/music/audiomack/trending", async (req, res) => {
    try {
      const c = audiomackConfig();
      const data = await audiomackRequest(c.trendingPath, { limit: 20 });
      return res.set("Cache-Control", "private, max-age=120").json({ success: true, tracks: audiomackItems(data).map(normalizeAudiomackTrack).filter(t => t.title) });
    } catch (error) {
      return res.status(error.code === "NOT_CONFIGURED" ? 503 : 502).json({ success: false, message: error.code === "NOT_CONFIGURED" ? "Audiomack access is waiting for approved API credentials." : error.message || "Audiomack trending music is temporarily unavailable." });
    }
  });

  app.get("/api/music/audiomack/recent", async (req, res) => {
    try {
      const c = audiomackConfig();
      const data = await audiomackRequest(c.recentPath, { limit: 20 });
      return res.set("Cache-Control", "private, max-age=120").json({ success: true, tracks: audiomackItems(data).map(normalizeAudiomackTrack).filter(t => t.title) });
    } catch (error) {
      return res.status(error.code === "NOT_CONFIGURED" ? 503 : 502).json({ success: false, message: error.code === "NOT_CONFIGURED" ? "Audiomack access is waiting for approved API credentials." : error.message || "Audiomack recent music is temporarily unavailable." });
    }
  });

  app.post("/api/music/audiomack/play/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return res.status(400).json({ success: false, message: "Invalid Audiomack track ID." });
    try {
      const data = await audiomackRequest("/music/" + encodeURIComponent(id) + "/playsession", {}, "POST");
      const candidate = data?.stream_url || data?.streamUrl || data?.url || data?.data?.stream_url || data?.data?.url;
      if (!validHttpsUrl(candidate)) return res.status(502).json({ success: false, message: "Audiomack did not return an authorized playable stream for this track. Open it on Audiomack instead." });
      return res.set("Cache-Control", "no-store").json({ success: true, streamUrl: candidate });
    } catch (error) {
      return res.status(error.code === "NOT_CONFIGURED" ? 503 : 502).json({ success: false, message: error.code === "NOT_CONFIGURED" ? "Audiomack access is waiting for approved API credentials." : error.message || "Audiomack playback is not available for this track." });
    }
  });
\n  app.get("/api/music/status", (req, res) => {
    const c = spotifyConfig();
    res.json({ success: true, spotifyConfigured: spotifyReady(), artistSubmissions: Boolean(pool), fileUploadsConfigured: Boolean(MUSIC_UPLOAD_DIR), maxUploadBytes: 25 * 1024 * 1024, streaming: "rights-cleared tracks only" });
  });

  app.get("/api/music/tracks", async (req, res) => {
    try {
      await ensureTables();
      const q = cleanText(req.query.q, 100);
      const result = await pool.query(
        `SELECT id, title, artist, genre, audio_url, artwork_url, download_allowed
         FROM dgm_music_tracks
         WHERE status = 'approved'
           AND ($1 = '' OR title ILIKE '%' || $1 || '%' OR artist ILIKE '%' || $1 || '%' OR genre ILIKE '%' || $1 || '%')
         ORDER BY created_at DESC LIMIT 100`, [q]
      );
      res.set("Cache-Control", "no-store");
      return res.json({ success: true, tracks: result.rows.map(t => ({
        id: t.id, title: t.title, artist: t.artist, genre: t.genre,
        audioUrl: t.audio_url, artworkUrl: t.artwork_url, downloadAllowed: t.download_allowed
      })) });
    } catch (error) {
      console.error("DGM Music catalog error:", error.message);
      return res.status(503).json({ success: false, message: "Music catalog is not available yet. Please try again later." });
    }
  });

  app.post("/api/music/artist-uploads", requireLogin, (req, res, next) => {
    if (!MUSIC_UPLOAD_DIR) return res.status(503).json({ success: false, message: "Secure audio storage is not configured yet. DGM must attach persistent storage and set MUSIC_UPLOAD_DIR before file uploads can be accepted." });
    next();
  }, (req, res, next) => musicUpload.single("audioFile")(req, res, error => {
    if (error) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({ success: false, message: tooLarge ? "Audio file must be 25 MB or smaller." : "Upload one supported audio file (MP3, M4A, AAC, OGG, WAV, FLAC, or WEBM)." });
    }
    if (req.file && !AUDIO_TYPES[req.file.mimetype]) {
      fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ success: false, message: "Unsupported audio format. Use MP3, M4A, AAC, OGG, WAV, FLAC, or WEBM." });
    }
    next();
  }), async (req, res) => {
    const uploaded = req.file;
    try {
      const title = cleanText(req.body?.title, 160);
      const artist = cleanText(req.body?.artist, 120);
      const genre = cleanText(req.body?.genre, 80);
      const artworkUrl = String(req.body?.artworkUrl || "").trim();
      const rights = req.body?.rightsConfirmed === "true" || req.body?.rightsConfirmed === "on";
      if (!uploaded) return res.status(400).json({ success: false, message: "Choose an audio file to upload." });
      if (!title || !artist || (artworkUrl && !validHttpsUrl(artworkUrl))) {
        await fs.promises.unlink(uploaded.path).catch(() => {});
        return res.status(400).json({ success: false, message: "Enter a title and artist; artwork URL must use HTTPS." });
      }
      if (!rights) {
        await fs.promises.unlink(uploaded.path).catch(() => {});
        return res.status(400).json({ success: false, message: "Confirm that you have rights to distribute this recording." });
      }
      await ensureTables();
      const audioUrl = "/api/music/audio/" + encodeURIComponent(path.basename(uploaded.filename));
      const result = await pool.query(
        `INSERT INTO dgm_music_tracks (title, artist, genre, audio_url, artwork_url, rights_confirmed, status, submitted_by)
         VALUES ($1,$2,$3,$4,$5,TRUE,'pending',$6) RETURNING id`,
        [title, artist, genre, audioUrl, artworkUrl || null, req.session?.customerId || null]
      );
      return res.status(201).json({ success: true, trackId: result.rows[0].id, message: "Audio uploaded securely and submitted for DGM review. It will appear after approval." });
    } catch (error) {
      if (uploaded?.path) await fs.promises.unlink(uploaded.path).catch(() => {});
      console.error("DGM Music audio upload error:", error.message);
      return res.status(503).json({ success: false, message: "Could not save the audio submission. Please try again." });
    }
  });

  app.get("/api/music/audio/:filename", async (req, res) => {
    const filename = String(req.params.filename || "");
    if (!/^[a-f0-9-]{36}\.(mp3|m4a|aac|ogg|wav|flac|webm)$/i.test(filename) || !MUSIC_UPLOAD_DIR) {
      return res.status(404).end();
    }
    try {
      await ensureTables();
      const audioUrl = "/api/music/audio/" + encodeURIComponent(filename);
      const found = await pool.query("SELECT title FROM dgm_music_tracks WHERE audio_url=$1 AND status='approved' LIMIT 1", [audioUrl]);
      if (!found.rows.length) return res.status(404).end();
      const fullPath = path.join(MUSIC_UPLOAD_DIR, filename);
      await fs.promises.access(fullPath, fs.constants.R_OK);
      res.set("Cache-Control", "public, max-age=3600");
      res.set("X-Content-Type-Options", "nosniff");
      return res.sendFile(fullPath, error => {
        if (error && !res.headersSent) res.status(error.statusCode || 404).end();
      });
    } catch (error) {
      if (error.code !== "ENOENT") console.error("DGM Music audio delivery error:", error.message);
      return res.status(404).end();
    }
  });

  app.post("/api/music/artist-submissions", requireLogin, async (req, res) => {
    try {
      const title = cleanText(req.body?.title, 160);
      const artist = cleanText(req.body?.artist, 120);
      const genre = cleanText(req.body?.genre, 80);
      const audioUrl = String(req.body?.audioUrl || "").trim();
      const artworkUrl = String(req.body?.artworkUrl || "").trim();
      if (!title || !artist || !validHttpsUrl(audioUrl) || (artworkUrl && !validHttpsUrl(artworkUrl))) {
        return res.status(400).json({ success: false, message: "Enter a title, artist, and valid HTTPS audio URL; artwork URL must also use HTTPS." });
      }
      if (req.body?.rightsConfirmed !== true && req.body?.rightsConfirmed !== "true" && req.body?.rightsConfirmed !== "on") {
        return res.status(400).json({ success: false, message: "Confirm that you have the rights to distribute this recording." });
      }
      await ensureTables();
      const customerId = req.session?.customerId;
      const result = await pool.query(
        `INSERT INTO dgm_music_tracks (title, artist, genre, audio_url, artwork_url, rights_confirmed, status, submitted_by)
         VALUES ($1,$2,$3,$4,$5,TRUE,'pending',$6) RETURNING id`,
        [title, artist, genre, audioUrl, artworkUrl || null, customerId || null]
      );
      return res.status(201).json({ success: true, trackId: result.rows[0].id, message: "Track submitted for DGM review. It will appear in the catalog only after approval." });
    } catch (error) {
      console.error("DGM Music artist submission error:", error.message);
      return res.status(503).json({ success: false, message: "Could not save the submission right now." });
    }
  });

  app.get("/api/admin/music/submissions", requireAdmin, async (req, res) => {
    try {
      await ensureTables();
      const result = await pool.query(
        "SELECT id, title, artist, genre, audio_url, artwork_url, rights_confirmed, submitted_by, created_at FROM dgm_music_tracks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100"
      );
      return res.json({ success: true, submissions: result.rows });
    } catch (error) {
      console.error("DGM Music admin list error:", error.message);
      return res.status(503).json({ success: false, message: "Could not load music submissions." });
    }
  });

  app.post("/api/admin/music/tracks/:id/review", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status || "").toLowerCase();
    const downloadAllowed = req.body?.downloadAllowed === true;
    if (!Number.isSafeInteger(id) || id <= 0 || !["approved", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Provide a valid track ID and approved/rejected status." });
    }
    try {
      await ensureTables();
      const result = await pool.query(
        "UPDATE dgm_music_tracks SET status = $1, download_allowed = $2, reviewed_at = NOW() WHERE id = $3 AND status = 'pending' RETURNING id, title, artist, status, download_allowed",
        [status, status === "approved" && downloadAllowed, id]
      );
      if (!result.rows.length) return res.status(404).json({ success: false, message: "Pending music submission not found." });
      return res.json({ success: true, track: result.rows[0] });
    } catch (error) {
      console.error("DGM Music review error:", error.message);
      return res.status(503).json({ success: false, message: "Could not review this submission right now." });
    }
  });

  app.get("/auth/spotify/start", (req, res) => {
    if (!spotifyReady()) return res.redirect("/music.html?spotify=not-configured");
    const state = crypto.randomBytes(24).toString("hex");
    req.session.spotifyOAuthState = state;
    const returnTo = String(req.query.returnTo || "/music.html");
    req.session.spotifyReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/music.html";
    const url = new URL(SPOTIFY_AUTHORIZE);
    url.searchParams.set("client_id", spotifyConfig().clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", spotifyConfig().redirectUri);
    url.searchParams.set("scope", "user-read-private user-read-email user-top-read playlist-read-private playlist-read-collaborative user-library-read");
    url.searchParams.set("state", state);
    return res.redirect(url.toString());
  });

  app.get("/auth/spotify/callback", async (req, res) => {
    const expected = String(req.session?.spotifyOAuthState || "");
    const supplied = String(req.query.state || "");
    delete req.session.spotifyOAuthState;
    const returnTo = String(req.session?.spotifyReturnTo || "/music.html");
    delete req.session.spotifyReturnTo;
    if (!expected || !supplied || expected.length !== supplied.length ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
      return res.redirect("/music.html?spotify=error");
    }
    if (req.query.error || !req.query.code || !spotifyReady()) {
      return res.redirect("/music.html?spotify=error");
    }
    try {
      const c = spotifyConfig();
      const response = await fetch(SPOTIFY_TOKEN, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(c.clientId + ":" + c.clientSecret).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code: String(req.query.code), redirect_uri: c.redirectUri }),
        signal: AbortSignal.timeout(10000)
      });
      const token = await response.json().catch(() => ({}));
      if (!response.ok || !token.access_token) {
        console.warn("Spotify OAuth token exchange failed with status", response.status);
        return res.redirect("/music.html?spotify=error");
      }
      // Keep Spotify tokens server-side in the DGM session; never expose client secret/token to browser JS.
      req.session.spotify = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        expiresAt: Date.now() + Math.max(0, Number(token.expires_in) || 0) * 1000
      };
      const profileResponse = await fetch(SPOTIFY_API + "/me", {
        headers: { Authorization: "Bearer " + token.access_token, Accept: "application/json" },
        signal: AbortSignal.timeout(10000)
      });
      if (profileResponse.ok) {
        const profile = await profileResponse.json();
        req.session.spotify.profile = { id: profile.id, displayName: profile.display_name || "", email: profile.email || null, image: profile.images?.[0]?.url || null };
      }
      return res.redirect((returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/music.html") + "?spotify=connected");
    } catch (error) {
      console.error("Spotify OAuth callback error:", error.message);
      return res.redirect("/music.html?spotify=error");
    }
  });


  app.get("/api/music/spotify/top-tracks", async (req, res) => {
    const spotify = req.session?.spotify;
    if (!spotify?.accessToken) {
      return res.status(401).json({ success: false, connected: false, message: "Connect Spotify first." });
    }
    try {
      const c = spotifyConfig();
      let accessToken = spotify.accessToken;
      // Refresh before expiry, keeping all Spotify credentials on the server.
      if (spotify.expiresAt && spotify.expiresAt < Date.now() + 60000) {
        if (!spotify.refreshToken || !c.clientId || !c.clientSecret) {
          delete req.session.spotify;
          return res.status(401).json({ success: false, connected: false, message: "Your Spotify session expired. Connect Spotify again." });
        }
        const refreshResponse = await fetch(SPOTIFY_TOKEN, {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(c.clientId + ":" + c.clientSecret).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
          },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: spotify.refreshToken }),
          signal: AbortSignal.timeout(10000)
        });
        const refreshed = await refreshResponse.json().catch(() => ({}));
        if (!refreshResponse.ok || !refreshed.access_token) {
          delete req.session.spotify;
          return res.status(401).json({ success: false, connected: false, message: "Spotify session expired. Connect Spotify again." });
        }
        accessToken = refreshed.access_token;
        req.session.spotify.accessToken = accessToken;
        req.session.spotify.expiresAt = Date.now() + Math.max(0, Number(refreshed.expires_in) || 3600) * 1000;
        if (refreshed.refresh_token) req.session.spotify.refreshToken = refreshed.refresh_token;
      }
      const response = await fetch(SPOTIFY_API + "/me/top/tracks?time_range=long_term&limit=5", {
        headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
        signal: AbortSignal.timeout(10000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        delete req.session.spotify;
        return res.status(401).json({ success: false, connected: false, message: "Spotify session expired. Connect Spotify again." });
      }
      if (!response.ok) {
        console.warn("Spotify top-tracks request failed with status", response.status);
        return res.status(response.status === 403 ? 403 : 502).json({
          success: false,
          message: response.status === 403
            ? "Spotify has not authorized top-track access for this account/app. Reconnect with the requested permission or check Spotify developer access."
            : "Spotify could not return your top tracks right now."
        });
      }
      const items = Array.isArray(data.items) ? data.items : [];
      return res.set("Cache-Control", "no-store").json({
        success: true,
        tracks: items.map(track => ({
          id: track.id,
          title: cleanText(track.name, 160),
          artist: (track.artists || []).map(artist => cleanText(artist.name, 120)).join(", "),
          album: cleanText(track.album?.name, 160),
          artworkUrl: track.album?.images?.[0]?.url || null,
          spotifyUrl: track.external_urls?.spotify || null
        }))
      });
    } catch (error) {
      console.error("Spotify top-tracks error:", error.message);
      return res.status(502).json({ success: false, message: "Could not contact Spotify right now. Please try again." });
    }
  });

  app.get("/api/music/spotify/me", async (req, res) => {
    if (!req.session?.spotify?.accessToken) return res.status(401).json({ success: false, connected: false, message: "Spotify is not connected." });
    return res.json({ success: true, connected: true, profile: req.session.spotify.profile || null });
  });
}

module.exports = { installMusic };
