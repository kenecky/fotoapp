'use strict';

/*
 * Markieren: Pfeil, Kreis, Stift und Text auf ein fertiges Foto zeichnen.
 * Die Markierungen werden in Bildkoordinaten (0…1) gespeichert und zum Schluss
 * in voller Auflösung über das Foto gelegt. Der Stempel bleibt unverändert.
 */
const Editor = (() => {
  const $e = (id) => document.getElementById(id);
  let st = null; // { item, bitmap, shapes, tool, color, drawing, onSave, cw, ch }

  const lineWidth = (w, h) => Math.max(3, Math.min(w, h) * 0.009);
  const darkText = (c) => c === '#FFFFFF' || c === '#FACC15';

  function drawShape(ctx, s, W, H) {
    const lw = lineWidth(W, H);
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
      const fs = Math.max(14, Math.min(W, H) * 0.045);
      ctx.font = `700 ${fs}px system-ui, Roboto, Arial, sans-serif`;
      const [x, y] = P(s.a);
      const tw = ctx.measureText(s.text).width;
      const pad = fs * 0.35;
      ctx.shadowBlur = lw;
      roundRect(ctx, x - pad, y - fs / 2 - pad, tw + pad * 2, fs + pad * 2, fs * 0.25);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = darkText(s.color) ? '#0F172A' : '#FFFFFF';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.text, x, y + fs * 0.04);
    }
    ctx.restore();
  }

  function render() {
    if (!st) return;
    const c = $e('editor-canvas');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(st.bitmap, 0, 0, c.width, c.height);
    for (const s of st.shapes) drawShape(ctx, s, c.width, c.height);
    if (st.drawing) drawShape(ctx, st.drawing, c.width, c.height);
    $e('editor-undo').disabled = st.shapes.length === 0;
  }

  function layout() {
    if (!st) return;
    const stage = $e('editor-stage');
    const c = $e('editor-canvas');
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const s = Math.min(sw / st.bitmap.width, sh / st.bitmap.height);
    const cssW = Math.floor(st.bitmap.width * s);
    const cssH = Math.floor(st.bitmap.height * s);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.style.width = cssW + 'px';
    c.style.height = cssH + 'px';
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    render();
  }

  function norm(e) {
    const r = $e('editor-canvas').getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  }

  function setTool(tool) {
    st.tool = tool;
    for (const b of document.querySelectorAll('#editor-tools [data-tool]')) {
      b.classList.toggle('active', b.dataset.tool === tool);
    }
  }

  function setColor(color) {
    st.color = color;
    for (const b of document.querySelectorAll('#editor-colors [data-color]')) {
      b.classList.toggle('active', b.dataset.color === color);
    }
  }

  async function open(item, onSave) {
    const bitmap = await createImageBitmap(item.blob);
    st = { item, bitmap, shapes: [], tool: 'arrow', color: '#EF4444', drawing: null, onSave };
    setTool('arrow');
    setColor('#EF4444');
    history.pushState({ view: 'editor' }, '');
    $e('editor').classList.remove('hidden');
    requestAnimationFrame(layout);
  }

  const isOpen = () => !!st;

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

  // Zeichnen
  function setup() {
    const c = $e('editor-canvas');
    c.addEventListener('pointerdown', async (e) => {
      if (!st || st.drawing) return;
      const p = norm(e);
      if (st.tool === 'text') {
        const text = await confirmDialog({
          title: 'Text einfügen',
          text: 'Der Text erscheint an der angetippten Stelle.',
          ok: 'Einfügen',
          cancel: 'Abbrechen',
          input: 'z. B. Riss in der Wand',
          icon: 'edit',
        });
        if (text && st) {
          st.shapes.push({ type: 'text', color: st.color, a: p, text: text.slice(0, 60) });
          render();
        }
        return;
      }
      c.setPointerCapture(e.pointerId);
      st.drawing = { type: st.tool, color: st.color, a: p, b: p, pts: [p] };
      render();
    });
    c.addEventListener('pointermove', (e) => {
      if (!st || !st.drawing) return;
      const p = norm(e);
      st.drawing.b = p;
      if (st.drawing.type === 'pen') st.drawing.pts.push(p);
      render();
    });
    const end = () => {
      if (!st || !st.drawing) return;
      const d = st.drawing;
      st.drawing = null;
      const size = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
      if (d.type === 'pen' ? d.pts.length > 1 : size > 0.015) st.shapes.push(d);
      render();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    $e('editor-tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (b && st) setTool(b.dataset.tool);
    });
    $e('editor-colors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (b && st) setColor(b.dataset.color);
    });
    $e('editor-undo').addEventListener('click', () => {
      if (!st) return;
      st.shapes.pop();
      render();
    });
    $e('editor-cancel').addEventListener('click', cancel);
    $e('editor-done').addEventListener('click', save);
    window.addEventListener('resize', () => { if (st) layout(); });
  }

  const hasChanges = () => !!(st && st.shapes.length);

  return { open, isOpen, hide, cancel, setup, hasChanges };
})();
