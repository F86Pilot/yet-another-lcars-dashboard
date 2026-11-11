"""
Collectors: each one fetches one kind of data on its own schedule.

Every collector has:
  name      -> the key it appears under in /api/status
  interval  -> seconds between refreshes
  configured() -> False if its settings are missing (panel shows NOT CONFIGURED)
  collect()    -> returns a dict of data, or raises an error (panel shows NO CONTACT)

Settings come from environment variables, which Docker loads from the .env file.
"""
import asyncio
import os
import re
import shutil
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

import httpx
import psutil


def env(name, default=None):
    value = os.environ.get(name, "").strip()
    return value or default


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


class Collector:
    name = "base"
    interval = 10

    def configured(self):
        return True

    async def collect(self):
        raise NotImplementedError


# ------------------------------------------------------------------
# Shared helpers for "system" panels (server, NAS, Mac all look alike)
# ------------------------------------------------------------------

class RateTracker:
    """Turns ever-growing byte counters into bytes-per-second, with history."""

    def __init__(self, points=90):
        self.prev = None
        self.rx_hist = deque(maxlen=points)
        self.tx_hist = deque(maxlen=points)

    def update(self, rx_bytes, tx_bytes):
        now = time.monotonic()
        rx_rate = tx_rate = 0.0
        if self.prev:
            dt = now - self.prev[0]
            if dt > 0:
                rx_rate = max(0.0, (rx_bytes - self.prev[1]) / dt)
                tx_rate = max(0.0, (tx_bytes - self.prev[2]) / dt)
                self.rx_hist.append(round(rx_rate))
                self.tx_hist.append(round(tx_rate))
        self.prev = (now, rx_bytes, tx_bytes)
        return {
            "rx_bps": round(rx_rate),
            "tx_bps": round(tx_rate),
            "rx_hist": list(self.rx_hist),
            "tx_hist": list(self.tx_hist),
        }


def cpu_temperature():
    """Best-effort CPU temperature on Linux. Returns None if unavailable."""
    if not hasattr(psutil, "sensors_temperatures"):
        return None
    try:
        temps = psutil.sensors_temperatures()
    except Exception:
        return None
    for chip in ("coretemp", "k10temp", "cpu_thermal", "acpitz"):
        for reading in temps.get(chip, []):
            if reading.current:
                return round(reading.current)
    return None


# ------------------------------------------------------------------
# servermcserveface (the machine this backend runs on)
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# "What's using it": top apps by CPU, memory and network
# ------------------------------------------------------------------

TOP_N = 5
INTERPRETERS = ("python", "node", "java", "bun", "ruby", "perl")


def app_label(name, cmdline=None, exe=None):
    """A friendly app name. Groups helpers/workers under their app
    ("Google Chrome Helper (Renderer)" -> "Google Chrome") and names
    Python/Node programs after their script or module instead of "python3"."""
    name = (name or "?").strip()
    if name.startswith(("kworker", "ksoftirq", "rcu_", "migration/", "kcompact", "kswapd", "jbd2")):
        return "KERNEL"
    # Linux cuts process names at 15 characters; the full program path has the whole name
    full = os.path.basename(exe or (cmdline[0] if cmdline else "") or "")
    if len(name) == 15 and full.startswith(name):
        name = full
    if name.lower().startswith(INTERPRETERS) and cmdline:
        args = cmdline[1:]
        if "-c" in args:
            return name
        if "-m" in args and args.index("-m") + 1 < len(args):
            return args[args.index("-m") + 1].split(".")[0]
        for a in args:
            if not a.startswith("-"):
                return os.path.basename(a).removesuffix(".py").split(":")[0]
    return re.sub(r" Helper.*$|: .*$", "", name)


def top(totals, n=TOP_N):
    return [{"name": k, "value": v} for k, v in sorted(totals.items(), key=lambda kv: -kv[1])[:n] if v > 0]


def process_top():
    """CPU (% of the whole machine) and memory (bytes), grouped by app."""
    ncpu = psutil.cpu_count() or 1
    cpu, mem = defaultdict(float), defaultdict(int)
    for p in psutil.process_iter(["name", "cmdline", "exe", "memory_info"]):
        try:
            label = app_label(p.info["name"], p.info["cmdline"], p.info["exe"])
            cpu[label] += p.cpu_percent(None) / ncpu   # psutil keeps each process between calls
            if p.info["memory_info"]:
                mem[label] += p.info["memory_info"].rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return {"cpu": top(cpu), "mem": top(mem)}


class NetHogs:
    """Runs `nethogs` in the background and keeps the latest per-app bandwidth.
    Needs the container's host network + host PID view + NET_ADMIN/NET_RAW/SYS_PTRACE
    (see docker-compose.yml). Without nethogs it simply reports nothing."""

    def __init__(self):
        self.latest = None
        self.task = None

    def start(self, iface):
        if self.task is None and shutil.which("nethogs"):
            self.task = asyncio.create_task(self._run(iface))

    @staticmethod
    def _label(ident):
        path, pid, _uid = (ident.rsplit("/", 2) + ["", ""])[:3]
        m = re.match(r"[\d.]+:\d+-([\d.]+):(\d+)$", path)
        if m:   # traffic the kernel handles itself, e.g. the NFS mount of the NAS
            if m.group(2) != "2049":
                return "KERNEL"
            nas = env("NAS_NAME", "NAS") if m.group(1) == env("NAS_HOST") else m.group(1)
            return "NFS · " + nas
        if path.startswith("unknown"):
            return "OTHER"
        name, cmd, exe = os.path.basename(path), None, path
        try:
            proc = psutil.Process(int(pid))
            name, cmd = proc.name(), proc.cmdline()
        except Exception:
            pass
        return app_label(name, cmd, exe)

    async def _run(self, iface):
        while True:
            try:
                proc = await asyncio.create_subprocess_exec(
                    "nethogs", "-t", "-d", "3", iface,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                block = defaultdict(lambda: [0.0, 0.0])
                async for raw in proc.stdout:
                    line = raw.decode(errors="replace").rstrip("\n")
                    if line.startswith("Refreshing:"):
                        rows = sorted(block.items(), key=lambda kv: -(kv[1][0] + kv[1][1]))
                        # nethogs reports KB/s; the page wants bytes/s
                        self.latest = [{"name": k, "rx": rx * 1024, "tx": tx * 1024}
                                       for k, (tx, rx) in rows[:TOP_N] if rx + tx >= 0.5]
                        block = defaultdict(lambda: [0.0, 0.0])
                        continue
                    parts = line.split("\t")
                    if len(parts) == 3:
                        try:
                            sent, recv = float(parts[1]), float(parts[2])
                        except ValueError:
                            continue
                        b = block[self._label(parts[0])]
                        b[0] += sent
                        b[1] += recv
                await proc.wait()
            except Exception:
                pass
            await asyncio.sleep(10)   # nethogs stopped: try again shortly


class ServerStats(Collector):
    name = "server"
    interval = 2

    def __init__(self):
        self.nic = env("SERVER_NIC")
        # In Docker the host's disk is mounted read-only at /host
        self.disk_path = env("SERVER_DISK_PATH", "/host" if os.path.isdir("/host/etc") else "/")
        self.rates = RateTracker()
        self.nethogs = NetHogs()
        self.top = {}
        self.top_at = 0
        psutil.cpu_percent(None)  # first call primes the counter

    def _pick_nic(self, counters):
        if self.nic in counters:
            return self.nic
        candidates = [n for n in counters if n != "lo" and not n.startswith(("veth", "docker", "br-", "utun", "lo"))]
        return max(candidates or counters, key=lambda n: counters[n].bytes_recv)

    async def collect(self):
        vm = psutil.virtual_memory()
        du = psutil.disk_usage(self.disk_path)
        counters = psutil.net_io_counters(pernic=True)
        nic = self._pick_nic(counters)
        net = self.rates.update(counters[nic].bytes_recv, counters[nic].bytes_sent)
        net["iface"] = nic
        self.nethogs.start(nic)
        if time.time() - self.top_at > 4:
            self.top = process_top()
            self.top_at = time.time()
        return {
            "top": {**self.top, "net": self.nethogs.latest, "net_kind": "apps"},
            "label": env("SERVER_NAME", "SERVERMCSERVEFACE"),
            "cpu_percent": psutil.cpu_percent(None),
            "ram": {"used": vm.total - vm.available, "total": vm.total},
            "disk": {"used": du.used, "total": du.total},
            "uptime_seconds": int(time.time() - psutil.boot_time()),
            "temp_c": cpu_temperature(),
            "net": net,
        }


# ------------------------------------------------------------------
# Synology NAS over SNMP (read-only, no DSM password needed)
# ------------------------------------------------------------------

class NasSnmp(Collector):
    name = "nas"
    interval = 5

    OIDS = {
        "cpu_idle":   "1.3.6.1.4.1.2021.11.11.0",
        "mem_total":  "1.3.6.1.4.1.2021.4.5.0",   # kB
        "mem_avail":  "1.3.6.1.4.1.2021.4.6.0",
        "mem_buffer": "1.3.6.1.4.1.2021.4.14.0",
        "mem_cached": "1.3.6.1.4.1.2021.4.15.0",
        "uptime":     "1.3.6.1.2.1.25.1.1.0",     # hundredths of a second
        "temp":       "1.3.6.1.4.1.6574.1.2.0",   # Synology system temp, °C
        "sys_status": "1.3.6.1.4.1.6574.1.1.0",   # 1 = normal
        "vol_status": "1.3.6.1.4.1.6574.3.1.1.3.0",  # 1 = normal
        "vol_free":   "1.3.6.1.4.1.6574.3.1.1.4.0",  # bytes
        "vol_total":  "1.3.6.1.4.1.6574.3.1.1.5.0",
    }

    def __init__(self):
        self.host = env("NAS_HOST")
        self.community = env("NAS_SNMP_COMMUNITY")
        self.iface_name = env("NAS_IFACE", "bond0")
        self.if_index = None
        self.rates = RateTracker()
        self.top = {}
        self.top_at = 0
        self.cpu_prev = None   # (time, {pid: cpu centiseconds})
        self.ncpu = None

    def configured(self):
        return bool(self.host and self.community)

    async def _walk(self, oid):
        """{last OID number: value} for an SNMP table column."""
        out = await self._run("snmpbulkwalk", "-v2c", "-c", self.community, "-On", "-Oq", "-t", "5",
                              self.host, oid)
        rows = {}
        for line in out.splitlines():
            key, _, val = line.partition(" ")
            if key.startswith("."):
                rows[key.rsplit(".", 1)[-1]] = val.strip().strip('"')
        return rows

    async def _top(self):
        """Top processes from the NAS's process table, plus connections per service.
        Synology doesn't track bandwidth per app, so "network" here means who is connected."""
        if self.ncpu is None:
            self.ncpu = max(1, len(await self._walk("1.3.6.1.2.1.25.3.3.1.2")))
        names = await self._walk("1.3.6.1.2.1.25.4.2.1.2")
        paths = await self._walk("1.3.6.1.2.1.25.4.2.1.4")
        names = {pid: app_label(n, exe=paths.get(pid)) for pid, n in names.items()}
        cpu_t = {k: int(v.split()[0]) for k, v in (await self._walk("1.3.6.1.2.1.25.5.1.1.1")).items()}
        mem_kb = await self._walk("1.3.6.1.2.1.25.5.1.1.2")
        now = time.time()
        cpu, mem = defaultdict(float), defaultdict(int)
        if self.cpu_prev:
            dt = now - self.cpu_prev[0]
            for pid, t in cpu_t.items():
                before = self.cpu_prev[1].get(pid)
                if before is not None and t >= before and pid in names:
                    # centiseconds of CPU time -> % of the whole machine
                    cpu[app_label(names[pid])] += (t - before) / (dt * 100) / self.ncpu * 100
        self.cpu_prev = (now, cpu_t)
        for pid, v in mem_kb.items():
            if pid in names:
                mem[app_label(names[pid])] += int(v.split()[0]) * 1024
        svc_names = await self._walk("1.3.6.1.4.1.6574.6.1.1.2")
        svc_users = await self._walk("1.3.6.1.4.1.6574.6.1.1.3")
        services = sorted(({"name": svc_names[k], "value": int(v)} for k, v in svc_users.items()
                           if k in svc_names and v.isdigit() and int(v) > 0), key=lambda x: -x["value"])
        return {"cpu": top(cpu) if self.cpu_prev and cpu else self.top.get("cpu", []),
                "mem": top(mem), "net": services, "net_kind": "services"}

    async def _run(self, *args):
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), timeout=15)
        if proc.returncode != 0:
            raise RuntimeError(err.decode().strip() or "snmp failed")
        return out.decode()

    async def _find_interface(self):
        out = await self._run("snmpwalk", "-v2c", "-c", self.community, "-On", "-Oq", "-t", "3",
                              self.host, "1.3.6.1.2.1.31.1.1.1.1")
        for line in out.splitlines():
            oid, _, name = line.partition(" ")
            if name.strip().strip('"') == self.iface_name:
                return oid.rsplit(".", 1)[-1]
        raise RuntimeError("interface {} not found on NAS".format(self.iface_name))

    async def collect(self):
        if self.if_index is None:
            self.if_index = await self._find_interface()
        oids = dict(self.OIDS)
        oids["rx"] = "1.3.6.1.2.1.31.1.1.1.6." + self.if_index
        oids["tx"] = "1.3.6.1.2.1.31.1.1.1.10." + self.if_index

        # -Oqvt: print just the values, one per line, timeticks as plain numbers
        out = await self._run("snmpget", "-v2c", "-c", self.community, "-Oqvt", "-t", "3", "-r", "1",
                              self.host, *oids.values())
        # Some values come with units attached ("2020340 kB"), so keep just the number
        values = [v.strip().strip('"').split()[0] for v in out.splitlines()]
        n = {k: float(v) for k, v in zip(oids.keys(), values)}

        mem_total = n["mem_total"] * 1024
        mem_used = (n["mem_total"] - n["mem_avail"] - n["mem_buffer"] - n["mem_cached"]) * 1024
        net = self.rates.update(n["rx"], n["tx"])
        net["iface"] = self.iface_name
        if time.time() - self.top_at > 15:
            try:
                self.top = await self._top()
            except Exception:
                pass   # keep the last list; the main stats still matter more
            self.top_at = time.time()
        return {
            "top": self.top,
            "label": env("NAS_NAME", "SMARTNAS"),
            "cpu_percent": 100 - n["cpu_idle"],
            "ram": {"used": max(0, mem_used), "total": mem_total},
            "disk": {"used": n["vol_total"] - n["vol_free"], "total": n["vol_total"]},
            "uptime_seconds": int(n["uptime"] / 100),
            "temp_c": int(n["temp"]),
            "healthy": n["sys_status"] == 1 and n["vol_status"] == 1,
            "net": net,
        }


# ------------------------------------------------------------------
# Mac Mini (asks the little helper running on the Mac)
# ------------------------------------------------------------------

class MacStats(Collector):
    name = "mac"
    interval = 5

    def __init__(self, client):
        self.client = client
        self.url = env("MAC_STATS_URL")

    def configured(self):
        return bool(self.url)

    async def collect(self):
        r = await self.client.get(self.url)
        r.raise_for_status()
        data = r.json()
        data["label"] = env("MAC_NAME", "MAC MINI M4")
        return data


# ------------------------------------------------------------------
# Speedtest Tracker
# ------------------------------------------------------------------

class Speedtest(Collector):
    name = "speedtest"
    interval = 120

    def __init__(self, client):
        self.client = client
        self.url = env("SPEEDTEST_URL")
        self.token = env("SPEEDTEST_TOKEN")

    def configured(self):
        return bool(self.url and self.token)

    async def collect(self):
        r = await self.client.get(
            self.url.rstrip("/") + "/api/v1/results",
            params={"sort": "-created_at"},
            headers={"Authorization": "Bearer " + self.token, "Accept": "application/json"},
        )
        r.raise_for_status()
        results = []
        for item in r.json()["data"]:
            if item.get("status") != "completed" or not item.get("download_bits"):
                continue
            # created_at is UTC without a timezone marker
            ts = datetime.strptime(item["created_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            results.append({
                "timestamp": ts.isoformat(),
                "download_mbps": round(item["download_bits"] / 1e6, 1),
                "upload_mbps": round(item["upload_bits"] / 1e6, 1),
                "ping_ms": round(item["ping"], 1),
            })
        if not results:
            raise RuntimeError("no completed speedtests")
        return {"latest": results[0], "history": list(reversed(results))}


# ------------------------------------------------------------------
# Plex, via Tautulli
# ------------------------------------------------------------------

class Plex(Collector):
    name = "plex"
    interval = 15

    def __init__(self, client):
        self.client = client
        self.url = env("TAUTULLI_URL")
        self.key = env("TAUTULLI_API_KEY")

    def configured(self):
        return bool(self.url and self.key)

    async def _cmd(self, cmd, **params):
        r = await self.client.get(self.url.rstrip("/") + "/api/v2",
                                  params={"apikey": self.key, "cmd": cmd, **params})
        r.raise_for_status()
        body = r.json()["response"]
        if body.get("result") != "success":
            raise RuntimeError(body.get("message") or "tautulli error")
        return body["data"]

    async def collect(self):
        activity, history = await asyncio.gather(
            self._cmd("get_activity"),
            self._cmd("get_history", length=25),
        )
        streams = []
        for s in activity.get("sessions", []):
            decision = s.get("transcode_decision", "direct play")
            streams.append({
                "user": s.get("friendly_name") or s.get("user"),
                "title": s.get("grandparent_title") or s.get("title"),
                "subtitle": "S{:0>2}E{:0>2} · {}".format(s.get("parent_media_index"), s.get("media_index"), s.get("title"))
                            if s.get("media_type") == "episode" else s.get("year") or "",
                "player": s.get("player") or s.get("platform"),
                "state": s.get("state"),
                "decision": decision.upper().replace("COPY", "DIRECT STREAM"),
                "quality": s.get("stream_video_full_resolution") or s.get("quality_profile"),
                "progress": int(s.get("progress_percent") or 0),
                "position_ms": int(s.get("view_offset") or 0),
                "duration_ms": int(s.get("duration") or 0),
                "kind": s.get("media_type"),
            })
        plays = []
        for h in history.get("data", []):
            plays.append({
                "time": iso(h["date"]) if h.get("date") else None,
                "user": h.get("friendly_name"),
                "title": h.get("full_title"),
                "player": h.get("player") or h.get("platform"),
                "percent": h.get("percent_complete"),
                "show": h.get("grandparent_title") or h.get("title"),
                "kind": h.get("media_type"),
                # second line: "S05E19 · Ties of Blood and Water" for episodes, the year for movies
                "detail": "S{:0>2}E{:0>2} · {}".format(h.get("parent_media_index"), h.get("media_index"), h.get("title"))
                          if h.get("media_type") == "episode" else str(h.get("year") or "MOVIE"),
            })
        return {"streams": streams, "history": plays}


# ------------------------------------------------------------------
# MeshCore messages, via RemoteTerm
# ------------------------------------------------------------------

class MeshCore(Collector):
    name = "mesh"
    interval = 15

    def __init__(self, client):
        self.client = client
        self.url = env("REMOTETERM_URL")
        user, password = env("REMOTETERM_USER"), env("REMOTETERM_PASS")
        self.auth = (user, password) if user and password else None
        self.channels = {}
        self.channels_at = 0
        # Channels whose name contains any of these words are hidden (e.g. #test, #testing)
        self.hide_words = [w.strip().lower() for w in (env("MESH_HIDE_CHANNELS_WITH", "test")).split(",") if w.strip()]

    def configured(self):
        return bool(self.url)

    async def _get(self, path, **params):
        r = await self.client.get(self.url.rstrip("/") + path, params=params, auth=self.auth)
        r.raise_for_status()
        return r.json()

    async def collect(self):
        if time.time() - self.channels_at > 600:
            self.channels = {c["key"]: c["name"] for c in await self._get("/api/channels")}
            self.channels_at = time.time()

        messages = []
        # Ask for extra, since messages from hidden channels get dropped below
        for m in await self._get("/api/messages", limit=60):
            where = self.channels.get(m.get("conversation_key"), "#?") if m.get("type") == "CHAN" else "DIRECT"
            if where != "DIRECT" and any(word in where.lower() for word in self.hide_words):
                continue
            if len(messages) >= 12:
                break
            sender = "YOU" if m.get("outgoing") else (m.get("sender_name") or "UNKNOWN")
            text = m.get("text") or ""
            # Channel messages arrive as "Sender: text"; strip the repeated name
            if m.get("sender_name") and text.startswith(m["sender_name"] + ": "):
                text = text[len(m["sender_name"]) + 2:]
            paths = m.get("paths") or []
            best = max(paths, key=lambda p: p.get("rssi") or -999) if paths else {}
            messages.append({
                "time": iso(m.get("received_at") or m.get("sender_timestamp") or time.time()),
                "where": where,
                "sender": sender,
                "text": text,
                "rssi": best.get("rssi"),
                "snr": best.get("snr"),
                "hops": best.get("path_len"),
            })
        return {"messages": messages}


# ------------------------------------------------------------------
# Outdoor weather + air quality, from Open-Meteo (free, no key needed)
# ------------------------------------------------------------------

# WMO weather codes -> short LCARS-style text
WEATHER_CODES = {
    0: "CLEAR", 1: "MOSTLY CLEAR", 2: "PARTLY CLOUDY", 3: "OVERCAST",
    45: "FOG", 48: "FREEZING FOG",
    51: "LIGHT DRIZZLE", 53: "DRIZZLE", 55: "HEAVY DRIZZLE", 56: "FREEZING DRIZZLE", 57: "FREEZING DRIZZLE",
    61: "LIGHT RAIN", 63: "RAIN", 65: "HEAVY RAIN", 66: "FREEZING RAIN", 67: "FREEZING RAIN",
    71: "LIGHT SNOW", 73: "SNOW", 75: "HEAVY SNOW", 77: "SNOW GRAINS",
    80: "SHOWERS", 81: "SHOWERS", 82: "HEAVY SHOWERS", 85: "SNOW SHOWERS", 86: "HEAVY SNOW SHOWERS",
    95: "THUNDERSTORM", 96: "THUNDERSTORM · HAIL", 99: "THUNDERSTORM · HAIL",
}

# US EPA AQI bands
AQI_BANDS = [(50, "GOOD"), (100, "MODERATE"), (150, "UNHEALTHY FOR SENSITIVE"),
             (200, "UNHEALTHY"), (300, "VERY UNHEALTHY"), (9999, "HAZARDOUS")]


class Weather(Collector):
    name = "weather"
    interval = 600  # Open-Meteo updates roughly every 15 min; no need to ask more often

    def __init__(self, client):
        self.client = client
        self.lat = env("WEATHER_LAT")
        self.lon = env("WEATHER_LON")
        self.metric = env("WEATHER_UNITS", "us").lower() == "metric"

    def configured(self):
        return bool(self.lat and self.lon)

    async def _forecast(self):
        params = {
            "latitude": self.lat, "longitude": self.lon, "timezone": "auto", "forecast_days": 3,
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
            "daily": "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max",
        }
        if not self.metric:
            params.update(temperature_unit="fahrenheit", wind_speed_unit="mph")
        r = await self.client.get("https://api.open-meteo.com/v1/forecast", params=params)
        r.raise_for_status()
        return r.json()

    async def _air(self):
        r = await self.client.get("https://air-quality-api.open-meteo.com/v1/air-quality", params={
            "latitude": self.lat, "longitude": self.lon, "timezone": "auto",
            "current": "us_aqi,pm2_5,pm10,ozone",
        })
        r.raise_for_status()
        return r.json()["current"]

    async def collect(self):
        fc, air = await asyncio.gather(self._forecast(), self._air(), return_exceptions=True)
        if isinstance(fc, Exception):
            raise fc
        cur, daily = fc["current"], fc["daily"]
        days = []
        for i, date in enumerate(daily["time"]):
            days.append({
                "date": date,
                "high": round(daily["temperature_2m_max"][i]),
                "low": round(daily["temperature_2m_min"][i]),
                "sky": WEATHER_CODES.get(daily["weather_code"][i], "—"),
                "rain_pct": daily["precipitation_probability_max"][i],
            })
        aqi = None
        if not isinstance(air, Exception) and air.get("us_aqi") is not None:
            value = round(air["us_aqi"])
            aqi = {
                "value": value,
                "category": next(label for limit, label in AQI_BANDS if value <= limit),
                "pm2_5": air.get("pm2_5"),
                "pm10": air.get("pm10"),
                "ozone": air.get("ozone"),
            }
        return {
            "label": env("WEATHER_NAME", "OUTSIDE"),
            "unit": "C" if self.metric else "F",
            "wind_unit": "KM/H" if self.metric else "MPH",
            "temp": round(cur["temperature_2m"]),
            "feels_like": round(cur["apparent_temperature"]),
            "humidity": cur["relative_humidity_2m"],
            "wind": round(cur["wind_speed_10m"]),
            "sky": WEATHER_CODES.get(cur["weather_code"], "—"),
            "is_day": bool(cur.get("is_day")),
            "days": days,
            "aqi": aqi,
        }


# ------------------------------------------------------------------
# Indoor temperatures (ecobee), via Home Assistant's REST API
# ------------------------------------------------------------------

class Indoor(Collector):
    """
    One ecobee thermostat with room sensors (upstairs / downstairs).

    INDOOR_ROOMS lists the room sensors as NAME=entity_id pairs separated by commas, e.g.
      INDOOR_ROOMS=Upstairs=sensor.upstairs_temperature,Downstairs=sensor.downstairs_temperature
    INDOOR_THERMOSTAT is the climate.* entity (blank = the first one Home Assistant has).
    It supplies the mode, set point and whether heat/AC is running.
    """
    name = "indoor"
    interval = 30

    def __init__(self, client):
        self.client = client
        self.url = env("HA_URL")
        self.token = env("HA_TOKEN")
        self.thermostat = env("INDOOR_THERMOSTAT")
        self.rooms = []
        for pair in (env("INDOOR_ROOMS") or "").split(","):
            label, _, entity = pair.partition("=")
            if entity.strip():
                self.rooms.append((label.strip(), entity.strip()))

    def configured(self):
        return bool(self.url and self.token)

    @staticmethod
    def _number(value):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    async def collect(self):
        r = await self.client.get(self.url.rstrip("/") + "/api/states",
                                  headers={"Authorization": "Bearer " + self.token})
        r.raise_for_status()
        states = {s["entity_id"]: s for s in r.json()}

        climate_id = self.thermostat or next((e for e in sorted(states) if e.startswith("climate.")), None)
        thermostat = None
        if climate_id in states:
            s = states[climate_id]
            a = s["attributes"]
            thermostat = {
                "name": (a.get("friendly_name") or "THERMOSTAT").upper(),
                "temp": a.get("current_temperature"),      # ecobee's average of the sensors in use
                "humidity": a.get("current_humidity"),
                "mode": s["state"].upper().replace("_", "/"),   # HEAT, COOL, HEAT/COOL, OFF
                "action": (a.get("hvac_action") or "").upper(), # HEATING, COOLING, IDLE, FAN
                "target": a.get("temperature"),
                "target_low": a.get("target_temp_low"),
                "target_high": a.get("target_temp_high"),
            }

        rooms = []
        for label, entity in self.rooms:
            s = states.get(entity)
            if s is None:
                rooms.append({"name": label.upper() or entity, "missing": True})
                continue
            rooms.append({"name": (label or s["attributes"].get("friendly_name") or entity).upper(),
                          "temp": self._number(s["state"])})
        if not rooms and thermostat:  # rooms not picked yet: show the thermostat's own reading
            rooms.append({"name": thermostat["name"], "temp": thermostat["temp"],
                          "humidity": thermostat["humidity"]})
        if not rooms:
            raise RuntimeError("no thermostat or sensors found in Home Assistant")
        return {"rooms": rooms, "thermostat": thermostat}


# ------------------------------------------------------------------
# Solar repeater telemetry (MeshCore, via RemoteTerm)
# ------------------------------------------------------------------

class Repeater(Collector):
    """
    Asks one repeater for its status over the mesh about once an hour, and keeps
    every reading in a small SQLite file so the graph survives restarts.

    REPEATER_NAME      the repeater's name as RemoteTerm lists it (e.g. Hilltop)
    REPEATER_PASSWORD  its admin or guest password (blank = guest login)
    REPEATER_POLL_MIN  minutes between radio requests (default 60; please keep it >= 30)
    """
    name = "repeater"
    interval = 60          # the loop wakes every minute, but only uses the radio when a reading is due
    RETRY_AFTER = 30 * 60  # after a failed attempt (repeater out of reach), try again in 30 minutes
    KEEP_DAYS = 14
    FIELDS = ["battery_volts", "uptime_seconds", "packets_sent", "packets_received",
              "airtime_seconds", "noise_floor_dbm", "last_rssi_dbm", "last_snr_db",
              "flood_dups", "direct_dups", "recv_errors", "tx_queue_len"]

    def __init__(self, client):
        self.client = client
        self.url = env("REMOTETERM_URL")
        user, password = env("REMOTETERM_USER"), env("REMOTETERM_PASS")
        self.auth = (user, password) if user and password else None
        self.target = env("REPEATER_NAME")
        self.password = os.environ.get("REPEATER_PASSWORD", "")
        self.poll_seconds = max(30, int(env("REPEATER_POLL_MIN", "60"))) * 60
        self.db_path = env("REPEATER_DB", "/data/repeater.db" if os.path.isdir("/data") else "repeater.db")
        self.key = None
        self.last_attempt = 0
        self.last_error = None
        self._db = None

    def configured(self):
        return bool(self.url and self.target)

    # --- storage ---

    def db(self):
        if self._db is None:
            import sqlite3
            self._db = sqlite3.connect(self.db_path)
            cols = ", ".join("{} REAL".format(f) for f in self.FIELDS)
            self._db.execute("CREATE TABLE IF NOT EXISTS readings (ts REAL PRIMARY KEY, {})".format(cols))
        return self._db

    def save(self, ts, status):
        self.db().execute(
            "INSERT OR REPLACE INTO readings (ts, {}) VALUES (?{})".format(", ".join(self.FIELDS), ", ?" * len(self.FIELDS)),
            [ts] + [status.get(f) for f in self.FIELDS])
        self.db().execute("DELETE FROM readings WHERE ts < ?", [ts - self.KEEP_DAYS * 86400])
        self.db().commit()

    def history(self, days=5):
        rows = self.db().execute(
            "SELECT ts, {} FROM readings WHERE ts >= ? ORDER BY ts".format(", ".join(self.FIELDS)),
            [time.time() - days * 86400]).fetchall()
        return [dict(zip(["ts"] + self.FIELDS, r)) for r in rows]

    # --- radio ---

    async def _call(self, method, path, **kw):
        r = await self.client.request(method, self.url.rstrip("/") + path, auth=self.auth, timeout=40, **kw)
        r.raise_for_status()
        return r.json()

    async def _find_key(self):
        offset = 0
        while True:
            page = await self._call("GET", "/api/contacts", params={"limit": 1000, "offset": offset})
            for c in page:
                if (c.get("name") or "").strip().lower() == self.target.lower():
                    return c["public_key"]
            if len(page) < 1000:
                raise RuntimeError("repeater '{}' not found in RemoteTerm contacts".format(self.target))
            offset += 1000

    async def _poll_radio(self):
        if self.key is None:
            self.key = await self._find_key()
        base = "/api/contacts/{}/repeater".format(self.key)
        login = await self._call("POST", base + "/login", json={"password": self.password})
        if login.get("authenticated") is False:
            raise RuntimeError("login refused: {}".format(login.get("message") or "check REPEATER_PASSWORD"))
        return await self._call("POST", base + "/status")

    async def collect(self):
        history = self.history()
        last_ts = history[-1]["ts"] if history else 0
        now = time.time()
        due = now - last_ts >= self.poll_seconds
        may_retry = now - self.last_attempt >= self.RETRY_AFTER
        if due and may_retry:
            self.last_attempt = now
            try:
                status = await self._poll_radio()
                self.save(now, status)
                history = self.history()
                self.last_error = None
            except Exception as exc:
                self.last_error = str(exc) or exc.__class__.__name__
                if not history:
                    raise  # nothing to show yet: panel says NO CONTACT
        return {
            "label": self.target.upper(),
            "poll_minutes": self.poll_seconds // 60,
            "last_error": self.last_error,   # shown small if the latest attempt failed but older data exists
            "readings": history,
        }
