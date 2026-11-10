# LCARS Home Lab Dashboard

Live at **http://your-server:8088**

## Where the data comes from

| Panel | Source | Refresh |
|---|---|---|
| Speedtest | Speedtest Tracker API (:8765) | 2 min |
| SERVERMCSERVEFACE | Read directly by the backend (it runs on this machine) | 2 s |
| SMARTNAS | SNMP from the Synology (community in `.env`) | 5 s |
| MAC MINI M4 | Helper on the Mac at :8089 (`mac-helper/`) | 5 s |
| Plex | Tautulli API (:8181, in `~/tautulli` on the server). Cards are drawn by `lcarsCard()` in app.js, not real posters | 15 s |
| MeshCore | RemoteTerm API (:8080) | 15 s |

## What's where

| File | What it does |
|---|---|
| `.env` | All addresses, tokens and passwords. **Private.** Not baked into the Docker image. |
| `app/main.py` | The backend: runs the collectors, serves `/api/status` and the page. |
| `app/collectors.py` | One class per data source. |
| `app/static/` | The LCARS page (`index.html`, `lcars.css`, `app.js`). |
| `mac-helper/` | Little stats server for the Mac Mini, plus its installer. |

## Deploy after a change (run on the Mac)

```bash
cd ~/Documents/lcars-dashboard && rsync -a --exclude .venv --exclude __pycache__ --exclude .DS_Store --delete ./ you@your-server:~/lcars-dashboard/ && ssh you@your-server 'cd ~/lcars-dashboard && docker compose up -d --build'
```

If you change `lcars.css` or `app.js`, bump the `?v=` number in `index.html` so the tablet picks up the new file.

Logs on the server: `cd ~/lcars-dashboard && docker compose logs -f`

## Mac Mini helper

Install once (re-run after editing `stats_server.py`). It starts at login and restarts if it crashes:

```bash
bash ~/Documents/lcars-dashboard/mac-helper/install.sh
```

Remove it:

```bash
launchctl bootout gui/$(id -u)/com.lcars.machelper; rm ~/Library/LaunchAgents/com.lcars.machelper.plist
```
