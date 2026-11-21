'use strict';

/*
 * Proofshot – Fotos und Videos aufnehmen und mit Zeitstempel, GPS-Koordinaten,
 * Adresse, Notiz und Firmenlogo stempeln. Alles passiert im Browser, nichts wird online gespeichert.
 * Für Adressen wird nur die Position an OpenStreetMap (Nominatim / Overpass) geschickt,
 * für den Zeitabgleich wird die Uhrzeit des Webservers abgefragt.
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
  selectMaxAccuracy: 100,      // Adresse wählen nur bei GPS-Genauigkeit bis ±100 m
  overrideResetMeters: 150,    // gewählte Adresse gilt, bis man sich so weit entfernt
  recentMax: 6,
  videoMaxSeconds: 120,
  videoFps: 30,
  videoBitsPerSecond: 5000000,
  audioBitsPerSecond: 128000,
  compareMaxSide: 4096,        // max. Kantenlänge des Vorher/Nachher-Bildes
  pdfImageMaxSide: 1000,       // Bildgröße im PDF-Bericht
  timeSyncMaxAgeMs: 15 * 60 * 1000,  // so lange gilt ein Zeitabgleich
  timeSyncIntervalMs: 5 * 60 * 1000,
  timeWarnDiffMs: 60 * 1000,   // ab dieser Abweichung der Handyuhr wird gewarnt
  companyLogoUrl: 'branding/firmenlogo.png', // Firmenlogo im Stempel und im PDF
};

const STORAGE = {
  addresses: 'hj.recentAddresses',
  notes: 'hj.recentNotes',
};
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
  timeDot: $('time-dot'),
  timeTitle: $('time-title'),
  timeSub: $('time-sub'),
  startVersion: $('start-version'),
  btnBack: $('btn-back'),
  video: $('video'),
  ghost: $('ghost'),
  focusRing: $('focus-ring'),
  flash: $('flash'),
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
  shotMode: $('shot-mode'),
  btnDetails: $('btn-details'),
  shutter: $('btn-shutter'),
  btnGhost: $('btn-ghost'),
  ghostThumb: $('ghost-thumb'),
  btnSeries: $('btn-series'),
  seriesThumb: $('series-thumb'),
  seriesCount: $('series-count'),
  sheet: $('sheet'),
  sheetPanel: $('sheet-panel'),
  sheetGrab: $('sheet-grab'),
  sheetClose: $('sheet-close'),
  addrList: $('addr-list'),
  addrStatus: $('addr-status'),
  noteInput: $('note-input'),
  noteClear: $('note-clear'),
  noteRecent: $('note-recent'),
  sheetApply: $('sheet-apply'),
  busyText: $('busy-text'),
  resultTitle: $('result-title'),
  resultSingle: $('result-single'),
  resultGrid: $('result-grid'),
  resultImg: $('result-img'),
  resultVideo: $('result-video'),
  btnDownload: $('btn-download'),
  downloadLabel: $('download-label'),
  btnShare: $('btn-share'),
  btnPdf: $('btn-pdf'),
  btnZip: $('btn-zip'),
  btnNew: $('btn-new'),
  btnHome: $('btn-home'),
  canvas: $('canvas'),
  viewer: $('viewer'),
  viewerImg: $('viewer-img'),
  viewerClose: $('viewer-close'),
  viewerHint: $('viewer-hint'),
  viewerPrev: $('viewer-prev'),
  viewerNext: $('viewer-next'),
  viewerCount: $('viewer-count'),
  zoomHint: $('zoom-hint'),
  btnHistory: $('btn-history'),
  btnSettings: $('btn-settings'),
  nameRow: $('name-row'),
  settings: $('settings'),
  settingsPanel: $('settings-panel'),
  settingsGrab: $('settings-grab'),
  settingsClose: $('settings-close'),
  settingsName: $('settings-name'),
  settingsStorage: $('settings-storage'),
  settingsClear: $('settings-clear'),
  settingsSave: $('settings-save'),
  viewHistory: $('view-history'),
  historyBack: $('history-back'),
  historyList: $('history-list'),
  viewerEdit: $('viewer-edit'),
  btnAnnotate: $('btn-annotate'),
  dialogInput: $('dialog-input'),
  dialogIcon: $('dialog-icon'),
  dialogIconPath: $('dialog-icon-path'),
  dialog: $('dialog'),
  dialogTitle: $('dialog-title'),
  dialogText: $('dialog-text'),
  dialogOk: $('dialog-ok'),
  dialogCancel: $('dialog-cancel'),
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
  addrOverride: null,      // gewählte Adresse aus der Umgebung { key, text, atLat, atLon }
  note: '',
  nearby: null,            // { lat, lon, items }
  torch: false,
  zoom: 1,
  zoomCaps: null,
  pendingZoom: null,
  mainPresets: [],
  lenses: null,            // { main, wide, labels }
  lens: 'main',            // 'main' | 'wide'
  focusTimer: null,
  before: null,            // Vorher-Bild { bitmap, url, date }
  ghostOn: true,
  seriesMode: false,
  series: [],              // Fotos der laufenden Serie
  seriesPending: 0,
  seriesNo: 0,
  seriesEntryId: null,      // Eintrag der laufenden Serie im Verlauf
  controlsTrack: null,
  seriesQueue: Promise.resolve(),
  seriesSaved: true,
  rec: null,               // laufende Videoaufnahme
  shown: null,             // angezeigtes Ergebnis { kind, items }
};

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isVisible(view) {
  return !view.classList.contains('hidden');
}

function loadList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* egal */ }
}

function pushRecent(key, item, same) {
  const list = loadList(key).filter((x) => !same(x, item));
  list.unshift(item);
  saveList(key, list.slice(0, CONFIG.recentMax));
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
/* Einstellungen                                                       */
/* ------------------------------------------------------------------ */

const settings = { name: '' };
try { settings.name = localStorage.getItem('hj.name') || ''; } catch (e) { /* egal */ }

/* Verlaufseinträge, die die App selbst entfernt, sollen kein „Zurück“ auslösen */
let skipPop = 0;
function popEntry(view) {
  if (history.state && history.state.view === view) {
    skipPop++;
    history.back();
  }
}

/* ------------------------------------------------------------------ */
/* Firmenlogo                                                          */
/* ------------------------------------------------------------------ */

const companyLogo = new Image();
let companyLogoReady = false;
companyLogo.onload = () => { companyLogoReady = companyLogo.naturalWidth > 0; };
companyLogo.src = CONFIG.companyLogoUrl;

/* ------------------------------------------------------------------ */
/* Zeitabgleich mit dem Internet                                       */
/* ------------------------------------------------------------------ */

/*
 * Die Uhrzeit wird aus dem „Date“-Kopf der Antwort des Webservers gelesen.
 * Danach läuft die geprüfte Zeit über die interne, nicht verstellbare Uhr des
 * Browsers (performance.now) weiter. Ein Verstellen der Handyuhr ändert sie nicht.
 */
const timeSync = {
  serverAt: null,   // geprüfte Zeit (ms) zum Zeitpunkt perfAt
  perfAt: null,
  deviceDiff: 0,    // Handyuhr minus geprüfte Zeit
  stale: false,     // nach Ruhezustand bis zum nächsten Abgleich ungültig
  pending: null,
  failed: false,
};

function syncTime() {
  if (timeSync.pending) return timeSync.pending;
  timeSync.pending = (async () => {
    try {
      const t0 = performance.now();
      const res = await fetch('./?zeit=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
      const t1 = performance.now();
      const header = res.headers.get('Date');
      const server = header ? Date.parse(header) : NaN;
      if (!isFinite(server)) throw new Error('keine Serverzeit');
      // Der Date-Kopf ist auf Sekunden gekürzt (+0,5 s) und kommt nach etwa der halben Laufzeit an
      const serverNow = server + 500 + (t1 - t0) / 2;
      timeSync.serverAt = serverNow;
      timeSync.perfAt = t1;
      timeSync.deviceDiff = Date.now() - serverNow;
      timeSync.stale = false;
      timeSync.failed = false;
    } catch (err) {
      console.warn('Zeitabgleich nicht möglich:', err);
      timeSync.failed = true;
    } finally {
      timeSync.pending = null;
      updateTimeUi();
    }
  })();
  return timeSync.pending;
}

function timeVerified() {
  return timeSync.perfAt != null && !timeSync.stale &&
    performance.now() - timeSync.perfAt < CONFIG.timeSyncMaxAgeMs;
}

/** Geprüfte Zeit zu einem performance.now()-Zeitpunkt (oder Handyzeit, falls nicht geprüft). */
function trustedTime(perf = performance.now(), deviceMs = Date.now()) {
  if (timeVerified()) return { date: new Date(timeSync.serverAt + (perf - timeSync.perfAt)), verified: true };
  return { date: new Date(deviceMs), verified: false };
}

/** Vor einem Foto kurz abgleichen, falls der letzte Abgleich etwas her ist. */
async function ensureTimeSync() {
  const age = timeSync.perfAt == null ? Infinity : performance.now() - timeSync.perfAt;
  if (timeVerified() && age < CONFIG.timeSyncIntervalMs) return;
  if (!navigator.onLine) return;
  await Promise.race([syncTime(), sleep(2500)]);
}

function updateTimeUi() {
  let level, title, sub;
  if (timeVerified()) {
    const diff = Math.round(timeSync.deviceDiff / 1000);
    level = 'good';
    title = 'Uhrzeit geprüft';
    if (Math.abs(timeSync.deviceDiff) >= CONFIG.timeWarnDiffMs) {
      level = 'medium';
      const min = Math.round(Math.abs(diff) / 60);
      sub = `Handyuhr geht ${min >= 1 ? min + ' Min.' : Math.abs(diff) + ' Sek.'} ${diff > 0 ? 'vor' : 'nach'} – der Stempel nutzt die Internetzeit.`;
    } else {
      sub = 'Mit Internetzeit abgeglichen' + (Math.abs(diff) >= 2 ? ` (Handyuhr ${diff > 0 ? '+' : ''}${diff} s)` : '');
    }
  } else if (timeSync.pending && !timeSync.failed) {
    level = 'wait';
    title = 'Uhrzeit wird geprüft …';
    sub = '';
  } else {
    level = 'bad';
    title = 'Uhrzeit nicht geprüft';
    sub = 'Kein Internet – der Stempel nutzt die Handyuhr.';
  }
  el.timeDot.className = 'gps-dot dot-' + level;
  el.timeTitle.textContent = title;
  el.timeSub.textContent = sub;
}

/* ------------------------------------------------------------------ */
/* Ansichten                                                           */
/* ------------------------------------------------------------------ */

const themeColorMeta = document.querySelector('meta[name="theme-color"]');

function show(view) {
  for (const v of [el.viewStart, el.viewHistory, el.viewCamera, el.viewBusy, el.viewResult]) {
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
  const useWide = state.lens === 'wide' && state.lenses && state.lenses.wide;
  const base = {
    ...(useWide ? { deviceId: { exact: state.lenses.wide } } : { facingMode: { ideal: 'environment' } }),
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
    if (useWide) {
      // Weitwinkel lässt sich nicht öffnen: zurück zur Hauptkamera
      state.lens = 'main';
      if (state.lenses) state.lenses.wide = null;
      showCameraMessage('Weitwinkel-Kamera nicht verfügbar.', 3000);
      startCamera();
      return;
    }
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
  } else if (!el.camMessage.textContent.startsWith('Weitwinkel')) {
    showCameraMessage('');
  }
  await detectLenses();
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

/* ---------- Weitwinkel (eigene Rückkamera, z. B. Samsung 0,6×) ---------- */

/*
 * Chrome zeigt Ultraweitwinkel-Objektive auf vielen Android-Handys (z. B. Samsung)
 * nicht als Zoomstufe, sondern als eigene Rückkamera („camera2 2, facing back“).
 * Die Hauptkamera ist die, die Chrome für „Rückseite“ automatisch wählt.
 */
async function detectLenses() {
  if (state.lenses || state.lens !== 'main') return;
  const t = videoTrack();
  if (!t || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const mainId = (t.getSettings && t.getSettings().deviceId) || '';
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const backs = devices.filter((d) => /back|rück|rear|environment/i.test(d.label));
    const num = (label) => {
      const m = label.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 999;
    };
    const others = backs.filter((d) => d.deviceId && d.deviceId !== mainId)
      .sort((a, b) => num(a.label) - num(b.label));
    state.lenses = {
      main: mainId,
      wide: others.length ? others[0].deviceId : null,
      labels: devices.map((d) => (d.deviceId === mainId ? '★ ' : '') + (d.label || '(ohne Namen)')),
    };
  } catch (e) {
    console.warn('Kameras nicht ermittelbar:', e);
  }
}

function switchLens(lens, zoomAfter) {
  if (state.rec || state.lens === lens) {
    if (zoomAfter != null) setZoom(zoomAfter);
    return;
  }
  state.lens = lens;
  state.pendingZoom = zoomAfter != null ? zoomAfter : null;
  stopCamera();
  startCamera();
}

/* ---------- Taschenlampe, Zoom, Fokus ---------- */

function setupCameraControls() {
  const t = videoTrack();
  if (!t) return;
  const caps = trackCaps();

  el.btnTorch.classList.toggle('hidden', !caps.torch);
  el.btnTorch.classList.toggle('active', state.torch);

  if (state.lens === 'main') {
    const z = caps.zoom;
    if (z && z.max > z.min) {
      const settings = t.getSettings ? t.getSettings() : {};
      if (state.controlsTrack !== t) state.zoom = settings.zoom || Math.max(1, z.min); // nur beim ersten Mal
      state.zoomCaps = z;
      const presets = [];
      if (z.min < 0.95) presets.push(z.min);       // Weitwinkel als Zoomstufe, falls das Handy das so meldet
      for (const p of [1, 2, 4, 8]) if (p >= z.min && p <= z.max) presets.push(p);
      state.mainPresets = presets;
    } else {
      state.zoomCaps = null;
      state.zoom = 1;
      state.mainPresets = [];
    }
    if (state.pendingZoom != null) {
      const z2 = state.pendingZoom;
      state.pendingZoom = null;
      setZoom(z2);
    }
  } else {
    state.zoomCaps = null; // im Weitwinkel kein Zoom
  }
  state.controlsTrack = t;
  renderZoomBar();
}

function formatZoom(z) {
  return String(Math.round(z * 10) / 10).replace('.', ',') + '×';
}

function renderZoomBar() {
  const items = [];
  const hasWideLens = !!(state.lenses && state.lenses.wide);
  const zoomHasWide = state.mainPresets.some((p) => p < 0.95);
  if (hasWideLens && !zoomHasWide) items.push({ lens: 'wide', zoom: 0.6 });
  for (const p of state.mainPresets) items.push({ lens: 'main', zoom: p });
  if (hasWideLens && !state.mainPresets.length) items.push({ lens: 'main', zoom: 1 });

  el.zoomBar.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'zoom-btn';
    b.dataset.lens = it.lens;
    b.dataset.zoom = String(it.zoom);
    b.addEventListener('click', () => {
      if (it.lens === 'wide') switchLens('wide');
      else if (state.lens === 'wide') switchLens('main', it.zoom);
      else setZoom(it.zoom);
    });
    el.zoomBar.appendChild(b);
  }
  el.zoomBar.classList.toggle('hidden', items.length < 2);
  updateZoomUi();
}

function updateZoomUi() {
  const btns = [...el.zoomBar.children];
  let active = null;
  if (state.lens === 'wide') {
    active = btns.find((b) => b.dataset.lens === 'wide') || null;
  } else {
    for (const b of btns) {
      if (b.dataset.lens === 'main' && parseFloat(b.dataset.zoom) <= state.zoom + 0.05) active = b;
    }
  }
  for (const b of btns) {
    const z = parseFloat(b.dataset.zoom);
    b.classList.toggle('active', b === active);
    const showCurrent = b === active && b.dataset.lens === 'main' && Math.abs(z - state.zoom) > 0.05;
    b.textContent = showCurrent ? formatZoom(state.zoom) : formatZoom(z);
    // Während einer Videoaufnahme kann nicht auf ein anderes Objektiv gewechselt werden
    b.disabled = !!state.rec && b.dataset.lens !== state.lens;
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
  if (accuracy > CONFIG.selectMaxAccuracy) return;
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
  el.addrLine.textContent = camAddr ? oneLine(camAddr) : (p ? 'Adresse wird ermittelt …' : 'Kein Standort');
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

/*
 * Gegen Manipulation: Es kann nur eine Adresse aus der direkten Umgebung des
 * aktuellen GPS-Standorts gewählt werden (keine freie Eingabe).
 */
const sheet = { selected: 'auto', options: new Map(), token: 0 };

const isSheetOpen = () => !el.sheet.classList.contains('hidden');

function openSheet() {
  if (state.rec || isSheetOpen()) return;
  history.pushState({ view: 'sheet' }, '');
  sheet.selected = state.addrOverride ? state.addrOverride.key : 'auto';
  el.noteInput.value = state.note;
  renderNoteRecent();
  renderAddrOptions([], 'loading');
  el.sheetPanel.style.transform = '';
  el.sheet.classList.remove('hidden');
  requestAnimationFrame(() => el.sheet.classList.add('open'));
  loadNearby();
}

function hideSheet() {
  el.sheet.classList.remove('open');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  setTimeout(() => {
    if (!el.sheet.classList.contains('open')) {
      el.sheet.classList.add('hidden');
      el.sheetPanel.style.transform = '';
    }
  }, 240);
}

function closeSheet() {
  if (history.state && history.state.view === 'sheet') history.back(); // popstate schließt das Fenster
  else hideSheet();
}

/*
 * Fenster nach unten wegwischen – überall im Fenster.
 * In der Adressliste beginnt das Wischen erst, wenn die Liste ganz oben steht
 * (sonst wird normal gescrollt).
 */
function setupSheetDrag(panel, grab, close) {
  const body = panel.querySelector('.sheet-body');
  let drag = null; // { x, y, t, active }

  const move = (dy) => { panel.style.transform = `translateY(${Math.max(0, dy)}px)`; };
  const finish = (dy, dt) => {
    panel.style.transition = '';
    const fast = dy > 40 && dt < 300;
    if (dy > 110 || fast) {
      panel.style.transform = 'translateY(100%)';
      close();
    } else {
      panel.style.transform = '';
    }
  };

  // Finger
  panel.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { drag = null; return; }
    const t = e.touches[0];
    drag = { x: t.clientX, y: t.clientY, t: Date.now(), active: false };
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const t = e.touches[0];
    const dx = t.clientX - drag.x;
    const dy = t.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dy) < 8 || Math.abs(dx) > Math.abs(dy)) return;
      const inBody = body.contains(e.target);
      if (dy < 0 || (inBody && body.scrollTop > 0)) { drag = null; return; } // normal scrollen
      drag.active = true;
      drag.y = t.clientY; // ab hier mitziehen
      drag.t = Date.now();
      panel.style.transition = 'none';
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    e.preventDefault();
    move(t.clientY - drag.y);
  }, { passive: false });

  const touchEnd = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    const t = e.changedTouches[0];
    finish(t.clientY - d.y, Date.now() - d.t);
  };
  panel.addEventListener('touchend', touchEnd);
  panel.addEventListener('touchcancel', touchEnd);

  // Maus (am Computer): am Kopfbereich ziehen
  let mouse = null;
  grab.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.target.closest('button')) return;
    mouse = { y: e.clientY, t: Date.now() };
    panel.style.transition = 'none';
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => { if (mouse) move(e.clientY - mouse.y); });
  const mouseEnd = (e) => {
    if (!mouse) return;
    const m = mouse;
    mouse = null;
    finish(Math.max(0, e.clientY - m.y), Date.now() - m.t);
  };
  grab.addEventListener('pointerup', mouseEnd);
  grab.addEventListener('pointercancel', mouseEnd);
}
setupSheetDrag(el.sheetPanel, el.sheetGrab, () => closeSheet());

/* ------------------------------------------------------------------ */
/* Großansicht mit Zoom                                                */
/* ------------------------------------------------------------------ */

const viewer = { s: 1, x: 0, y: 0, dx: 0, dy: 0, base: null, urls: [], index: 0 };
const isViewerOpen = () => !el.viewer.classList.contains('hidden');

/** Großansicht öffnen; bei mehreren Bildern mit Blättern (Galerie). */
function openViewer(urls, index = 0, items = null) {
  history.pushState({ view: 'viewer' }, '');
  viewer.urls = urls;
  viewer.items = items;
  el.viewer.classList.remove('hidden');
  el.viewer.style.background = '';
  el.viewerHint.textContent = urls.length > 1
    ? 'Wischen zum Blättern · nach unten zum Schließen'
    : 'Zoomen: zwei Finger oder doppelt tippen';
  el.viewerHint.classList.remove('fade');
  void el.viewerHint.offsetWidth;
  el.viewerHint.classList.add('fade');
  showViewerImage(index, 0);
}

/** Bild Nummer index anzeigen; from = -1/1 lässt es von links/rechts hereingleiten. */
function showViewerImage(index, from) {
  viewer.index = index;
  const multi = viewer.urls.length > 1;
  el.viewerPrev.classList.toggle('hidden', !multi);
  el.viewerNext.classList.toggle('hidden', !multi);
  el.viewerCount.classList.toggle('hidden', !multi);
  el.viewerPrev.disabled = index <= 0;
  el.viewerNext.disabled = index >= viewer.urls.length - 1;
  el.viewerCount.textContent = `${index + 1} / ${viewer.urls.length}`;
  const item = viewer.items && viewer.items[index];
  el.viewerEdit.classList.toggle('hidden', !(item && item.kind !== 'video'));

  const img = el.viewerImg;
  img.onload = () => {
    viewerLayout();
    if (from) {
      viewer.dx = from * viewer.base.vw;
      viewerApply(false);
      requestAnimationFrame(() => requestAnimationFrame(() => { viewer.dx = 0; viewerApply(true); }));
    }
  };
  img.src = viewer.urls[index];
}

function viewerStep(dir) {
  const i = viewer.index + dir;
  if (i < 0 || i >= viewer.urls.length) return false;
  showViewerImage(i, dir);
  return true;
}

function hideViewer() {
  el.viewer.classList.add('hidden');
  el.viewerImg.removeAttribute('src');
  el.viewerImg.onload = null;
  viewer.urls = [];
}

function closeViewer() {
  if (history.state && history.state.view === 'viewer') history.back(); // popstate schließt
  else hideViewer();
}

/** Bild einpassen (Zoom 1). */
function viewerLayout() {
  const img = el.viewerImg;
  const vw = el.viewer.clientWidth;
  const vh = el.viewer.clientHeight;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const s0 = Math.min(vw / iw, vh / ih);
  viewer.base = { w: iw * s0, h: ih * s0, vw, vh };
  img.style.width = viewer.base.w + 'px';
  img.style.height = viewer.base.h + 'px';
  viewer.s = 1;
  viewer.dx = 0;
  viewer.dy = 0;
  viewer.x = (vw - viewer.base.w) / 2;
  viewer.y = (vh - viewer.base.h) / 2;
  viewerApply(false);
}

function viewerClamp() {
  const b = viewer.base;
  const w = b.w * viewer.s;
  const h = b.h * viewer.s;
  viewer.x = w <= b.vw ? (b.vw - w) / 2 : Math.min(0, Math.max(b.vw - w, viewer.x));
  viewer.y = h <= b.vh ? (b.vh - h) / 2 : Math.min(0, Math.max(b.vh - h, viewer.y));
}

function viewerApply(animate) {
  if (!viewer.base) return;
  viewerClamp();
  // dx/dy: Verschiebung beim Blättern bzw. Herunterwischen (außerhalb der Begrenzung)
  el.viewerImg.style.transition = animate ? 'transform .22s ease' : 'none';
  el.viewerImg.style.transform =
    `translate(${viewer.x + viewer.dx}px, ${viewer.y + viewer.dy}px) scale(${viewer.s})`;
  const fade = Math.min(1, Math.max(0, viewer.dy) / 400);
  el.viewer.style.transition = animate ? 'background-color .22s ease' : 'none';
  el.viewer.style.backgroundColor = `rgba(0, 0, 0, ${1 - fade * 0.8})`;
  el.viewer.classList.toggle('dragging', viewer.dy > 0);
}

/** Zoomen um einen Punkt (px, py) im Fenster. */
function viewerZoomAt(px, py, newScale, animate) {
  const s = Math.min(6, Math.max(1, newScale));
  viewer.x = px - (px - viewer.x) * (s / viewer.s);
  viewer.y = py - (py - viewer.y) * (s / viewer.s);
  viewer.s = s;
  viewerApply(animate);
}

(function setupViewerGestures() {
  const area = el.viewer;
  const pointers = new Map();
  let pinch = null;
  let pan = null;    // { start, x, y, t, moved, mode: null | 'pan' | 'swipe' | 'down' }
  let lastTap = null;
  const rel = (e) => {
    const r = area.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  area.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    area.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, rel(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      viewer.dx = 0;
      viewer.dy = 0;
      pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        s: viewer.s, x: viewer.x, y: viewer.y,
      };
      pan = null;
    } else if (pointers.size === 1) {
      const p = rel(e);
      pan = { start: p, x: viewer.x, y: viewer.y, t: Date.now(), moved: false, mode: null };
    }
  });

  area.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, rel(e));
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.min(6, Math.max(1, pinch.s * (d / pinch.d)));
      viewer.s = s;
      viewer.x = mid.x - (pinch.mid.x - pinch.x) * (s / pinch.s);
      viewer.y = mid.y - (pinch.mid.y - pinch.y) * (s / pinch.s);
      viewerApply(false);
    } else if (pan && pointers.size === 1) {
      const p = rel(e);
      const dx = p.x - pan.start.x;
      const dy = p.y - pan.start.y;
      if (!pan.moved && Math.hypot(dx, dy) > 10) {
        pan.moved = true;
        if (viewer.s > 1.02) pan.mode = 'pan';                       // gezoomt: Bild verschieben
        else if (Math.abs(dx) > Math.abs(dy)) pan.mode = viewer.urls.length > 1 ? 'swipe' : null;
        else pan.mode = dy > 0 ? 'down' : null;                      // nach unten: schließen
      }
      if (pan.mode === 'pan') {
        viewer.x = pan.x + dx;
        viewer.y = pan.y + dy;
      } else if (pan.mode === 'swipe') {
        const atEnd = (dx > 0 && viewer.index === 0) || (dx < 0 && viewer.index === viewer.urls.length - 1);
        viewer.dx = atEnd ? dx * 0.3 : dx; // am Anfang/Ende nur leicht nachgeben
      } else if (pan.mode === 'down') {
        viewer.dy = Math.max(0, dy);
        viewer.dx = dx * 0.3;
      }
      if (pan.mode) viewerApply(false);
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = rel(e);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;

    if (pan && pointers.size === 0) {
      const dt = Date.now() - pan.t;
      const dx = p.x - pan.start.x;
      const dy = p.y - pan.start.y;
      if (pan.mode === 'swipe') {
        const dir = dx < 0 ? 1 : -1;
        const far = Math.abs(dx) > Math.min(90, viewer.base.vw * 0.22) || (Math.abs(dx) > 30 && dt < 250);
        if (far && viewer.index + dir >= 0 && viewer.index + dir < viewer.urls.length) {
          viewer.dx = -dir * viewer.base.vw; // altes Bild hinausschieben
          viewerApply(true);
          setTimeout(() => viewerStep(dir), 180);
        } else {
          viewer.dx = 0;
          viewerApply(true);
        }
      } else if (pan.mode === 'down') {
        if (dy > 120 || (dy > 40 && dt < 250)) {
          viewer.dy = viewer.base.vh;
          viewerApply(true);
          setTimeout(closeViewer, 180);
        } else {
          viewer.dx = 0;
          viewer.dy = 0;
          viewerApply(true);
        }
      } else if (!pan.moved && e.type === 'pointerup' && dt < 300) {
        // Doppeltippen: vergrößern bzw. zurück
        const now = Date.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
          if (viewer.s > 1.05) {
            viewer.s = 1;
            viewerApply(true);
          } else {
            viewerZoomAt(p.x, p.y, 2.5, true);
          }
          lastTap = null;
        } else {
          lastTap = { t: now, x: p.x, y: p.y };
        }
      }
      pan = null;
    } else if (pointers.size === 1) {
      const [only] = [...pointers.values()];
      pan = { start: only, x: viewer.x, y: viewer.y, t: Date.now(), moved: true, mode: viewer.s > 1.02 ? 'pan' : null };
    }
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);

  // Mausrad und Pfeiltasten am Computer
  area.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = rel(e);
    viewerZoomAt(p.x, p.y, viewer.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), false);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (!isViewerOpen()) return;
    if (e.key === 'ArrowLeft') viewerStep(-1);
    else if (e.key === 'ArrowRight') viewerStep(1);
    else if (e.key === 'Escape') closeViewer();
  });

  window.addEventListener('resize', () => { if (isViewerOpen()) viewerLayout(); });
})();

async function loadNearby() {
  const token = ++sheet.token;
  const pos = freshPosition();
  if (!pos) { renderAddrOptions([], 'nogps'); return; }
  if (pos.coords.accuracy > CONFIG.selectMaxAccuracy) { renderAddrOptions([], 'inaccurate'); return; }
  if (!navigator.onLine) { renderAddrOptions([], 'offline'); return; }
  try {
    const items = await fetchNearby(pos.coords.latitude, pos.coords.longitude);
    if (token === sheet.token && isSheetOpen()) renderAddrOptions(items, 'ok');
  } catch (err) {
    console.warn('Adressen in der Nähe:', err);
    if (token === sheet.token && isSheetOpen()) renderAddrOptions([], 'error');
  }
}

function addrOption(key, title, sub, badge, onDelete) {
  const row = document.createElement('div');
  row.className = 'addr-opt';
  row.dataset.key = key;
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.innerHTML = '<span class="radio"></span><span class="addr-opt-text"><span class="addr-opt-title"></span>' +
    '<span class="addr-opt-sub"></span></span>';
  row.querySelector('.addr-opt-title').textContent = title;
  const subEl = row.querySelector('.addr-opt-sub');
  if (sub) subEl.textContent = sub; else subEl.remove();
  if (badge) {
    const s = document.createElement('span');
    s.className = 'addr-opt-badge';
    s.textContent = badge;
    row.appendChild(s);
  }
  if (onDelete) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'addr-del';
    del.setAttribute('aria-label', 'Aus der Liste löschen');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 7.1 16.9 5.7 12 10.6 7.1 5.7 5.7 7.1l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete();
    });
    row.appendChild(del);
  }
  const select = () => {
    sheet.selected = key;
    updateSheetSelection();
  };
  row.addEventListener('click', select);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') select(); });
  return row;
}

function groupLabel(text) {
  const d = document.createElement('div');
  d.className = 'group-label';
  d.textContent = text;
  return d;
}

function renderAddrOptions(nearby, status) {
  sheet.lastNearby = nearby;
  sheet.lastStatus = status;
  const pos = freshPosition();
  const canChoose = pos && pos.coords.accuracy <= CONFIG.selectMaxAccuracy;
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

  // Zuletzt verwendet – nur, wenn ganz in der Nähe des aktuellen Standorts
  if (canChoose) {
    const shown = new Set(nearby.map((n) => n.text));
    const recent = loadList(STORAGE.addresses).filter((r) => r && r.text && r.lat != null && !shown.has(r.text));
    const near = recent
      .map((r) => ({ ...r, dist: distanceMeters(pos.coords.latitude, pos.coords.longitude, r.lat, r.lon) }))
      .filter((r) => r.dist <= CONFIG.overrideResetMeters);
    if (near.length) {
      list.appendChild(groupLabel('Zuletzt verwendet'));
      for (const r of near) {
        const key = 'recent:' + r.text;
        const [line1, line2] = r.text.split('\n');
        sheet.options.set(key, { key, text: r.text });
        list.appendChild(addrOption(key, line1, line2 || '', formatDistance(r.dist), () => {
          saveList(STORAGE.addresses, loadList(STORAGE.addresses).filter((x) => !x || x.text !== r.text));
          if (sheet.selected === key) sheet.selected = 'auto';
          renderAddrOptions(sheet.lastNearby || [], sheet.lastStatus || 'ok');
        }));
      }
    }
  }

  // Die aktuell gewählte Adresse, falls sie gerade nicht in der Liste steht
  if (sheet.selected !== 'auto' && !sheet.options.has(sheet.selected)) {
    const o = state.addrOverride;
    if (o && o.key === sheet.selected) {
      sheet.options.set(o.key, { key: o.key, text: o.text });
      const [line1, line2] = o.text.split('\n');
      list.insertBefore(addrOption(o.key, line1, line2 || '', 'gewählt'), list.children[1] || null);
    } else {
      sheet.selected = 'auto';
    }
  }

  const acc = pos ? Math.round(pos.coords.accuracy) : 0;
  const messages = {
    loading: 'Adressen in der Nähe werden gesucht …',
    nogps: 'Ohne GPS-Standort kann keine Adresse gewählt werden.',
    inaccurate: `GPS zu ungenau (±${acc} m). Eine Adresse kann erst ab ±${CONFIG.selectMaxAccuracy} m gewählt werden.`,
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
  let o = null;
  if (sheet.selected !== 'auto' && pos && pos.coords.accuracy <= CONFIG.selectMaxAccuracy) {
    const opt = sheet.options.get(sheet.selected);
    if (opt) {
      o = state.addrOverride && state.addrOverride.key === sheet.selected
        ? state.addrOverride
        : { key: sheet.selected, text: opt.text, atLat: pos.coords.latitude, atLon: pos.coords.longitude };
    }
  }
  state.addrOverride = o;
  if (o) {
    pushRecent(STORAGE.addresses, { text: o.text, lat: o.atLat, lon: o.atLon }, (a, b) => a.text === b.text);
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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/**
 * Zeichnet den Stempel (halbtransparenter Balken mit Text und Firmenlogo) auf eine
 * eigene Fläche in voller Bildbreite. Sie wird unten ins Foto bzw. in jedes Videobild gesetzt.
 * info: { timestamp, timeVerified, note, address, coords }
 */
function renderStamp(w, h, info, target) {
  const canvas = target || document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = Math.max(14, Math.round(Math.min(w, h) * 0.032));
  const lineHeight = Math.round(fontSize * 1.3);
  const pad = Math.round(fontSize * 0.8);

  // Firmenlogo rechts auf einer hellen Fläche
  let plate = null;
  if (companyLogoReady) {
    const ph = Math.round(fontSize * 3.4);
    const inner = Math.round(ph * 0.14);
    const ratio = companyLogo.naturalWidth / companyLogo.naturalHeight;
    let lw = (ph - inner * 2) * ratio;
    const pw = Math.min(Math.round(lw + inner * 2), Math.round(w * 0.32));
    lw = pw - inner * 2;
    plate = { w: pw, h: ph, inner, lw, lh: lw / ratio };
  }
  const maxWidth = w - pad * 2 - (plate ? plate.w + pad : 0);

  const rows = []; // [text, fett?, farbe, zusatz]
  const add = (text, bold, color, extra) => {
    ctx.font = `${bold ? 700 : 400} ${fontSize}px ${FONT}`;
    const lines = wrapText(ctx, text, maxWidth);
    lines.forEach((l, i) => rows.push([l, bold, color, i === lines.length - 1 ? extra : null]));
  };

  add(info.timestamp, true, '#ffffff', info.timeVerified
    ? { text: '  ✓ Zeit geprüft', color: '#86EFAC' }
    : { text: '  Zeit ungeprüft', color: '#FCD34D' });
  if (info.note) add(info.note, true, '#7DD3FC');
  if (info.address) add(info.address, false, '#ffffff');
  if (info.coords) {
    if (!info.address) add('Adresse nicht verfügbar', false, '#ffd27a');
    add(info.coords, false, '#ffffff');
  } else {
    add('Kein Standort verfügbar', true, '#ffb4ab');
  }
  if (info.employee) add('Aufgenommen von ' + info.employee, false, '#CBD5E1');

  const boxHeight = Math.max(rows.length * lineHeight, plate ? plate.h : 0) + pad * 2;
  canvas.width = w;
  canvas.height = boxHeight; // setzt auch den Zeichenzustand zurück
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, w, boxHeight);

  if (plate) {
    const px = w - pad - plate.w;
    const py = Math.round((boxHeight - plate.h) / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    roundRect(ctx, px, py, plate.w, plate.h, Math.round(plate.h * 0.16));
    ctx.fill();
    ctx.drawImage(companyLogo, px + plate.inner, py + (plate.h - plate.lh) / 2, plate.lw, plate.lh);
  }

  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = Math.round(fontSize * 0.15);
  let y = pad + Math.round((lineHeight - fontSize) / 2);
  for (const [text, bold, color, extra] of rows) {
    ctx.font = `${bold ? 700 : 400} ${fontSize}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(text, pad, y);
    if (extra) {
      const x = pad + ctx.measureText(text).width;
      ctx.font = `600 ${Math.round(fontSize * 0.8)}px ${FONT}`;
      ctx.fillStyle = extra.color;
      ctx.fillText(extra.text, x, y + Math.round(fontSize * 0.15));
    }
    y += lineHeight;
  }
  return canvas;
}

/** EXIF-Daten eines Ergebnisses (z. B. nach dem Markieren erneut schreiben). */
function exifMetaFor(item) {
  const m = item.meta || {};
  return {
    date: m.date,
    pos: m.posData ? { coords: m.posData, timestamp: m.posData.timestamp } : null,
    description: exifDescription(m.note, m.address),
    artist: m.employee,
  };
}

function exifDescription(note, address) {
  return [note, oneLine(address)].filter(Boolean).join(' | ');
}

/* ------------------------------------------------------------------ */
/* Foto (einzeln, Serie, Nachher-Foto beim Vorher/Nachher-Vergleich)   */
/* ------------------------------------------------------------------ */

function canvasToBlob(canvas, quality = CONFIG.jpegQuality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))),
      'image/jpeg', quality);
  });
}

/** Kamerabild sofort einfrieren (Zeitpunkt = Auslösen). */
function captureFrame() {
  const video = el.video;
  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return {
    canvas, w, h,
    perf: performance.now(),
    device: Date.now(),
    note: state.note,
    employee: settings.name,
    compare: state.mode === 'compare' && state.before ? state.before : null,
  };
}

/** Stempel, Zusammensetzen, EXIF – liefert ein fertiges Ergebnis. */
async function processFrame(frame, status = () => {}) {
  status(freshPosition() ? 'Adresse wird ermittelt …' : 'Standort wird ermittelt …');
  const pos = await getPositionForPhoto();
  status('Adresse wird ermittelt …');
  const address = await getAddressForPhoto(pos);
  status('Uhrzeit wird geprüft …');
  await ensureTimeSync();
  const t = trustedTime(frame.perf, frame.device);

  status('Foto wird gespeichert …');
  const { canvas, w, h } = frame;
  const ctx = canvas.getContext('2d');
  const coords = pos ? formatCoords(pos) : null;
  const stamp = renderStamp(w, h, {
    timestamp: formatTimestamp(t.date),
    timeVerified: t.verified,
    note: frame.note,
    address,
    coords,
    employee: frame.employee,
  });
  ctx.drawImage(stamp, 0, h - stamp.height);

  let out = canvas;
  let prefix = 'Foto';
  let kind = 'photo';
  if (frame.compare) {
    status('Vorher/Nachher wird erstellt …');
    out = composeBeforeAfter(frame.compare, canvas);
    prefix = 'VorherNachher';
    kind = 'compare';
  }

  let blob = await canvasToBlob(out);
  try {
    blob = await Exif.insert(blob, { date: t.date, pos, description: exifDescription(frame.note, address), artist: frame.employee });
  } catch (e) {
    console.warn('EXIF konnte nicht geschrieben werden:', e);
  }

  return {
    kind,
    blob,
    url: URL.createObjectURL(blob),
    filename: makeFilename(prefix, t.date, address, 'jpg'),
    width: out.width,
    height: out.height,
    meta: {
      date: t.date,
      verified: t.verified,
      address,
      coords,
      note: frame.note,
      employee: frame.employee,
      posData: pos ? {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        altitude: pos.coords.altitude,
        timestamp: pos.timestamp,
      } : null,
      compareDate: frame.compare && frame.compare.date,
    },
  };
}

function flash() {
  el.flash.classList.remove('on');
  void el.flash.offsetWidth;
  el.flash.classList.add('on');
}

async function takePhoto() {
  if (!state.stream || !el.video.videoWidth) return;
  const frame = captureFrame();

  // Serie: Kamera bleibt offen, das Foto wird im Hintergrund fertiggestellt
  if (state.mode === 'photo' && state.seriesMode) {
    flash();
    state.seriesPending++;
    state.seriesSaved = false;
    updateSeriesUi();
    state.seriesQueue = state.seriesQueue
      .then(() => processFrame(frame))
      .then((item) => {
        state.seriesNo++;
        item.filename = item.filename.replace(/\.jpg$/, `_${pad2(state.seriesNo)}.jpg`);
        state.series.push(item);
        persistSeriesSoon();
      })
      .catch((err) => {
        console.error(err);
        showCameraMessage('Ein Foto konnte nicht verarbeitet werden: ' + err.message, 4000);
      })
      .finally(() => {
        state.seriesPending--;
        updateSeriesUi();
      });
    return;
  }

  el.shutter.disabled = true;
  show(el.viewBusy);
  try {
    const item = await processFrame(frame, (t) => { el.busyText.textContent = t; });
    stopCamera(); // Akku sparen, solange das Ergebnis angezeigt wird
    showResults(item.kind, [item]);
  } catch (err) {
    console.error(err);
    alert('Fehler beim Erstellen des Fotos: ' + err.message);
    show(el.viewCamera);
    el.shutter.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Serie                                                               */
/* ------------------------------------------------------------------ */

function setSeriesMode(on) {
  state.seriesMode = on;
  for (const b of el.shotMode.querySelectorAll('button')) {
    b.classList.toggle('active', (b.dataset.mode === 'series') === on);
  }
  updateSeriesUi();
}

function updateSeriesUi() {
  const inPhoto = state.mode === 'photo';
  el.shotMode.classList.toggle('hidden', !inPhoto);
  const count = state.series.length + state.seriesPending;
  el.btnSeries.classList.toggle('hidden', !(inPhoto && count > 0));
  el.seriesCount.textContent = String(count);
  el.btnSeries.classList.toggle('busy', state.seriesPending > 0);
  const last = state.series[state.series.length - 1];
  if (last) el.seriesThumb.src = last.url;
  else el.seriesThumb.removeAttribute('src');
}

async function finishSeries() {
  if (!state.series.length && !state.seriesPending) return;
  el.busyText.textContent = 'Fotos werden fertiggestellt …';
  show(el.viewBusy);
  await state.seriesQueue;
  stopCamera();
  if (!state.series.length) {
    show(el.viewCamera);
    startCamera();
    return;
  }
  if (!state.seriesEntryId) state.seriesEntryId = newEntryId();
  showResults('series', state.series, { entryId: state.seriesEntryId });
}

function discardSeries() {
  for (const it of state.series) URL.revokeObjectURL(it.url);
  state.series = [];
  state.seriesNo = 0;
  state.seriesSaved = true;
  state.seriesEntryId = null;
  clearTimeout(seriesSaveTimer);
  updateSeriesUi();
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
      leaveResult();
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
function liveStampInfo() {
  const pos = freshPosition();
  const t = trustedTime();
  return {
    timestamp: formatTimestamp(t.date),
    timeVerified: t.verified,
    note: state.note,
    address: currentAddressText(pos),
    coords: pos ? formatCoords(pos) : null,
    employee: settings.name,
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
  updateZoomUi(); // während der Aufnahme nur Objektivwechsel sperren
}

async function startRecording() {
  const video = el.video;
  if (!state.stream || !video.videoWidth || state.rec) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    alert('Dieser Browser kann keine Videos aufnehmen. Bitte Chrome aktualisieren.');
    return;
  }
  await ensureTimeSync();

  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = el.canvas;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const rec = {
    startedAt: trustedTime().date,
    address: currentAddressText(freshPosition()),
    stampCanvas: document.createElement('canvas'),
    stampKey: '',
    chunks: [],
    recorder: null,
    timer: null,
    wakeLock: null,
    stopping: false,
    perfStart: performance.now(),
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
    const info = liveStampInfo();
    const key = [info.timestamp, info.timeVerified, info.note, info.address, info.coords, info.employee].join('|');
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
    const sec = (performance.now() - rec.perfStart) / 1000;
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
  showResults('video', [{
    kind: 'video',
    blob,
    url: URL.createObjectURL(blob),
    filename: makeFilename('Video', rec.startedAt, rec.address, ext),
    meta: { date: rec.startedAt, address: rec.address, note: state.note, employee: settings.name },
  }]);
}

/* ------------------------------------------------------------------ */
/* Ergebnis: anzeigen, herunterladen, teilen, PDF, ZIP                 */
/* ------------------------------------------------------------------ */

const RESULT_TEXT = {
  photo: { title: 'Foto erstellt', again: 'Neues Foto' },
  video: { title: 'Video erstellt', again: 'Neues Video' },
  compare: { title: 'Vorher/Nachher erstellt', again: 'Neues Vorher/Nachher' },
  series: { title: 'Serie', again: 'Weitere Fotos' },
};

const KIND_LABEL = { photo: 'Foto', video: 'Video', compare: 'Vorher/Nachher', series: 'Serie' };

function showResults(kind, items, opts = {}) {
  state.shown = { kind, items, entryId: opts.entryId || null, fromHistory: !!opts.fromHistory };
  history.replaceState({ view: 'result' }, '');
  renderResults();
  show(el.viewResult);
  if (!opts.fromHistory) persistShown();
}

/* ---------- Verlauf speichern ---------- */

const newEntryId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function imageThumb(blob) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, 360 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return canvasToBlob(c, 0.7);
}

function videoThumb(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (b) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(b);
    };
    const timer = setTimeout(() => finish(null), 4000);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onloadeddata = () => { v.currentTime = 0.2; };
    v.onseeked = async () => {
      clearTimeout(timer);
      try {
        const s = Math.min(1, 360 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * s);
        c.height = Math.round(v.videoHeight * s);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        finish(await canvasToBlob(c, 0.7));
      } catch (e) { finish(null); }
    };
    v.onerror = () => { clearTimeout(timer); finish(null); };
    v.src = url;
  });
}

async function saveEntry(kind, items, id) {
  if (!items.length || !window.indexedDB) return;
  try {
    const last = items[items.length - 1];
    let thumb = null;
    try { thumb = last.kind === 'video' ? await videoThumb(last.blob) : await imageThumb(last.blob); } catch (e) { /* ohne Vorschau */ }
    const first = items[0].meta || {};
    await HistoryStore.put({
      id,
      kind,
      createdAt: first.date ? +first.date : Date.now(),
      updatedAt: Date.now(),
      address: first.address || null,
      note: first.note || '',
      count: items.length,
      thumb,
      items: items.map(HistoryStore.toStored),
    });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (err) {
    console.warn('Verlauf konnte nicht gespeichert werden:', err);
  }
}

/** Angezeigtes Ergebnis im Verlauf speichern bzw. aktualisieren. */
function persistShown() {
  const s = state.shown;
  if (!s || !s.items.length) return;
  if (!s.entryId) s.entryId = newEntryId();
  if (s.kind === 'series') state.seriesEntryId = s.entryId;
  saveEntry(s.kind, s.items.slice(), s.entryId);
}

let seriesSaveTimer = null;
function persistSeriesSoon() {
  clearTimeout(seriesSaveTimer);
  seriesSaveTimer = setTimeout(() => {
    if (!state.series.length) return;
    if (!state.seriesEntryId) state.seriesEntryId = newEntryId();
    saveEntry('series', state.series.slice(), state.seriesEntryId);
  }, 800);
}

/* ---------- Markieren ---------- */

async function annotateItem(item) {
  try {
    await Editor.open(item, async (blob) => {
      URL.revokeObjectURL(item.url);
      item.blob = blob;
      item.url = URL.createObjectURL(blob);
      if (!/_markiert\.jpg$/.test(item.filename)) item.filename = item.filename.replace(/\.jpg$/, '_markiert.jpg');
      item.meta.annotated = true;
      if (state.shown) {
        renderResults();
        persistShown();
      }
      if (isViewerOpen() && viewer.items) {
        viewer.urls = viewer.items.map((x) => x.url);
        showViewerImage(viewer.index, 0);
      }
    });
  } catch (err) {
    console.error(err);
    alert('Das Foto kann nicht markiert werden: ' + err.message);
  }
}

function renderResults() {
  const { kind, items } = state.shown;
  const isSeries = kind === 'series';
  const single = items[0];

  el.resultSingle.classList.toggle('hidden', isSeries);
  el.zoomHint.classList.toggle('hidden', isSeries);
  el.resultGrid.classList.toggle('hidden', !isSeries);
  el.resultImg.removeAttribute('src');
  el.resultVideo.pause();
  el.resultVideo.removeAttribute('src');

  if (isSeries) {
    el.resultTitle.textContent = state.shown.fromHistory
      ? `Serie · ${formatShortDate(items[0].meta.date)}`
      : items.length === 1 ? '1 Foto aufgenommen' : `${items.length} Fotos aufgenommen`;
    el.resultGrid.innerHTML = '';
    items.forEach((it, i) => {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = `Foto ${i + 1}`;
      const num = document.createElement('span');
      num.className = 'grid-num';
      num.textContent = String(i + 1);
      const del = document.createElement('button');
      del.className = 'grid-del';
      del.setAttribute('aria-label', `Foto ${i + 1} entfernen`);
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 7.1 16.9 5.7 12 10.6 7.1 5.7 5.7 7.1l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z"/></svg>';
      del.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `Foto ${i + 1} löschen?`,
          text: 'Das Foto wird aus der Serie entfernt. Das kann nicht rückgängig gemacht werden.',
          ok: 'Löschen',
          cancel: 'Zurück',
          danger: true,
        });
        if (ok) removeSeriesItem(it);
      });
      img.addEventListener('click', () => openViewer(items.map((x) => x.url), i, items));
      cell.append(img, num, del);
      el.resultGrid.appendChild(cell);
    });
  } else {
    el.resultTitle.textContent = state.shown.fromHistory
      ? `${KIND_LABEL[kind]} · ${formatShortDate(single.meta.date)}`
      : RESULT_TEXT[kind].title;
    const isVideo = kind === 'video';
    el.resultImg.classList.toggle('hidden', isVideo);
    el.resultVideo.classList.toggle('hidden', !isVideo);
    if (isVideo) el.resultVideo.src = single.url;
    else el.resultImg.src = single.url;
    el.zoomHint.classList.toggle('hidden', isVideo);
  }

  el.btnNew.textContent = RESULT_TEXT[kind].again;
  el.downloadLabel.textContent = items.length > 1 ? `Alle herunterladen (${items.length})` : 'Herunterladen';

  const files = items.map((it) => new File([it.blob], it.filename, { type: it.blob.type }));
  const canShare = !!(navigator.canShare && navigator.canShare({ files }));
  el.btnShare.classList.toggle('hidden', !canShare);
  el.btnPdf.classList.toggle('hidden', kind === 'video');
  el.btnZip.classList.toggle('hidden', items.length < 2);
  el.btnAnnotate.classList.toggle('hidden', kind !== 'photo' && kind !== 'compare');
  el.btnNew.classList.toggle('hidden', state.shown.fromHistory);
  el.btnHome.textContent = state.shown.fromHistory ? 'Zum Verlauf' : 'Startseite';
  for (const b of [el.btnDownload, el.btnShare, el.btnPdf, el.btnZip]) b.disabled = items.length === 0;
}

function removeSeriesItem(item) {
  const i = state.series.indexOf(item);
  if (i < 0) return;
  state.series.splice(i, 1);
  URL.revokeObjectURL(item.url);
  if (!state.series.length) {
    // nichts mehr übrig: Eintrag aus dem Verlauf löschen
    if (state.seriesEntryId) HistoryStore.remove(state.seriesEntryId).catch(() => {});
    const fromHistory = state.shown && state.shown.fromHistory;
    state.seriesSaved = true;
    state.seriesEntryId = null;
    state.shown = null;
    if (fromHistory) {
      showHistory(false);
      return;
    }
    history.replaceState({ view: 'camera' }, '');
    enterCamera('photo');
    return;
  }
  renderResults();
  persistShown();
}

/** Ergebnis verlassen: Einzelergebnisse freigeben (die Serie bleibt bis zur Startseite erhalten). */
function leaveResult() {
  const s = state.shown;
  state.shown = null;
  el.resultImg.removeAttribute('src');
  el.resultVideo.pause();
  el.resultVideo.removeAttribute('src');
  el.resultVideo.load();
  if (s && s.kind !== 'series') for (const it of s.items) URL.revokeObjectURL(it.url);
}

function markSaved() {
  if (state.shown && state.shown.kind === 'series') state.seriesSaved = true;
}

function downloadBlob(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadResults() {
  if (!state.shown) return;
  const items = state.shown.items;
  for (let i = 0; i < items.length; i++) {
    downloadBlob(items[i].url, items[i].filename);
    if (i < items.length - 1) await sleep(400); // sonst blockiert der Browser mehrere Downloads
  }
  markSaved();
}

async function shareResults() {
  if (!state.shown) return;
  const files = state.shown.items.map((it) => new File([it.blob], it.filename, { type: it.blob.type }));
  try {
    await navigator.share({ files, title: files.length === 1 ? files[0].name : `${files.length} Fotos` });
    markSaved();
  } catch (err) {
    if (err.name !== 'AbortError') alert('Teilen nicht möglich: ' + err.message);
  }
}

async function withButtonBusy(button, text, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = text;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    alert('Fehler: ' + err.message);
  } finally {
    button.textContent = old;
    button.disabled = false;
  }
}

async function zipResults() {
  if (!state.shown) return;
  await withButtonBusy(el.btnZip, 'ZIP …', async () => {
    const items = state.shown.items;
    const zip = await Zip.create(items.map((it) => ({ name: it.filename, blob: it.blob, date: it.meta.date })));
    const first = items[0].meta;
    const name = makeFilename('Fotos', first.date, first.address, 'zip');
    const url = URL.createObjectURL(zip);
    downloadBlob(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    markSaved();
  });
}

/* ---------- PDF-Bericht ---------- */

/** Bild verkleinert als JPEG-Bytes für das PDF. */
async function jpegForPdf(source, maxSide, background) {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const sw = bmp.width || bmp.naturalWidth;
  const sh = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  const ctx = c.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  const blob = await canvasToBlob(c, 0.85);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
}

async function createReport(items) {
  const doc = new Pdf.Document();
  const M = 42;                      // Seitenrand
  const CW = doc.width - M * 2;      // nutzbare Breite
  const BOTTOM = doc.height - 50;
  const TEXT = '#0F172A';
  const MUTED = '#64748B';
  const now = trustedTime();

  const photos = items.filter((it) => it.kind !== 'video');
  const dates = photos.map((p) => p.meta.date).sort((a, b) => a - b);
  const addresses = [...new Set(photos.map((p) => oneLine(p.meta.address)).filter(Boolean))];

  // Kopf: Firmenlogo + Titel
  doc.newPage();
  let y = M;
  if (companyLogoReady) {
    const logo = await jpegForPdf(companyLogo, 600, '#ffffff');
    const lh = 46;
    const lw = Math.min(200, (logo.width / logo.height) * lh);
    doc.image(doc.addJpeg(logo.bytes, logo.width, logo.height), M, y, lw, lw / (logo.width / logo.height));
  }
  const title = 'Fotobericht';
  doc.text(title, doc.width - M - Pdf.textWidth(title, 22, true), y + 2, 22, { bold: true, color: TEXT });
  const created = `Erstellt am ${formatShortDate(now.date)}${now.verified ? ' (Zeit geprüft)' : ''}`;
  doc.text(created, doc.width - M - Pdf.textWidth(created, 9), y + 30, 9, { color: MUTED });
  if (settings.name) {
    const by = `Erstellt von ${settings.name}`;
    doc.text(by, doc.width - M - Pdf.textWidth(by, 9), y + 42, 9, { color: MUTED });
  }
  y += 62;
  doc.rect(M, y, CW, 2, '#0EA5E9');
  y += 16;

  // Übersicht
  const info = [];
  if (addresses.length === 1) info.push(['Adresse', addresses[0]]);
  else if (addresses.length > 1) info.push(['Adressen', addresses.join(' · ')]);
  if (dates.length) {
    const from = formatShortDate(dates[0]);
    const to = formatShortDate(dates[dates.length - 1]);
    info.push(['Zeitraum', from === to ? from : `${from} – ${to}`]);
  }
  info.push(['Anzahl Fotos', String(photos.length)]);
  for (const [label, value] of info) {
    doc.text(label, M, y, 10, { bold: true, color: MUTED });
    for (const line of Pdf.wrap(value, 10, false, CW - 90)) {
      doc.text(line, M + 90, y, 10, { color: TEXT });
      y += 14;
    }
    y += 2;
  }
  y += 12;

  // Fotos: 4 pro Seite (2 × 2), auch auf der ersten Seite. Alle Felder gleich groß,
  // die Größe richtet sich nach dem Platz unter dem Kopf der ersten Seite.
  // Ohne Bildunterschrift – Zeit, Adresse usw. stehen ja im Stempel.
  const GAP = 12;
  const cellW = (CW - GAP) / 2;
  const cellH = (BOTTOM - y - GAP) / 2;
  const fit = (img) => {
    let iw = cellW;
    let ih = (img.height / img.width) * iw;
    if (ih > cellH) {
      ih = cellH;
      iw = (img.width / img.height) * ih;
    }
    return { iw, ih };
  };
  for (let i = 0; i < photos.length; i += 2) {
    if (i > 0 && i % 4 === 0) {
      doc.newPage();
      y = M;
    }
    // Zwei Bilder nebeneinander, oben bündig; die Zeile ist so hoch wie das höhere Bild
    const row = [];
    for (const p of photos.slice(i, i + 2)) {
      const img = await jpegForPdf(p.blob, CONFIG.pdfImageMaxSide);
      row.push({ img, ...fit(img) });
    }
    row.forEach(({ img, iw, ih }, col) => {
      const cx = M + col * (cellW + GAP);
      doc.image(doc.addJpeg(img.bytes, img.width, img.height), cx + (cellW - iw) / 2, y, iw, ih);
    });
    y += Math.max(...row.map((r) => r.ih)) + GAP;
  }

  // Fußzeile auf jeder Seite
  doc.pages.forEach((page, i) => {
    doc.page = page;
    const footer = `Proofshot · Fotobericht · Seite ${i + 1} von ${doc.pages.length}`;
    doc.text(footer, (doc.width - Pdf.textWidth(footer, 8)) / 2, doc.height - 30, 8, { color: MUTED });
  });

  return doc.toBlob();
}

async function pdfResults() {
  if (!state.shown) return;
  await withButtonBusy(el.btnPdf, 'PDF wird erstellt …', async () => {
    const items = state.shown.items;
    const pdf = await createReport(items);
    const first = items[0].meta;
    const name = makeFilename('Bericht', first.date, first.address, 'pdf');
    const url = URL.createObjectURL(pdf);
    downloadBlob(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    markSaved();
  });
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
  updateSeriesUi();
  updateGpsUi();
  updateNoteUi();
  show(el.viewCamera);
  startCamera();
}

function openCamera(mode) {
  history.pushState({ view: 'camera' }, '');
  state.lens = 'main';
  enterCamera(mode);
}

function newShot() {
  const kind = state.shown ? state.shown.kind : state.mode;
  if (kind === 'compare') {
    pickBeforeImage(); // neues Vorher-Bild wählen, danach geht es weiter
    return;
  }
  leaveResult();
  history.replaceState({ view: 'camera' }, '');
  enterCamera(kind === 'series' ? 'photo' : kind);
}

/* ---------- Bestätigungsfenster im Stil der App ---------- */

let dialogResolve = null;
const isDialogOpen = () => el.dialog.classList.contains('open'); // während der Schließ-Animation schon „zu“

const DIALOG_ICONS = {
  warn: 'M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
};
let dialogInputMode = false;

/**
 * Fenster im Stil der App. Liefert true/false – oder mit „input“ den eingegebenen Text (bzw. null).
 */
function confirmDialog({ title, text, ok = 'OK', cancel = 'Abbrechen', danger = false, input = null, inputValue = '', icon = 'warn' }) {
  if (dialogResolve) dialogResolve(dialogInputMode ? null : false);
  dialogInputMode = input !== null;
  el.dialogIconPath.setAttribute('d', DIALOG_ICONS[icon] || DIALOG_ICONS.warn);
  el.dialogIcon.classList.toggle('dialog-icon-edit', icon === 'edit');
  el.dialogInput.classList.toggle('hidden', !dialogInputMode);
  el.dialogInput.value = inputValue || '';
  el.dialogInput.placeholder = dialogInputMode ? input : '';
  if (dialogInputMode) setTimeout(() => el.dialogInput.focus(), 60);
  el.dialogTitle.textContent = title;
  el.dialogText.textContent = text;
  el.dialogOk.textContent = ok;
  el.dialogCancel.textContent = cancel;
  el.dialogOk.classList.toggle('btn-danger', danger);
  el.dialog.classList.remove('hidden');
  requestAnimationFrame(() => el.dialog.classList.add('open'));
  return new Promise((resolve) => { dialogResolve = resolve; });
}

function closeDialog(result) {
  el.dialog.classList.remove('open');
  setTimeout(() => { if (!el.dialog.classList.contains('open')) el.dialog.classList.add('hidden'); }, 180);
  const r = dialogResolve;
  dialogResolve = null;
  if (el.dialogInput === document.activeElement) el.dialogInput.blur();
  if (r) r(dialogInputMode ? (result ? el.dialogInput.value.trim() : null) : result);
}

/** Wurde eine Serie noch nicht gespeichert oder geteilt? */
const seriesUnsaved = () => state.series.length > 0 && !state.seriesSaved;

/** Zur Startseite (eine nicht gespeicherte Serie wird vorher über askDiscardSeries abgefragt). */
function showStart() {
  if (Editor.isOpen()) Editor.hide();
  if (isSettingsOpen()) hideSettings();
  if (isViewerOpen()) hideViewer();
  if (isDialogOpen()) closeDialog(false);
  if (isSheetOpen()) hideSheet();
  stopCamera();
  leaveResult();
  clearBefore();
  discardSeries();
  show(el.viewStart);
  fitStartPage();
}

async function askDiscardSeries() {
  const n = state.series.length;
  return confirmDialog({
    title: 'Serie noch nicht gespeichert',
    text: `${n === 1 ? 'Das Foto' : `Die ${n} Fotos`} der Serie ${n === 1 ? 'wurde' : 'wurden'} noch nicht heruntergeladen oder geteilt. Im Verlauf ${n === 1 ? 'bleibt es' : 'bleiben sie'} 30 Tage erhalten.`,
    ok: 'Trotzdem verlassen',
    cancel: 'Zurück',
    danger: true,
  });
}

// Zurück (Button oder Android-Zurück-Taste) führt immer zur Startseite
function goBack() {
  if (history.state && history.state.view !== 'start') history.back();
  else showStart();
}

window.addEventListener('popstate', () => {
  if (skipPop > 0) {
    skipPop--;
    return;
  }
  if (isDialogOpen()) {
    // Zurück-Taste bei offenem Fenster = Abbrechen (Seite bleibt, wie sie ist)
    skipPop++;
    history.forward();
    closeDialog(false);
    return;
  }
  if (Editor.isOpen()) {
    if (Editor.hasChanges()) {
      // erst nachfragen – Seite bleibt so lange offen
      skipPop++;
      history.forward();
      Editor.cancel();
    } else {
      Editor.hide();
    }
    return;
  }
  if (isSettingsOpen()) {
    hideSettings();
    return;
  }
  if (isViewerOpen()) {
    hideViewer();
    return;
  }
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
  if (isVisible(el.viewResult) && state.shown && state.shown.fromHistory) {
    // Aus dem Verlauf geöffnet: zurück zum Verlauf
    const series = state.shown.kind === 'series';
    leaveResult();
    if (series) discardSeries();
    showHistory(false);
    return;
  }
  if (seriesUnsaved() && !isVisible(el.viewStart)) {
    // Erst nachfragen, solange auf der aktuellen Seite bleiben
    history.pushState({ view: isVisible(el.viewResult) ? 'result' : 'camera' }, '');
    askDiscardSeries().then((ok) => {
      if (!ok) return;
      discardSeries();
      history.back(); // jetzt ohne Rückfrage zur Startseite
    });
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
/* Einstellungen                                                       */
/* ------------------------------------------------------------------ */

const isSettingsOpen = () => !el.settings.classList.contains('hidden');

function updateNameUi() {
  el.nameRow.classList.toggle('hidden', !!settings.name);
  fitStartPage();
}

async function openSettings() {
  if (isSettingsOpen()) return;
  history.pushState({ view: 'settings' }, '');
  el.settingsName.value = settings.name;
  el.settingsPanel.style.transform = '';
  el.settings.classList.remove('hidden');
  requestAnimationFrame(() => el.settings.classList.add('open'));
  el.settingsStorage.textContent = `Aufnahmen werden ${HistoryStore.KEEP_DAYS} Tage lang nur auf diesem Handy gespeichert.`;
  try {
    const list = await HistoryStore.all();
    let used = '';
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      used = ` · belegt ${Math.max(1, Math.round((est.usage || 0) / 1048576))} MB`;
    }
    el.settingsStorage.textContent += ` Aktuell ${list.length} ${list.length === 1 ? 'Eintrag' : 'Einträge'}${used}.`;
  } catch (e) { /* egal */ }
}

function hideSettings() {
  el.settings.classList.remove('open');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  setTimeout(() => {
    if (!el.settings.classList.contains('open')) {
      el.settings.classList.add('hidden');
      el.settingsPanel.style.transform = '';
    }
  }, 240);
}

function closeSettings() {
  if (history.state && history.state.view === 'settings') history.back();
  else hideSettings();
}

function saveSettings() {
  settings.name = el.settingsName.value.trim().replace(/\s+/g, ' ').slice(0, 40);
  try { localStorage.setItem('hj.name', settings.name); } catch (e) { /* egal */ }
  updateNameUi();
  closeSettings();
}

async function clearHistory() {
  const ok = await confirmDialog({
    title: 'Verlauf leeren?',
    text: 'Alle Aufnahmen im Verlauf werden von diesem Handy gelöscht. Bereits heruntergeladene Dateien bleiben erhalten.',
    ok: 'Leeren',
    cancel: 'Zurück',
    danger: true,
  });
  if (!ok) return;
  await HistoryStore.clear().catch(() => {});
  el.settingsStorage.textContent = `Aufnahmen werden ${HistoryStore.KEEP_DAYS} Tage lang nur auf diesem Handy gespeichert. Der Verlauf ist leer.`;
}

/* ------------------------------------------------------------------ */
/* Verlauf                                                             */
/* ------------------------------------------------------------------ */

let historyUrls = [];

function dayLabel(d) {
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function showHistory(push = true) {
  if (push) history.pushState({ view: 'history' }, '');
  show(el.viewHistory);
  renderHistory();
}

async function renderHistory() {
  for (const u of historyUrls) URL.revokeObjectURL(u);
  historyUrls = [];
  const list = el.historyList;
  let entries = [];
  try {
    entries = (await HistoryStore.all()).sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    console.warn(e);
  }
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<div class="history-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3a9 9 0 0 0-9 9H1l3.9 3.9L8.8 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8z"/></svg>' +
      '<div class="history-empty-title">Noch keine Aufnahmen</div><div>Fotos, Videos und Serien erscheinen hier automatisch.</div></div>';
    return;
  }
  let lastDay = '';
  for (const e of entries) {
    const d = new Date(e.createdAt);
    const day = dayLabel(d);
    if (day !== lastDay) {
      const h = document.createElement('div');
      h.className = 'history-day';
      h.textContent = day;
      list.appendChild(h);
      lastDay = day;
    }
    const row = document.createElement('div');
    row.className = 'history-row';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    const thumb = document.createElement('div');
    thumb.className = 'history-thumb';
    if (e.thumb) {
      const url = URL.createObjectURL(e.thumb);
      historyUrls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      thumb.appendChild(img);
    }
    if (e.kind === 'video' || !e.thumb) {
      const ic = document.createElement('span');
      ic.className = 'history-kind-icon';
      ic.innerHTML = e.kind === 'video'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9z"/></svg>';
      thumb.appendChild(ic);
    }
    if (e.kind === 'series') {
      const n = document.createElement('span');
      n.className = 'history-count';
      n.textContent = String(e.count);
      thumb.appendChild(n);
    }

    const text = document.createElement('div');
    text.className = 'history-text';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = e.kind === 'series' ? `Serie · ${e.count} ${e.count === 1 ? 'Foto' : 'Fotos'}` : KIND_LABEL[e.kind] || 'Aufnahme';
    const sub = document.createElement('div');
    sub.className = 'history-sub';
    sub.textContent = [`${pad2(d.getHours())}:${pad2(d.getMinutes())} Uhr`, e.address ? oneLine(e.address) : ''].filter(Boolean).join(' · ');
    text.append(title, sub);
    if (e.note) {
      const note = document.createElement('div');
      note.className = 'history-note';
      note.textContent = e.note;
      text.appendChild(note);
    }

    const del = document.createElement('button');
    del.className = 'history-del';
    del.setAttribute('aria-label', 'Aus dem Verlauf löschen');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 7.1 16.9 5.7 12 10.6 7.1 5.7 5.7 7.1l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z"/></svg>';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await confirmDialog({
        title: 'Eintrag löschen?',
        text: `${title.textContent} vom ${formatShortDate(d)} wird aus dem Verlauf gelöscht. Bereits heruntergeladene Dateien bleiben erhalten.`,
        ok: 'Löschen',
        cancel: 'Zurück',
        danger: true,
      });
      if (!ok) return;
      await HistoryStore.remove(e.id).catch(() => {});
      renderHistory();
    });

    row.append(thumb, text, del);
    row.addEventListener('click', () => openHistoryEntry(e.id));
    list.appendChild(row);
  }
}

async function openHistoryEntry(id) {
  let entry = null;
  try { entry = await HistoryStore.get(id); } catch (e) { /* unten */ }
  if (!entry || !entry.items || !entry.items.length) {
    alert('Dieser Eintrag konnte nicht geladen werden.');
    renderHistory();
    return;
  }
  const items = entry.items.map(HistoryStore.fromStored);
  history.pushState({ view: 'result' }, '');
  if (entry.kind === 'series') {
    discardSeries();
    state.series = items;
    state.seriesNo = items.length;
    state.seriesSaved = true;
    state.seriesEntryId = entry.id;
    showResults('series', state.series, { entryId: entry.id, fromHistory: true });
  } else {
    showResults(entry.kind, items, { entryId: entry.id, fromHistory: true });
  }
}

/* Kamera-Infos zur Fehlersuche (Tippen auf die Versionsnummer) */
function showCameraInfo() {
  const lines = ['Kamera-Info'];
  if (state.lenses) {
    lines.push('Kameras:', ...state.lenses.labels.map((l) => '  ' + l));
    lines.push('Weitwinkel erkannt: ' + (state.lenses.wide ? 'ja' : 'nein'));
  } else {
    lines.push('Noch keine Kamera geöffnet – bitte erst einmal „Foto“ öffnen.');
  }
  lines.push(`Zeit geprüft: ${timeVerified() ? 'ja' : 'nein'}, Handyuhr ${Math.round(timeSync.deviceDiff / 1000)} s`);
  alert(lines.join('\n'));
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

// GPS und Zeitabgleich laufen schon auf der Startseite
startGps();
syncTime();
setInterval(() => { if (!document.hidden) syncTime(); }, CONFIG.timeSyncIntervalMs);

function on(element, handler, event = 'click') {
  if (element) element.addEventListener(event, handler);
  else showStartError('Seite unvollständig geladen – bitte App schließen und neu öffnen.');
}
on(el.btnOpenPhoto, () => {
  setSeriesMode(false); // von der Startseite immer mit „Einzeln“ beginnen
  openCamera('photo');
});
on(el.btnOpenVideo, () => openCamera('video'));
on(el.btnOpenCompare, pickBeforeImage);
on(el.beforeInput, onBeforePicked, 'change');
on(el.startVersion, showCameraInfo);
on(el.btnBack, goBack);
on(el.btnHome, goBack);
on(el.shutter, onShutter);
on(el.btnTorch, toggleTorch);
on(el.btnDetails, openSheet);
on(el.addrBtn, openSheet);
on(el.noteChip, openSheet);
on(el.btnGhost, () => { state.ghostOn = !state.ghostOn; updateGhostUi(); });
on(el.btnSeries, finishSeries);
on(el.shotMode, (e) => {
  const b = e.target.closest('button');
  if (b) setSeriesMode(b.dataset.mode === 'series');
});
on(el.sheetClose, closeSheet);
on(el.sheetApply, applySheet);
on(el.sheet, (e) => { if (e.target === el.sheet) closeSheet(); }); // Tippen neben das Fenster
on(el.noteClear, () => { el.noteInput.value = ''; el.noteInput.focus(); });
on(el.btnDownload, downloadResults);
on(el.btnShare, shareResults);
on(el.btnPdf, pdfResults);
on(el.btnZip, zipResults);
on(el.btnNew, newShot);
on(el.btnHistory, () => showHistory(true));
on(el.historyBack, goBack);
on(el.btnSettings, openSettings);
on(el.nameRow, openSettings);
on(el.settingsClose, closeSettings);
on(el.settingsSave, saveSettings);
on(el.settingsClear, clearHistory);
on(el.settings, (e) => { if (e.target === el.settings) closeSettings(); });
on(el.dialogInput, (e) => { if (e.key === 'Enter') closeDialog(true); }, 'keydown');
setupSheetDrag(el.settingsPanel, el.settingsGrab, () => closeSettings());
Editor.setup();
updateNameUi();
HistoryStore.prune().catch(() => {});
on(el.resultImg, () => { if (state.shown) openViewer([state.shown.items[0].url], 0, state.shown.items); });
on(el.zoomHint, () => { if (state.shown) openViewer([state.shown.items[0].url], 0, state.shown.items); });
on(el.viewerEdit, () => { if (viewer.items) annotateItem(viewer.items[viewer.index]); });
on(el.btnAnnotate, () => { if (state.shown) annotateItem(state.shown.items[0]); });
on(el.viewerClose, closeViewer);
on(el.viewerPrev, () => viewerStep(-1));
on(el.viewerNext, () => viewerStep(1));
on(el.dialogOk, () => closeDialog(true));
on(el.dialogCancel, () => closeDialog(false));
on(el.dialog, (e) => { if (e.target === el.dialog) closeDialog(false); });
history.replaceState({ view: 'start' }, '');

setSeriesMode(false);
updateTimeUi();

// Kamera und GPS pausieren, wenn die App im Hintergrund ist.
// Eine laufende Videoaufnahme wird dabei beendet und gespeichert.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.rec) stopRecording();
    else stopCamera();
    stopGps();
    timeSync.stale = true; // nach dem Ruhezustand neu abgleichen
  } else {
    startGps();
    syncTime();
    updateTimeUi();
    if (isVisible(el.viewCamera)) startCamera();
  }
});

// Anzeige regelmäßig aktualisieren (z. B. wenn die Position veraltet)
setInterval(() => { updateGpsUi(); updateTimeUi(); }, 5000);

/* Startseite automatisch einpassen: so lange kompakter, bis nichts mehr übersteht */
var fitFrame = null; // var: wird schon vor dieser Stelle (beim Start) benötigt
function fitStartPage() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    const v = el.viewStart;
    if (!isVisible(v)) return;
    v.classList.remove('fit-1', 'fit-2', 'fit-3');
    for (const level of ['fit-1', 'fit-2', 'fit-3']) {
      if (v.scrollHeight <= v.clientHeight + 1) break;
      v.classList.add(level);
    }
  });
}
window.addEventListener('resize', fitStartPage);
window.addEventListener('load', fitStartPage);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitStartPage);
// Texte (Adresse, Uhrzeit-Hinweis) ändern die Höhe – danach neu prüfen
new MutationObserver(fitStartPage).observe(el.viewStart.querySelector('.start-footer'), { childList: true, subtree: true, characterData: true });
fitStartPage();

/* Startseite: von oben nach unten ziehen = App aktualisieren (nur im oberen Drittel) */
(function setupPullToRefresh() {
  const view = el.viewStart;
  const ptr = $('ptr');
  const label = $('ptr-label');
  const THRESHOLD = 90;   // so weit (nach Dämpfung) muss gezogen werden
  let start = null;
  let pull = 0;
  let refreshing = false;

  const render = () => {
    const p = Math.min(pull / THRESHOLD, 1);
    ptr.style.transform = `translate(-50%, ${Math.min(pull, THRESHOLD * 1.3) - 70}px)`;
    ptr.style.opacity = String(Math.min(1, pull / 30));
    ptr.querySelector('svg').style.transform = `rotate(${p * 270}deg)`;
    ptr.classList.toggle('ready', pull >= THRESHOLD);
    label.textContent = pull >= THRESHOLD ? 'Loslassen zum Aktualisieren' : 'Zum Aktualisieren ziehen';
  };
  const reset = () => {
    pull = 0;
    ptr.classList.add('animate');
    render();
    setTimeout(() => ptr.classList.remove('animate'), 250);
  };

  view.addEventListener('pointerdown', (e) => {
    if (refreshing || !isVisible(view) || e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.clientY > window.innerHeight / 3) return; // nur im oberen Drittel
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  view.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    if (pull === 0 && Math.abs(e.clientX - start.x) > Math.abs(dy) && Math.abs(dy) < 10) return;
    pull = Math.max(0, dy * 0.55); // gedämpft
    if (pull > 0 && !view.hasPointerCapture(e.pointerId)) view.setPointerCapture(e.pointerId);
    render();
  });
  const end = async (e) => {
    if (!start || e.pointerId !== start.id) return;
    start = null;
    if (pull < THRESHOLD) { reset(); return; }
    refreshing = true;
    ptr.classList.add('animate', 'loading');
    pull = THRESHOLD;
    render();
    label.textContent = 'Wird aktualisiert …';
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) await Promise.race([reg.update(), sleep(3000)]);
    } catch (err) { /* trotzdem neu laden */ }
    location.reload();
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
  });
}
