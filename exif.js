'use strict';

/*
 * Kleines EXIF-Modul (ohne fremde Bibliotheken):
 *  - Exif.insert(jpegBlob, meta): schreibt Aufnahmezeit, GPS und Beschreibung in ein JPEG
 *  - Exif.readDate(arrayBuffer): liest das Aufnahmedatum aus einem JPEG
 */
const Exif = (() => {
  const encoder = new TextEncoder();
  const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };

  const pad2 = (n) => String(n).padStart(2, '0');

  function exifDateTime(d) {
    return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ` +
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function tzOffset(d) {
    const m = -d.getTimezoneOffset();
    const a = Math.abs(m);
    return `${m >= 0 ? '+' : '-'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
  }

  /** EXIF-Textfelder sind ASCII: Umlaute umschreiben, Sonderzeichen ersetzen. */
  function toAscii(text) {
    return String(text)
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[–—]/g, '-').replace(/[„“”]/g, '"')
      .replace(/[^\x20-\x7E]/g, '?');
  }

  function ascii(tag, text) {
    const b = encoder.encode(toAscii(text));
    const data = new Uint8Array(b.length + 1); // mit abschließendem NUL
    data.set(b);
    return { tag, type: TYPE.ASCII, count: data.length, data };
  }

  function rationals(tag, pairs) {
    const data = new Uint8Array(pairs.length * 8);
    const dv = new DataView(data.buffer);
    pairs.forEach(([n, d], i) => {
      dv.setUint32(i * 8, Math.max(0, Math.round(n)), true);
      dv.setUint32(i * 8 + 4, d, true);
    });
    return { tag, type: TYPE.RATIONAL, count: pairs.length, data };
  }

  function bytes(tag, values) {
    return { tag, type: TYPE.BYTE, count: values.length, data: new Uint8Array(values) };
  }

  function long(tag, value) {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint32(0, value, true);
    return { tag, type: TYPE.LONG, count: 1, data };
  }

  function dms(value) {
    const v = Math.abs(value);
    const d = Math.floor(v);
    const mFloat = (v - d) * 60;
    const m = Math.floor(mFloat);
    const s = (mFloat - m) * 60;
    return [[d, 1], [m, 1], [s * 10000, 10000]];
  }

  function ifdSize(entries) {
    let size = 2 + entries.length * 12 + 4;
    for (const e of entries) if (e.data.length > 4) size += e.data.length + (e.data.length % 2);
    return size;
  }

  function writeIfd(dv, buf, offset, entries) {
    dv.setUint16(offset, entries.length, true);
    let dataOffset = offset + 2 + entries.length * 12 + 4;
    entries.forEach((e, i) => {
      const p = offset + 2 + i * 12;
      dv.setUint16(p, e.tag, true);
      dv.setUint16(p + 2, e.type, true);
      dv.setUint32(p + 4, e.count, true);
      if (e.data.length <= 4) {
        buf.set(e.data, p + 8);
      } else {
        dv.setUint32(p + 8, dataOffset, true);
        buf.set(e.data, dataOffset);
        dataOffset += e.data.length + (e.data.length % 2);
      }
    });
    dv.setUint32(offset + 2 + entries.length * 12, 0, true); // kein weiteres IFD
  }

  /** Baut den TIFF-Block (Inhalt des EXIF-Segments). */
  function buildTiff(meta) {
    const date = meta.date || new Date();
    const dt = exifDateTime(date);

    const ifd0 = [ascii(0x0131, 'Proofshot'), ascii(0x0132, dt)];
    if (meta.description) ifd0.push(ascii(0x010E, meta.description));
    if (meta.artist) ifd0.push(ascii(0x013B, meta.artist));

    const exifIfd = [ascii(0x9003, dt), ascii(0x9004, dt), ascii(0x9011, tzOffset(date))];

    let gpsIfd = null;
    const c = meta.pos && meta.pos.coords;
    if (c) {
      const utc = new Date(meta.pos.timestamp || date.getTime());
      gpsIfd = [
        bytes(0x0000, [2, 3, 0, 0]),
        ascii(0x0001, c.latitude >= 0 ? 'N' : 'S'),
        rationals(0x0002, dms(c.latitude)),
        ascii(0x0003, c.longitude >= 0 ? 'E' : 'W'),
        rationals(0x0004, dms(c.longitude)),
        rationals(0x0007, [[utc.getUTCHours(), 1], [utc.getUTCMinutes(), 1], [utc.getUTCSeconds(), 1]]),
        ascii(0x001D, `${utc.getUTCFullYear()}:${pad2(utc.getUTCMonth() + 1)}:${pad2(utc.getUTCDate())}`),
      ];
      if (typeof c.altitude === 'number' && isFinite(c.altitude)) {
        gpsIfd.push(bytes(0x0005, [c.altitude < 0 ? 1 : 0]));
        gpsIfd.push(rationals(0x0006, [[Math.abs(c.altitude) * 100, 100]]));
      }
      if (typeof c.accuracy === 'number' && isFinite(c.accuracy)) {
        gpsIfd.push(rationals(0x001F, [[c.accuracy * 100, 100]]));
      }
    }

    // Verweise auf Exif- und GPS-Block (Werte werden unten gesetzt)
    const exifPtr = long(0x8769, 0);
    ifd0.push(exifPtr);
    const gpsPtr = gpsIfd ? long(0x8825, 0) : null;
    if (gpsPtr) ifd0.push(gpsPtr);

    for (const list of [ifd0, exifIfd, gpsIfd]) if (list) list.sort((a, b) => a.tag - b.tag);

    const off0 = 8;
    const offExif = off0 + ifdSize(ifd0);
    const offGps = offExif + ifdSize(exifIfd);
    const total = offGps + (gpsIfd ? ifdSize(gpsIfd) : 0);
    new DataView(exifPtr.data.buffer).setUint32(0, offExif, true);
    if (gpsPtr) new DataView(gpsPtr.data.buffer).setUint32(0, offGps, true);

    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    buf.set([0x49, 0x49]);          // "II" = Little Endian
    dv.setUint16(2, 42, true);
    dv.setUint32(4, off0, true);
    writeIfd(dv, buf, off0, ifd0);
    writeIfd(dv, buf, offExif, exifIfd);
    if (gpsIfd) writeIfd(dv, buf, offGps, gpsIfd);
    return buf;
  }

  /** Fügt einen EXIF-Block in ein JPEG ein (vorhandene APP0/APP1 am Anfang werden ersetzt). */
  async function insert(blob, meta) {
    const src = new Uint8Array(await blob.arrayBuffer());
    if (src[0] !== 0xFF || src[1] !== 0xD8) return blob;

    // Am Dateianfang stehende APP0 (JFIF) und APP1 (EXIF) überspringen
    let p = 2;
    while (p + 4 <= src.length && src[p] === 0xFF && (src[p + 1] === 0xE0 || src[p + 1] === 0xE1)) {
      p += 2 + ((src[p + 2] << 8) | src[p + 3]);
    }

    const tiff = buildTiff(meta);
    const segLen = 2 + 6 + tiff.length;
    if (segLen > 0xFFFF) return blob;
    const seg = new Uint8Array(2 + segLen);
    seg.set([0xFF, 0xE1, segLen >> 8, segLen & 0xFF, 0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
    seg.set(tiff, 10);

    return new Blob([src.subarray(0, 2), seg, src.subarray(p)], { type: 'image/jpeg' });
  }

  /** Liest das Aufnahmedatum (DateTimeOriginal, sonst DateTime) aus einem JPEG. */
  function readDate(arrayBuffer) {
    try {
      const dv = new DataView(arrayBuffer);
      if (dv.getUint16(0) !== 0xFFD8) return null;
      let p = 2;
      while (p + 4 <= dv.byteLength) {
        if (dv.getUint8(p) !== 0xFF) return null;
        const marker = dv.getUint8(p + 1);
        const len = dv.getUint16(p + 2);
        if (marker === 0xDA) return null; // Bilddaten beginnen
        if (marker === 0xE1 && dv.getUint32(p + 4) === 0x45786966) {
          return parseTiffDate(dv, p + 10);
        }
        p += 2 + len;
      }
    } catch (e) { /* defekte Datei */ }
    return null;
  }

  function parseTiffDate(dv, t) {
    const le = dv.getUint16(t) === 0x4949;
    const u16 = (o) => dv.getUint16(t + o, le);
    const u32 = (o) => dv.getUint32(t + o, le);

    const readAscii = (entry) => {
      const count = u32(entry + 4);
      const off = count > 4 ? u32(entry + 8) : entry + 8;
      let s = '';
      for (let i = 0; i < count - 1; i++) s += String.fromCharCode(dv.getUint8(t + off + i));
      return s;
    };
    const findTag = (ifd, tag) => {
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === tag) return e;
      }
      return null;
    };

    const ifd0 = u32(4);
    let text = null;
    const exifPtr = findTag(ifd0, 0x8769);
    if (exifPtr) {
      const e = findTag(u32(exifPtr + 8), 0x9003);
      if (e) text = readAscii(e);
    }
    if (!text) {
      const e = findTag(ifd0, 0x0132);
      if (e) text = readAscii(e);
    }
    const m = text && text.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d.getTime()) ? null : d;
  }

  return { insert, readDate };
})();
