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

// =====================================================
// APP CONFIG
// =====================================================

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

// =====================================================
// DATABASE
// =====================================================

if (!DATABASE_URL) {
  console.error(
    "ERROR: DATABASE_URL is missing."
  );
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

  // ===================================================
  // ADD NEW ORDER COLUMNS SAFELY
  // ===================================================

  const orderColumns = [
    ["datamart_purchase_id", "TEXT"],
    ["datamart_reference", "TEXT"],
    ["datamart_transaction_reference", "TEXT"],
    ["datamart_status", "TEXT"],
    ["capacity", "TEXT"],
    ["paystack_reference", "TEXT"],
    ["payment_status", "TEXT DEFAULT 'Pending'"],
    ["paid_at", "TIMESTAMPTZ"]
  ];

  for (
    const [column, definition]
    of orderColumns
  ) {

    await pool.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS
      ${column} ${definition}
    `);
  }

  // ===================================================
  // WALLET TRANSACTION UNIQUE INDEX
  // ===================================================

  /*
   * Remove duplicate non-null references while
   * preserving the newest transaction.
   *
   * This makes old databases safe before the unique
   * index is created.
   */

  await pool.query(`
    DELETE FROM wallet_transactions a
    USING wallet_transactions b
    WHERE a.reference IS NOT NULL
      AND a.reference = b.reference
      AND a.id < b.id
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    wallet_transactions_reference_unique
    ON wallet_transactions(reference)
    WHERE reference IS NOT NULL
  `);

  // ===================================================
  // INDEXES
  // ===================================================

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    orders_customer_created_idx
    ON orders(customer_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    wallet_transactions_customer_created_idx
    ON wallet_transactions(customer_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    wallet_topups_customer_created_idx
    ON wallet_topups(customer_id, created_at DESC)
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

    store:
      sessionStore,

    secret:
      SESSION_SECRET,

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

  if (
    phone.startsWith("+233")
  ) {

    phone =
      "0" +
      phone.slice(4);
  }

  if (
    phone.startsWith("233")
  ) {

    phone =
      "0" +
      phone.slice(3);
  }

  return phone;
}

function validGhanaPhone(value) {

  return /^0(20|23|24|25|26|27|50|51|53|54|55|59)\d{7}$/
    .test(
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

function createTransactionReference() {

  return (
    "TXN-" +
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

  return res.status(status).json({

    success: false,

    message
  });
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

    id:
      customer.id,

    name:
      customer.name,

    phone:
      customer.phone,

    email:
      customer.email,

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

  return Number.isFinite(number)
    ? number
    : null;
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

  MTN:
    "YELLO",

  AirtelTigo:
    "AT_PREMIUM",

  Telecel:
    "TELECEL"
};

// =====================================================
// DATAMART
// =====================================================

const DATAMART_BASE =
  "https://api.datamartgh.shop/api";

const DATAMART_DEVELOPER_BASE =
  "https://api.datamartgh.shop/api/developer";

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

async function datamartPurchase(
  payload,
  idempotencyKey
) {

  const body =
    JSON.stringify(payload);

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

  } catch (primaryError) {

    console.warn(
      "Primary DataMart endpoint failed:",
      primaryError.message
    );

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
  }
}

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
    String(
      order.service || ""
    ).toLowerCase() !== "data"
  ) {

    return;
  }

  /*
   * Prevent unnecessary repeat fulfillment.
   */

  if (
    order.datamart_purchase_id ||
    order.datamart_reference
  ) {

    return {
      success: true,

      status:
        order.status ||
        "Processing",

      alreadyFulfilled:
        true
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

  const payload = {

    phoneNumber:
      normalizeGhanaPhone(
        order.phone
      ),

    network:
      datamartNetwork,

    capacity,

    gateway:
      "wallet"
  };

  const idempotencyKey =
    `dgm-${order.order_ref}`;

  try {

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
        result?.status ||
        result?.data?.status ||
        "processing"
      ).toLowerCase();

    let localStatus =
      "Processing";

    if (
      [
        "completed",
        "complete",
        "success",
        "successful"
      ].includes(
        externalStatus
      )
    ) {

      localStatus =
        "Completed";
    }

    if (
      [
        "failed",
        "failure",
        "refunded",
        "cancelled",
        "canceled"
      ].includes(
        externalStatus
      )
    ) {

      localStatus =
        "Failed";
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

      success:
        true,

      status:
        localStatus,

      datamart:
        result
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

      success:
        false,

      status:
        "Processing",

      error:
        error.message
    };
  }
}

// =====================================================
// WALLET CREDIT
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

    const topupResult =
      await client.query(
        `
        SELECT *
        FROM wallet_topups
        WHERE reference = $1
        FOR UPDATE
        `,
        [reference]
      );

    if (
      !topupResult.rows.length
    ) {

      await client.query(
        "ROLLBACK"
      );

      return {

        success:
          false,

        message:
          "Wallet top-up not found."
      };
    }

    const topup =
      topupResult.rows[0];

    /*
     * Idempotency protection.
     */

    if (
      String(
        topup.payment_status
      ).toLowerCase() ===
      "paid"
    ) {

      await client.query(
        "COMMIT"
      );

      return {

        success:
          true,

        alreadyCredited:
          true,

        amount:
          Number(topup.amount),

        customerId:
          topup.customer_id
      };
    }

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

      await client.query(
        "ROLLBACK"
      );

      throw new Error(
        "Customer account not found."
      );
    }

    const amount =
      Number(topup.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      await client.query(
        "ROLLBACK"
      );

      throw new Error(
        "Invalid wallet top-up amount."
      );
    }

    /*
     * Credit customer wallet.
     */

    await client.query(
      `
      UPDATE customers
      SET balance =
        balance + $1
      WHERE id = $2
      `,
      [
        amount,

        topup.customer_id
      ]
    );

    /*
     * Mark payment as completed.
     */

    await client.query(
      `
      UPDATE wallet_topups
      SET
        status = 'Completed',
        payment_status = 'Paid',
        paid_at =
          COALESCE(
            paid_at,
            NOW()
          )
      WHERE id = $1
      `,
      [topup.id]
    );

    /*
     * Create wallet transaction.
     */

    await client.query(
      `
      INSERT INTO wallet_transactions
        (
          customer_id,
          type,
          amount,
          description,
          reference
        )
      VALUES
        (
          $1,
          'Credit',
          $2,
          'Wallet top-up via Paystack',
          $3
        )
      ON CONFLICT (reference)
      DO NOTHING
      `,
      [

        topup.customer_id,

        amount,

        reference
      ]
    );

    await client.query(
      "COMMIT"
    );

    console.log(
      `WALLET CREDITED: ${reference} GH₵${amount.toFixed(2)}`
    );

    return {

      success:
        true,

      alreadyCredited:
        false,

      amount,

      customerId:
        topup.customer_id
    };

  } catch (error) {

    try {

      await client.query(
        "ROLLBACK"
      );

    } catch {}

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

      if (
        !PAYSTACK_SECRET_KEY
      ) {

        return res.sendStatus(
          200
        );
      }

      const signature =
        req.headers[
          "x-paystack-signature"
        ];

      if (!signature) {

        return res.sendStatus(
          401
        );
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

        return res.sendStatus(
          401
        );
      }

      const valid =
        crypto.timingSafeEqual(
          Buffer.from(
            signature
          ),
          Buffer.from(
            expectedSignature
          )
        );

      if (!valid) {

        return res.sendStatus(
          401
        );
      }

      let event;

      try {

        event =
          JSON.parse(
            rawBody.toString("utf8")
          );

      } catch {

        return res.sendStatus(
          400
        );
      }

      if (
        event.event !==
        "charge.success"
      ) {

        return res.sendStatus(
          200
        );
      }

      const reference =
        event?.data?.reference;

      if (!reference) {

        return res.sendStatus(
          200
        );
      }

      // =================================================
      // WALLET TOP-UP
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
            event?.data?.amount || 0
          ) / 100;

        const currency =
          String(
            event?.data?.currency || ""
          ).toUpperCase();

        if (
          currency !== "GHS"
        ) {

          console.error(
            "Wallet webhook currency mismatch:",
            reference
          );

          return res.sendStatus(
            400
          );
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
            "Wallet top-up amount mismatch:",
            reference
          );

          return res.sendStatus(
            400
          );
        }

        await creditWalletFromTopup(
          reference
        );

        return res.sendStatus(
          200
        );
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

      if (
        !result.rows.length
      ) {

        return res.sendStatus(
          200
        );
      }

      const order =
        result.rows[0];

      const amountFromPaystack =
        Number(
          event?.data?.amount || 0
        ) / 100;

      const currency =
        String(
          event?.data?.currency || ""
        ).toUpperCase();

      if (
        currency !== "GHS"
      ) {

        return res.sendStatus(
          400
        );
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

        return res.sendStatus(
          400
        );
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

      await fulfillDataOrder(
        updatedResult.rows[0]
      );

      return res.sendStatus(
        200
      );

    } catch (error) {

      console.error(
        "Paystack webhook error:",
        error
      );

      return res.sendStatus(
        500
      );
    }
  }
);

// =====================================================
// BODY PARSERS
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
// AUTH - REGISTER
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
        (resolve, reject) => {

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
        (resolve, reject) => {

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

        success:
          true,

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
// AUTH - LOGIN
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
        (resolve, reject) => {

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
        (resolve, reject) => {

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

        success:
          true,

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

        success:
          true,

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
// AUTH - LOGOUT
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
              NODE_ENV === "production",

            sameSite:
              "lax",

            path: "/"
          }
        );

        res.clearCookie(
          "connect.sid",
          {
            httpOnly: true,

            secure:
              NODE_ENV === "production",

            sameSite:
              "lax",

            path: "/"
          }
        );

        return res.json({
          success:
            true
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

          return res.status(
            500
          ).json({

            success:
              false,

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

        success:
          true,

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
          [
            req.session.customerId
          ]
        );

      return res.json({

        success:
          true,

        orders:
          result.rows
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

      if (
        !result.rows.length
      ) {

        return sendError(
          res,
          404,
          "Order not found."
        );
      }

      return res.json({

        success:
          true,

        order:
          result.rows[0]
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
// PAYSTACK - INITIALIZE DATA ORDER
// =====================================================

app.post(
  "/api/payments/initialize",
  requireLogin,
  async (req, res) => {

    try {

      if (
        !PAYSTACK_SECRET_KEY
      ) {

        return sendError(
          res,
          500,
          "Paystack is not configured."
        );
      }

      const orderRef =
        String(
          req.body.orderRef ||
          ""
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
          order.payment_status
        ).toLowerCase() ===
        "paid"
      ) {

        return res.json({

          success:
            true,

          alreadyPaid:
            true,

          order
        });
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

      const amountPesewas =
        Math.round(
          Number(
            order.amount
          ) * 100
        );

      if (
        amountPesewas <= 0
      ) {

        return sendError(
          res,
          400,
          "Invalid order amount."
        );
      }

      const callbackUrl =
        `${BASE_URL}/payment-success`;

      const paystackResponse =
        await fetch(
          "https://api.paystack.co/transaction/initialize",
          {

            method:
              "POST",

            headers: {

              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({

                email:
                  customer.email,

                amount:
                  amountPesewas,

                currency:
                  "GHS",

                callback_url:
                  callbackUrl,

                metadata: {

                  type:
                    "data_order",

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
        !data.status ||
        !data.data
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

        success:
          true,

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
// PAYSTACK - VERIFY DATA ORDER
// =====================================================

app.get(
  "/api/payments/verify/:reference",
  requireLogin,
  async (req, res) => {

    try {

      if (
        !PAYSTACK_SECRET_KEY
      ) {

        return sendError(
          res,
          500,
          "Paystack is not configured."
        );
      }

      const reference =
        String(
          req.params.reference ||
          ""
        ).trim();

      if (!reference) {

        return sendError(
          res,
          400,
          "Payment reference is required."
        );
      }

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

      if (
        !orderResult.rows.length
      ) {

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
        !data.status ||
        !data.data
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

          success:
            true,

          paid:
            false,

          status:
            transaction.status,

          order
        });
      }

      const amount =
        Number(
          transaction.amount || 0
        ) / 100;

      if (
        Math.round(
          amount * 100
        ) !==
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

      const currency =
        String(
          transaction.currency || ""
        ).toUpperCase();

      if (
        currency !== "GHS"
      ) {

        return sendError(
          res,
          400,
          "Payment currency is invalid."
        );
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

          paystack_reference =
            $1,

          status =
            CASE
              WHEN status =
                'Pending Payment'
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

      if (
        String(
          order.payment_status
        ).toLowerCase() ===
          "paid" &&

        String(
          order.service
        ).toLowerCase() ===
          "data" &&

        !order.datamart_reference &&

        !order.datamart_purchase_id
      ) {

        await fulfillDataOrder(
          order
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

      return res.json({

        success:
          true,

        paid:
          true,

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
// WALLET - INITIALIZE TOP-UP
// =====================================================

app.post(
  "/api/wallet/deposit",
  requireLogin,
  async (req, res) => {

    try {

      if (
        !PAYSTACK_SECRET_KEY
      ) {

        return sendError(
          res,
          500,
          "Paystack is not configured."
        );
      }

      const amount =
        Number(
          req.body.amount
        );

      if (
        !Number.isFinite(amount)
      ) {

        return sendError(
          res,
          400,
          "Enter a valid amount."
        );
      }

      const roundedAmount =
        Math.round(
          amount * 100
        ) / 100;

      if (
        roundedAmount < 1
      ) {

        return sendError(
          res,
          400,
          "Minimum wallet top-up is GH₵1.00."
        );
      }

      if (
        roundedAmount > 10000
      ) {

        return sendError(
          res,
          400,
          "Maximum wallet top-up is GH₵10,000.00."
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

      const reference =
        createWalletReference();

      await pool.query(
        `
        INSERT INTO wallet_topups
          (
            customer_id,
            reference,
            amount,
            status,
            payment_status
          )
        VALUES
          (
            $1,
            $2,
            $3,
            'Pending',
            'Pending'
          )
        `,
        [

          customer.id,

          reference,

          roundedAmount
        ]
      );

      const amountPesewas =
        Math.round(
          roundedAmount * 100
        );

      const callbackUrl =
        `${BASE_URL}/payment-success?type=wallet&reference=${encodeURIComponent(
          reference
        )}`;

      const paystackResponse =
        await fetch(
          "https://api.paystack.co/transaction/initialize",
          {

            method:
              "POST",

            headers: {

              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({

                email:
                  customer.email,

                amount:
                  amountPesewas,

                currency:
                  "GHS",

                reference,

                callback_url:
                  callbackUrl,

                metadata: {

                  type:
                    "wallet_topup",

                  wallet_reference:
                    reference,

                  customer_id:
                    customer.id,

                  customer_email:
                    customer.email
                }
              })
          }
        );

      const data =
        await paystackResponse.json();

      if (
        !paystackResponse.ok ||
        !data.status ||
        !data.data
      ) {

        console.error(
          "Wallet Paystack initialize failed:",
          data
        );

        await pool.query(
          `
          UPDATE wallet_topups
          SET status = 'Failed'
          WHERE reference = $1
          `,
          [reference]
        );

        return sendError(
          res,
          502,
          data.message ||
            "Could not initialize wallet payment."
        );
      }

      return res.json({

        success:
          true,

        amount:
          roundedAmount,

        reference,

        authorization_url:
          data.data.authorization_url,

        access_code:
          data.data.access_code
      });

    } catch (error) {

      console.error(
        "Wallet deposit initialize error:",
        error
      );

      return sendError(
        res,
        500,
        "Wallet payment initialization failed."
      );
    }
  }
);

// =====================================================
// WALLET - VERIFY TOP-UP
// =====================================================

app.get(
  "/api/wallet/deposit/verify/:reference",
  requireLogin,
  async (req, res) => {

    try {

      if (
        !PAYSTACK_SECRET_KEY
      ) {

        return sendError(
          res,
          500,
          "Paystack is not configured."
        );
      }

      const reference =
        String(
          req.params.reference ||
          ""
        ).trim();

      if (!reference) {

        return sendError(
          res,
          400,
          "Payment reference is required."
        );
      }

      const topupResult =
        await pool.query(
          `
          SELECT *
          FROM wallet_topups
          WHERE reference = $1
            AND customer_id = $2
          LIMIT 1
          `,
          [

            reference,

            req.session.customerId
          ]
        );

      if (
        !topupResult.rows.length
      ) {

        return sendError(
          res,
          404,
          "Wallet top-up not found."
        );
      }

      const topup =
        topupResult.rows[0];

      /*
       * Already credited.
       */

      if (
        String(
          topup.payment_status
        ).toLowerCase() ===
        "paid"
      ) {

        const customer =
          await getCustomer(
            req.session.customerId
          );

        return res.json({

          success:
            true,

          paid:
            true,

          alreadyCredited:
            true,

          amount:
            Number(topup.amount),

          balance:
            Number(
              customer?.balance || 0
            ),

          reference
        });
      }

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
        !data.status ||
        !data.data
      ) {

        return sendError(
          res,
          502,
          data.message ||
            "Could not verify wallet payment."
        );
      }

      const transaction =
        data.data;

      const paid =
        transaction.status ===
        "success";

      if (!paid) {

        return res.json({

          success:
            true,

          paid:
            false,

          status:
            transaction.status,

          reference
        });
      }

      const amount =
        Number(
          transaction.amount || 0
        ) / 100;

      const expectedAmount =
        Number(
          topup.amount
        );

      if (
        Math.round(
          amount * 100
        ) !==
        Math.round(
          expectedAmount * 100
        )
      ) {

        return sendError(
          res,
          400,
          "Payment amount does not match wallet top-up."
        );
      }

      const currency =
        String(
          transaction.currency || ""
        ).toUpperCase();

      if (
        currency !== "GHS"
      ) {

        return sendError(
          res,
          400,
          "Payment currency is invalid."
        );
      }

      const creditResult =
        await creditWalletFromTopup(
          reference
        );

      const customer =
        await getCustomer(
          req.session.customerId
        );

      return res.json({

        success:
          true,

        paid:
          true,

        credited:
          !creditResult.alreadyCredited,

        amount:
          expectedAmount,

        balance:
          Number(
            customer?.balance || 0
          ),

        reference
      });

    } catch (error) {

      console.error(
        "Wallet verify error:",
        error
      );

      return sendError(
        res,
        500,
        "Wallet payment verification failed."
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

      const customer =
        await getCustomer(
          req.session.customerId
        );

      if (!customer) {

        return sendError(
          res,
          404,
          "Customer account not found."
        );
      }

      return res.json({

        success:
          true,

        balance:
          Number(
            customer.balance || 0
          )
      });

    } catch (error) {

      console.error(
        "Wallet balance error:",
        error
      );

      return sendError(
        res,
        500,
        "Could not load wallet balance."
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
            reference AS transaction_ref,
            created_at
          FROM wallet_transactions
          WHERE customer_id = $1
          ORDER BY created_at DESC
          LIMIT 50
          `,
          [
            req.session.customerId
          ]
        );

      return res.json({

        success:
          true,

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
// PAYMENT SUCCESS PAGE
//
// This page now verifies the payment before the user
// is sent back to the dashboard/account/orders.
// =====================================================

app.get(
  "/payment-success",
  (req, res) => {

    const type =
      String(
        req.query.type || ""
      ).toLowerCase();

    const reference =
      String(
        req.query.reference || ""
      ).trim();

    const isWallet =
      type === "wallet";

    const safeReference =
      escapeHtml(reference);

    const verifyEndpoint =
      isWallet
        ? `/api/wallet/deposit/verify/${encodeURIComponent(
            reference
          )}`
        : `/api/payments/verify/${encodeURIComponent(
            reference
          )}`;

    const destination =
      isWallet
        ? "/account.html"
        : "/orders.html";

    res.send(`
      <!DOCTYPE html>

      <html lang="en">

      <head>

        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0"
        >

        <title>
          Payment Processing | DHE GENIUS MEDIA
        </title>

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

            background:
              linear-gradient(
                135deg,
                #06130c,
                #0a2417,
                #020705
              );

            color: white;

            font-family:
              Arial,
              Helvetica,
              sans-serif;
          }

          .box {

            width: 100%;

            max-width: 440px;

            padding: 35px 25px;

            text-align: center;

            border-radius: 24px;

            background:
              #0c1712;

            border:
              1px solid
              rgba(255,255,255,.08);

            box-shadow:
              0 25px 70px
              rgba(0,0,0,.45);
          }

          .icon {

            width: 76px;

            height: 76px;

            margin:
              0 auto 20px;

            border-radius:
              50%;

            display:
              grid;

            place-items:
              center;

            background:
              #25d366;

            color:
              #06110b;

            font-size:
              38px;

            font-weight:
              900;
          }

          .loading {

            width: 38px;

            height: 38px;

            margin:
              0 auto 20px;

            border:
              4px solid
              rgba(255,255,255,.15);

            border-top-color:
              #25d366;

            border-radius:
              50%;

            animation:
              spin 0.8s linear infinite;
          }

          @keyframes spin {

            to {
              transform:
                rotate(360deg);
            }
          }

          h1 {
            margin:
              0 0 10px;
          }

          p {

            color:
              #9fb2a7;

            line-height:
              1.6;
          }

          .reference {

            margin-top:
              18px;

            padding:
              12px;

            border-radius:
              12px;

            background:
              #111f18;

            font-size:
              13px;

            word-break:
              break-word;
          }

          a {

            display:
              block;

            margin-top:
              15px;

            padding:
              14px;

            border-radius:
              13px;

            background:
              #25d366;

            color:
              #06110b;

            text-decoration:
              none;

            font-weight:
              900;
          }

          .secondary {

            background:
              #17251e;

            color:
              white;
          }

          .hidden {
            display:
              none;
          }

        </style>

      </head>

      <body>

        <div class="box">

          <div
            id="loadingIcon"
            class="loading"
          ></div>

          <div
            id="successIcon"
            class="icon hidden"
          >
            ✓
          </div>

          <h1 id="title">
            Verifying Payment
          </h1>

          <p id="message">
            Please wait while we securely
            confirm your payment.
          </p>

          ${
            safeReference
              ? `
                <div class="reference">
                  Reference:<br>
                  <strong>
                    ${safeReference}
                  </strong>
                </div>
              `
              : ""
          }

          <div
            id="buttons"
            class="hidden"
          >

            <a href="${destination}">
              ${
                isWallet
                  ? "View My Wallet"
                  : "View My Orders"
              }
            </a>

            <a
              href="/dashboard.html"
              class="secondary"
            >
              Back to Dashboard
            </a>

          </div>

        </div>

        <script>

          const verifyEndpoint =
            ${JSON.stringify(
              verifyEndpoint
            )};

          const destination =
            ${JSON.stringify(
              destination
            )};

          const hasReference =
            ${JSON.stringify(
              Boolean(reference)
            )};

          async function verifyPayment() {

            if (!hasReference) {

              showResult(
                false,
                "Payment reference is missing."
              );

              return;
            }

            try {

              const response =
                await fetch(
                  verifyEndpoint,
                  {
                    method: "GET",
                    credentials: "include",
                    cache: "no-store"
                  }
                );

              const data =
                await response.json();

              if (
                response.status === 401
              ) {

                showResult(
                  false,
                  "Your session has expired. Please login again."
                );

                return;
              }

              if (
                data.success &&
                data.paid
              ) {

                showResult(
                  true,
                  ${
                    isWallet
                      ? JSON.stringify(
                          "Your wallet has been successfully funded. Your balance has been updated."
                        )
                      : JSON.stringify(
                          "Your payment has been verified. Your order is now being processed."
                        )
                  }
                );

                setTimeout(
                  () => {
                    window.location.href =
                      destination;
                  },
                  1800
                );

                return;
              }

              showResult(
                false,
                data.message ||
                "Payment has not been confirmed yet. If you completed the payment, please check your account shortly."
              );

            } catch (error) {

              console.error(
                "Payment verification error:",
                error
              );

              showResult(
                false,
                "We could not verify the payment right now. Please check your account before trying to pay again."
              );
            }
          }

          function showResult(
            success,
            message
          ) {

            const loading =
              document.getElementById(
                "loadingIcon"
              );

            const successIcon =
              document.getElementById(
                "successIcon"
              );

            const title =
              document.getElementById(
                "title"
              );

            const messageElement =
              document.getElementById(
                "message"
              );

            const buttons =
              document.getElementById(
                "buttons"
              );

            loading.classList.add(
              "hidden"
            );

            successIcon.classList.toggle(
              "hidden",
              !success
            );

            title.textContent =
              success
                ? "Payment Successful"
                : "Payment Status";

            messageElement.textContent =
              message;

            buttons.classList.remove(
              "hidden"
            );
          }

          verifyPayment();

        </script>

      </body>

      </html>
    `);
  }
);

// =====================================================
// ESCAPE HTML
// =====================================================

function escapeHtml(value) {

  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  "/api/health",
  async (req, res) => {

    try {

      await pool.query(
        "SELECT 1"
      );

      return res.json({

        success:
          true,

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
            : "not configured"
      });

    } catch (error) {

      console.error(
        "Health check error:",
        error
      );

      return res.status(
        500
      ).json({

        success:
          false,

        service:
          "DHE GENIUS MEDIA",

        status:
          "online",

        database:
          "error",

        datamart:
          DATAMART_API_KEY
            ? "configured"
            : "not configured",

        paystack:
          PAYSTACK_SECRET_KEY
            ? "configured"
            : "not configured"
      });
    }
  }
);

// =====================================================
// STATIC FILES
// =====================================================

const publicDir =
  path.join(
    __dirname,
    "public"
  );

app.use(
  express.static(
    publicDir,
    {
      extensions: ["html"],

      index: false,

      redirect: false
    }
  )
);

// =====================================================
// FRONTEND ROUTES
// =====================================================

function servePage(
  fileName
) {

  return (req, res) => {

    res.sendFile(
      path.join(
        publicDir,
        fileName
      )
    );
  };
}

app.get(
  [
    "/",
    "/index.html"
  ],
  servePage(
    "index.html"
  )
);

app.get(
  [
    "/login",
    "/login.html"
  ],
  servePage(
    "login.html"
  )
);

app.get(
  [
    "/register",
    "/register.html"
  ],
  servePage(
    "register.html"
  )
);

app.get(
  [
    "/dashboard",
    "/dashboard.html"
  ],
  servePage(
    "dashboard.html"
  )
);

app.get(
  [
    "/data",
    "/buy-data",
    "/data.html"
  ],
  servePage(
    "data.html"
  )
);

app.get(
  [
    "/airtime",
    "/airtime.html"
  ],
  servePage(
    "airtime.html"
  )
);

app.get(
  [
    "/orders",
    "/orders.html"
  ],
  servePage(
    "orders.html"
  )
);

app.get(
  [
    "/account",
    "/account.html"
  ],
  servePage(
    "account.html"
  )
);

app.get(
  [
    "/service",
    "/service.html",
    "/services",
    "/services.html"
  ],
  servePage(
    "service.html"
  )
);

// =====================================================
// API 404
// =====================================================

app.use(
  "/api",
  (req, res) => {

    return res.status(
      404
    ).json({

      success:
        false,

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
      req.path.endsWith(".html") ||
      req.path.includes(".")
    ) {

      return res.status(
        404
      ).send(`

        <!DOCTYPE html>

        <html>

        <head>

          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          >

          <title>
            Page Not Found
          </title>

          <style>

            body {

              margin: 0;

              min-height: 100vh;

              display: grid;

              place-items: center;

              background:
                #07110d;

              color:
                white;

              font-family:
                Arial,
                sans-serif;

              padding:
                24px;

              text-align:
                center;
            }

            .box {
              max-width:
                430px;
            }

            h1 {

              font-size:
                58px;

              margin:
                0 0 10px;
            }

            p {

              color:
                #aab8b1;

              line-height:
                1.6;
            }

            a {

              display:
                inline-block;

              margin-top:
                18px;

              padding:
                13px 20px;

              border-radius:
                12px;

              background:
                #25d366;

              color:
                #06110b;

              text-decoration:
                none;

              font-weight:
                800;
            }

          </style>

        </head>

        <body>

          <div class="box">

            <h1>
              404
            </h1>

            <h2>
              Page not found
            </h2>

            <p>
              The page you requested
              does not exist.
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
  }
);

// =====================================================
// START SERVER
// =====================================================

async function startServer() {

  try {

    await initDatabase();

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
            DATAMART_API_KEY
              ? "configured"
              : "MISSING"
          }`
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
