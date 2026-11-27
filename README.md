# Exelidoc

Exelidoc is an AI assistant for Google Workspace, with an experimental Microsoft
Office add-in. The Chrome extension connects to a shared Flask API for accounts,
AI requests, history, quotas, Stripe subscriptions, and abuse controls.

## What works today

### Chrome extension

Install the unpacked extension from `browser-extension/` in Chrome or Edge. It
currently provides:

- **Gmail:** search messages and find/open matching messages. After the one-time
  Google connection, the extension indexes Inbox messages locally every five
  minutes while the browser is running. It stores at most 20,000 body characters
  per message. The index is not uploaded automatically.
- **Google Docs:** analyze or preview an edit to the active plain-text document.
  The current edit flow replaces the document text and does not support tables
  or embedded objects. You review the result before applying it.
- **Google Sheets:** select a cell range, describe the change, review a
  cell-by-cell preview, and approve it. Formula changes need a separate
  confirmation. The extension re-reads the range before writing.
- **Google Slides:** ask questions about presentation text. This is read-only.
- **Google sources in context:** search Gmail, Drive, Docs, Sheets, and Slides
  when requested. Select the sources to include in a request; selected content
  is sent to the backend and Gemini only when you submit that request.
- **Gmail drafts:** use selected email content as context and apply a reviewed
  draft to the open message. Exelidoc does not send the email.
- **Accounts and history:** email-verified signup, password login/reset,
  subscription management, account deletion, and shared question history.
  History shows the user's question and safe source references, not source text
  or AI responses.

The extension uses the production Render API URL in
`browser-extension/background.js`. Running the API locally does not redirect the
unpacked extension to localhost; avoid live billing unless that is intentional.
The checked-in Google OAuth client is for unpacked development, not the
published Chrome Web Store package.

### Microsoft Office add-in

`office-addin/` contains an **experimental preview**, not a production-ready
release. Its manifests target Word, Excel, and PowerPoint; Outlook has a
separate compose manifest. The task pane has text assistance and reviewed Excel
range edits, but Microsoft-host authentication and behavior have not been
verified across supported clients. It is not published in AppSource; do not use
the preview with important or production data.

### Website and backend

- `website/` is the static marketing site, privacy policy, and draft terms.
- `backend/` is the Flask API. Render serves the Office task pane files from
  `office-addin/`.
- Supabase stores account, history, quota, usage, rate-limit, and monthly
  Gemini-budget records.
- Gemini is called server-side; provider credentials do not belong in the
  extension or website.
- Stripe Checkout and the customer portal handle paid subscriptions. Stripe
  webhooks update account plans.

## Development setup

### Backend (Windows PowerShell)

From the repository root:

```powershell
Set-Location backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pip install pytest
Copy-Item ..\.env.example .env
```

Fill in development credentials in `backend/.env`; never commit that file. Keep
`FLASK_ENV=development` and use Stripe test credentials locally. Start the API
from `backend/`:

```powershell
python -m flask --app app run --debug --port 5000
```

Check `http://127.0.0.1:5000/api/health`. This health endpoint is a liveness
check; it does not verify Supabase, Gemini, or Stripe connectivity.

The unpacked extension still points at Render unless its `BACKEND_URL` is
changed locally in `browser-extension/background.js`. Do not point a development
extension at production unintentionally.

### Browser extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `browser-extension/`.
4. Configure the development OAuth client and add the resulting extension ID
   to the backend's allowed `FRONTEND_ORIGINS` when testing against a backend.

### Office add-in preview

From the repository root:

```powershell
Set-Location office-addin
npm install
npm start
```

The `start:excel`, `start:word`, `start:powerpoint`, and `start:outlook` scripts
are also available. Sideloading and client-specific authentication are not
certified production workflows.

## Google OAuth verification and Chrome Web Store release

The manifest requests these exact Google OAuth scopes:

| Scope | Google classification | What it allows |
| --- | --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | Restricted | Read Gmail messages, including inbox, sent mail, and drafts; no Gmail send/modify scope is requested. |
| `https://www.googleapis.com/auth/drive.readonly` | Restricted | View and download Drive files; this is broad access used to search Docs, Sheets, and Slides. |
| `https://www.googleapis.com/auth/documents` | Sensitive | Read and edit Google Docs. |
| `https://www.googleapis.com/auth/spreadsheets.readonly` | Sensitive | Read Google Sheets. |
| `https://www.googleapis.com/auth/spreadsheets` | Sensitive | Read and edit Google Sheets. |

Before submitting:

1. In Google Cloud Console, enable Gmail, Drive, Docs, Sheets, and Slides APIs.
2. Verify the public Exelidoc domain. Make the homepage and privacy policy
   accessible without sign-in, and use matching links on the OAuth consent
   screen and site.
3. Set the OAuth app to **External** and provide accurate app name, logo,
   support/developer contacts, authorized domain, and data-use disclosures.
4. Submit a justification for every requested scope. Explain why narrower
   scopes do not support inbox indexing and cross-file search. Do not claim
   Gmail sending: the extension uses read-only Gmail access and edits an open
   draft only after approval.
5. Record a reviewer demo showing the complete consent flow and each scope's
   user-facing feature. Keep the consent screen and feature behavior consistent.
6. Submit the Gmail and Drive restricted scopes for Google's restricted-scope
   verification. Because source content can be transmitted to the backend and
   Gemini after a user request, Google may require a third-party security
   assessment. Follow the current requirements shown in Cloud Console.
7. Separately complete Chrome Web Store listing, user-data, privacy, and
   single-purpose disclosures. Google OAuth verification and Web Store review
   are separate processes.
8. Replace the unpacked OAuth client ID in `browser-extension/manifest.json`
   with the published extension's client before packaging. Re-check the
   published extension ID in `FRONTEND_ORIGINS` and OAuth configuration.

Official references:

- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Drive API authorization](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Docs API scopes](https://developers.google.com/workspace/docs/api/auth)
- [Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes)
- [Google OAuth verification requirements](https://support.google.com/cloud/answer/13464321)
- [Google OAuth verification overview](https://support.google.com/cloud/answer/13463073)

## Supabase setup and migrations

Back up the database before applying migrations. For a new project, run
`backend/supabase/schema.sql` first, then the remaining migrations below in
order. For an existing project, check which migrations have already been
applied; do not rerun `migration_daily_request_limits.sql`, because it resets
every account's current 24-hour quota window.

1. `migration_add_tiers.sql`
2. `migration_add_session_token.sql`
3. `migration_add_password_auth.sql`
4. `migration_add_email_verification.sql`
5. `migration_customer_account_controls.sql`
6. `migration_add_history.sql`
7. `migration_history_metadata_only.sql`
8. `migration_history_questions_and_refs.sql`
9. `migration_daily_request_limits.sql`
10. `migration_ai_monthly_budget.sql`
11. `migration_ai_monthly_budget_alerts.sql`
12. `migration_api_rate_limits.sql`

`migration_history_metadata_only.sql` clears previously stored history prompts
and AI responses before enforcing metadata-only history. Review that data change
before applying it. For the current existing production database, the two new
operational migrations are `migration_ai_monthly_budget_alerts.sql` and
`migration_api_rate_limits.sql`, provided the base budget and account/history
migrations are already present.

The backend uses the Supabase **service-role** key server-side. Never place it
in the extension or website. The SQL enables row-level security and restricts
direct access to internal service tables.

## Backend configuration and production deployment

`.env.example` lists the backend settings. Important values:

- `FLASK_SECRET_KEY`: long, random, unique server secret.
- `FLASK_ENV=production`: enables strict startup validation and distributed
  authentication rate limits.
- `TRUSTED_PROXY_HOPS`: set to the number of trusted reverse proxies in front
  of the service. For a standard single Render ingress, set `1`; verify this
  if you add another proxy. Do not trust arbitrary client-supplied forwarding
  headers.
- `FRONTEND_ORIGINS`: exact HTTPS website and published Chrome extension
  origins; no wildcard.
- `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
- `GEMINI_API_KEY` and `GEMINI_MODEL`.
- `SENTRY_DSN`: required in production for error and spend alerts. Configure a
  Sentry Python/Flask project and alert rules before deploying.
- `API_PUBLIC_URL`, `APP_PUBLIC_URL`, and `BILLING_RETURN_URL`.
- Transactional email: `EMAIL_FROM_ADDRESS` and either `RESEND_API_KEY` or SMTP
  settings. Resend's HTTPS API is recommended on Render Free; outbound SMTP
  ports are restricted on that plan.
- `STRIPE_MODE=live` and matching `STRIPE_LIVE_*` credentials and recurring
  price IDs. Production rejects Stripe test mode.

For a Render service rooted at `backend/`, use `pip install -r requirements.txt`
as the build command and `gunicorn app:app` as the start command. Set all
production environment variables in Render's environment settings, not in the
repository. Configure the Stripe webhook at
`https://exelidocv4-5.onrender.com/api/stripe/webhook` for:
`checkout.session.completed`, `customer.subscription.updated`, and
`customer.subscription.deleted`.

The backend enforces:

- A shared $10 USD UTC-month Gemini spend ceiling, with a one-time Sentry
  warning at 80% and an alert when a request is blocked by the ceiling.
- Per-account AI request limits per rolling 24-hour period: Free 5, Monthly 10,
  Pro 20, Enterprise 50.
- Shared Supabase-backed authentication limits: signup 10/IP/hour and
  3/email/hour; login 30/IP/15 minutes and 10/email/15 minutes; password-reset
  request 10/IP/hour and 3/email/hour; verification and reset completion are
  also limited by IP and one-time token.
- Fail-closed auth throttling: if the rate-limit table/RPC is unavailable,
  unauthenticated auth endpoints return `503`, not an unthrottled success.
- Stripe webhook signature validation; processing failures are logged and
  return `500` so Stripe can retry.

Sentry events are scrubbed before transmission: request details, user identity,
breadcrumbs, extra fields, local variables, and exception messages are removed.
Only static monthly-budget alert names are retained as messages. Configure Sentry issue
notifications for new backend errors and the two AI-budget alert names. Sentry
event retention and notification recipients are managed in its dashboard.

## Data handling and customer disclosures

- The local Gmail index stays in the browser until Google is disconnected in
  Exelidoc or browser data/extension storage is removed. Account deletion alone
  does not clear that local index.
- History stores the user's question and safe source references; it does not
  store source text or AI responses. Users can clear history or delete their
  account. History has no automatic expiry.
- Email verification links expire after 24 hours; password-reset links expire
  after 30 minutes. Tokens are stored as hashes and carried in URL fragments,
  not sent in the initial page request.
- The monthly AI-budget table stores aggregate month totals without a user ID.
- Submitted text is sent to Gemini to fulfill the explicit user request.
  Provider and hosting logs/backups are controlled by their respective terms
  and settings; do not promise immediate deletion from those systems.
- `website/privacy.html` describes current behavior. `website/terms.html` is
  still a draft, and the support link is currently the project issue page.
  Replace it with a monitored customer-support contact and get qualified legal
  review before broad commercial launch.

## Backups, alerts, and rollback

These are account-level operations and are not enabled by repository code:

1. In Supabase, confirm the project's backup/PITR plan and retention window.
   Take a backup before each production migration and periodically test a
   restore into a separate project.
2. In Sentry, configure email/notification rules for new backend errors and
   the AI-budget warning/cap events. Verify delivery with a test event before
   release.
3. In Stripe, monitor webhook delivery and failed event retries in the Stripe
   Dashboard. A processing failure returns `500` and Stripe retries.
4. For a bad application deploy, use Render's **Deploys** page to roll back to
   the last known-good deployment. Then run the health check and smoke-test
   sign-in, AI, and Stripe webhook handling.
5. Application rollback does not undo a database migration. Review migration
   compatibility before release; restore the database from a tested backup
   only when necessary and follow Supabase's restore procedure.

`/api/health` checks that the Flask process responds; it is not a dependency
readiness check. Use Sentry and provider dashboards to diagnose database,
Gemini, Stripe, and email-provider failures.

## Tests

From the repository root:

```powershell
Set-Location backend
python -m pytest tests
Set-Location ..
node --test browser-extension\tests\*.test.js
```

Validate the Office manifests from `office-addin/`:

```powershell
Set-Location office-addin
npm run validate
npm run validate:outlook
```
