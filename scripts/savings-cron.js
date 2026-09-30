const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const secret = String(process.env.CRON_SECRET || "").trim();

if (!baseUrl || !secret) {
  console.error("BASE_URL and CRON_SECRET are required.");
  process.exit(1);
}

fetch(baseUrl + "/api/savings/auto-run", {
  method: "POST",
  headers: { "X-DGM-Cron-Secret": secret, Accept: "application/json" }
})
  .then(async response => {
    const text = await response.text();
    console.log("Savings cron:", response.status, text);
    if (!response.ok) process.exitCode = 1;
  })
  .catch(error => {
    console.error("Savings cron failed:", error);
    process.exitCode = 1;
  });