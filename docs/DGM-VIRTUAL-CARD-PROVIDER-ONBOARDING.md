# DGM Virtual Card — Provider Onboarding and Integration Plan

**Status:** Pre-integration planning only. No live payment or card issuance is enabled.
**Date:** 14 October 2026
**Repository work:** Pull request #10, `feature/dgm-virtual-card-preview`

## 1. Issuer onboarding request (send to Brails)

**To:** onboarding@onbrails.com  
**Subject:** Issuer onboarding and Ghana Mobile Money funding feasibility — DHE GENIUS MEDIA (DGM)

Hello Brails Onboarding Team,

DHE GENIUS MEDIA (DGM) is a Ghana-focused digital services business exploring a compliant virtual Visa card product for eligible customers. We are assessing your virtual card API and would like to confirm whether you can onboard our business and support this use case before we build or enable any real-money features.

Could you please confirm:

1. Whether a Ghana-registered business serving customers in Ghana is eligible to apply for a live virtual Visa card program, and which KYB documents, minimum balances, volumes or reserves are required.
2. Whether Ghana-resident cardholders can be onboarded using the accepted Ghanaian identity documents, and the complete KYC/KYB, sanctions screening and ongoing compliance requirements.
3. Whether our business can collect customer payments in GHS through an approved Ghana Mobile Money provider, convert/settle those funds compliantly into the Brails USD business wallet, and then top up the customer's card. Please identify permitted settlement routes and any restrictions on third-party payment collection.
4. Whether direct Mobile Money-to-card funding is supported, or whether the only supported path is business-wallet-to-card top-up.
5. The current card creation, top-up, FX, settlement, decline, chargeback, reversal, withdrawal and termination fees; minimum/maximum amounts; and any other fees.
6. Whether withdrawals from a card return funds only to the Brails business wallet, and whether cardholder withdrawals or refunds to Ghana Mobile Money are supported.
7. Which sandbox APIs, webhook signing/verification methods, idempotency controls, test credentials and test scenarios are available.
8. The required customer disclosures, cardholder terms, permitted use cases, support/complaints responsibilities and any card-program branding restrictions.
9. The expected onboarding timeline and the formal steps for production approval.

We will keep the product in preview/sandbox mode until eligibility, settlement, compliance and production access are confirmed in writing. We will not collect or store card PINs, and we intend to avoid storing full card numbers or CVVs in our systems.

Please let us know the next onboarding steps and any documents you require from DGM.

Kind regards,  
DHE GENIUS MEDIA (DGM)  
Stay Connected. Stay Genius.

---

## 2. Payment collection confirmation required

Paystack's published Ghana Mobile Money channel documentation lists:
- MTN: `mtn`
- Telecel: `vod`
- AT Money / Airtel Money: `atl`

The payment flow uses customer authorization on their phone and a server-side webhook / transaction verification to determine final status. This does **not** by itself confirm that funds may be settled to a card issuer's USD wallet. Obtain written confirmation from Paystack and the issuer on settlement, conversion, reconciliation, refunds, chargebacks and permitted use before enabling a card top-up.

## 3. Target architecture

1. Authenticated DGM customer chooses a destination: DGM Wallet or Virtual Card.
2. Server validates amount, customer eligibility, provider/network, limits and idempotency key.
3. Server creates a pending deposit and requests a GHS Mobile Money charge from the approved payment provider.
4. UI tells the customer to authorize the prompt on their phone; it never asks for the Mobile Money PIN.
5. Server verifies signed webhook authenticity and/or queries the provider API. Browser redirects are never proof of payment.
6. A single idempotent ledger operation marks the deposit successful only after verified success.
7. For wallet funding, credit the DGM wallet ledger.
8. For card funding, check the issuer's written-approved settlement path and available business USD balance; apply disclosed fees/FX and request issuer top-up. Mark the card top-up complete only after the issuer confirms success by its documented status/webhook.
9. Reconcile payment-provider collections, refunds/chargebacks, FX, issuer-wallet debits and card balances on a schedule.

## 4. Required engineering controls

- Use database transactions and unique provider references/idempotency keys to prevent duplicate credits.
- Keep an append-only ledger; never change a balance without a corresponding ledger entry.
- Validate webhook signatures according to the provider's current official instructions and verify the transaction amount, currency, reference and final status server-side.
- Track separate states: `created`, `awaiting_authorization`, `payment_verified`, `issuer_topup_pending`, `completed`, `failed`, `reversed`, `refunded`.
- Do not log API secrets, identity document images, full PAN, CVV, or authentication data.
- Keep all provider secrets in Render environment variables, never in source control or browser code.
- Require KYC/eligibility checks and clear fee/FX confirmation before a customer authorizes payment.
- Test webhook retries, duplicate events, timeouts, reversals, late confirmations, issuer failures and reconciliation in sandbox.
- Keep production card issuance and real-money endpoints disabled until issuer approval, payment settlement confirmation, regulatory/compliance review and security review are complete.

## 5. Compliance launch gate

The Bank of Ghana describes specific permitted activities for licensed payment service providers, including limited-use closed-loop virtual cards for certain PSP-Enhanced activities. This does not establish that DGM's proposed open-loop Visa product is covered. Obtain qualified Ghanaian regulatory advice and written confirmation of the applicable licensing/partnering model before public launch.

## 6. Current implementation status

- The existing `dgm-virtual-card.html` is a UI preview.
- It includes the two proposed funding destinations and three Ghana Mobile Money network choices.
- The preview action only displays a message. It does not initiate a charge or change balances.
- No provider credentials, live payment endpoints, issuer calls, or production card creation have been added.
