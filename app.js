'use strict';

/*
 * Hier & Jetzt – Fotos und Videos aufnehmen und mit Zeitstempel, GPS-Koordinaten und Adresse stempeln.
 * Alles passiert im Browser. Es werden keine Daten auf einem Server gespeichert.
 * Für die Adresse wird nur die Position an OpenStreetMap (Nominatim) geschickt.
 */

const CONFIG = {
  jpegQuality: 0.92,
  gpsTimeoutMs: 8000,        // so lange wird beim Foto höchstens auf GPS gewartet
  maxPositionAgeMs: 30000,   // ältere Positionen gelten als veraltet
  addressTimeoutMs: 6000,
  addressReuseMeters: 30,    // bereits ermittelte Adresse wiederverwenden, wenn so nah
  addressMinIntervalMs: 10000,
  videoMaxSeconds: 120,      // Höchstlänge eines Videos
  videoFps: 30,
  videoBitsPerSecond: 5000000,
  audioBitsPerSecond: 128000,
};

const $ = (id) => document.getElementById(id);
const el = {
  viewStart: $('view-start'),
  viewCamera: $('view-camera'),
  viewBusy: $('view-busy'),
  viewResult: $('view-result'),
  btnOpenPhoto: $('btn-open-photo'),
  btnOpenVideo: $('btn-open-video'),
  startGps: $('start-gps'),
  startDot: $('start-dot'),
  startAddr: $('start-addr'),
  resultTitle: $('result-title'),
  btnBack: $('btn-back'),
  video: $('video'),
  gpsChip: $('gps-chip'),
  addrLine: $('addr-line'),
  camMessage: $('cam-message'),
  recInfo: $('rec-info'),
  recTime: $('rec-time'),
  shutter: $('btn-shutter'),
  busyText: $('busy-text'),
  resultImg: $('result-img'),
  resultVideo: $('result-video'),
  btnDownload: $('btn-download'),
  btnShare: $('btn-share'),
  btnNew: $('btn-new'),
  btnHome: $('btn-home'),
  canvas: $('canvas'),
};

const state = {
  mode: 'photo',           // 'photo' | 'video'
  stream: null,
  hasAudio: false,
  watchId: null,
  position: null,          // letzte GeolocationPosition
  gpsError: null,
  address: null,           // { lat, lon, text, time }
  addressPending: null,
  lastAddressRequest: 0,
  rec: null,               // laufende Videoaufnahme
  result: null,            // { blob, url, filename, kind }
};

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

function isVisible(view) {
  return !view.classList.contains('hidden');
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

  const isVideo = state.mode === 'video';
  const videoConstraints = {
    facingMode: { ideal: 'environment' },
    // Foto: so hoch wie möglich. Video: Full HD, damit die Aufnahme flüssig bleibt.
    width: { ideal: isVideo ? 1920 : 4096 },
    height: { ideal: isVideo ? 1080 : 4096 },
  };

  try {
    let stream;
    let note = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: isVideo });
    } catch (err) {
      if (!isVideo || err.name !== 'NotAllowedError' && err.name !== 'NotFoundError') throw err;
      // Mikrofon nicht erlaubt oder nicht vorhanden: Video ohne Ton
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      note = 'Mikrofon nicht verfügbar – Video wird ohne Ton aufgenommen.';
    }
    // Ansicht wurde inzwischen verlassen
    if (!isVisible(el.viewCamera)) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    state.stream = stream;
    state.hasAudio = stream.getAudioTracks().length > 0;
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    showCameraMessage(note);
    if (note) setTimeout(() => { if (el.camMessage.textContent === note) showCameraMessage(''); }, 4000);
    el.shutter.disabled = false;
  } catch (err) {
    console.error(err);
    el.shutter.disabled = true;
    if (err.name === 'NotAllowedError') {
      showCameraMessage('Kein Zugriff auf die Kamera. Bitte in den Chrome-Einstellungen Kamera (und für Videos Mikrofon) für diese Seite erlauben und neu laden.');
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
  let addr = state.address ? state.address.text.replace('\n', ', ') : '';
  el.gpsChip.textContent = text;
  el.gpsChip.className = 'chip chip-' + level;
  el.addrLine.textContent = addr;

  if (!addr && level === 'bad' && !p) addr = 'Fotos sind trotzdem möglich – ohne Standort im Stempel.';
  el.startGps.textContent = startText;
  el.startDot.className = 'gps-dot dot-' + level;
  el.startAddr.textContent = addr;
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

/** Holt die Adresse schon vorab (und während eines Videos laufend nach). */
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
/* Stempel                                                             */
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

/**
 * Zeichnet den Stempel (halbtransparenter Balken mit Text) auf eine eigene Fläche
 * in voller Bildbreite. Sie wird dann unten ins Foto bzw. in jedes Videobild gesetzt.
 */
function renderStamp(w, h, info, target) {
  const canvas = target || document.createElement('canvas');
  const ctx = canvas.getContext('2d');
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
    ctx.font = `700 ${fontSize}px ${family}`;
    for (const l of wrapText(ctx, 'Kein Standort verfügbar', maxWidth)) rows.push([l, true, '#ffb4ab']);
  }
  ctx.font = `400 ${fontSize}px ${family}`;
  if (info.address) {
    for (const l of wrapText(ctx, info.address, maxWidth)) rows.push([l, false, '#ffffff']);
  } else if (info.coords) {
    for (const l of wrapText(ctx, 'Adresse nicht verfügbar', maxWidth)) rows.push([l, false, '#ffd27a']);
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
    ctx.font = `${bold ? 700 : 400} ${fontSize}px ${family}`;
    ctx.fillStyle = color;
    ctx.fillText(text, pad, y);
    y += lineHeight;
  }
  return canvas;
}

/* ------------------------------------------------------------------ */
/* Foto                                                                */
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
      coords: pos ? formatCoords(pos) : null,
      address,
    });
    ctx.drawImage(stamp, 0, h - stamp.height);

    const blob = await canvasToBlob(canvas);
    stopCamera(); // Akku sparen, solange das Ergebnis angezeigt wird
    showResult(blob, `Foto_${fileTimestamp(takenAt)}.jpg`, 'photo');
  } catch (err) {
    console.error(err);
    alert('Fehler beim Erstellen des Fotos: ' + err.message);
    show(el.viewCamera);
    el.shutter.disabled = false;
  }
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
  let address = null;
  if (pos) {
    const a = cachedAddressFor(pos.coords.latitude, pos.coords.longitude);
    address = a ? a.text : null;
  }
  return {
    timestamp: formatTimestamp(now),
    coords: pos ? formatCoords(pos) : null,
    address,
  };
}

function formatDuration(sec) {
  return `${pad2(Math.floor(sec / 60))}:${pad2(Math.floor(sec % 60))}`;
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
    w, h, ctx,
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
    const key = info.timestamp + '|' + info.coords + '|' + info.address;
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

  // Anzeige: Aufnahmezeit, automatischer Stopp nach Höchstlänge
  el.viewCamera.classList.add('recording');
  el.recInfo.classList.remove('hidden');
  el.btnBack.disabled = true;
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
  el.recInfo.classList.add('hidden');
  el.viewCamera.classList.remove('recording');
  el.btnBack.disabled = false;
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
  showResult(blob, `Video_${fileTimestamp(rec.startedAt)}.${ext}`, 'video');
}

/* ------------------------------------------------------------------ */
/* Ergebnis: anzeigen, herunterladen, teilen                           */
/* ------------------------------------------------------------------ */

function showResult(blob, filename, kind) {
  clearResult();
  const url = URL.createObjectURL(blob);
  state.result = { blob, url, filename, kind };
  el.resultImg.classList.toggle('hidden', kind !== 'photo');
  el.resultVideo.classList.toggle('hidden', kind !== 'video');
  if (kind === 'photo') el.resultImg.src = url;
  else el.resultVideo.src = url;
  el.btnNew.textContent = kind === 'photo' ? 'Neues Foto' : 'Neues Video';
  el.resultTitle.textContent = kind === 'photo' ? 'Foto erstellt' : 'Video erstellt';

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
  if (state.mode !== mode) stopCamera(); // Video braucht zusätzlich das Mikrofon
  state.mode = mode;
  el.viewCamera.classList.toggle('mode-video', mode === 'video');
  el.shutter.setAttribute('aria-label', mode === 'video' ? 'Aufnahme starten/stoppen' : 'Foto aufnehmen');
  showCameraMessage('');
  show(el.viewCamera);
  startCamera();
}

function openCamera(mode) {
  history.pushState({ view: 'camera' }, '');
  enterCamera(mode);
}

function newShot() {
  const mode = state.result ? state.result.kind : state.mode;
  clearResult();
  history.replaceState({ view: 'camera' }, '');
  enterCamera(mode);
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
  if (state.rec || isVisible(el.viewBusy)) {
    // Während Aufnahme/Verarbeitung nicht wegnavigieren; laufende Aufnahme wird beendet und gespeichert
    history.pushState({ view: 'camera' }, '');
    stopRecording();
    return;
  }
  showStart();
});

function onShutter() {
  if (state.mode === 'photo') takePhoto();
  else if (state.rec) stopRecording();
  else startRecording();
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

function on(element, handler) {
  if (element) element.addEventListener('click', handler);
  else showStartError('Seite unvollständig geladen – bitte App schließen und neu öffnen.');
}
on(el.btnOpenPhoto, () => openCamera('photo'));
on(el.btnOpenVideo, () => openCamera('video'));
on(el.btnBack, goBack);
on(el.btnHome, goBack);
on(el.shutter, onShutter);
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
