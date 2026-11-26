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

#### Google account access

The extension uses Chrome OAuth for on-demand Gmail, Drive, Docs, Sheets, and
Slides access. In Google Cloud, enable the Gmail API, Drive API, Google Docs
API, Google Sheets API, and Google Slides API. Register the published Chrome
Web Store extension ID on its OAuth client; register the separate unpacked
extension ID on a development OAuth client. Add test users when the OAuth
consent screen is in testing. Configure the OAuth consent screen and complete Google's required
verification before publishing the Gmail, Drive, and spreadsheet permissions.
The user connects a Google account once in the extension for Gmail, Docs, and
Sheets access. Searching is initiated only when requested, and source contents
are sent to Gemini only when the user asks. Matching Gmail messages can be
selected as context for Docs edits, Sheets edits, and Gmail drafts. The extension also indexes inbox
messages locally every 5 minutes while Chrome is running (up to 20,000 body
characters per message); email contents stay in the local Chrome profile and
are sent to Gemini only after the user asks. Disconnecting Google clears the local index. History
displays the user's question and stores safe Google source IDs for explicit
follow-ups; source contents and AI responses are not retained.

Google Docs edits use a reviewed full-text replacement and reject documents
containing unsupported tables or embedded objects. Users can optionally find
and include Gmail messages as context before previewing a Docs change. The
Exelidoc launcher
appears inside an open Sheet, where users highlight cells, select them for
Exelidoc, describe the requested change, optionally include matching Gmail
emails, review the
proposed cell-by-cell changes, and approve before applying. The initial Google
setup requests Gmail, Docs, and spreadsheet access together. Existing users see a
one-time **Finish Google setup** action in the popup to approve the added scopes;
afterward there is no separate Sheets connection. Formula changes require an
additional checkbox and confirmation.
Spreadsheet edits re-read the range before writing and stop if it changed
after the preview. Neither flow sends email messages; approved edits write
only to the reviewed document or cells.

The connected-account search flow currently covers Google only. Microsoft
Graph search across Outlook mail and OneDrive/Office files is not implemented;
the Office add-in continues to work with the active Office document.

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

AI requests call Google's Gemini Developer API directly using `GEMINI_API_KEY`
and `GEMINI_MODEL` (default `gemini-4-hydrogen`). The backend enforces a shared
$10 USD calendar-month spend ceiling using Supabase; run
`backend/supabase/migration_ai_monthly_budget.sql` before deploying this version.
The cap applies to requests through this backend only. Keep the Gemini key
restricted to the Gemini API and do not reuse it elsewhere.

Exelidoc history displays the user's question and stores validated source
references; it never stores source content or AI responses. Before deploying
that behavior, run `backend/supabase/migration_history_metadata_only.sql` and
then `backend/supabase/migration_history_questions_and_refs.sql` in Supabase.
The first migration clears previously saved prompts/responses; the second
allows capped user questions and structured Google source references while
continuing to enforce empty AI responses.

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
node --test browser-extension\tests\*.test.js
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
