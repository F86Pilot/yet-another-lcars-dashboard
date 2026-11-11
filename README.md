# LCARS Home Lab Dashboard

Live at **http://your-server:8088**

## Where the data comes from

| Panel | Source | Refresh |
|---|---|---|
| SERVERMCSERVEFACE | Read directly by the backend (it runs on this machine). Tap for top apps by CPU / memory / network: needs `pid: host` and the `cap_add` list in docker-compose.yml; network per app comes from `nethogs` | 2 s |
| SMARTNAS | SNMP from the Synology (community in `.env`). Tap for top processes by CPU / memory, and connections per service (Synology has no per-app bandwidth) | 5 s (top apps 15 s) |
| MAC MINI M4 | Helper on the Mac at :8089 (`mac-helper/`). CPU temperature needs `brew install macmon`. Tap for top apps; network per app uses macOS `nettop`. After changing the helper, re-run `bash mac-helper/install.sh` | 5 s |
| Plex | Tautulli API (:8181, in `~/tautulli` on the server). Tiles with the show's initials, drawn by `lcarsCard()` in app.js | 15 s |
| MeshCore | RemoteTerm API (:8080) | 15 s |
| Outside | Open-Meteo weather + air quality (internet, free, no key). Location = `WEATHER_LAT/LON` | 10 min |
| Solar repeater | MeshCore repeater status via RemoteTerm (login + status over the mesh). Readings saved in `data/repeater.db` on the server. Shares the MeshCore spot, tap to switch | 60 min |
| Indoor climate | ecobee via Home Assistant (:8123, in `~/homeassistant` on the server). Needs `HA_TOKEN` | 30 s |

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
cd ~/Documents/lcars-dashboard && rsync -a --exclude .git --exclude data --exclude .venv --exclude __pycache__ --exclude .DS_Store --delete ./ you@your-server:~/lcars-dashboard/ && ssh you@your-server 'cd ~/lcars-dashboard && docker compose up -d --build'
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
