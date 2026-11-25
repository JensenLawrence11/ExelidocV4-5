# Exelidoc


AI writing/data assistant across Google Docs, Gmail, Word, Excel, PowerPoint, and Outlook —
like Grammarly/Honey, but powered by your own AI backend.


## Structure


```
Exelidoc/
├── backend/            Flask API — the shared brain. Calls the AI, handles
│                        Stripe subscriptions, auth. Both frontends below
│                        talk to this over HTTPS. Nothing else calls the AI
│                        API directly — keys never leave the server.
├── office-addin/       Task pane add-in for Word/Excel/PowerPoint/Outlook.
│                        HTML/CSS/JS, driven by Office.js. Currently scaffolded
│                        for Excel first.
├── browser-extension/  Manifest V3 extension for Gmail + Google Docs.
│                        Content scripts + popup, HTML/CSS/JS.
└── website/             Static marketing site (plain HTML/CSS/JS). Just a
                          landing page + GitHub download link for now — no
                          backend needed for this piece.
```


## Local backend quick start

Gunicorn is a Linux WSGI server, so run the backend inside WSL. The backend
already exposes the WSGI application as `app:app` and includes Gunicorn in
`backend/requirements.txt`.

### 1. Install WSL (one-time Windows setup)

Open PowerShell as Administrator:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if prompted, then open Ubuntu from the Start menu and create
your Linux username and password.

### 2. Create the Linux environment

Run these commands in the Ubuntu terminal. This example uses the existing
Windows checkout; keeping the project under your Linux home directory is
usually faster for development.

```bash
cd /mnt/c/Users/lawrenjw/Desktop/ExelidocV4-4/backend
sudo apt update
sudo apt install -y python3 python3-venv python3-pip
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Create or edit `backend/.env` with the required API keys. Do not commit it.

### 3. Run with Gunicorn

From the `backend` directory, with the virtual environment active:

```bash
python -m gunicorn --bind 0.0.0.0:5000 --workers 1 --threads 2 app:app
```

Check it from Windows at <http://127.0.0.1:5000/api/health>. Stop Gunicorn with
`Ctrl+C`.

For local development with automatic reload, use Flask instead:

```bash
flask --app app run --debug --host 0.0.0.0 --port 5000
```


### Office Add-in (Excel)
--powershell


cd office-addin
npm install
npm start                         # sideloads into Excel, serves on https://localhost:3000




### Browser Extension
Chrome/Edge → `chrome://extensions` → Enable Developer Mode → Load Unpacked → select `browser-extension/`

The unpacked extension uses the production Render API, including live Stripe
Checkout when Render is configured for live mode. Its Stripe mode comes from
Render, not the local `backend/.env`. Treat checkout links opened from this
extension as live purchases.

#### Google Docs API setup

The Chrome extension edits Docs through the Google Docs API. The manifest's
`oauth2` section contains the Chrome Extension OAuth client ID and the
`https://www.googleapis.com/auth/documents` scope. In Google Cloud, enable the
Google Docs API and register the published Chrome Web Store extension ID on that
OAuth client. For unpacked development, register its separate extension ID with
a development OAuth client. The extension requests Google Docs access when the user generates a preview. Google
OAuth consent configuration and any required verification must be completed
before publishing this permission. Exelidoc reads the full plain-text document
and shows a proposed replacement for review before writing anything. Applying
the preview replaces the full document text; original formatting is not
preserved. Documents containing tables or embedded objects are rejected without
changes. Writes and Undo are guarded by the Docs revision, so an edit made
after a preview stops the operation instead of being overwritten.
The checked-in manifest currently uses the unpacked development client
`733957481846-72v784csg244sum7vrthd2j10cdg29am.apps.googleusercontent.com`.
Before preparing a Web Store package, change it to the published extension's
client `733957481846-qurs99dqiuu20o48q8f8nifeko2sl3d5.apps.googleusercontent.com`.


### Website
Just open `website/index.html`, or `python -m http.server` from inside `website/`.


## Environment variables


See `.env.example` at the repo root for the full list (AI provider key, Stripe keys,
Flask secret key, etc). Copy it to `backend/.env` and fill in real values — never commit
the real `.env` file (already covered in `.gitignore`).

When `FLASK_ENV=production`, the backend validates its configuration at startup.
Set a non-default `FLASK_SECRET_KEY`, the Supabase and AI provider credentials,
`EMAIL_FROM_ADDRESS` and either `RESEND_API_KEY` or SMTP settings, Stripe
secret/webhook secrets and all active recurring price IDs, and `BILLING_RETURN_URL`
to the actual HTTPS website page customers should return to from Stripe's billing
portal. Set `FRONTEND_ORIGINS` to exact allowed origins (the HTTPS website origin and the
published `chrome-extension://<extension-id>` origin); wildcard origins are
rejected. If using the unpacked extension against Render, temporarily include
its generated `chrome-extension://<unpacked-id>` origin as well.

For transactional email, Resend's HTTPS API is recommended on Render Free;
Render Free web services block outbound SMTP ports 25, 465, and 587. Verify
your sending domain with Resend before setting `RESEND_API_KEY` in the backend
host's environment. When `RESEND_API_KEY` is set, the backend uses Resend;
otherwise it falls back to the configured SMTP transport.
Set `API_PUBLIC_URL` to the backend's public HTTPS origin (the Render service
URL), because email verification and password-reset links must reach the API.
`APP_PUBLIC_URL` is the website origin used for checkout redirects, not email
action links.

### Stripe paid plans

Set `STRIPE_MODE=test` or `STRIPE_MODE=live` and provide credentials with the
matching `STRIPE_TEST_*` or `STRIPE_LIVE_*` names. Production startup rejects
test mode or a test secret key. Existing deployments can keep using generic
`STRIPE_*` variables in live mode; `STRIPE_LIVE_*` values take precedence when
present. Create active recurring prices for Monthly, Pro, and Enterprise in the selected
Stripe mode. Their `price_...` IDs are not Product IDs (`prod_...`). Configure a Stripe webhook pointing to
`https://exelidocv4-5.onrender.com/api/stripe/webhook` for
`checkout.session.completed`, `customer.subscription.updated`, and
`customer.subscription.deleted`, then set its signing secret as
`STRIPE_TEST_WEBHOOK_SECRET` or `STRIPE_LIVE_WEBHOOK_SECRET` for the selected
mode. Existing live deployments may continue using `STRIPE_WEBHOOK_SECRET`.
Checkout can succeed without the webhook, but paid access will not be recorded
in Exelidoc until the webhook is delivered.

Daily AI request limits use a rolling 24-hour window: 5 for Free, 10 for Monthly,
20 for Pro, and 50 for Enterprise. Apply `backend/supabase/migration_daily_request_limits.sql`
once when deploying the change to reset existing accounts into a fresh window.

Before enabling email verification and password recovery, apply these SQL
migrations once in the Supabase SQL Editor, in order:

1. `backend/supabase/migration_add_session_token.sql`
2. `backend/supabase/migration_add_password_auth.sql`
3. `backend/supabase/migration_add_email_verification.sql`
4. `backend/supabase/migration_customer_account_controls.sql`

They add the account/session fields, pending signups, and password-reset
functions used by the login and recovery routes.
Enable Stripe's Customer Portal in the Stripe dashboard and configure its
allowed cancellation and plan-management behavior before enabling customer
billing controls. The extension requires active subscriptions to be canceled
and confirmed as ended before it allows account deletion.

The website's `terms.html` and `privacy.html` are working customer-information
drafts, not approved commercial legal documents. Replace repository issue links
with a monitored customer support contact, establish retention and refund
policies, and have qualified counsel review the final disclosures before launch.

### Focused tests

From the repository root, run the backend suite with:

```powershell
python -m pytest backend\tests
```

Install `pytest` in the active development environment if it is not already
available. Run the extension service-worker tests with:

```powershell
node --test browser-extension\tests\background.test.js
```


## Status


- [x] Project structure scaffolded
- [ ] Backend `/api/analyze` endpoint (real AI logic)
- [ ] Stripe subscription flow
- [ ] Excel task pane wired to backend
- [ ] Browser extension content scripts (Gmail, Google Docs)
- [ ] Marketing site content + design pass


### To stop server
npm stop
