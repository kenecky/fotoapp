'use strict';

/*
 * PDF- und ZIP-Erzeugung direkt im Browser (ohne fremde Bibliotheken, ohne Server).
 *  - Pdf.Document: einfache PDF-Seiten mit Text (Helvetica), Rechtecken, Linien und JPEG-Bildern
 *  - Zip.create(files): ZIP-Archiv (ohne Kompression – JPEGs sind schon komprimiert)
 */

const Pdf = (() => {
  const PAGE_W = 595.28; // A4 in Punkt
  const PAGE_H = 841.89;

  // Zeichen außerhalb von Latin-1, die WinAnsi trotzdem kennt
  const WIN = {
    '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92,
    '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  };

  function encode(str) {
    const out = [];
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (c < 128) out.push(c);
      else if (WIN[ch]) out.push(WIN[ch]);
      else if (c >= 160 && c <= 255) out.push(c);
      else out.push(63); // '?'
    }
    return out;
  }

  function pdfString(str) {
    let s = '(';
    for (const b of encode(str)) {
      if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
      else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
      else s += String.fromCharCode(b);
    }
    return s + ')';
  }

  // Zeichenbreiten (1/1000 em) für Helvetica und Helvetica-Bold, Zeichen 32–126
  const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
    500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722,
    500, 500, 500, 334, 260, 334, 584];
  const HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556,
    722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556,
    611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556,
    556, 500, 389, 280, 389, 584];
  const EXTRA = {
    'ä': 556, 'ö': 556, 'ü': 556, 'Ä': 667, 'Ö': 778, 'Ü': 722, 'ß': 611, '°': 400, '±': 584, '×': 584,
    '–': 556, '—': 1000, '„': 333, '“': 333, '”': 333, '·': 278, '…': 1000, '•': 350,
  };

  function textWidth(str, size, bold) {
    const table = bold ? HELV_B : HELV;
    let w = 0;
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      w += c >= 32 && c <= 126 ? table[c - 32] : (EXTRA[ch] || 600) * (bold ? 1.05 : 1);
    }
    return (w * size) / 1000;
  }

  /** Bricht Text in Zeilen um, die in maxWidth passen. */
  function wrap(str, size, bold, maxWidth) {
    const lines = [];
    for (const para of String(str).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const test = line ? line + ' ' + word : word;
        if (textWidth(test, size, bold) <= maxWidth || !line) {
          line = test;
        } else {
          lines.push(line);
          line = word;
        }
        // sehr lange Wörter hart umbrechen
        while (textWidth(line, size, bold) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > maxWidth) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      lines.push(line);
    }
    return lines;
  }

  const num = (n) => (Math.round(n * 100) / 100).toString();

  function rgb(hex) {
    const h = (hex || '#000000').replace('#', '');
    return [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(' ');
  }

  class Document {
    constructor() {
      this.objects = [];   // je Objekt: Liste aus Strings / Uint8Arrays
      this.pages = [];
      this.images = [];
      this.fontRegular = this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      this.fontBold = this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    }

    get width() { return PAGE_W; }
    get height() { return PAGE_H; }

    add(parts) {
      this.objects.push(Array.isArray(parts) ? parts : [parts]);
      return this.objects.length; // Objektnummer
    }

    /** JPEG-Bild einbetten; liefert den Namen für image(). */
    addJpeg(bytes, width, height) {
      const id = this.add([
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
        bytes,
        '\nendstream',
      ]);
      const name = 'Im' + (this.images.length + 1);
      this.images.push({ id, name });
      return name;
    }

    newPage() {
      const page = { ops: [] };
      this.pages.push(page);
      this.page = page;
      return page;
    }

    // Koordinaten: x von links, y von OBEN (wird intern umgerechnet)
    text(str, x, yTop, size, opts = {}) {
      const y = PAGE_H - yTop - size * 0.8;
      this.page.ops.push(`BT /${opts.bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(opts.color)} rg ` +
        `${num(x)} ${num(y)} Td ${pdfString(str)} Tj ET`);
    }

    rect(x, yTop, w, h, color) {
      this.page.ops.push(`${rgb(color)} rg ${num(x)} ${num(PAGE_H - yTop - h)} ${num(w)} ${num(h)} re f`);
    }

    line(x1, y1, x2, y2, color, width = 0.5) {
      this.page.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(PAGE_H - y1)} m ` +
        `${num(x2)} ${num(PAGE_H - y2)} l S`);
    }

    image(name, x, yTop, w, h) {
      this.page.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(PAGE_H - yTop - h)} cm /${name} Do Q`);
    }

    toBlob() {
      const pagesId = this.add('');
      const xobjects = this.images.map((im) => `/${im.name} ${im.id} 0 R`).join(' ');
      const resources = `<< /Font << /F1 ${this.fontRegular} 0 R /F2 ${this.fontBold} 0 R >> ` +
        `/XObject << ${xobjects} >> >>`;
      const kids = [];
      for (const page of this.pages) {
        const content = page.ops.join('\n');
        const contentId = this.add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
        kids.push(this.add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources ${resources} /Contents ${contentId} 0 R >>`));
      }
      this.objects[pagesId - 1] = [`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`];
      const catalogId = this.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

      const enc = new TextEncoder();
      const chunks = [];
      let offset = 0;
      const push = (part) => {
        const bytes = typeof part === 'string' ? enc.encode(part) : part;
        chunks.push(bytes);
        offset += bytes.length;
      };
      push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\x80-\xFF]/g, '')); // Kopf (nur ASCII)
      const offsets = [];
      this.objects.forEach((parts, i) => {
        offsets.push(offset);
        push(`${i + 1} 0 obj\n`);
        parts.forEach(push);
        push('\nendobj\n');
      });
      const xref = offset;
      let table = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
      for (const o of offsets) table += `${String(o).padStart(10, '0')} 00000 n \n`;
      push(table);
      push(`trailer\n<< /Size ${this.objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      return new Blob(chunks, { type: 'application/pdf' });
    }
  }

  return { Document, textWidth, wrap };
})();

const Zip = (() => {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  /** files: [{ name, blob, date }] */
  async function create(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const { time, date } = dosDateTime(f.date || new Date());

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034B50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // Dateinamen in UTF-8
      local.setUint16(8, 0, true);      // ohne Kompression
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014B50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);

      offset += 30 + name.length + data.length;
    }

    const centralSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  return { create };
})();
