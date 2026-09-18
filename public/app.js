const bundles = {
  MTN: [
    ["1GB", 5], ["2GB", 10], ["3GB", 15], ["4GB", 20],
    ["5GB", 24], ["6GB", 28], ["8GB", 36], ["10GB", 45],
    ["15GB", 64], ["20GB", 84], ["25GB", 100], ["30GB", 128],
    ["40GB", 168], ["50GB", 207]
  ],
  AirtelTigo: [
    ["1GB", 5], ["2GB", 10], ["3GB", 15], ["4GB", 20],
    ["5GB", 24], ["6GB", 26], ["8GB", 35], ["10GB", 45],
    ["12GB", 48], ["15GB", 65], ["25GB", 100], ["30GB", 120],
    ["40GB", 160], ["50GB", 200]
  ],
  Telecel: [
    ["10GB", 45], ["15GB", 60], ["20GB", 76], ["25GB", 100],
    ["30GB", 115], ["35GB", 136], ["40GB", 150], ["45GB", 165],
    ["50GB", 185], ["100GB", 407]
  ]
};

const products = document.getElementById("products");

function renderBundles(network) {
  products.innerHTML = "";

  bundles[network].forEach(([size, price]) => {
    const card = document.createElement("div");
    card.className = "bundle-card";

    card.innerHTML = `
      <h3>${network}</h3>
      <strong>${size}</strong>
      <p>GH₵${price.toFixed(2)}</p>
      <small>Validity: 90 days</small>
      <button onclick="buyBundle('${network}','${size}',${price})">
        Buy Now
      </button>
    `;

    products.appendChild(card);
  });
}

function createNetworkButtons() {
  const section = document.querySelector("main");

  const selector = document.createElement("div");
  selector.className = "network-selector";

  selector.innerHTML = `
    <h2>Choose Network</h2>
    <button onclick="renderBundles('MTN')">MTN</button>
    <button onclick="renderBundles('AirtelTigo')">AirtelTigo</button>
    <button onclick="renderBundles('Telecel')">Telecel</button>
  `;

  section.insertBefore(selector, document.getElementById("products"));
}

function buyBundle(network, size, price) {
  const phone = prompt(
    `Enter the Ghana phone number that should receive ${size} ${network} data:`
  );

  if (!phone) return;

  const order = {
    orderId: "DGM-" + Date.now(),
    network,
    bundle: size,
    price,
    phone,
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  const orders = JSON.parse(localStorage.getItem("dgm_orders") || "[]");
  orders.push(order);
  localStorage.setItem("dgm_orders", JSON.stringify(orders));

  alert(
    `Order created successfully!\n\n` +
    `Order ID: ${order.orderId}\n` +
    `Network: ${network}\n` +
    `Bundle: ${size}\n` +
    `Price: GH₵${price.toFixed(2)}\n` +
    `Status: Pending`
  );

  showOrders();
}

function showOrders() {
  const ordersBox = document.getElementById("orders");
  if (!ordersBox) return;

  const orders = JSON.parse(localStorage.getItem("dgm_orders") || "[]");

  if (!orders.length) {
    ordersBox.innerHTML = "<p>No orders yet.</p>";
    return;
  }

  ordersBox.innerHTML = `
    <h3>Your Orders</h3>
    ${orders.map(order => `
      <div class="order">
        <strong>${order.orderId}</strong>
        <p>${order.network} ${order.bundle}</p>
        <p>GH₵${order.price.toFixed(2)}</p>
        <p>Phone: ${order.phone}</p>
        <p>Status: <strong>${order.status}</strong></p>
      </div>
    `).join("")}
  `;
}

createNetworkButtons();
renderBundles("MTN");
showOrders();
