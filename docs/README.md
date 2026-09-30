# Exelidoc Google Docs Apps Script prototype

This is a separate, developer-only Google Docs add-on prototype. It is not
the Chrome/Edge extension and is not published in the Google Workspace
Marketplace. For the simpler Gmail and Google Docs install, use the browser
extension instructions on the website's Download page.

## Developer setup

Prerequisites: Node.js and the Google Apps Script CLI (`clasp`). The `docs/`
folder already contains its Apps Script project configuration.

```bash
npm install -g @google/clasp
clasp login
cd docs
clasp push
clasp open
```

In the Apps Script editor, open **Project Settings -> Script Properties** and
set:

- `EXELIDOC_BACKEND_URL` = `https://exelidocv4-5.onrender.com`
- `EXELIDOC_SESSION_TOKEN` = the session token from your Exelidoc account

Keep the session token private. The add-on reads it from Script Properties;
do not put it in `Code.gs` or commit it. `setConfig()` can set the backend URL.

## Test deployment

In Apps Script, choose **Deploy -> Test deployments -> Install**. Open a
Google Doc and choose **Extensions -> Exelidoc**. Publishing for other users
requires a separate deployment and Google authorization review.

## Current limitations

- A multi-paragraph selection only replaces the first selected text range.
- Inline formatting within replaced text is not preserved.
- This prototype uses a session token configured by the developer in Script
  Properties; it does not provide a per-user sign-in flow. Do not deploy it
  for general use without addressing that limitation.

The current Exelidoc signup flow does not verify email ownership and does not
support signing into an existing account from a fresh extension install. Add
verified account authentication before opening signup to the public.
