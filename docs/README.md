# Exelidoc -- Google Docs Add-on

This is a separate Apps Script project, not part of the Chrome extension.
Drop this whole `docs-addon` folder into the root of your repo, alongside
`browser-extension/` and `backend/`.

## One-time setup

```bash
npm install -g @google/clasp
clasp login
cd docs-addon
clasp create --type docs --title "Exelidoc"
clasp push
```

`clasp create` will generate its own `.clasp.json` with the new script ID --
that's expected, just let it write into this folder.

## Before first use

1. Open the project in the Apps Script editor (clasp will print a URL after
   `clasp create`, or run `clasp open`).
2. In `Code.gs`, select `setConfig` from the function dropdown at the top
   and click **Run**. This stores your backend URL and API key in this
   script's own PropertiesService store -- separate from the Chrome
   extension's `background.js`, since Apps Script runs on Google's
   servers and can't read files from the browser extension.
3. Edit the two placeholder values inside `setConfig()` in `Code.gs` first:
   - `EXELIDOC_BACKEND_URL` -> your deployed Render URL
     (e.g. `https://exelidoc-backend.onrender.com`)
   - `EXELIDOC_API_KEY` -> same shared testing key as `background.js`'s
     `DEFAULT_API_KEY`, for now

## Testing without publishing

Deploy -> Test deployments -> Install. Open any Google Doc, then
Extensions -> Exelidoc to open the sidebar. No Marketplace listing or
OAuth verification needed for this step -- that's only required once you
want other people to install it.

## Known limitations (v1)

- Multi-paragraph selections only replace the first paragraph in the
  selected range -- fine for single-paragraph edits, needs extending for
  larger selections.
- No formatting preservation beyond "don't touch text outside the
  selection" -- an edited selection itself loses inline formatting
  (bold/italic/links) since the AI only sees plain text.
- Shared `EXELIDOC_API_KEY` -- same caveat as the Chrome extension's
  `DEFAULT_API_KEY`. Swap to per-user keys before any real users touch
  this.
