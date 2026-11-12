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

// Segmented LCARS meter: N blocks that light up; turns orange/red when high
const SEGS = 20;
function setSegs(el, pct, { hot = 75, crit = 90 } = {}) {
  if (el.children.length !== SEGS) el.innerHTML = "<i></i>".repeat(SEGS);
  const lit = Math.round((Math.min(100, Math.max(0, pct)) / 100) * SEGS);
  const cls = pct >= crit ? "crit" : pct >= hot ? "hot" : "on";
  [...el.children].forEach((seg, i) => { seg.className = i < Math.max(lit, pct > 0 ? 1 : 0) ? cls : ""; });
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

// Tapping a system panel steps through what's using it: CPU → MEMORY → NETWORK → back.
const SYS_VIEWS = ["overview", "cpu", "mem", "net"];
const VIEW_NAMES = { cpu: "CPU", mem: "MEMORY", net: "NETWORK" };
const lastSys = {};   // latest data per panel, so a tap redraws right away

function setupSystemPanels() {
  const tpl = $("sys-template");
  document.querySelectorAll(".sys").forEach((panel) => {
    panel.appendChild(tpl.content.cloneNode(true));
    panel.dataset.view = "overview";
    onTap(panel, () => {
      lastTouch = Date.now();
      const next = SYS_VIEWS[(SYS_VIEWS.indexOf(panel.dataset.view) + 1) % SYS_VIEWS.length];
      chirp();
      setSysView(panel, next);
    });
  });
}

function setSysView(panel, view) {
  panel.dataset.view = view;
  panel.querySelector(".sys-overview").hidden = view !== "overview";
  panel.querySelector(".tops").hidden = view === "overview";
  const s = lastSys[panel.id];
  if (s) renderSysView(panel, s);
}

const fmtMbps = (bps) => fmtRate(bps);
function renderSysView(panel, s) {
  const view = panel.dataset.view;
  panel.querySelector(".sys-name").textContent = view === "overview" ? s.label : `${s.label} · ${VIEW_NAMES[view]}`;
  if (view === "overview") return;
  // Names are shown in capitals, so merge ones that differ only by case ("Claude" + "claude")
  const merge = (list) => list && Object.values(list.reduce((acc, x) => {
    const k = x.name.toUpperCase(), a = acc[k] || (acc[k] = { name: x.name, value: 0, rx: 0, tx: 0 });
    a.value += x.value || 0; a.rx += x.rx || 0; a.tx += x.tx || 0;
    return acc;
  }, {})).sort((a, b) => (b.value + b.rx + b.tx) - (a.value + a.rx + a.tx));
  const raw = s.top || {};
  const t = { ...raw, cpu: merge(raw.cpu), mem: merge(raw.mem), net: merge(raw.net) };
  let rows = [], empty = "NOTHING BUSY RIGHT NOW";
  if (view === "cpu") {
    const scale = Math.max(10, ...(t.cpu || []).map((x) => x.value));
    rows = (t.cpu || []).map((x) => ({ name: x.name, pct: (x.value / scale) * 100, val: `${x.value < 10 ? x.value.toFixed(1) : Math.round(x.value)}%` }));
  } else if (view === "mem") {
    const scale = Math.max(s.ram.total * 0.1, ...(t.mem || []).map((x) => x.value));
    rows = (t.mem || []).map((x) => ({ name: x.name, pct: (x.value / scale) * 100, val: fmtBytes(x.value) }));
  } else if (t.net_kind === "services") {
    // The NAS can't split bandwidth by app, so show who's connected to which service
    const scale = Math.max(1, ...(t.net || []).map((x) => x.value));
    rows = (t.net || []).map((x) => ({ name: x.name, pct: (x.value / scale) * 100, val: `${x.value} CONN` }));
    empty = "NO ACTIVE CONNECTIONS";
  } else if (t.net == null) {
    empty = "NETWORK DETAIL UNAVAILABLE";
  } else {
    const scale = Math.max(125000, ...t.net.map((x) => x.rx + x.tx));   // at least 1 Mbps full scale
    rows = t.net.map((x) => ({
      name: x.name, pct: ((x.rx + x.tx) / scale) * 100,
      val: x.rx >= x.tx ? `↓ ${fmtMbps(x.rx)}` : `↑ ${fmtMbps(x.tx)}`,
    }));
  }
  const list = panel.querySelector(".tops");
  list.innerHTML = rows.length
    ? rows.map((x) => `<li><span class="t-name">${esc(x.name.toUpperCase())}</span><div class="segs"></div><span class="mval">${esc(x.val)}</span></li>`).join("")
    : `<li class="empty">${empty}</li>`;
  list.querySelectorAll(".segs").forEach((el, i) => setSegs(el, Math.max(rows[i].pct, 1), { hot: 101, crit: 101 }));
}

function renderSystem(panel, entry) {
  const q = (sel) => panel.querySelector(sel);
  const s = panelState(panel, entry);
  if (!s) return;
  lastSys[panel.id] = s;
  renderSysView(panel, s);

  setSegs(q(".s-cpu"), s.cpu_percent);
  q(".v-cpu").textContent = `${Math.round(s.cpu_percent)}%`;
  setSegs(q(".s-ram"), (s.ram.used / s.ram.total) * 100, { hot: 85, crit: 95 });
  q(".v-ram").textContent = fmtRam(s.ram.used, s.ram.total);
  setSegs(q(".s-disk"), (s.disk.used / s.disk.total) * 100, { hot: 80, crit: 92 });
  q(".v-disk").textContent = fmtUsed(s.disk.used, s.disk.total);

  q(".v-rx").textContent = fmtRate(s.net.rx_bps);
  q(".v-tx").textContent = fmtRate(s.net.tx_bps);
  sparkline(q(".spark-net"), [
    { values: s.net.rx_hist, color: color("orange") },
    { values: s.net.tx_hist, color: color("blue") },
  ], { min: 0 });

  // Header end cap: uptime and temperature, e.g. "47D · 59°"
  const cap = [fmtUptime(s.uptime_seconds).split(" ")[0]];
  if (s.temp_c != null) cap.push(`${Math.round(s.temp_c)}°`);
  if (s.healthy === false) cap.unshift("⚠ DEGRADED");
  q(".ph-cap").textContent = cap.join(" · ");
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

function lcarsCard(title) {
  title = title || "UNKNOWN";
  const c = color(CARD_COLORS[hashStr(title) % CARD_COLORS.length]);  // same show, same color
  let abbr = abbreviate(title);
  if (abbr.length > 4) abbr = abbr[0];  // one long word (BLUEY) -> just its initial
  return `<div class="ltile${abbr.length > 3 ? " long" : ""}" style="background:${c}" title="${esc(title)}">${esc(abbr)}</div>`;
}

// ---------- plex ----------

const fmtMin = (ms) => Math.round(ms / 60000);
function renderPlex(entry) {
  const data = panelState($("p-plex"), entry);
  if (!data) {
    if (!entry.configured) $("plex-streams").innerHTML = `<div class="empty">FINISH TAUTULLI SETUP TO ENABLE</div>`;
    return;
  }

  $("plex-streams").innerHTML = data.streams.length
    ? data.streams.map((s) => `
      <div class="stream">
        ${lcarsCard(s.title)}
        <div class="stream-body">
          <div class="stream-title">${esc(s.title)}</div>
          <div class="stream-sub">${esc(s.subtitle)}</div>
          <div class="chips">
            <span class="chip c-blue first ${s.decision === "TRANSCODE" ? "transcode" : ""}">${esc(s.decision)}</span>
            ${s.quality ? `<span class="chip c-peach">${esc(String(s.quality).toUpperCase())}</span>` : ""}
            <span class="chip c-purple last">${esc(String(s.player || "").toUpperCase())}</span>
          </div>
          <div class="who">${esc(String(s.user || "").toUpperCase())}${s.state === "paused" ? " · PAUSED" : ""}</div>
          <div class="meter-row prog">
            <div class="segs"></div>
            <span class="mval">${s.duration_ms ? `${fmtMin(s.position_ms)} / ${fmtMin(s.duration_ms)} MIN` : `${s.progress}%`}</span>
          </div>
        </div>
      </div>`).join("")
    : `<div class="empty">NO ACTIVE STREAMS</div>`;
  $("plex-streams").querySelectorAll(".prog .segs").forEach((el, i) => setSegs(el, data.streams[i].progress, { hot: 101, crit: 101 }));

  // Scrollable list; only rewrite it when something changed so a scroll in progress isn't disturbed
  // Tautulli logs a new row each time a stop/resume happens; show each episode once
  const plays = data.history.filter((h, i, all) => !all.slice(0, i).some((o) =>
    o.show === h.show && o.detail === h.detail && o.user === h.user));
  const html = plays.map((h) => `
    <li>${lcarsCard(h.show)}
      <div class="h-body">
        <div class="h-title">${esc(h.show)}</div>
        <div class="h-meta">${esc(h.detail || "")}</div>
      </div>
      <span class="ago">${h.time ? fmtAgo(h.time) : ""} · ${esc(String(h.user || "").toUpperCase())}</span></li>`).join("")
    || `<li class="empty">NO HISTORY YET</li>`;
  const list = $("plex-history");
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
}

// Scrolling lists (Recently Watched, MeshCore): swipe to scroll. After 60 seconds
// without a touch they glide back to the top.
let lastTouch = 0;
const IDLE_MS = 60000;
["plex-history", "mesh-log"].forEach((id) =>
  ["scroll", "touchstart", "wheel", "pointerdown"].forEach((ev) =>
    $(id).addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true })));
setInterval(() => {
  if (Date.now() - lastTouch < IDLE_MS) return;
  document.querySelectorAll(".sys").forEach((p) => { if (p.dataset.view !== "overview") setSysView(p, "overview"); });
  ["plex-history", "mesh-log"].forEach((id) => {
    if ($(id).scrollTop > 0) $(id).scrollTo({ top: 0, behavior: "smooth" });
  });
}, 5000);

// A tap (not a swipe) on MeshCore / the repeater switches between them
// ---------- tap sounds ----------
// One of three key-press sounds (static/sounds), picked at random on
// every tap. Browsers only allow sound after a tap, which is exactly when these play.
const SOUND_FILES = ["sounds/keyok1.wav", "sounds/keyok2.wav", "sounds/keyok3.wav"];
let audio = null, sounds = null, lastSound = -1;
function loadSounds() {
  audio = new (window.AudioContext || window.webkitAudioContext)();
  sounds = SOUND_FILES.map((url) =>
    fetch(url).then((r) => r.arrayBuffer()).then((b) => audio.decodeAudioData(b)).catch(() => null));
}
// start loading on the very first touch anywhere, so the first sound isn't late
document.addEventListener("pointerdown", () => { if (!audio) loadSounds(); }, { once: true });
async function chirp() {
  try {
    if (!audio) loadSounds();
    if (audio.state === "suspended") audio.resume();
    // random, but never the same sound twice in a row
    let i = Math.floor(Math.random() * SOUND_FILES.length);
    if (i === lastSound) i = (i + 1) % SOUND_FILES.length;
    lastSound = i;
    const buf = await sounds[i];
    if (!buf) return;
    const src = audio.createBufferSource();
    src.buffer = buf;
    src.connect(audio.destination);
    src.start();
  } catch (e) { /* no audio available: stay silent */ }
}

function onTap(el, fn) {
  let x = 0, y = 0;
  el.addEventListener("pointerdown", (e) => { x = e.clientX; y = e.clientY; });
  el.addEventListener("click", (e) => {
    if (Math.abs(e.clientX - x) > 10 || Math.abs(e.clientY - y) > 10) return;  // that was a swipe
    fn();
  });
}

// ---------- meshcore ----------

function renderMesh(entry) {
  const data = panelState($("p-mesh"), entry);
  if (!data) return;
  const html = data.messages.map((m) => `
    <li>
      <div class="m-top">
        <time>${fmtTime(m.time)}</time>
        <span class="m-where ${m.where === "DIRECT" ? "dm" : m.where.startsWith("#") ? "" : "pub"}">${esc(m.where.toUpperCase())}</span>
        <span class="m-sender">${esc(m.sender)}</span>
        ${m.snr != null ? `<span class="m-sig">SNR ${m.snr} · ${m.hops ?? "?"} HOPS</span>` : ""}
      </div>
      <div class="m-text">${esc(m.text)}</div>
    </li>`).join("") || `<li class="empty">NO MESSAGES</li>`;
  const list = $("mesh-log");
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
}

// ---------- outside: weather + air quality ----------

const deg = (v) => (v == null ? "—" : `${Math.round(v)}<span class="dg">°</span>`);

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
  $("wx-temp").innerHTML = deg(w.temp);
  $("wx-sky").textContent = w.sky;
  $("wx-feels").textContent = `${w.feels_like}°`;
  $("wx-wind").textContent = `${w.wind} ${w.wind_unit}`;

  const box = $("wx-aqi");
  box.className = "bignum aqi" + (w.aqi ? ` ${aqiClass(w.aqi.value)}` : "");
  box.textContent = w.aqi ? w.aqi.value : "—";
  $("wx-air").innerHTML = w.aqi
    ? `AIR <b>${esc(w.aqi.category)}</b>${w.aqi.pm2_5 != null ? ` · PM2.5 <b>${Math.round(w.aqi.pm2_5)}</b>` : ""}` : "AIR QUALITY: NO DATA";

  // Today only: high / low and chance of rain
  const d = w.days && w.days[0];
  $("wx-today").innerHTML = d
    ? `TODAY <b>${d.high}°</b> / <b class="lo">${d.low}°</b>${d.rain_pct ? ` · <b>${d.rain_pct}%</b> RAIN` : ""}`
    : "";
}

// ---------- inside: ecobee via Home Assistant ----------

const ROOM_COLORS = ["c-peach", "c-blue", "c-tan", "c-lavender"];
function renderIndoor(entry) {
  const data = panelState($("p-indoor"), entry);
  if (!data) {
    if (!entry.configured) $("indoor-rooms").innerHTML = `<div class="empty">FINISH HOME ASSISTANT SETUP TO ENABLE</div>`;
    return;
  }
  $("indoor-rooms").innerHTML = data.rooms.map((r, i) => `
    <div class="cell"><div class="label">${esc(r.name.toUpperCase())}</div>
      <div class="bignum ${r.missing ? "c-dim" : ROOM_COLORS[i % ROOM_COLORS.length]}">${r.missing ? "—" : deg(r.temp)}</div></div>`).join("");

  // Thermostat: what it's doing, what it's set to
  const t = data.thermostat;
  if (!t) { $("indoor-hvac").innerHTML = ""; return; }
  const set = t.target != null ? `${Math.round(t.target)}°`
    : t.target_low != null ? `${Math.round(t.target_low)}–${Math.round(t.target_high)}°` : "—";
  const action = t.mode === "OFF" ? "OFF" : (t.action || t.mode);
  $("indoor-hvac").innerHTML = `
    <div class="headline ${esc(action.toLowerCase())}">${esc(action)}</div>
    <div class="line">SET TO <b>${set}</b></div>
    <div class="line">MODE <b>${esc(t.mode)}</b></div>`;
}

// ---------- hot tub (via Home Assistant) ----------
// Shares the Outside spot: tap to switch, and it also flips by itself every 20 seconds.

function renderHotTub(entry) {
  const panel = $("p-hottub");
  htConfigured = entry.configured;
  const d = panelState(panel, entry);
  if (!d) return;
  $("ht-name").textContent = d.label.toUpperCase();
  $("ht-temp").innerHTML = deg(d.temp);
  $("ht-target").innerHTML = deg(d.target);

  // Header lights: lit = on, dim = off
  const heating = d.action === "heating";
  const light = (id, on, text, color) => {
    const el = $(id);
    el.textContent = text;
    el.className = "ind" + (on ? ` on ${color}` : "");
  };
  light("ht-power", d.power, "POWER", "c-blue");
  light("ht-heat", heating || d.mode === "heat", heating ? "HEATING" : "HEATER", heating ? "c-orange" : "c-tan");
  light("ht-filter", d.filter, "FILTER", "c-lavender");
  const cap = $("ht-cap");
  const problem = d.connected === false ? "OFFLINE"
    : d.errors.length ? d.errors.join(" ").toUpperCase() : d.error ? "ERROR" : "";
  cap.textContent = problem || "OK";
  cap.classList.toggle("alert", !!problem);

  // 24 h chart: heater-on bands behind the water temperature, target as a dashed line.
  // Each reading holds until the next one, so both lines are drawn as steps.
  const end = Date.now() / 1000, start = end - d.history_hours * 3600;
  const pts = d.history.slice();
  if (d.temp != null) pts.push([end, d.temp, d.target, heating]);   // reach "now" between history refreshes
  const segs = [];
  pts.forEach((p, i) => {
    const t1 = i + 1 < pts.length ? pts[i + 1][0] : end;
    const t0 = Math.max(p[0], start);
    if (t1 > t0) segs.push({ t0, t1, temp: p[1], target: p[2], heat: p[3] });
  });
  const svg = $("ht-svg");
  const vals = segs.flatMap((s) => [s.temp, s.target]).filter((v) => v != null);
  if (!vals.length) {
    svg.innerHTML = `<text class="ht-empty" x="150" y="55" text-anchor="middle">COLLECTING HISTORY</text>`;
    $("ht-hi").textContent = $("ht-lo").textContent = "";
    return;
  }
  let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  if (hi - lo < 6) { lo = Math.floor((hi + lo) / 2 - 3); hi = lo + 6; }
  const x = (t) => ((t - start) / (end - start)) * 300;
  const y = (v) => 96 - ((v - lo) / (hi - lo)) * 92;
  const steps = (key, cls) => {
    const runs = [[]];
    segs.forEach((s) => {
      if (s[key] == null) { runs.push([]); return; }
      runs[runs.length - 1].push(`${x(s.t0).toFixed(1)},${y(s[key]).toFixed(1)} ${x(s.t1).toFixed(1)},${y(s[key]).toFixed(1)}`);
    });
    return runs.filter((r) => r.length).map((r) => `<polyline class="${cls}" points="${r.join(" ")}"/>`).join("");
  };
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const mid = midnight.getTime() / 1000;
  svg.innerHTML =
    (mid > start ? `<line class="mid" x1="${x(mid).toFixed(1)}" y1="0" x2="${x(mid).toFixed(1)}" y2="100"/>` : "")
    + segs.filter((s) => s.heat).map((s) =>
      `<rect class="heat" x="${x(s.t0).toFixed(1)}" y="0" width="${Math.max(0.8, x(s.t1) - x(s.t0)).toFixed(1)}" height="100"/>`).join("")
    + steps("target", "target") + steps("temp", "water")
    + (d.temp != null ? `<circle cx="299" cy="${y(d.temp).toFixed(1)}" r="2.5"/>` : "");
  $("ht-hi").textContent = `${hi}°`;
  $("ht-lo").textContent = `${lo}°`;
}

// ---------- solar repeater ----------
// Shares the MeshCore spot: tap to switch, and it also flips by itself every 20 seconds.

const RP_DAYS = 4;
const RP_LOW_VOLTS = 3.6;
// Two panels sharing one spot. ready() says whether the second one has anything to show.
function swapPair(mainId, altId, ready) {
  let showingAlt = false;
  return (show) => {
    showingAlt = ready() && (show ?? !showingAlt);
    $(mainId).classList.toggle("swap-hidden", showingAlt);
    $(altId).classList.toggle("swap-hidden", !showingAlt);
  };
}
let rpConfigured = false, htConfigured = false;
const swapMeshRepeater = swapPair("p-mesh", "p-repeater", () => rpConfigured);
const swapWeatherHotTub = swapPair("p-weather", "p-hottub", () => htConfigured);

function renderRepeater(entry) {
  const panel = $("p-repeater");
  rpConfigured = entry.configured;
  const d = panelState(panel, entry);
  if (!d) return;
  $("rp-name").textContent = `${d.label.toUpperCase()} · SOLAR REPEATER`;
  const rows = d.readings.filter((r) => r.battery_volts);
  if (!rows.length) return;
  const last = rows[rows.length - 1];
  $("rp-now").innerHTML = `${last.battery_volts.toFixed(2)}<span class="dg">V</span>`;
  // Red once the cell is nearly empty (a Li-ion cell has little left below ~3.6 V)
  $("rp-now").classList.toggle("low", last.battery_volts < RP_LOW_VOLTS);
  // Header end cap: uptime, like the system panels
  panel.querySelector(".ph-cap").textContent = last.uptime_seconds != null ? fmtUptime(last.uptime_seconds).split(" ")[0] : "";

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
  $("rp-peak").innerHTML = todays.length ? `${Math.max(...todays).toFixed(2)}<span class="dg">V</span>` : "—";

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
  $("rp-rate").textContent = bars.length ? `${Math.round(bars[bars.length - 1].rate)} / HR · PEAK ${Math.round(peakRate)}` : "—";

  // Share of time the radio spends transmitting
  $("rp-air").textContent = last.airtime_seconds != null && last.uptime_seconds
    ? `${(100 * last.airtime_seconds / last.uptime_seconds).toFixed(1)}%` : "—";
  $("rp-when").textContent = d.last_error ? "⚠ LAST CHECK FAILED" : `CHECKED ${fmtAgo(new Date(last.ts * 1000).toISOString())}`;
  $("rp-when").title = d.last_error || "";
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
    if (data.hottub) renderHotTub(data.hottub);

    if (data.title) $("title").textContent = data.title.toUpperCase();
    $("link-status").textContent = "LINK ESTABLISHED";
    document.body.classList.remove("stale");
  } catch (err) {
    console.warn("status fetch failed:", err);
    $("link-status").textContent = "LINK LOST";
    document.body.classList.add("stale");
  }
}

setupSystemPanels();
onTap($("p-mesh"), () => { chirp(); swapMeshRepeater(); });
onTap($("p-repeater"), () => { chirp(); swapMeshRepeater(); });
document.querySelectorAll(".buttons a").forEach((a) => a.addEventListener("click", () => chirp()));
onTap($("p-weather"), () => { if (htConfigured) { chirp(); swapWeatherHotTub(); } });
onTap($("p-hottub"), () => { chirp(); swapWeatherHotTub(); });
// Auto-switch every 20 s, but not while someone is reading/scrolling the messages.
// Outside / hot tub runs 10 s out of step, so the two spots don't flip at the same moment.
setInterval(() => { if (Date.now() - lastTouch > IDLE_MS) swapMeshRepeater(); }, 20000);
setTimeout(() => setInterval(() => { if (Date.now() - lastTouch > IDLE_MS) swapWeatherHotTub(); }, 20000), 10000);
tickClock();
setInterval(tickClock, 1000);
poll();
setInterval(poll, POLL_MS);
