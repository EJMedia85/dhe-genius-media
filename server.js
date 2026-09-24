const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// ENVIRONMENT VARIABLES
// =====================================================

const DATABASE_URL = process.env.DATABASE_URL || "";
const DATAMART_API_KEY = process.env.DATAMART_API_KEY || "";
const DATAMART_BASE_URL =
  process.env.DATAMART_BASE_URL || "https://api.datamartgh.com";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  process.env.JWT_SECRET ||
  "dgm-change-this-session-secret";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// =====================================================
// APP CONFIG
// =====================================================

app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

// =====================================================
// DATABASE
// =====================================================

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// =====================================================
// HELPERS
// =====================================================

function generateOrderRef(prefix = "DGM") {
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${Date.now()}-${random}`;
}

function normalizePhone(phone) {
  if (!phone) return "";

  let value = String(phone).replace(/\s+/g, "").trim();

  if (value.startsWith("+233")) {
    value = "0" + value.substring(4);
  }

  if (value.startsWith("233")) {
    value = "0" + value.substring(3);
  }

  return value;
}

function isValidGhanaPhone(phone) {
  return /^0\d{9}$/.test(phone);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    balance: Number(user.balance || 0),
    created_at: user.created_at
  };
}

function requireLogin(req, res, next) {
  if (!req.session.customerId) {
    return res.status(401).json({
      success: false,
      message: "Please login to continue."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({
      success: false,
      message: "Admin authentication required."
    });
  }

  next();
}

async function query(text, params = []) {
  return pool.query(text, params);
}

// =====================================================
// DATA BUNDLE PRICES
// =====================================================

const DATA_BUNDLES = {
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

  AIRTELTIGO: {
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

  TELECEL: {
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

// =====================================================
// DATABASE INITIALIZATION
// =====================================================

async function initializeDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        balance NUMERIC(12,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_ref VARCHAR(100) UNIQUE NOT NULL,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        service VARCHAR(100) NOT NULL,
        network VARCHAR(50),
        phone VARCHAR(20),
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'Pending',
        provider_ref VARCHAR(150),
        provider_response TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        reference VARCHAR(120) UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Pending',
        description TEXT,
        paystack_reference VARCHAR(150),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        name VARCHAR(150),
        phone VARCHAR(30),
        message TEXT NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_customer_id
      ON orders(customer_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_created_at
      ON orders(created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wallet_customer_id
      ON wallet_transactions(customer_id)
    `);

    await client.query("COMMIT");

    console.log("PostgreSQL database initialized successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Database initialization error:", error);
    throw error;
  } finally {
    client.release();
  }
}

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", async (req, res) => {
  let database = "disconnected";

  try {
    await query("SELECT 1");
    database = "connected";
  } catch (error) {
    console.error("Health database error:", error.message);
  }

  res.json({
    success: true,
    service: "DHE GENIUS MEDIA",
    status: "online",
    database,
    datamart: DATAMART_API_KEY ? "configured" : "not_configured",
    paystack: PAYSTACK_SECRET_KEY ? "configured" : "not_configured"
  });
});

// =====================================================
// PUBLIC CONFIG
// =====================================================

app.get("/api/config", (req, res) => {
  res.json({
    success: true,
    service: "DHE GENIUS MEDIA",
    paystackPublicKey: PAYSTACK_PUBLIC_KEY,
    whatsapp: "0241518385",
    call: "0508667776",
    location: "Accra - Spintex"
  });
});

// =====================================================
// DATA BUNDLES
// =====================================================

app.get("/api/data-bundles", (req, res) => {
  res.json({
    success: true,
    validity: "90 days",
    bundles: DATA_BUNDLES
  });
});

// =====================================================
// REGISTER
// =====================================================

app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || name.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Please enter your full name."
      });
    }

    if (!isValidGhanaPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Ghana phone number."
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters."
      });
    }

    const existing = await query(
      `
      SELECT id
      FROM customers
      WHERE phone = $1 OR email = $2
      LIMIT 1
      `,
      [phone, email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "An account with that phone or email already exists."
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await query(
      `
      INSERT INTO customers
      (name, phone, email, password, balance)
      VALUES ($1, $2, $3, $4, 0)
      RETURNING id, name, phone, email, balance, created_at
      `,
      [name, phone, email, hashedPassword]
    );

    const user = result.rows[0];

    req.session.customerId = user.id;

    res.status(201).json({
      success: true,
      message: "Account created successfully.",
      user: publicUser(user)
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create account.",
      error:
        process.env.NODE_ENV === "production"
          ? undefined
          : error.message
    });
  }
});

// =====================================================
// LOGIN
// =====================================================

app.post("/api/login", async (req, res) => {
  try {
    const identifier = String(req.body.identifier || "").trim();
    const password = String(req.body.password || "");

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: "Enter your phone/email and password."
      });
    }

    const normalizedPhone = normalizePhone(identifier);

    const result = await query(
      `
      SELECT *
      FROM customers
      WHERE email = $1 OR phone = $2
      LIMIT 1
      `,
      [identifier.toLowerCase(), normalizedPhone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    req.session.customerId = user.id;

    res.json({
      success: true,
      message: "Login successful.",
      user: publicUser(user)
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to login."
    });
  }
});

// =====================================================
// LOGOUT
// =====================================================

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({
      success: true,
      message: "Logged out successfully."
    });
  });
});

// =====================================================
// CURRENT CUSTOMER
// =====================================================

app.get("/api/me", requireLogin, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT id, name, phone, email, balance, created_at
      FROM customers
      WHERE id = $1
      `,
      [req.session.customerId]
    );

    if (result.rows.length === 0) {
      req.session.destroy(() => {});

      return res.status(401).json({
        success: false,
        message: "Account not found."
      });
    }

    res.json({
      success: true,
      user: publicUser(result.rows[0])
    });
  } catch (error) {
    console.error("ME ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load account."
    });
  }
});

// =====================================================
// UPDATE PROFILE
// =====================================================

app.put("/api/profile", requireLogin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);
    const email = String(req.body.email || "").trim().toLowerCase();

    if (!name || !isValidGhanaPhone(phone) || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid profile details."
      });
    }

    const duplicate = await query(
      `
      SELECT id
      FROM customers
      WHERE (phone = $1 OR email = $2)
      AND id <> $3
      LIMIT 1
      `,
      [phone, email, req.session.customerId]
    );

    if (duplicate.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Phone or email is already being used."
      });
    }

    const result = await query(
      `
      UPDATE customers
      SET name = $1,
          phone = $2,
          email = $3
      WHERE id = $4
      RETURNING id, name, phone, email, balance, created_at
      `,
      [name, phone, email, req.session.customerId]
    );

    res.json({
      success: true,
      message: "Profile updated.",
      user: publicUser(result.rows[0])
    });
  } catch (error) {
    console.error("PROFILE ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to update profile."
    });
  }
});

// =====================================================
// WALLET BALANCE
// =====================================================

app.get("/api/wallet", requireLogin, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT balance
      FROM customers
      WHERE id = $1
      `,
      [req.session.customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found."
      });
    }

    res.json({
      success: true,
      balance: Number(result.rows[0].balance || 0)
    });
  } catch (error) {
    console.error("WALLET ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load wallet."
    });
  }
});

// =====================================================
// PAYSTACK - INITIALIZE ADD MONEY
// =====================================================

app.post("/api/wallet/initialize", requireLogin, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        success: false,
        message: "Paystack is not configured."
      });
    }

    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid amount."
      });
    }

    if (amount > 10000) {
      return res.status(400).json({
        success: false,
        message: "Maximum wallet top-up is GH₵10,000."
      });
    }

    const customerResult = await query(
      `
      SELECT name, email, phone
      FROM customers
      WHERE id = $1
      `,
      [req.session.customerId]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer account not found."
      });
    }

    const customer = customerResult.rows[0];

    const reference = generateOrderRef("DGM-WALLET");

    await query(
      `
      INSERT INTO wallet_transactions
      (
        customer_id,
        reference,
        type,
        amount,
        status,
        description
      )
      VALUES ($1, $2, 'Wallet Top Up', $3, 'Pending', $4)
      `,
      [
        req.session.customerId,
        reference,
        amount,
        "Wallet top-up via Paystack"
      ]
    );

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: customer.email,
          amount: Math.round(amount * 100),
          reference,
          currency: "GHS",
          metadata: {
            customer_id: req.session.customerId,
            customer_phone: customer.phone,
            type: "wallet_topup"
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      console.error("PAYSTACK INITIALIZE ERROR:", data);

      await query(
        `
        UPDATE wallet_transactions
        SET status = 'Failed'
        WHERE reference = $1
        `,
        [reference]
      );

      return res.status(502).json({
        success: false,
        message: data.message || "Unable to initialize payment."
      });
    }

    res.json({
      success: true,
      reference,
      authorization_url: data.data.authorization_url,
      access_code: data.data.access_code
    });
  } catch (error) {
    console.error("WALLET INITIALIZE ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to initialize wallet payment."
    });
  }
});

// =====================================================
// PAYSTACK - VERIFY WALLET PAYMENT
// =====================================================

app.get("/api/wallet/verify/:reference", requireLogin, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        success: false,
        message: "Paystack is not configured."
      });
    }

    const reference = String(req.params.reference || "").trim();

    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Payment reference is required."
      });
    }

    const transactionResult = await query(
      `
      SELECT *
      FROM wallet_transactions
      WHERE reference = $1
      AND customer_id = $2
      LIMIT 1
      `,
      [reference, req.session.customerId]
    );

    if (transactionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Wallet transaction not found."
      });
    }

    const walletTransaction = transactionResult.rows[0];

    if (walletTransaction.status === "Completed") {
      return res.json({
        success: true,
        message: "Payment has already been credited.",
        status: "Completed"
      });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(
        reference
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(502).json({
        success: false,
        message: data.message || "Unable to verify payment."
      });
    }

    const payment = data.data;

    if (payment.status !== "success") {
      await query(
        `
        UPDATE wallet_transactions
        SET status = $1,
            paystack_reference = $2
        WHERE reference = $3
        `,
        [
          payment.status === "failed" ? "Failed" : "Pending",
          payment.reference || reference,
          reference
        ]
      );

      return res.json({
        success: true,
        status: payment.status,
        message: "Payment has not been completed."
      });
    }

    const paidAmount = Number(payment.amount) / 100;
    const expectedAmount = Number(walletTransaction.amount);

    if (Math.abs(paidAmount - expectedAmount) > 0.01) {
      await query(
        `
        UPDATE wallet_transactions
        SET status = 'Failed',
            paystack_reference = $1,
            description = 'Amount mismatch detected'
        WHERE reference = $2
        `,
        [payment.reference || reference, reference]
      );

      return res.status(400).json({
        success: false,
        message: "Payment amount could not be verified."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const locked = await client.query(
        `
        SELECT *
        FROM wallet_transactions
        WHERE reference = $1
        AND customer_id = $2
        FOR UPDATE
        `,
        [reference, req.session.customerId]
      );

      if (locked.rows.length === 0) {
        throw new Error("Wallet transaction disappeared.");
      }

      if (locked.rows[0].status === "Completed") {
        await client.query("COMMIT");

        return res.json({
          success: true,
          status: "Completed",
          message: "Payment already credited."
        });
      }

      await client.query(
        `
        UPDATE customers
        SET balance = balance + $1
        WHERE id = $2
        `,
        [paidAmount, req.session.customerId]
      );

      await client.query(
        `
        UPDATE wallet_transactions
        SET status = 'Completed',
            paystack_reference = $1
        WHERE reference = $2
        `,
        [payment.reference || reference, reference]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        status: "Completed",
        amount: paidAmount,
        message: "Wallet credited successfully."
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("WALLET VERIFY ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to verify wallet payment."
    });
  }
});

// =====================================================
// WALLET TRANSACTIONS
// =====================================================

app.get(
  "/api/wallet/transactions",
  requireLogin,
  async (req, res) => {
    try {
      const result = await query(
        `
        SELECT
          reference,
          type,
          amount,
          status,
          description,
          created_at
        FROM wallet_transactions
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [req.session.customerId]
      );

      res.json({
        success: true,
        transactions: result.rows
      });
    } catch (error) {
      console.error("WALLET TRANSACTIONS ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Unable to load wallet transactions."
      });
    }
  }
);

// =====================================================
// CREATE DATA ORDER
// =====================================================

app.post("/api/orders/data", requireLogin, async (req, res) => {
  const client = await pool.connect();

  try {
    const network = String(req.body.network || "")
      .trim()
      .toUpperCase();

    const phone = normalizePhone(req.body.phone);
    const size = Number(req.body.size);

    if (!DATA_BUNDLES[network]) {
      return res.status(400).json({
        success: false,
        message: "Invalid network."
      });
    }

    if (!isValidGhanaPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Ghana phone number."
      });
    }

    if (
      !Number.isFinite(size) ||
      !Object.prototype.hasOwnProperty.call(DATA_BUNDLES[network], size)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid data bundle."
      });
    }

    const amount = Number(DATA_BUNDLES[network][size]);
    const orderRef = generateOrderRef("DGM-DATA");

    await client.query("BEGIN");

    const customerResult = await client.query(
      `
      SELECT balance
      FROM customers
      WHERE id = $1
      FOR UPDATE
      `,
      [req.session.customerId]
    );

    if (customerResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Customer account not found."
      });
    }

    const balance = Number(customerResult.rows[0].balance || 0);

    if (balance < amount) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance."
      });
    }

    await client.query(
      `
      UPDATE customers
      SET balance = balance - $1
      WHERE id = $2
      `,
      [amount, req.session.customerId]
    );

    await client.query(
      `
      INSERT INTO orders
      (
        order_ref,
        customer_id,
        service,
        network,
        phone,
        amount,
        status
      )
      VALUES
      ($1, $2, 'Data Bundle', $3, $4, $5, 'Pending')
      `,
      [
        orderRef,
        req.session.customerId,
        network,
        phone,
        amount
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Data order received.",
      order: {
        order_ref: orderRef,
        service: "Data Bundle",
        network,
        phone,
        size,
        amount,
        status: "Pending"
      }
    });

    // Delivery is intentionally started after the transaction is safely committed.
    deliverDataOrder(orderRef).catch((error) => {
      console.error("DATA DELIVERY ERROR:", error);
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("DATA ORDER ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create data order."
    });
  } finally {
    client.release();
  }
});

// =====================================================
// DATAMART DELIVERY
// =====================================================

async function deliverDataOrder(orderRef) {
  if (!DATAMART_API_KEY) {
    console.log(
      `DataMart API key not configured. Order ${orderRef} remains Pending.`
    );
    return;
  }

  try {
    const orderResult = await query(
      `
      SELECT *
      FROM orders
      WHERE order_ref = $1
      LIMIT 1
      `,
      [orderRef]
    );

    if (orderResult.rows.length === 0) {
      return;
    }

    const order = orderResult.rows[0];

    await query(
      `
      UPDATE orders
      SET status = 'Processing',
          updated_at = NOW()
      WHERE order_ref = $1
      `,
      [orderRef]
    );

    /*
      IMPORTANT:
      Keep the provider request isolated here.

      DataMart's exact endpoint/request format can differ according
      to the API product/account being used. This code first checks
      the configured API and safely records the response.

      Update the endpoint/body below with the exact DataMart API
      documentation for your active account before enabling automatic
      delivery.
    */

    const response = await fetch(
      `${DATAMART_BASE_URL}/api/data`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DATAMART_API_KEY}`,
          "x-api-key": DATAMART_API_KEY
        },
        body: JSON.stringify({
          network: order.network,
          phone: order.phone,
          amount: Number(order.amount),
          order_ref: order.order_ref
        })
      }
    );

    const responseText = await response.text();

    let providerData;

    try {
      providerData = JSON.parse(responseText);
    } catch (_) {
      providerData = {
        raw: responseText
      };
    }

    if (!response.ok) {
      await query(
        `
        UPDATE orders
        SET status = 'Failed',
            provider_response = $1,
            updated_at = NOW()
        WHERE order_ref = $2
        `,
        [
          JSON.stringify(providerData),
          orderRef
        ]
      );

      return;
    }

    const providerStatus = String(
      providerData.status ||
        providerData.data?.status ||
        ""
    ).toLowerCase();

    let finalStatus = "Processing";

    if (
      providerStatus === "success" ||
      providerStatus === "successful" ||
      providerStatus === "completed"
    ) {
      finalStatus = "Completed";
    }

    if (
      providerStatus === "failed" ||
      providerStatus === "error"
    ) {
      finalStatus = "Failed";
    }

    await query(
      `
      UPDATE orders
      SET status = $1,
          provider_ref = $2,
          provider_response = $3,
          updated_at = NOW()
      WHERE order_ref = $4
      `,
      [
        finalStatus,
        String(
          providerData.reference ||
            providerData.transaction_id ||
            providerData.data?.reference ||
            ""
        ),
        JSON.stringify(providerData),
        orderRef
      ]
    );
  } catch (error) {
    console.error("DATAMART ERROR:", error);

    await query(
      `
      UPDATE orders
      SET status = 'Failed',
          provider_response = $1,
          updated_at = NOW()
      WHERE order_ref = $2
      `,
      [
        JSON.stringify({
          error: error.message
        }),
        orderRef
      ]
    );
  }
}

// =====================================================
// ORDERS
// =====================================================

app.get("/api/orders", requireLogin, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        order_ref,
        service,
        network,
        phone,
        amount,
        status,
        created_at,
        updated_at
      FROM orders
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [req.session.customerId]
    );

    res.json({
      success: true,
      orders: result.rows
    });
  } catch (error) {
    console.error("ORDERS ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load orders."
    });
  }
});

// =====================================================
// SINGLE ORDER
// =====================================================

app.get(
  "/api/orders/:reference",
  requireLogin,
  async (req, res) => {
    try {
      const result = await query(
        `
        SELECT
          order_ref,
          service,
          network,
          phone,
          amount,
          status,
          provider_ref,
          created_at,
          updated_at
        FROM orders
        WHERE order_ref = $1
        AND customer_id = $2
        LIMIT 1
        `,
        [
          req.params.reference,
          req.session.customerId
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Order not found."
        });
      }

      res.json({
        success: true,
        order: result.rows[0]
      });
    } catch (error) {
      console.error("ORDER DETAILS ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Unable to load order."
      });
    }
  }
);

// =====================================================
// AIRTIME ORDER
// =====================================================

app.post("/api/orders/airtime", requireLogin, async (req, res) => {
  const client = await pool.connect();

  try {
    const network = String(req.body.network || "")
      .trim()
      .toUpperCase();

    const phone = normalizePhone(req.body.phone);
    const amount = Number(req.body.amount);

    if (!["MTN", "AIRTELTIGO", "TELECEL"].includes(network)) {
      return res.status(400).json({
        success: false,
        message: "Invalid network."
      });
    }

    if (!isValidGhanaPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Ghana phone number."
      });
    }

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid airtime amount."
      });
    }

    if (amount > 1000) {
      return res.status(400).json({
        success: false,
        message: "Maximum airtime order is GH₵1,000."
      });
    }

    const orderRef = generateOrderRef("DGM-AIRTIME");

    await client.query("BEGIN");

    const customerResult = await client.query(
      `
      SELECT balance
      FROM customers
      WHERE id = $1
      FOR UPDATE
      `,
      [req.session.customerId]
    );

    if (customerResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Customer account not found."
      });
    }

    const balance = Number(customerResult.rows[0].balance || 0);

    if (balance < amount) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance."
      });
    }

    await client.query(
      `
      UPDATE customers
      SET balance = balance - $1
      WHERE id = $2
      `,
      [amount, req.session.customerId]
    );

    await client.query(
      `
      INSERT INTO orders
      (
        order_ref,
        customer_id,
        service,
        network,
        phone,
        amount,
        status
      )
      VALUES
      ($1, $2, 'Airtime', $3, $4, $5, 'Pending')
      `,
      [
        orderRef,
        req.session.customerId,
        network,
        phone,
        amount
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Airtime order received.",
      order: {
        order_ref: orderRef,
        service: "Airtime",
        network,
        phone,
        amount,
        status: "Pending"
      }
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("AIRTIME ORDER ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create airtime order."
    });
  } finally {
    client.release();
  }
});

// =====================================================
// DASHBOARD
// =====================================================

app.get("/api/dashboard", requireLogin, async (req, res) => {
  try {
    const customerResult = await query(
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
      [req.session.customerId]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found."
      });
    }

    const ordersResult = await query(
      `
      SELECT
        order_ref,
        service,
        network,
        phone,
        amount,
        status,
        created_at
      FROM orders
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 5
      `,
      [req.session.customerId]
    );

    const transactionResult = await query(
      `
      SELECT
        reference,
        type,
        amount,
        status,
        description,
        created_at
      FROM wallet_transactions
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 5
      `,
      [req.session.customerId]
    );

    res.json({
      success: true,
      user: publicUser(customerResult.rows[0]),
      recentOrders: ordersResult.rows,
      recentTransactions: transactionResult.rows,
      services: {
        data: true,
        airtime: true,
        wallet: Boolean(PAYSTACK_SECRET_KEY),
        datamart: Boolean(DATAMART_API_KEY)
      }
    });
  } catch (error) {
    console.error("DASHBOARD ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load dashboard."
    });
  }
});

// =====================================================
// SUPPORT
// =====================================================

app.post("/api/support", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);
    const message = String(req.body.message || "").trim();

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Please enter your message."
      });
    }

    await query(
      `
      INSERT INTO support_messages
      (
        customer_id,
        name,
        phone,
        message
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        req.session.customerId || null,
        name || null,
        phone || null,
        message
      ]
    );

    res.json({
      success: true,
      message: "Support message sent successfully."
    });
  } catch (error) {
    console.error("SUPPORT ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to send support message."
    });
  }
});

// =====================================================
// ADMIN LOGIN
// =====================================================

app.post("/api/admin/login", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      return res.status(503).json({
        success: false,
        message: "Admin credentials are not configured."
      });
    }

    if (
      email !== ADMIN_EMAIL.toLowerCase() ||
      password !== ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid admin credentials."
      });
    }

    req.session.admin = true;

    res.json({
      success: true,
      message: "Admin login successful."
    });
  } catch (error) {
    console.error("ADMIN LOGIN ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to login as admin."
    });
  }
});

// =====================================================
// ADMIN LOGOUT
// =====================================================

app.post("/api/admin/logout", (req, res) => {
  req.session.admin = false;

  res.json({
    success: true,
    message: "Admin logged out."
  });
});

// =====================================================
// ADMIN ORDERS
// =====================================================

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        o.id,
        o.order_ref,
        o.service,
        o.network,
        o.phone,
        o.amount,
        o.status,
        o.provider_ref,
        o.created_at,
        o.updated_at,
        c.name AS customer_name,
        c.email AS customer_email,
        c.phone AS customer_phone
      FROM orders o
      JOIN customers c
        ON c.id = o.customer_id
      ORDER BY o.created_at DESC
      LIMIT 500
    `);

    res.json({
      success: true,
      orders: result.rows
    });
  } catch (error) {
    console.error("ADMIN ORDERS ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load admin orders."
    });
  }
});

// =====================================================
// ADMIN UPDATE ORDER
// =====================================================

app.patch(
  "/api/admin/orders/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const status = String(req.body.status || "").trim();

      const allowedStatuses = [
        "Pending",
        "Processing",
        "Completed",
        "Failed"
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid order status."
        });
      }

      const result = await query(
        `
        UPDATE orders
        SET status = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [status, req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Order not found."
        });
      }

      res.json({
        success: true,
        message: "Order updated.",
        order: result.rows[0]
      });
    } catch (error) {
      console.error("ADMIN ORDER UPDATE ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Unable to update order."
      });
    }
  }
);

// =====================================================
// STATIC PUBLIC FILES
// =====================================================

const publicDirectory = path.join(__dirname, "public");

app.use(express.static(publicDirectory, {
  extensions: ["html"]
}));

// =====================================================
// IMPORTANT PAGE ROUTES
// =====================================================

// These explicit routes make sure pages such as
// /add-money.html are served correctly.

const publicPages = [
  "index.html",
  "login.html",
  "register.html",
  "dashboard.html",
  "data.html",
  "airtime.html",
  "orders.html",
  "account.html",
  "add-money.html",
  "services.html",
  "support.html",
  "admin.html"
];

for (const page of publicPages) {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(publicDirectory, page), (error) => {
      if (error && !res.headersSent) {
        res.status(404).send("Page not found");
      }
    });
  });
}

// =====================================================
// ROOT
// =====================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDirectory, "index.html"), (error) => {
    if (error && !res.headersSent) {
      res.status(404).send("DHE GENIUS MEDIA homepage not found.");
    }
  });
});

// =====================================================
// 404 API HANDLER
// =====================================================

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

// =====================================================
// GENERAL 404
// =====================================================

app.use((req, res) => {
  res.status(404).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Page Not Found • DHE GENIUS MEDIA</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #07110d;
            color: white;
            font-family: Arial, sans-serif;
            text-align: center;
          }

          .box {
            max-width: 420px;
            padding: 30px;
          }

          h1 {
            font-size: 52px;
            margin: 0 0 10px;
          }

          p {
            color: #b8c8c0;
            line-height: 1.6;
          }

          a {
            display: inline-block;
            margin-top: 15px;
            padding: 12px 20px;
            border-radius: 10px;
            background: #25d366;
            color: #06100b;
            text-decoration: none;
            font-weight: bold;
          }
        </style>
      </head>

      <body>
        <div class="box">
          <h1>404</h1>
          <h2>Page Not Found</h2>
          <p>
            The page you requested does not exist on
            DHE GENIUS MEDIA.
          </p>
          <a href="/">Go Home</a>
        </div>
      </body>
    </html>
  `);
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });
});

// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log("=================================================");
      console.log("DHE GENIUS MEDIA");
      console.log("Server running on port:", PORT);
      console.log("Environment:", process.env.NODE_ENV || "development");
      console.log("Database:", DATABASE_URL ? "configured" : "missing");
      console.log(
        "DataMart:",
        DATAMART_API_KEY ? "configured" : "not configured"
      );
      console.log(
        "Paystack:",
        PAYSTACK_SECRET_KEY ? "configured" : "not configured"
      );
      console.log("Public directory:", publicDirectory);
      console.log("=================================================");
    });
  } catch (error) {
    console.error("FAILED TO START SERVER:", error);
    process.exit(1);
  }
}

startServer();
