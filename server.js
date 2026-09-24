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

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const DATAMART_API_KEY =
  process.env.DATAMART_API_KEY || "";

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "dgm-change-this-secret";

const NODE_ENV =
  process.env.NODE_ENV || "development";

// =====================================================
// BASIC SECURITY / PROXY
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
// DATAMART API
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

function validGhanaPhone(phone) {
  const value = cleanPhone(phone);

  return (
    /^0\d{9}$/.test(value) ||
    /^\+233\d{9}$/.test(value)
  );
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
    balance: Number(customer.balance || 0),
    created_at: customer.created_at
  };
}

function sendError(res, status, message) {
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
    "X-API-Key": DATAMART_API_KEY,
    Accept: "application/json",
    "Content-Type": "application/json"
  };

  if (idempotencyKey) {
    headers["X-Idempotency-Key"] =
      idempotencyKey;
  }

  async function makeRequest(url) {
    console.log(
      "DATAMART REQUEST:",
      {
        url,
        method,
        idempotencyKey:
          idempotencyKey || null
      }
    );

    const response = await fetch(
      url,
      {
        method,
        headers,
        body:
          body !== null
            ? JSON.stringify(body)
            : undefined
      }
    );

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
        statusCode: response.status,
        ok: response.ok,
        data
      }
    );

    return {
      response,
      data
    };
  }

  // ===================================================
  // PURCHASE
  // ===================================================

  if (
    endpoint === "/purchase" &&
    method === "POST"
  ) {
    const primary =
      await makeRequest(
        `${DATAMART_BASE}${endpoint}`
      );

    if (
      primary.response.status === 404
    ) {
      console.log(
        "DATAMART PRIMARY PURCHASE ROUTE RETURNED 404."
      );

      const developer =
        await makeRequest(
          `${DATAMART_DEVELOPER_BASE}${endpoint}`
        );

      if (!developer.response.ok) {
        const data =
          developer.data || {};

        let message =
          data.message ||
          data.error ||
          data.raw ||
          `DataMart request failed (${developer.response.status})`;

        if (
          data.currentBalance !== undefined &&
          data.requiredAmount !== undefined
        ) {
          message +=
            ` Current wallet balance: GH₵${data.currentBalance}.` +
            ` Required: GH₵${data.requiredAmount}.`;
        }

        throw new Error(message);
      }

      if (
        developer.data &&
        developer.data.status === "error"
      ) {
        let message =
          developer.data.message ||
          "DataMart purchase failed.";

        if (
          developer.data.currentBalance !== undefined &&
          developer.data.requiredAmount !== undefined
        ) {
          message +=
            ` Current wallet balance: GH₵${developer.data.currentBalance}.` +
            ` Required: GH₵${developer.data.requiredAmount}.`;
        }

        throw new Error(message);
      }

      return developer.data;
    }

    if (!primary.response.ok) {
      const data =
        primary.data || {};

      let message =
        data.message ||
        data.error ||
        data.raw ||
        `DataMart request failed (${primary.response.status})`;

      if (
        data.currentBalance !== undefined &&
        data.requiredAmount !== undefined
      ) {
        message +=
          ` Current wallet balance: GH₵${data.currentBalance}.` +
          ` Required: GH₵${data.requiredAmount}.`;
      }

      throw new Error(message);
    }

    if (
      primary.data &&
      primary.data.status === "error"
    ) {
      throw new Error(
        primary.data.message ||
        "DataMart purchase failed."
      );
    }

    return primary.data;
  }

  // ===================================================
  // OTHER DATAMART ENDPOINTS
  // ===================================================

  const result =
    await makeRequest(
      `${DATAMART_BASE}${endpoint}`
    );

  if (!result.response.ok) {
    const data =
      result.data || {};

    let message =
      data.message ||
      data.error ||
      data.raw ||
      `DataMart request failed (${result.response.status})`;

    if (
      data.currentBalance !== undefined &&
      data.requiredAmount !== undefined
    ) {
      message +=
        ` Current wallet balance: GH₵${data.currentBalance}.` +
        ` Required: GH₵${data.requiredAmount}.`;
    }

    throw new Error(message);
  }

  if (
    result.data &&
    result.data.status === "error"
  ) {
    throw new Error(
      result.data.message ||
      "DataMart request failed."
    );
  }

  return result.data;
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

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS datamart_purchase_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS datamart_reference TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS datamart_transaction_reference TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS datamart_status TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS capacity TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS paystack_reference TEXT;
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_status TEXT
    DEFAULT 'Pending';
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
  `);

  console.log(
    "Database initialized successfully."
  );
}

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
          .send("Paystack key missing");
      }

      const signature =
        req.headers[
          "x-paystack-signature"
        ];

      if (!signature) {
        return res
          .status(401)
          .send("Missing signature");
      }

      const hash =
        crypto
          .createHmac(
            "sha512",
            PAYSTACK_SECRET_KEY
          )
          .update(req.body)
          .digest("hex");

      const signaturesMatch =
        crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(hash)
        );

      if (!signaturesMatch) {
        console.error(
          "INVALID PAYSTACK WEBHOOK SIGNATURE"
        );

        return res
          .status(401)
          .send("Invalid signature");
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

      if (!orderResult.rows.length) {
        console.error(
          "PAYSTACK ORDER NOT FOUND:",
          reference
        );

        return res.sendStatus(200);
      }

      const order =
        orderResult.rows[0];

      const expectedAmount =
        Math.round(
          Number(order.amount) * 100
        );

      const paidAmount =
        Number(payment.amount);

      const currency =
        String(
          payment.currency || ""
        ).toUpperCase();

      if (
        paidAmount !== expectedAmount ||
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

      // -------------------------------------------------
      // Already fulfilled
      // -------------------------------------------------

      if (
        String(
          order.payment_status || ""
        ).toLowerCase() === "paid" &&
        order.datamart_purchase_id
      ) {
        console.log(
          "PAYMENT ALREADY PROCESSED:",
          order.order_ref
        );

        return res.sendStatus(200);
      }

      // -------------------------------------------------
      // Mark payment as paid
      // -------------------------------------------------

      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'Paid',
          status =
            CASE
              WHEN status = 'Completed'
                THEN status
              WHEN status = 'Failed'
                THEN status
              ELSE 'Paid'
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

      // -------------------------------------------------
      // Automatically deliver data
      // -------------------------------------------------

      if (
        String(
          updatedOrder.service || ""
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

      // Paystack should receive 200 so
      // the webhook is not endlessly retried.
      return res.sendStatus(200);
    }
  }
);

// =====================================================
// MIDDLEWARE
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
// SESSION
// =====================================================

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure:
        NODE_ENV === "production",
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
// STATIC WEBSITE
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
            : "not configured"
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
        cleanPhone(
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
          req.body.confirmPassword || ""
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

      req.session.customerId =
        customer.id;

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
        cleanPhone(
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

      req.session.customerId =
        customer.id;

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
        req.session.destroy(
          () => {}
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
          "connect.sid"
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
        cleanPhone(
          req.body.phone
        );

      const capacity =
        String(
          req.body.capacity ||
          req.body.data_capacity ||
          req.body.bundle ||
          ""
        ).trim();

      const amount =
        Number(
          req.body.amount
        );

      if (!service) {
        return sendError(
          res,
          400,
          "Service is required."
        );
      }

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
          !validGhanaPhone(phone)
        ) {
          return sendError(
            res,
            400,
            "Please enter a valid Ghana phone number."
          );
        }

        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return sendError(
            res,
            400,
            "Valid amount is required."
          );
        }
      } else {
        if (
          !Number.isFinite(amount) ||
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
            : undefined
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
}

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
          "Paystack is not configured on the server."
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
          order.payment_status || ""
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
          order.paystack_reference || ""
        ).trim() ||
        createTransactionReference();

      const callbackUrl =
        `${req.protocol}://${req.get("host")}/`;

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
        payment.data.authorization_url;

      const accessCode =
        payment.data.access_code;

      const paystackReference =
        payment.data.reference ||
        reference;

      if (!authorizationUrl) {
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
// DATAMART DATA FULFILLMENT
// =====================================================

async function fulfillDataOrder(order) {
  if (!order) {
    throw new Error(
      "Order not found."
    );
  }

  // ---------------------------------------------------
  // Already fulfilled
  // ---------------------------------------------------

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

  // ---------------------------------------------------
  // Payment protection
  // ---------------------------------------------------

  if (
    String(
      order.payment_status || ""
    ).toLowerCase() !== "paid"
  ) {
    throw new Error(
      "Order has not been paid."
    );
  }

  try {
    // -------------------------------------------------
    // NETWORK
    // -------------------------------------------------

    const network =
      networkMap[
        order.network
      ];

    if (!network) {
      throw new Error(
        `Unsupported network: ${order.network}`
      );
    }

    // -------------------------------------------------
    // PHONE
    // -------------------------------------------------

    const phoneNumber =
      cleanPhone(
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

    // -------------------------------------------------
    // CAPACITY
    // -------------------------------------------------

    const rawCapacity =
      String(
        order.capacity || ""
      ).trim();

    let capacity = "";

    const capacityMatch =
      rawCapacity.match(
        /^(\d+(?:\.\d+)?)\s*GB$/i
      );

    if (capacityMatch) {
      capacity =
        capacityMatch[1];
    } else if (
      /^\d+(?:\.\d+)?$/.test(
        rawCapacity
      )
    ) {
      capacity =
        rawCapacity;
    } else {
      throw new Error(
        `Invalid data capacity: ${rawCapacity}`
      );
    }

    // -------------------------------------------------
    // IDEMPOTENCY
    // -------------------------------------------------

    const idempotencyKey =
      `dgm-${order.order_ref}`;

    // -------------------------------------------------
    // SET PROCESSING
    // -------------------------------------------------

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

    // -------------------------------------------------
    // DATAMART PAYLOAD
    // -------------------------------------------------

    const payload = {
      phoneNumber,
      network,
      capacity,
      gateway: "wallet"
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

    // -------------------------------------------------
    // PURCHASE
    // -------------------------------------------------

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

    // -------------------------------------------------
    // VALIDATE
    // -------------------------------------------------

    if (
      !data ||
      data.status !== "success" ||
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

    // -------------------------------------------------
    // MAP STATUS
    // -------------------------------------------------

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

    // -------------------------------------------------
    // SAVE RESULT
    // -------------------------------------------------

    await pool.query(
      `
      UPDATE orders
      SET
        status = $1,
        datamart_purchase_id = COALESCE(
          datamart_purchase_id,
          $2
        ),
        datamart_reference = COALESCE(
          datamart_reference,
          $3
        ),
        datamart_transaction_reference = COALESCE(
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

    console.log(
      "DATAMART FULFILLMENT SUCCESS:",
      {
        orderRef:
          order.order_ref,
        purchaseId,
        datamartReference,
        datamartTransactionReference,
        datamartStatus,
        finalStatus
      }
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

    try {
      await pool.query(
        `
        UPDATE orders
        SET
          status = 'Failed',
          datamart_status = $1
        WHERE id = $2
          AND datamart_purchase_id IS NULL
        `,
        [
          `failed: ${error.message}`,
          order.id
        ]
      );
    } catch (dbError) {
      console.error(
        "DATAMART FAILURE STATUS UPDATE ERROR:",
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
// DATAMART ORDER STATUS CHECKER
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
      result.status !== "success" ||
      !result.data
    ) {
      console.error(
        "DATAMART STATUS CHECK FAILED:",
        result
      );

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

    console.log(
      "DGM ORDER STATUS UPDATED:",
      {
        orderRef:
          order.order_ref,
        datamartReference:
          order.datamart_reference,
        datamartStatus,
        dgmStatus
      }
    );

  } catch (error) {
    console.error(
      "DATAMART STATUS CHECK ERROR:",
      {
        orderRef:
          order?.order_ref,
        error:
          error.message
      }
    );
  }
}

// =====================================================
// AUTOMATIC PROCESSING ORDER CHECKER
// =====================================================

async function checkProcessingOrders() {
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
// PAYSTACK VERIFY
// =====================================================

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

      if (!result.rows.length) {
        return sendError(
          res,
          404,
          "Order for this payment was not found."
        );
      }

      const order =
        result.rows[0];

      // ------------------------------------------------
      // If already paid, do not charge again
      // ------------------------------------------------

      if (
        String(
          order.payment_status || ""
        ).toLowerCase() ===
        "paid"
      ) {
        const latestResult =
          await pool.query(
            `
            SELECT *
            FROM orders
            WHERE id = $1
            LIMIT 1
            `,
            [order.id]
          );

        return res.json({
          success: true,
          payment_status:
            latestResult.rows[0]
              .payment_status,
          order_status:
            latestResult.rows[0]
              .status,
          order:
            latestResult.rows[0]
        });
      }

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
          Number(order.amount) * 100
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
        payment.status !== "success"
      ) {
        return res.json({
          success: false,
          payment_status:
            order.payment_status ||
            "Pending",
          status:
            order.status,
          message:
            "Payment has not been completed."
        });
      }

      if (
        currency !== "GHS"
      ) {
        return sendError(
          res,
          400,
          "Payment currency is invalid."
        );
      }

      if (
        paidAmount !==
        expectedAmount
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
          status =
            CASE
              WHEN status = 'Completed'
                THEN status
              ELSE 'Paid'
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

      let fulfillment = null;

      if (
        String(
          updatedOrder.service || ""
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

      res.json({
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
      });

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
          order.payment_status || ""
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
        return sendError(
          res,
          500,
          resultData.error
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
            customer.balance || 0
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

        // ------------------------------------------------
        // DATAMART STATUS CHECKER
        // ------------------------------------------------

        setTimeout(() => {
          checkProcessingOrders();
        }, 5000);

        setInterval(() => {
          checkProcessingOrders();
        }, 30 * 1000);

        console.log(
          "DATAMART AUTOMATIC STATUS CHECKER STARTED"
        );
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
