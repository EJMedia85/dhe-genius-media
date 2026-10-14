"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

delete process.env.DGM_VIRTUAL_CARD_SANDBOX_ENABLED;
delete process.env.PAYSTACK_SANDBOX_SECRET_KEY;

const { installVirtualCard } = require("../virtual-card-routes");

function makeHarness() {
  const routes = { get: new Map(), post: new Map() };
  const app = {
    get(path, ...handlers) { routes.get.set(path, handlers); },
    post(path, ...handlers) { routes.post.set(path, handlers); }
  };
  const pool = {
    async query() {
      throw new Error("Database must not be touched by status-only test");
    }
  };
  const requireLogin = (req, res, next) => next();
  installVirtualCard(app, { pool, requireLogin });
  return { app, routes };
}

test("sandbox status is safely disabled by default", () => {
  const { routes } = makeHarness();
  let payload;
  const res = { json(value) { payload = value; return this; } };
  routes.get.get("/api/virtual-card/sandbox-status")[0]({}, res);
  assert.equal(payload.success, true);
  assert.equal(payload.sandbox_enabled, false);
  assert.equal(payload.real_card_issuance_enabled, false);
  assert.equal(payload.real_wallet_credit_enabled, false);
});

test("funding endpoints require customer authentication before database setup", () => {
  const { routes } = makeHarness();
  const handlers = routes.post.get("/api/virtual-card/funding/initialize");
  assert.ok(handlers);
  assert.equal(typeof handlers[0], "function"); // bounded JSON parser
  assert.equal(handlers[1].name, "requireLogin");
  assert.equal(handlers[2].name, "ready");
  const statusHandlers = routes.get.get("/api/virtual-card/funding/:reference");
  assert.equal(statusHandlers[0].name, "requireLogin");
  assert.equal(statusHandlers[1].name, "ready");
});

test("sandbox webhook is isolated from the existing live webhook", () => {
  const { routes } = makeHarness();
  const handlers = routes.post.get("/api/virtual-card/paystack-sandbox-webhook");
  assert.ok(handlers);
  assert.equal(handlers[0].name, "ready");
  assert.equal(typeof handlers[1], "function"); // dedicated raw-body parser
  assert.equal(handlers[2].constructor.name, "AsyncFunction");
});

test("only the documented Ghana MoMo provider codes are configured", () => {
  const { routes } = makeHarness();
  const initHandlers = routes.post.get("/api/virtual-card/funding/initialize");
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "virtual-card-routes.js"),
    "utf8"
  );
  assert.match(source, /MTN:\s*"mtn"/);
  assert.match(source, /TELECEL:\s*"vod"/);
  assert.match(source, /AT:\s*"atl"/);
  assert.ok(initHandlers);
});
