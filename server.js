const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const NODE_ENV =
  process.env.NODE_ENV || "development";

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const DATAMART_API_KEY =
  process.env.DATAMART_API_KEY || "";

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "dgm-change-this-secret";

const BASE_URL =
  process.env.BASE_URL ||
  "https://dhe-genius-media.onrender.com";

const DATAMART_STATUS_CHECKER_ENABLED =
  String(
    process.env.DATAMART_STATUS_CHECKER_ENABLED ||
      "false"
  ).toLowerCase() === "true";

// =====================================================
// SECURITY / PROXY
// =====================================================

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

if (
  NODE_ENV === "production" &&
  SESSION_SECRET === "dgm-change-this-secret"
) {
  console.error(
    "SESSION_SECRET must be changed in production."
  );
  process.exit(1);
}

// =====================================================
// DATAMART
// =====================================================

const DATAMART_BASE =
  "https://api.datamartgh.shop/api";

const DATAMART_DEVELOPER_BASE =
  "https://api.datamartgh.shop/api/developer";

// =====================================================
// DATABASE
// =====================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    NODE_ENV === "production"
      ? {
          rejectUnauthorized: false
        }
      : false
});

pool.on("error", (error) => {
  console.error(
    "POSTGRES POOL ERROR:",
    error
  );
});

// =====================================================
// HELPERS
// =====================================================

function cleanPhone(phone) {
  return String(phone || "")
    .trim()
    .replace(/\s+/g, "");
}

function normalizeGhanaPhone(phone) {
  let value = cleanPhone(phone);

  if (/^\+233\d{9}$/.test(value)) {
    value = "0" + value.slice(4);
  }

  return value;
}

function validGhanaPhone(phone) {
  const value =
    normalizeGhanaPhone(phone);

  return /^0\d{9}$/.test(value);
}

function cleanEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function createOrderReference() {
  return (
    "DGM-" +
    Date.now() +
    "-" +
    crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase()
  );
}

function createTransactionReference() {
  return (
    "DGM-TXN-" +
    Date.now() +
    "-" +
    crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase()
  );
}

function requireLogin(req, res, next) {
  if (!req.session.customerId) {
    return res.status(401).json({
      success: false,
      error: "Please log in first."
    });
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
    LIMIT 1
    `,
    [customerId]
  );

  return result.rows[0] || null;
}

function publicCustomer(customer) {
  if (!customer) {
    return null;
  }

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    balance: Number(
      customer.balance || 0
    ),
    created_at:
      customer.created_at
  };
}

function sendError(
  res,
  status,
  message
) {
  return res.status(status).json({
    success: false,
    error: message
  });
}

// =====================================================
// NETWORK MAPPING
// =====================================================

const networkMap = {
  MTN: "YELLO",
  AirtelTigo: "AT_PREMIUM",
  Telecel: "TELECEL"
};

// =====================================================
// DGM SERVER-SIDE DATA PRICES
// =====================================================
// These are the DGM prices previously supplied.
// Update this ONE section whenever your prices change.
// =====================================================

const DGM_PRICES = {
  MTN: {
    "1": 5,
    "2": 10,
    "3": 15,
    "4": 20,
    "5": 24,
    "6": 28,
    "8": 36,
    "10": 45,
    "15": 64,
    "20": 84,
    "25": 100,
    "30": 128,
    "40": 168,
    "50": 207
  },

  AirtelTigo: {
    "1": 5,
    "2": 10,
    "3": 15,
    "4": 20,
    "5": 24,
    "6": 26,
    "8": 35,
    "10": 45,
    "12": 48,
    "15": 65,
    "25": 100,
    "30": 120,
    "40": 160,
    "50": 200
  },

  Telecel: {
    "10": 45,
    "15": 60,
    "20": 76,
    "25": 100,
    "30": 115,
    "35": 136,
    "40": 150,
    "45": 165,
    "50": 185,
    "100": 407
  }
};

function normalizeCapacity(capacity) {
  const value =
    String(capacity || "")
      .trim()
      .replace(/\s*GB$/i, "");

  if (
    !/^\d+(?:\.\d+)?$/.test(value)
  ) {
    return null;
  }

  return String(
    Number(value)
  );
}

function getDGMDataPrice(
  network,
  capacity
) {
  const normalized =
    normalizeCapacity(capacity);

  if (!normalized) {
    return null;
  }

  if (!DGM_PRICES[network]) {
    return null;
  }

  const price =
    DGM_PRICES[network][
      normalized
    ];

  if (
    price === undefined
  ) {
    return null;
  }

  return Number(price);
}

// =====================================================
// POSTGRES SESSION STORE
// =====================================================
// This replaces Express MemoryStore.
// Sessions survive Render restarts/redeploys.
// =====================================================

class PostgresSessionStore
  extends session.Store {

  constructor(pool) {
    super();
    this.pool = pool;
  }

  async get(sid, callback) {
    try {
      const result =
        await this.pool.query(
          `
          SELECT sess, expire
          FROM user_sessions
          WHERE sid = $1
          LIMIT 1
          `,
          [sid]
        );

      if (!result.rows.length) {
        return callback(null, null);
      }

      const row =
        result.rows[0];

      if (
        row.expire &&
        new Date(row.expire) <=
          new Date()
      ) {
        await this.destroy(
          sid,
          () => {}
        );

        return callback(
          null,
          null
        );
      }

      const sess =
        typeof row.sess === "string"
          ? JSON.parse(row.sess)
          : row.sess;

      callback(
        null,
        sess
      );
    } catch (error) {
      console.error(
        "SESSION GET ERROR:",
        error
      );

      callback(error);
    }
  }

  async set(
    sid,
    sess,
    callback
  ) {
    try {
      const maxAge =
        sess?.cookie?.maxAge ||
        1000 *
          60 *
          60 *
          24 *
          7;

      const expire =
        new Date(
          Date.now() + maxAge
        );

      await this.pool.query(
        `
        INSERT INTO user_sessions
        (
          sid,
          sess,
          expire
        )
        VALUES
        (
          $1,
          $2::jsonb,
          $3
        )
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
        "SESSION SET ERROR:",
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
      await this.pool.query(
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
        "SESSION DESTROY ERROR:",
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
        sess?.cookie?.maxAge ||
        1000 *
          60 *
          60 *
          24 *
          7;

      const expire =
        new Date(
          Date.now() + maxAge
        );

      await this.pool.query(
        `
        UPDATE user_sessions
        SET
          sess = $1::jsonb,
          expire = $2
        WHERE sid = $3
        `,
        [
          JSON.stringify(sess),
          expire,
          sid
        ]
      );

      if (callback) {
        callback(null);
      }
    } catch (error) {
      console.error(
        "SESSION TOUCH ERROR:",
        error
      );

      if (callback) {
        callback(error);
      }
    }
  }
}

const sessionStore =
  new PostgresSessionStore(
    pool
  );

// =====================================================
// DATAMART REQUEST
// =====================================================

async function datamartRequest(
  endpoint,
  method = "GET",
  body = null,
  idempotencyKey = null
) {
  if (!DATAMART_API_KEY) {
    throw new Error(
      "DATAMART_API_KEY is not configured."
    );
  }

  const headers = {
    "X-API-Key":
      DATAMART_API_KEY,
    Accept:
      "application/json",
    "Content-Type":
      "application/json"
  };

  if (idempotencyKey) {
    headers[
      "X-Idempotency-Key"
    ] = idempotencyKey;
  }

  async function makeRequest(
    url
  ) {
    console.log(
      "DATAMART REQUEST:",
      {
        url,
        method,
        idempotencyKey:
          idempotencyKey || null
      }
    );

    const controller =
      new AbortController();

    const timeout =
      setTimeout(() => {
        controller.abort();
      }, 30000);

    try {
      const response =
        await fetch(url, {
          method,
          headers,
          body:
            body !== null
              ? JSON.stringify(body)
              : undefined,
          signal:
            controller.signal
        });

      const text =
        await response.text();

      let data = {};

      try {
        data = text
          ? JSON.parse(text)
          : {};
      } catch {
        data = {
          raw: text
        };
      }

      console.log(
        "DATAMART RESPONSE:",
        {
          statusCode:
            response.status,
          ok:
            response.ok,
          data
        }
      );

      return {
        response,
        data
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------------------------------------------------
  // PURCHASE
  // ---------------------------------------------------

  if (
    endpoint === "/purchase" &&
    method === "POST"
  ) {
    const primary =
      await makeRequest(
        `${DATAMART_BASE}${endpoint}`
      );

    if (
      primary.response.status ===
      404
    ) {
      console.log(
        "DATAMART PRIMARY PURCHASE ROUTE RETURNED 404."
      );

      const developer =
        await makeRequest(
          `${DATAMART_DEVELOPER_BASE}${endpoint}`
        );

      if (
        !developer.response.ok
      ) {
        const data =
          developer.data || {};

        throw new Error(
          data.message ||
            data.error ||
            data.raw ||
            `DataMart request failed (${developer.response.status})`
        );
      }

      if (
        developer.data &&
        developer.data.status ===
          "error"
      ) {
        throw new Error(
          developer.data.message ||
            "DataMart purchase failed."
        );
      }

      return developer.data;
    }

    if (
      !primary.response.ok
    ) {
      const data =
        primary.data || {};

      throw new Error(
        data.message ||
          data.error ||
          data.raw ||
          `DataMart request failed (${primary.response.status})`
      );
    }

    if (
      primary.data &&
      primary.data.status ===
        "error"
    ) {
      throw new Error(
        primary.data.message ||
          "DataMart purchase failed."
      );
    }

    return primary.data;
  }

  // ---------------------------------------------------
  // OTHER DATAMART ENDPOINTS
  // ---------------------------------------------------

  const result =
    await makeRequest(
      `${DATAMART_BASE}${endpoint}`
    );

  if (
    !result.response.ok
  ) {
    const data =
      result.data || {};

    throw new Error(
      data.message ||
        data.error ||
        data.raw ||
        `DataMart request failed (${result.response.status})`
    );
  }

  if (
    result.data &&
    result.data.status ===
      "error"
  ) {
    throw new Error(
      result.data.message ||
        "DataMart request failed."
    );
  }

  return result.data;
}

// =====================================================
// PAYSTACK REQUEST
// =====================================================

async function paystackRequest(
  endpoint,
  method = "GET",
  body = null
) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not configured."
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, 30000);

  try {
    const response =
      await fetch(
        `https://api.paystack.co${endpoint}`,
        {
          method,
          headers: {
            Authorization:
              `Bearer ${PAYSTACK_SECRET_KEY}`,
            Accept:
              "application/json",
            "Content-Type":
              "application/json"
          },
          body:
            body !== null
              ? JSON.stringify(body)
              : undefined,
          signal:
            controller.signal
        }
      );

    const data =
      await response
        .json()
        .catch(
          () => ({})
        );

    if (!response.ok) {
      throw new Error(
        data.message ||
          "Paystack request failed."
      );
    }

    if (
      data.status === false
    ) {
      throw new Error(
        data.message ||
          "Paystack request failed."
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// =====================================================
// DATABASE INITIALIZATION
// =====================================================

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      balance NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
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
      amount NUMERIC(12,2) NOT NULL,
      status TEXT DEFAULT 'Pending Payment',
      created_at TIMESTAMP DEFAULT NOW()
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
      reference TEXT,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ---------------------------------------------------
  // SESSION TABLE
  // ---------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMP NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    user_sessions_expire_idx
    ON user_sessions(expire);
  `);

  // ---------------------------------------------------
  // ORDER COLUMNS
  // ---------------------------------------------------

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS
    datamart_purchase_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS
    datamart_reference TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS
    datamart_transaction_reference TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS
    datamart_status TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS
    capacity TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS
    paystack_reference TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS
    payment_status TEXT
    DEFAULT 'Pending';
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS
    paid_at TIMESTAMP;
  `);

  console.log(
    "Database initialized successfully."
  );
}

// =====================================================
// SESSION MIDDLEWARE
// =====================================================

app.use(
  session({
    store: sessionStore,

    secret:
      SESSION_SECRET,

    resave: false,

    saveUninitialized:
      false,

    rolling: true,

    cookie: {
      httpOnly: true,

      secure:
        NODE_ENV ===
        "production",

      sameSite: "lax",

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
// PAYSTACK WEBHOOK
// IMPORTANT: BEFORE express.json()
// =====================================================

app.post(
  "/api/paystack/webhook",
  express.raw({
    type: "application/json"
  }),
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res
          .status(500)
          .send(
            "Paystack key missing"
          );
      }

      const signature =
        req.headers[
          "x-paystack-signature"
        ];

      if (!signature) {
        return res
          .status(401)
          .send(
            "Missing signature"
          );
      }

      const hash =
        crypto
          .createHmac(
            "sha512",
            PAYSTACK_SECRET_KEY
          )
          .update(req.body)
          .digest("hex");

      const signatureBuffer =
        Buffer.from(
          String(signature)
        );

      const hashBuffer =
        Buffer.from(hash);

      if (
        signatureBuffer.length !==
        hashBuffer.length
      ) {
        return res
          .status(401)
          .send(
            "Invalid signature"
          );
      }

      const signaturesMatch =
        crypto.timingSafeEqual(
          signatureBuffer,
          hashBuffer
        );

      if (!signaturesMatch) {
        console.error(
          "INVALID PAYSTACK WEBHOOK SIGNATURE"
        );

        return res
          .status(401)
          .send(
            "Invalid signature"
          );
      }

      const event =
        JSON.parse(
          req.body.toString()
        );

      console.log(
        "PAYSTACK WEBHOOK EVENT:",
        event.event
      );

      if (
        event.event !==
        "charge.success"
      ) {
        return res.sendStatus(200);
      }

      const payment =
        event.data || {};

      const reference =
        String(
          payment.reference || ""
        ).trim();

      if (!reference) {
        return res.sendStatus(200);
      }

      const orderResult =
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

      if (
        !orderResult.rows.length
      ) {
        console.error(
          "PAYSTACK ORDER NOT FOUND:",
          reference
        );

        return res.sendStatus(200);
      }

      const order =
        orderResult.rows[0];

      // ------------------------------------------------
      // Validate metadata when available
      // ------------------------------------------------

      const metadataOrderRef =
        payment?.metadata?.order_ref;

      if (
        metadataOrderRef &&
        metadataOrderRef !==
          order.order_ref
      ) {
        console.error(
          "PAYSTACK METADATA ORDER MISMATCH"
        );

        return res.sendStatus(200);
      }

      const expectedAmount =
        Math.round(
          Number(order.amount) *
            100
        );

      const paidAmount =
        Number(
          payment.amount
        );

      const currency =
        String(
          payment.currency || ""
        ).toUpperCase();

      if (
        paidAmount !==
          expectedAmount ||
        currency !== "GHS"
      ) {
        console.error(
          "PAYSTACK PAYMENT MISMATCH:",
          {
            order:
              order.order_ref,
            expectedAmount,
            paidAmount,
            currency
          }
        );

        return res.sendStatus(200);
      }

      // ------------------------------------------------
      // Already fulfilled
      // ------------------------------------------------

      if (
        String(
          order.payment_status ||
            ""
        ).toLowerCase() ===
          "paid" &&
        order.datamart_purchase_id
      ) {
        return res.sendStatus(200);
      }

      // ------------------------------------------------
      // Mark paid
      // ------------------------------------------------

      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'Paid',
          status =
            CASE
              WHEN status = 'Completed'
                THEN status
              ELSE 'Processing'
            END,
          paystack_reference = $1,
          paid_at = COALESCE(
            paid_at,
            NOW()
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
          LIMIT 1
          `,
          [order.id]
        );

      const updatedOrder =
        updatedResult.rows[0];

      if (
        String(
          updatedOrder.service ||
            ""
        ).toLowerCase() ===
        "data bundle"
      ) {
        await fulfillDataOrder(
          updatedOrder
        );
      }

      return res.sendStatus(200);

    } catch (error) {
      console.error(
        "PAYSTACK WEBHOOK ERROR:",
        error
      );

      return res.sendStatus(200);
    }
  }
);

// =====================================================
// BODY MIDDLEWARE
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
// STATIC FILES
// =====================================================

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

// =====================================================
// HEALTH
// =====================================================

app.get(
  "/api/health",
  async (req, res) => {
    try {
      await pool.query(
        "SELECT 1"
      );

      res.json({
        success: true,
        service:
          "DHE GENIUS MEDIA",
        status:
          "online",
        database:
          "connected",
        datamart:
          DATAMART_API_KEY
            ? "configured"
            : "not configured",
        paystack:
          PAYSTACK_SECRET_KEY
            ? "configured"
            : "not configured",
        sessions:
          "postgresql",
        datamartStatusChecker:
          DATAMART_STATUS_CHECKER_ENABLED
            ? "enabled"
            : "disabled"
      });

    } catch (error) {
      console.error(
        "HEALTH ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        status:
          "database error"
      });
    }
  }
);

// =====================================================
// REGISTER
// =====================================================

function regenerateSession(
  req
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      req.session.regenerate(
        (error) => {
          if (error) {
            return reject(
              error
            );
          }

          resolve();
        }
      );
    }
  );
}

function saveSession(req) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      req.session.save(
        (error) => {
          if (error) {
            return reject(
              error
            );
          }

          resolve();
        }
      );
    }
  );
}

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

      const confirmPassword =
        String(
          req.body.confirmPassword ||
            ""
        );

      if (!name) {
        return sendError(
          res,
          400,
          "Full name is required."
        );
      }

      if (
        !validGhanaPhone(phone)
      ) {
        return sendError(
          res,
          400,
          "Please enter a valid Ghana phone number."
        );
      }

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        )
      ) {
        return sendError(
          res,
          400,
          "Please enter a valid email address."
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

      if (
        password !==
        confirmPassword
      ) {
        return sendError(
          res,
          400,
          "Passwords do not match."
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
          400,
          "An account with this phone or email already exists."
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
            password,
            balance
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            0
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

      await regenerateSession(
        req
      );

      req.session.customerId =
        customer.id;

      await saveSession(req);

      res.status(201).json({
        success: true,
        customer:
          publicCustomer(
            customer
          )
      });

    } catch (error) {
      console.error(
        "REGISTER ERROR:",
        error
      );

      if (
        error.code === "23505"
      ) {
        return sendError(
          res,
          400,
          "An account with this phone or email already exists."
        );
      }

      sendError(
        res,
        500,
        "Unable to create account."
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
          req.body.identifier || ""
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
          "Phone/email and password are required."
        );
      }

      const email =
        cleanEmail(
          identifier
        );

      const phone =
        normalizeGhanaPhone(
          identifier
        );

      const result =
        await pool.query(
          `
          SELECT *
          FROM customers
          WHERE email = $1
             OR phone = $2
          LIMIT 1
          `,
          [
            email,
            phone
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

      const valid =
        await bcrypt.compare(
          password,
          customer.password
        );

      if (!valid) {
        return sendError(
          res,
          401,
          "Invalid login details."
        );
      }

      await regenerateSession(
        req
      );

      req.session.customerId =
        customer.id;

      await saveSession(req);

      res.json({
        success: true,
        customer:
          publicCustomer(
            customer
          )
      });

    } catch (error) {
      console.error(
        "LOGIN ERROR:",
        error
      );

      sendError(
        res,
        500,
        "Unable to login."
      );
    }
  }
);

// =====================================================
// CURRENT CUSTOMER
// =====================================================

app.get(
  "/api/me",
  async (req, res) => {
    try {
      if (
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
        await new Promise(
          (resolve) => {
            req.session.destroy(
              () => resolve()
            );
          }
        );

        return sendError(
          res,
          401,
          "Customer account not found."
        );
      }

      res.json({
        success: true,
        customer:
          publicCustomer(
            customer
          )
      });

    } catch (error) {
      console.error(
        "ME ERROR:",
        error
      );

      sendError(
        res,
        500,
        "Unable to load account."
      );
    }
  }
);

// =====================================================
// LOGOUT
// =====================================================

app.post(
  "/api/logout",
  async (req, res) => {
    req.session.destroy(
      (error) => {
        if (error) {
          console.error(
            "LOGOUT ERROR:",
            error
          );

          return sendError(
            res,
            500,
            "Unable to logout."
          );
        }

        res.clearCookie(
          "connect.sid",
          {
            httpOnly: true,
            sameSite: "lax",
            secure:
              NODE_ENV ===
              "production"
          }
        );

        res.json({
          success: true
        });
      }
    );
  }
);

// =====================================================
// CREATE ORDER
// =====================================================

app.post(
  "/api/orders",
  requireLogin,
  async (req, res) => {
    try {
      const customer =
        await getCustomer(
          req.session.customerId
        );

      if (!customer) {
        return sendError(
          res,
          401,
          "Customer account not found."
        );
      }

      const service =
        String(
          req.body.service || ""
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
          req.body.capacity ||
            req.body.data_capacity ||
            req.body.bundle ||
            ""
        );

      if (!service) {
        return sendError(
          res,
          400,
          "Service is required."
        );
      }

      let amount;

      // ------------------------------------------------
      // DATA BUNDLE
      // ------------------------------------------------

      if (
        service.toLowerCase() ===
        "data bundle"
      ) {
        if (
          !network ||
          !networkMap[network]
        ) {
          return sendError(
            res,
            400,
            "Please select a valid network."
          );
        }

        if (!capacity) {
          return sendError(
            res,
            400,
            "Data capacity is required."
          );
        }

        if (
          !validGhanaPhone(
            phone
          )
        ) {
          return sendError(
            res,
            400,
            "Please enter a valid Ghana phone number."
          );
        }

        amount =
          getDGMDataPrice(
            network,
            capacity
          );

        if (
          amount === null
        ) {
          return sendError(
            res,
            400,
            `The ${network} ${capacity}GB bundle is not available.`
          );
        }
      } else {
        // ------------------------------------------------
        // OTHER SERVICES
        // ------------------------------------------------

        amount =
          Number(
            req.body.amount
          );

        if (
          !Number.isFinite(
            amount
          ) ||
          amount <= 0
        ) {
          return sendError(
            res,
            400,
            "Valid amount is required."
          );
        }
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
            customer.id,
            service,
            network || null,
            phone || null,
            amount,
            capacity || null
          ]
        );

      res.status(201).json({
        success: true,
        message:
          "Order created successfully.",
        order:
          result.rows[0]
      });

    } catch (error) {
      console.error(
        "CREATE ORDER ERROR:",
        error
      );

      sendError(
        res,
        500,
        "Unable to create order."
      );
    }
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
            paid_at,
            datamart_purchase_id,
            datamart_reference,
            datamart_transaction_reference,
            datamart_status,
            created_at
          FROM orders
          WHERE customer_id = $1
          ORDER BY created_at DESC
          `,
          [
            req.session.customerId
          ]
        );

      res.json({
        success: true,
        orders:
          result.rows
      });

    } catch (error) {
      console.error(
        "LOAD ORDERS ERROR:",
        error
      );

      sendError(
        res,
        500,
        "Unable to load orders."
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

      const customer =
        await getCustomer(
          req.session.customerId
        );

      if (!customer) {
        return sendError(
          res,
          401,
          "Customer account not found."
        );
      }

      const email =
        cleanEmail(
          customer.email
        );

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        )
      ) {
        return sendError(
          res,
          400,
          "Please add a valid email address to your account before making payment."
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
            customer.id
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
          order.payment_status ||
            ""
        ).toLowerCase() ===
          "paid"
      ) {
        return sendError(
          res,
          400,
          "This order has already been paid."
        );
      }

      const amountGHS =
        Number(
          order.amount
        );

      if (
        !Number.isFinite(
          amountGHS
        ) ||
        amountGHS <= 0
      ) {
        return sendError(
          res,
          400,
          "Invalid order amount."
        );
      }

      const amountPesewas =
        Math.round(
          amountGHS * 100
        );

      const reference =
        String(
          order.paystack_reference ||
            ""
        ).trim() ||
        createTransactionReference();

      // IMPORTANT:
      // Return to our dedicated payment page.
      const callbackUrl =
        `${BASE_URL}/payment-success`;

      const payment =
        await paystackRequest(
          "/transaction/initialize",
          "POST",
          {
            email,

            amount:
              String(
                amountPesewas
              ),

            currency:
              "GHS",

            reference,

            callback_url:
              callbackUrl,

            metadata: {
              order_ref:
                order.order_ref,

              customer_id:
                String(
                  customer.id
                ),

              service:
                order.service || "",

              network:
                order.network || "",

              phone:
                order.phone || "",

              capacity:
                order.capacity || "",

              amount:
                amountGHS
            }
          }
        );

      if (
        !payment ||
        payment.status !== true ||
        !payment.data
      ) {
        return sendError(
          res,
          502,
          payment?.message ||
            "Paystack failed to initialize the payment."
        );
      }

      const authorizationUrl =
        payment.data
          .authorization_url;

      const accessCode =
        payment.data
          .access_code;

      const paystackReference =
        payment.data.reference ||
        reference;

      if (
        !authorizationUrl
      ) {
        return sendError(
          res,
          502,
          "Paystack did not return a checkout URL."
        );
      }

      await pool.query(
        `
        UPDATE orders
        SET
          paystack_reference = $1
        WHERE id = $2
        `,
        [
          paystackReference,
          order.id
        ]
      );

      res.json({
        success: true,

        order_ref:
          order.order_ref,

        reference:
          paystackReference,

        authorization_url:
          authorizationUrl,

        access_code:
          accessCode || null
      });

    } catch (error) {
      console.error(
        "PAYSTACK INITIALIZE ERROR:",
        error
      );

      sendError(
        res,
        500,
        error.message ||
          "Unable to initialize Paystack payment."
      );
    }
  }
);

// =====================================================
// PAYSTACK VERIFY
// =====================================================

async function verifyPaystackOrder(
  order,
  reference
) {
  const verification =
    await paystackRequest(
      `/transaction/verify/${encodeURIComponent(
        reference
      )}`
    );

  const payment =
    verification.data || {};

  const expectedAmount =
    Math.round(
      Number(order.amount) *
        100
    );

  const paidAmount =
    Number(
      payment.amount
    );

  const currency =
    String(
      payment.currency || ""
    ).toUpperCase();

  if (
    payment.status !==
    "success"
  ) {
    return {
      success: false,
      message:
        "Payment has not been completed."
    };
  }

  if (
    currency !== "GHS"
  ) {
    throw new Error(
      "Payment currency is invalid."
    );
  }

  if (
    paidAmount !==
    expectedAmount
  ) {
    throw new Error(
      "Payment amount does not match the order."
    );
  }

  await pool.query(
    `
    UPDATE orders
    SET
      payment_status = 'Paid',
      status =
        CASE
          WHEN status = 'Completed'
            THEN status
          ELSE 'Processing'
        END,
      paystack_reference = $1,
      paid_at = COALESCE(
        paid_at,
        NOW()
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
      LIMIT 1
      `,
      [order.id]
    );

  const updatedOrder =
    updatedResult.rows[0];

  let fulfillment =
    null;

  if (
    String(
      updatedOrder.service ||
        ""
    ).toLowerCase() ===
    "data bundle"
  ) {
    fulfillment =
      await fulfillDataOrder(
        updatedOrder
      );
  }

  const finalResult =
    await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [order.id]
    );

  return {
    success: true,

    payment_status:
      finalResult.rows[0]
        .payment_status,

    order_status:
      finalResult.rows[0]
        .status,

    order:
      finalResult.rows[0],

    fulfillment
  };
}

app.get(
  "/api/payments/verify/:reference",
  requireLogin,
  async (req, res) => {
    try {
      const reference =
        String(
          req.params.reference || ""
        ).trim();

      if (!reference) {
        return sendError(
          res,
          400,
          "Payment reference is required."
        );
      }

      const result =
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

      if (
        !result.rows.length
      ) {
        return sendError(
          res,
          404,
          "Order for this payment was not found."
        );
      }

      const order =
        result.rows[0];

      // Already paid.
      if (
        String(
          order.payment_status ||
            ""
        ).toLowerCase() ===
        "paid"
      ) {
        return res.json({
          success: true,

          payment_status:
            order.payment_status,

          order_status:
            order.status,

          order
        });
      }

      const resultData =
        await verifyPaystackOrder(
          order,
          reference
        );

      res.json(
        resultData
      );

    } catch (error) {
      console.error(
        "PAYMENT VERIFY ERROR:",
        error
      );

      sendError(
        res,
        500,
        error.message ||
          "Unable to verify payment."
      );
    }
  }
);

// =====================================================
// PAYMENT SUCCESS PAGE
// =====================================================
// Paystack returns here instead of "/".
// The customer's existing session is used.
// =====================================================

app.get(
  "/payment-success",
  (req, res) => {
    res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <meta name="theme-color" content="#070b0a">
  <title>Payment — DHE GENIUS MEDIA</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;

      font-family:
        Inter,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

      background: #070b0a;
      color: #fff;
    }

    .card {
      width: 100%;
      max-width: 430px;
      padding: 35px 25px;
      text-align: center;

      border-radius: 24px;

      background:
        linear-gradient(
          145deg,
          rgba(255,255,255,.06),
          rgba(255,255,255,.02)
        );

      border: 1px solid rgba(255,255,255,.08);
    }

    .icon {
      width: 70px;
      height: 70px;
      margin: 0 auto 20px;

      display: flex;
      align-items: center;
      justify-content: center;

      border-radius: 50%;

      background: rgba(37,211,102,.12);

      color: #25d366;
      font-size: 32px;
    }

    h1 {
      font-size: 23px;
      margin: 0 0 10px;
    }

    p {
      color: #909a96;
      font-size: 13px;
      line-height: 1.6;
      margin: 0;
    }

    .loader {
      width: 25px;
      height: 25px;

      margin: 22px auto 0;

      border: 3px solid
        rgba(255,255,255,.1);

      border-top-color: #25d366;

      border-radius: 50%;

      animation:
        spin .8s linear infinite;
    }

    @keyframes spin {
      to {
        transform:
          rotate(360deg);
      }
    }
  </style>
</head>

<body>

  <div class="card">

    <div
      class="icon"
      id="icon"
    >
      ✓
    </div>

    <h1 id="title">
      Confirming payment
    </h1>

    <p id="message">
      Please wait while we verify your Paystack payment.
    </p>

    <div
      class="loader"
      id="loader"
    ></div>

  </div>

<script>

  async function verifyPayment() {

    const params =
      new URLSearchParams(
        window.location.search
      );

    const reference =
      params.get("reference");

    if (!reference) {

      document.getElementById(
        "title"
      ).textContent =
        "Payment reference missing";

      document.getElementById(
        "message"
      ).textContent =
        "We could not find the Paystack transaction reference.";

      document.getElementById(
        "loader"
      ).style.display = "none";

      setTimeout(() => {
        window.location.href =
          "/orders.html";
      }, 2500);

      return;
    }

    try {

      const response =
        await fetch(
          "/api/payments/verify/" +
          encodeURIComponent(
            reference
          ),
          {
            credentials:
              "include"
          }
        );

      const data =
        await response.json();

      if (
        response.status === 401
      ) {

        document.getElementById(
          "title"
        ).textContent =
          "Please log in";

        document.getElementById(
          "message"
        ).textContent =
          "Your payment was received, but your login session could not be restored.";

        document.getElementById(
          "loader"
        ).style.display = "none";

        setTimeout(() => {
          window.location.href =
            "/login.html?redirect=/orders.html";
        }, 2500);

        return;
      }

      if (
        data.success
      ) {

        document.getElementById(
          "title"
        ).textContent =
          "Payment confirmed";

        document.getElementById(
          "message"
        ).textContent =
          "Your payment was successfully verified. Opening your order...";

        setTimeout(() => {
          window.location.href =
            "/orders.html";
        }, 1500);

      } else {

        document.getElementById(
          "title"
        ).textContent =
          "Payment not completed";

        document.getElementById(
          "message"
        ).textContent =
          data.message ||
          "The payment has not been confirmed.";

        document.getElementById(
          "loader"
        ).style.display = "none";

        setTimeout(() => {
          window.location.href =
            "/orders.html";
        }, 2500);
      }

    } catch (error) {

      console.error(
        "PAYMENT CALLBACK ERROR:",
        error
      );

      document.getElementById(
        "title"
      ).textContent =
        "Checking payment";

      document.getElementById(
        "message"
      ).textContent =
        "Please check your Orders page for the latest status.";

      document.getElementById(
        "loader"
      ).style.display = "none";

      setTimeout(() => {
        window.location.href =
          "/orders.html";
      }, 2500);
    }
  }

  verifyPayment();

</script>

</body>
</html>
    `);
  }
);

// =====================================================
// DATAMART FULFILLMENT
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
    order.datamart_purchase_id
  ) {
    return {
      success: true,
      alreadyProcessed: true,
      purchaseId:
        order.datamart_purchase_id
    };
  }

  if (
    String(
      order.payment_status ||
        ""
    ).toLowerCase() !==
    "paid"
  ) {
    throw new Error(
      "Order has not been paid."
    );
  }

  try {
    const network =
      networkMap[
        order.network
      ];

    if (!network) {
      throw new Error(
        `Unsupported network: ${order.network}`
      );
    }

    const phoneNumber =
      normalizeGhanaPhone(
        order.phone
      );

    if (
      !validGhanaPhone(
        phoneNumber
      )
    ) {
      throw new Error(
        "Invalid Ghana delivery phone number."
      );
    }

    const capacity =
      normalizeCapacity(
        order.capacity
      );

    if (!capacity) {
      throw new Error(
        `Invalid data capacity: ${order.capacity}`
      );
    }

    const idempotencyKey =
      `dgm-${order.order_ref}`;

    await pool.query(
      `
      UPDATE orders
      SET status = 'Processing'
      WHERE id = $1
        AND payment_status = 'Paid'
        AND datamart_purchase_id IS NULL
      `,
      [order.id]
    );

    const payload = {
      phoneNumber,
      network,
      capacity,
      gateway:
        "wallet"
    };

    console.log(
      "DATAMART PURCHASE:",
      {
        orderRef:
          order.order_ref,
        phoneNumber,
        network,
        capacity,
        gateway:
          "wallet",
        idempotencyKey
      }
    );

    const data =
      await datamartRequest(
        "/purchase",
        "POST",
        payload,
        idempotencyKey
      );

    console.log(
      "DATAMART PURCHASE RESPONSE:",
      data
    );

    if (
      !data ||
      data.status !==
        "success" ||
      !data.data
    ) {
      throw new Error(
        data?.message ||
          "DataMart purchase failed."
      );
    }

    const purchase =
      data.data;

    const purchaseId =
      purchase.purchaseId ||
      null;

    const datamartReference =
      purchase.orderReference ||
      null;

    const datamartTransactionReference =
      purchase.transactionReference ||
      null;

    const datamartStatus =
      String(
        purchase.orderStatus ||
          "processing"
      ).trim();

    if (
      !purchaseId &&
      !datamartReference
    ) {
      throw new Error(
        "DataMart returned success without a purchase reference."
      );
    }

    const lowerStatus =
      datamartStatus.toLowerCase();

    let finalStatus =
      "Processing";

    if (
      [
        "completed",
        "success",
        "successful"
      ].includes(
        lowerStatus
      )
    ) {
      finalStatus =
        "Completed";
    }

    if (
      [
        "failed",
        "refunded",
        "cancelled",
        "canceled"
      ].includes(
        lowerStatus
      )
    ) {
      finalStatus =
        "Failed";
    }

    await pool.query(
      `
      UPDATE orders
      SET
        status = $1,

        datamart_purchase_id =
          COALESCE(
            datamart_purchase_id,
            $2
          ),

        datamart_reference =
          COALESCE(
            datamart_reference,
            $3
          ),

        datamart_transaction_reference =
          COALESCE(
            datamart_transaction_reference,
            $4
          ),

        datamart_status = $5

      WHERE id = $6
      `,
      [
        finalStatus,
        purchaseId,
        datamartReference,
        datamartTransactionReference,
        datamartStatus,
        order.id
      ]
    );

    return {
      success: true,
      purchaseId,
      reference:
        datamartReference,
      transactionReference:
        datamartTransactionReference,
      status:
        datamartStatus
    };

  } catch (error) {
    console.error(
      "DATAMART FULFILLMENT ERROR:",
      error
    );

    // Keep the order Processing instead
    // of falsely telling the customer it failed.
    try {
      await pool.query(
        `
        UPDATE orders
        SET
          status = 'Processing',
          datamart_status = $1
        WHERE id = $2
          AND datamart_purchase_id IS NULL
        `,
        [
          `pending: ${error.message}`,
          order.id
        ]
      );
    } catch (dbError) {
      console.error(
        "DATAMART ERROR STATUS UPDATE:",
        dbError
      );
    }

    return {
      success: false,
      error:
        error.message
    };
  }
}

// =====================================================
// MANUAL DATAMART PURCHASE
// =====================================================

app.post(
  "/api/orders/:orderRef/datamart-purchase",
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

      if (
        !result.rows.length
      ) {
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
          order.payment_status ||
            ""
        ).toLowerCase() !==
        "paid"
      ) {
        return sendError(
          res,
          400,
          "Payment is required before data delivery."
        );
      }

      const resultData =
        await fulfillDataOrder(
          order
        );

      if (
        !resultData.success
      ) {
        return res.status(202).json(
          {
            success: false,
            status:
              "Processing",
            message:
              "Payment is confirmed. Data delivery is still being processed.",
            error:
              resultData.error
          }
        );
      }

      res.json(
        resultData
      );

    } catch (error) {
      console.error(
        "MANUAL DATAMART ERROR:",
        error
      );

      sendError(
        res,
        500,
        error.message
      );
    }
  }
);

// =====================================================
// DATAMART STATUS CHECK
// =====================================================
// Currently disabled by default because the endpoint
// previously returned 404.
// =====================================================

async function updateDataMartOrderStatus(
  order
) {
  if (
    !order ||
    !order.datamart_reference
  ) {
    return;
  }

  try {
    const endpoint =
      `/order-status/${encodeURIComponent(
        order.datamart_reference
      )}`;

    const result =
      await datamartRequest(
        endpoint
      );

    if (
      !result ||
      result.status !==
        "success" ||
      !result.data
    ) {
      return;
    }

    const datamartStatus =
      String(
        result.data.orderStatus ||
          ""
      )
        .trim()
        .toLowerCase();

    if (!datamartStatus) {
      return;
    }

    let dgmStatus =
      "Processing";

    if (
      [
        "completed",
        "success",
        "successful"
      ].includes(
        datamartStatus
      )
    ) {
      dgmStatus =
        "Completed";
    }

    if (
      [
        "failed",
        "refunded",
        "cancelled",
        "canceled"
      ].includes(
        datamartStatus
      )
    ) {
      dgmStatus =
        "Failed";
    }

    await pool.query(
      `
      UPDATE orders
      SET
        status = $1,
        datamart_status = $2
      WHERE id = $3
      `,
      [
        dgmStatus,
        datamartStatus,
        order.id
      ]
    );

  } catch (error) {
    console.error(
      "DATAMART STATUS CHECK ERROR:",
      error.message
    );
  }
}

async function checkProcessingOrders() {
  if (
    !DATAMART_STATUS_CHECKER_ENABLED
  ) {
    return;
  }

  try {
    const result =
      await pool.query(
        `
        SELECT
          id,
          order_ref,
          status,
          datamart_reference,
          datamart_status
        FROM orders
        WHERE status = 'Processing'
          AND datamart_reference IS NOT NULL
          AND datamart_reference <> ''
        ORDER BY created_at ASC
        LIMIT 100
        `
      );

    if (
      !result.rows.length
    ) {
      return;
    }

    console.log(
      `DATAMART STATUS CHECKER: ${result.rows.length} order(s)`
    );

    for (
      const order of result.rows
    ) {
      await updateDataMartOrderStatus(
        order
      );
    }

  } catch (error) {
    console.error(
      "PROCESSING ORDER CHECKER ERROR:",
      error
    );
  }
}

// =====================================================
// WALLET
// =====================================================

app.get(
  "/api/wallet",
  requireLogin,
  async (req, res) => {
    try {
      const customer =
        await getCustomer(
          req.session.customerId
        );

      if (!customer) {
        return sendError(
          res,
          404,
          "Customer not found."
        );
      }

      res.json({
        success: true,
        balance:
          Number(
            customer.balance ||
              0
          )
      });

    } catch (error) {
      console.error(
        "WALLET ERROR:",
        error
      );

      sendError(
        res,
        500,
        "Unable to load wallet."
      );
    }
  }
);

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
            reference,
            description,
            created_at
          FROM wallet_transactions
          WHERE customer_id = $1
          ORDER BY created_at DESC
          `,
          [
            req.session.customerId
          ]
        );

      res.json({
        success: true,
        transactions:
          result.rows
      });

    } catch (error) {
      console.error(
        "WALLET TRANSACTIONS ERROR:",
        error
      );

      sendError(
        res,
        500,
        "Unable to load wallet transactions."
      );
    }
  }
);

// =====================================================
// DATAMART BALANCE
// =====================================================

app.get(
  "/api/datamart/balance",
  requireLogin,
  async (req, res) => {
    try {
      const data =
        await datamartRequest(
          "/balance"
        );

      res.json(data);

    } catch (error) {
      console.error(
        "DATAMART BALANCE ERROR:",
        error
      );

      sendError(
        res,
        500,
        error.message
      );
    }
  }
);

// =====================================================
// DATAMART PACKAGES
// =====================================================

app.get(
  "/api/datamart/packages",
  requireLogin,
  async (req, res) => {
    try {
      const data =
        await datamartRequest(
          "/packages"
        );

      res.json(data);

    } catch (error) {
      console.error(
        "DATAMART PACKAGES ERROR:",
        error
      );

      sendError(
        res,
        500,
        error.message
      );
    }
  }
);

// =====================================================
// API 404
// =====================================================

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      success: false,
      error:
        "API endpoint not found."
    });
  }
);

// =====================================================
// FRONTEND FALLBACK
// =====================================================

app.get(
  /.*/,
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

// =====================================================
// START SERVER
// =====================================================

initializeDatabase()
  .then(() => {

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
          "Database: connected"
        );

        console.log(
          `DataMart API: ${
            DATAMART_API_KEY
              ? "configured"
              : "NOT configured"
          }`
        );

        console.log(
          `Paystack: ${
            PAYSTACK_SECRET_KEY
              ? "configured"
              : "NOT configured"
          }`
        );

        console.log(
          "Sessions: PostgreSQL"
        );

        console.log(
          `BASE_URL: ${BASE_URL}`
        );

        console.log(
          `DATAMART STATUS CHECKER: ${
            DATAMART_STATUS_CHECKER_ENABLED
              ? "ENABLED"
              : "DISABLED"
          }`
        );

        if (
          DATAMART_STATUS_CHECKER_ENABLED
        ) {
          setTimeout(() => {
            checkProcessingOrders();
          }, 5000);

          setInterval(() => {
            checkProcessingOrders();
          }, 30 * 1000);
        }

      }
    );

  })
  .catch((error) => {

    console.error(
      "DATABASE INITIALIZATION ERROR:",
      error
    );

    process.exit(1);

  });
