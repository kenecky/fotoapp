'use strict';

/*
 * Markieren: Pfeil, Kreis, Stift und Text auf ein fertiges Foto zeichnen.
 *  - Werkzeug „Zoomen“ (Finger): mit zwei Fingern oder Doppeltippen vergrößern, mit einem Finger verschieben.
 *    Zwei Finger zoomen auch in allen anderen Werkzeugen.
 *  - Text: gedrückt halten = verschieben, kurz antippen = ändern/löschen.
 *  - Werkzeug „Löschen“: Markierung antippen (oder darüberwischen) entfernt sie.
 *  - Rückgängig nimmt jeden Schritt zurück (Zeichnen, Löschen, Verschieben, Text ändern).
 * Markierungen werden in Bildkoordinaten (0…1) gespeichert und zum Schluss in voller
 * Auflösung über das Foto gelegt. Der Stempel bleibt unverändert.
 */
const Editor = (() => {
  const $e = (id) => document.getElementById(id);
  const LONG_PRESS_MS = 380;
  const MOVE_TOLERANCE = 8;   // Pixel, ab denen eine Bewegung als Ziehen gilt
  const MAX_ZOOM = 6;
  const FONT = 'system-ui, Roboto, Arial, sans-serif';

  let st = null;
  // st: { item, bitmap, shapes, tool, color, drawing, moving, onSave,
  //       base: { bw, bh, sw, sh }, view: { z, tx, ty }, dpr }

  /* ---------- Zeichnen ---------- */

  // Größen relativ zum Bild; „scale“ macht Striche/Text feiner, wenn sie im Zoom entstanden sind
  const lineWidth = (W, H, s) => Math.max(1.2, Math.min(W, H) * 0.009 * (s.scale || 1));
  const textSize = (W, H, s) => Math.max(6, Math.min(W, H) * 0.045 * (s.scale || 1));
  const darkText = (c) => c === '#FFFFFF' || c === '#FACC15';

  function textRect(ctx, s, W, H) {
    const fs = textSize(W, H, s);
    ctx.font = `700 ${fs}px ${FONT}`;
    const tw = ctx.measureText(s.text).width;
    const pad = fs * 0.35;
    const x = s.a[0] * W;
    const y = s.a[1] * H;
    return { x: x - pad, y: y - fs / 2 - pad, w: tw + pad * 2, h: fs + pad * 2, fs, tx: x, ty: y };
  }

  function drawShape(ctx, s, W, H, highlight) {
    const lw = lineWidth(W, H, s);
    const P = (p) => [p[0] * W, p[1] * H];
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = lw * 0.8;

    if (s.type === 'arrow') {
      const [x1, y1] = P(s.a);
      const [x2, y2] = P(s.b);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = lw * 4.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
      ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    } else if (s.type === 'circle') {
      const [x1, y1] = P(s.a);
      const [x2, y2] = P(s.b);
      ctx.beginPath();
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.max(1, Math.abs(x2 - x1) / 2), Math.max(1, Math.abs(y2 - y1) / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.type === 'pen') {
      ctx.beginPath();
      s.pts.forEach((p, i) => {
        const [x, y] = P(p);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
    } else if (s.type === 'text') {
      const r = textRect(ctx, s, W, H);
      ctx.shadowBlur = lw;
      roundRect(ctx, r.x, r.y, r.w, r.h, r.fs * 0.25);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = darkText(s.color) ? '#0F172A' : '#FFFFFF';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.text, r.tx, r.ty + r.fs * 0.04);
      if (highlight) {
        ctx.setLineDash([r.fs * 0.3, r.fs * 0.2]);
        ctx.lineWidth = Math.max(1, r.fs * 0.08);
        ctx.strokeStyle = '#FFFFFF';
        roundRect(ctx, r.x - r.fs * 0.2, r.y - r.fs * 0.2, r.w + r.fs * 0.4, r.h + r.fs * 0.4, r.fs * 0.35);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function render() {
    if (!st) return;
    const c = $e('editor-canvas');
    const ctx = c.getContext('2d');
    const { bw, bh } = st.base;
    const { z, tx, ty } = st.view;
    const d = st.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(d * z, 0, 0, d * z, d * tx, d * ty);
    ctx.drawImage(st.bitmap, 0, 0, bw, bh);
    for (const s of st.shapes) drawShape(ctx, s, bw, bh, st.moving && st.moving.shape === s);
    if (st.drawing) drawShape(ctx, st.drawing, bw, bh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    $e('editor-undo').disabled = st.undo.length === 0;
    const zoomBtn = $e('editor-zoom');
    zoomBtn.classList.toggle('hidden', z <= 1.02);
    zoomBtn.textContent = `${String(Math.round(z * 10) / 10).replace('.', ',')}× · Zurücksetzen`;
  }

  /* ---------- Ansicht (Zoom / Verschieben) ---------- */

  function layout() {
    if (!st) return;
    const stage = $e('editor-stage');
    const c = $e('editor-canvas');
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.style.width = sw + 'px';
    c.style.height = sh + 'px';
    c.width = Math.round(sw * dpr);
    c.height = Math.round(sh * dpr);
    const s = Math.min(sw / st.bitmap.width, sh / st.bitmap.height);
    st.base = { bw: st.bitmap.width * s, bh: st.bitmap.height * s, sw, sh };
    st.dpr = dpr;
    resetView();
  }

  function resetView() {
    const { bw, bh, sw, sh } = st.base;
    st.view = { z: 1, tx: (sw - bw) / 2, ty: (sh - bh) / 2 };
    render();
  }

  function clampView() {
    const { bw, bh, sw, sh } = st.base;
    const v = st.view;
    const w = bw * v.z;
    const h = bh * v.z;
    v.tx = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, v.tx));
    v.ty = h <= sh ? (sh - h) / 2 : Math.min(0, Math.max(sh - h, v.ty));
  }

  function zoomAt(px, py, newZ) {
    const v = st.view;
    const z = Math.min(MAX_ZOOM, Math.max(1, newZ));
    v.tx = px - (px - v.tx) * (z / v.z);
    v.ty = py - (py - v.ty) * (z / v.z);
    v.z = z;
    clampView();
    render();
  }

  /** Bildschirmpunkt (im Canvas) -> Bildkoordinaten 0…1 */
  function toImage(cx, cy) {
    const { bw, bh } = st.base;
    const v = st.view;
    return [
      Math.min(1, Math.max(0, (cx - v.tx) / v.z / bw)),
      Math.min(1, Math.max(0, (cy - v.ty) / v.z / bh)),
    ];
  }

  function canvasPoint(e) {
    const r = $e('editor-canvas').getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Text unter dem Finger (oberster zuerst); mit „only“ nur diesen einen Text prüfen */
  function hitText(cx, cy, only) {
    const ctx = $e('editor-canvas').getContext('2d');
    const { bw, bh } = st.base;
    const v = st.view;
    for (let i = st.shapes.length - 1; i >= 0; i--) {
      const s = st.shapes[i];
      if (s.type !== 'text' || (only && s !== only)) continue;
      const r = textRect(ctx, s, bw, bh);
      const grow = 10; // etwas größere Trefferfläche
      const x = v.tx + r.x * v.z - grow;
      const y = v.ty + r.y * v.z - grow;
      if (cx >= x && cx <= x + r.w * v.z + grow * 2 && cy >= y && cy <= y + r.h * v.z + grow * 2) return s;
    }
    return null;
  }

  /* ---------- Rückgängig ---------- */

  /** Zwischenstand merken – vor jeder Änderung aufrufen. */
  function remember() {
    st.undo.push(JSON.parse(JSON.stringify(st.shapes)));
    if (st.undo.length > 50) st.undo.shift();
  }

  function undo() {
    if (!st || !st.undo.length) return;
    st.shapes = st.undo.pop();
    st.moving = null;
    render();
  }

  /* ---------- Löschen ---------- */

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /** Markierung unter dem Finger (oberste zuerst), Prüfung in Bildschirm-Koordinaten. */
  function hitShape(cx, cy) {
    const { bw, bh } = st.base;
    const v = st.view;
    const S = (p) => [v.tx + p[0] * bw * v.z, v.ty + p[1] * bh * v.z];
    for (let i = st.shapes.length - 1; i >= 0; i--) {
      const s = st.shapes[i];
      const tol = 16 + (lineWidth(bw, bh, s) * v.z) / 2;
      if (s.type === 'text') {
        if (hitText(cx, cy, s)) return s;
      } else if (s.type === 'arrow') {
        const [x1, y1] = S(s.a);
        const [x2, y2] = S(s.b);
        if (distToSegment(cx, cy, x1, y1, x2, y2) <= tol) return s;
      } else if (s.type === 'circle') {
        const [x1, y1] = S(s.a);
        const [x2, y2] = S(s.b);
        const rx = Math.max(1, Math.abs(x2 - x1) / 2);
        const ry = Math.max(1, Math.abs(y2 - y1) / 2);
        const d = Math.hypot((cx - (x1 + x2) / 2) / rx, (cy - (y1 + y2) / 2) / ry);
        if (d <= 1 || (d - 1) * Math.min(rx, ry) <= tol) return s; // innen oder am Rand
      } else if (s.type === 'pen') {
        const pts = s.pts.map(S);
        for (let k = 1; k < pts.length; k++) {
          if (distToSegment(cx, cy, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]) <= tol) return s;
        }
      }
    }
    return null;
  }

  /** Löscht die Markierung unter dem Finger; ein Zwischenstand pro Wischbewegung. */
  function eraseAt(cx, cy, gesture) {
    const s = hitShape(cx, cy);
    if (!s) return;
    if (!gesture.remembered) {
      remember();
      gesture.remembered = true;
    }
    st.shapes.splice(st.shapes.indexOf(s), 1);
    if (navigator.vibrate) navigator.vibrate(10);
    render();
  }

  /* ---------- Werkzeuge ---------- */

  function setTool(tool) {
    st.tool = tool;
    for (const b of document.querySelectorAll('#editor-tools [data-tool]')) {
      b.classList.toggle('active', b.dataset.tool === tool);
    }
    $e('editor-stage').classList.toggle('hand', tool === 'hand');
    $e('editor-stage').classList.toggle('erase', tool === 'erase');
    $e('editor-hint').classList.toggle('hidden', tool !== 'erase');
  }

  function setColor(color) {
    st.color = color;
    for (const b of document.querySelectorAll('#editor-colors [data-color]')) {
      b.classList.toggle('active', b.dataset.color === color);
    }
  }

  async function addText(p) {
    const text = await confirmDialog({
      title: 'Text einfügen',
      text: 'Der Text erscheint an der angetippten Stelle. Gedrückt halten zum Verschieben.',
      ok: 'Einfügen',
      cancel: 'Abbrechen',
      input: 'z. B. Riss in der Wand',
      icon: 'edit',
    });
    if (text && st) {
      remember();
      st.shapes.push({ type: 'text', color: st.color, a: p, text: text.slice(0, 60), scale: 1 / st.view.z });
      render();
    }
  }

  async function editText(shape) {
    const text = await confirmDialog({
      title: 'Text ändern',
      text: 'Leer lassen, um den Text zu löschen.',
      ok: 'Übernehmen',
      cancel: 'Abbrechen',
      input: 'Text',
      inputValue: shape.text,
      icon: 'edit',
    });
    if (text === null || !st) return;
    remember();
    if (text) shape.text = text.slice(0, 60);
    else st.shapes.splice(st.shapes.indexOf(shape), 1);
    render();
  }

  /* ---------- Öffnen / Schließen / Speichern ---------- */

  async function open(item, onSave) {
    const bitmap = await createImageBitmap(item.blob);
    st = { item, bitmap, shapes: [], undo: [], tool: 'arrow', color: '#EF4444', drawing: null, moving: null, onSave };
    setTool('arrow');
    setColor('#EF4444');
    history.pushState({ view: 'editor' }, '');
    $e('editor').classList.remove('hidden');
    requestAnimationFrame(layout);
  }

  const isOpen = () => !!st;
  const hasChanges = () => !!(st && st.shapes.length);

  function hide() {
    $e('editor').classList.add('hidden');
    if (st && st.bitmap.close) st.bitmap.close();
    st = null;
  }

  function close() {
    hide();
    popEntry('editor'); // eigenen Verlaufseintrag entfernen
  }

  /** Abbrechen – bei vorhandenen Markierungen erst nachfragen. */
  async function cancel() {
    if (!st) return;
    if (st.shapes.length) {
      const ok = await confirmDialog({
        title: 'Markierungen verwerfen?',
        text: 'Die Markierungen auf diesem Foto werden nicht gespeichert.',
        ok: 'Verwerfen',
        cancel: 'Zurück',
        danger: true,
      });
      if (!ok) return;
    }
    close();
  }

  /** Markierungen in voller Auflösung ins Foto schreiben. */
  async function save() {
    if (!st) return;
    if (!st.shapes.length) { close(); return; }
    const btn = $e('editor-done');
    btn.disabled = true;
    try {
      const { bitmap, shapes, item, onSave } = st;
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      for (const s of shapes) drawShape(ctx, s, c.width, c.height);
      let blob = await canvasToBlob(c);
      try { blob = await Exif.insert(blob, exifMetaFor(item)); } catch (e) { /* ohne EXIF */ }
      close();
      await onSave(blob);
    } catch (err) {
      console.error(err);
      alert('Markierungen konnten nicht gespeichert werden: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Gesten ---------- */

  function setup() {
    const c = $e('editor-canvas');
    const pointers = new Map();
    let pinch = null;
    let gesture = null; // { id, x, y, t, hit, mode: null|'draw'|'pan'|'move'|'none', timer, tx, ty, off }
    let lastTap = null;

    const endGesture = () => {
      if (gesture && gesture.timer) clearTimeout(gesture.timer);
      gesture = null;
    };

    const startDrawing = (x, y) => {
      const p = toImage(x, y);
      st.drawing = { type: st.tool, color: st.color, a: p, b: p, pts: [p], scale: 1 / st.view.z };
    };

    c.addEventListener('pointerdown', (e) => {
      if (!st) return;
      c.setPointerCapture(e.pointerId);
      const pt = canvasPoint(e);
      pointers.set(e.pointerId, pt);

      if (pointers.size === 2) {
        // Zweiter Finger: angefangenen Strich verwerfen, stattdessen zoomen
        st.drawing = null;
        st.moving = null;
        endGesture();
        const [a, b] = [...pointers.values()];
        pinch = {
          d: Math.hypot(a.x - b.x, a.y - b.y),
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          z: st.view.z, tx: st.view.tx, ty: st.view.ty,
        };
        render();
        return;
      }
      if (pointers.size > 2) return;

      if (st.tool === 'erase') {
        gesture = { id: e.pointerId, x: pt.x, y: pt.y, t: Date.now(), hit: null, mode: 'erase', timer: null };
        eraseAt(pt.x, pt.y, gesture);
        return;
      }

      const hit = hitText(pt.x, pt.y);
      gesture = { id: e.pointerId, x: pt.x, y: pt.y, t: Date.now(), hit, mode: null, timer: null };
      if (hit) {
        // Gedrückt halten auf einem Text = verschieben
        gesture.timer = setTimeout(() => {
          if (!gesture || gesture.mode || !st) return;
          gesture.mode = 'move';
          remember();
          const p = toImage(gesture.x, gesture.y);
          gesture.off = [hit.a[0] - p[0], hit.a[1] - p[1]];
          st.moving = { shape: hit };
          if (navigator.vibrate) navigator.vibrate(15);
          render();
        }, LONG_PRESS_MS);
      } else if (['arrow', 'circle', 'pen'].includes(st.tool)) {
        gesture.mode = 'draw';
        startDrawing(pt.x, pt.y);
        render();
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (!st || !pointers.has(e.pointerId)) return;
      const pt = canvasPoint(e);
      pointers.set(e.pointerId, pt);

      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const z = Math.min(MAX_ZOOM, Math.max(1, pinch.z * (d / pinch.d)));
        st.view.z = z;
        st.view.tx = mid.x - (pinch.mid.x - pinch.tx) * (z / pinch.z);
        st.view.ty = mid.y - (pinch.mid.y - pinch.ty) * (z / pinch.z);
        clampView();
        render();
        return;
      }
      if (!gesture || e.pointerId !== gesture.id) return;

      const dx = pt.x - gesture.x;
      const dy = pt.y - gesture.y;
      if (!gesture.mode && Math.hypot(dx, dy) > MOVE_TOLERANCE) {
        clearTimeout(gesture.timer);
        if (st.tool === 'hand') {
          gesture.mode = 'pan';
          gesture.tx = st.view.tx;
          gesture.ty = st.view.ty;
        } else if (['arrow', 'circle', 'pen'].includes(st.tool)) {
          gesture.mode = 'draw'; // auf einem Text losgezogen: normal zeichnen
          startDrawing(gesture.x, gesture.y);
        } else {
          gesture.mode = 'none';
        }
      }

      if (gesture.mode === 'erase') {
        eraseAt(pt.x, pt.y, gesture); // darüberwischen löscht ebenfalls
      } else if (gesture.mode === 'draw' && st.drawing) {
        const p = toImage(pt.x, pt.y);
        st.drawing.b = p;
        if (st.drawing.type === 'pen') st.drawing.pts.push(p);
        render();
      } else if (gesture.mode === 'pan') {
        st.view.tx = gesture.tx + dx;
        st.view.ty = gesture.ty + dy;
        clampView();
        render();
      } else if (gesture.mode === 'move' && st.moving) {
        const p = toImage(pt.x, pt.y);
        st.moving.shape.a = [
          Math.min(1, Math.max(0, p[0] + gesture.off[0])),
          Math.min(1, Math.max(0, p[1] + gesture.off[1])),
        ];
        render();
      }
    });

    const up = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const pt = canvasPoint(e);
      pointers.delete(e.pointerId);
      if (!st) return;
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        endGesture();
        return;
      }
      if (!gesture || e.pointerId !== gesture.id) return;
      const g = gesture;
      endGesture();

      if (g.mode === 'draw' && st.drawing) {
        const d = st.drawing;
        st.drawing = null;
        const size = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * st.view.z;
        if (d.type === 'pen' ? d.pts.length > 1 : size > 0.015) {
          remember();
          st.shapes.push(d);
        }
        render();
      } else if (g.mode === 'move') {
        st.moving = null;
        render();
      } else if (!g.mode && e.type === 'pointerup') {
        // Kurz angetippt
        if (g.hit) {
          editText(g.hit);
        } else if (st.tool === 'text') {
          addText(toImage(pt.x, pt.y));
        } else if (st.tool === 'hand') {
          const now = Date.now();
          if (lastTap && now - lastTap.t < 320 && Math.hypot(pt.x - lastTap.x, pt.y - lastTap.y) < 30) {
            if (st.view.z > 1.05) resetView();
            else zoomAt(pt.x, pt.y, 2.5);
            lastTap = null;
          } else {
            lastTap = { t: now, x: pt.x, y: pt.y };
          }
        }
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);

    // Mausrad am Computer
    c.addEventListener('wheel', (e) => {
      if (!st) return;
      e.preventDefault();
      const pt = canvasPoint(e);
      zoomAt(pt.x, pt.y, st.view.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });

    $e('editor-tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (b && st) setTool(b.dataset.tool);
    });
    $e('editor-colors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (b && st) setColor(b.dataset.color);
    });
    $e('editor-undo').addEventListener('click', undo);
    $e('editor-zoom').addEventListener('click', () => { if (st) resetView(); });
    $e('editor-cancel').addEventListener('click', cancel);
    $e('editor-done').addEventListener('click', save);
    window.addEventListener('resize', () => { if (st) layout(); });
  }

  return { open, isOpen, hasChanges, hide, cancel, setup };
})();
