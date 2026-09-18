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


function renderBundles(network) {

  const products = document.getElementById("products");

  if (!products) {
    console.error("Products container not found.");
    return;
  }

  products.innerHTML = "";

  bundles[network].forEach(function(item) {

    const size = item[0];
    const price = item[1];

    const card = document.createElement("div");

    card.className = "bundle-card";

    card.innerHTML = `
      <h3>${network}</h3>

      <strong>${size}</strong>

      <p>GH₵${price.toFixed(2)}</p>

      <small>Validity: 90 days</small>

      <button onclick="buyBundle('${network}', '${size}', ${price})">
        Buy Now
      </button>
    `;

    products.appendChild(card);
  });
}


function buyBundle(network, size, price) {

  const phone = prompt(
    "Enter the Ghana phone number that should receive " +
    size + " " + network + " data:"
  );

  if (!phone) {
    return;
  }

  const order = {
    orderId: "DGM-" + Date.now(),
    network: network,
    bundle: size,
    price: price,
    phone: phone,
    status: "Pending",
    createdAt: new Date().toISOString()
  };

  const orders = JSON.parse(
    localStorage.getItem("dgm_orders") || "[]"
  );

  orders.push(order);

  localStorage.setItem(
    "dgm_orders",
    JSON.stringify(orders)
  );

  alert(
    "Order created successfully!\n\n" +
    "Order ID: " + order.orderId + "\n" +
    "Network: " + network + "\n" +
    "Bundle: " + size + "\n" +
    "Price: GH₵" + price.toFixed(2) + "\n" +
    "Status: Pending"
  );

  showOrders();
}


function showOrders() {

  const ordersBox = document.getElementById("orders-list");

  if (!ordersBox) {
    return;
  }

  const orders = JSON.parse(
    localStorage.getItem("dgm_orders") || "[]"
  );

  if (!orders.length) {

    ordersBox.innerHTML = `
      <div class="empty">
        No orders yet.
      </div>
    `;

    return;
  }

  ordersBox.innerHTML = orders.map(function(order) {

    return `
      <div class="order">

        <strong>${order.orderId}</strong>

        <p>
          ${order.network} — ${order.bundle}
        </p>

        <p>
          GH₵${Number(order.price).toFixed(2)}
        </p>

        <p>
          Phone: ${order.phone}
        </p>

        <p>
          Status:
          <strong>${order.status}</strong>
        </p>

      </div>
    `;

  }).join("");
}


function buyAirtime() {

  const network =
    document.getElementById("airtimeNetwork").value;

  const phone =
    document.getElementById("airtimePhone").value.trim();

  const amount =
    document.getElementById("airtimeAmount").value;

  if (!phone || !amount) {

    alert(
      "Please enter the phone number and airtime amount."
    );

    return;
  }

  alert(
    "Airtime order received.\n\n" +
    "Network: " + network + "\n" +
    "Phone: " + phone + "\n" +
    "Amount: GH₵" + amount +
    "\n\nPayment and automatic delivery will be connected in the next stage."
  );
}


function saveAccount() {

  const input =
    document.getElementById("accountPhone");

  const message =
    document.getElementById("accountMessage");

  const phone =
    input.value.trim();

  if (!phone) {

    alert("Please enter your phone number.");

    return;
  }

  localStorage.setItem(
    "dgm_account_phone",
    phone
  );

  message.innerText =
    "Account information saved on this device.";
}


window.renderBundles = renderBundles;
window.buyBundle = buyBundle;
window.showOrders = showOrders;
window.buyAirtime = buyAirtime;
window.saveAccount = saveAccount;
