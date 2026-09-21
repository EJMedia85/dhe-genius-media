const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// DATABASE
// ===============================

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ===============================
// CREATE TABLES
// ===============================

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_ref TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      service TEXT NOT NULL,
      network TEXT,
      phone TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (customer_id)
        REFERENCES customers(id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      transaction_ref TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      balance_before NUMERIC(12,2) NOT NULL,
      balance_after NUMERIC(12,2) NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (customer_id)
        REFERENCES customers(id)
        ON DELETE CASCADE
    );
  `);

  console.log("DGM PostgreSQL database ready.");
}

// ===============================
// APP SETTINGS
// ===============================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      "DGM_CHANGE_THIS_SECRET_BEFORE_PRODUCTION",

    resave: false,
    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

// ===============================
// STATIC WEBSITE
// ===============================

app.use(express.static(path.join(__dirname, "public")));

// ===============================
// HELPERS
// ===============================

function cleanPhone(phone) {
  return String(phone || "").trim();
}

function validGhanaPhone(phone) {
  return /^(0\d{9}|\+233\d{9})$/.test(phone);
}

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function requireLogin(req, res, next) {
  if (!req.session.customerId) {
    return res.status(401).json({
      success: false,
      message: "Please log in first."
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
    `,
    [customerId]
  );

  return result.rows[0];
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

function createOrderReference() {
  return (
    "DGM-" +
    Date.now() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

function createTransactionReference() {
  return (
    "DGM-WALLET-" +
    Date.now() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

// ===============================
// HEALTH CHECK
// ===============================

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      service: "DHE GENIUS MEDIA",
      status: "online",
      database: "connected"
    });
  } catch (error) {
    console.error("HEALTH ERROR:", error);

    res.status(500).json({
      success: false,
      service: "DHE GENIUS MEDIA",
      status: "database_error"
    });
  }
});

// ===============================
// REGISTER
// ===============================

app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = cleanPhone(req.body.phone);
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    if (!name || name.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Please enter your full name."
      });
    }

    if (!validGhanaPhone(phone)) {
      return res.status(400).json({
        success: false,
        message:
          "Enter a valid Ghana phone number, e.g. 0241234567 or +233241234567."
      });
    }

    if (!email || !email.includes("@") || !email.includes(".")) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least 8 characters."
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match."
      });
    }

    const existingPhone = await pool.query(
      "SELECT id FROM customers WHERE phone = $1",
      [phone]
    );

    if (existingPhone.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "This phone number is already registered."
      });
    }

    const existingEmail = await pool.query(
      "SELECT id FROM customers WHERE email = $1",
      [email]
    );

    if (existingEmail.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "This email address is already registered."
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO customers
      (name, phone, email, password)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [name, phone, email, hashedPassword]
    );

    const customerId = result.rows[0].id;

    req.session.customerId = customerId;

    const customer = await getCustomer(customerId);

    res.json({
      success: true,
      message: "Account created successfully.",
      customer: publicCustomer(customer)
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create account."
    });
  }
});

// ===============================
// LOGIN
// ===============================

app.post("/api/login", async (req, res) => {
  try {
    const identifier = String(req.body.identifier || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: "Enter your phone/email and password."
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM customers
      WHERE LOWER(email) = $1
         OR LOWER(phone) = $1
      LIMIT 1
      `,
      [identifier]
    );

    const customer = result.rows[0];

    if (!customer) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    const passwordCorrect = await bcrypt.compare(
      password,
      customer.password
    );

    if (!passwordCorrect) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    req.session.customerId = customer.id;

    res.json({
      success: true,
      message: "Login successful.",
      customer: publicCustomer(customer)
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to log in."
    });
  }
});

// ===============================
// CURRENT CUSTOMER
// ===============================

app.get("/api/me", requireLogin, async (req, res) => {
  try {
    const customer = await getCustomer(req.session.customerId);

    if (!customer) {
      req.session.destroy(() => {});

      return res.status(401).json({
        success: false,
        message: "Account not found."
      });
    }

    res.json({
      success: true,
      customer: publicCustomer(customer)
    });
  } catch (error) {
    console.error("ME ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load account."
    });
  }
});

// ===============================
// LOGOUT
// ===============================

app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Unable to sign out."
      });
    }

    res.clearCookie("connect.sid");

    res.json({
      success: true,
      message: "Signed out successfully."
    });
  });
});

// ===============================
// CUSTOMER ORDERS
// ===============================

app.get("/api/orders", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        order_ref,
        service,
        network,
        phone,
        amount,
        status,
        created_at
      FROM orders
      WHERE customer_id = $1
      ORDER BY id DESC
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

// ===============================
// CREATE ORDER
// ===============================

app.post("/api/orders", requireLogin, async (req, res) => {
  try {
    const service = String(req.body.service || "").trim();
    const network = String(req.body.network || "").trim();
    const phone = cleanPhone(req.body.phone);
    const amount = Number(req.body.amount);

    const allowedServices = [
      "Data Bundle",
      "Airtime"
    ];

    const allowedNetworks = [
      "MTN",
      "AirtelTigo",
      "Telecel"
    ];

    if (!allowedServices.includes(service)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service."
      });
    }

    if (!allowedNetworks.includes(network)) {
      return res.status(400).json({
        success: false,
        message: "Please select a valid network."
      });
    }

    if (!validGhanaPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Ghana phone number."
      });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid amount."
      });
    }

    if (amount > 10000) {
      return res.status(400).json({
        success: false,
        message: "Order amount is too high."
      });
    }

    const orderRef = createOrderReference();

    const result = await pool.query(
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
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      [
        orderRef,
        req.session.customerId,
        service,
        network,
        phone,
        amount,
        "Pending"
      ]
    );

    const orderResult = await pool.query(
      `
      SELECT
        id,
        order_ref,
        service,
        network,
        phone,
        amount,
        status,
        created_at
      FROM orders
      WHERE id = $1
      `,
      [result.rows[0].id]
    );

    res.json({
      success: true,
      message: "Order received successfully.",
      order: orderResult.rows[0]
    });
  } catch (error) {
    console.error("ORDER ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create order."
    });
  }
});

// ===============================
// WALLET BALANCE
// ===============================

app.get("/api/wallet", requireLogin, async (req, res) => {
  try {
    const customer = await getCustomer(req.session.customerId);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    res.json({
      success: true,
      balance: Number(customer.balance || 0)
    });
  } catch (error) {
    console.error("WALLET ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load wallet."
    });
  }
});

// ===============================
// WALLET TRANSACTIONS
// ===============================

app.get(
  "/api/wallet/transactions",
  requireLogin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          id,
          transaction_ref,
          type,
          amount,
          balance_before,
          balance_after,
          description,
          status,
          created_at
        FROM wallet_transactions
        WHERE customer_id = $1
        ORDER BY id DESC
        `,
        [req.session.customerId]
      );

      res.json({
        success: true,
        transactions: result.rows
      });
    } catch (error) {
      console.error("WALLET HISTORY ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Unable to load wallet transactions."
      });
    }
  }
);

// ===============================
// API 404
// ===============================

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

// ===============================
// START SERVER
// ===============================

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `DHE GENIUS MEDIA server running on port ${PORT}`
      );
    });
  })
  .catch((error) => {
    console.error("DATABASE INITIALIZATION ERROR:", error);
    process.exit(1);
  });
