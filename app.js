// =====================================================
// DHE GENIUS MEDIA - CUSTOMER STORE
// Paystack + DataMartGH
// =====================================================

const P = document.querySelector("#products");
const A = document.querySelector("#auth");
const O = document.querySelector("#orders");

let cart = [];
let currentCustomer = null;

// =====================================================
// DGM DATA BUNDLES
// =====================================================

const bundles = {
  MTN: [
    ["1GB", 5],
    ["2GB", 10],
    ["3GB", 15],
    ["4GB", 20],
    ["5GB", 24],
    ["6GB", 28],
    ["8GB", 36],
    ["10GB", 45],
    ["15GB", 64],
    ["20GB", 84],
    ["25GB", 100],
    ["30GB", 128],
    ["40GB", 168],
    ["50GB", 207]
  ],

  AirtelTigo: [
    ["1GB", 5],
    ["2GB", 10],
    ["3GB", 15],
    ["4GB", 20],
    ["5GB", 24],
    ["6GB", 26],
    ["8GB", 35],
    ["10GB", 45],
    ["12GB", 48],
    ["15GB", 65],
    ["25GB", 100],
    ["30GB", 120],
    ["40GB", 160],
    ["50GB", 200]
  ],

  Telecel: [
    ["10GB", 45],
    ["15GB", 60],
    ["20GB", 76],
    ["25GB", 100],
    ["30GB", 115],
    ["35GB", 136],
    ["40GB", 150],
    ["45GB", 165],
    ["50GB", 185],
    ["100GB", 407]
  ]
};

let selectedNetwork = "MTN";

// =====================================================
// API HELPER
// =====================================================

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.error ||
      "Something went wrong."
    );
  }

  return data;
}

// =====================================================
// INITIAL LOAD
// =====================================================

async function load() {
  renderBundles(selectedNetwork);

  await loadCustomer();

  await loadOrders();

  checkPaymentReturn();
}

// =====================================================
// RENDER BUNDLES
// =====================================================

function renderBundles(network) {
  selectedNetwork = network;

  if (!P) return;

  const networkBundles =
    bundles[network] || [];

  P.innerHTML = `
    <div class="network-buttons">
      <button onclick="renderBundles('MTN')">
        MTN
      </button>

      <button onclick="renderBundles('AirtelTigo')">
        AirtelTigo
      </button>

      <button onclick="renderBundles('Telecel')">
        Telecel
      </button>
    </div>

    <h2>${network} Data Bundles</h2>

    <div class="bundle-grid">
      ${networkBundles.map(
        ([capacity, price]) => `
          <div class="card">
            <h3>${capacity}</h3>

            <div class="price">
              GH₵ ${price.toFixed(2)}
            </div>

            <p>
              Validity: 90 days
            </p>

            <button
              onclick="selectBundle(
                '${network}',
                '${capacity}',
                ${price}
              )"
            >
              Buy Now
            </button>
          </div>
        `
      ).join("")}
    </div>
  `;
}

// =====================================================
// SELECT BUNDLE
// =====================================================

function selectBundle(
  network,
  capacity,
  amount
) {
  cart = [
    {
      network,
      capacity,
      amount
    }
  ];

  const phone =
    prompt(
      "Enter the Ghana phone number to receive the data:"
    );

  if (!phone) return;

  if (
    !/^(0\d{9}|\+233\d{9})$/.test(
      phone.trim()
    )
  ) {
    alert(
      "Please enter a valid Ghana phone number."
    );

    return;
  }

  startOrder(
    network,
    capacity,
    amount,
    phone.trim()
  );
}

// =====================================================
// CREATE ORDER + START PAYSTACK
// =====================================================

async function startOrder(
  network,
  capacity,
  amount,
  phone
) {
  try {
    if (!currentCustomer) {
      alert(
        "Please create an account or log in first."
      );

      return;
    }

    const orderResponse =
      await api(
        "/api/orders",
        {
          method: "POST",

          body: JSON.stringify({
            service: "Data Bundle",
            network,
            phone,
            capacity,
            amount
          })
        }
      );

    const order =
      orderResponse.order;

    if (!order) {
      throw new Error(
        "Order was not created."
      );
    }

    alert(
      "Order created successfully.\n\n" +
      "Order Reference: " +
      order.order_ref +
      "\n\n" +
      "You will now be redirected to Paystack."
    );

    const payment =
      await api(
        "/api/payments/initialize",
        {
          method: "POST",

          body: JSON.stringify({
            orderRef:
              order.order_ref
          })
        }
      );

    if (
      !payment.authorization_url
    ) {
      throw new Error(
        "Paystack payment link was not returned."
      );
    }

    /*
     * Send customer to Paystack.
     */

    window.location.href =
      payment.authorization_url;

  } catch (error) {
    console.error(
      "PAYMENT START ERROR:",
      error
    );

    alert(
      error.message ||
      "Unable to start payment."
    );
  }
}

// =====================================================
// CUSTOMER / AUTH
// =====================================================

async function loadCustomer() {
  if (!A) return;

  try {
    const data =
      await api("/api/me");

    currentCustomer =
      data.customer;

    renderLoggedIn();
  } catch {
    currentCustomer = null;

    renderAuth();
  }
}

// =====================================================
// LOGIN / REGISTER UI
// =====================================================

function renderAuth() {
  if (!A) return;

  A.innerHTML = `
    <div class="auth-box">

      <h2>Create Account</h2>

      <input
        id="registerName"
        placeholder="Full name"
      >

      <input
        id="registerPhone"
        placeholder="Phone number"
        type="tel"
      >

      <input
        id="registerEmail"
        placeholder="Email address"
        type="email"
      >

      <input
        id="registerPassword"
        placeholder="Password"
        type="password"
      >

      <input
        id="registerConfirmPassword"
        placeholder="Confirm password"
        type="password"
      >

      <button onclick="reg()">
        Create Account
      </button>

      <hr>

      <h2>Login</h2>

      <input
        id="loginIdentifier"
        placeholder="Phone or email"
      >

      <input
        id="loginPassword"
        placeholder="Password"
        type="password"
      >

      <button onclick="log()">
        Login
      </button>

    </div>
  `;
}

// =====================================================
// LOGGED-IN UI
// =====================================================

function renderLoggedIn() {
  if (!A || !currentCustomer) return;

  A.innerHTML = `
    <div class="account-box">

      <h2>
        Welcome, ${escapeHtml(
          currentCustomer.name
        )}
      </h2>

      <p>
        Email:
        ${escapeHtml(
          currentCustomer.email
        )}
      </p>

      <p>
        Phone:
        ${escapeHtml(
          currentCustomer.phone
        )}
      </p>

      <p>
        Wallet Balance:
        <strong>
          GH₵ ${Number(
            currentCustomer.balance || 0
          ).toFixed(2)}
        </strong>
      </p>

      <button onclick="logout()">
        Logout
      </button>

    </div>
  `;
}

// =====================================================
// REGISTER
// =====================================================

async function reg() {
  try {
    const name =
      document
        .querySelector("#registerName")
        ?.value.trim();

    const phone =
      document
        .querySelector("#registerPhone")
        ?.value.trim();

    const email =
      document
        .querySelector("#registerEmail")
        ?.value.trim();

    const password =
      document
        .querySelector("#registerPassword")
        ?.value;

    const confirmPassword =
      document
        .querySelector(
          "#registerConfirmPassword"
        )
        ?.value;

    const data =
      await api(
        "/api/register",
        {
          method: "POST",

          body: JSON.stringify({
            name,
            phone,
            email,
            password,
            confirmPassword
          })
        }
      );

    currentCustomer =
      data.customer;

    renderLoggedIn();

    alert(
      "Account created successfully."
    );

  } catch (error) {
    alert(
      error.message
    );
  }
}

// =====================================================
// LOGIN
// =====================================================

async function log() {
  try {
    const identifier =
      document
        .querySelector("#loginIdentifier")
        ?.value.trim();

    const password =
      document
        .querySelector("#loginPassword")
        ?.value;

    const data =
      await api(
        "/api/login",
        {
          method: "POST",

          body: JSON.stringify({
            identifier,
            password
          })
        }
      );

    currentCustomer =
      data.customer;

    renderLoggedIn();

    await loadOrders();

    alert(
      "Login successful."
    );

  } catch (error) {
    alert(
      error.message
    );
  }
}

// =====================================================
// LOGOUT
// =====================================================

async function logout() {
  try {
    await api(
      "/api/logout",
      {
        method: "POST"
      }
    );

    currentCustomer = null;

    renderAuth();

    if (O) {
      O.innerHTML = "";
    }

  } catch (error) {
    alert(
      error.message
    );
  }
}

// =====================================================
// LOAD ORDERS
// =====================================================

async function loadOrders() {
  if (!O) return;

  try {
    const data =
      await api(
        "/api/orders"
      );

    const orders =
      data.orders || [];

    if (!orders.length) {
      O.innerHTML = `
        <p>
          No orders yet.
        </p>
      `;

      return;
    }

    O.innerHTML = orders
      .map(
        order => `
          <div class="order-card">

            <strong>
              ${escapeHtml(
                order.order_ref
              )}
            </strong>

            <p>
              ${escapeHtml(
                order.service
              )}
            </p>

            <p>
              Network:
              ${escapeHtml(
                order.network || "-"
              )}
            </p>

            <p>
              Bundle:
              ${escapeHtml(
                order.capacity || "-"
              )}
            </p>

            <p>
              Phone:
              ${escapeHtml(
                order.phone
              )}
            </p>

            <p>
              Amount:
              GH₵ ${Number(
                order.amount
              ).toFixed(2)}
            </p>

            <p>
              Payment:
              <strong>
                ${escapeHtml(
                  order.payment_status ||
                  "Pending"
                )}
              </strong>
            </p>

            <p>
              Order Status:
              <strong>
                ${escapeHtml(
                  order.status
                )}
              </strong>
            </p>

          </div>
        `
      )
      .join("");

  } catch (error) {
    console.error(
      "LOAD ORDERS ERROR:",
      error
    );
  }
}

// =====================================================
// CHECK PAYSTACK RETURN
// =====================================================

async function checkPaymentReturn() {
  const params =
    new URLSearchParams(
      window.location.search
    );

  const reference =
    params.get("reference");

  if (!reference) {
    return;
  }

  if (!currentCustomer) {
    return;
  }

  try {
    alert(
      "Checking your Paystack payment..."
    );

    const result =
      await api(
        `/api/payments/verify/${encodeURIComponent(
          reference
        )}`
      );

    if (
      result.payment_status ===
      "Paid"
    ) {
      alert(
        "Payment successful!\n\n" +
        "Your order has been received and is being processed."
      );
    } else {
      alert(
        result.message ||
        "Payment is still being processed."
      );
    }

    /*
     * Remove the Paystack reference
     * from the browser URL.
     */

    window.history.replaceState(
      {},
      document.title,
      window.location.pathname
    );

    await loadOrders();

  } catch (error) {
    console.error(
      "PAYMENT VERIFICATION ERROR:",
      error
    );

    alert(
      error.message ||
      "Unable to verify payment."
    );
  }
}

// =====================================================
// ESCAPE HTML
// =====================================================

function escapeHtml(value) {
  return String(value ?? "")
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
// START
// =====================================================

load();
