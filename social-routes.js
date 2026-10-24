const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const CATEGORIES = new Set(["news", "memes", "wallpapers", "announcements"]);

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeCategory(value) {
  // Accept canonical values and human-readable labels (including singular forms).
  // Strip separators and punctuation so "Wallpaper", "wallpapers", and
  // "🖼️ Wallpapers" all resolve to the same database-safe category.
  const category = cleanText(value, 80).toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases = new Map([
    ["news", "news"], ["dgmnews", "news"], ["updates", "news"],
    ["meme", "memes"], ["memes", "memes"], ["funny", "memes"],
    ["wallpaper", "wallpapers"], ["wallpapers", "wallpapers"],
    ["announcement", "announcements"], ["announcements", "announcements"],
    ["dgmannouncement", "announcements"], ["dgmannouncements", "announcements"],
    ["dgmupdate", "announcements"], ["dgmupdates", "announcements"]
  ]);
  return aliases.get(category) || category;
}
function safeHttpsUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function installSocial(app, { pool, requireLogin, requireAdmin }) {
  let readyPromise;
  async function ensureTables() {
    if (!pool) throw new Error("Database is not configured.");
    if (!readyPromise) {
      readyPromise = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS dgm_social_posts (
            id BIGSERIAL PRIMARY KEY,
            category VARCHAR(24) NOT NULL CHECK (category IN ('news','memes','wallpapers','announcements')),
            title VARCHAR(140) NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            image_url TEXT NOT NULL DEFAULT '',
            media_type VARCHAR(12) NOT NULL DEFAULT 'image',
            wallpaper_url TEXT NOT NULL DEFAULT '',
            published BOOLEAN NOT NULL DEFAULT FALSE,
            pinned BOOLEAN NOT NULL DEFAULT FALSE,
            created_by TEXT NOT NULL DEFAULT 'DGM Admin',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS dgm_social_likes (
            post_id BIGINT NOT NULL REFERENCES dgm_social_posts(id) ON DELETE CASCADE,
            customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(post_id, customer_id)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS dgm_social_saves (
            post_id BIGINT NOT NULL REFERENCES dgm_social_posts(id) ON DELETE CASCADE,
            customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(post_id, customer_id)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS dgm_social_comments (
            id BIGSERIAL PRIMARY KEY,
            post_id BIGINT NOT NULL REFERENCES dgm_social_posts(id) ON DELETE CASCADE,
            customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            body VARCHAR(600) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await pool.query("ALTER TABLE dgm_social_posts ADD COLUMN IF NOT EXISTS media_type VARCHAR(12) NOT NULL DEFAULT 'image'");
        await pool.query("CREATE INDEX IF NOT EXISTS dgm_social_posts_feed_idx ON dgm_social_posts(published, pinned DESC, created_at DESC)");
        await pool.query("CREATE INDEX IF NOT EXISTS dgm_social_comments_post_idx ON dgm_social_comments(post_id, created_at)");
      })().catch(error => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  const sendFailure = (res, status, message) => res.status(status).json({ success: false, message });


  const socialUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) return callback(null, true);
      return callback(new Error("Choose an image or video file."));
    }
  });
  app.post("/api/admin/social/upload", requireAdmin, (req, res, next) => {
    socialUpload.single("media")(req, res, error => {
      if (error) return sendFailure(res, error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
        error.code === "LIMIT_FILE_SIZE" ? "Media must be 100 MB or smaller." : error.message || "Unable to read that file.");
      next();
    });
  }, async (req, res) => {
    const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
    const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
    const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
    if (!cloudName || !apiKey || !apiSecret) return sendFailure(res, 503, "Gallery uploads are not configured yet. DGM admin must configure the secure media storage keys.");
    if (!req.file) return sendFailure(res, 400, "Choose a photo or video from your gallery first.");
    const isVideo = req.file.mimetype.startsWith("video/");
    const resourceType = isVideo ? "video" : "image";
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = "dgm-social";
    const signature = crypto.createHash("sha1").update("folder=" + folder + "&timestamp=" + timestamp + apiSecret).digest("hex");
    try {
      const form = new FormData();
      form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || ("dgm-social." + (isVideo ? "mp4" : "jpg")));
      form.append("api_key", apiKey);
      form.append("timestamp", String(timestamp));
      form.append("folder", folder);
      form.append("signature", signature);
      const response = await fetch("https://api.cloudinary.com/v1_1/" + encodeURIComponent(cloudName) + "/" + resourceType + "/upload", { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.secure_url) {
        console.error("DGM Social media upload failed:", result.error?.message || response.status);
        return sendFailure(res, 502, "The media upload failed. Check the file and try again.");
      }
      return res.status(201).json({ success: true, url: result.secure_url, media_type: resourceType });
    } catch (error) {
      console.error("DGM Social upload error:", error.message);
      return sendFailure(res, 502, "Media storage could not be reached. Please try again.");
    }
  });

  app.get("/api/social/posts", requireLogin, async (req, res) => {
    try {
      await ensureTables();
      const category = String(req.query.category || "").trim().toLowerCase();
      if (category && !CATEGORIES.has(category)) return sendFailure(res, 400, "Invalid social feed category.");
      const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 30));
      const offset = Math.min(10000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
      const result = await pool.query(`
        SELECT p.id, p.category, p.title, p.body, p.image_url, p.media_type, p.wallpaper_url,
               p.pinned, p.created_at, p.updated_at,
               (SELECT COUNT(*)::int FROM dgm_social_likes l WHERE l.post_id=p.id) AS like_count,
               (SELECT COUNT(*)::int FROM dgm_social_comments c WHERE c.post_id=p.id) AS comment_count,
               (SELECT COUNT(*)::int FROM dgm_social_saves s WHERE s.post_id=p.id) AS save_count,
               EXISTS(SELECT 1 FROM dgm_social_likes l WHERE l.post_id=p.id AND l.customer_id=$1) AS liked,
               EXISTS(SELECT 1 FROM dgm_social_saves s WHERE s.post_id=p.id AND s.customer_id=$1) AS saved
        FROM dgm_social_posts p
        WHERE p.published=TRUE AND ($2::text='' OR p.category=$2)
        ORDER BY p.pinned DESC, p.created_at DESC
        LIMIT $3 OFFSET $4
      `, [req.session.customerId, category, limit, offset]);
      res.set("Cache-Control", "no-store");
      return res.json({ success: true, posts: result.rows });
    } catch (error) {
      console.error("DGM Social feed error:", error.message);
      return sendFailure(res, 500, "The social feed is temporarily unavailable.");
    }
  });

  app.get("/api/social/posts/:id/comments", requireLogin, async (req, res) => {
    const postId = parseId(req.params.id);
    if (!postId) return sendFailure(res, 400, "Invalid post.");
    try {
      await ensureTables();
      const post = await pool.query("SELECT id FROM dgm_social_posts WHERE id=$1 AND published=TRUE", [postId]);
      if (!post.rowCount) return sendFailure(res, 404, "Post not found.");
      const result = await pool.query(`
        SELECT c.id, c.body, c.created_at, COALESCE(NULLIF(TRIM(u.name),''),'DGM Customer') AS customer_name,
               (c.customer_id=$2) AS mine
        FROM dgm_social_comments c
        JOIN customers u ON u.id=c.customer_id
        WHERE c.post_id=$1
        ORDER BY c.created_at ASC
        LIMIT 100
      `, [postId, req.session.customerId]);
      return res.json({ success: true, comments: result.rows });
    } catch (error) {
      console.error("DGM Social comments read error:", error.message);
      return sendFailure(res, 500, "Comments are temporarily unavailable.");
    }
  });

  app.post("/api/social/posts/:id/like", requireLogin, async (req, res) => {
    const postId = parseId(req.params.id);
    if (!postId) return sendFailure(res, 400, "Invalid post.");
    try {
      await ensureTables();
      const post = await pool.query("SELECT id FROM dgm_social_posts WHERE id=$1 AND published=TRUE", [postId]);
      if (!post.rowCount) return sendFailure(res, 404, "Post not found.");
      const inserted = await pool.query(
        "INSERT INTO dgm_social_likes(post_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING post_id",
        [postId, req.session.customerId]
      );
      let liked = inserted.rowCount > 0;
      if (!liked) {
        await pool.query("DELETE FROM dgm_social_likes WHERE post_id=$1 AND customer_id=$2", [postId, req.session.customerId]);
        liked = false;
      }
      const count = await pool.query("SELECT COUNT(*)::int AS count FROM dgm_social_likes WHERE post_id=$1", [postId]);
      return res.json({ success: true, liked, like_count: count.rows[0].count });
    } catch (error) {
      console.error("DGM Social like error:", error.message);
      return sendFailure(res, 500, "Unable to update your like right now.");
    }
  });

  app.post("/api/social/posts/:id/save", requireLogin, async (req, res) => {
    const postId = parseId(req.params.id);
    if (!postId) return sendFailure(res, 400, "Invalid post.");
    try {
      await ensureTables();
      const post = await pool.query("SELECT id FROM dgm_social_posts WHERE id=$1 AND published=TRUE", [postId]);
      if (!post.rowCount) return sendFailure(res, 404, "Post not found.");
      const inserted = await pool.query(
        "INSERT INTO dgm_social_saves(post_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING post_id",
        [postId, req.session.customerId]
      );
      let saved = inserted.rowCount > 0;
      if (!saved) {
        await pool.query("DELETE FROM dgm_social_saves WHERE post_id=$1 AND customer_id=$2", [postId, req.session.customerId]);
        saved = false;
      }
      return res.json({ success: true, saved });
    } catch (error) {
      console.error("DGM Social save error:", error.message);
      return sendFailure(res, 500, "Unable to update your saved posts right now.");
    }
  });

  app.post("/api/social/posts/:id/comments", requireLogin, async (req, res) => {
    const postId = parseId(req.params.id);
    const body = cleanText(req.body?.body, 600);
    if (!postId) return sendFailure(res, 400, "Invalid post.");
    if (!body) return sendFailure(res, 400, "Write a comment first.");
    if (body.length > 600) return sendFailure(res, 400, "Comments must be 600 characters or fewer.");
    try {
      await ensureTables();
      const post = await pool.query("SELECT id FROM dgm_social_posts WHERE id=$1 AND published=TRUE", [postId]);
      if (!post.rowCount) return sendFailure(res, 404, "Post not found.");
      const result = await pool.query(
        "INSERT INTO dgm_social_comments(post_id,customer_id,body) VALUES($1,$2,$3) RETURNING id,body,created_at",
        [postId, req.session.customerId, body]
      );
      const customer = await pool.query("SELECT COALESCE(NULLIF(TRIM(name),''),'DGM Customer') AS name FROM customers WHERE id=$1", [req.session.customerId]);
      return res.status(201).json({ success: true, comment: { ...result.rows[0], customer_name: customer.rows[0]?.name || "DGM Customer", mine: true } });
    } catch (error) {
      console.error("DGM Social comment create error:", error.message);
      return sendFailure(res, 500, "Unable to post your comment right now.");
    }
  });

  app.get("/api/admin/social/posts", requireAdmin, async (req, res) => {
    try {
      await ensureTables();
      const result = await pool.query(`
        SELECT p.*,
          (SELECT COUNT(*)::int FROM dgm_social_likes l WHERE l.post_id=p.id) AS like_count,
          (SELECT COUNT(*)::int FROM dgm_social_comments c WHERE c.post_id=p.id) AS comment_count,
          (SELECT COUNT(*)::int FROM dgm_social_saves s WHERE s.post_id=p.id) AS save_count
        FROM dgm_social_posts p
        ORDER BY p.created_at DESC
        LIMIT 200
      `);
      return res.json({ success: true, posts: result.rows });
    } catch (error) {
      console.error("DGM Social admin list error:", error.message);
      return sendFailure(res, 500, "Unable to load social posts.");
    }
  });

  app.post("/api/admin/social/posts", requireAdmin, async (req, res) => {
    // Some mobile browsers/proxies can omit the select value in the submitted JSON.
    // The wallpaper URL field is only shown for the Wallpapers category, so use it
    // as a safe fallback when the category value is missing or unrecognized.
    const submittedCategory = normalizeCategory(req.body?.category ?? req.body?.category_key ?? req.body?.post_category);
    const hasUploadedImage = Boolean(String(req.body?.image_url || "").trim());
    const hasWallpaperLink = Boolean(String(req.body?.wallpaper_url || "").trim());
    const category = CATEGORIES.has(submittedCategory)
      ? submittedCategory
      : (hasWallpaperLink || (hasUploadedImage && String(req.body?.media_type || "image").toLowerCase() === "image")
        ? "wallpapers"
        : "wallpapers");
    const title = cleanText(req.body?.title, 140);
    const body = cleanText(req.body?.body, 3000);
    const imageInput = String(req.body?.image_url || "").trim();
    const mediaType = cleanText(req.body?.media_type || "image", 12).toLowerCase();
    const wallpaperInput = String(req.body?.wallpaper_url || "").trim();
    const imageUrl = safeHttpsUrl(imageInput);
    const wallpaperUrl = safeHttpsUrl(wallpaperInput);
    const published = req.body?.published === true || req.body?.published === "true";
    const pinned = req.body?.pinned === true || req.body?.pinned === "true";
    if (!CATEGORIES.has(category)) return sendFailure(res, 400, "Choose a valid category.");
    if (!["image", "video"].includes(mediaType)) return sendFailure(res, 400, "Unsupported media type.");
    if (!title) return sendFailure(res, 400, "Post title is required.");
    if (body.length > 3000) return sendFailure(res, 400, "Post text is too long.");
    if (imageUrl === null || wallpaperUrl === null) return sendFailure(res, 400, "Image and wallpaper links must be valid HTTPS URLs.");
    if (category === "wallpapers" && !imageUrl && !wallpaperUrl) return sendFailure(res, 400, "Upload an image or add a wallpaper link.");
    if (mediaType === "video" && category === "wallpapers") return sendFailure(res, 400, "Choose the News, Meme or DGM Announcement category for a video.");
    try {
      await ensureTables();
      const createdBy = cleanText(req.session.adminEmail || req.session.admin?.email || "DGM Admin", 160) || "DGM Admin";
      const result = await pool.query(`
        INSERT INTO dgm_social_posts(category,title,body,image_url,media_type,wallpaper_url,published,pinned,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `, [category, title, body, imageUrl, mediaType, wallpaperUrl, published, pinned, createdBy]);
      return res.status(201).json({ success: true, post: result.rows[0] });
    } catch (error) {
      console.error("DGM Social admin create error:", error.message);
      return sendFailure(res, 500, "Unable to create the post.");
    }
  });

  app.patch("/api/admin/social/posts/:id", requireAdmin, async (req, res) => {
    const postId = parseId(req.params.id);
    if (!postId) return sendFailure(res, 400, "Invalid post.");
    const hasPublished = Object.prototype.hasOwnProperty.call(req.body || {}, "published");
    const hasPinned = Object.prototype.hasOwnProperty.call(req.body || {}, "pinned");
    if (!hasPublished && !hasPinned) return sendFailure(res, 400, "No supported post setting was provided.");
    try {
      await ensureTables();
      const result = await pool.query(`
        UPDATE dgm_social_posts
        SET published=CASE WHEN $2::boolean IS NULL THEN published ELSE $2::boolean END,
            pinned=CASE WHEN $3::boolean IS NULL THEN pinned ELSE $3::boolean END,
            updated_at=NOW()
        WHERE id=$1
        RETURNING *
      `, [postId, hasPublished ? req.body.published === true || req.body.published === "true" : null,
          hasPinned ? req.body.pinned === true || req.body.pinned === "true" : null]);
      if (!result.rowCount) return sendFailure(res, 404, "Post not found.");
      return res.json({ success: true, post: result.rows[0] });
    } catch (error) {
      console.error("DGM Social admin update error:", error.message);
      return sendFailure(res, 500, "Unable to update the post.");
    }
  });

  app.delete("/api/admin/social/posts/:id", requireAdmin, async (req, res) => {
    const postId = parseId(req.params.id);
    if (!postId) return sendFailure(res, 400, "Invalid post.");
    try {
      await ensureTables();
      const result = await pool.query("DELETE FROM dgm_social_posts WHERE id=$1 RETURNING id", [postId]);
      if (!result.rowCount) return sendFailure(res, 404, "Post not found.");
      return res.json({ success: true });
    } catch (error) {
      console.error("DGM Social admin delete error:", error.message);
      return sendFailure(res, 500, "Unable to delete the post.");
    }
  });

  app.get("/api/admin/social/posts/:id/comments", requireAdmin, async (req, res) => {
    const postId = parseId(req.params.id);
    if (!postId) return sendFailure(res, 400, "Invalid post.");
    try {
      await ensureTables();
      const result = await pool.query(`
        SELECT c.id, c.body, c.created_at, COALESCE(NULLIF(TRIM(u.name),''),'DGM Customer') AS customer_name
        FROM dgm_social_comments c JOIN customers u ON u.id=c.customer_id
        WHERE c.post_id=$1 ORDER BY c.created_at DESC LIMIT 100
      `, [postId]);
      return res.json({ success: true, comments: result.rows });
    } catch (error) {
      console.error("DGM Social admin comments error:", error.message);
      return sendFailure(res, 500, "Unable to load comments.");
    }
  });

  app.delete("/api/admin/social/comments/:id", requireAdmin, async (req, res) => {
    const commentId = parseId(req.params.id);
    if (!commentId) return sendFailure(res, 400, "Invalid comment.");
    try {
      await ensureTables();
      const result = await pool.query("DELETE FROM dgm_social_comments WHERE id=$1 RETURNING id", [commentId]);
      if (!result.rowCount) return sendFailure(res, 404, "Comment not found.");
      return res.json({ success: true });
    } catch (error) {
      console.error("DGM Social admin comment delete error:", error.message);
      return sendFailure(res, 500, "Unable to delete the comment.");
    }
  });
}

module.exports = { installSocial };
