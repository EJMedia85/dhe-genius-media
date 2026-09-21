const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// DATABASE
// ===============================

const db = new Database("dgm.sqlite");

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_ref TEXT NOT NULL UNIQUE,
    customer_id INTEGER NOT NULL,
    service TEXT NOT NULL,
    network TEXT,
    phone TEXT,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'Pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );
`);

// ===============================
// EXPRESS SETTINGS
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
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

// ===============================
// STATIC WEBSITE
// ===============================

app.use(express.static(path.join(__dirname, "public")));

// ===============================
// HELPER FUNCTIONS
// ===============================

function cleanPhone(phone) {
  return String(phone || "").replace(/\s+/g, "").trim();
}

function validGhanaPhone(phone) {
  return /^(0\d{9}|\+233\d{9})$/.test(phone);
}

function requireLogin(req, res, next) {
  if (!req.session.customerId) {
    return res.status(401).json({
      success: false,
      message: "Please log in to continue."
    });
  }

  next();
}

function getCustomer(customerId) {
  return db
    .prepare(
      `
      SELECT
        id,
        name,
        phone,
        email,
        balance,
        created_at
      FROM customers
      WHERE id = ?
    `
    )
    .get(customerId);
}

// ===============================
// HEALTH CHECK
// ===============================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "DHE GENIUS MEDIA",
    status: "online"
  });
});

// ===============================
// REGISTER
// ===============================

app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = cleanPhone(req.body.phone);
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    const confirmPassword = String(
      req.body.confirmPassword || ""
    );

    if (!name || !phone || !email || !password || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Please fill in all required fields."
      });
    }

    if (!validGhanaPhone(phone)) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid Ghana phone number."
      });
    }

    if (!email.includes("@")) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message:
          "Password must contain at least 8 characters."
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match."
      });
    }

    const existingPhone = db
      .prepare("SELECT id FROM customers WHERE phone = ?")
      .get(phone);

    if (existingPhone) {
      return res.status(409).json({
        success: false,
        message:
          "An account already exists with this phone number."
      });
    }

    const existingEmail = db
      .prepare("SELECT id FROM customers WHERE email = ?")
      .get(email);

    if (existingEmail) {
      return res.status(409).json({
        success: false,
        message:
          "An account already exists with this email."
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const result = db
      .prepare(
        `
        INSERT INTO customers
        (name, phone, email, password)
        VALUES (?, ?, ?, ?)
      `
      )
      .run(
        name,
        phone,
        email,
        hashedPassword
      );

    req.session.customerId = result.lastInsertRowid;

    const customer = getCustomer(
      result.lastInsertRowid
    );

    res.status(201).json({
      success: true,
      message: "Account created successfully.",
      customer
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
    const identifier = String(
      req.body.identifier || ""
    )
      .trim()
      .toLowerCase();

    const password = String(
      req.body.password || ""
    );

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter your phone/email and password."
      });
    }

    const customer = db
      .prepare(
        `
        SELECT *
        FROM customers
        WHERE phone = ?
           OR email = ?
      `
      )
      .get(identifier, identifier);

    if (!customer) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    const passwordMatch = await bcrypt.compare(
      password,
      customer.password
    );

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    req.session.customerId = customer.id;

    const safeCustomer = getCustomer(
      customer.id
    );

    res.json({
      success: true,
      message: "Login successful.",
      customer: safeCustomer
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

app.get(
  "/api/me",
  requireLogin,
  (req, res) => {
    const customer = getCustomer(
      req.session.customerId
    );

    if (!customer) {
      req.session.destroy(() => {});

      return res.status(401).json({
        success: false,
        message: "Account not found."
      });
    }

    res.json({
      success: true,
      customer
    });
  }
);

// ===============================
// LOGOUT
// ===============================

app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Unable to log out."
      });
    }

    res.clearCookie("connect.sid");

    res.json({
      success: true,
      message: "Logged out successfully."
    });
  });
});

// ===============================
// CUSTOMER ORDERS
// ===============================

app.get(
  "/api/orders",
  requireLogin,
  (req, res) => {
    const orders = db
      .prepare(
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
        WHERE customer_id = ?
        ORDER BY created_at DESC
      `
      )
      .all(req.session.customerId);

    res.json({
      success: true,
      orders
    });
  }
);

// ===============================
// CREATE ORDER
// ===============================

app.post(
  "/api/orders",
  requireLogin,
  (req, res) => {
    try {
      const service = String(
        req.body.service || ""
      ).trim();

      const network = String(
        req.body.network || ""
      ).trim();

      const phone = cleanPhone(
        req.body.phone
      );

      const amount = Number(
        req.body.amount
      );

      if (!service || !phone || !amount) {
        return res.status(400).json({
          success: false,
          message:
            "Missing order information."
        });
      }

      if (!validGhanaPhone(phone)) {
        return res.status(400).json({
          success: false,
          message:
            "Please enter a valid Ghana phone number."
        });
      }

      if (amount <= 0) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid order amount."
        });
      }

      const orderRef =
        "DGM-" +
        Date.now() +
        "-" +
        Math.floor(
          Math.random() * 1000
        );

      db.prepare(
        `
        INSERT INTO orders
        (
          order_ref,
          customer_id,
          service,
          network,
          phone,
          amount
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run(
        orderRef,
        req.session.customerId,
        service,
        network,
        phone,
        amount
      );

      res.status(201).json({
        success: true,
        message: "Order received.",
        orderRef,
        status: "Pending"
      });
    } catch (error) {
      console.error("ORDER ERROR:", error);

      res.status(500).json({
        success: false,
        message:
          "Unable to create order."
      });
    }
  }
);

// ===============================
// 404 API RESPONSE
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

app.listen(PORT, () => {
  console.log(
    `DHE GENIUS MEDIA server running on port ${PORT}`
  );
});
