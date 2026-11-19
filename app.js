'use strict';

/*
 * FotoApp – Foto aufnehmen und mit Zeitstempel, GPS-Koordinaten und Adresse stempeln.
 * Alles passiert im Browser. Es werden keine Daten auf einem Server gespeichert.
 * Für die Adresse wird nur die Position an OpenStreetMap (Nominatim) geschickt.
 */

const CONFIG = {
  jpegQuality: 0.92,
  gpsTimeoutMs: 8000,        // so lange wird beim Auslösen höchstens auf GPS gewartet
  maxPositionAgeMs: 30000,   // ältere Positionen gelten als veraltet
  addressTimeoutMs: 6000,
  addressReuseMeters: 30,    // bereits ermittelte Adresse wiederverwenden, wenn so nah
  addressMinIntervalMs: 10000,
};

const $ = (id) => document.getElementById(id);
const el = {
  viewStart: $('view-start'),
  btnOpenCamera: $('btn-open-camera'),
  startGps: $('start-gps'),
  startAddr: $('start-addr'),
  btnBack: $('btn-back'),
  btnHome: $('btn-home'),
  viewCamera: $('view-camera'),
  viewBusy: $('view-busy'),
  viewResult: $('view-result'),
  video: $('video'),
  gpsChip: $('gps-chip'),
  addrLine: $('addr-line'),
  camMessage: $('cam-message'),
  shutter: $('btn-shutter'),
  busyText: $('busy-text'),
  resultImg: $('result-img'),
  btnDownload: $('btn-download'),
  btnShare: $('btn-share'),
  btnNew: $('btn-new'),
  canvas: $('canvas'),
};

const state = {
  stream: null,
  watchId: null,
  position: null,          // letzte GeolocationPosition
  gpsError: null,
  address: null,           // { lat, lon, text, time }
  addressPending: null,
  lastAddressRequest: 0,
  result: null,            // { blob, url, filename }
};

/* ------------------------------------------------------------------ */
/* Ansichten                                                           */
/* ------------------------------------------------------------------ */

function show(view) {
  for (const v of [el.viewStart, el.viewCamera, el.viewBusy, el.viewResult]) {
    v.classList.toggle('hidden', v !== view);
  }
}

function showCameraMessage(text) {
  el.camMessage.textContent = text;
  el.camMessage.classList.toggle('hidden', !text);
}

/* ------------------------------------------------------------------ */
/* Kamera                                                              */
/* ------------------------------------------------------------------ */

async function startCamera() {
  if (state.stream) return;
  if (!window.isSecureContext) {
    showCameraMessage('Die App muss über HTTPS geöffnet werden, sonst sind Kamera und GPS gesperrt.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraMessage('Dieser Browser unterstützt keinen Kamerazugriff. Bitte Chrome verwenden.');
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 4096 },
        height: { ideal: 4096 },
      },
    });
    el.video.srcObject = state.stream;
    await el.video.play().catch(() => {});
    showCameraMessage('');
    el.shutter.disabled = false;
  } catch (err) {
    console.error(err);
    el.shutter.disabled = true;
    if (err.name === 'NotAllowedError') {
      showCameraMessage('Kein Zugriff auf die Kamera. Bitte in den Chrome-Einstellungen die Kamera für diese Seite erlauben und neu laden.');
    } else if (err.name === 'NotFoundError') {
      showCameraMessage('Keine Kamera gefunden.');
    } else {
      showCameraMessage('Kamera konnte nicht gestartet werden: ' + err.message);
    }
  }
}

function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  el.video.srcObject = null;
  el.shutter.disabled = true;
}

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

function updateGpsUi() {
  const p = freshPosition();
  let text, cls;
  if (p) {
    const acc = Math.round(p.coords.accuracy);
    text = `GPS ±${acc} m`;
    cls = acc <= 20 ? 'chip-good' : acc <= 100 ? 'chip-medium' : 'chip-bad';
  } else if (state.gpsError) {
    text = state.gpsError;
    cls = 'chip-bad';
  } else {
    text = 'GPS wird gesucht …';
    cls = 'chip-wait';
  }
  const addr = state.address ? state.address.text.replace('\n', ', ') : '';
  for (const chip of [el.gpsChip, el.startGps]) {
    chip.textContent = text;
    chip.className = 'chip ' + cls;
  }
  el.addrLine.textContent = addr;
  el.startAddr.textContent = addr;
}

/** Wartet beim Auslösen kurz auf eine aktuelle Position, falls noch keine da ist. */
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
/* Adresse (Reverse Geocoding über OpenStreetMap / Nominatim)          */
/* ------------------------------------------------------------------ */

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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
  const text = [line1, line2].filter(Boolean).join('\n');
  return text || data.display_name || '';
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
    const text = formatAddress(await res.json());
    if (!text) return null;
    state.address = { lat, lon, text, time: Date.now() };
    updateGpsUi();
    return state.address;
  } catch (err) {
    console.warn('Adresse nicht ermittelbar:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Holt die Adresse schon während der Vorschau, damit das Auslösen schnell geht. */
function prefetchAddress(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  if (accuracy > 200 || !navigator.onLine) return;
  if (cachedAddressFor(lat, lon) || state.addressPending) return;
  if (Date.now() - state.lastAddressRequest < CONFIG.addressMinIntervalMs) return;
  state.addressPending = fetchAddress(lat, lon).finally(() => { state.addressPending = null; });
}

async function getAddressForPhoto(pos) {
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
/* Foto aufnehmen und stempeln                                         */
/* ------------------------------------------------------------------ */

function pad2(n) { return String(n).padStart(2, '0'); }

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

function fileTimestamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
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

function drawStamp(ctx, w, h, info) {
  const base = Math.min(w, h);
  const fontSize = Math.max(14, Math.round(base * 0.032));
  const lineHeight = Math.round(fontSize * 1.3);
  const pad = Math.round(fontSize * 0.8);
  const maxWidth = w - pad * 2;
  const family = 'system-ui, Roboto, "Segoe UI", Arial, sans-serif';

  // Zeilen zusammenstellen: [text, fett?, farbe]
  const rows = [];
  ctx.font = `700 ${fontSize}px ${family}`;
  for (const l of wrapText(ctx, info.timestamp, maxWidth)) rows.push([l, true, '#ffffff']);

  ctx.font = `400 ${fontSize}px ${family}`;
  if (info.coords) {
    for (const l of wrapText(ctx, info.coords, maxWidth)) rows.push([l, false, '#ffffff']);
  } else {
    for (const l of wrapText(ctx, 'Kein Standort verfügbar', maxWidth)) rows.push([l, true, '#ffb4ab']);
  }
  if (info.address) {
    for (const l of wrapText(ctx, info.address, maxWidth)) rows.push([l, false, '#ffffff']);
  } else if (info.coords) {
    for (const l of wrapText(ctx, 'Adresse nicht verfügbar', maxWidth)) rows.push([l, false, '#ffd27a']);
  }

  const boxHeight = rows.length * lineHeight + pad * 2;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, h - boxHeight, w, boxHeight);

  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = Math.round(fontSize * 0.15);
  let y = h - boxHeight + pad + Math.round((lineHeight - fontSize) / 2);
  for (const [text, bold, color] of rows) {
    ctx.font = `${bold ? 700 : 400} ${fontSize}px ${family}`;
    ctx.fillStyle = color;
    ctx.fillText(text, pad, y);
    y += lineHeight;
  }
  ctx.shadowBlur = 0;
}

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

  show(el.viewBusy);

  try {
    // 2. Position und Adresse
    el.busyText.textContent = freshPosition() ? 'Adresse wird ermittelt …' : 'Standort wird ermittelt …';
    const pos = await getPositionForPhoto();
    el.busyText.textContent = 'Adresse wird ermittelt …';
    const address = await getAddressForPhoto(pos);

    // 3. Stempel zeichnen
    el.busyText.textContent = 'Foto wird gespeichert …';
    drawStamp(ctx, w, h, {
      timestamp: formatTimestamp(takenAt),
      coords: pos ? formatCoords(pos) : null,
      address,
    });

    const blob = await canvasToBlob(canvas);
    setResult(blob, `Foto_${fileTimestamp(takenAt)}.jpg`);
    stopCamera(); // Akku sparen, solange das Ergebnis angezeigt wird
    history.replaceState({ view: 'result' }, '');
    show(el.viewResult);
  } catch (err) {
    console.error(err);
    alert('Fehler beim Erstellen des Fotos: ' + err.message);
    show(el.viewCamera);
    el.shutter.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Ergebnis: anzeigen, herunterladen, teilen                           */
/* ------------------------------------------------------------------ */

function setResult(blob, filename) {
  clearResult();
  const url = URL.createObjectURL(blob);
  state.result = { blob, url, filename };
  el.resultImg.src = url;
  const file = new File([blob], filename, { type: 'image/jpeg' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  el.btnShare.classList.toggle('hidden', !canShare);
}

function clearResult() {
  if (state.result) URL.revokeObjectURL(state.result.url);
  state.result = null;
  el.resultImg.removeAttribute('src');
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
  const file = new File([state.result.blob], state.result.filename, { type: 'image/jpeg' });
  try {
    await navigator.share({ files: [file], title: state.result.filename });
  } catch (err) {
    if (err.name !== 'AbortError') alert('Teilen nicht möglich: ' + err.message);
  }
}

function newPhoto() {
  clearResult();
  history.replaceState({ view: 'camera' }, '');
  show(el.viewCamera);
  startCamera();
}

/* ------------------------------------------------------------------ */
/* Navigation (Startseite <-> Kamera, inkl. Android-Zurück-Taste)       */
/* ------------------------------------------------------------------ */

function openCamera() {
  history.pushState({ view: 'camera' }, '');
  show(el.viewCamera);
  startCamera();
}

function showStart() {
  stopCamera();
  clearResult();
  show(el.viewStart);
}

// Zurück (Button oder Android-Zurück-Taste) führt immer zur Startseite
function goBack() {
  if (history.state && history.state.view !== 'start') history.back();
  else showStart();
}

window.addEventListener('popstate', () => {
  if (!el.viewBusy.classList.contains('hidden')) {
    // Während der Verarbeitung nicht wegnavigieren
    history.pushState({ view: 'camera' }, '');
    return;
  }
  showStart();
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

el.btnOpenCamera.addEventListener('click', openCamera);
el.btnBack.addEventListener('click', goBack);
el.btnHome.addEventListener('click', goBack);
el.shutter.addEventListener('click', takePhoto);
el.btnDownload.addEventListener('click', downloadResult);
el.btnShare.addEventListener('click', shareResult);
el.btnNew.addEventListener('click', newPhoto);
history.replaceState({ view: 'start' }, '');

// Kamera und GPS pausieren, wenn die App im Hintergrund ist
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCamera();
    stopGps();
  } else {
    startGps();
    if (!el.viewCamera.classList.contains('hidden')) startCamera();
  }
});

// Anzeige regelmäßig aktualisieren (z. B. wenn die Position veraltet)
setInterval(updateGpsUi, 5000);

// GPS läuft schon auf der Startseite, damit beim Foto sofort ein Standort da ist
startGps();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
  });
}
