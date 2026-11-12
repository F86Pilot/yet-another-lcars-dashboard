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


def data_path(filename):
    """Where saved history lives: the /data volume in Docker, else next to the code."""
    return os.path.join("/data" if os.path.isdir("/data") else ".", filename)


class Cached:
    """Remembers an async result for a while, so a detail view left open doesn't hammer anything."""

    def __init__(self, seconds):
        self.seconds, self.at, self.value, self.key = seconds, 0, None, None

    async def get(self, fn, key=None):
        if self.value is None or key != self.key or time.time() - self.at > self.seconds:
            self.value, self.key, self.at = await fn(), key, time.time()
        return self.value


class HistoryStore:
    """
    One-minute averages of the system panels' numbers, kept 8 days in SQLite
    (data/history.db), for the bigger graphs on their full-screen views.
    """
    KEEP_DAYS = 8

    def __init__(self, path=None):
        self.path = path or env("HISTORY_DB") or data_path("history.db")
        self._db = None
        self.pending = {}   # source -> (minute, {field: [values]})

    def db(self):
        if self._db is None:
            import sqlite3
            self._db = sqlite3.connect(self.path)
            self._db.execute("CREATE TABLE IF NOT EXISTS samples (source TEXT, ts INTEGER, data TEXT, PRIMARY KEY (source, ts))")
        return self._db

    def add(self, source, values):
        """Collect a reading; once a minute is complete its average is saved."""
        import json
        minute = int(time.time() // 60) * 60
        current = self.pending.get(source)
        if current and current[0] != minute:
            avg = {k: round(sum(v) / len(v), 2) for k, v in current[1].items() if v}
            self.db().execute("INSERT OR REPLACE INTO samples VALUES (?, ?, ?)", (source, current[0], json.dumps(avg)))
            if current[0] % 3600 == 0:
                self.db().execute("DELETE FROM samples WHERE ts < ?", (minute - self.KEEP_DAYS * 86400,))
            self.db().commit()
            current = None
        if current is None:
            current = self.pending[source] = (minute, defaultdict(list))
        for k, v in values.items():
            if v is not None:
                current[1][k].append(float(v))

    def series(self, source, hours, points=300):
        """{"t": [...], field: [...]}: averages over buckets, about `points` of them for the span."""
        import json
        since = time.time() - hours * 3600
        bucket = max(60, int(hours * 3600 / points) // 60 * 60)
        groups = {}
        for ts, data in self.db().execute("SELECT ts, data FROM samples WHERE source = ? AND ts >= ? ORDER BY ts",
                                          (source, since)):
            g = groups.setdefault(ts // bucket * bucket, defaultdict(list))
            for k, v in json.loads(data).items():
                g[k].append(v)
        out = {"t": sorted(groups), "bucket": bucket}
        fields = sorted({k for g in groups.values() for k in g})
        for f in fields:
            out[f] = [round(sum(groups[t][f]) / len(groups[t][f]), 2) if groups[t].get(f) else None for t in out["t"]]
        return out


HISTORY = HistoryStore()


class SystemHistory:
    """Mixed into the server / NAS / Mac collectors: what to save each reading, and the detail view's data."""

    @staticmethod
    def sample(d):
        return {"cpu": d["cpu_percent"], "mem": 100 * d["ram"]["used"] / d["ram"]["total"] if d["ram"]["total"] else None,
                "disk": d["disk"]["used"], "rx": d["net"]["rx_bps"], "tx": d["net"]["tx_bps"], "temp": d.get("temp_c")}

    async def detail(self, hours=24):
        hours = min(max(float(hours), 1), 24 * 7)
        week = HISTORY.series(self.name, 24 * 7, points=7 * 24)  # hourly, for the disk fill rate
        return {"hours": hours, "series": HISTORY.series(self.name, hours),
                "disk_week": {"t": week["t"], "disk": week.get("disk", [])}}


async def ha_history(client, url, token, entity_ids, hours):
    """Home Assistant's recorded states for some entities: {entity_id: [state, ...]}.
    end_time matters: without it HA only returns the first day after the start."""
    now = datetime.now(timezone.utc)
    start = datetime.fromtimestamp(now.timestamp() - hours * 3600, timezone.utc)
    r = await client.get(url.rstrip("/") + "/api/history/period/" + start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                         params={"filter_entity_id": ",".join(entity_ids), "significant_changes_only": "0",
                                 "end_time": now.strftime("%Y-%m-%dT%H:%M:%SZ")},
                         headers={"Authorization": "Bearer " + token}, timeout=30)
    r.raise_for_status()
    return {rows[0]["entity_id"]: rows for rows in r.json() if rows}


def ha_ts(state):
    return round(datetime.fromisoformat(state["last_updated"].replace("Z", "+00:00")).timestamp())


def ha_number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


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
# The server (the machine this backend runs on)
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


class ServerStats(SystemHistory, Collector):
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
            "label": env("SERVER_NAME", "SERVER"),
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

class NasSnmp(SystemHistory, Collector):
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
            "label": env("NAS_NAME", "NAS"),
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

class MacStats(SystemHistory, Collector):
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
        data["label"] = env("MAC_NAME", "MAC")
        return data


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
        return {"streams": streams, "history": plays,
                "bandwidth_kbps": int(activity.get("total_bandwidth") or 0)}

    @staticmethod
    def _play(h):
        return {
            "time": iso(h["date"]) if h.get("date") else None,
            "user": h.get("friendly_name"),
            "player": h.get("player") or h.get("platform"),
            "percent": h.get("percent_complete"),
            "show": h.get("grandparent_title") or h.get("title"),
            "kind": h.get("media_type"),
            "minutes": round((h.get("play_duration") or h.get("duration") or 0) / 60),
            "detail": "S{:0>2}E{:0>2} · {}".format(h.get("parent_media_index"), h.get("media_index"), h.get("title"))
                      if h.get("media_type") == "episode" else str(h.get("year") or "MOVIE"),
        }

    async def _detail(self):
        by_date, stats, libraries, history = await asyncio.gather(
            self._cmd("get_plays_by_date", time_range=30),
            self._cmd("get_home_stats", time_range=7, stats_count=6),
            self._cmd("get_libraries"),
            self._cmd("get_history", length=60))
        series = {s["name"]: s["data"] for s in by_date.get("series", [])}
        rows = lambda stat_id: next((s["rows"] for s in stats if s["stat_id"] == stat_id), [])
        return {
            "days": by_date.get("categories", []),
            "tv": series.get("TV", []), "movies": series.get("Movies", []),
            "top_tv": [{"title": r.get("title"), "plays": r.get("total_plays"), "minutes": round((r.get("total_duration") or 0) / 60)}
                       for r in rows("top_tv")],
            "top_movies": [{"title": r.get("title"), "plays": r.get("total_plays"), "minutes": round((r.get("total_duration") or 0) / 60)}
                           for r in rows("top_movies")],
            "top_users": [{"name": r.get("friendly_name"), "plays": r.get("total_plays"), "minutes": round((r.get("total_duration") or 0) / 60)}
                          for r in rows("top_users")],
            "libraries": [{"name": l.get("section_name"), "type": l.get("section_type"), "count": int(l.get("count") or 0),
                           "seasons": int(l.get("parent_count") or 0), "episodes": int(l.get("child_count") or 0)}
                          for l in libraries],
            "history": [self._play(h) for h in history.get("data", [])],
        }

    async def detail(self, hours=None):
        if not hasattr(self, "cache"):
            self.cache = Cached(120)
        return await self.cache.get(self._detail)


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
            msg = self._message(m)
            if msg is None:
                continue
            if len(messages) >= 12:
                break
            messages.append(msg)
        return {"messages": messages}

    def _message(self, m):
        """One message as the page shows it, or None if it's in a hidden channel."""
        where = self.channels.get(m.get("conversation_key"), "#?") if m.get("type") == "CHAN" else "DIRECT"
        if where != "DIRECT" and any(word in where.lower() for word in self.hide_words):
            return None
        sender = "YOU" if m.get("outgoing") else (m.get("sender_name") or "UNKNOWN")
        text = m.get("text") or ""
        # Channel messages arrive as "Sender: text"; strip the repeated name
        if m.get("sender_name") and text.startswith(m["sender_name"] + ": "):
            text = text[len(m["sender_name"]) + 2:]
        paths = m.get("paths") or []
        best = max(paths, key=lambda p: p.get("rssi") or -999) if paths else {}
        return {
            "time": iso(m.get("received_at") or m.get("sender_timestamp") or time.time()),
            "ts": m.get("received_at") or m.get("sender_timestamp"),
            "where": where,
            "sender": sender,
            "text": text,
            "rssi": best.get("rssi"),
            "snr": best.get("snr"),
            "hops": best.get("path_len"),
        }

    async def _detail(self):
        contacts, health = await asyncio.gather(self._get("/api/contacts", limit=1000), self._get("/api/health"))
        since = time.time() - 86400
        # RemoteTerm hands out at most 1000 messages at a time; page back until a full day is covered
        raw = []
        for page in range(5):
            batch = await self._get("/api/messages", limit=1000, offset=page * 1000)
            raw += batch
            if len(batch) < 1000 or (batch[-1].get("received_at") or 0) < since:
                break
        msgs = [x for x in (self._message(m) for m in raw) if x and (x["ts"] or 0) >= since]
        kinds = {1: "CHAT", 2: "REPEATER", 3: "ROOM", 4: "SENSOR"}
        heard = sorted((c for c in contacts if (c.get("last_seen") or 0) >= time.time() - 7 * 86400),
                       key=lambda c: -(c.get("last_seen") or 0))
        stats = health.get("radio_stats") or {}
        return {
            "messages": msgs,   # the last 24 hours, newest first
            "contacts": [{"name": c.get("name"), "kind": kinds.get(c.get("type"), "?"), "last_seen": c.get("last_seen")}
                         for c in heard[:40]],
            "contact_count": len(contacts),
            "radio": {"connected": health.get("radio_connected"), "model": (health.get("radio_device_info") or {}).get("model"),
                      "noise_floor": stats.get("noise_floor"), "last_rssi": stats.get("last_rssi"), "last_snr": stats.get("last_snr"),
                      "packets_recv": stats.get("packets_recv"), "packets_sent": stats.get("packets_sent"),
                      "uptime": stats.get("uptime_secs"), "battery_mv": stats.get("battery_mv")},
        }

    async def detail(self, hours=None):
        if not hasattr(self, "cache"):
            self.cache = Cached(60)
        return await self.cache.get(self._detail)


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


    async def _detail(self):
        params = {
            "latitude": self.lat, "longitude": self.lon, "timezone": "auto", "past_days": 1, "forecast_days": 7,
            "hourly": "temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m",
            "daily": "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum,"
                     "sunrise,sunset,uv_index_max,wind_speed_10m_max",
            "current": "relative_humidity_2m,wind_gusts_10m,uv_index,pressure_msl",
            "timeformat": "unixtime",
        }
        if not self.metric:
            params.update(temperature_unit="fahrenheit", wind_speed_unit="mph", precipitation_unit="inch")
        fc, air = await asyncio.gather(
            self.client.get("https://api.open-meteo.com/v1/forecast", params=params),
            self.client.get("https://air-quality-api.open-meteo.com/v1/air-quality", params={
                "latitude": self.lat, "longitude": self.lon, "timezone": "auto", "past_days": 1, "forecast_days": 2,
                "hourly": "us_aqi,pm2_5", "timeformat": "unixtime"}),
            return_exceptions=True)
        if isinstance(fc, Exception):
            raise fc
        fc.raise_for_status()
        fc = fc.json()
        h, d = fc["hourly"], fc["daily"]
        out = {
            "hourly": {"t": h["time"], "temp": h["temperature_2m"], "feels": h["apparent_temperature"],
                       "rain_pct": h["precipitation_probability"], "rain": h["precipitation"],
                       "wind": h["wind_speed_10m"], "gusts": h["wind_gusts_10m"]},
            "days": [{"t": d["time"][i], "high": round(d["temperature_2m_max"][i]), "low": round(d["temperature_2m_min"][i]),
                      "sky": WEATHER_CODES.get(d["weather_code"][i], "—"), "rain_pct": d["precipitation_probability_max"][i],
                      "rain": d["precipitation_sum"][i], "sunrise": d["sunrise"][i], "sunset": d["sunset"][i],
                      "uv": d["uv_index_max"][i], "wind": d["wind_speed_10m_max"][i]} for i in range(len(d["time"]))],
            "current": fc.get("current", {}),
            "rain_unit": "MM" if self.metric else "IN",
            "air": None,
        }
        if not isinstance(air, Exception) and air.status_code == 200:
            a = air.json()["hourly"]
            out["air"] = {"t": a["time"], "aqi": a["us_aqi"], "pm2_5": a["pm2_5"]}
        return out

    async def detail(self, hours=None):
        if not hasattr(self, "cache"):
            self.cache = Cached(900)
        return await self.cache.get(self._detail)


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
        self.climate_id = climate_id
        return {"rooms": rooms, "thermostat": thermostat}

    async def _detail(self):
        climate_id = getattr(self, "climate_id", None) or self.thermostat
        ids = [e for _, e in self.rooms] + ([climate_id] if climate_id else [])
        hist = await ha_history(self.client, self.url, self.token, ids, 24 * 7)
        rooms = []
        for label, entity in self.rooms:
            pts = []
            for st in hist.get(entity, []):
                p = [ha_ts(st), ha_number(st["state"])]
                if not pts or pts[-1][1] != p[1]:
                    pts.append(p)
            rooms.append({"name": label.upper(), "points": pts})
        thermo = []
        for st in hist.get(climate_id, []):
            a = st.get("attributes") or {}
            p = [ha_ts(st), a.get("current_temperature"), a.get("current_humidity"), (a.get("hvac_action") or "").lower(),
                 a.get("temperature"), a.get("target_temp_low"), a.get("target_temp_high")]
            if not thermo or thermo[-1][1:] != p[1:]:
                thermo.append(p)
        return {"rooms": rooms, "thermostat": thermo}

    async def detail(self, hours=None):
        if not hasattr(self, "cache"):
            self.cache = Cached(300)
        return await self.cache.get(self._detail)


# ------------------------------------------------------------------
# Hot tub (Bestway / Lay-Z-Spa / SaluSpa), via Home Assistant
# ------------------------------------------------------------------

class HotTub(Collector):
    """
    A hot tub that Home Assistant already knows about (e.g. through the ha-bestway add-on).

    HOTTUB_THERMOSTAT is its climate.* entity, e.g. climate.back_patio_hot_tub_spa_thermostat.
    The add-on names the other entities after it (…_power, …_filter, …_errors), so those are
    found automatically. The 24-hour graph comes from Home Assistant's own history.
    """
    name = "hottub"
    interval = 30
    HISTORY_HOURS = 24
    HISTORY_EVERY = 300   # seconds between history refreshes

    def __init__(self, client):
        self.client = client
        self.url = (env("HA_URL") or "").rstrip("/")
        self.token = env("HA_TOKEN")
        self.climate = env("HOTTUB_THERMOSTAT")
        self.label = env("HOTTUB_NAME", "HOT TUB")
        base = (self.climate or "").split(".", 1)[-1]
        if base.endswith("_thermostat"):
            base = base[: -len("_thermostat")]
        self.related = {
            "power": "switch.%s_power" % base,
            "filter": "switch.%s_filter" % base,
            "errors": "binary_sensor.%s_errors" % base,
            "connected": "binary_sensor.%s_connected" % base,
            "bubbles": "select.%s_bubbles" % base,
        }
        self.history = []
        self.history_at = 0

    def configured(self):
        return bool(self.url and self.token and self.climate)

    async def _get(self, path, **params):
        r = await self.client.get(self.url + path, params=params or None,
                                  headers={"Authorization": "Bearer " + self.token})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    @staticmethod
    def _on(state):
        if state is None or state["state"] in ("unknown", "unavailable"):
            return None
        return state["state"] == "on"

    @staticmethod
    def _point(e):
        a = e.get("attributes") or {}
        # [time, water temp, target, heater running]; temp is None while the tub is offline
        return [ha_ts(e), a.get("current_temperature"), a.get("temperature"), a.get("hvac_action") == "heating"]

    async def _refresh_history(self):
        hist = await ha_history(self.client, self.url, self.token, [self.climate], self.HISTORY_HOURS)
        self.history = [self._point(e) for e in hist.get(self.climate, [])]
        self.history_at = time.time()

    # --- full-screen detail view: a week of history, fetched only while someone is looking ---

    async def _detail(self):
        ids = [self.climate, self.related["power"], self.related["filter"]]
        hist = await ha_history(self.client, self.url, self.token, ids, 24 * 7)
        points = []   # repeats dropped: a week of raw rows is thousands
        for e in hist.get(self.climate, []):
            p = self._point(e)
            if not points or points[-1][1:] != p[1:]:
                points.append(p)
        switch = lambda eid: [[ha_ts(e), self._on(e)] for e in hist.get(eid, [])]
        return {"days": 7, "history": points, "power": switch(ids[1]), "filter": switch(ids[2])}

    async def detail(self, hours=None):
        if not hasattr(self, "cache"):
            self.cache = Cached(300)
        return await self.cache.get(self._detail)

    async def collect(self):
        climate = await self._get("/api/states/" + self.climate)
        if climate is None:
            raise RuntimeError("%s not found in Home Assistant" % self.climate)
        related = {k: await self._get("/api/states/" + eid) for k, eid in self.related.items()}
        if time.time() - self.history_at > self.HISTORY_EVERY:
            await self._refresh_history()

        a = climate["attributes"]
        errors = related["errors"]
        bubbles = related["bubbles"]
        return {
            "label": self.label,
            "temp": a.get("current_temperature"),
            "target": a.get("temperature"),
            "unit": a.get("temperature_unit") or "°F",
            "mode": climate["state"],                 # heat / off / unknown
            "action": a.get("hvac_action"),           # heating / idle / off
            "power": self._on(related["power"]),
            "filter": self._on(related["filter"]),
            "connected": self._on(related["connected"]),
            "bubbles": bubbles["state"] if bubbles and bubbles["state"] not in ("unknown", "unavailable") else None,
            "error": self._on(errors),
            "errors": (errors or {}).get("attributes", {}).get("errors") or [],
            "history": self.history,
            "history_hours": self.HISTORY_HOURS,
        }


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

    async def detail(self, hours=None):
        return {"readings": self.history(days=self.KEEP_DAYS), "poll_minutes": self.poll_seconds // 60}
