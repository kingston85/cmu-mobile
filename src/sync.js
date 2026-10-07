// Sync with the CMU Google Sheet through the Apps Script web API.
// Push: local outbox -> server.  Pull: server rows changed since last sync -> local.
import { Network } from '@capacitor/network';
import { db, getMeta, setMeta } from './db';
import { TABLE_KEYS } from './schema';

const CHUNK = 40;

async function call(apiUrl, body) {
  // CapacitorHttp (enabled in capacitor.config.json) handles this natively on Android:
  // no CORS, follows the Apps Script redirect. text/plain avoids a browser pre-flight.
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error('Server did not return JSON. Check the Apps Script URL ends in /exec and access is "Anyone".');
  }
  if (!data.ok) throw new Error(data.error || 'Server error');
  return data;
}

export async function login(apiUrl, staff_id, pin) {
  const data = await call(apiUrl, { action: 'login', staff_id, pin });
  return { token: data.token, user: data.user };
}

export async function isOnline() {
  try { return (await Network.getStatus()).connected; } catch { return navigator.onLine; }
}

let running = null;
export function sync(session, onProgress = () => {}) {
  if (!running) running = doSync(session, onProgress).finally(() => { running = null; });
  return running;
}

async function doSync({ apiUrl, token, user }, onProgress) {
  if (!apiUrl || !token) throw new Error('Not connected to a server (offline mode). Add the server in Settings.');
  if (!(await isOnline())) throw new Error('No network connection. Your changes are saved on the phone and will sync later.');
  const summary = { pushed: 0, pulled: 0, photos: 0, conflicts: [] };

  // 1) PUSH queued changes (directors are read-only: skip)
  if (user.role !== 'director') {
    const queued = await db.outbox.orderBy('seq').toArray();
    for (let i = 0; i < queued.length; i += CHUNK) {
      const batch = queued.slice(i, i + CHUNK);
      const changes = [];
      for (const q of batch) {
        const record = await db[q.tbl].get(q.record_id);
        if (record) changes.push({ table: q.tbl, record });
      }
      onProgress(`Uploading changes ${Math.min(i + CHUNK, queued.length)}/${queued.length}…`);
      const res = await call(apiUrl, { action: 'push', token, changes });
      for (const r of res.results) {
        const q = batch.find(b => b.record_id === r.id);
        if (r.status === 'conflict' && r.server) {
          await db[q.tbl].put(r.server); // server copy wins; officer is told
          summary.conflicts.push({ table: q.tbl, id: r.id });
        }
        if (r.status !== 'error') await db.outbox.delete(q.seq);
        if (r.status === 'ok') summary.pushed++;
      }
    }

    // 2) PHOTOS
    const photos = await db.photos.where('uploaded').equals(0).toArray();
    for (const [n, p] of photos.entries()) {
      onProgress(`Uploading photo ${n + 1}/${photos.length}…`);
      const res = await call(apiUrl, { action: 'photo', token, photo: { id: p.id, inspection_id: p.inspection_id, taken_at: p.taken_at, base64: p.data } });
      await db.photos.update(p.id, { uploaded: 1, url: res.url });
      summary.photos++;
    }
  }

  // 3) PULL changes since last sync
  onProgress('Downloading updates…');
  const since = await getMeta('lastSync', '');
  const res = await call(apiUrl, { action: 'pull', token, since });
  const pendingIds = new Set((await db.outbox.toArray()).map(o => o.record_id));
  for (const t of TABLE_KEYS) {
    for (const row of res.data[t] || []) {
      if (pendingIds.has(row.id)) continue; // local unsent edit wins until pushed
      const local = await db[t].get(row.id);
      if (!local || Number(row.version) >= Number(local.version)) {
        await db[t].put({ ...row, version: Number(row.version) || 1, deleted: Number(row.deleted) || 0 });
        summary.pulled++;
      }
    }
  }
  if (res.user) await setMeta('serverUser', res.user);
  await setMeta('lastSync', res.serverTime);
  await setMeta('lastSyncLocal', new Date().toISOString());
  return summary;
}
