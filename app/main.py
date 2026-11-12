"""
LCARS dashboard backend.

  GET /api/status   -> everything the page shows, as one JSON blob
  GET /api/detail/X -> extra data for panel X's full-screen view (e.g. hottub)
  GET /             -> the LCARS page itself (files in ./static)

Each collector (see collectors.py) runs in its own background loop.
Its latest result is kept in STATE and handed out on /api/status.
"""
import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

import collectors as c
from collectors import iso

log = logging.getLogger("uvicorn.error")
STATIC_DIR = Path(__file__).parent / "static"

# trust_env=False: ignore any proxy settings (almost everything we talk to is on the home network)
client = httpx.AsyncClient(timeout=8, trust_env=False)
COLLECTORS = [
    c.ServerStats(),
    c.NasSnmp(),
    c.MacStats(client),
    c.Plex(client),
    c.MeshCore(client),
    c.Weather(client),
    c.Indoor(client),
    c.HotTub(client),
    c.Repeater(client),
]

# STATE["nas"] = {"configured": True, "ok": True, "error": None, "updated_at": "...", "data": {...}}
STATE = {}


async def run_collector(col):
    entry = STATE[col.name]
    while True:
        try:
            entry["data"] = await col.collect()
            if hasattr(col, "sample"):   # system panels: keep minute averages for the detail graphs
                try:
                    c.HISTORY.add(col.name, col.sample(entry["data"]))
                except Exception as exc:
                    log.warning("%s: history not saved: %s", col.name, exc)
            entry["updated_at"] = iso(time.time())
            if not entry["ok"]:
                log.info("%s: back online", col.name)
            entry["ok"], entry["error"] = True, None
        except Exception as exc:  # keep the last good data, just flag it
            message = str(exc) or exc.__class__.__name__
            if entry["error"] != message:
                log.warning("%s: %s", col.name, message)
            entry["ok"], entry["error"] = False, message
        # After a failure, try again within a minute instead of waiting a full slow interval
        # (weather is every 10 min, so one internet blip would blank it for 10 min)
        await asyncio.sleep(col.interval if entry["ok"] else min(col.interval, 60))


@asynccontextmanager
async def lifespan(app):
    tasks = []
    for col in COLLECTORS:
        STATE[col.name] = {"configured": col.configured(), "ok": False, "error": None,
                           "updated_at": None, "data": None}
        if col.configured():
            tasks.append(asyncio.create_task(run_collector(col)))
        else:
            log.info("%s: not configured, skipping", col.name)
    yield
    for t in tasks:
        t.cancel()
    await client.aclose()


app = FastAPI(title="Yet Another LCARS Dashboard", lifespan=lifespan)


@app.middleware("http")
async def no_stale_pages(request, call_next):
    """Make browsers re-check the page files each load, so updates show up on a plain refresh."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/status")
def status():
    return {"generated_at": iso(time.time()),
            "title": c.env("DASHBOARD_TITLE", "HOME LAB OPERATIONS"), **STATE}


@app.get("/api/detail/{name}")
async def detail(name: str, hours: float = 24):
    """Extra data for a panel's full-screen view (longer history), only asked for while it's open."""
    col = next((col for col in COLLECTORS if col.name == name and hasattr(col, "detail")), None)
    if col is None or not col.configured():
        raise HTTPException(404, "no detail view for " + name)
    try:
        return await col.detail(hours=hours)
    except Exception as exc:
        raise HTTPException(502, str(exc) or exc.__class__.__name__)


# Must come last: anything that isn't /api/... is treated as a file in ./static
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
