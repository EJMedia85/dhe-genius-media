# DGM Virtual Card — Sandbox Integration Test Plan

**Current mode:** sandbox-only routes have been added on the development branch; they are disabled by default and have not been deployed to the live DGM service. No real card issuance or wallet credit is implemented.
**Rule:** Never use live credentials or real customer money in sandbox testing.

## Current development implementation

- New module: `virtual-card-routes.js`, registered in `server.js` on the development branch.
- Sandbox flag: `DGM_VIRTUAL_CARD_SANDBOX_ENABLED=true`.
- Separate credential: `PAYSTACK_SANDBOX_SECRET_KEY`; the module refuses to run unless it begins with `sk_test_`. Never reuse `PAYSTACK_SECRET_KEY` for this flow.
- Public status endpoint: `GET /api/virtual-card/sandbox-status`.
- Authenticated sandbox charge endpoint: `POST /api/virtual-card/funding/initialize` with `amount`, `provider` (`mtn`, `vod`, or `atl`) and `phone`.
- Dedicated sandbox webhook: `POST /api/virtual-card/paystack-sandbox-webhook`; it validates the raw-body HMAC-SHA512 signature and re-verifies the charge with Paystack.
- Authenticated status lookup: `GET /api/virtual-card/funding/:reference`.
- Deposit records are isolated in `dgm_virtual_card_deposits`. They store only the phone's last four digits, and a verified sandbox payment is marked `sandbox_paid` without crediting the DGM Wallet.
- The module is deliberately registered before Bridge's JSON parser so the webhook can validate the original raw request body; the charge route has its own bounded JSON parser.
- Added `test/virtual-card-routes.test.js` to assert default-disabled behavior, auth-before-database ordering, dedicated raw-body webhook registration, and approved Ghana MoMo provider codes.
- Static syntax parsing has passed for `server.js` and `virtual-card-routes.js`. Automated repository checks and the new Node.js safety tests have passed in GitHub Actions (DGM Virtual Card Development Checks, DGM Server Checks, and DGM backend syntax checks). Real provider sandbox integration tests still require a separate Paystack test secret and must run in a controlled sandbox environment before enabling the flag.

These routes are not proof of issuer approval, card issuance, or a live settlement path. Do not enable the sandbox flag in production until a separate test key and the sandbox webhook configuration are available.

## Provider facts to confirm before coding against production

- Paystack's official Ghana Mobile Money documentation lists provider codes `mtn`, `vod` (Telecel) and `atl` (AT Money/Airtel Money). Its Charge API can return `pay_offline` and a display message while the customer approves the prompt. Successful payments are reported asynchronously; verify the transaction on the server and avoid duplicate fulfilment.
- Brails documents a sandbox API base URL at `https://sandboxapi.onbrails.com/api/v2/` and production at `https://api.onbrails.com/api/v2/`. Card issuing requires onboarding approval. Ghana card-user registration requires date of birth and accepts passport, driver's licence or voter ID per its documentation.
- Brails describes funding cards from the business USD wallet, not directly from a customer's MoMo. Therefore direct MoMo-to-card must remain unavailable unless the providers explicitly approve and document the complete settlement path.

## Proposed sandbox test matrix

| Test | Setup / event | Expected safe outcome |
|---|---|---|
| Amount validation | Missing, zero, negative, non-number or over-limit amount | Reject before provider request |
| Network validation | Unsupported network value | Reject; never pass arbitrary provider codes |
| Unauthenticated request | No valid customer session | 401/redirect to login; no payment created |
| Start MoMo charge | Valid customer, amount and network, sandbox secret | Create one pending record and show provider's authorization message |
| Customer cancels / times out | Provider returns failed/abandoned or remains pending then verifies failed | No wallet/card credit |
| Browser fakes success | Redirect query claims success, no verified provider success | No credit |
| Valid webhook | Correct HMAC signature and matching provider reference, amount and currency | Mark deposit successful exactly once |
| Invalid webhook signature | Wrong/missing signature | Reject and do not credit |
| Duplicate webhook | Same event/reference delivered repeatedly | Acknowledge safely; one ledger credit only |
| Reference collision | Existing reference used for another request | Reject; no duplicate credit |
| Amount/currency mismatch | Provider verification does not match pending deposit | Quarantine for review; no credit |
| Delayed provider response | Pending charge is checked again | Keep pending until server-side verification resolves it |
| Card issuer unavailable | Payment succeeds but issuer API times out | Deposit remains accounted for; top-up stays pending; retry/reconcile without charging again |
| Issuer top-up fails | Issuer explicitly reports failure | Do not mark card funded; retain traceable ledger entries and begin approved refund/reversal workflow |
| Duplicate issuer webhook | Same card creation/top-up event repeated | Process idempotently |
| FX/fee disclosure | Fee or exchange rate is absent/changed | Require a clear quote and user confirmation before charge |
| Secret leakage | Inspect browser bundle, logs and errors | No provider secrets, PAN, CVV or KYC documents exposed |
| Reconciliation | Compare Paystack settlements, refunds/reversals and Brails wallet/card transactions | Every amount/reference is matched or raised as an exception |

## Required data model (final names depend on existing DGM schema)

- `virtual_card_deposits`: internal UUID, customer ID, destination (`wallet` or `card`), GHS amount in pesewas, provider/network, unique payment reference, provider transaction ID, status, timestamps, verified payload digest, failure code.
- `virtual_card_ledger_entries`: append-only debit/credit entries, currency, amount in minor units, customer, deposit/card reference, idempotency key, entry type and timestamp.
- `virtual_cards`: internal ID, customer ID, issuer card ID, last four digits only, brand/type, issuer status and timestamps. Never store CVV; avoid storing full PAN.
- `virtual_card_topups`: internal ID, customer/card ID, GHS quote, fees, FX quote and expiry, USD amount, issuer reference, status and timestamps.

All money movement must use database transactions, unique constraints and explicit state transitions. Do not treat a UI balance as the ledger. The final schema must be reconciled with DGM's existing wallet and order tables before migration.

## Safe implementation sequence

1. Inspect the existing DGM session/auth middleware, PostgreSQL migration conventions, Paystack webhook raw-body handling and wallet ledger before writing routes.
2. Add database migrations and unit tests; do not modify existing wallet balances.
3. Implement sandbox-only MoMo charge creation behind a server-side feature flag and authenticated customer route.
4. Implement signature-verified Paystack webhook and server-side verify/reconciliation worker; make processing idempotent.
5. Integrate Brails sandbox only after obtaining sandbox credentials and checking current endpoint/authentication/webhook docs.
6. Test card creation/top-up with provider test identities and test funds.
7. Complete security review and Ghana regulatory/partner review.
8. Enable production only after written issuer approval, settlement confirmation, compliance approval and explicit deployment review.

## Not in scope until provider confirmation

- Live card creation or funding.
- Direct MoMo-to-card funding.
- Transfers/withdrawals from the card to Mobile Money.
- Any claim that DGM is itself a licensed card issuer or stores customer deposits.
