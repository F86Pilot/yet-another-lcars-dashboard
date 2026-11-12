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
let lastStatus = {};  // the whole latest /api/status, for the full-screen views

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
  const { rows, empty } = sysTopRows(s, view);
  fillTops(panel.querySelector(".tops"), rows, empty);
}

// Top apps for one view ("cpu", "mem", "net") as rows of {name, pct, val}
function sysTopRows(s, view) {
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
  return { rows, empty };
}

function fillTops(list, rows, empty) {
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
    ? data.streams.map(streamHtml).join("")
    : `<div class="empty">NO ACTIVE STREAMS</div>`;
  $("plex-streams").querySelectorAll(".prog .segs").forEach((el, i) => setSegs(el, data.streams[i].progress, { hot: 101, crit: 101 }));

  // Scrollable list; only rewrite it when something changed so a scroll in progress isn't disturbed
  const html = dedupePlays(data.history).map((h) => historyItem(h)).join("") || `<li class="empty">NO HISTORY YET</li>`;
  const list = $("plex-history");
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
}

function streamHtml(s) {
  return `
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
      </div>`;
}

// Tautulli logs a new row each time a stop/resume happens; show each episode once
const dedupePlays = (list) => list.filter((h, i, all) => !all.slice(0, i).some((o) =>
  o.show === h.show && o.detail === h.detail && o.user === h.user));

function historyItem(h, more = false) {
  const who = `${h.time ? fmtAgo(h.time) : ""} · ${esc(String(h.user || "").toUpperCase())}`;
  // The full-screen list is narrower per row, so who/when/where goes on a third line there
  const extra = more ? `<div class="h-who">${who}${h.player ? ` · ${esc(String(h.player).toUpperCase())}` : ""}${h.percent != null ? ` · ${h.percent}%` : ""}</div>` : "";
  return `
    <li>${lcarsCard(h.show)}
      <div class="h-body">
        <div class="h-title">${esc(h.show)}</div>
        <div class="h-meta">${esc(h.detail || "")}</div>${extra}
      </div>
      ${more ? "" : `<span class="ago">${who}</span>`}</li>`;
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
  closeDetail();
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
    fn(e);
  });
}

// ---------- meshcore ----------

function renderMesh(entry) {
  const data = panelState($("p-mesh"), entry);
  if (!data) return;
  const html = data.messages.map((m) => meshItem(m)).join("") || `<li class="empty">NO MESSAGES</li>`;
  const list = $("mesh-log");
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
}

function meshItem(m) {
  return `
    <li>
      <div class="m-top">
        <time>${fmtTime(m.time)}</time>
        <span class="m-where ${m.where === "DIRECT" ? "dm" : m.where.startsWith("#") ? "" : "pub"}">${esc(m.where.toUpperCase())}</span>
        <span class="m-sender">${esc(m.sender)}</span>
        ${m.snr != null ? `<span class="m-sig">SNR ${m.snr} · ${m.hops ?? "?"} HOPS</span>` : ""}
      </div>
      <div class="m-text">${esc(m.text)}</div>
    </li>`;
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

let lastHotTub = null;
function renderHotTub(entry) {
  const panel = $("p-hottub");
  htConfigured = entry.configured;
  const d = panelState(panel, entry);
  if (!d) return;
  lastHotTub = d;
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
  const end = Date.now() / 1000, start = end - d.history_hours * 3600;
  const segs = tubSegs(tubPoints(d, d.history), start, end);
  const scale = tubScale(segs);
  const svg = $("ht-svg");
  if (!scale) {
    svg.innerHTML = `<text class="ht-empty" x="150" y="55" text-anchor="middle">COLLECTING HISTORY</text>`;
    $("ht-hi").textContent = $("ht-lo").textContent = "";
  } else {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    svg.innerHTML = tubChart(segs, { start, end, ...scale, temp: d.temp, grid: [{ t: midnight.getTime() / 1000, cls: "mid" }] });
    $("ht-hi").textContent = `${scale.hi}°`;
    $("ht-lo").textContent = `${scale.lo}°`;
  }
}

// ---------- hot tub chart, shared by the panel and its full-screen view ----------
// Readings are [time, water, target, heating]. Each one holds until the next, so lines are steps.

// History plus a reading for "now", so the line reaches the right edge between history refreshes
function tubPoints(d, history) {
  const pts = history.slice();
  if (d.temp != null) pts.push([Date.now() / 1000, d.temp, d.target, d.action === "heating"]);
  return pts;
}

function tubSegs(pts, start, end) {
  const segs = [];
  pts.forEach((p, i) => {
    const t1 = Math.min(i + 1 < pts.length ? pts[i + 1][0] : end, end);
    const t0 = Math.max(p[0], start);
    if (t1 > t0) segs.push({ t0, t1, temp: p[1], target: p[2], heat: p[3] });
  });
  return segs;
}

// Axis range in whole degrees, at least 6° tall so small wobbles don't look dramatic
function tubScale(segs) {
  const vals = segs.flatMap((s) => [s.temp, s.target]).filter((v) => v != null);
  if (!vals.length) return null;
  let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  if (hi - lo < 6) { lo = Math.floor((hi + lo) / 2 - 3); hi = lo + 6; }
  return { lo, hi };
}

// SVG content for a viewBox of W × H. grid: [{t, cls}] vertical lines; extra(x): more marks drawn behind the lines.
function tubChart(segs, { start, end, lo, hi, temp, W = 300, H = 100, grid = [], extra }) {
  const x = (t) => ((t - start) / (end - start)) * W;
  const y = (v) => H * 0.96 - ((v - lo) / (hi - lo)) * H * 0.92;
  const steps = (key, cls) => {
    const runs = [[]];
    segs.forEach((s) => {
      if (s[key] == null) { runs.push([]); return; }
      runs[runs.length - 1].push(`${x(s.t0).toFixed(1)},${y(s[key]).toFixed(1)} ${x(s.t1).toFixed(1)},${y(s[key]).toFixed(1)}`);
    });
    return runs.filter((r) => r.length).map((r) => `<polyline class="${cls}" points="${r.join(" ")}"/>`).join("");
  };
  return grid.filter((g) => g.t > start && g.t < end).map((g) =>
      `<line class="${g.cls}" x1="${x(g.t).toFixed(1)}" y1="0" x2="${x(g.t).toFixed(1)}" y2="${H}"/>`).join("")
    + segs.filter((s) => s.heat).map((s) =>
      `<rect class="heat" x="${x(s.t0).toFixed(1)}" y="0" width="${Math.max(W / 375, x(s.t1) - x(s.t0)).toFixed(1)}" height="${H}"/>`).join("")
    + (extra ? extra(x) : "")
    + steps("target", "target") + steps("temp", "water")
    + (temp != null ? `<circle cx="${W - 1}" cy="${y(temp).toFixed(1)}" r="2.5"/>` : "");
}

// ---------- hot tub full-screen view ----------

const fmtDur = (h) => (h >= 1 ? `${Math.floor(h)}H ${String(Math.round((h % 1) * 60)).padStart(2, "0")}M` : `${Math.max(1, Math.round(h * 60))} MIN`);

// How fast the water warms while heating, and cools while not, from whole runs of each.
// Short runs are skipped: the sensor only reports whole degrees, so they're mostly noise.
function tubRates(segs) {
  const runs = [];
  segs.forEach((s) => {
    if (s.temp == null) { runs.push(null); return; }
    const r = runs[runs.length - 1];
    if (r && r.heat === s.heat) { r.t1 = s.t1; r.last = s.temp; } else runs.push({ heat: s.heat, t0: s.t0, t1: s.t1, first: s.temp, last: s.temp });
  });
  const rate = (heat, minHours) => {
    let deg = 0, hrs = 0;
    runs.filter((r) => r && r.heat === heat && (r.t1 - r.t0) / 3600 >= minHours).forEach((r) => {
      deg += r.last - r.first; hrs += (r.t1 - r.t0) / 3600;
    });
    return hrs ? Math.abs(deg / hrs) : null;
  };
  return { heat: rate(true, 0.5), cool: rate(false, 2) };
}

function renderHotTubDetail() {
  const d = lastHotTub;
  if (!d) return;
  const extra = detailData.hottub;
  // The week of history (refreshed every 5 min), topped up with the panel's fresher readings
  const week = extra ? extra.history.slice() : [];
  const lastTs = week.length ? week[week.length - 1][0] : 0;
  week.push(...d.history.filter((p) => p[0] > lastTs));
  const pts = tubPoints(d, week);
  const heating = d.action === "heating";

  $("dh-name").textContent = `${d.label.toUpperCase()} · DETAIL`;
  $("dh-temp").innerHTML = deg(d.temp);
  $("dh-target").innerHTML = deg(d.target);
  ["power", "heat", "filter"].forEach((k) => {
    const src = $(`ht-${k}`), dst = $(`dh-${k}`);
    dst.textContent = src.textContent; dst.className = src.className;
  });
  panelState($("d-hottub"), lastStatus.hottub);

  // Status and how long until it's warm, from how fast it has been heating this week
  const end = Date.now() / 1000;
  const rates = tubRates(tubSegs(pts, end - 7 * 86400, end));
  const status = d.connected === false ? "OFFLINE" : d.power === false ? "POWER OFF" : heating ? "HEATING" : d.mode === "heat" ? "IDLE" : "HEATER OFF";
  $("dh-status").textContent = status;
  $("dh-status").className = "headline " + (heating ? "heating" : "idle");
  const gap = d.temp != null && d.target != null ? d.target - d.temp : null;
  $("dh-eta").innerHTML = gap == null ? ""
    : gap < -0.5 ? `<b>${Math.round(-gap)}°</b> ABOVE TARGET`
    : gap <= 0 ? "AT TARGET"
    : heating && rates.heat ? `AT TARGET IN <b>≈ ${fmtDur(gap / rates.heat)}</b>`
    : `<b>${Math.round(gap)}°</b> BELOW TARGET`;
  const r = (v) => (v == null ? "—" : `${v.toFixed(1)}°/HR`);
  $("dh-rates").innerHTML = `HEATS <b>${r(rates.heat)}</b> · COOLS <b>${r(rates.cool)}</b>`;
  const problem = d.errors.length ? d.errors.join(" ").toUpperCase() : d.error ? "ERROR" : "NO ERRORS";
  $("dh-extra").innerHTML = `${d.bubbles ? `BUBBLES <b>${esc(d.bubbles.toUpperCase())}</b> · ` : ""}<b class="${problem === "NO ERRORS" ? "" : "alert"}">${esc(problem)}</b>`;

  const hours = detailHours.hottub;
  $("dh-chart-title").textContent = `WATER · ${hours === 24 ? "24 HRS" : `${hours / 24} DAYS`}`;

  // Big chart for the chosen range
  const start = end - hours * 3600;
  const segs = tubSegs(pts, start, end);
  const scale = tubScale(segs);
  const svg = $("dh-svg");
  const W = 600, H = 200;
  const { grid, ticks } = timeGrid(start, end);
  drawTicks($("dh-ticks"), ticks, start, end);

  // Filter running: a strip along the bottom
  const filterRuns = [];
  const fl = extra ? extra.filter : [];
  fl.forEach((f, i) => {
    if (!f[1]) return;
    const a = Math.max(f[0], start), b = Math.min(i + 1 < fl.length ? fl[i + 1][0] : end, end);
    if (b > a) filterRuns.push([a, b]);
  });
  const filterStrip = (x) => filterRuns.map(([a, b]) =>
    `<rect class="filter" x="${x(a).toFixed(1)}" y="${H - 5}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="5"/>`).join("");

  if (!scale) {
    svg.innerHTML = `<text class="ht-empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">${extra ? "NO HISTORY FOR THIS RANGE" : "LOADING HISTORY"}</text>`;
    $("dh-axis").innerHTML = "";
  } else {
    svg.innerHTML = tubChart(segs, { start, end, ...scale, temp: d.temp, W, H, grid, extra: filterStrip });
    drawAxis($("dh-axis"), scale.lo, scale.hi, { n: Math.min(6, scale.hi - scale.lo), fmt: (v) => `${Math.round(v)}°` });
  }

  // Range summary: heater time and water range
  const heatHrs = segs.filter((s) => s.heat).reduce((a, s) => a + (s.t1 - s.t0) / 3600, 0);
  const temps = segs.map((s) => s.temp).filter((v) => v != null);
  $("dh-range-stats").innerHTML = temps.length
    ? `HEATER <b>${heatHrs.toFixed(1)} HRS</b> (${Math.round((100 * heatHrs) / hours)}%) · WATER <b>${Math.min(...temps)}–${Math.max(...temps)}°</b>` : "";

  // Heater hours for each of the last 7 days (today so far on the right)
  const days = [];
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const a = new Date(day0); a.setDate(a.getDate() - i);
    const b = new Date(a); b.setDate(b.getDate() + 1);
    const ds = tubSegs(pts, a.getTime() / 1000, Math.min(b.getTime() / 1000, end));
    const t = ds.map((s) => s.temp).filter((v) => v != null);
    days.push({
      label: i === 0 ? "TODAY" : a.toLocaleDateString([], { weekday: "short", day: "numeric" }).toUpperCase(),
      hours: ds.filter((s) => s.heat).reduce((acc, s) => acc + (s.t1 - s.t0) / 3600, 0),
      lo: t.length ? Math.min(...t) : null, hi: t.length ? Math.max(...t) : null,
      known: t.length > 0,
    });
  }
  const most = Math.max(4, ...days.map((x) => x.hours));
  $("dh-days").innerHTML = days.map((x) => `
    <div class="dh-day${x.known ? "" : " none"}">
      <div class="dh-hrs">${x.known ? `${x.hours.toFixed(1)}H` : "—"}</div>
      <div class="dh-bar"><i style="height:${((x.hours / most) * 100).toFixed(1)}%"></i></div>
      <div class="dh-lbl">${esc(x.label)}</div>
      <div class="dh-rng">${x.lo != null ? `${x.lo}–${x.hi}°` : ""}</div>
    </div>`).join("");
}

// ---------- charts for the full-screen views ----------
// All detail charts use the same geometry: a W × H viewBox, values between lo and hi,
// with a little room top and bottom. Axis labels are placed in % to match.

const yFrac = (v, lo, hi) => 0.96 - ((v - lo) / (hi - lo || 1)) * 0.92;

// Vertical grid lines and the labels under a time axis, spaced to suit the span
function timeGrid(start, end, { maxLabels = 8 } = {}) {
  const span = (end - start) / 3600;
  const grid = [], ticks = [];
  const dayName = (t, opts = { weekday: "short" }) => new Date(t * 1000).toLocaleDateString([], opts).toUpperCase();
  const hourName = (d) => `${d.getHours() % 12 || 12}${d.getHours() < 12 ? "A" : "P"}`;
  const first = new Date(start * 1000);
  if (span <= 2) {
    first.setSeconds(0, 0); first.setMinutes(Math.ceil(first.getMinutes() / 15) * 15);
    for (let t = first.getTime() / 1000; t < end; t += 900) {
      const d = new Date(t * 1000);
      grid.push({ t, cls: "hr" });
      ticks.push({ t, text: `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}` });
    }
  } else if (span <= 50) {
    const step = span <= 26 ? 3 : 6;
    first.setMinutes(0, 0, 0); first.setHours(Math.ceil(first.getHours() / step) * step);
    for (let t = first.getTime() / 1000; t < end; t += step * 3600) {
      const d = new Date(t * 1000);
      grid.push({ t, cls: d.getHours() === 0 ? "mid" : "hr" });
      ticks.push({ t, text: d.getHours() === 0 ? dayName(t) : hourName(d) });
    }
  } else {
    first.setHours(0, 0, 0, 0);
    const days = Math.ceil(span / 24);
    const every = days > maxLabels + 1 ? Math.ceil(days / maxLabels) : 1;
    let i = 0;
    for (let t = first.getTime() / 1000; t < end; t += 86400) {
      const day = new Date(t * 1000); day.setHours(0, 0, 0, 0);
      const mid = day.getTime() / 1000;   // (safe across daylight-saving changes)
      grid.push({ t: mid, cls: "mid" });
      if (span <= 80) grid.push({ t: mid + 43200, cls: "hr" });
      if (i++ % every === 0) ticks.push({ t: mid + 43200, text: dayName(mid + 43200, days > 9 ? { day: "numeric", month: "short" } : { weekday: "short", day: "numeric" }) });
    }
  }
  return { grid, ticks };
}

function drawTicks(el, ticks, start, end) {
  const pct = (t) => ((t - start) / (end - start)) * 100;
  // labels right at either edge would be cut in half, so they're left off
  el.innerHTML = ticks.filter((k) => pct(k.t) > 3 && pct(k.t) < 97)
    .map((k) => `<span style="left:${pct(k.t).toFixed(1)}%">${esc(k.text)}</span>`).join("");
}

function drawAxis(el, lo, hi, { n = 4, fmt = (v) => v } = {}) {
  const marks = [];
  for (let i = 0; i <= n; i++) marks.push(lo + ((hi - lo) * i) / n);
  el.innerHTML = marks.map((v) => `<span style="top:${(yFrac(v, lo, hi) * 100).toFixed(1)}%">${esc(fmt(v))}</span>`).join("");
}

// A tidy axis range around some values: whole steps, optional floor/ceiling, never flat
function niceRange(vals, { min, max, pad = 0.08, step = 1, floor, ceil, minSpan = step * 2 } = {}) {
  const v = vals.filter((x) => x != null && isFinite(x));
  if (!v.length) return null;
  let lo = min ?? Math.min(...v), hi = max ?? Math.max(...v);
  const p = (hi - lo || Math.abs(hi) || 1) * pad;
  if (min == null) lo -= p;
  if (max == null) hi += p;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  if (hi - lo < minSpan) { if (max == null) hi = lo + minSpan; else lo = hi - minSpan; }
  if (floor != null) lo = Math.max(floor, lo);
  if (ceil != null) hi = Math.min(ceil, hi);
  return { lo, hi };
}

/* SVG content for one chart.
   lines: [{pts: [[t, v], ...], cls, step, gap}]   v null or a time gap > gap seconds breaks the line
   bars:  [{t0, t1, v, v0, cls}]                    v0 = where the bar starts (stacking), default lo
   bands: [{t0, t1, cls, top, bottom}]              full-height shading; top/bottom as 0..1 to limit it
   hlines:[{v, cls}]  marks: [{t, cls}]  grid: from timeGrid */
function chartSvg({ start, end, lo, hi, W = 600, H = 100, lines = [], bars = [], bands = [], hlines = [], marks = [], grid = [] }) {
  const x = (t) => ((t - start) / (end - start)) * W;
  const y = (v) => yFrac(v, lo, hi) * H;
  const f = (n) => n.toFixed(1);
  let out = grid.filter((g) => g.t > start && g.t < end)
    .map((g) => `<line class="${g.cls}" x1="${f(x(g.t))}" y1="0" x2="${f(x(g.t))}" y2="${H}"/>`).join("");
  out += bands.map((b) => {
    const a = Math.max(b.t0, start), z = Math.min(b.t1, end);
    if (z <= a) return "";
    const top = (b.top ?? 0) * H, bot = (b.bottom ?? 1) * H;
    return `<rect class="${b.cls}" x="${f(x(a))}" y="${f(top)}" width="${f(Math.max(W / 400, x(z) - x(a)))}" height="${f(bot - top)}"/>`;
  }).join("");
  out += bars.map((b) => {
    const a = Math.max(b.t0, start), z = Math.min(b.t1, end);
    if (z <= a || b.v == null) return "";
    const ya = y(b.v0 ?? lo), yb = y(b.v0 != null ? b.v0 + b.v : b.v);
    const top = Math.min(ya, yb), h = Math.abs(ya - yb);
    const w = x(z) - x(a);
    return `<rect class="${b.cls}" x="${f(x(a) + Math.min(1, w * 0.1))}" y="${f(top)}" width="${f(Math.max(0.8, w - Math.min(2, w * 0.2)))}" height="${f(h)}"/>`;
  }).join("");
  out += hlines.filter((h) => h.v >= lo && h.v <= hi).map((h) => `<line class="${h.cls}" x1="0" y1="${f(y(h.v))}" x2="${W}" y2="${f(y(h.v))}"/>`).join("");
  out += lines.map((l) => {
    const runs = [[]];
    let prev = null;
    l.pts.forEach(([t, v], i) => {
      if (v == null || (prev != null && l.gap && t - prev > l.gap)) runs.push([]);
      prev = t;
      if (v == null) return;
      const t1 = l.step ? Math.min(i + 1 < l.pts.length ? l.pts[i + 1][0] : end, end) : null;
      if (t1 != null && t1 < start) return;
      const run = runs[runs.length - 1];
      run.push(`${f(x(Math.max(t, start)))},${f(y(v))}`);
      if (l.step) run.push(`${f(x(t1))},${f(y(v))}`);
    });
    return runs.filter((r) => r.length).map((r) => `<polyline class="${l.cls}" points="${r.join(" ")}"/>`).join("");
  }).join("");
  out += marks.filter((m) => m.t >= start && m.t <= end)
    .map((m) => `<line class="${m.cls}" x1="${f(x(m.t))}" y1="0" x2="${f(x(m.t))}" y2="${H}"/>`).join("");
  return out;
}

const emptyChart = (svg, text) => {
  const [, , W, H] = svg.getAttribute("viewBox").split(" ").map(Number);
  svg.innerHTML = `<text class="ht-empty" x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle">${esc(text)}</text>`;
};

// Columns of [[t, v], ...] from the server's {t: [...], field: [...]} shape
const zipSeries = (s, field, scale = 1) => (s && s[field] ? s.t.map((t, i) => [t, s[field][i] == null ? null : s[field][i] * scale]) : []);
const statOf = (pts) => {
  const v = pts.map((p) => p[1]).filter((x) => x != null);
  return v.length ? { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, last: v[v.length - 1] } : null;
};
const fmtNum = (n) => Number(n).toLocaleString();

// Ranked list (name, bar, value) shared by the "top" lists
function rankList(el, rows, empty) {
  const scale = Math.max(1e-9, ...rows.map((r) => r.value));
  el.innerHTML = rows.length
    ? rows.map((r) => `<li><span class="t-name">${esc(String(r.name).toUpperCase())}</span><div class="segs"></div><span class="mval">${esc(r.label)}</span></li>`).join("")
    : `<li class="empty">${esc(empty)}</li>`;
  el.querySelectorAll(".segs").forEach((s, i) => setSegs(s, Math.max(1, (rows[i].value / scale) * 100), { hot: 101, crit: 101 }));
}

// One column per day: a bar (or a floating range), the value above, the day below
function dayColumns(el, days, { max, min = 0, fmt, sub } = {}) {
  el.style.gridTemplateColumns = `repeat(${days.length}, 1fr)`;
  el.innerHTML = days.map((d) => {
    const parts = (d.parts || [{ v: d.value, cls: "" }]);
    // (bars stack upward from the bottom; a floating range gets an empty spacer under it)
    const pct = (v) => `${Math.max(0, (v / (max - min)) * 100).toFixed(1)}%`;
    const stack = parts.map((p) => (p.from != null ? `<i class="gap" style="height:${pct(p.from - min)}"></i>` : "")
      + `<i class="${p.cls}" style="height:${pct(p.v - (p.from ?? 0))}"></i>`).join("");
    return `<div class="dh-day${d.known ? "" : " none"}">
      <div class="dh-hrs">${d.known ? esc(fmt(d)) : "—"}</div>
      <div class="dh-bar">${d.known ? stack : ""}</div>
      <div class="dh-lbl">${esc(d.label)}</div>
      <div class="dh-rng">${sub && d.known ? esc(sub(d)) : ""}</div></div>`;
  }).join("");
}

// Local-midnight boundaries for the last n days, oldest first: [{a, b, label}]
function lastDays(n) {
  const out = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const a = new Date(today); a.setDate(a.getDate() - i);
    const b = new Date(a); b.setDate(b.getDate() + 1);
    out.push({ a: a.getTime() / 1000, b: b.getTime() / 1000,
      label: i === 0 ? "TODAY" : a.toLocaleDateString([], n > 7 ? { day: "numeric", month: "numeric" } : { weekday: "short", day: "numeric" }).toUpperCase() });
  }
  return out;
}

// Hours a step series spent in some state between a and b. pts: [[t, state], ...]
function hoursIn(pts, a, b, test, end = Date.now() / 1000) {
  let h = 0;
  pts.forEach((p, i) => {
    const t1 = Math.min(i + 1 < pts.length ? pts[i + 1][0] : end, b), t0 = Math.max(p[0], a);
    if (t1 > t0 && test(p)) h += (t1 - t0) / 3600;
  });
  return h;
}

// Shading for the periods a step series is in some state
function runsOf(pts, test, end = Date.now() / 1000) {
  const out = [];
  pts.forEach((p, i) => {
    if (!test(p)) return;
    const t1 = i + 1 < pts.length ? pts[i + 1][0] : end;
    const last = out[out.length - 1];
    if (last && last.t1 === p[0]) last.t1 = t1; else out.push({ t0: p[0], t1 });
  });
  return out;
}

// ---------- systems (server / NAS / Mac) full-screen view ----------

function renderSysDetail(key) {
  const panel = document.querySelector(`.panels .sys[data-key="${key}"]`);
  const s = lastSys[panel.id];
  const view = $("d-sys");
  view.style.setProperty("--c", panel.style.getPropertyValue("--c"));
  panelState(view, lastStatus[key]);
  if (!s) return;
  const hours = detailHours.sys;
  $("ds-name").textContent = `${s.label} · DETAIL`;
  $("ds-cpu").innerHTML = `${Math.round(s.cpu_percent)}<span class="dg">%</span>`;
  $("ds-mem").innerHTML = `${Math.round((100 * s.ram.used) / s.ram.total)}<span class="dg">%</span>`;

  const x = detailData[key];
  const series = x && x.hours === hours ? x.series : null;
  const end = Date.now() / 1000, start = end - hours * 3600;
  const cpu = zipSeries(series, "cpu"), mem = zipSeries(series, "mem"), temp = zipSeries(series, "temp");
  const rx = zipSeries(series, "rx", 8 / 1e6), tx = zipSeries(series, "tx", 8 / 1e6);
  const gap = series ? series.bucket * 3 : 0;

  // Facts
  const tStat = statOf(temp);
  $("ds-l1").innerHTML = `DISK <b>${fmtUsed(s.disk.used, s.disk.total)}</b> · <b>${Math.round((100 * s.disk.used) / s.disk.total)}%</b>`;
  const dw = x && x.disk_week;
  let fill = "";
  if (dw && dw.t.length > 1 && dw.t[dw.t.length - 1] - dw.t[0] > 86400) {
    const perDay = ((dw.disk[dw.disk.length - 1] - dw.disk[0]) / (dw.t[dw.t.length - 1] - dw.t[0])) * 86400;
    fill = ` · <b>${perDay >= 0 ? "+" : "−"}${fmtBytes(Math.abs(perDay))}</b>/DAY`;
  }
  $("ds-l2").innerHTML = `UP <b>${fmtUptime(s.uptime_seconds)}</b>${fill}`;
  $("ds-l3").innerHTML = s.temp_c != null
    ? `TEMP <b>${Math.round(s.temp_c)}°C</b>${tStat ? ` · PEAK <b>${Math.round(tStat.max)}°</b>` : ""}` : "";
  $("ds-l4").innerHTML = `NET ↓ <b>${fmtRate(s.net.rx_bps)}</b> ↑ <b>${fmtRate(s.net.tx_bps)}</b>`
    + (s.healthy === false ? ` · <b class="alert">⚠ DEGRADED</b>` : s.healthy ? " · HEALTH <b>OK</b>" : "");

  // Charts
  const { grid, ticks } = timeGrid(start, end);
  drawTicks($("ds-ticks"), ticks, start, end);
  const charts = [
    { id: "cpu", pts: cpu, range: niceRange(cpu.map((p) => p[1]), { min: 0, step: 10, ceil: 100, minSpan: 10 }), cls: "l-orange", fmt: (v) => `${Math.round(v)}%` },
    { id: "mem", pts: mem, range: niceRange(mem.map((p) => p[1]), { step: 5, floor: 0, ceil: 100, minSpan: 10 }), cls: "l-peach", fmt: (v) => `${Math.round(v)}%` },
  ];
  charts.forEach((c) => {
    const svg = $(`ds-${c.id}-svg`), st = statOf(c.pts);
    if (!c.range) { emptyChart(svg, series ? "COLLECTING HISTORY · A POINT EVERY MINUTE" : "LOADING"); $(`ds-${c.id}-axis`).innerHTML = ""; $(`ds-${c.id}-note`).textContent = ""; return; }
    svg.innerHTML = chartSvg({ start, end, ...c.range, grid, lines: [{ pts: c.pts, cls: c.cls, gap }] });
    drawAxis($(`ds-${c.id}-axis`), c.range.lo, c.range.hi, { n: 2, fmt: c.fmt });
    $(`ds-${c.id}-note`).textContent = `AVG ${Math.round(st.avg)}% · PEAK ${Math.round(st.max)}%`;
  });
  const netRange = niceRange([...rx, ...tx].map((p) => p[1]), { min: 0, step: 1, minSpan: 1 });
  if (!netRange) { emptyChart($("ds-net-svg"), series ? "COLLECTING HISTORY" : "LOADING"); $("ds-net-axis").innerHTML = ""; $("ds-net-note").textContent = ""; }
  else {
    $("ds-net-svg").innerHTML = chartSvg({ start, end, ...netRange, grid, lines: [{ pts: rx, cls: "l-orange", gap }, { pts: tx, cls: "l-blue", gap }] });
    drawAxis($("ds-net-axis"), netRange.lo, netRange.hi, { n: 2, fmt: (v) => (v >= 10 ? Math.round(v) : v.toFixed(1)) });
    const rs = statOf(rx), ts = statOf(tx);
    $("ds-net-note").innerHTML = `<em class="k-rx">↓</em> PEAK ${rs.max.toFixed(1)} · <em class="k-tx">↑</em> PEAK ${ts.max.toFixed(1)}`;
  }

  // Top apps, all three at once
  ["cpu", "mem", "net"].forEach((v) => { const r = sysTopRows(s, v); fillTops($(`ds-top-${v}`), r.rows, r.empty); });
  $("ds-top-net-title").textContent = s.top && s.top.net_kind === "services" ? "CONNECTIONS" : "TOP · NETWORK";
}

// ---------- plex full-screen view ----------

function renderPlexDetail() {
  const entry = lastStatus.plex, d = entry && entry.data, x = detailData.plex;
  panelState($("d-plex"), entry);
  if (!d) return;
  $("dp-streams").innerHTML = d.streams.length ? d.streams.map(streamHtml).join("") : `<div class="empty">NO ACTIVE STREAMS</div>`;
  $("dp-streams").querySelectorAll(".prog .segs").forEach((el, i) => setSegs(el, d.streams[i].progress, { hot: 101, crit: 101 }));
  $("dp-bw").textContent = d.streams.length && d.bandwidth_kbps ? `${(d.bandwidth_kbps / 1000).toFixed(1)} MBPS` : "";
  if (!x) return;

  // Plays per day, TV and movies stacked
  const days = x.days.map((s) => { const [y, m, dd] = s.split("-").map(Number); return new Date(y, m - 1, dd).getTime() / 1000; });
  if (days.length) {
    const start = days[0], end = days[days.length - 1] + 86400;
    const totals = days.map((_, i) => (x.tv[i] || 0) + (x.movies[i] || 0));
    const hi = Math.max(4, Math.ceil(Math.max(...totals) / 2) * 2);
    const bars = days.flatMap((t, i) => [
      { t0: t, t1: t + 86400, v: x.tv[i] || 0, v0: 0, cls: "b-tv" },
      { t0: t, t1: t + 86400, v: x.movies[i] || 0, v0: x.tv[i] || 0, cls: "b-movie" }]);
    const { ticks } = timeGrid(start, end, { maxLabels: 5 });
    $("dp-svg").innerHTML = chartSvg({ start, end, lo: 0, hi, bars, grid: [] });
    drawAxis($("dp-axis"), 0, hi, { n: 2, fmt: (v) => Math.round(v) });
    drawTicks($("dp-ticks"), ticks, start, end);
    const week = totals.slice(-7).reduce((a, b) => a + b, 0);
    $("dp-plays-note").textContent = `${totals.reduce((a, b) => a + b, 0)} PLAYS · ${week} THIS WEEK`;
  }
  const hrs = (m) => (m >= 60 ? `${(m / 60).toFixed(1)} H` : `${m} M`);
  rankList($("dp-top-tv"), x.top_tv.map((r) => ({ name: r.title.replace(/\s*\(\d{4}\)$/, ""), value: r.plays, label: `${r.plays} · ${hrs(r.minutes)}` })), "NOTHING THIS WEEK");
  rankList($("dp-top-movies"), x.top_movies.map((r) => ({ name: r.title, value: r.plays, label: `${r.plays} · ${hrs(r.minutes)}` })), "NO MOVIES THIS WEEK");
  rankList($("dp-top-users"), x.top_users.map((r) => ({ name: r.name, value: r.minutes, label: `${r.plays} · ${hrs(r.minutes)}` })), "NO ONE THIS WEEK");
  $("dp-libs").innerHTML = x.libraries.map((l) => `<div class="line">${esc(l.name.toUpperCase())} <b>${fmtNum(l.count)}</b>${l.type === "show" ? ` SHOWS · <b>${fmtNum(l.episodes)}</b> EPISODES` : l.type === "movie" ? " MOVIES" : ""}</div>`).join("");
  const html = dedupePlays(x.history).map((h) => historyItem(h, true)).join("") || `<li class="empty">NO HISTORY YET</li>`;
  const list = $("dp-history");
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
}

// ---------- meshcore full-screen view ----------

const CHAN_COLORS = ["tan", "blue", "lavender", "purple", "peach"];
function renderMeshDetail() {
  const entry = lastStatus.mesh, x = detailData.mesh;
  panelState($("d-mesh"), entry);
  if (!x) { $("dm-log").innerHTML = `<li class="empty">LOADING</li>`; return; }
  const msgs = x.messages;
  $("dm-count").textContent = `${msgs.length} MESSAGES`;
  const html = msgs.map((m) => meshItem(m)).join("") || `<li class="empty">NO MESSAGES</li>`;
  const list = $("dm-log");
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }

  // Per-channel counts; the busiest four get their own color in the chart
  const count = (key) => Object.entries(msgs.reduce((a, m) => { a[key(m)] = (a[key(m)] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]);
  const chans = count((m) => m.where.toUpperCase());
  const colorOf = {};
  chans.forEach(([c], i) => { colorOf[c] = i < 4 ? CHAN_COLORS[i] : "peach"; });
  rankList($("dm-channels"), chans.slice(0, 6).map(([n, v]) => ({ name: n, value: v, label: `${v}` })), "NONE");
  rankList($("dm-senders"), count((m) => m.sender).slice(0, 6).map(([n, v]) => ({ name: n, value: v, label: `${v}` })), "NONE");

  const end = Date.now() / 1000;
  const hour0 = new Date(); hour0.setMinutes(0, 0, 0);
  const startHour = hour0.getTime() / 1000 - 23 * 3600;
  const start = startHour, endH = hour0.getTime() / 1000 + 3600;
  const buckets = Array.from({ length: 24 }, () => ({}));
  msgs.forEach((m) => {
    const i = Math.floor((m.ts - startHour) / 3600);
    if (i >= 0 && i < 24) { const c = colorOf[m.where.toUpperCase()]; buckets[i][c] = (buckets[i][c] || 0) + 1; }
  });
  const order = [...new Set(Object.values(colorOf))];
  const bars = [];
  let peak = 1;
  buckets.forEach((b, i) => {
    let base = 0;
    order.forEach((c) => { if (b[c]) { bars.push({ t0: startHour + i * 3600, t1: startHour + (i + 1) * 3600, v: b[c], v0: base, cls: `b-${c}` }); base += b[c]; } });
    peak = Math.max(peak, base);
  });
  const hi = Math.ceil(peak / 5) * 5;
  const { grid, ticks } = timeGrid(start, endH);
  $("dm-svg").innerHTML = chartSvg({ start, end: endH, lo: 0, hi, bars, grid: grid.filter((g) => g.cls === "mid") });
  drawAxis($("dm-axis"), 0, hi, { n: 2, fmt: (v) => Math.round(v) });
  drawTicks($("dm-ticks"), ticks, start, endH);
  $("dm-keys").innerHTML = chans.slice(0, 4).map(([c]) => `<span class="kc-${colorOf[c]}">▮ ${esc(c)}</span>`).join("") + (chans.length > 4 ? `<span class="kc-peach">▮ OTHER</span>` : "");

  const r = x.radio || {};
  const fact = (label, v) => (v == null ? "" : `<div class="line">${label} <b>${v}</b></div>`);
  $("dm-radio").innerHTML = fact("RADIO", r.connected === false ? "DISCONNECTED" : r.model ? esc(String(r.model).toUpperCase()) : null)
    + fact("NOISE FLOOR", r.noise_floor != null ? `${r.noise_floor} DBM` : null)
    + fact("LAST", r.last_rssi != null ? `RSSI ${r.last_rssi} · SNR ${r.last_snr}` : null)
    + fact("PACKETS", r.packets_recv != null ? `↓ ${fmtNum(r.packets_recv)} · ↑ ${fmtNum(r.packets_sent)}` : null)
    + fact("UPTIME", r.uptime != null ? fmtUptime(r.uptime) : null);
  $("dm-heard-n").textContent = `${x.contacts.length} OF ${x.contact_count}`;
  $("dm-heard").innerHTML = x.contacts.map((c) => `<li><span class="kind k-${c.kind.toLowerCase()}">${esc(c.kind)}</span><span class="nm">${esc(c.name || "?")}</span><span class="ago">${c.last_seen ? fmtAgo(new Date(c.last_seen * 1000).toISOString()) : ""}</span></li>`).join("")
    || `<li class="empty">NOTHING HEARD</li>`;
}

// ---------- solar repeater full-screen view ----------

function renderRepeaterDetail() {
  const entry = lastStatus.repeater, d = entry && entry.data, x = detailData.repeater;
  panelState($("d-repeater"), entry);
  if (!d) return;
  const rows = ((x && x.readings) || d.readings).filter((r) => r.battery_volts);
  $("dr-name").textContent = `${d.label.toUpperCase()} · SOLAR REPEATER · DETAIL`;
  if (!rows.length) return;
  const last = rows[rows.length - 1];
  const hours = detailHours.repeater;
  const end = Date.now() / 1000, start = end - hours * 3600;
  const shown = rows.filter((r) => r.ts >= start);
  const gap = d.poll_minutes * 60 * 3;

  $("dr-now").innerHTML = `${last.battery_volts.toFixed(2)}<span class="dg">V</span>`;
  $("dr-now").classList.toggle("low", last.battery_volts < RP_LOW_VOLTS);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tv = rows.filter((r) => r.ts * 1000 >= today.getTime()).map((r) => r.battery_volts);
  $("dr-today").innerHTML = tv.length ? `${Math.min(...tv).toFixed(2)}<span class="sep">–</span>${Math.max(...tv).toFixed(2)}` : "—";
  $("dr-l1").innerHTML = last.uptime_seconds != null ? `UPTIME <b>${fmtUptime(last.uptime_seconds)}</b>` : "";
  $("dr-l2").innerHTML = last.airtime_seconds != null && last.uptime_seconds
    ? `AIRTIME <b>${((100 * last.airtime_seconds) / last.uptime_seconds).toFixed(1)}%</b>` : "";
  $("dr-l3").innerHTML = `DUPES <b>${fmtNum((last.flood_dups || 0) + (last.direct_dups || 0))}</b> · RX ERRORS <b>${fmtNum(last.recv_errors || 0)}</b>`;
  $("dr-l4").innerHTML = d.last_error ? `<b class="alert">⚠ LAST CHECK FAILED</b>` : `CHECKED <b>${fmtAgo(new Date(last.ts * 1000).toISOString())}</b> · EVERY <b>${d.poll_minutes} MIN</b>`;

  const { grid, ticks } = timeGrid(start, end);
  drawTicks($("dr-ticks"), ticks, start, end);
  const volts = shown.map((r) => [r.ts, r.battery_volts]);
  const vr = niceRange(volts.map((p) => p[1]), { step: 0.05, minSpan: 0.2 });
  const vs = statOf(volts);
  if (vr) {
    $("dr-svg").innerHTML = chartSvg({ start, end, ...vr, W: 600, H: 200, grid,
      hlines: [{ v: vs.avg, cls: "base" }, { v: RP_LOW_VOLTS, cls: "low" }], lines: [{ pts: volts, cls: "l-tan", gap }] });
    drawAxis($("dr-axis"), vr.lo, vr.hi, { n: 4, fmt: (v) => v.toFixed(2) });
    $("dr-volts-note").textContent = `AVG ${vs.avg.toFixed(2)} · LOW ${vs.min.toFixed(2)} · PEAK ${vs.max.toFixed(2)}`;
  }

  // Relayed per hour, from the change in the "sent" counter (a reboot resets it, so drops are skipped)
  const bars = [];
  for (let i = 1; i < shown.length; i++) {
    const a = shown[i - 1], b = shown[i], h = (b.ts - a.ts) / 3600, sent = b.packets_sent - a.packets_sent;
    if (h > 0 && h <= 6 && sent >= 0) bars.push({ t0: a.ts, t1: b.ts, v: sent / h, cls: "b-blue" });
  }
  const ph = Math.max(10, Math.ceil(Math.max(0, ...bars.map((b) => b.v)) / 10) * 10);
  $("dr-pk-svg").innerHTML = chartSvg({ start, end, lo: 0, hi: ph, bars, grid: grid.filter((g) => g.cls === "mid") });
  drawAxis($("dr-pk-axis"), 0, ph, { n: 2, fmt: (v) => Math.round(v) });

  const noise = shown.map((r) => [r.ts, r.noise_floor_dbm]);
  const nr = niceRange(noise.map((p) => p[1]), { step: 2, minSpan: 6 });
  if (nr) {
    $("dr-sig-svg").innerHTML = chartSvg({ start, end, ...nr, grid: grid.filter((g) => g.cls === "mid"), lines: [{ pts: noise, cls: "l-lavender", gap }] });
    drawAxis($("dr-sig-axis"), nr.lo, nr.hi, { n: 2, fmt: (v) => Math.round(v) });
  } else emptyChart($("dr-sig-svg"), "NO NOISE READINGS");
  const sigTitle = document.querySelector("#d-repeater .dr-cols .dv-col:last-child .sub-bar span");
  sigTitle.textContent = last.last_snr_db != null ? `NOISE FLOOR DBM · LAST SNR ${last.last_snr_db} · RSSI ${last.last_rssi_dbm}` : "NOISE FLOOR · DBM";

  // Each day's low-to-peak range on one shared scale: a solar day charges up, nights drain
  const days = lastDays(hours > 96 ? 14 : 7).map((dd) => {
    const v = rows.filter((r) => r.ts >= dd.a && r.ts < dd.b).map((r) => r.battery_volts);
    return { ...dd, known: v.length > 0, lo: v.length ? Math.min(...v) : 0, hi: v.length ? Math.max(...v) : 0 };
  });
  const known = days.filter((dd) => dd.known);
  const lo = Math.min(...known.map((dd) => dd.lo)) - 0.02, hi = Math.max(...known.map((dd) => dd.hi)) + 0.02;
  dayColumns($("dr-days"), days.map((dd) => ({ ...dd, parts: [{ from: dd.lo, v: dd.hi, cls: dd.lo < RP_LOW_VOLTS ? "lowv" : "volt" }] })),
    { min: lo, max: hi, fmt: (dd) => `+${(dd.hi - dd.lo).toFixed(2)}`, sub: (dd) => `${dd.lo.toFixed(2)}–${dd.hi.toFixed(2)}` });
}

// ---------- outside (weather) full-screen view ----------

const fmtClock = (ts) => { const d = new Date(ts * 1000); return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`; };
function renderWeatherDetail() {
  const entry = lastStatus.weather, w = entry && entry.data, x = detailData.weather;
  panelState($("d-weather"), entry);
  if (!w) return;
  $("dw-name").textContent = `OUTSIDE · ${w.label.toUpperCase()} · DETAIL`;
  $("dw-temp").innerHTML = deg(w.temp);
  const box = $("dw-aqi");
  box.className = "bignum aqi" + (w.aqi ? ` ${aqiClass(w.aqi.value)}` : "");
  box.textContent = w.aqi ? w.aqi.value : "—";
  $("dw-sky").textContent = w.sky;
  const c = (x && x.current) || {};
  $("dw-l1").innerHTML = `FEELS <b>${w.feels_like}°</b> · HUMIDITY <b>${w.humidity}%</b>${c.pressure_msl ? ` · <b>${Math.round(c.pressure_msl)}</b> HPA` : ""}`;
  $("dw-l2").innerHTML = `WIND <b>${w.wind}</b>${c.wind_gusts_10m != null ? ` · GUSTS <b>${Math.round(c.wind_gusts_10m)}</b>` : ""} ${w.wind_unit}${c.uv_index != null ? ` · UV <b>${c.uv_index.toFixed(0)}</b>` : ""}`;
  if (!x) { emptyChart($("dw-svg"), "LOADING FORECAST"); return; }
  const now = Date.now() / 1000;
  const todayStr = new Date().toLocaleDateString("en-CA");
  const today = x.days.find((d) => new Date(d.t * 1000).toLocaleDateString("en-CA") === todayStr) || x.days[1];
  $("dw-l3").innerHTML = today ? `SUNRISE <b>${fmtClock(today.sunrise)}</b> · SUNSET <b>${fmtClock(today.sunset)}</b> · UV MAX <b>${Math.round(today.uv || 0)}</b>` : "";

  // Temperature: the last day and the next two, or the coming week; chance of rain as bars along the bottom
  const hours = detailHours.weather;
  const h = x.hourly;
  const start = hours <= 48 ? now - 24 * 3600 : now - 6 * 3600;
  const end = hours <= 48 ? now + 48 * 3600 : h.t[h.t.length - 1];
  $("dw-chart-title").textContent = hours <= 48 ? "TEMPERATURE · PAST 24 HRS · NEXT 48 HRS" : "TEMPERATURE · NEXT 7 DAYS";
  const temp = h.t.map((t, i) => [t, h.temp[i]]), feels = h.t.map((t, i) => [t, h.feels[i]]);
  const inView = (p) => p[0] >= start - 3600 && p[0] <= end;
  const tr = niceRange([...temp, ...feels].filter(inView).map((p) => p[1]), { step: 5, pad: 0.05, minSpan: 10 });
  const rain = h.t.map((t, i) => ({ t0: t, t1: t + 3600, cls: "rainbar", top: 1 - (h.rain_pct[i] || 0) / 100 * 0.4, bottom: 1 }))
    .filter((b) => b.top < 1 && b.t1 > start && b.t0 < end);
  const { grid, ticks } = timeGrid(start, end);
  $("dw-svg").innerHTML = chartSvg({ start, end, ...tr, W: 600, H: 200, grid, bands: rain, marks: [{ t: now, cls: "now" }],
    lines: [{ pts: feels.filter(inView), cls: "l-dash-tan" }, { pts: temp.filter(inView), cls: "l-peach" }] });
  drawAxis($("dw-axis"), tr.lo, tr.hi, { n: 4, fmt: (v) => `${Math.round(v)}°` });
  drawTicks($("dw-ticks"), ticks, start, end);

  // Forecast cards from today on
  const upcoming = x.days.filter((d) => new Date(d.t * 1000).toLocaleDateString("en-CA") >= todayStr).slice(0, 7);
  $("dw-days").innerHTML = upcoming.map((d, i) => `
    <div class="dw-day">
      <div class="dw-dn">${i === 0 ? "TODAY" : new Date(d.t * 1000 + 43200000).toLocaleDateString([], { weekday: "short" }).toUpperCase()}</div>
      <div class="dw-hl"><span class="dw-hi">${d.high}°</span><span class="dw-lo">${d.low}°</span></div>
      <div class="dw-sky">${esc(d.sky)}</div>
      <div class="dw-rain${d.rain_pct >= 50 ? " wet" : ""}">${d.rain_pct ? `${d.rain_pct}%` : "—"}</div>
    </div>`).join("");

  // Air quality, past day and next day
  const a = x.air;
  if (a) {
    const aStart = now - 24 * 3600, aEnd = now + 24 * 3600;
    const aqi = a.t.map((t, i) => [t, a.aqi[i]]).filter((p) => p[0] >= aStart - 3600 && p[0] <= aEnd);
    const st = statOf(aqi);
    const ar = { lo: 0, hi: Math.max(60, Math.ceil(((st && st.max) || 0) * 1.15 / 10) * 10) };
    const g2 = timeGrid(aStart, aEnd);
    $("dw-aqi-svg").innerHTML = chartSvg({ start: aStart, end: aEnd, ...ar, grid: g2.grid.filter((g) => g.cls === "mid"),
      hlines: [{ v: 50, cls: "aqi-50" }, { v: 100, cls: "aqi-100" }], marks: [{ t: now, cls: "now" }], lines: [{ pts: aqi, cls: "l-lavender" }] });
    drawAxis($("dw-aqi-axis"), ar.lo, ar.hi, { n: 2, fmt: (v) => Math.round(v) });
    drawTicks($("dw-aqi-ticks"), g2.ticks, aStart, aEnd);
    const next = aqi.filter((p) => p[0] > now).map((p) => p[1]).filter((v) => v != null);
    $("dw-aqi-note").textContent = next.length ? `NEXT 24 HRS PEAK ${Math.round(Math.max(...next))}` : "";
  } else emptyChart($("dw-aqi-svg"), "NO AIR QUALITY DATA");
}

// ---------- indoor climate full-screen view ----------

const ROOM_LINES = ["l-peach", "l-blue", "l-tan", "l-lavender"];
function renderIndoorDetail() {
  const entry = lastStatus.indoor, d = entry && entry.data, x = detailData.indoor;
  panelState($("d-indoor"), entry);
  if (!d) return;
  $("di-rooms").innerHTML = d.rooms.map((r, i) => `
    <div class="cell"><div class="label">${esc(r.name.toUpperCase())}</div>
      <div class="bignum ${r.missing ? "c-dim" : ROOM_COLORS[i % ROOM_COLORS.length]}">${r.missing ? "—" : deg(r.temp)}</div></div>`).join("");
  const t = d.thermostat;
  if (t) {
    const action = t.mode === "OFF" ? "OFF" : (t.action || t.mode);
    $("di-action").textContent = action;
    $("di-action").className = `headline ${action.toLowerCase()}`;
    const set = t.target != null ? `${Math.round(t.target)}°` : t.target_low != null ? `${Math.round(t.target_low)}–${Math.round(t.target_high)}°` : "—";
    $("di-l1").innerHTML = `SET TO <b>${set}</b> · MODE <b>${esc(t.mode)}</b>`;
    $("di-l2").innerHTML = t.humidity != null ? `HUMIDITY <b>${Math.round(t.humidity)}%</b>` : "";
  }
  if (!x) { emptyChart($("di-svg"), "LOADING HISTORY"); return; }
  const now = Date.now() / 1000;
  const th = x.thermostat;   // [t, temp, humidity, action, target, low, high]
  const day0 = lastDays(1)[0];
  const heatToday = hoursIn(th, day0.a, now, (p) => p[3] === "heating"), coolToday = hoursIn(th, day0.a, now, (p) => p[3] === "cooling");
  $("di-l3").innerHTML = `TODAY: HEAT <b>${fmtDur(heatToday)}</b> · COOL <b>${fmtDur(coolToday)}</b>`;

  const hours = detailHours.indoor;
  const start = now - hours * 3600, end = now;
  const { grid, ticks } = timeGrid(start, end);
  drawTicks($("di-ticks"), ticks, start, end);
  // Each room's line reaches "now" with the live reading
  const rooms = x.rooms.map((r, i) => {
    const live = d.rooms.find((dr) => dr.name === r.name);
    return { ...r, pts: [...r.points, ...(live && live.temp != null ? [[now, live.temp]] : [])], cls: ROOM_LINES[i % ROOM_LINES.length] };
  });
  const setLines = [
    { pts: th.map((p) => [p[0], p[4]]), cls: "l-dash-tan", step: true },
    { pts: th.map((p) => [p[0], p[5]]), cls: "l-dash-orange", step: true },
    { pts: th.map((p) => [p[0], p[6]]), cls: "l-dash-blue", step: true },
  ];
  const visible = (pts) => pts.filter((p) => p[0] >= start - 3600);
  const tr = niceRange([...rooms.flatMap((r) => visible(r.pts)), ...setLines.flatMap((l) => visible(l.pts))].map((p) => p[1]), { step: 1, minSpan: 6 });
  const bands = [
    ...runsOf(th, (p) => p[3] === "heating").map((b) => ({ ...b, cls: "heat" })),
    ...runsOf(th, (p) => p[3] === "cooling").map((b) => ({ ...b, cls: "cool" })),
  ];
  if (tr) {
    $("di-svg").innerHTML = chartSvg({ start, end, ...tr, W: 600, H: 200, grid, bands,
      lines: [...setLines, ...rooms.map((r) => ({ pts: r.pts, cls: r.cls, step: true }))] });
    drawAxis($("di-axis"), tr.lo, tr.hi, { n: 4, fmt: (v) => `${Math.round(v)}°` });
  } else emptyChart($("di-svg"), "NO HISTORY YET");
  $("di-legend").innerHTML = rooms.map((r) => `<span class="kc-${r.cls.slice(2)}">━ ${esc(r.name)}</span>`).join("")
    + `<span class="k-target">┅ SET POINT</span><span class="k-heat">▮ HEATING</span><span class="k-cool">▮ COOLING</span>`;
  const rangeHeat = hoursIn(th, start, end, (p) => p[3] === "heating"), rangeCool = hoursIn(th, start, end, (p) => p[3] === "cooling");
  $("di-note").textContent = `HEAT ${rangeHeat.toFixed(1)} H · COOL ${rangeCool.toFixed(1)} H`;
  $("di-chart-title").textContent = `TEMPERATURE · ${hours === 24 ? "24 HRS" : `${hours / 24} DAYS`}`;

  const hum = th.map((p) => [p[0], p[2]]);
  const hr = niceRange(visible(hum).map((p) => p[1]), { step: 5, minSpan: 10 });
  if (hr) {
    $("di-hum-svg").innerHTML = chartSvg({ start, end, ...hr, grid: grid.filter((g) => g.cls === "mid"), lines: [{ pts: hum, cls: "l-blue", step: true }] });
    drawAxis($("di-hum-axis"), hr.lo, hr.hi, { n: 2, fmt: (v) => `${Math.round(v)}%` });
  } else emptyChart($("di-hum-svg"), "NO HUMIDITY READINGS");

  const first = th.length ? th[0][0] : now;
  const days = lastDays(7).map((dd) => {
    const heat = hoursIn(th, dd.a, Math.min(dd.b, now), (p) => p[3] === "heating");
    const cool = hoursIn(th, dd.a, Math.min(dd.b, now), (p) => p[3] === "cooling");
    return { ...dd, heat, cool, known: dd.b > first, parts: [{ v: heat, cls: "" }, { v: cool, cls: "cool" }] };
  });
  dayColumns($("di-days"), days, { max: Math.max(4, ...days.map((dd) => dd.heat + dd.cool)), fmt: (dd) => `${(dd.heat + dd.cool).toFixed(1)}H` });
}

// ---------- full-screen detail views (shared) ----------
// Tap a panel's title bar to open its detail view. BACK, or 60 seconds
// without a touch, goes back to the overview.

const configured = (key) => () => !!(lastStatus[key] && lastStatus[key].configured);
const DETAILS = {
  server: { panel: "d-sys", ready: configured("server"), render: () => renderSysDetail("server"), range: "sys", refetch: true },
  nas: { panel: "d-sys", ready: configured("nas"), render: () => renderSysDetail("nas"), range: "sys", refetch: true },
  mac: { panel: "d-sys", ready: configured("mac"), render: () => renderSysDetail("mac"), range: "sys", refetch: true },
  plex: { panel: "d-plex", ready: configured("plex"), render: renderPlexDetail },
  mesh: { panel: "d-mesh", ready: configured("mesh"), render: renderMeshDetail },
  repeater: { panel: "d-repeater", ready: configured("repeater"), render: renderRepeaterDetail, range: "repeater" },
  weather: { panel: "d-weather", ready: configured("weather"), render: renderWeatherDetail, range: "weather" },
  indoor: { panel: "d-indoor", ready: configured("indoor"), render: renderIndoorDetail, range: "indoor" },
  hottub: { panel: "d-hottub", ready: configured("hottub"), render: () => renderHotTubDetail(), range: "hottub" },
};
// Each view opens on its first range button
const DEFAULT_HOURS = { sys: 24, repeater: 96, weather: 48, indoor: 24, hottub: 24 };
const detailHours = { ...DEFAULT_HOURS };
let openKey = null;
const detailData = {};
let detailFetch = null;

function renderOpenDetail() {
  if (!openKey) return;
  const def = DETAILS[openKey];
  if (def.range) document.querySelectorAll(`.ranges[data-key="${def.range}"] button`)
    .forEach((b) => b.classList.toggle("on", +b.dataset.hours === detailHours[def.range]));
  try { def.render(); } catch (err) { console.error(`detail ${openKey} render failed:`, err); }
}

async function fetchDetail(key) {
  const def = DETAILS[key];
  try {
    const q = def.range ? `?hours=${detailHours[def.range]}` : "";
    const res = await fetch(`api/detail/${key}${q}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    detailData[key] = await res.json();
    if (openKey === key) renderOpenDetail();
  } catch (err) {
    console.warn(`detail ${key} fetch failed:`, err);
  }
}

function openDetail(key) {
  const def = DETAILS[key];
  if (!def || !def.ready()) return;
  openKey = key;
  lastTouch = Date.now();
  if (def.range) detailHours[def.range] = DEFAULT_HOURS[def.range];
  document.querySelectorAll(".details .detail").forEach((p) => p.classList.toggle("active", p.id === def.panel));
  document.querySelectorAll(".details .dv-scroll").forEach((el) => { el.scrollTop = 0; });
  $("details").hidden = false;
  document.body.classList.add("detail-open");
  renderOpenDetail();
  fetchDetail(key);
  clearInterval(detailFetch);
  detailFetch = setInterval(() => fetchDetail(key), 60000);
}

function closeDetail() {
  if (!openKey) return;
  openKey = null;
  clearInterval(detailFetch);
  $("details").hidden = true;
  document.body.classList.remove("detail-open");
}

function setupDetails() {
  // A tap on the title bar opens the view; it doesn't also count as a tap on the panel itself
  document.querySelectorAll(".panels .panel[data-detail]").forEach((panel) => {
    onTap(panel.querySelector(".panel-head"), (e) => {
      e.stopPropagation();
      if (!DETAILS[panel.dataset.detail].ready()) return;
      chirp();
      openDetail(panel.dataset.detail);
    });
  });
  document.querySelectorAll(".details .back").forEach((b) => b.addEventListener("click", () => { chirp(); closeDetail(); }));
  ["pointerdown", "wheel", "keydown", "touchmove"].forEach((ev) =>
    $("details").addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true }));
  document.querySelectorAll(".ranges[data-key] button").forEach((b) => b.addEventListener("click", () => {
    chirp();
    const range = b.parentElement.dataset.key;
    detailHours[range] = +b.dataset.hours;
    renderOpenDetail();
    if (openKey && DETAILS[openKey].refetch) fetchDetail(openKey);
  }));
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
    lastStatus = data;

    document.querySelectorAll(".sys").forEach((p) => renderSystem(p, data[p.dataset.key]));
    renderPlex(data.plex);
    renderMesh(data.mesh);
    renderWeather(data.weather);
    renderIndoor(data.indoor);
    renderRepeater(data.repeater);
    if (data.hottub) renderHotTub(data.hottub);

    renderOpenDetail();   // keep an open full-screen view live too

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
setupDetails();
onTap($("p-mesh"), () => { chirp(); swapMeshRepeater(); });
onTap($("p-repeater"), () => { chirp(); swapMeshRepeater(); });
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
