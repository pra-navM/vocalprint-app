// ============================================================
// IndexedDB persistence for STI Tracker recordings
//
// Recordings carry decoded mono PCM (Float32Array) and envelope
// arrays that are far too large for localStorage. IndexedDB is
// built for this and stores typed arrays via structured clone.
//
// AudioBuffer is NOT structured-cloneable, so we persist the mono
// PCM Float32Array + sampleRate and reconstruct a playable
// AudioBuffer on demand (see pcmToAudioBuffer).
//
// Every function degrades gracefully: if IndexedDB is unavailable
// (private mode, quota, old browser) reads resolve to [] and
// writes/deletes resolve to void, so the app falls back to its
// previous in-memory-only behaviour. Mirrors loadFromLS/saveToLS.
// ============================================================

const DB_NAME = 'vocalprint';
const DB_VERSION = 1;
const STORE = 'recordings';
const SESSION_INDEX = 'sessionId';

let dbPromise = null;
let warned = false;

function warnOnce(err) {
  if (warned) return;
  warned = true;
  // Non-fatal: persistence is best-effort.
  console.warn('STI Tracker: recording persistence unavailable, falling back to in-memory only.', err);
}

/**
 * Open (and lazily create) the database. The open is memoized so
 * concurrent callers share a single connection. Rejects if
 * indexedDB is unavailable in this environment.
 */
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(SESSION_INDEX, 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('failed to open IndexedDB'));
  });
  // If the open fails, allow a later retry by clearing the memo.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/** Test-only: close + drop the memoized connection so the next openDB re-evaluates indexedDB. */
export function _resetForTests() {
  if (dbPromise) dbPromise.then(db => db.close()).catch(() => {});
  dbPromise = null;
  warned = false;
}

/** Promisify a single IDBRequest. */
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run `fn(store)` inside a transaction and resolve when it commits.
 * `fn` may return a value (resolved on commit) or a promise.
 */
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    let inner;
    try {
      inner = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result === undefined ? inner : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    if (inner && typeof inner.then === 'function') {
      inner.then(r => { result = r; }, err => reject(err));
    } else {
      result = inner;
    }
  });
}

/**
 * Is on-device persistence available at all? Resolves false when IndexedDB is
 * missing or blocked (private mode, disabled storage). Lets the UI distinguish
 * "storage unavailable from the start" from "an individual write failed".
 */
export async function isPersistenceAvailable() {
  try {
    await openDB();
    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert a recording. Covers both add and onset/offset updates.
 * Returns true if it was persisted, false if the write failed (e.g. quota
 * exceeded) — callers surface that so changes are never lost silently.
 */
export async function putRecording(record) {
  try {
    await tx('readwrite', store => { store.put(record); });
    return true;
  } catch (err) {
    warnOnce(err);
    return false;
  }
}

/** All recordings for a session. Returns [] on any failure. */
export async function getRecordingsBySession(sessionId) {
  try {
    return await tx('readonly', store => req(store.index(SESSION_INDEX).getAll(sessionId)));
  } catch (err) {
    warnOnce(err);
    return [];
  }
}

/** Delete a single recording by id. Returns true on success, false on failure. */
export async function deleteRecording(id) {
  try {
    await tx('readwrite', store => { store.delete(id); });
    return true;
  } catch (err) {
    warnOnce(err);
    return false;
  }
}

/** Delete every recording belonging to a session. */
export async function deleteRecordingsBySession(sessionId) {
  try {
    await tx('readwrite', async store => {
      const keys = await req(store.index(SESSION_INDEX).getAllKeys(sessionId));
      keys.forEach(key => store.delete(key));
    });
  } catch (err) {
    warnOnce(err);
  }
}

/** Delete recordings for many sessions in one transaction (patient delete). */
export async function deleteRecordingsBySessions(sessionIds) {
  if (!sessionIds || sessionIds.length === 0) return;
  try {
    await tx('readwrite', async store => {
      const index = store.index(SESSION_INDEX);
      for (const sessionId of sessionIds) {
        const keys = await req(index.getAllKeys(sessionId));
        keys.forEach(key => store.delete(key));
      }
    });
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Delete every recording whose sessionId is NOT in `validSessionIds` — i.e.
 * orphans left when a session/patient was deleted while a clip was still
 * decoding (the in-flight write lands after the session's cleanup). Iterates
 * the sessionId index with a key cursor (no PCM loaded), collects orphan
 * primary keys, then deletes them in the same transaction. Returns the count.
 */
export async function deleteOrphanedRecordings(validSessionIds) {
  const valid = new Set(validSessionIds || []);
  try {
    return await tx('readwrite', store => new Promise((resolve, reject) => {
      const cursorReq = store.index(SESSION_INDEX).openKeyCursor();
      const toDelete = [];
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          if (!valid.has(cursor.key)) toDelete.push(cursor.primaryKey);
          cursor.continue();
        } else {
          toDelete.forEach(key => store.delete(key));
          resolve(toDelete.length);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    }));
  } catch (err) {
    warnOnce(err);
    return 0;
  }
}

/**
 * Reconstruct a playable mono AudioBuffer from stored PCM. Used when
 * a recording was loaded from IndexedDB and has no live AudioBuffer.
 */
export function pcmToAudioBuffer(ctx, pcm, sampleRate) {
  const buf = ctx.createBuffer(1, pcm.length, sampleRate);
  if (typeof buf.copyToChannel === 'function') {
    buf.copyToChannel(pcm, 0);
  } else {
    buf.getChannelData(0).set(pcm);
  }
  return buf;
}
