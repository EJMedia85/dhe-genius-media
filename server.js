const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL || "";

const DATAMART_API_KEY =
  process.env.DATAMART_API_KEY || "";

const DATAMART_API_SECRET =
  process.env.DATAMART_API_SECRET || "";

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "dgm-change-this-secret";

const DATAMART_BASE =
  "https://api.datamartgh.shop/api/developer";


// =====================================================
// DATABASE
// =====================================================

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


// =====================================================
// MIDDLEWARE
// =====================================================

// Paystack webhook MUST come before express.json()
// because Paystack signature verification needs
// the original raw request body.

app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {

    try {

      if (!PAYSTACK_SECRET_KEY) {
        return res.status(500).send("Paystack key missing");
      }

      const signature =
        req.headers["x-paystack-signature"];

      const hash =
        crypto
          .createHmac(
            "sha512",
            PAYSTACK_SECRET_KEY
          )
          .update(req.body)
          .digest("hex");

      if (
        !signature ||
        signature !== hash
      ) {
        return res
          .status(401)
          .send("Invalid signature");
      }

      const event =
        JSON.parse(req.body.toString());

      if (
        event.event !== "charge.success"
      ) {
        return res.sendStatus(200);
      }

      const payment =
        event.data || {};

      const reference =
        payment.reference;

      if (!reference) {
        return res.sendStatus(200);
      }

      const orderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE order_ref = $1
             OR paystack_reference = $1
          LIMIT 1
          `,
          [reference]
        );

      if (!orderResult.rows.length) {
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
          "PAYSTACK WEBHOOK AMOUNT/CURRENCY MISMATCH"
        );

        return res.sendStatus(200);
      }

      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'Paid',
          status = 'Paid',
          paystack_reference = $1,
          paid_at = NOW()
        WHERE id = $2
        `,
        [
          reference,
          order.id
        ]
      );

      await fulfillDataOrder(order);

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


// Normal JSON middleware

app.use(
  express.json()
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax"
    }
  })
);


// =====================================================
// STATIC WEBSITE
// =====================================================

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


// =====================================================
// HELPERS
// =====================================================

function cleanPhone(phone) {

  return String(phone || "")
    .trim()
    .replace(/\s+/g, "");
}


function validGhanaPhone(phone) {

  const value =
    cleanPhone(phone);

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
    Math.floor(
      100000 +
      Math.random() * 900000
    )
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
  );
}


function requireLogin(req, res, next) {

  if (!req.session.customerId) {

    return res.status(401).json({
      error: "Please log in first."
    });
  }

  next();
}


async function getCustomer(customerId) {

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
    created_at: customer.created_at
  };
}


// =====================================================
// DATAMART API
// =====================================================

const networkMap = {

  MTN: "YELLO",

  AirtelTigo:
    "AT_PREMIUM",

  Telecel:
    "TELECEL"
};


async function datamartRequest(
  endpoint,
  method = "GET",
  body = null
) {

  const headers = {
    "X-API-Key":
      DATAMART_API_KEY,

    "Content-Type":
      "application/json"
  };

  if (DATAMART_API_SECRET) {

    headers["X-API-Secret"] =
      DATAMART_API_SECRET;
  }

  const response =
    await fetch(
      `${DATAMART_BASE}${endpoint}`,
      {
        method,
        headers,
        body:
          body
            ? JSON.stringify(body)
            : undefined
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
      data.message ||
      data.error ||
      `DataMart request failed (${response.status})`
    );
  }

  return data;
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


  // Existing orders table upgrades

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
    ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'Pending';
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

      res.status(500).json({
        success: false,
        status:
          "database error",
        error:
          error.message
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

      res.status(500).json({
        error:
          error.message
      });
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

      res.status(500).json({
        error:
          error.message
      });
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
          req.body.confirmPassword ||
          ""
        );


      if (!name) {

        return res.status(400).json({
          error:
            "Full name is required."
        });
      }


      if (!validGhanaPhone(phone)) {

        return res.status(400).json({
          error:
            "Please enter a valid Ghana phone number."
        });
      }


      if (!email) {

        return res.status(400).json({
          error:
            "Email address is required."
        });
      }


      if (password.length < 6) {

        return res.status(400).json({
          error:
            "Password must be at least 6 characters."
        });
      }


      if (
        password !==
        confirmPassword
      ) {

        return res.status(400).json({
          error:
            "Passwords do not match."
        });
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


      if (existing.rows.length) {

        return res.status(400).json({
          error:
            "An account with this phone or email already exists."
        });
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

      res.status(500).json({
        error:
          "Unable to create account."
      });
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

        return res.status(400).json({
          error:
            "Phone/email and password are required."
        });
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


      if (!result.rows.length) {

        return res.status(401).json({
          error:
            "Invalid login details."
        });
      }


      const customer =
        result.rows[0];


      const valid =
        await bcrypt.compare(
          password,
          customer.password
        );


      if (!valid) {

        return res.status(401).json({
          error:
            "Invalid login details."
        });
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

      res.status(500).json({
        error:
          "Unable to login."
      });
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

      if (!req.session.customerId) {

        return res.status(401).json({
          error:
            "Not logged in."
        });
      }


      const customer =
        await getCustomer(
          req.session.customerId
        );


      if (!customer) {

        return res.status(401).json({
          error:
            "Customer account not found."
        });
      }


      res.json({
        success: true,
        customer:
          publicCustomer(
            customer
          )
      });

    } catch (error) {

      res.status(500).json({
        error:
          "Unable to load account."
      });
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
      () => {

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

        return res.status(401).json({
          error:
            "Customer account not found."
        });
      }


      /*
       * IMPORTANT:
       * Accept capacity from the frontend.
       */

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


      /*
       * Accept both:
       *
       * capacity
       * data_capacity
       *
       * This makes the backend compatible
       * with different frontend versions.
       */

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


      console.log(
        "NEW ORDER REQUEST:",
        {
          service,
          network,
          phone,
          capacity,
          amount
        }
      );


      // -----------------------------
      // SERVICE VALIDATION
      // -----------------------------

      if (!service) {

        return res.status(400).json({
          error:
            "Service is required."
        });
      }


      // -----------------------------
      // DATA BUNDLE VALIDATION
      // -----------------------------

      if (
        service.toLowerCase() ===
        "data bundle"
      ) {

        if (!network) {

          return res.status(400).json({
            error:
              "Network is required."
          });
        }


        if (!capacity) {

          return res.status(400).json({
            error:
              "Data capacity is required."
          });
        }


        if (!phone) {

          return res.status(400).json({
            error:
              "Phone number is required."
          });
        }


        if (
          !validGhanaPhone(phone)
        ) {

          return res.status(400).json({
            error:
              "Please enter a valid Ghana phone number."
          });
        }


        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {

          return res.status(400).json({
            error:
              "Valid amount is required."
          });
        }
      }


      // -----------------------------
      // CREATE ORDER REFERENCE
      // -----------------------------

      const orderRef =
        createOrderReference();


      // -----------------------------
      // INSERT ORDER
      // -----------------------------

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


      const order =
        result.rows[0];


      console.log(
        "ORDER CREATED:",
        order
      );


      return res.status(201).json({
        success: true,
        message:
          "Order created successfully.",
        order
      });

    } catch (error) {

      console.error(
        "CREATE ORDER ERROR:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to create order.",
        details:
          process.env.NODE_ENV ===
          "production"
            ? undefined
            : error.message
      });
    }
  }
);


// =====================================================
// GET CUSTOMER ORDERS
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

      res.status(500).json({
        error:
          "Unable to load orders."
      });
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

          "Content-Type":
            "application/json"
        },

        body:
          body
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

      const orderRef =
        String(
          req.body.orderRef || ""
        ).trim();


      if (!orderRef) {

        return res.status(400).json({
          error:
            "Order reference is required."
        });
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

        return res.status(404).json({
          error:
            "Order not found."
        });
      }


      const order =
        result.rows[0];


      if (
        order.payment_status ===
        "Paid"
      ) {

        return res.status(400).json({
          error:
            "This order has already been paid."
        });
      }


      const amountPesewas =
        Math.round(
          Number(order.amount) *
          100
        );


      if (
        !Number.isFinite(
          amountPesewas
        ) ||
        amountPesewas <= 0
      ) {

        return res.status(400).json({
          error:
            "Invalid order amount."
        });
      }


      const customer =
        await getCustomer(
          req.session.customerId
        );


      const reference =
        order.paystack_reference ||
        createTransactionReference();


      const callbackUrl =
        `${req.protocol}://${req.get("host")}/`;


      const payment =
        await paystackRequest(
          "/transaction/initialize",
          "POST",
          {
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
              order_ref:
                order.order_ref,

              customer_id:
                customer.id,

              service:
                order.service,

              network:
                order.network,

              capacity:
                order.capacity,

              phone:
                order.phone
            }
          }
        );


      await pool.query(
        `
        UPDATE orders
        SET
          paystack_reference = $1
        WHERE id = $2
        `,
        [
          reference,
          order.id
        ]
      );


      res.json({
        success: true,

        authorization_url:
          payment.data
            ?.authorization_url,

        access_code:
          payment.data
            ?.access_code,

        reference:
          payment.data
            ?.reference ||
          reference
      });

    } catch (error) {

      console.error(
        "PAYSTACK INITIALIZE ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Unable to initialize Paystack payment."
      });
    }
  }
);


// =====================================================
// DATAMART DATA PURCHASE
// =====================================================

async function fulfillDataOrder(
  order
) {

  try {

    // Already delivered
    if (
      order.datamart_purchase_id
    ) {

      return {
        success: true,
        alreadyProcessed: true
      };
    }


    const capacity =
      String(
        order.capacity ||
        ""
      ).trim();


    if (!capacity) {

      throw new Error(
        "Data capacity is missing from the order."
      );
    }


    const network =
      networkMap[
        order.network
      ];


    if (!network) {

      throw new Error(
        `Unsupported network: ${order.network}`
      );
    }


    const phone =
      cleanPhone(
        order.phone
      );


    if (
      !validGhanaPhone(phone)
    ) {

      throw new Error(
        "Invalid Ghana delivery phone number."
      );
    }


    const transactionReference =
      createTransactionReference();


    const payload = {

      phoneNumber:
        phone,

      network:
        network,

      capacity:
        capacity,

      gateway:
        "wallet",

      ref:
        order.order_ref,

      idempotencyKey:
        `dgm-${order.order_ref}`
    };


    console.log(
      "DATAMART PURCHASE:",
      payload
    );


    const data =
      await datamartRequest(
        "/purchase",
        "POST",
        payload
      );


    const purchase =
      data.data ||
      data;


    const purchaseId =
      purchase.purchaseId ||
      purchase.purchase_id ||
      purchase.id ||
      null;


    const datamartReference =
      purchase.reference ||
      purchase.ref ||
      null;


    const datamartTransactionReference =
      purchase.transactionReference ||
      purchase.transaction_reference ||
      null;


    const datamartStatus =
      purchase.status ||
      "Processing";


    await pool.query(
      `
      UPDATE orders
      SET
        status = 'Processing',
        datamart_purchase_id = $1,
        datamart_reference = $2,
        datamart_transaction_reference = $3,
        datamart_status = $4
      WHERE id = $5
      `,
      [
        purchaseId,
        datamartReference,
        datamartTransactionReference ||
          transactionReference,
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
        datamartTransactionReference ||
        transactionReference,

      status:
        datamartStatus
    };

  } catch (error) {

    console.error(
      "DATAMART FULFILLMENT ERROR:",
      error
    );


    await pool.query(
      `
      UPDATE orders
      SET
        status = 'Payment Received',
        datamart_status = $1
      WHERE id = $2
      `,
      [
        `Failed: ${error.message}`,
        order.id
      ]
    );


    return {
      success: false,
      error:
        error.message
    };
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

        return res.status(400).json({
          error:
            "Payment reference is required."
        });
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

        return res.status(404).json({
          error:
            "Order for this payment was not found."
        });
      }


      const order =
        result.rows[0];


      const verification =
        await paystackRequest(
          `/transaction/verify/${encodeURIComponent(
            reference
          )}`
        );


      const payment =
        verification.data ||
        {};


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

        return res.status(400).json({
          error:
            "Payment currency is invalid."
        });
      }


      if (
        paidAmount !==
        expectedAmount
      ) {

        return res.status(400).json({
          error:
            "Payment amount does not match the order."
        });
      }


      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'Paid',
          status = 'Paid',
          paystack_reference = $1,
          paid_at = NOW()
        WHERE id = $2
        `,
        [
          reference,
          order.id
        ]
      );


      const updatedOrder =
        {
          ...order,

          payment_status:
            "Paid",

          status:
            "Paid",

          paystack_reference:
            reference
        };


      let fulfillment = null;


      if (
        String(
          order.service
        ).toLowerCase() ===
        "data bundle"
      ) {

        fulfillment =
          await fulfillDataOrder(
            updatedOrder
          );
      }


      const finalOrderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE id = $1
          `,
          [order.id]
        );


      const finalOrder =
        finalOrderResult
          .rows[0];


      res.json({

        success: true,

        payment_status:
          finalOrder.payment_status,

        order_status:
          finalOrder.status,

        order:
          finalOrder,

        fulfillment
      });

    } catch (error) {

      console.error(
        "PAYMENT VERIFY ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Unable to verify payment."
      });
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

        return res.status(404).json({
          error:
            "Order not found."
        });
      }


      const order =
        result.rows[0];


      if (
        order.payment_status !==
        "Paid"
      ) {

        return res.status(400).json({
          error:
            "Payment is required before data delivery."
        });
      }


      const resultData =
        await fulfillDataOrder(
          order
        );


      if (
        !resultData.success
      ) {

        return res.status(500).json({
          error:
            resultData.error
        });
      }


      res.json(
        resultData
      );

    } catch (error) {

      console.error(
        "MANUAL DATAMART ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
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

        return res.status(404).json({
          error:
            "Customer not found."
        });
      }


      res.json({
        success: true,

        balance:
          Number(
            customer.balance || 0
          )
      });

    } catch (error) {

      res.status(500).json({
        error:
          "Unable to load wallet."
      });
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

      res.status(500).json({
        error:
          "Unable to load wallet transactions."
      });
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
      error:
        "API endpoint not found."
    });
  }
);


// =====================================================
// FRONTEND FALLBACK
// =====================================================

app.get(
  "*",
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

      }
    );

  })
  .catch(error => {

    console.error(
      "DATABASE INITIALIZATION ERROR:",
      error
    );

    process.exit(1);
  });
