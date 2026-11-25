# Family portal

A small public site where a family looks up their account and pays. It is **separate from the board finance site** (that site sits behind a site-wide Netlify password; this one must be public) and it uses **its own Stripe key**.

Families:
1. Sign in with **any email listed for their player** and the **last 4 digits of any phone number listed for that player** (either parent's email works with either parent's phone). These come from a Google Sheet tab, not from Stripe.
2. See each player's status, what's paid, what's left, the schedule, and payment history.
3. **Pay now**: the past-due balance (down payment and/or overdue installments), or the next installment.
4. **Start monthly payments**: a Stripe subscription that stops by itself after the last installment.

Nothing is stored anywhere except Stripe. The ledger rules are the same as the board site (`lib/fees.mjs`, `lib/ledger.mjs`, `lib/logic.mjs` are copies; keep them in sync when you change fee plans or per-player exceptions).

## Try it with fake data (no Stripe)
    node test.mjs        # 28 tests
    node dev.mjs         # http://localhost:8888, sign in with demo@example.com / 1234

## Deploy
1. New Netlify site from this folder (drag-and-drop works). Do **not** put a Netlify password on it.
2. Stripe Dashboard > Developers > API keys > **Create restricted key** for this site only:
   - Checkout Sessions: **Write**
   - Customers, Charges, Invoices: **Read**
   - PaymentIntents: **Write** (the webhook copies a plan's tags onto each of its payments)
   - Subscriptions: **Write** (needed to set the end date of monthly plans)
3. Stripe > Developers > Webhooks > Add endpoint: `https://YOUR-SITE/api/stripe-webhook`, events `checkout.session.completed` and `invoice.payment_succeeded`. Copy its signing secret.
4. Netlify > Site settings > Environment variables:
   - `STRIPE_API_KEY` = the restricted key from step 2
   - `GOOGLE_SERVICE_ACCOUNT_JSON`, `CONTACTS_SHEET_ID` (see the contacts section)
   - `STRIPE_WEBHOOK_SECRET` = the `whsec_...` value
   - `SITE_URL` = your portal's address (optional; Netlify's own URL is used if omitted)
5. Turn on **ACH / US bank account** in Stripe > Settings > Payment methods (cards work without it).
6. **Test in Stripe test mode first** (test key, test webhook, a test customer with your email and a phone number). I could not reach Stripe from my sandbox, so everything is tested against a fake Stripe, not the real one.

## The contacts sheet (who can sign in)
`sample/family_contacts.csv` is built from both registration reports: 66 contacts, 34 players, one row per parent/guardian:

    org, team, player, name, relationship, email, phone, birthdate

1. Create a Google Sheet (a **separate** one is best: it holds only these 7 columns, not the birthdates and addresses from registration), name a tab `Contacts`, and import the CSV into it.
2. Share the sheet (Viewer) with the same service account email you used for the board sheet.
3. Netlify env vars on the portal: `GOOGLE_SERVICE_ACCOUNT_JSON` (same JSON as the board site), `CONTACTS_SHEET_ID`, optional `CONTACTS_RANGE` (default `Contacts!A:Z`).
4. New registrations: paste new rows (the page re-reads the sheet about once a minute). Player names should match the `player` tag used in Stripe (middle names don't matter: first and last word must match). `team` is blank in the import; fill it in or leave it (Stripe's team tag is used when a player has payments).
- A family signs in with three things: an email listed for a player, the last 4 digits of **any** phone listed for that player, and the **birth date** of any player on that email (any parent/child combination works). Birth dates in `birthdate` can be written 2012-09-09, 9/9/2012 or 09-Sep-2012; a player with a blank or wrong birth date can't sign in until it's fixed in the sheet. Siblings sharing an email appear together.
- Payments are found exactly the way the board site finds them: every Stripe charge since the season start, tagged by `org`/`player` on the payment, then its subscription, then its customer. A family's players (from the sheet) pick out their own payments, so it doesn't matter which email or customer record a payment was made under. The `player` tag must match the sheet's name (middle names don't matter: first and last word must match).
- Players with no payments yet appear (using the sheet's name) and can pay their down payment.
- If a family has no Stripe customer yet, Checkout creates one with the email they signed in with.

## Stripe notes
- Each page load reads the season's charges, subscriptions and invoices from Stripe (as the board site does), so the key needs Read on those plus Customers and PaymentIntents.

## How amounts are decided
The browser only says *which player and which button*. The server re-verifies the login, recomputes the amount from Stripe and the fee plan, and builds the checkout itself.
- **Pay now:** the family can change the amount: any amount from $25 up to everything still owed on the season. The suggested amount is the past-due balance (or the next installment).
- **Pay now (suggested amount):** missing down payment + installments whose month has ended and aren't covered yet. If nothing is overdue and no subscription is running, it offers the next installment.
- Voltage has two installment amounts (bank $162, card $167). Families choose bank or card first, and checkout only allows that method. Summit has one amount, so both are allowed.
- **Monthly payments:** charged today = down payment + installments through the current month. Then the recurring amount on the **1st** of each remaining month. Not offered when the player already has an active subscription, nothing remains, or the org uses `skip_months`.
- The subscription's end date can't be set from Checkout, so the **webhook** sets `cancel_at` after checkout completes. If the webhook isn't working, plans would keep charging after the last installment, so check the Stripe webhook log after your first test.
- Bank payments show as "processing" (with a warning) until they clear, so families don't pay twice. They aren't counted as paid until Stripe marks them succeeded.

## Security: please read
- **Email + last 4 of phone is a weak login.** Anyone who knows a family's email has 10,000 phone-digit codes, and now must also know a child's birth date (a bit better odds now that either parent's phone works). Mitigations here: generic failure messages, a short delay on failure, a 5-failure lockout (best-effort, only while a function instance is warm), and Netlify rate limiting (10 requests/minute per visitor, set in each function's `config`). What an intruder could see is limited to that family's balance and payment history, and the only action is paying (money goes in, never out). No card or bank details are shown or stored; payment happens on Stripe's own page.
- Stronger option: send an emailed one-time link instead of asking for the phone digits.
- Credentials are never put in the URL. They're kept in the browser tab's session storage for 30 minutes so the Back button from Stripe doesn't force a new sign-in (closing the tab or Sign out clears them), and they're re-checked on every request.
- Keep this key separate from the board's read-only key. Never paste either into chat or commit them.

## Players with monthly payments already set up
They get no payment options (their subscription handles it) and an **Update payment method** button that opens Stripe's customer portal.
- Turn it on: Stripe > Settings > Billing > **Customer portal** > activate. Enable only **Update payment methods** (leave cancel/pause/plan changes off). Do this in test mode and in live mode.
- The portal key needs **Customer portal sessions: Write** (shown as "Customer portal" in the restricted-key list).
- Security: the portal page shows the card on file (brand and last 4) and billing details, and lets the person replace the card. That is more than the balance and history a family sees on the account page, so the weak email + phone-digits login matters more here. An emailed one-time sign-in link would close that gap.

## Not included (by design)
- Cancelling or changing a subscription. Families contact you; you do it in Stripe.
- Scholarship or waived players need an entry in `players` in `lib/fees.mjs` (as on the board site), otherwise they'd show a full balance. In this registration data that matters for Leah Anderson (scholarship request, no override yet).

## Files
- `public/index.html`, `brand.js`, `brand/`: the page (`?org=voltage` or `?org=summit` brands the sign-in page; after sign-in it follows the player's org)
- `netlify/functions/account.mjs`, `checkout.mjs`, `stripe-webhook.mjs`
- `lib/contacts.mjs` (reads the contacts tab, login matching), `sample/family_contacts.csv`
- `lib/portal.mjs` (login, account view, checkout), `lib/stripe.mjs`, `lib/webhook.mjs`, `lib/demo.mjs` (fake Stripe)
