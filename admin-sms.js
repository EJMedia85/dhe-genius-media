const SMS_ENDPOINT = "https://sms.arkesel.com/api/v2/sms/send";

function normalizeRecipient(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (/^0\d{9}$/.test(digits)) return "233" + digits.slice(1);
  if (/^233\d{9}$/.test(digits)) return digits;
  if (/^\+233\d{9}$/.test(raw)) return raw.slice(1);
  return "";
}

async function sendAdminSms(event, details) {
  const apiKey = String(process.env.ARKESEL_API_KEY || "").trim();
  const recipient = normalizeRecipient(process.env.DGM_ADMIN_ALERT_PHONE);
  const enabled = String(process.env.DGM_ADMIN_ALERTS_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return { sent: false, reason: "disabled" };
  if (!apiKey || !recipient) {
    if (!apiKey || !recipient) {
      console.info("DGM admin SMS not configured; set ARKESEL_API_KEY and DGM_ADMIN_ALERT_PHONE in Render.");
    }
    return { sent: false, reason: "not_configured" };
  }

  const sender = String(process.env.DGM_SMS_SENDER || "DGM").trim().slice(0, 11) || "DGM";
  const message = ("DGM ADMIN ALERT: " + String(event || "Approval request") + ". " +
    String(details || "Please review the Admin Dashboard.") +
    " Open dhe-genius-media.onrender.com/admin.html").slice(0, 480);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(SMS_ENDPOINT, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ sender, message, recipients: [recipient] }),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || String(result.status || "").toLowerCase() !== "success") {
      console.error("DGM admin SMS send failed:", response.status, String(result.message || result.status || "Provider rejected request").slice(0, 180));
      return { sent: false, reason: "provider_error" };
    }
    console.info("DGM admin SMS accepted:", event, result.data?.[0]?.id || "message accepted");
    return { sent: true, id: result.data?.[0]?.id || null };
  } catch (error) {
    console.error("DGM admin SMS error:", error.name === "AbortError" ? "request timed out" : error.message);
    return { sent: false, reason: "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendAdminSms };
