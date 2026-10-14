const crypto = require("crypto");

const SANDBOX_ENABLED =
  String(process.env.DGM_VIRTUAL_CARD_SANDBOX_ENABLED || "false").toLowerCase() === "true";
const PAYSTACK_SANDBOX_SECRET_KEY = String(process.env.PAYSTACK_SANDBOX_SECRET_KEY || "").trim();
const SANDBOX_KEY_VALID = PAYSTACK_SANDBOX_SECRET_KEY.startsWith("sk_test_");

const PROVIDERS = Object.freeze({
  MTN: "mtn",
  TELECEL: "vod",
  AT: "atl"
});

function sendError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function newReference() {
  return "DGM-VC-" + Date.now().toString(36).toUpperCase() + "-" +
    crypto.randomBytes(6).toString("hex").toUpperCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/[\s()\-]/g, "");
}

function installVirtualCard(app, { pool, requireLogin }) {
  let dbReady = null;

  async function initDatabase() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dgm_virtual_card_deposits (
        id BIGSERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        reference TEXT NOT NULL UNIQUE,
        amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        currency TEXT NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS'),
        provider TEXT NOT NULL CHECK (provider IN ('mtn','vod','atl')),
        phone_last4 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payment_status TEXT NOT NULL DEFAULT 'pending',
        provider_status TEXT,
        provider_message TEXT,
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS dgm_virtual_card_deposits_customer_created_idx
      ON dgm_virtual_card_deposits(customer_id, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS dgm_virtual_card_deposits_status_idx
      ON dgm_virtual_card_deposits(status, created_at DESC)
    `);
  }

  function ready(req, res, next) {
    if (!SANDBOX_ENABLED || !SANDBOX_KEY_VALID) {
      return sendError(res, 503, "DGM Virtual Card sandbox is disabled. Configure DGM_VIRTUAL_CARD_SANDBOX_ENABLED=true and a separate PAYSTACK_SANDBOX_SECRET_KEY beginning with sk_test_.");
    }
    if (!dbReady) dbReady = initDatabase();
    dbReady.then(() => next()).catch(error => {
      console.error("DGM Virtual Card sandbox database initialization failed:", error.message);
      return sendError(res, 503, "Virtual Card sandbox is temporarily unavailable.");
    });
  }

  async function paystackRequest(path, options = {}) {
    const response = await fetch("https://api.paystack.co" + path, {
      method: options.method || "GET",
      headers: {
        Authorization: "Bearer " + PAYSTACK_SANDBOX_SECRET_KEY,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    return { response, payload };
  }

  async function verifyCharge(reference, expected) {
    const { response, payload } = await paystackRequest(
      "/transaction/verify/" + encodeURIComponent(reference)
    );
    const payment = payload?.data || {};
    const valid = response.ok &&
      payload.status === true &&
      String(payment.status || "").toLowerCase() === "success" &&
      String(payment.currency || "").toUpperCase() === "GHS" &&
      Math.round(Number(payment.amount || 0)) === Math.round(Number(expected.amount) * 100) &&
      String(payment.reference || "") === reference;

    if (!valid) {
      await pool.query(
        `UPDATE dgm_virtual_card_deposits
         SET provider_status=$1, provider_message=$2, updated_at=NOW()
         WHERE reference=$3 AND payment_status <> 'paid'`,
        [
          String(payment.status || payload.message || "verification_failed").slice(0, 80),
          String(payment.gateway_response || payload.message || "Payment not verified.").slice(0, 500),
          reference
        ]
      );
      return false;
    }

    // This records a verified sandbox payment only. It deliberately does not
    // credit the DGM Wallet or claim that a real virtual card has been funded.
    await pool.query(
      `UPDATE dgm_virtual_card_deposits
       SET status='sandbox_paid', payment_status='paid',
           provider_status='success', provider_message='Sandbox payment verified',
           paid_at=COALESCE(paid_at,NOW()), updated_at=NOW()
       WHERE reference=$1 AND amount=$2 AND currency='GHS'`,
      [reference, expected.amount]
    );
    return true;
  }

  app.get("/api/virtual-card/sandbox-status", (req, res) => {
    res.json({
      success: true,
      sandbox_enabled: SANDBOX_ENABLED && SANDBOX_KEY_VALID,
      real_card_issuance_enabled: false,
      real_wallet_credit_enabled: false,
      message: SANDBOX_ENABLED && SANDBOX_KEY_VALID
        ? "Sandbox-only Mobile Money tests are available. No real card is issued and no DGM Wallet balance is changed."
        : "Virtual Card sandbox is disabled until a separate Paystack test key is configured."
    });
  });

  // Raw body is required for Paystack's HMAC-SHA512 signature validation.
  // This dedicated endpoint is separate from the existing live-payments webhook.
  app.post("/api/virtual-card/paystack-sandbox-webhook", ready,
    require("express").raw({ type: "application/json", limit: "128kb" }),
    async (req, res) => {
      try {
        const signature = String(req.get("x-paystack-signature") || "");
        if (!signature || !Buffer.isBuffer(req.body)) return res.sendStatus(401);
        const expected = crypto.createHmac("sha512", PAYSTACK_SANDBOX_SECRET_KEY)
          .update(req.body).digest("hex");
        const suppliedBuffer = Buffer.from(signature, "utf8");
        const expectedBuffer = Buffer.from(expected, "utf8");
        if (suppliedBuffer.length !== expectedBuffer.length ||
            !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
          return res.sendStatus(401);
        }

        let event;
        try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.sendStatus(400); }
        if (event?.event !== "charge.success") return res.sendStatus(200);

        const reference = String(event?.data?.reference || "").trim();
        if (!reference) return res.sendStatus(200);

        const found = await pool.query(
          "SELECT reference, amount, currency FROM dgm_virtual_card_deposits WHERE reference=$1 LIMIT 1",
          [reference]
        );
        if (!found.rows.length) return res.sendStatus(200);

        const row = found.rows[0];
        // Re-verify with Paystack rather than trusting webhook payload fields.
        await verifyCharge(reference, row);
        return res.sendStatus(200);
      } catch (error) {
        console.error("DGM Virtual Card sandbox webhook error:", error.message);
        return res.sendStatus(500);
      }
    }
  );

  app.post("/api/virtual-card/funding/initialize", ready, requireLogin, async (req, res) => {
    try {
      const amount = Math.round(Number(req.body?.amount || 0) * 100) / 100;
      const provider = String(req.body?.provider || "").trim().toLowerCase();
      const phone = normalizePhone(req.body?.phone);
      const validProviders = Object.values(PROVIDERS);

      if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
        return sendError(res, 400, "Sandbox funding amount must be between GH₵1.00 and GH₵1,000.00.");
      }
      if (!validProviders.includes(provider)) {
        return sendError(res, 400, "Choose MTN MoMo, Telecel Cash, or AT Money.");
      }
      if (!/^(?:0\d{9}|\+233\d{9}|233\d{9})$/.test(phone)) {
        return sendError(res, 400, "Enter a valid Ghanaian Mobile Money number.");
      }

      const customerResult = await pool.query(
        "SELECT id, email FROM customers WHERE id=$1 LIMIT 1",
        [req.session.customerId]
      );
      const customer = customerResult.rows[0];
      if (!customer) return sendError(res, 404, "Customer account not found.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer.email || ""))) {
        return sendError(res, 400, "Add a valid email address to your DGM account before testing.");
      }

      const reference = newReference();
      await pool.query(
        `INSERT INTO dgm_virtual_card_deposits
         (customer_id, reference, amount, currency, provider, phone_last4, status, payment_status)
         VALUES ($1,$2,$3,'GHS',$4,$5,'initializing','pending')`,
        [customer.id, reference, amount, provider, phone.slice(-4)]
      );

      const { response, payload } = await paystackRequest("/charge", {
        method: "POST",
        body: {
          email: customer.email,
          amount: Math.round(amount * 100),
          currency: "GHS",
          mobile_money: { phone, provider },
          reference,
          metadata: {
            type: "dgm_virtual_card_sandbox_funding",
            customer_id: customer.id,
            deposit_reference: reference,
            sandbox_only: true
          }
        }
      });

      const charge = payload?.data || {};
      if (!response.ok || payload.status !== true || !charge.reference) {
        await pool.query(
          `UPDATE dgm_virtual_card_deposits
           SET status='initialization_failed', provider_status=$1, provider_message=$2, updated_at=NOW()
           WHERE reference=$3`,
          [String(charge.status || "failed").slice(0, 80),
           String(payload.message || "Paystack sandbox could not initialize this Mobile Money charge.").slice(0, 500),
           reference]
        );
        return sendError(res, 502, payload.message || "Could not start the sandbox Mobile Money request.");
      }

      await pool.query(
        `UPDATE dgm_virtual_card_deposits
         SET status='pending', provider_status=$1, provider_message=$2, updated_at=NOW()
         WHERE reference=$3`,
        [String(charge.status || "pending").slice(0, 80),
         String(charge.display_text || payload.message || "Approve the payment prompt on your phone.").slice(0, 500),
         reference]
      );

      return res.status(202).json({
        success: true,
        sandbox_only: true,
        real_card_issuance_enabled: false,
        real_wallet_credit_enabled: false,
        reference,
        amount,
        currency: "GHS",
        provider,
        status: String(charge.status || "pending"),
        message: String(charge.display_text || payload.message || "Approve the sandbox payment prompt on your phone."),
        expires_in_seconds: 180
      });
    } catch (error) {
      console.error("DGM Virtual Card sandbox initialization error:", error.message);
      return sendError(res, 500, "Could not initialize sandbox Mobile Money funding.");
    }
  });

  app.get("/api/virtual-card/funding/:reference", ready, requireLogin, async (req, res) => {
    try {
      const reference = String(req.params.reference || "").trim();
      const result = await pool.query(
        `SELECT reference, amount, currency, provider, phone_last4, status, payment_status,
                provider_status, provider_message, paid_at, created_at
         FROM dgm_virtual_card_deposits
         WHERE reference=$1 AND customer_id=$2 LIMIT 1`,
        [reference, req.session.customerId]
      );
      if (!result.rows.length) return sendError(res, 404, "Sandbox funding record not found.");
      return res.json({
        success: true,
        sandbox_only: true,
        real_card_issuance_enabled: false,
        real_wallet_credit_enabled: false,
        deposit: result.rows[0]
      });
    } catch (error) {
      console.error("DGM Virtual Card sandbox status lookup error:", error.message);
      return sendError(res, 500, "Could not load sandbox funding status.");
    }
  });
}

module.exports = { installVirtualCard };
