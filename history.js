'use strict';

/*
 * Verlauf: Aufnahmen werden 30 Tage lang nur auf diesem Handy gespeichert (IndexedDB).
 * Ein Eintrag ist ein Foto, ein Video, ein Vorher/Nachher-Bild oder eine ganze Serie.
 */
const HistoryStore = (() => {
  const DB_NAME = 'hier-und-jetzt'; // alter Name bleibt, damit der Verlauf erhalten bleibt
  const STORE = 'entries';
  const KEEP_DAYS = 30;
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const put = (entry) => run('readwrite', (s) => s.put(entry));
  const get = (id) => run('readonly', (s) => s.get(id));
  const remove = (id) => run('readwrite', (s) => s.delete(id));
  const clear = () => run('readwrite', (s) => s.clear());
  const all = () => run('readonly', (s) => s.getAll());

  /** Einträge löschen, die älter als 30 Tage sind. */
  async function prune() {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const e of await all()) if (e.createdAt < cutoff) await remove(e.id);
  }

  // Ergebnis-Objekte der App <-> speicherbare Form (Datum als Zahl, ohne Objekt-URL)
  function toStored(it) {
    const m = it.meta || {};
    return {
      kind: it.kind,
      blob: it.blob,
      filename: it.filename,
      width: it.width || null,
      height: it.height || null,
      meta: {
        ...m,
        date: m.date ? +m.date : Date.now(),
        compareDate: m.compareDate ? +m.compareDate : null,
      },
    };
  }

  function fromStored(s) {
    return {
      ...s,
      url: URL.createObjectURL(s.blob),
      meta: {
        ...s.meta,
        date: new Date(s.meta.date),
        compareDate: s.meta.compareDate ? new Date(s.meta.compareDate) : null,
      },
    };
  }

  return { put, get, remove, clear, all, prune, toStored, fromStored, KEEP_DAYS };
})();
