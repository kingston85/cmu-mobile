// Local, offline-first database (IndexedDB via Dexie). Persists inside the Android app.
import Dexie from 'dexie';
import { TABLES, TABLE_KEYS } from './schema';

export const db = new Dexie('cmu');
db.version(1).stores({
  ...Object.fromEntries(TABLE_KEYS.map(t => [t, 'id, updated_at, deleted'])),
  outbox: '++seq, tbl, record_id',
  photos: 'id, inspection_id, uploaded',
  activity: '++seq, at',
  meta: 'key',
});

export const uuid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key);
  return row ? row.value : fallback;
}
export const setMeta = (key, value) => db.meta.put({ key, value });

export async function listRecords(table) {
  const rows = await db[table].toArray();
  return rows.filter(r => !r.deleted).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

export const getRecord = (table, id) => db[table].get(id);

const norm = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Returns existing records that look like duplicates of `rec`
export async function findDuplicates(table, rec) {
  const keys = TABLES[table].duplicateKeys || [];
  if (!keys.length) return [];
  const rows = await listRecords(table);
  return rows.filter(r => r.id !== rec.id && keys.some(k => norm(rec[k]) && norm(rec[k]) === norm(r[k])));
}

export async function saveRecord(table, record, user, action) {
  const now = new Date().toISOString();
  const existing = record.id ? await db[table].get(record.id) : null;
  const rec = {
    ...existing,
    ...record,
    id: record.id || uuid(),
    version: (existing?.version || 0) + 1,
    updated_at: now,
    updated_by: user?.staff_id || 'local',
    deleted: record.deleted ? 1 : 0,
  };
  await db.transaction('rw', db[table], db.outbox, db.activity, async () => {
    await db[table].put(rec);
    await db.outbox.where('record_id').equals(rec.id).delete(); // keep only latest version queued
    await db.outbox.add({ tbl: table, record_id: rec.id, created_at: now });
    await db.activity.add({ at: now, user: rec.updated_by, table, record_id: rec.id, action: action || (existing ? 'update' : 'create') });
  });
  return rec;
}

export const deleteRecord = (table, rec, user) => saveRecord(table, { ...rec, deleted: 1 }, user, 'delete');

export const pendingCount = async () => (await db.outbox.count()) + (await db.photos.where('uploaded').equals(0).count());

export async function counts() {
  const out = {};
  for (const t of TABLE_KEYS) out[t] = (await db[t].toArray()).filter(r => !r.deleted).length;
  return out;
}

export async function wipeLocal() {
  await db.delete();
  await db.open();
}
