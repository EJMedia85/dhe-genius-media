(function () {
  "use strict";
  const endpoint = "/api/analytics/event";
  const allowed = new Set([
    "page_view", "signup_cta_click", "signup_form_submit",
    "login_cta_click", "login_form_submit", "data_page_view",
    "dashboard_view", "service_cta_click"
  ]);
  let visitId = "";
  try {
    visitId = sessionStorage.getItem("dgm_funnel_visit_id") || "";
    if (!/^[a-f0-9-]{16,64}$/i.test(visitId)) {
      visitId = (crypto.randomUUID ? crypto.randomUUID() : (
        "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
          const r = Math.random() * 16 | 0;
          return (c === "x" ? r : (r & 3 | 8)).toString(16);
        })
      ));
      sessionStorage.setItem("dgm_funnel_visit_id", visitId);
    }
  } catch (_) {
    return;
  }

  function send(name) {
    if (!allowed.has(name)) return;
    const payload = JSON.stringify({
      event_name: name,
      visit_id: visitId,
      page_path: location.pathname
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
      } else {
        fetch(endpoint, {
          method: "POST",
          credentials: "same-origin",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: payload
        }).catch(function () {});
      }
    } catch (_) {}
  }

  const path = location.pathname.toLowerCase();
  send("page_view");
  if (path === "/register.html") {
    document.addEventListener("DOMContentLoaded", function () {
      const form = document.querySelector("form");
      if (form) form.addEventListener("submit", function () { send("signup_form_submit"); });
    });
  }
  if (path === "/login.html") {
    document.addEventListener("DOMContentLoaded", function () {
      const form = document.querySelector("form");
      if (form) form.addEventListener("submit", function () { send("login_form_submit"); });
    });
  }
  if (path === "/data.html") send("data_page_view");
  if (path === "/dashboard.html") send("dashboard_view");

  document.addEventListener("click", function (event) {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (href === "/register.html" || href.indexOf("/register.html?") === 0) send("signup_cta_click");
    else if (href === "/login.html" || href.indexOf("/login.html?") === 0) send("login_cta_click");
    else if (href === "/data.html" || href.indexOf("/data.html?") === 0) send("service_cta_click");
  });
})();