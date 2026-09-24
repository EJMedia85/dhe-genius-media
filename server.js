const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);

// =====================================================
// ENVIRONMENT VARIABLES
// =====================================================

const NODE_ENV = process.env.NODE_ENV || "development";

const DATABASE_URL = process.env.DATABASE_URL || "";

const DATAMART_API_KEY =
  process.env.DATAMART_API_KEY || "";

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET || "dgm-change-this-secret";

const BASE_URL =
  process.env.BASE_URL ||
  "https://dhe-genius-media.onrender.com";

const DATAMART_STATUS_CHECKER_ENABLED =
  String(process.env.DATAMART_STATUS_CHECKER_ENABLED || "false")
    .toLowerCase() === "true";

// =====================================================
// APP CONFIG
// =====================================================

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================================================
// DATABASE
// =====================================================

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
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

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

// =====================================================
// DATABASE SETUP
// =====================================================

async function initDatabase() {
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL
        REFERENCES customers(id)
        ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      description TEXT,
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
  `);

  const columns = [
    ["datamart_purchase_id", "TEXT"],
    ["datamart_reference", "TEXT"],
    ["datamart_transaction_reference", "TEXT"],
    ["datamart_status", "TEXT"],
    ["capacity", "TEXT"],
    ["paystack_reference", "TEXT"],
    ["payment_status", "TEXT DEFAULT 'Pending'"],
    ["paid_at", "TIMESTAMPTZ"]
  ];

  for (const [column, definition] of columns) {
    await pool.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS ${column} ${definition}
    `);
  }

  console.log("Database initialized.");
}

// =====================================================
// POSTGRES SESSION STORE
// =====================================================

class PostgresSessionStore extends session.Store {
  async get(sid, callback) {
    try {
      const result = await pool.query(
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

      callback(null, result.rows[0].sess);
    } catch (error) {
      console.error("Session GET error:", error);
      callback(error);
    }
  }

  async set(sid, sess, callback) {
    try {
      const expire = new Date(
        Date.now() +
          ((sess.cookie && sess.cookie.maxAge) ||
            1000 * 60 * 60 * 24 * 7)
      );

      await pool.query(
        `
        INSERT INTO user_sessions (sid, sess, expire)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (sid)
        DO UPDATE SET
          sess = EXCLUDED.sess,
          expire = EXCLUDED.expire
        `,
        [sid, JSON.stringify(sess), expire]
      );

      if (callback) callback(null);
    } catch (error) {
      console.error("Session SET error:", error);

      if (callback) callback(error);
    }
  }

  async destroy(sid, callback) {
    try {
      await pool.query(
        `DELETE FROM user_sessions WHERE sid = $1`,
        [sid]
      );

      if (callback) callback(null);
    } catch (error) {
      console.error("Session DESTROY error:", error);

      if (callback) callback(error);
    }
  }

  async touch(sid, sess, callback) {
    try {
      const expire = new Date(
        Date.now() +
          ((sess.cookie && sess.cookie.maxAge) ||
            1000 * 60 * 60 * 24 * 7)
      );

      await pool.query(
        `
        UPDATE user_sessions
        SET expire = $2,
            sess = $3::jsonb
        WHERE sid = $1
        `,
        [sid, expire, JSON.stringify(sess)]
      );

      if (callback) callback(null);
    } catch (error) {
      console.error("Session TOUCH error:", error);

      if (callback) callback(error);
    }
  }
}

const sessionStore = new PostgresSessionStore();

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
      secure: NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7
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
  let phone = cleanPhone(value);

  if (phone.startsWith("+233")) {
    phone = "0" + phone.slice(4);
  }

  if (phone.startsWith("233")) {
    phone = "0" + phone.slice(3);
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
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

function createTransactionReference() {
  return (
    "TXN-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

async function requireLogin(req, res, next) {
  if (!req.session || !req.session.customerId) {
    return sendError(res, 401, "Please login to continue.");
  }

  next();
}

async function getCustomer(customerId) {
  const result = await pool.query(
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

  return result.rows[0] || null;
}

function publicCustomer(customer) {
  if (!customer) return null;

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    balance: Number(customer.balance || 0),
    created_at: customer.created_at
  };
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
  AirtelTigo: "AT_PREMIUM",
  Telecel: "TELECEL"
};

function normalizeCapacity(value) {
  const cleaned = String(value || "")
    .toUpperCase()
    .replace(/GB/g, "")
    .trim();

  const number = Number(cleaned);

  return Number.isFinite(number) ? number : null;
}

// =====================================================
// DATAMART
// =====================================================

const DATAMART_BASE =
  "https://api.datamartgh.shop/api";

const DATAMART_DEVELOPER_BASE =
  "https://api.datamartgh.shop/api/developer";

async function datamartRequest(baseUrl, endpoint, options = {}) {
  if (!DATAMART_API_KEY) {
    throw new Error("DATAMART_API_KEY is not configured.");
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 30000);

  try {
    const response = await fetch(
      `${baseUrl}${endpoint}`,
      {
        ...options,
        signal: controller.signal,

        headers: {
          "Content-Type": "application/json",
          "X-API-Key": DATAMART_API_KEY,
          ...(options.headers || {})
        }
      }
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        raw: text
      };
    }

    if (!response.ok) {
      throw new Error(
        `DataMart HTTP ${response.status}: ${
          data.message ||
          data.error ||
          text ||
          "Request failed"
        }`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function datamartPurchase(payload, idempotencyKey) {
  const body = JSON.stringify(payload);

  try {
    return await datamartRequest(
      DATAMART_BASE,
      "/purchase",
      {
        method: "POST",
        body,
        headers: {
          "X-Idempotency-Key": idempotencyKey
        }
      }
    );
  } catch (primaryError) {
    console.warn(
      "Primary DataMart purchase endpoint failed:",
      primaryError.message
    );

    return await datamartRequest(
      DATAMART_DEVELOPER_BASE,
      "/purchase",
      {
        method: "POST",
        body,
        headers: {
          "X-Idempotency-Key": idempotencyKey
        }
      }
    );
  }
}

async function fulfillDataOrder(order) {
  if (!order) {
    throw new Error("Order not found.");
  }

  if (
    String(order.payment_status || "").toLowerCase() !==
    "paid"
  ) {
    throw new Error("Order has not been paid.");
  }

  if (
    String(order.service || "").toLowerCase() !==
    "data"
  ) {
    return;
  }

  const capacity = normalizeCapacity(order.capacity);

  if (!order.network) {
    throw new Error("Network is missing.");
  }

  if (!validGhanaPhone(order.phone)) {
    throw new Error("Invalid Ghana phone number.");
  }

  if (!capacity) {
    throw new Error("Data capacity is missing.");
  }

  const datamartNetwork =
    NETWORK_MAP[order.network];

  if (!datamartNetwork) {
    throw new Error(
      `Unsupported network: ${order.network}`
    );
  }

  const payload = {
    phoneNumber: normalizeGhanaPhone(order.phone),
    network: datamartNetwork,
    capacity,
    gateway: "wallet"
  };

  const idempotencyKey =
    `dgm-${order.order_ref}`;

  try {
    const result = await datamartPurchase(
      payload,
      idempotencyKey
    );

    const purchaseId =
      result?.purchaseId ||
      result?.purchase_id ||
      result?.id ||
      null;

    const reference =
      result?.reference ||
      result?.orderReference ||
      result?.order_reference ||
      null;

    const transactionReference =
      result?.transactionReference ||
      result?.transaction_reference ||
      null;

    const externalStatus = String(
      result?.status ||
      result?.data?.status ||
      "processing"
    ).toLowerCase();

    let localStatus = "Processing";

    if (
      [
        "completed",
        "complete",
        "success",
        "successful"
      ].includes(externalStatus)
    ) {
      localStatus = "Completed";
    }

    if (
      [
        "failed",
        "failure",
        "refunded",
        "cancelled",
        "canceled"
      ].includes(externalStatus)
    ) {
      localStatus = "Failed";
    }

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
        externalStatus,
        localStatus,
        order.id
      ]
    );

    return {
      success: true,
      status: localStatus,
      datamart: result
    };
  } catch (error) {
    console.error(
      "DataMart fulfillment error:",
      error
    );

    await pool.query(
      `
      UPDATE orders
      SET
        datamart_status = $1,
        status = 'Processing'
      WHERE id = $2
      `,
      [
        `pending: ${error.message}`,
        order.id
      ]
    );

    return {
      success: false,
      status: "Processing",
      error: error.message
    };
  }
}

// =====================================================
// PAYSTACK WEBHOOK
// MUST COME BEFORE express.json()
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
        req.headers["x-paystack-signature"];

      if (!signature) {
        return res.sendStatus(401);
      }

      const rawBody = Buffer.isBuffer(req.body)
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
          Buffer.from(signature),
          Buffer.from(expectedSignature)
        );

      if (!valid) {
        return res.sendStatus(401);
      }

      const event =
        JSON.parse(rawBody.toString("utf8"));

      if (event.event !== "charge.success") {
        return res.sendStatus(200);
      }

      const reference =
        event?.data?.reference;

      if (!reference) {
        return res.sendStatus(200);
      }

      const result = await pool.query(
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

      const order = result.rows[0];

      const amountFromPaystack =
        Number(event?.data?.amount || 0) / 100;

      if (
        Math.round(amountFromPaystack * 100) !==
        Math.round(Number(order.amount) * 100)
      ) {
        console.error(
          "Paystack amount mismatch:",
          reference
        );

        return res.sendStatus(400);
      }

      const currency = String(
        event?.data?.currency || ""
      ).toUpperCase();

      if (currency !== "GHS") {
        return res.sendStatus(400);
      }

      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'Paid',
          paid_at = COALESCE(paid_at, NOW()),
          status =
            CASE
              WHEN status = 'Pending Payment'
              THEN 'Processing'
              ELSE status
            END
        WHERE id = $1
        `,
        [order.id]
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

      await fulfillDataOrder(
        updatedResult.rows[0]
      );

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
// AUTH - REGISTER
// =====================================================

app.post("/api/register", async (req, res) => {
  try {
    const name = String(
      req.body.name || ""
    ).trim();

    const phone =
      normalizeGhanaPhone(req.body.phone);

    const email =
      cleanEmail(req.body.email);

    const password =
      String(req.body.password || "");

    if (!name) {
      return sendError(
        res,
        400,
        "Please enter your name."
      );
    }

    if (!validGhanaPhone(phone)) {
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

    if (password.length < 6) {
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
        [phone, email]
      );

    if (existing.rows.length) {
      return sendError(
        res,
        409,
        "An account with that phone or email already exists."
      );
    }

    const hashedPassword =
      await bcrypt.hash(password, 12);

    const result =
      await pool.query(
        `
        INSERT INTO customers
          (name, phone, email, password)
        VALUES
          ($1, $2, $3, $4)
        RETURNING id, name, phone, email, balance, created_at
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
      (resolve, reject) => {
        req.session.regenerate(
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      }
    );

    req.session.customerId =
      customer.id;

    await new Promise(
      (resolve, reject) => {
        req.session.save(
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      }
    );

    return res.json({
      success: true,
      customer: publicCustomer(customer)
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
});

// =====================================================
// AUTH - LOGIN
// =====================================================

app.post("/api/login", async (req, res) => {
  try {
    const login =
      String(req.body.login || "")
        .trim();

    const password =
      String(req.body.password || "");

    if (!login || !password) {
      return sendError(
        res,
        400,
        "Enter your login details."
      );
    }

    const phone =
      normalizeGhanaPhone(login);

    const email =
      cleanEmail(login);

    const result =
      await pool.query(
        `
        SELECT *
        FROM customers
        WHERE phone = $1
           OR email = $2
        LIMIT 1
        `,
        [phone, email]
      );

    if (!result.rows.length) {
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
      (resolve, reject) => {
        req.session.regenerate(
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      }
    );

    req.session.customerId =
      customer.id;

    await new Promise(
      (resolve, reject) => {
        req.session.save(
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      }
    );

    return res.json({
      success: true,
      customer: publicCustomer(customer)
    });
  } catch (error) {
    console.error(
      "Login error:",
      error
    );

    return sendError(
      res,
      500,
      "Login failed."
    );
  }
});

// =====================================================
// AUTH - ME
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
        req.session.destroy(() => {});

        return sendError(
          res,
          401,
          "Account not found."
        );
      }

      return res.json({
        success: true,
        customer:
          publicCustomer(customer)
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
// AUTH - LOGOUT
// =====================================================

app.post(
  "/api/logout",
  (req, res) => {
    const destroySession = () => {
      res.clearCookie("dgm.sid", {
        httpOnly: true,
        secure: NODE_ENV === "production",
        sameSite: "lax",
        path: "/"
      });

      // Clear old session cookie too.
      res.clearCookie("connect.sid", {
        httpOnly: true,
        secure: NODE_ENV === "production",
        sameSite: "lax",
        path: "/"
      });

      return res.json({
        success: true
      });
    };

    if (!req.session) {
      return destroySession();
    }

    req.session.destroy((error) => {
      if (error) {
        console.error(
          "Logout error:",
          error
        );

        return res.status(500).json({
          success: false,
          message: "Logout failed."
        });
      }

      return destroySession();
    });
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
          req.body.service || "Data"
        ).trim();

      const network =
        String(
          req.body.network || ""
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

      if (!validGhanaPhone(phone)) {
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
        DGM_PRICES[network];

      if (!networkPrices) {
        return sendError(
          res,
          400,
          "Invalid network."
        );
      }

      const amount =
        networkPrices[capacity];

      if (
        typeof amount !== "number"
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
        order: result.rows[0]
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
// GET ORDERS
// =====================================================

app.get(
  "/api/orders",
  requireLogin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            id,
            order_ref,
            service,
            network,
            phone,
            amount,
            status,
            capacity,
            payment_status,
            paystack_reference,
            datamart_reference,
            datamart_transaction_reference,
            datamart_status,
            created_at,
            paid_at
          FROM orders
          WHERE customer_id = $1
          ORDER BY created_at DESC
          `,
          [req.session.customerId]
        );

      return res.json({
        success: true,
        orders: result.rows
      });
    } catch (error) {
      console.error(
        "Orders error:",
        error
      );

      return sendError(
        res,
        500,
        "Could not load orders."
      );
    }
  }
);

// =====================================================
// SINGLE ORDER
// =====================================================

app.get(
  "/api/orders/:orderRef",
  requireLogin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE order_ref = $1
            AND customer_id = $2
          LIMIT 1
          `,
          [
            req.params.orderRef,
            req.session.customerId
          ]
        );

      if (!result.rows.length) {
        return sendError(
          res,
          404,
          "Order not found."
        );
      }

      return res.json({
        success: true,
        order: result.rows[0]
      });
    } catch (error) {
      console.error(
        "Single order error:",
        error
      );

      return sendError(
        res,
        500,
        "Could not load order."
      );
    }
  }
);

// =====================================================
// PAYSTACK INITIALIZE
// =====================================================

app.post(
  "/api/payments/initialize",
  requireLogin,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return sendError(
          res,
          500,
          "Paystack is not configured."
        );
      }

      const orderRef =
        String(
          req.body.orderRef || ""
        ).trim();

      if (!orderRef) {
        return sendError(
          res,
          400,
          "Order reference is required."
        );
      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE order_ref = $1
            AND customer_id = $2
          LIMIT 1
          `,
          [
            orderRef,
            req.session.customerId
          ]
        );

      if (!result.rows.length) {
        return sendError(
          res,
          404,
          "Order not found."
        );
      }

      const order =
        result.rows[0];

      if (
        String(
          order.payment_status
        ).toLowerCase() === "paid"
      ) {
        return res.json({
          success: true,
          alreadyPaid: true,
          order
        });
      }

      const amountPesewas =
        Math.round(
          Number(order.amount) * 100
        );

      const callbackUrl =
        `${BASE_URL}/payment-success`;

      const paystackResponse =
        await fetch(
          "https://api.paystack.co/transaction/initialize",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              email:
                String(
                  (
                    await getCustomer(
                      req.session.customerId
                    )
                  )?.email || ""
                ),
              amount: amountPesewas,
              currency: "GHS",
              callback_url: callbackUrl,

              metadata: {
                order_ref:
                  order.order_ref,
                customer_id:
                  order.customer_id,
                service:
                  order.service
              }
            })
          }
        );

      const data =
        await paystackResponse.json();

      if (
        !paystackResponse.ok ||
        !data.status
      ) {
        console.error(
          "Paystack initialize failed:",
          data
        );

        return sendError(
          res,
          502,
          data.message ||
            "Could not initialize payment."
        );
      }

      const reference =
        data.data.reference;

      await pool.query(
        `
        UPDATE orders
        SET paystack_reference = $1
        WHERE id = $2
        `,
        [
          reference,
          order.id
        ]
      );

      return res.json({
        success: true,
        authorization_url:
          data.data.authorization_url,
        access_code:
          data.data.access_code,
        reference
      });
    } catch (error) {
      console.error(
        "Payment initialize error:",
        error
      );

      return sendError(
        res,
        500,
        "Payment initialization failed."
      );
    }
  }
);

// =====================================================
// PAYSTACK VERIFY
// =====================================================

app.get(
  "/api/payments/verify/:reference",
  requireLogin,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return sendError(
          res,
          500,
          "Paystack is not configured."
        );
      }

      const reference =
        String(
          req.params.reference || ""
        ).trim();

      const orderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE customer_id = $1
            AND (
              order_ref = $2
              OR paystack_reference = $2
            )
          LIMIT 1
          `,
          [
            req.session.customerId,
            reference
          ]
        );

      if (!orderResult.rows.length) {
        return sendError(
          res,
          404,
          "Payment order not found."
        );
      }

      let order =
        orderResult.rows[0];

      const verifyResponse =
        await fetch(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(
            reference
          )}`,
          {
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`
            }
          }
        );

      const data =
        await verifyResponse.json();

      if (
        !verifyResponse.ok ||
        !data.status
      ) {
        return sendError(
          res,
          502,
          data.message ||
            "Could not verify payment."
        );
      }

      const transaction =
        data.data;

      const paid =
        transaction.status ===
        "success";

      if (!paid) {
        return res.json({
          success: true,
          paid: false,
          status:
            transaction.status,
          order
        });
      }

      const amount =
        Number(transaction.amount || 0) /
        100;

      if (
        Math.round(amount * 100) !==
        Math.round(
          Number(order.amount) * 100
        )
      ) {
        return sendError(
          res,
          400,
          "Payment amount does not match the order."
        );
      }

      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'Paid',
          paid_at = COALESCE(paid_at, NOW()),
          paystack_reference = $1,
          status =
            CASE
              WHEN status = 'Pending Payment'
              THEN 'Processing'
              ELSE status
            END
        WHERE id = $2
        `,
        [
          transaction.reference,
          order.id
        ]
      );

      const updated =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE id = $1
          `,
          [order.id]
        );

      order =
        updated.rows[0];

      // Important:
      // Even if the webhook already marked the
      // order Paid, this makes sure an unfulfilled
      // order is sent to DataMart.
      if (
        String(order.payment_status)
          .toLowerCase() === "paid" &&
        String(order.service)
          .toLowerCase() === "data" &&
        !order.datamart_reference &&
        !order.datamart_purchase_id
      ) {
        await fulfillDataOrder(order);

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

      return res.json({
        success: true,
        paid: true,
        order
      });
    } catch (error) {
      console.error(
        "Payment verify error:",
        error
      );

      return sendError(
        res,
        500,
        "Payment verification failed."
      );
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
      const result =
        await pool.query(
          `
          SELECT
            id,
            type,
            amount,
            description,
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
        transactions:
          result.rows
      });
    } catch (error) {
      console.error(
        "Wallet transactions error:",
        error
      );

      return sendError(
        res,
        500,
        "Could not load wallet transactions."
      );
    }
  }
);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      success: true,
      service: "DHE GENIUS MEDIA",
      status: "online",
      database: "connected",
      datamart:
        DATAMART_API_KEY
          ? "configured"
          : "not configured",
      paystack:
        PAYSTACK_SECRET_KEY
          ? "configured"
          : "not configured"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      service: "DHE GENIUS MEDIA",
      status: "online",
      database: "error"
    });
  }
});

// =====================================================
// STATIC FILES
// =====================================================

const publicDir =
  path.join(__dirname, "public");

app.use(
  express.static(publicDir, {
    extensions: ["html"],
    index: false,
    redirect: false
  })
);

// =====================================================
// FRONTEND ROUTES
// IMPORTANT:
// service.html IS THE REAL FILE.
// We support both singular and plural URLs.
// =====================================================

function servePage(fileName) {
  return (req, res) => {
    res.sendFile(
      path.join(publicDir, fileName)
    );
  };
}

// Home
app.get(
  ["/", "/index.html"],
  servePage("index.html")
);

// Login
app.get(
  ["/login", "/login.html"],
  servePage("login.html")
);

// Register
app.get(
  ["/register", "/register.html"],
  servePage("register.html")
);

// Dashboard
app.get(
  ["/dashboard", "/dashboard.html"],
  servePage("dashboard.html")
);

// Data
app.get(
  [
    "/data",
    "/buy-data",
    "/data.html"
  ],
  servePage("data.html")
);

// Airtime
app.get(
  [
    "/airtime",
    "/airtime.html"
  ],
  servePage("airtime.html")
);

// Orders
app.get(
  [
    "/orders",
    "/orders.html"
  ],
  servePage("orders.html")
);

// Account
app.get(
  [
    "/account",
    "/account.html"
  ],
  servePage("account.html")
);

// More Services
// BOTH work:
app.get(
  [
    "/service",
    "/service.html",
    "/services",
    "/services.html"
  ],
  servePage("service.html")
);

// =====================================================
// API 404
// =====================================================

app.use("/api", (req, res) => {
  return res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

// =====================================================
// FRONTEND 404
// =====================================================

app.use((req, res) => {
  if (
    req.path.endsWith(".html") ||
    req.path.includes(".")
  ) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        >
        <title>Page Not Found - DHE GENIUS MEDIA</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: #07110d;
            color: #fff;
            font-family: Arial, sans-serif;
            padding: 24px;
            text-align: center;
          }

          .box {
            max-width: 430px;
          }

          h1 {
            font-size: 58px;
            margin: 0 0 10px;
          }

          p {
            color: #aab8b1;
            line-height: 1.6;
          }

          a {
            display: inline-block;
            margin-top: 18px;
            padding: 13px 20px;
            border-radius: 12px;
            background: #25d366;
            color: #06110b;
            text-decoration: none;
            font-weight: 800;
          }
        </style>
      </head>

      <body>
        <div class="box">
          <h1>404</h1>
          <h2>Page not found</h2>
          <p>
            The page you requested does not exist.
          </p>
          <a href="/dashboard.html">
            Back to Dashboard
          </a>
        </div>
      </body>
      </html>
    `);
  }

  return res.redirect("/");
});

// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(
        `DHE GENIUS MEDIA running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
}

startServer();
