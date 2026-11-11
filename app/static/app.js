// =============================================================
// LCARS dashboard front end
// Asks the backend for /api/status every few seconds and fills
// in the panels. No libraries, just plain JavaScript.
// =============================================================

const POLL_MS = 3000;
const $ = (id) => document.getElementById(id);
const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(`--${name}`).trim();

// Escape text from outside sources (mesh messages, Plex titles) before inserting it as HTML.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// ---------- clock ----------

function tickClock() {
  const now = new Date();
  $("date").textContent = now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" }).toUpperCase();
  $("time").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
}

// ---------- formatting helpers ----------

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}D ${String(h).padStart(2, "0")}H` : `${h}H ${String(m).padStart(2, "0")}M`;
}

function fmtBytes(b, digits = 1) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return `${b.toFixed(i < 2 ? 0 : digits)} ${units[i]}`;
}

// "used / total" with both in the total's unit, e.g. "4.2 / 15.3 TB"
// base 1000 for disks (how drives are sold)
function fmtUsed(used, total, base = 1000) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, t = total;
  while (t >= base && i < units.length - 1) { t /= base; i++; }
  const u = used / base ** i;
  const digits = t >= 100 ? 0 : 1;
  return `${u.toFixed(digits)} / ${t.toFixed(digits)} ${units[i]}`;
}

// RAM: like fmtUsed, but the total is rounded up to the whole GB the machine shipped with.
// (The OS reports a bit less, e.g. 15.5 of 16, because firmware/graphics reserve some.)
function fmtRam(used, total) {
  const gb = 1024 ** 3;
  return `${(used / gb).toFixed(1)} / ${Math.ceil(total / gb - 0.05)} GB`;
}

// Network speed in megabits per second (same unit as the speedtest): bytes/s × 8 ÷ 1,000,000
function fmtRate(bytesPerSec) {
  const mbps = (bytesPerSec * 8) / 1e6;
  const digits = mbps < 1 ? 2 : mbps < 10 ? 1 : 0;
  return `${mbps.toFixed(digits)} MBPS`;
}

function fmtTime(iso) {
  // 12-hour time without AM/PM, e.g. 8:34
  const d = new Date(iso);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtAgo(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "JUST NOW";
  if (min < 60) return `${min} MIN AGO`;
  if (min < 48 * 60) return `${Math.round(min / 60)} HR AGO`;
  return `${Math.round(min / 1440)} DAYS AGO`;
}

// Draw one or more lines into an <svg viewBox="0 0 300 60">. Gaps (null) break the line.
function sparkline(svg, series, { min, max } = {}) {
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { svg.innerHTML = ""; return; }
  const lo = min ?? Math.min(...all);
  const hi = max ?? Math.max(...all);
  const span = hi - lo || 1;
  svg.innerHTML = series.map((s) => {
    const n = s.values.length;
    const runs = [[]];
    s.values.forEach((v, i) => {
      if (v == null) { runs.push([]); return; }
      const x = n > 1 ? (i / (n - 1)) * 300 : 0;
      const y = 57 - ((v - lo) / span) * 54;
      runs[runs.length - 1].push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    return runs.filter((r) => r.length).map((r) => `<polyline points="${r.join(" ")}" style="stroke:${s.color}"/>`).join("");
  }).join("");
}

function setMeter(el, pct, { hot = 75, crit = 90 } = {}) {
  el.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  el.classList.toggle("hot", pct >= hot && pct < crit);
  el.classList.toggle("crit", pct >= crit);
}

// Mark a panel as working / down / not set up, and return its data (or null).
function panelState(panel, entry) {
  const tag = panel.querySelector(".ptag");
  panel.classList.toggle("unconfigured", !entry.configured);
  panel.classList.toggle("down", entry.configured && !entry.ok);
  if (!entry.configured) tag.textContent = "NOT CONFIGURED";
  else if (!entry.ok) tag.textContent = "NO CONTACT";
  tag.title = entry.error || "";
  return entry.data;
}

// ---------- system panels (server, NAS, Mac) ----------

function setupSystemPanels() {
  const tpl = $("sys-template");
  document.querySelectorAll(".sys").forEach((panel) => {
    panel.appendChild(tpl.content.cloneNode(true));
    const c = panel.dataset.color;
    panel.querySelector(".pill").classList.add(`c-${c}`);
    panel.querySelector(".rule").classList.add(`c-${c}`);
  });
}

function renderSystem(panel, entry) {
  const q = (sel) => panel.querySelector(sel);
  const s = panelState(panel, entry);
  if (!s) return;
  q(".sys-name").textContent = s.label;

  setMeter(q(".f-cpu"), s.cpu_percent);
  q(".v-cpu").textContent = `${Math.round(s.cpu_percent)}%`;
  setMeter(q(".f-ram"), (s.ram.used / s.ram.total) * 100, { hot: 85, crit: 95 });
  q(".v-ram").textContent = fmtRam(s.ram.used, s.ram.total);
  setMeter(q(".f-disk"), (s.disk.used / s.disk.total) * 100, { hot: 80, crit: 92 });
  q(".v-disk").textContent = fmtUsed(s.disk.used, s.disk.total);

  q(".v-rx").textContent = `↓ ${fmtRate(s.net.rx_bps)}`;
  q(".v-tx").textContent = `↑ ${fmtRate(s.net.tx_bps)}`;
  sparkline(q(".spark-net"), [
    { values: s.net.rx_hist, color: color("orange") },
    { values: s.net.tx_hist, color: color("blue") },
  ], { min: 0 });

  q(".v-uptime").textContent = fmtUptime(s.uptime_seconds);
  const extra = [s.net.iface?.toUpperCase()];
  if (s.temp_c != null) extra.unshift(`${s.temp_c}°C`);
  if (s.healthy === false) extra.unshift("⚠ DEGRADED");
  q(".v-extra").textContent = extra.filter(Boolean).join(" · ");
}

// ---------- LCARS title cards (stand-ins for Plex posters) ----------
// Every show/movie gets a card drawn from its title: same title -> same colors, every time.

const CARD_COLORS = ["orange", "peach", "tan", "lavender", "purple", "blue"];
const STOP_WORDS = new Set(["THE", "A", "AN", "OF", "AND", "IN", "ON", "TO", "FOR", "AT"]);
const NUMBER_WORDS = { ONE: "1", TWO: "2", THREE: "3", FOUR: "4", FIVE: "5", SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9", TEN: "10" };

function hashStr(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const ROMAN = { II: "2", III: "3", IV: "4", V: "5", VI: "6", VII: "7", VIII: "8", IX: "9", X: "10" };
const toNumber = (w) => NUMBER_WORDS[w] || ROMAN[w] || w;

// Fan-style abbreviations:
//   "Star Trek: Deep Space Nine" -> DS9      "Star Wars: Episode VI - Return of the Jedi" -> ROTJ
//   "Back to the Future Part III" -> BTTF3   "Harry Potter and the Deathly Hallows: Part 2" -> HPDH2
//   "Top Gun: Maverick" -> MAVERICK          "Bluey (2018)" -> BLUEY
function abbreviate(title) {
  const clean = title.replace(/\(\d{4}\)/g, "").replace(/['’]/g, "").trim();
  const [main, ...rest] = clean.split(":");
  const sub = rest.join(":").trim().replace(/^episode\s+[ivx]+\s*-\s*/i, "");
  const part = sub.match(/^part\s+(\w+)$/i);
  // Taglines like "Rogue One: A Star Wars Story" describe the franchise, not the film
  const tagline = /^(an?|the)\s.*\b(story|movie|film|adventure|tale)$/i.test(sub);
  // Otherwise the subtitle usually names the specific film/series ("Star Trek: The Wrath of Khan")
  const source = sub && !part && !tagline ? sub : main;
  const suffix = part ? toNumber(part[1].toUpperCase()) : "";

  const words = source.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((w) => w && w !== "PART");
  const significant = words.filter((w) => !STOP_WORDS.has(w));
  // One real word ("Ratatouille", "The Martian") -> show the word itself
  const oneWord = significant.length <= 1 && (words.length === 1 || ["THE", "A", "AN"].includes(words[0]));
  if (oneWord && !suffix) return (significant[0] || words[0] || "?").slice(0, 12);

  // Number words only become digits at the end ("Deep Space Nine" -> DS9, but "The Two Towers" -> TTT)
  const initials = (list) => list.map((w, i) =>
    (i === list.length - 1 && NUMBER_WORDS[w]) || (i > 0 && ROMAN[w]) || (/^\d+$/.test(w) ? w : w[0])).join("");
  let abbr = initials(words) + suffix;                          // ROTJ, TNG, TWOK
  if (abbr.length > 5) abbr = initials(significant) + suffix;   // long titles: skip "and/the/of"
  return abbr.slice(0, 5);
}

function wrapWords(text, maxChars, maxLines) {
  const lines = [];
  let line = "";
  for (const word of text.toUpperCase().split(/\s+/)) {
    if ((line + " " + word).trim().length > maxChars && line) { lines.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += "…"; }
  return lines;
}

function lcarsCard(title, kind) {
  title = title || "UNKNOWN";
  const h = hashStr(title);
  // Three different palette colors, chosen by the title's hash
  const i1 = h % 6;
  const i2 = (i1 + 1 + ((h >>> 4) % 5)) % 6;
  let i3 = (i1 + 1 + ((h >>> 8) % 5)) % 6;
  if (i3 === i2) i3 = (i3 + 1) % 6 === i1 ? (i3 + 2) % 6 : (i3 + 1) % 6;
  const [c1, c2, c3] = [i1, i2, i3].map((i) => color(CARD_COLORS[i]));
  const code = `${(h % 90) + 10}-${String((h >>> 7) % 10000).padStart(4, "0")}`;
  const abbr = abbreviate(title);
  const size = Math.min(44, 76 / (abbr.length * 0.46));  // shrink long words to fit the card
  const lines = wrapWords(title, 13, 3)
    .map((l, i) => `<text x="114" y="${116 + i * 13}" text-anchor="end" font-size="11" fill="${color("peach")}">${esc(l)}</text>`).join("");
  const label = kind === "episode" || kind === "show" ? "TV" : kind === "track" ? "AUD" : "FILM";
  return `<svg class="lcard" viewBox="0 0 120 180" role="img" aria-label="${esc(title)}">
    <rect width="120" height="180" fill="#000"/>
    <path d="M0,34 Q0,0 34,0 L113,0 A7,7 0 0 1 113,14 L46,14 Q34,14 34,26 L34,128 L0,128 Z" fill="${c1}"/>
    <rect x="0" y="132" width="34" height="18" fill="${c2}"/>
    <rect x="0" y="154" width="34" height="26" fill="${c3}"/>
    <text x="30" y="176" text-anchor="end" font-size="10" font-weight="600" fill="#000">${label}</text>
    <text x="114" y="32" text-anchor="end" font-size="10" fill="${color("lavender")}">${code}</text>
    <text x="114" y="${62 + size * 0.75}" text-anchor="end" font-size="${size.toFixed(1)}" font-weight="700" fill="${c1}">${esc(abbr)}</text>
    ${lines}
    <path d="M46,168 L113,168 A6,6 0 0 1 113,180 L46,180 Z" fill="${c2}"/>
  </svg>`;
}

// ---------- plex ----------

function renderPlex(entry) {
  const data = panelState($("p-plex"), entry);
  if (!data) {
    if (!entry.configured) $("plex-streams").innerHTML = `<div class="empty">FINISH TAUTULLI SETUP TO ENABLE</div>`;
    return;
  }

  $("plex-streams").innerHTML = data.streams.length
    ? data.streams.map((s) => `
      <div class="stream">
        ${lcarsCard(s.title, s.kind)}
        <div>
          <div class="stream-title">${esc(s.title)}</div>
          <div class="stream-sub">${esc(s.subtitle)}</div>
          <div class="stream-meta">${esc(s.user)} · ${esc(s.player)}${s.state === "paused" ? " · PAUSED" : ""}</div>
          <div class="stream-meta">
            <span class="tag ${s.decision === "TRANSCODE" ? "transcode" : ""}">${esc(s.decision)}</span>
            ${s.quality ? `<span class="tag">${esc(String(s.quality).toUpperCase())}</span>` : ""}</div>
          <div class="meter"><div class="fill" style="width:${s.progress}%"></div></div>
        </div>
      </div>`).join("")
    : `<div class="empty">NO ACTIVE STREAMS</div>`;

  // Scrollable list; only rewrite it when something changed so a scroll in progress isn't disturbed
  const html = data.history.map((h) => `
    <li>${lcarsCard(h.show, h.kind)}
      <div class="h-body">
        <div class="h-title">${esc(h.title)}</div>
        <div class="h-meta">${h.time ? fmtAgo(h.time) : ""} · ${esc(h.user)}</div>
      </div></li>`).join("")
    || `<li class="empty">NO HISTORY YET</li>`;
  const list = $("plex-history");
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
}

// After 60 seconds without a touch, scroll Recently Watched back to the top
let historyTouched = 0;
["scroll", "touchstart", "wheel", "pointerdown"].forEach((ev) =>
  $("plex-history").addEventListener(ev, () => { historyTouched = Date.now(); }, { passive: true }));
setInterval(() => {
  const list = $("plex-history");
  if (list.scrollTop > 0 && Date.now() - historyTouched > 60000) list.scrollTo({ top: 0, behavior: "smooth" });
}, 5000);

// ---------- meshcore ----------

function renderMesh(entry) {
  const data = panelState($("p-mesh"), entry);
  if (!data) return;
  $("mesh-log").innerHTML = data.messages.slice(0, 12).map((m) => `
    <li>
      <div class="m-top">
        <time>${fmtTime(m.time)}</time>
        <span class="m-where ${m.where === "DIRECT" ? "dm" : ""}">${esc(m.where.toUpperCase())}</span>
        <span class="m-sender">${esc(m.sender)}</span>
        ${m.snr != null ? `<span class="m-sig">SNR ${m.snr} · ${m.hops ?? "?"} HOPS</span>` : ""}
      </div>
      <div class="m-text">${esc(m.text)}</div>
    </li>`).join("") || `<li class="empty">NO MESSAGES</li>`;
}

// ---------- outside: weather + air quality ----------

const deg = (v, unit = "") => (v == null ? "—" : `${Math.round(v)}<sup>°${unit}</sup>`);

function aqiClass(v) {
  if (v <= 50) return "good";
  if (v <= 100) return "moderate";
  if (v <= 150) return "sensitive";
  return "bad";
}

function renderWeather(entry) {
  const panel = $("p-weather");
  const w = panelState(panel, entry);
  if (!w) {
    if (!entry.configured) $("wx-sky").textContent = "ADD WEATHER_LAT / WEATHER_LON TO .ENV";
    return;
  }
  $("wx-name").textContent = `OUTSIDE · ${w.label.toUpperCase()}`;
  $("wx-temp").innerHTML = deg(w.temp, w.unit);
  $("wx-sky").textContent = w.sky;
  $("wx-feels").textContent = `${w.feels_like}°`;
  $("wx-wind").textContent = `${w.wind} ${w.wind_unit}`;

  const box = $("wx-aqi");
  box.className = "aqi" + (w.aqi ? ` ${aqiClass(w.aqi.value)}` : "");
  box.querySelector(".aqi-value").textContent = w.aqi ? w.aqi.value : "—";
  box.querySelector(".aqi-cat").textContent = w.aqi
    ? `${w.aqi.category}${w.aqi.pm2_5 != null ? ` · PM2.5 ${Math.round(w.aqi.pm2_5)}` : ""}` : "NO DATA";

  // Today only: high / low and chance of rain
  const d = w.days && w.days[0];
  $("wx-today").innerHTML = d
    ? `TODAY <b>${d.high}°</b> / <b class="lo">${d.low}°</b>${d.rain_pct ? ` · <b>${d.rain_pct}%</b> RAIN` : ""}`
    : "";
}

// ---------- inside: ecobee via Home Assistant ----------

function renderIndoor(entry) {
  const data = panelState($("p-indoor"), entry);
  if (!data) {
    if (!entry.configured) $("indoor-rooms").innerHTML = `<div class="empty">FINISH HOME ASSISTANT SETUP TO ENABLE</div>`;
    return;
  }
  $("indoor-rooms").innerHTML = data.rooms.map((r) => r.missing
    ? `<div class="room"><div class="label">${esc(r.name)}</div><div class="empty">SENSOR NOT FOUND</div></div>`
    : `<div class="room"><div class="label">${esc(r.name)}</div>
        <div class="big-temp">${deg(r.temp)}</div>
      </div>`).join("");

  // One status line for the thermostat itself: what it's doing and what it's set to
  const t = data.thermostat;
  if (!t) { $("indoor-hvac").innerHTML = ""; return; }
  const set = t.target != null ? `${Math.round(t.target)}°`
    : t.target_low != null ? `${Math.round(t.target_low)}–${Math.round(t.target_high)}°` : "—";
  const action = t.mode === "OFF" ? "OFF" : (t.action || t.mode);
  $("indoor-hvac").innerHTML = `
    <span class="tag ${esc(action.toLowerCase())}">${esc(action)}</span>
    <span>MODE <b>${esc(t.mode)}</b></span>
    <span>SET <b>${set}</b></span>`;
}

// ---------- solar repeater ----------
// Shares the MeshCore spot: tap to switch, and it also flips by itself every 20 seconds.

const RP_DAYS = 4;
let rpShowing = false, rpConfigured = false;
function swapMeshRepeater(show) {
  rpShowing = rpConfigured && (show ?? !rpShowing);
  $("p-mesh").classList.toggle("swap-hidden", rpShowing);
  $("p-repeater").classList.toggle("swap-hidden", !rpShowing);
  if (!rpShowing) fitList($("mesh-log"));
}

function renderRepeater(entry) {
  const panel = $("p-repeater");
  rpConfigured = entry.configured;
  const d = panelState(panel, entry);
  if (!d) return;
  $("rp-name").textContent = `SOLAR REPEATER · ${d.label}`;
  const rows = d.readings.filter((r) => r.battery_volts);
  if (!rows.length) return;
  const last = rows[rows.length - 1];
  $("rp-now").textContent = `${last.battery_volts.toFixed(2)} V`;
  $("rp-up").textContent = last.uptime_seconds != null ? fmtUptime(last.uptime_seconds) : "—";

  // Time window: the last RP_DAYS days, ending now
  const end = Date.now() / 1000, start = end - RP_DAYS * 86400;
  const x = (ts) => ((ts - start) / (end - start)) * 300;
  const shown = rows.filter((r) => r.ts >= start);
  const volts = shown.map((r) => r.battery_volts);
  const baseline = volts.reduce((a, b) => a + b, 0) / volts.length;
  const lo = Math.floor((Math.min(...volts) - 0.02) * 50) / 50;
  const hi = Math.ceil((Math.max(...volts) + 0.02) * 50) / 50;
  const y = (v) => 96 - ((v - lo) / (hi - lo)) * 92;

  // Midnight lines + weekday labels
  const days = [];
  const mid = new Date(start * 1000); mid.setHours(24, 0, 0, 0);
  for (let t = mid.getTime() / 1000; t < end; t += 86400) days.push(t);
  const dayLines = days.map((t) => `<line class="day" x1="${x(t)}" y1="0" x2="${x(t)}" y2="100"/>`).join("");
  $("rp-days").innerHTML = days.map((t) => {
    const noon = t + 43200;
    if (noon > end) return "";
    return `<span style="left:${(x(noon) / 3).toFixed(1)}%">${new Date(noon * 1000).toLocaleDateString([], { weekday: "short" }).toUpperCase().slice(0, 2)}</span>`;
  }).join("");

  // Voltage line (a gap of more than 3 polls breaks it), baseline, and a dot for "now"
  const runs = [[]];
  shown.forEach((r, i) => {
    if (i && r.ts - shown[i - 1].ts > d.poll_minutes * 60 * 3) runs.push([]);
    runs[runs.length - 1].push(`${x(r.ts).toFixed(1)},${y(r.battery_volts).toFixed(1)}`);
  });
  $("rp-volts").innerHTML = dayLines
    + `<line class="base" x1="0" y1="${y(baseline)}" x2="300" y2="${y(baseline)}"/>`
    + runs.filter((r) => r.length).map((r) => `<polyline points="${r.join(" ")}"/>`).join("")
    + `<circle cx="${x(last.ts)}" cy="${y(last.battery_volts)}" r="2.5"/>`;
  $("rp-hi").textContent = hi.toFixed(2);
  $("rp-lo").textContent = lo.toFixed(2);
  const base = $("rp-base");
  base.textContent = baseline.toFixed(2);
  base.style.top = `${y(baseline)}%`;

  // Peak since local midnight
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todays = rows.filter((r) => r.ts * 1000 >= today.getTime()).map((r) => r.battery_volts);
  $("rp-peak").textContent = todays.length ? `${Math.max(...todays).toFixed(2)} V` : "—";

  // Packets relayed per hour, from the change in the "sent" counter between readings.
  // A reboot resets the counter, so a drop is skipped rather than drawn as a negative.
  const bars = [];
  for (let i = 1; i < shown.length; i++) {
    const a = shown[i - 1], b = shown[i];
    const hours = (b.ts - a.ts) / 3600;
    const sent = b.packets_sent - a.packets_sent;
    if (hours > 0 && sent >= 0 && hours <= 6) bars.push({ x0: x(a.ts), x1: x(b.ts), rate: sent / hours });
  }
  const peakRate = Math.max(1, ...bars.map((b) => b.rate));
  $("rp-packets").innerHTML = bars.map((b) => {
    const h = (b.rate / peakRate) * 28;
    return `<rect x="${(b.x0 + 0.3).toFixed(1)}" y="${(30 - h).toFixed(1)}" width="${Math.max(0.6, b.x1 - b.x0 - 0.6).toFixed(1)}" height="${h.toFixed(1)}"/>`;
  }).join("");
  $("rp-rate").textContent = bars.length ? `NOW ${Math.round(bars[bars.length - 1].rate)} · PEAK ${Math.round(peakRate)}` : "";

  // Radio health line
  const radio = [];
  if (last.noise_floor_dbm != null) radio.push(`NOISE ${last.noise_floor_dbm} DBM`);
  if (last.airtime_seconds != null && last.uptime_seconds) radio.push(`AIRTIME ${(100 * last.airtime_seconds / last.uptime_seconds).toFixed(1)}%`);
  if (last.last_snr_db != null) radio.push(`SNR ${last.last_snr_db}`);
  $("rp-radio").textContent = radio.join(" · ");
  $("rp-when").textContent = d.last_error ? "⚠ LAST TRY FAILED" : fmtAgo(new Date(last.ts * 1000).toISOString());
  $("rp-when").title = d.last_error || "";
}

// ---------- one-screen mode ----------
// Remove list items from the end until the list fits its panel, so nothing is cut off halfway.
// Only matters when the CSS one-screen mode clips the list (on phones everything just scrolls).
function fitList(list) {
  const bottom = list.getBoundingClientRect().bottom;
  let items = [...list.children];
  while (items.length > 1 && items[items.length - 1].getBoundingClientRect().bottom > bottom + 1) {
    items.pop().remove();
  }
}

// ---------- polling loop ----------

async function poll() {
  try {
    const res = await fetch("api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.querySelectorAll(".sys").forEach((p) => renderSystem(p, data[p.dataset.key]));
    renderPlex(data.plex);
    renderMesh(data.mesh);
    renderWeather(data.weather);
    renderIndoor(data.indoor);
    renderRepeater(data.repeater);
    fitList($("mesh-log"));

    const systems = ["server", "nas", "mac"];
    const up = systems.filter((k) => data[k].ok).length;
    $("sys-count").textContent = `${up}/${systems.length} ONLINE`;
    $("link-status").textContent = "LINK ESTABLISHED";
    document.body.classList.remove("stale");
  } catch (err) {
    console.warn("status fetch failed:", err);
    $("link-status").textContent = "LINK LOST";
    document.body.classList.add("stale");
  }
}

setupSystemPanels();
$("p-mesh").addEventListener("click", () => swapMeshRepeater());
$("p-repeater").addEventListener("click", () => swapMeshRepeater());
setInterval(() => swapMeshRepeater(), 20000);
tickClock();
setInterval(tickClock, 1000);
poll();
setInterval(poll, POLL_MS);
