"""
Mac Mini stats helper for the LCARS dashboard.

Serves http://<mac>:8089/stats as JSON: CPU, memory, disk, uptime, network,
plus the top apps by CPU, memory and network (for the tap-through views).
Installed as a LaunchAgent by install.sh so it starts at login.
"""
import json
import os
import re
import subprocess
import threading
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psutil

PORT = 8089
DISK_PATH = "/System/Volumes/Data"  # where your files actually live on modern macOS

lock = threading.Lock()
latest = {}
top = {"cpu": [], "mem": [], "net": [], "net_kind": "apps"}
TOP_N = 5
cpu_temp = None
# macmon (brew install macmon) reads Apple Silicon temperature sensors without sudo.
# LaunchAgents don't get Homebrew's PATH, so look in the usual places.
MACMON = next((p for p in ("/opt/homebrew/bin/macmon", "/usr/local/bin/macmon") if os.path.exists(p)), None)


def temp_forever():
    """Keep one macmon running; it prints a JSON line every 5 s with the CPU temperature."""
    global cpu_temp
    while MACMON:
        try:
            proc = subprocess.Popen([MACMON, "pipe", "-i", "5000"], stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True)
            for line in proc.stdout:
                try:
                    t = json.loads(line).get("temp", {}).get("cpu_temp_avg")
                    cpu_temp = round(t) if t else None
                except ValueError:
                    continue
            proc.wait()
        except Exception:
            pass
        cpu_temp = None
        time.sleep(30)   # macmon stopped: try again later


def app_label(name):
    """Group helpers under their app: "Google Chrome Helper (Renderer)" -> "Google Chrome"."""
    return re.sub(r" Helper.*$|: .*$", "", (name or "?").strip())


def ranked(totals):
    return [{"name": k, "value": v} for k, v in sorted(totals.items(), key=lambda kv: -kv[1])[:TOP_N] if v > 0]


def names_by_pid():
    out = {}
    for p in psutil.process_iter(["name"]):
        out[p.pid] = app_label(p.info["name"])
    return out


def top_procs_forever():
    """Every 4 s: CPU (% of the whole Mac) and memory per app."""
    ncpu = psutil.cpu_count() or 1
    while True:
        cpu, mem = defaultdict(float), defaultdict(int)
        for p in psutil.process_iter(["name", "memory_info"]):
            try:
                label = app_label(p.info["name"])
                cpu[label] += p.cpu_percent(None) / ncpu   # psutil remembers each process between rounds
                if p.info["memory_info"]:
                    mem[label] += p.info["memory_info"].rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        with lock:
            top["cpu"], top["mem"] = ranked(cpu), ranked(mem)
        time.sleep(4)


def top_net_forever():
    """Per-app network using macOS's built-in nettop: two 3-second samples, keep the second (the change)."""
    while True:
        try:
            out = subprocess.run(["nettop", "-P", "-L", "2", "-d", "-s", "3", "-x", "-J", "bytes_in,bytes_out"],
                                 capture_output=True, text=True, timeout=20).stdout
            block = out.split(",bytes_in,bytes_out,")[-1]
            pids = names_by_pid()
            rows = defaultdict(lambda: [0, 0])
            for line in block.strip().splitlines():
                parts = line.split(",")
                if len(parts) < 3 or not parts[1].isdigit():
                    continue
                name, _, pid = parts[0].rpartition(".")
                label = pids.get(int(pid), app_label(name)) if pid.isdigit() else app_label(parts[0])
                rows[label][0] += int(parts[1]) / 3
                rows[label][1] += int(parts[2]) / 3
            best = sorted(rows.items(), key=lambda kv: -(kv[1][0] + kv[1][1]))[:TOP_N]
            with lock:
                top["net"] = [{"name": k, "rx": round(rx), "tx": round(tx)} for k, (rx, tx) in best if rx + tx >= 500]
        except Exception:
            pass
        time.sleep(3)


def sample_forever():
    """Every 2 s: measure everything and store it, so requests are instant."""
    prev = None
    rx_hist, tx_hist = [], []
    psutil.cpu_percent(None)
    while True:
        time.sleep(2)
        counters = psutil.net_io_counters(pernic=True)
        iface = "en0" if "en0" in counters else max(counters, key=lambda n: counters[n].bytes_recv)
        c, now = counters[iface], time.monotonic()
        rx = tx = 0
        if prev:
            dt = now - prev[0]
            rx, tx = max(0, (c.bytes_recv - prev[1]) / dt), max(0, (c.bytes_sent - prev[2]) / dt)
            rx_hist, tx_hist = (rx_hist + [round(rx)])[-90:], (tx_hist + [round(tx)])[-90:]
        prev = (now, c.bytes_recv, c.bytes_sent)

        vm = psutil.virtual_memory()
        du = psutil.disk_usage(DISK_PATH)
        data = {
            "cpu_percent": psutil.cpu_percent(None),
            # macOS "available" counts reclaimable cache, so this matches Activity Monitor closely
            "ram": {"used": vm.total - vm.available, "total": vm.total},
            "disk": {"used": du.total - du.free, "total": du.total},
            "uptime_seconds": int(time.time() - psutil.boot_time()),
            "temp_c": cpu_temp,
            "net": {"iface": iface, "rx_bps": round(rx), "tx_bps": round(tx),
                    "rx_hist": rx_hist, "tx_hist": tx_hist},
        }
        with lock:
            data["top"] = dict(top)
            latest.clear()
            latest.update(data)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/stats":
            self.send_error(404)
            return
        with lock:
            body = json.dumps(latest).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # keep quiet


if __name__ == "__main__":
    threading.Thread(target=sample_forever, daemon=True).start()
    threading.Thread(target=top_procs_forever, daemon=True).start()
    threading.Thread(target=top_net_forever, daemon=True).start()
    threading.Thread(target=temp_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
