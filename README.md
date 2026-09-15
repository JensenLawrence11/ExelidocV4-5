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


### Website
Just open `website/index.html`, or `python -m http.server` from inside `website/`.


## Environment variables


See `.env.example` at the repo root for the full list (AI provider key, Stripe keys,
Flask secret key, etc). Copy it to `backend/.env` and fill in real values — never commit
the real `.env` file (already covered in `.gitignore`).


## Status


- [x] Project structure scaffolded
- [ ] Backend `/api/analyze` endpoint (real AI logic)
- [ ] Stripe subscription flow
- [ ] Excel task pane wired to backend
- [ ] Browser extension content scripts (Gmail, Google Docs)
- [ ] Marketing site content + design pass


### To stop server
npm stop

