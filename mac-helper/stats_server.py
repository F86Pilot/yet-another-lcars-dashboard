"""
Mac Mini stats helper for the LCARS dashboard.

Serves http://<mac>:8089/stats as JSON: CPU, memory, disk, uptime, network.
Installed as a LaunchAgent by install.sh so it starts at login.
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psutil

PORT = 8089
DISK_PATH = "/System/Volumes/Data"  # where your files actually live on modern macOS

lock = threading.Lock()
latest = {}


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
            "temp_c": None,
            "net": {"iface": iface, "rx_bps": round(rx), "tx_bps": round(tx),
                    "rx_hist": rx_hist, "tx_hist": tx_hist},
        }
        with lock:
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
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
