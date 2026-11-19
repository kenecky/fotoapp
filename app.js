'use strict';

/*
 * Hier & Jetzt – Fotos und Videos aufnehmen und mit Zeitstempel, GPS-Koordinaten,
 * Adresse und Notiz stempeln. Alles passiert im Browser, nichts wird auf einem Server gespeichert.
 * Für Adressen wird nur die Position an OpenStreetMap (Nominatim / Overpass) geschickt.
 */

const CONFIG = {
  jpegQuality: 0.92,
  gpsTimeoutMs: 8000,          // so lange wird beim Foto höchstens auf GPS gewartet
  maxPositionAgeMs: 30000,     // ältere Positionen gelten als veraltet
  addressTimeoutMs: 6000,
  addressReuseMeters: 30,      // ermittelte Adresse wiederverwenden, wenn so nah
  addressMinIntervalMs: 10000,
  nearbyRadiusMeters: 80,      // Umkreis für „Adressen in der Nähe“
  nearbyMax: 15,
  nearbyTimeoutMs: 12000,
  overrideResetMeters: 150,    // gewählte Adresse gilt, bis man sich so weit entfernt
  recentMax: 6,
  videoMaxSeconds: 120,
  videoFps: 30,
  videoBitsPerSecond: 5000000,
  audioBitsPerSecond: 128000,
  compareMaxSide: 4096,        // max. Kantenlänge des Vorher/Nachher-Bildes
};

const STORAGE = { addresses: 'hj.recentAddresses', notes: 'hj.recentNotes' };
const FONT = 'system-ui, Roboto, "Segoe UI", Arial, sans-serif';

const $ = (id) => document.getElementById(id);
const el = {
  viewStart: $('view-start'),
  viewCamera: $('view-camera'),
  viewBusy: $('view-busy'),
  viewResult: $('view-result'),
  btnOpenPhoto: $('btn-open-photo'),
  btnOpenVideo: $('btn-open-video'),
  btnOpenCompare: $('btn-open-compare'),
  beforeInput: $('before-input'),
  startGps: $('start-gps'),
  startDot: $('start-dot'),
  startAddr: $('start-addr'),
  btnBack: $('btn-back'),
  video: $('video'),
  ghost: $('ghost'),
  focusRing: $('focus-ring'),
  gpsChip: $('gps-chip'),
  addrBtn: $('addr-btn'),
  addrLine: $('addr-line'),
  noteChip: $('note-chip'),
  noteText: $('note-text'),
  btnTorch: $('btn-torch'),
  camMessage: $('cam-message'),
  compareBanner: $('compare-banner'),
  recInfo: $('rec-info'),
  recTime: $('rec-time'),
  zoomBar: $('zoom-bar'),
  btnDetails: $('btn-details'),
  shutter: $('btn-shutter'),
  btnGhost: $('btn-ghost'),
  ghostThumb: $('ghost-thumb'),
  sheet: $('sheet'),
  sheetClose: $('sheet-close'),
  addrList: $('addr-list'),
  addrStatus: $('addr-status'),
  manualRow: $('manual-row'),
  addrManual: $('addr-manual'),
  noteInput: $('note-input'),
  noteClear: $('note-clear'),
  noteRecent: $('note-recent'),
  sheetApply: $('sheet-apply'),
  busyText: $('busy-text'),
  resultTitle: $('result-title'),
  resultImg: $('result-img'),
  resultVideo: $('result-video'),
  btnDownload: $('btn-download'),
  btnShare: $('btn-share'),
  btnNew: $('btn-new'),
  btnHome: $('btn-home'),
  canvas: $('canvas'),
};

const state = {
  mode: 'photo',           // 'photo' | 'video' | 'compare'
  stream: null,
  cameraStarting: false,
  watchId: null,
  position: null,          // letzte GeolocationPosition
  gpsError: null,
  address: null,           // automatisch ermittelte Adresse { lat, lon, text, postcode, city }
  addressPending: null,
  lastAddressRequest: 0,
  addrOverride: null,      // gewählte Adresse { key, text, atLat, atLon }
  note: '',
  nearby: null,            // { lat, lon, items }
  torch: false,
  zoom: 1,
  zoomCaps: null,
  focusTimer: null,
  before: null,            // Vorher-Bild { bitmap, url, date }
  ghostOn: true,
  rec: null,               // laufende Videoaufnahme
  result: null,            // { blob, url, filename, kind }
};

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

function isVisible(view) {
  return !view.classList.contains('hidden');
}

function loadList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function pushRecent(key, item, same) {
  const list = loadList(key).filter((x) => !same(x, item));
  list.unshift(item);
  try { localStorage.setItem(key, JSON.stringify(list.slice(0, CONFIG.recentMax))); } catch (e) { /* egal */ }
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

const oneLine = (text) => (text || '').replace(/\n/g, ', ');

/* ------------------------------------------------------------------ */
/* Ansichten                                                           */
/* ------------------------------------------------------------------ */

const themeColorMeta = document.querySelector('meta[name="theme-color"]');

function show(view) {
  for (const v of [el.viewStart, el.viewCamera, el.viewBusy, el.viewResult]) {
    v.classList.toggle('hidden', v !== view);
  }
  // Statusleiste des Handys passend färben: Kamera dunkel, sonst hell
  if (themeColorMeta) themeColorMeta.content = view === el.viewCamera ? '#000000' : '#F4F7FA';
}

let messageTimer = null;
function showCameraMessage(text, ms) {
  clearTimeout(messageTimer);
  el.camMessage.textContent = text;
  el.camMessage.classList.toggle('hidden', !text);
  if (text && ms) messageTimer = setTimeout(() => showCameraMessage(''), ms);
}

/* ------------------------------------------------------------------ */
/* Kamera                                                              */
/* ------------------------------------------------------------------ */

async function startCamera() {
  if (state.stream || state.cameraStarting) return;
  if (!window.isSecureContext) {
    showCameraMessage('Die App muss über HTTPS geöffnet werden, sonst sind Kamera und GPS gesperrt.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraMessage('Dieser Browser unterstützt keinen Kamerazugriff. Bitte Chrome verwenden.');
    return;
  }

  const wantAudio = state.mode === 'video';
  const base = {
    facingMode: { ideal: 'environment' },
    // Foto: so hoch wie möglich. Video: Full HD, damit die Aufnahme flüssig bleibt.
    width: { ideal: wantAudio ? 1920 : 4096 },
    height: { ideal: wantAudio ? 1080 : 4096 },
  };
  // Erst mit Zoom-Unterstützung (und Ton bei Video) versuchen, dann schrittweise ohne
  const attempts = [];
  for (const audio of wantAudio ? [true, false] : [false]) {
    for (const zoom of [true, false]) attempts.push({ audio, zoom });
  }

  state.cameraStarting = true;
  let stream = null;
  let lastErr = null;
  for (const a of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: a.audio,
        video: a.zoom ? { ...base, zoom: true } : base,
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  state.cameraStarting = false;

  if (!stream) {
    console.error(lastErr);
    el.shutter.disabled = true;
    const name = lastErr && lastErr.name;
    if (name === 'NotAllowedError') {
      showCameraMessage('Kein Zugriff auf die Kamera. Bitte in den Chrome-Einstellungen Kamera (und für Videos Mikrofon) für diese Seite erlauben und neu laden.');
    } else if (name === 'NotFoundError') {
      showCameraMessage('Keine Kamera gefunden.');
    } else {
      showCameraMessage('Kamera konnte nicht gestartet werden: ' + (lastErr ? lastErr.message : ''));
    }
    return;
  }

  // Ansicht wurde inzwischen verlassen
  if (!isVisible(el.viewCamera)) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  state.stream = stream;
  el.video.srcObject = stream;
  await el.video.play().catch(() => {});
  el.shutter.disabled = false;
  if (wantAudio && !stream.getAudioTracks().length) {
    showCameraMessage('Mikrofon nicht verfügbar – Video wird ohne Ton aufgenommen.', 4000);
  } else {
    showCameraMessage('');
  }
  setupCameraControls();
  // Manche Handys melden Zoom/Taschenlampe erst nach kurzer Zeit
  setTimeout(setupCameraControls, 800);
}

function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  el.video.srcObject = null;
  el.shutter.disabled = true;
  state.torch = false;
  state.zoomCaps = null;
  el.btnTorch.classList.add('hidden');
  el.btnTorch.classList.remove('active');
  el.zoomBar.classList.add('hidden');
}

function videoTrack() {
  return state.stream ? state.stream.getVideoTracks()[0] : null;
}

function trackCaps() {
  const t = videoTrack();
  try { return t && t.getCapabilities ? t.getCapabilities() : {}; } catch (e) { return {}; }
}

/* ---------- Taschenlampe, Zoom, Fokus ---------- */

function setupCameraControls() {
  const t = videoTrack();
  if (!t) return;
  const caps = trackCaps();

  el.btnTorch.classList.toggle('hidden', !caps.torch);
  el.btnTorch.classList.toggle('active', state.torch);

  const z = caps.zoom;
  if (z && z.max > z.min) {
    const settings = t.getSettings ? t.getSettings() : {};
    state.zoomCaps = z;
    state.zoom = settings.zoom || Math.max(1, z.min);
    const presets = [];
    if (z.min < 0.95) presets.push(z.min);            // Weitwinkel, falls vorhanden
    for (const p of [1, 2, 4, 8]) if (p >= z.min && p <= z.max) presets.push(p);
    renderZoomBar(presets);
  } else {
    state.zoomCaps = null;
    el.zoomBar.classList.add('hidden');
  }
}

function formatZoom(z) {
  return String(Math.round(z * 10) / 10).replace('.', ',') + '×';
}

function renderZoomBar(presets) {
  el.zoomBar.innerHTML = '';
  for (const p of presets) {
    const b = document.createElement('button');
    b.className = 'zoom-btn';
    b.dataset.zoom = String(p);
    b.addEventListener('click', () => setZoom(p));
    el.zoomBar.appendChild(b);
  }
  el.zoomBar.classList.toggle('hidden', presets.length < 2);
  updateZoomUi();
}

function updateZoomUi() {
  const btns = [...el.zoomBar.children];
  let active = null;
  for (const b of btns) if (parseFloat(b.dataset.zoom) <= state.zoom + 0.05) active = b;
  for (const b of btns) {
    const z = parseFloat(b.dataset.zoom);
    b.classList.toggle('active', b === active);
    b.textContent = b === active && Math.abs(z - state.zoom) > 0.05 ? formatZoom(state.zoom) : formatZoom(z);
  }
}

let zoomFrame = null;
function setZoom(value) {
  const c = state.zoomCaps;
  if (!c || !videoTrack()) return;
  let z = Math.min(c.max, Math.max(c.min, value));
  if (c.step) z = Math.round(z / c.step) * c.step;
  state.zoom = z;
  updateZoomUi();
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = null;
    const t = videoTrack();
    if (t) t.applyConstraints({ advanced: [{ zoom: state.zoom }] }).catch(() => {});
  });
}

async function toggleTorch() {
  const t = videoTrack();
  if (!t) return;
  const on = !state.torch;
  try {
    await t.applyConstraints({ advanced: [{ torch: on }] });
    state.torch = on;
  } catch (e) {
    showCameraMessage('Taschenlampe ist bei dieser Kamera nicht verfügbar.', 3000);
  }
  el.btnTorch.classList.toggle('active', state.torch);
}

function focusAt(clientX, clientY) {
  const v = el.video;
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return;
  const r = v.getBoundingClientRect();
  const s = Math.min(r.width / vw, r.height / vh);
  const dw = vw * s;
  const dh = vh * s;
  const x = (clientX - r.left - (r.width - dw) / 2) / dw;
  const y = (clientY - r.top - (r.height - dh) / 2) / dh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  showFocusRing(clientX, clientY);
  const t = videoTrack();
  if (!t) return;
  const modes = trackCaps().focusMode || [];
  const c = { pointsOfInterest: [{ x, y }] };
  if (modes.includes('single-shot')) c.focusMode = 'single-shot';
  else if (modes.includes('continuous')) c.focusMode = 'continuous';
  t.applyConstraints({ advanced: [c] }).catch(() => {});

  // Nach ein paar Sekunden wieder automatisch scharfstellen
  clearTimeout(state.focusTimer);
  if (modes.includes('continuous')) {
    state.focusTimer = setTimeout(() => {
      const t2 = videoTrack();
      if (t2) t2.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }, 5000);
  }
}

function showFocusRing(x, y) {
  const f = el.focusRing;
  f.style.left = x + 'px';
  f.style.top = y + 'px';
  f.classList.remove('hidden', 'animate');
  void f.offsetWidth; // Animation neu starten
  f.classList.add('animate');
  clearTimeout(f.hideTimer);
  f.hideTimer = setTimeout(() => f.classList.add('hidden'), 900);
}

/* Gesten auf dem Kamerabild: Antippen = scharfstellen, zwei Finger = zoomen */
(function setupGestures() {
  const pointers = new Map();
  let pinch = null;
  let tap = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  el.video.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) tap = { x: e.clientX, y: e.clientY, t: Date.now() };
    if (pointers.size === 2) {
      tap = null;
      pinch = { d: spread(), z: state.zoom };
    }
  });
  el.video.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2 && state.zoomCaps && pinch.d > 0) setZoom(pinch.z * (spread() / pinch.d));
  });
  const end = (e) => {
    if (tap && pointers.size === 1 && e.type === 'pointerup') {
      const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
      if (moved < 12 && Date.now() - tap.t < 600) focusAt(e.clientX, e.clientY);
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) tap = null;
  };
  el.video.addEventListener('pointerup', end);
  el.video.addEventListener('pointercancel', end);
})();

/* ------------------------------------------------------------------ */
/* GPS                                                                 */
/* ------------------------------------------------------------------ */

function startGps() {
  if (state.watchId !== null) return;
  if (!('geolocation' in navigator)) {
    state.gpsError = 'GPS wird nicht unterstützt';
    updateGpsUi();
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.position = pos;
      state.gpsError = null;
      checkOverrideDistance(pos);
      updateGpsUi();
      prefetchAddress(pos);
    },
    (err) => {
      state.gpsError = err.code === err.PERMISSION_DENIED
        ? 'Standort nicht erlaubt'
        : 'Kein GPS-Signal';
      updateGpsUi();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
}

function stopGps() {
  if (state.watchId === null) return;
  navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}

function freshPosition() {
  const p = state.position;
  if (p && Date.now() - p.timestamp <= CONFIG.maxPositionAgeMs) return p;
  return null;
}

/** Eine gewählte Adresse gilt nur in der Nähe des Ortes, an dem sie gewählt wurde. */
function checkOverrideDistance(pos) {
  const o = state.addrOverride;
  if (!o) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  if (accuracy > 100) return;
  if (o.atLat == null) {
    o.atLat = lat;
    o.atLon = lon;
    return;
  }
  if (distanceMeters(o.atLat, o.atLon, lat, lon) > CONFIG.overrideResetMeters) {
    state.addrOverride = null;
    if (isVisible(el.viewCamera)) {
      showCameraMessage('Neuer Standort – die Adresse wird wieder automatisch per GPS ermittelt.', 4000);
    }
  }
}

/** Adresse, die gerade im Stempel landen würde (gewählt oder automatisch). */
function currentAddressText(pos) {
  if (state.addrOverride) return state.addrOverride.text;
  if (!pos) return null;
  const a = cachedAddressFor(pos.coords.latitude, pos.coords.longitude);
  return a ? a.text : null;
}

function updateGpsUi() {
  const p = freshPosition();
  let text, startText, level;
  if (p) {
    const acc = Math.round(p.coords.accuracy);
    text = `GPS ±${acc} m`;
    level = acc <= 20 ? 'good' : acc <= 100 ? 'medium' : 'bad';
    startText = (level === 'bad' ? 'GPS ungenau' : 'GPS bereit') + ` · ±${acc} m`;
  } else if (state.gpsError) {
    text = startText = state.gpsError;
    level = 'bad';
  } else {
    text = startText = 'GPS wird gesucht …';
    level = 'wait';
  }

  // Kamera
  el.gpsChip.textContent = text;
  el.gpsChip.className = 'chip chip-' + level;
  const camAddr = currentAddressText(p);
  el.addrLine.textContent = camAddr ? oneLine(camAddr) : (p ? 'Adresse wird ermittelt …' : 'Adresse wählen');
  el.addrBtn.classList.toggle('chosen', !!state.addrOverride);

  // Startseite
  let startAddr = state.address ? oneLine(state.address.text) : '';
  if (!startAddr && level === 'bad' && !p) startAddr = 'Fotos sind trotzdem möglich – ohne Standort im Stempel.';
  el.startGps.textContent = startText;
  el.startDot.className = 'gps-dot dot-' + level;
  el.startAddr.textContent = startAddr;
}

function updateNoteUi() {
  el.noteText.textContent = state.note;
  el.noteChip.classList.toggle('hidden', !state.note);
}

/** Wartet beim Foto kurz auf eine aktuelle Position, falls noch keine da ist. */
function getPositionForPhoto() {
  const p = freshPosition();
  if (p) return Promise.resolve(p);
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => { state.position = pos; resolve(pos); },
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: CONFIG.maxPositionAgeMs, timeout: CONFIG.gpsTimeoutMs },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Adresse automatisch (Nominatim)                                     */
/* ------------------------------------------------------------------ */

function cachedAddressFor(lat, lon) {
  const a = state.address;
  if (a && distanceMeters(a.lat, a.lon, lat, lon) <= CONFIG.addressReuseMeters) return a;
  return null;
}

function formatAddress(data) {
  const a = data.address || {};
  const street = a.road || a.pedestrian || a.footway || a.path || a.square || a.place || '';
  const line1 = [street, a.house_number].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.municipality || a.hamlet || '';
  const district = a.suburb || a.city_district || '';
  const line2 = [a.postcode, city].filter(Boolean).join(' ') +
    (district && district !== city ? ` (${district})` : '');
  const text = [line1, line2].filter(Boolean).join('\n') || data.display_name || '';
  return { text, postcode: a.postcode || '', city };
}

async function fetchAddress(lat, lon) {
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18' +
    `&accept-language=de&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.addressTimeoutMs);
  try {
    state.lastAddressRequest = Date.now();
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const f = formatAddress(await res.json());
    if (!f.text) return null;
    state.address = { lat, lon, ...f, time: Date.now() };
    updateGpsUi();
    return state.address;
  } catch (err) {
    console.warn('Adresse nicht ermittelbar:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Holt die Adresse schon vorab (und während eines Videos laufend nach). */
function prefetchAddress(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  if (accuracy > 200 || !navigator.onLine) return;
  if (cachedAddressFor(lat, lon) || state.addressPending) return;
  if (Date.now() - state.lastAddressRequest < CONFIG.addressMinIntervalMs) return;
  state.addressPending = fetchAddress(lat, lon).finally(() => { state.addressPending = null; });
}

async function getAddressForPhoto(pos) {
  if (state.addrOverride) return state.addrOverride.text;
  if (!pos) return null;
  const { latitude: lat, longitude: lon } = pos.coords;
  const cached = cachedAddressFor(lat, lon);
  if (cached) return cached.text;
  if (state.addressPending) {
    await state.addressPending;
    const again = cachedAddressFor(lat, lon);
    if (again) return again.text;
  }
  if (!navigator.onLine) return null;
  const fetched = await fetchAddress(lat, lon);
  return fetched ? fetched.text : null;
}

/* ------------------------------------------------------------------ */
/* Adressen in der Nähe (Overpass / OpenStreetMap)                     */
/* ------------------------------------------------------------------ */

async function fetchNearby(lat, lon) {
  const c = state.nearby;
  if (c && distanceMeters(c.lat, c.lon, lat, lon) < 25) return c.items;

  const q = `[out:json][timeout:10];nwr(around:${CONFIG.nearbyRadiusMeters},${lat.toFixed(6)},${lon.toFixed(6)})` +
    '["addr:housenumber"]["addr:street"];out center tags 100;';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.nearbyTimeoutMs);
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const auto = state.address || {};
    const byKey = new Map();
    for (const e of data.elements || []) {
      const t = e.tags || {};
      const la = e.lat != null ? e.lat : e.center && e.center.lat;
      const lo = e.lon != null ? e.lon : e.center && e.center.lon;
      if (la == null || lo == null) continue;
      const line1 = `${t['addr:street']} ${t['addr:housenumber']}`;
      const key = 'near:' + line1.toLowerCase();
      const dist = distanceMeters(lat, lon, la, lo);
      const prev = byKey.get(key);
      if (prev && prev.dist <= dist) continue;
      const line2 = [t['addr:postcode'] || auto.postcode, t['addr:city'] || auto.city].filter(Boolean).join(' ');
      byKey.set(key, { key, text: [line1, line2].filter(Boolean).join('\n'), line1, line2, dist });
    }
    const items = [...byKey.values()].sort((a, b) => a.dist - b.dist).slice(0, CONFIG.nearbyMax);
    state.nearby = { lat, lon, items };
    return items;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Auswahlfenster „Adresse & Notiz“                                    */
/* ------------------------------------------------------------------ */

const sheet = { selected: 'auto', options: new Map(), token: 0 };

const isSheetOpen = () => !el.sheet.classList.contains('hidden');

function openSheet() {
  if (state.rec || isSheetOpen()) return;
  history.pushState({ view: 'sheet' }, '');
  sheet.selected = state.addrOverride ? state.addrOverride.key : 'auto';
  el.addrManual.value = state.addrOverride && state.addrOverride.key === 'manual'
    ? oneLine(state.addrOverride.text) : '';
  el.noteInput.value = state.note;
  renderNoteRecent();
  renderAddrOptions([], 'loading');
  el.sheet.classList.remove('hidden');
  requestAnimationFrame(() => el.sheet.classList.add('open'));
  loadNearby();
}

function hideSheet() {
  el.sheet.classList.remove('open');
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  setTimeout(() => { if (!el.sheet.classList.contains('open')) el.sheet.classList.add('hidden'); }, 220);
}

function closeSheet() {
  if (history.state && history.state.view === 'sheet') history.back(); // popstate schließt das Fenster
  else hideSheet();
}

async function loadNearby() {
  const token = ++sheet.token;
  const pos = freshPosition();
  if (!pos) { renderAddrOptions([], 'nogps'); return; }
  if (!navigator.onLine) { renderAddrOptions([], 'offline'); return; }
  try {
    const items = await fetchNearby(pos.coords.latitude, pos.coords.longitude);
    if (token === sheet.token && isSheetOpen()) renderAddrOptions(items, 'ok');
  } catch (err) {
    console.warn('Adressen in der Nähe:', err);
    if (token === sheet.token && isSheetOpen()) renderAddrOptions([], 'error');
  }
}

function addrOption(key, title, sub, badge) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'addr-opt';
  b.dataset.key = key;
  b.innerHTML = '<span class="radio"></span><span class="addr-opt-text"><span class="addr-opt-title"></span>' +
    '<span class="addr-opt-sub"></span></span>';
  b.querySelector('.addr-opt-title').textContent = title;
  const subEl = b.querySelector('.addr-opt-sub');
  if (sub) subEl.textContent = sub; else subEl.remove();
  if (badge) {
    const s = document.createElement('span');
    s.className = 'addr-opt-badge';
    s.textContent = badge;
    b.appendChild(s);
  }
  b.addEventListener('click', () => {
    sheet.selected = key;
    updateSheetSelection();
  });
  return b;
}

function groupLabel(text) {
  const d = document.createElement('div');
  d.className = 'group-label';
  d.textContent = text;
  return d;
}

function renderAddrOptions(nearby, status) {
  const pos = freshPosition();
  const list = el.addrList;
  list.innerHTML = '';
  sheet.options.clear();

  // Automatisch per GPS
  const auto = pos ? cachedAddressFor(pos.coords.latitude, pos.coords.longitude) : null;
  list.appendChild(addrOption('auto', 'Automatisch (GPS)',
    auto ? oneLine(auto.text) : pos ? 'Adresse wird ermittelt …' : 'Kein GPS-Standort', 'GPS'));

  // In der Nähe
  if (nearby.length) {
    list.appendChild(groupLabel('In der Nähe'));
    for (const n of nearby) {
      sheet.options.set(n.key, n);
      list.appendChild(addrOption(n.key, n.line1, n.line2, formatDistance(n.dist)));
    }
  }

  // Zuletzt verwendet
  const shown = new Set(nearby.map((n) => n.text));
  const recent = loadList(STORAGE.addresses).filter((r) => r && r.text && !shown.has(r.text));
  if (recent.length) {
    list.appendChild(groupLabel('Zuletzt verwendet'));
    for (const r of recent) {
      const key = 'recent:' + r.text;
      const [line1, line2] = r.text.split('\n');
      const dist = pos && r.lat != null ? distanceMeters(pos.coords.latitude, pos.coords.longitude, r.lat, r.lon) : null;
      sheet.options.set(key, { key, text: r.text });
      list.appendChild(addrOption(key, line1, line2 || '', dist != null ? formatDistance(dist) : ''));
    }
  }

  // Eine früher gewählte Adresse, die gerade nicht in der Liste steht
  if (sheet.selected !== 'auto' && sheet.selected !== 'manual' && !sheet.options.has(sheet.selected)) {
    const o = state.addrOverride;
    if (o && o.key === sheet.selected) {
      sheet.options.set(o.key, { key: o.key, text: o.text });
      const [line1, line2] = o.text.split('\n');
      list.insertBefore(addrOption(o.key, line1, line2 || '', 'gewählt'), list.children[1] || null);
    } else {
      sheet.selected = 'auto';
    }
  }

  const messages = {
    loading: 'Adressen in der Nähe werden gesucht …',
    nogps: 'Ohne GPS-Standort keine Adressen in der Nähe. Bitte unten eine Adresse eingeben.',
    offline: 'Keine Internetverbindung – Adressen in der Nähe nicht verfügbar.',
    error: 'Adressen in der Nähe konnten nicht geladen werden.',
    ok: nearby.length ? '' : 'Keine weiteren Adressen in der Nähe gefunden.',
  };
  const msg = messages[status] || '';
  el.addrStatus.innerHTML = '';
  if (status === 'loading') {
    const sp = document.createElement('span');
    sp.className = 'mini-spinner';
    el.addrStatus.appendChild(sp);
  }
  el.addrStatus.appendChild(document.createTextNode(msg));
  el.addrStatus.classList.toggle('hidden', !msg);
  updateSheetSelection();
}

function updateSheetSelection() {
  for (const b of el.addrList.querySelectorAll('.addr-opt')) {
    b.classList.toggle('selected', b.dataset.key === sheet.selected);
  }
  el.manualRow.classList.toggle('selected', sheet.selected === 'manual');
}

function renderNoteRecent() {
  el.noteRecent.innerHTML = '';
  for (const n of loadList(STORAGE.notes)) {
    if (typeof n !== 'string' || !n) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'note-pill';
    b.textContent = n;
    b.addEventListener('click', () => { el.noteInput.value = n; });
    el.noteRecent.appendChild(b);
  }
}

function applySheet() {
  const pos = freshPosition();
  const at = pos
    ? { atLat: pos.coords.latitude, atLon: pos.coords.longitude }
    : { atLat: null, atLon: null };

  let o = null;
  if (sheet.selected === 'manual') {
    const t = el.addrManual.value.trim();
    if (t) o = { key: 'manual', text: t, ...at };
  } else if (sheet.selected !== 'auto') {
    const opt = sheet.options.get(sheet.selected);
    if (opt) o = { key: sheet.selected, text: opt.text, ...at };
  }
  state.addrOverride = o;
  if (o) {
    pushRecent(STORAGE.addresses, { text: o.text, lat: at.atLat, lon: at.atLon }, (a, b) => a.text === b.text);
  }

  state.note = el.noteInput.value.trim().slice(0, 80);
  if (state.note) pushRecent(STORAGE.notes, state.note, (a, b) => a === b);

  closeSheet();
  updateGpsUi();
  updateNoteUi();
}

/* ------------------------------------------------------------------ */
/* Stempel                                                             */
/* ------------------------------------------------------------------ */

function formatTimestamp(d) {
  const date = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  let zone = '';
  try {
    const part = new Intl.DateTimeFormat('de-DE', { timeZoneName: 'short' })
      .formatToParts(d).find((p) => p.type === 'timeZoneName');
    zone = part ? ' ' + part.value : '';
  } catch (e) { /* ohne Zeitzone */ }
  return `${date}  ${time}${zone}`;
}

function formatShortDate(d) {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fileTimestamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

/** Erste Adresszeile als Dateinamen-Teil, z. B. „Musterstrasse-12“. */
function slugify(text) {
  if (!text) return '';
  return text.split(/[\n,]/)[0]
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function makeFilename(prefix, date, address, ext) {
  const s = slugify(address);
  return `${prefix}_${fileTimestamp(date)}${s ? '_' + s : ''}.${ext}`;
}

function formatCoords(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'O' : 'W';
  return `${Math.abs(lat).toFixed(6)}° ${ns}, ${Math.abs(lon).toFixed(6)}° ${ew}  (±${Math.round(accuracy)} m)`;
}

/** Bricht einen Text so um, dass er in maxWidth passt. */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Zeichnet den Stempel (halbtransparenter Balken mit Text) auf eine eigene Fläche
 * in voller Bildbreite. Sie wird dann unten ins Foto bzw. in jedes Videobild gesetzt.
 * info: { timestamp, note, address, coords }
 */
function renderStamp(w, h, info, target) {
  const canvas = target || document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = Math.max(14, Math.round(Math.min(w, h) * 0.032));
  const lineHeight = Math.round(fontSize * 1.3);
  const pad = Math.round(fontSize * 0.8);
  const maxWidth = w - pad * 2;

  const rows = []; // [text, fett?, farbe]
  const add = (text, bold, color) => {
    ctx.font = `${bold ? 700 : 400} ${fontSize}px ${FONT}`;
    for (const l of wrapText(ctx, text, maxWidth)) rows.push([l, bold, color]);
  };

  add(info.timestamp, true, '#ffffff');
  if (info.note) add(info.note, true, '#7DD3FC');
  if (info.address) add(info.address, false, '#ffffff');
  if (info.coords) {
    if (!info.address) add('Adresse nicht verfügbar', false, '#ffd27a');
    add(info.coords, false, '#ffffff');
  } else if (info.address) {
    add('Kein GPS-Standort – Adresse manuell gewählt', false, '#ffb4ab');
  } else {
    add('Kein Standort verfügbar', true, '#ffb4ab');
  }

  const boxHeight = rows.length * lineHeight + pad * 2;
  canvas.width = w;
  canvas.height = boxHeight; // setzt auch den Zeichenzustand zurück
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, w, boxHeight);

  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = Math.round(fontSize * 0.15);
  let y = pad + Math.round((lineHeight - fontSize) / 2);
  for (const [text, bold, color] of rows) {
    ctx.font = `${bold ? 700 : 400} ${fontSize}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(text, pad, y);
    y += lineHeight;
  }
  return canvas;
}

function exifDescription(note, address) {
  return [note, oneLine(address)].filter(Boolean).join(' | ');
}

/* ------------------------------------------------------------------ */
/* Foto (auch Nachher-Foto beim Vorher/Nachher-Vergleich)              */
/* ------------------------------------------------------------------ */

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))),
      'image/jpeg', CONFIG.jpegQuality);
  });
}

async function takePhoto() {
  const video = el.video;
  if (!state.stream || !video.videoWidth) return;
  el.shutter.disabled = true;

  // 1. Bild sofort einfrieren (Zeitpunkt = Auslösen)
  const takenAt = new Date();
  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = el.canvas;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  const note = state.note;

  show(el.viewBusy);

  try {
    // 2. Position und Adresse
    el.busyText.textContent = freshPosition() ? 'Adresse wird ermittelt …' : 'Standort wird ermittelt …';
    const pos = await getPositionForPhoto();
    el.busyText.textContent = 'Adresse wird ermittelt …';
    const address = await getAddressForPhoto(pos);

    // 3. Stempel zeichnen
    el.busyText.textContent = 'Foto wird gespeichert …';
    const stamp = renderStamp(w, h, {
      timestamp: formatTimestamp(takenAt),
      note,
      address,
      coords: pos ? formatCoords(pos) : null,
    });
    ctx.drawImage(stamp, 0, h - stamp.height);

    // 4. Bei Vorher/Nachher beide Bilder zusammensetzen
    let out = canvas;
    let prefix = 'Foto';
    let kind = 'photo';
    if (state.mode === 'compare' && state.before) {
      el.busyText.textContent = 'Vorher/Nachher wird erstellt …';
      out = composeBeforeAfter(state.before, canvas);
      prefix = 'VorherNachher';
      kind = 'compare';
    }

    let blob = await canvasToBlob(out);
    try {
      blob = await Exif.insert(blob, { date: takenAt, pos, description: exifDescription(note, address) });
    } catch (e) {
      console.warn('EXIF konnte nicht geschrieben werden:', e);
    }

    stopCamera(); // Akku sparen, solange das Ergebnis angezeigt wird
    showResult(blob, makeFilename(prefix, takenAt, address, 'jpg'), kind);
  } catch (err) {
    console.error(err);
    alert('Fehler beim Erstellen des Fotos: ' + err.message);
    show(el.viewCamera);
    el.shutter.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Vorher / Nachher                                                    */
/* ------------------------------------------------------------------ */

function pickBeforeImage() {
  el.beforeInput.value = '';
  el.beforeInput.click();
}

async function onBeforePicked() {
  const file = el.beforeInput.files && el.beforeInput.files[0];
  if (!file) return;
  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      bitmap = await createImageBitmap(file);
    }
    let date = null;
    try { date = Exif.readDate(await file.slice(0, 256 * 1024).arrayBuffer()); } catch (e) { /* ohne Datum */ }

    clearBefore();
    const url = URL.createObjectURL(file);
    state.before = { bitmap, url, date };
    state.ghostOn = true;
    el.ghost.src = url;
    el.ghostThumb.src = url;

    if (isVisible(el.viewResult)) {
      clearResult();
      history.replaceState({ view: 'camera' }, '');
      enterCamera('compare');
    } else {
      openCamera('compare');
    }
  } catch (err) {
    console.error(err);
    alert('Das Bild konnte nicht geladen werden: ' + err.message);
  }
}

function clearBefore() {
  if (!state.before) return;
  try { state.before.bitmap.close(); } catch (e) { /* egal */ }
  URL.revokeObjectURL(state.before.url);
  state.before = null;
  el.ghost.removeAttribute('src');
  el.ghostThumb.removeAttribute('src');
}

function updateGhostUi() {
  const compare = state.mode === 'compare' && !!state.before;
  el.ghost.classList.toggle('hidden', !(compare && state.ghostOn));
  el.btnGhost.classList.toggle('hidden', !compare);
  el.btnGhost.classList.toggle('off', !state.ghostOn);
  el.compareBanner.classList.toggle('hidden', !compare);
  el.compareBanner.textContent = state.ghostOn
    ? 'Nachher-Foto · Vorher-Bild zum Ausrichten eingeblendet'
    : 'Nachher-Foto aufnehmen';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawBadge(ctx, x, y, base, label, sub, accent) {
  const fs = Math.max(16, Math.round(base * 0.075));
  const fs2 = Math.round(fs * 0.6);
  const pad = Math.round(fs * 0.6);
  const margin = Math.round(fs * 0.7);

  ctx.font = `800 ${fs}px ${FONT}`;
  let width = ctx.measureText(label).width;
  if (sub) {
    ctx.font = `600 ${fs2}px ${FONT}`;
    width = Math.max(width, ctx.measureText(sub).width);
  }
  const bw = width + pad * 2;
  const bh = fs + (sub ? fs2 * 1.3 : 0) + pad * 1.3;
  const bx = x + margin;
  const by = y + margin;

  if (accent) {
    const g = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
    g.addColorStop(0, '#10B981');
    g.addColorStop(1, '#0EA5E9');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  }
  roundRect(ctx, bx, by, bw, bh, Math.round(fs * 0.45));
  ctx.fill();

  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${fs}px ${FONT}`;
  ctx.fillText(label, bx + pad, by + pad * 0.65);
  if (sub) {
    ctx.font = `600 ${fs2}px ${FONT}`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText(sub, bx + pad, by + pad * 0.65 + fs * 1.15);
  }
}

/**
 * Setzt Vorher- und Nachher-Bild zusammen.
 * Hochformat: nebeneinander, Querformat: untereinander.
 */
function composeBeforeAfter(before, after) {
  const aw = after.width;
  const ah = after.height;
  const sideBySide = ah >= aw;
  const gap0 = Math.round(Math.min(aw, ah) * 0.012);
  const W0 = sideBySide ? aw * 2 + gap0 : aw;
  const H0 = sideBySide ? ah : ah * 2 + gap0;
  const scale = Math.min(1, CONFIG.compareMaxSide / Math.max(W0, H0));

  const cw = Math.round(aw * scale);
  const ch = Math.round(ah * scale);
  const gap = Math.max(2, Math.round(gap0 * scale));
  const W = sideBySide ? cw * 2 + gap : cw;
  const H = sideBySide ? ch : ch * 2 + gap;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const [bx, by] = [0, 0];
  const [ax, ay] = sideBySide ? [cw + gap, 0] : [0, ch + gap];

  // Vorher: vollständig eingepasst (nichts abschneiden – es kann schon einen Stempel haben)
  ctx.fillStyle = '#111111';
  ctx.fillRect(bx, by, cw, ch);
  const b = before.bitmap;
  const s = Math.min(cw / b.width, ch / b.height);
  const dw = b.width * s;
  const dh = b.height * s;
  ctx.drawImage(b, bx + (cw - dw) / 2, by + (ch - dh) / 2, dw, dh);

  // Nachher: mit Stempel
  ctx.drawImage(after, ax, ay, cw, ch);

  const base = Math.min(cw, ch);
  drawBadge(ctx, bx, by, base, 'VORHER', before.date ? 'Aufnahme ' + formatShortDate(before.date) : null, false);
  drawBadge(ctx, ax, ay, base, 'NACHHER', null, true);
  return c;
}

/* ------------------------------------------------------------------ */
/* Video                                                               */
/* ------------------------------------------------------------------ */

function pickVideoMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (!window.MediaRecorder) return null;
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/** Stempel-Daten für den aktuellen Moment eines Videos. */
function liveStampInfo(now) {
  const pos = freshPosition();
  return {
    timestamp: formatTimestamp(now),
    note: state.note,
    address: currentAddressText(pos),
    coords: pos ? formatCoords(pos) : null,
  };
}

function formatDuration(sec) {
  return `${pad2(Math.floor(sec / 60))}:${pad2(Math.floor(sec % 60))}`;
}

function setRecordingUi(on) {
  el.viewCamera.classList.toggle('recording', on);
  el.recInfo.classList.toggle('hidden', !on);
  el.btnBack.disabled = on;
  el.btnDetails.disabled = on;
  el.addrBtn.disabled = on;
  el.noteChip.disabled = on;
}

async function startRecording() {
  const video = el.video;
  if (!state.stream || !video.videoWidth || state.rec) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    alert('Dieser Browser kann keine Videos aufnehmen. Bitte Chrome aktualisieren.');
    return;
  }

  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = el.canvas;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const rec = {
    startedAt: new Date(),
    address: currentAddressText(freshPosition()),
    stampCanvas: document.createElement('canvas'),
    stampKey: '',
    chunks: [],
    recorder: null,
    timer: null,
    wakeLock: null,
    stopping: false,
  };

  // Bildschleife: Kamerabild + Stempel in das Canvas zeichnen
  const drawFrame = () => {
    if (state.rec !== rec || rec.stopping) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      // Falls das Handy während der Aufnahme gedreht wird: Bild einpassen
      const scale = Math.min(w / vw, h / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      if (dw < w || dh < h) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    const info = liveStampInfo(new Date());
    const key = [info.timestamp, info.note, info.address, info.coords].join('|');
    if (key !== rec.stampKey) {
      renderStamp(w, h, info, rec.stampCanvas);
      rec.stampKey = key;
    }
    ctx.drawImage(rec.stampCanvas, 0, h - rec.stampCanvas.height);
    scheduleFrame();
  };
  const scheduleFrame = () => {
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(drawFrame);
    else requestAnimationFrame(drawFrame);
  };

  state.rec = rec;
  drawFrame();

  // Aufnahme-Stream: Canvas-Bild + Mikrofon-Ton
  const out = canvas.captureStream(CONFIG.videoFps);
  for (const t of state.stream.getAudioTracks()) out.addTrack(t);

  const mimeType = pickVideoMimeType();
  try {
    rec.recorder = new MediaRecorder(out, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: CONFIG.videoBitsPerSecond,
      audioBitsPerSecond: CONFIG.audioBitsPerSecond,
    });
  } catch (err) {
    console.error(err);
    state.rec = null;
    alert('Videoaufnahme konnte nicht gestartet werden: ' + err.message);
    return;
  }

  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = () => finishRecording(rec);
  rec.recorder.start(1000);

  // Bildschirm während der Aufnahme anlassen
  try {
    if (navigator.wakeLock) rec.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* nicht schlimm */ }

  setRecordingUi(true);
  const tick = () => {
    const sec = (Date.now() - rec.startedAt.getTime()) / 1000;
    el.recTime.textContent = `${formatDuration(sec)} / ${formatDuration(CONFIG.videoMaxSeconds)}`;
    if (sec >= CONFIG.videoMaxSeconds) stopRecording();
  };
  tick();
  rec.timer = setInterval(tick, 250);
}

function stopRecording() {
  const rec = state.rec;
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  clearInterval(rec.timer);
  setRecordingUi(false);
  if (rec.wakeLock) rec.wakeLock.release().catch(() => {});
  el.busyText.textContent = 'Video wird gespeichert …';
  show(el.viewBusy);
  if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  else finishRecording(rec);
}

function finishRecording(rec) {
  if (state.rec !== rec) return;
  state.rec = null;
  stopCamera();
  if (!rec.chunks.length) {
    alert('Das Video ist leer und konnte nicht gespeichert werden.');
    showStart();
    return;
  }
  const type = (rec.recorder && rec.recorder.mimeType) || rec.chunks[0].type || 'video/webm';
  const blob = new Blob(rec.chunks, { type: type.split(';')[0] });
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  showResult(blob, makeFilename('Video', rec.startedAt, rec.address, ext), 'video');
}

/* ------------------------------------------------------------------ */
/* Ergebnis: anzeigen, herunterladen, teilen                           */
/* ------------------------------------------------------------------ */

const RESULT_TEXT = {
  photo: { title: 'Foto erstellt', again: 'Neues Foto' },
  video: { title: 'Video erstellt', again: 'Neues Video' },
  compare: { title: 'Vorher/Nachher erstellt', again: 'Neues Vorher/Nachher' },
};

function showResult(blob, filename, kind) {
  clearResult();
  const url = URL.createObjectURL(blob);
  state.result = { blob, url, filename, kind };
  const isVideo = kind === 'video';
  el.resultImg.classList.toggle('hidden', isVideo);
  el.resultVideo.classList.toggle('hidden', !isVideo);
  if (isVideo) el.resultVideo.src = url;
  else el.resultImg.src = url;
  el.resultTitle.textContent = RESULT_TEXT[kind].title;
  el.btnNew.textContent = RESULT_TEXT[kind].again;

  const file = new File([blob], filename, { type: blob.type });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  el.btnShare.classList.toggle('hidden', !canShare);

  history.replaceState({ view: 'result' }, '');
  show(el.viewResult);
}

function clearResult() {
  if (state.result) URL.revokeObjectURL(state.result.url);
  state.result = null;
  el.resultImg.removeAttribute('src');
  el.resultVideo.pause();
  el.resultVideo.removeAttribute('src');
  el.resultVideo.load();
}

function downloadResult() {
  if (!state.result) return;
  const a = document.createElement('a');
  a.href = state.result.url;
  a.download = state.result.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function shareResult() {
  if (!state.result) return;
  const { blob, filename } = state.result;
  const file = new File([blob], filename, { type: blob.type });
  try {
    await navigator.share({ files: [file], title: filename });
  } catch (err) {
    if (err.name !== 'AbortError') alert('Teilen nicht möglich: ' + err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Navigation (Startseite <-> Kamera, inkl. Android-Zurück-Taste)       */
/* ------------------------------------------------------------------ */

function enterCamera(mode) {
  if (state.mode !== mode && (state.mode === 'video' || mode === 'video')) stopCamera(); // Video braucht das Mikrofon
  state.mode = mode;
  el.viewCamera.classList.toggle('mode-video', mode === 'video');
  el.shutter.setAttribute('aria-label', mode === 'video' ? 'Aufnahme starten/stoppen' : 'Foto aufnehmen');
  showCameraMessage('');
  updateGhostUi();
  updateGpsUi();
  updateNoteUi();
  show(el.viewCamera);
  startCamera();
}

function openCamera(mode) {
  history.pushState({ view: 'camera' }, '');
  enterCamera(mode);
}

function newShot() {
  const kind = state.result ? state.result.kind : state.mode;
  if (kind === 'compare') {
    pickBeforeImage(); // neues Vorher-Bild wählen, danach geht es weiter
    return;
  }
  clearResult();
  history.replaceState({ view: 'camera' }, '');
  enterCamera(kind);
}

function showStart() {
  if (isSheetOpen()) hideSheet();
  stopCamera();
  clearResult();
  clearBefore();
  show(el.viewStart);
}

// Zurück (Button oder Android-Zurück-Taste) führt immer zur Startseite
function goBack() {
  if (history.state && history.state.view !== 'start') history.back();
  else showStart();
}

window.addEventListener('popstate', () => {
  if (isSheetOpen()) {
    hideSheet();
    return;
  }
  if (state.rec || isVisible(el.viewBusy)) {
    // Während Aufnahme/Verarbeitung nicht wegnavigieren; laufende Aufnahme wird beendet und gespeichert
    history.pushState({ view: 'camera' }, '');
    stopRecording();
    return;
  }
  showStart();
});

function onShutter() {
  if (state.mode === 'video') {
    if (state.rec) stopRecording();
    else startRecording();
  } else {
    takePhoto();
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

// Fehler auf der Startseite anzeigen, damit man sie am Handy sieht
function showStartError(msg) {
  const box = document.getElementById('start-error');
  if (!box) return;
  box.textContent = 'Fehler: ' + msg;
  box.classList.remove('hidden');
}
window.addEventListener('error', (e) => showStartError(e.message));
window.addEventListener('unhandledrejection', (e) => showStartError(String(e.reason && e.reason.message || e.reason)));

// GPS läuft schon auf der Startseite, damit beim Auslösen sofort ein Standort da ist
startGps();

function on(element, handler, event = 'click') {
  if (element) element.addEventListener(event, handler);
  else showStartError('Seite unvollständig geladen – bitte App schließen und neu öffnen.');
}
on(el.btnOpenPhoto, () => openCamera('photo'));
on(el.btnOpenVideo, () => openCamera('video'));
on(el.btnOpenCompare, pickBeforeImage);
on(el.beforeInput, onBeforePicked, 'change');
on(el.btnBack, goBack);
on(el.btnHome, goBack);
on(el.shutter, onShutter);
on(el.btnTorch, toggleTorch);
on(el.btnDetails, openSheet);
on(el.addrBtn, openSheet);
on(el.noteChip, openSheet);
on(el.btnGhost, () => { state.ghostOn = !state.ghostOn; updateGhostUi(); });
on(el.sheetClose, closeSheet);
on(el.sheetApply, applySheet);
on(el.sheet, (e) => { if (e.target === el.sheet) closeSheet(); }); // Tippen neben das Fenster
on(el.addrManual, () => {
  sheet.selected = el.addrManual.value.trim() ? 'manual' : 'auto';
  updateSheetSelection();
}, 'input');
on(el.addrManual, () => { if (el.addrManual.value.trim()) { sheet.selected = 'manual'; updateSheetSelection(); } }, 'focus');
on(el.noteClear, () => { el.noteInput.value = ''; el.noteInput.focus(); });
on(el.btnDownload, downloadResult);
on(el.btnShare, shareResult);
on(el.btnNew, newShot);
history.replaceState({ view: 'start' }, '');

// Kamera und GPS pausieren, wenn die App im Hintergrund ist.
// Eine laufende Videoaufnahme wird dabei beendet und gespeichert.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.rec) stopRecording();
    else stopCamera();
    stopGps();
  } else {
    startGps();
    if (isVisible(el.viewCamera)) startCamera();
  }
});

// Anzeige regelmäßig aktualisieren (z. B. wenn die Position veraltet)
setInterval(updateGpsUi, 5000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
  });
}
