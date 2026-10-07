import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { TABLES, TABLE_KEYS } from './schema';
import { db, listRecords, saveRecord, deleteRecord, findDuplicates, pendingCount, getMeta, wipeLocal, uuid } from './db';
import { sync, login, isOnline } from './sync';
import { loadSession, saveSession, clearSession, takePhoto, getGps, toCsv, shareCsv } from './device';

const APP_VERSION = '1.0.0';
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = d => Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
const fmtTime = iso => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [data, setData] = useState(() => Object.fromEntries(TABLE_KEYS.map(t => [t, []])));
  const [stack, setStack] = useState([{ screen: 'home' }]);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncState, setSyncState] = useState({ busy: false, msg: '', last: null, error: '' });
  const [toast, setToast] = useState('');

  const canEdit = session && session.user.role !== 'director';
  const view = stack.at(-1);
  const go = (screen, params = {}) => setStack(s => [...s, { screen, params }]);
  const back = () => setStack(s => (s.length > 1 ? s.slice(0, -1) : s));
  const tab = screen => setStack([{ screen }]);
  const flash = m => { setToast(m); setTimeout(() => setToast(''), 2600); };

  const reload = useCallback(async () => {
    const next = {};
    for (const t of TABLE_KEYS) next[t] = await listRecords(t);
    setData(next);
    setPending(await pendingCount());
    setSyncState(s => ({ ...s, last: null }));
    getMeta('lastSyncLocal').then(last => setSyncState(s => ({ ...s, last })));
  }, []);

  const look = useCallback((table, id) => {
    if (!id) return '';
    const r = data[table]?.find(x => x.id === id);
    return r ? TABLES[table].title(r, () => '') : '(unknown)';
  }, [data]);

  const runSync = useCallback(async (quiet = false) => {
    if (!session?.token) { if (!quiet) flash('Offline mode — add a server in Settings to sync'); return; }
    setSyncState(s => ({ ...s, busy: true, msg: 'Starting sync…', error: '' }));
    try {
      const r = await sync(session, msg => setSyncState(s => ({ ...s, msg })));
      setSyncState(s => ({ ...s, busy: false, msg: `Sent ${r.pushed} change(s), ${r.photos} photo(s); received ${r.pulled}.`, conflicts: r.conflicts }));
      if (r.conflicts.length) flash(`${r.conflicts.length} record(s) were changed by someone else — the server copy was kept.`);
      else if (!quiet) flash('Sync complete');
    } catch (e) {
      setSyncState(s => ({ ...s, busy: false, error: e.message }));
      if (!quiet) flash(e.message);
    }
    reload();
  }, [session, reload]);

  // start-up
  useEffect(() => { loadSession().then(s => setSession(s || null)); }, []);
  useEffect(() => { if (session) { reload(); runSync(true); } }, [session]); // eslint-disable-line

  // network watcher → auto sync when connection returns
  const syncRef = useRef(runSync);
  syncRef.current = runSync;
  useEffect(() => {
    isOnline().then(setOnline);
    let h;
    Network.addListener('networkStatusChange', st => { setOnline(st.connected); if (st.connected) syncRef.current(true); }).then(x => (h = x)).catch(() => {});
    return () => h?.remove();
  }, []);

  // Android back button
  const stackRef = useRef(stack);
  stackRef.current = stack;
  useEffect(() => {
    let h;
    CapApp.addListener('backButton', () => {
      if (stackRef.current.length > 1) setStack(s => s.slice(0, -1));
      else CapApp.exitApp();
    }).then(x => (h = x)).catch(() => {});
    return () => h?.remove();
  }, []);

  if (session === undefined) return <div className="splash">CMU Database</div>;
  if (!session) return <Login onDone={async s => { await saveSession(s); setSession(s); }} />;

  const ctx = { session, data, look, canEdit, go, back, reload, flash, runSync, syncState, pending, online };
  let body;
  switch (view.screen) {
    case 'records': body = <Records {...ctx} />; break;
    case 'list': body = <List {...ctx} table={view.params.table} filter={view.params.filter} />; break;
    case 'detail': body = <Detail {...ctx} table={view.params.table} id={view.params.id} />; break;
    case 'form': body = <Form {...ctx} table={view.params.table} id={view.params.id} preset={view.params.preset} />; break;
    case 'sync': body = <SyncScreen {...ctx} />; break;
    case 'settings': body = <Settings {...ctx} onSignOut={async () => { await clearSession(); setSession(null); setStack([{ screen: 'home' }]); }} onSession={async s => { await saveSession(s); setSession(s); }} />; break;
    default: body = <Home {...ctx} />;
  }
  const root = stack[0].screen;
  return (
    <div className="app">
      {!online && <div className="banner offline">Offline — changes are saved on this phone{pending ? ` (${pending} waiting)` : ''}</div>}
      {online && syncState.busy && <div className="banner busy">{syncState.msg}</div>}
      <main>{body}</main>
      <nav className="tabs">
        {[['home', 'Home', '⌂'], ['records', 'Records', '☰'], ['sync', 'Sync', '⟳'], ['settings', 'Settings', '⚙']].map(([k, label, ic]) => (
          <button key={k} className={root === k && stack.length === 1 ? 'on' : root === k ? 'half' : ''} onClick={() => tab(k)}>
            <span className="ic">{ic}</span>{label}{k === 'sync' && pending > 0 && <b className="badge">{pending}</b>}
          </button>
        ))}
      </nav>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ---------------- Login ---------------- */
function Login({ onDone }) {
  const [apiUrl, setApiUrl] = useState('');
  const [staff, setStaff] = useState('');
  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('server');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault(); setErr('');
    if (mode === 'local') {
      if (!name.trim()) return setErr('Enter your name');
      return onDone({ apiUrl: '', token: '', user: { staff_id: 'local-' + name.trim().toLowerCase().replace(/\s+/g, '-'), name: name.trim(), role: 'officer' } });
    }
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(apiUrl.trim())) return setErr('Paste the Apps Script web app URL (it ends in /exec)');
    setBusy(true);
    try {
      const { token, user } = await login(apiUrl.trim(), staff.trim(), pin);
      onDone({ apiUrl: apiUrl.trim(), token, user });
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };

  return (
    <div className="login">
      <div className="brand"><div className="logo">CMU</div><h1>Chemical Management Unit</h1><p>EPA Liberia · ERRS Department</p></div>
      <div className="seg">
        <button className={mode === 'server' ? 'on' : ''} onClick={() => setMode('server')}>Sign in</button>
        <button className={mode === 'local' ? 'on' : ''} onClick={() => setMode('local')}>Offline only</button>
      </div>
      <form onSubmit={submit} className="card">
        {mode === 'server' ? <>
          <label>Server URL<input value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="https://script.google.com/macros/s/…/exec" autoCapitalize="off" /></label>
          <label>Staff ID<input value={staff} onChange={e => setStaff(e.target.value)} autoCapitalize="characters" /></label>
          <label>PIN<input value={pin} onChange={e => setPin(e.target.value)} type="password" inputMode="numeric" /></label>
        </> : <>
          <p className="muted">Records stay on this phone only. You can connect to the CMU server later in Settings.</p>
          <label>Your name<input value={name} onChange={e => setName(e.target.value)} /></label>
        </>}
        {err && <p className="err">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : mode === 'server' ? 'Sign in' : 'Start'}</button>
      </form>
      <p className="muted small">v{APP_VERSION}</p>
    </div>
  );
}

/* ---------------- Home ---------------- */
function Home({ session, data, look, go, canEdit, pending, syncState, runSync }) {
  const permits = data.permits.filter(p => p.expiry_date && p.status !== 'Revoked' && p.status !== 'Rejected');
  const expired = permits.filter(p => daysUntil(p.expiry_date) < 0);
  const expiring = permits.filter(p => daysUntil(p.expiry_date) >= 0 && daysUntil(p.expiry_date) <= 30);
  const followUps = data.inspections.filter(i => i.follow_up_date && daysUntil(i.follow_up_date) <= 7 && i.compliance !== 'Compliant');
  const nonCompliant = data.inspections.filter(i => i.compliance === 'Non-compliant').length;

  return (
    <>
      <header className="top">
        <div><h1>CMU Database</h1><p>{session.user.name} · {session.user.role}</p></div>
        <button className="ghost" onClick={() => runSync()} disabled={syncState.busy}>{syncState.busy ? '…' : '⟳'}</button>
      </header>
      <section className="syncline" onClick={() => go('sync')}>
        {pending ? <span className="dot warn" /> : <span className="dot ok" />}
        {pending ? `${pending} change(s) waiting to sync` : 'All changes synced'} · last sync {fmtTime(syncState.last)}
      </section>
      {canEdit && (
        <div className="quick">
          <button className="primary" onClick={() => go('form', { table: 'inspections' })}>+ New inspection</button>
          <button onClick={() => go('form', { table: 'consignments' })}>+ New consignment</button>
        </div>
      )}
      <div className="grid">
        {TABLE_KEYS.map(t => (
          <button key={t} className="stat" onClick={() => go('list', { table: t })}>
            <span className="ic">{TABLES[t].icon}</span><b>{data[t].length}</b><span>{TABLES[t].label}</span>
          </button>
        ))}
        <button className="stat alert" onClick={() => go('list', { table: 'inspections', filter: 'noncompliant' })}>
          <span className="ic">⚠️</span><b>{nonCompliant}</b><span>Non-compliant</span>
        </button>
      </div>
      <Alerts title={`Permits expired (${expired.length})`} rows={expired} tone="bad" table="permits" go={go} line={p => `${p.permit_no} · ${look('importers', p.importer_id)} · ${-daysUntil(p.expiry_date)} days ago`} />
      <Alerts title={`Permits expiring in 30 days (${expiring.length})`} rows={expiring} tone="warn" table="permits" go={go} line={p => `${p.permit_no} · ${look('importers', p.importer_id)} · in ${daysUntil(p.expiry_date)} days`} />
      <Alerts title={`Follow-ups due (${followUps.length})`} rows={followUps} tone="warn" table="inspections" go={go} line={i => `${i.site_name} · ${i.follow_up_date}`} />
    </>
  );
}

function Alerts({ title, rows, tone, table, go, line }) {
  if (!rows.length) return null;
  return (
    <section className={`card alerts ${tone}`}>
      <h3>{title}</h3>
      {rows.slice(0, 6).map(r => <button key={r.id} className="row" onClick={() => go('detail', { table, id: r.id })}>{line(r)}</button>)}
      {rows.length > 6 && <p className="muted small">+ {rows.length - 6} more</p>}
    </section>
  );
}

/* ---------------- Records & list ---------------- */
function Records({ data, go }) {
  return (
    <>
      <header className="top"><h1>Records</h1></header>
      {TABLE_KEYS.map(t => (
        <button key={t} className="card listrow" onClick={() => go('list', { table: t })}>
          <span className="ic">{TABLES[t].icon}</span><span className="grow">{TABLES[t].label}</span><b>{data[t].length}</b>
        </button>
      ))}
    </>
  );
}

function List({ table, filter, data, look, go, back, canEdit, flash }) {
  const T = TABLES[table];
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    let r = data[table];
    if (filter === 'noncompliant') r = r.filter(x => x.compliance === 'Non-compliant');
    if (!q.trim()) return r;
    const s = q.toLowerCase();
    return r.filter(x => T.fields.some(f => String(f.type === 'ref' ? look(f.ref, x[f.key]) : x[f.key] ?? '').toLowerCase().includes(s)));
  }, [data, table, q, filter, look, T]);

  const exportCsv = async () => {
    const cols = [{ label: 'id', value: r => r.id }, ...T.fields.map(f => ({ label: f.label, value: r => (f.type === 'ref' ? look(f.ref, r[f.key]) : r[f.key]) }))];
    if (T.hasGps) cols.push({ label: 'Latitude', value: r => r.lat }, { label: 'Longitude', value: r => r.lng }, { label: 'GPS accuracy (m)', value: r => r.gps_accuracy_m });
    cols.push({ label: 'Updated', value: r => r.updated_at }, { label: 'Updated by', value: r => r.updated_by });
    try { await shareCsv(`CMU_${T.sheet}_${today()}.csv`, toCsv(rows, cols)); } catch (e) { flash(e.message); }
  };

  return (
    <>
      <header className="top">
        <button className="ghost" onClick={back}>‹</button>
        <h1 className="grow">{T.label}{filter === 'noncompliant' ? ' (non-compliant)' : ''}</h1>
        <button className="ghost small" onClick={exportCsv}>CSV</button>
      </header>
      <input className="search" placeholder={`Search ${T.label.toLowerCase()}…`} value={q} onChange={e => setQ(e.target.value)} />
      {!rows.length && <p className="empty">No {T.label.toLowerCase()} yet{canEdit ? ' — tap + to add one.' : '.'}</p>}
      {rows.map(r => (
        <button key={r.id} className="card listrow" onClick={() => go('detail', { table, id: r.id })}>
          <span className="grow"><b>{T.title(r, look) || '(untitled)'}</b><small>{T.subtitle(r, look)}</small></span>
          {r.compliance && <span className={`pill ${r.compliance === 'Compliant' ? 'ok' : r.compliance === 'Non-compliant' ? 'bad' : 'warn'}`}>{r.compliance}</span>}
          {table === 'permits' && r.expiry_date && daysUntil(r.expiry_date) < 0 && <span className="pill bad">Expired</span>}
        </button>
      ))}
      {canEdit && <button className="fab" onClick={() => go('form', { table })}>+</button>}
    </>
  );
}

/* ---------------- Detail ---------------- */
function Detail({ table, id, data, look, go, back, canEdit, session, reload, flash }) {
  const T = TABLES[table];
  const r = data[table].find(x => x.id === id);
  const [photos, setPhotos] = useState([]);
  const [history, setHistory] = useState([]);
  useEffect(() => {
    db.photos.where('inspection_id').equals(id).toArray().then(setPhotos);
    db.activity.filter(a => a.record_id === id).toArray().then(h => setHistory(h.reverse()));
  }, [id, data]);
  if (!r) return <><header className="top"><button className="ghost" onClick={back}>‹</button><h1>Not found</h1></header></>;

  const remove = async () => {
    if (!confirm(`Delete this ${T.singular.toLowerCase()}? It will be removed for everyone after sync.`)) return;
    await deleteRecord(table, r, session.user); await reload(); flash('Deleted'); back();
  };
  // records that point at this one
  const linked = TABLE_KEYS.flatMap(t => TABLES[t].fields.filter(f => f.type === 'ref' && f.ref === table).map(f => ({ t, rows: data[t].filter(x => x[f.key] === id) }))).filter(x => x.rows.length);

  return (
    <>
      <header className="top">
        <button className="ghost" onClick={back}>‹</button>
        <h1 className="grow">{T.title(r, look) || T.singular}</h1>
        {canEdit && <button className="ghost small" onClick={() => go('form', { table, id })}>Edit</button>}
      </header>
      <section className="card">
        {T.fields.map(f => (r[f.key] !== undefined && r[f.key] !== '' && r[f.key] !== null) && (
          <div className="kv" key={f.key}>
            <span>{f.label}</span>
            {f.type === 'ref'
              ? <button className="link" onClick={() => go('detail', { table: f.ref, id: r[f.key] })}>{look(f.ref, r[f.key])}</button>
              : <b className={f.type === 'textarea' ? 'pre' : ''}>{String(r[f.key])}</b>}
          </div>
        ))}
        {T.hasGps && r.lat && (
          <div className="kv"><span>GPS</span>
            <a className="link" href={`https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`} target="_blank" rel="noreferrer">{r.lat}, {r.lng} (±{r.gps_accuracy_m} m)</a>
          </div>
        )}
      </section>
      {T.hasPhotos && photos.length > 0 && (
        <section className="card"><h3>Photos ({photos.length})</h3>
          <div className="photos">{photos.map(p => <img key={p.id} src={`data:image/jpeg;base64,${p.data}`} alt="" />)}</div>
        </section>
      )}
      {linked.map(({ t, rows }) => (
        <section className="card" key={t}><h3>{TABLES[t].label} ({rows.length})</h3>
          {rows.slice(0, 10).map(x => <button key={x.id} className="row" onClick={() => go('detail', { table: t, id: x.id })}>{TABLES[t].title(x, look)} <small>{TABLES[t].subtitle(x, look)}</small></button>)}
        </section>
      ))}
      <section className="card meta">
        <p>Last changed {fmtTime(r.updated_at)} by {r.updated_by} · version {r.version}</p>
        {history.slice(0, 5).map(h => <p key={h.seq} className="small">{fmtTime(h.at)} — {h.action} by {h.user}</p>)}
      </section>
      {canEdit && <button className="danger wide" onClick={remove}>Delete {T.singular.toLowerCase()}</button>}
    </>
  );
}

/* ---------------- Form ---------------- */
function Form({ table, id, preset, data, look, back, session, reload, flash }) {
  const T = TABLES[table];
  const existing = id ? data[table].find(x => x.id === id) : null;
  const [rec, setRec] = useState(() => {
    if (existing) return { ...existing };
    const r = { id: uuid(), ...preset };
    T.fields.forEach(f => { if (f.defaultToday) r[f.key] = today(); });
    return r;
  });
  const [photos, setPhotos] = useState([]);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [dupes, setDupes] = useState([]);
  const isNew = !existing;

  useEffect(() => { if (T.hasPhotos) db.photos.where('inspection_id').equals(rec.id).toArray().then(setPhotos); }, []); // eslint-disable-line
  const set = (k, v) => setRec(r => ({ ...r, [k]: v }));

  const captureGps = async () => {
    setGpsBusy(true);
    try { const g = await getGps(); setRec(r => ({ ...r, ...g })); flash(`Location captured (±${g.gps_accuracy_m} m)`); }
    catch (e) { flash('Could not get location: ' + e.message); }
    setGpsBusy(false);
  };
  const addPhoto = async () => {
    try {
      const b64 = await takePhoto();
      if (b64) setPhotos(p => [...p, { id: uuid(), inspection_id: rec.id, data: b64, uploaded: 0, taken_at: new Date().toISOString(), isNew: true }]);
    } catch (e) { if (!/cancel/i.test(e.message)) flash(e.message); }
  };

  const save = async (force = false) => {
    const errs = {};
    T.fields.forEach(f => { if (f.required && (rec[f.key] === undefined || rec[f.key] === '')) errs[f.key] = 'Required'; });
    setErrors(errs);
    if (Object.keys(errs).length) return flash('Please fill the required fields');
    if (!force) {
      const d = await findDuplicates(table, rec);
      if (d.length) return setDupes(d);
    }
    const clean = { ...rec };
    T.fields.forEach(f => { if (f.type === 'number' && clean[f.key] !== '' && clean[f.key] != null) clean[f.key] = Number(clean[f.key]); });
    await saveRecord(table, clean, session.user);
    for (const p of photos.filter(p => p.isNew)) { const { isNew: _, ...row } = p; await db.photos.put(row); }
    await reload();
    flash(isNew ? `${T.singular} saved` : 'Changes saved');
    back();
  };

  return (
    <>
      <header className="top">
        <button className="ghost" onClick={back}>✕</button>
        <h1 className="grow">{isNew ? `New ${T.singular.toLowerCase()}` : `Edit ${T.singular.toLowerCase()}`}</h1>
        <button className="ghost small strong" onClick={() => save()}>Save</button>
      </header>
      <form className="card form" onSubmit={e => { e.preventDefault(); save(); }}>
        {T.fields.map(f => (
          <label key={f.key} className={errors[f.key] ? 'bad' : ''}>
            {f.label}{f.required && <em> *</em>}
            <Field f={f} value={rec[f.key] ?? ''} onChange={v => set(f.key, v)} data={data} look={look} />
            {errors[f.key] && <small className="err">{errors[f.key]}</small>}
          </label>
        ))}
        {T.hasGps && (
          <div className="gps">
            <span>GPS location</span>
            {rec.lat ? <b>{rec.lat}, {rec.lng} (±{rec.gps_accuracy_m} m)</b> : <small className="muted">not captured</small>}
            <button type="button" onClick={captureGps} disabled={gpsBusy}>{gpsBusy ? 'Locating…' : rec.lat ? 'Re-capture' : 'Capture GPS'}</button>
          </div>
        )}
        {T.hasPhotos && (
          <div className="gps">
            <span>Photos ({photos.length})</span>
            <div className="photos">{photos.map(p => <img key={p.id} src={`data:image/jpeg;base64,${p.data}`} alt="" />)}</div>
            <button type="button" onClick={addPhoto}>+ Add photo</button>
          </div>
        )}
        <button className="primary wide">Save</button>
      </form>
      {dupes.length > 0 && (
        <div className="modal" onClick={() => setDupes([])}>
          <div className="card" onClick={e => e.stopPropagation()}>
            <h3>Possible duplicate</h3>
            <p>This looks like an existing {T.singular.toLowerCase()}:</p>
            {dupes.map(d => <p key={d.id}><b>{T.title(d, look)}</b><br /><small>{T.subtitle(d, look)}</small></p>)}
            <div className="quick">
              <button onClick={() => setDupes([])}>Go back</button>
              <button className="primary" onClick={() => { setDupes([]); save(true); }}>Save anyway</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Field({ f, value, onChange, data, look }) {
  if (f.type === 'textarea') return <textarea rows={3} value={value} onChange={e => onChange(e.target.value)} />;
  if (f.type === 'select') return (
    <select value={value} onChange={e => onChange(e.target.value)}>
      <option value="">—</option>
      {f.options.map(o => <option key={o}>{o}</option>)}
    </select>
  );
  if (f.type === 'ref') {
    const opts = [...data[f.ref]].sort((a, b) => look(f.ref, a.id).localeCompare(look(f.ref, b.id)));
    return (
      <select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— choose —</option>
        {opts.map(o => <option key={o.id} value={o.id}>{look(f.ref, o.id)}</option>)}
      </select>
    );
  }
  return <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} inputMode={f.inputMode || (f.type === 'number' ? 'decimal' : undefined)} step="any" value={value} onChange={e => onChange(e.target.value)} />;
}

/* ---------------- Sync ---------------- */
function SyncScreen({ session, pending, syncState, runSync, online }) {
  const [queue, setQueue] = useState([]);
  useEffect(() => { db.outbox.toArray().then(setQueue); }, [pending]);
  return (
    <>
      <header className="top"><h1>Sync</h1></header>
      <section className="card">
        <div className="kv"><span>Server</span><b>{session.apiUrl ? 'CMU Google Sheet' : 'None (offline mode)'}</b></div>
        <div className="kv"><span>Network</span><b>{online ? 'Online' : 'Offline'}</b></div>
        <div className="kv"><span>Waiting to upload</span><b>{pending}</b></div>
        <div className="kv"><span>Last sync</span><b>{fmtTime(syncState.last)}</b></div>
        {syncState.msg && !syncState.busy && <p className="ok">{syncState.msg}</p>}
        {syncState.error && <p className="err">{syncState.error}</p>}
        <button className="primary wide" disabled={syncState.busy} onClick={() => runSync()}>{syncState.busy ? syncState.msg : 'Sync now'}</button>
        {session.user.role === 'director' && <p className="muted small">Director accounts are read-only: sync downloads the latest records.</p>}
      </section>
      {queue.length > 0 && (
        <section className="card"><h3>Queued changes</h3>
          {queue.slice(0, 20).map(q => <p key={q.seq} className="small">{TABLES[q.tbl].singular} · {fmtTime(q.created_at)}</p>)}
        </section>
      )}
    </>
  );
}

/* ---------------- Settings ---------------- */
function Settings({ session, onSignOut, onSession, flash, reload, pending }) {
  const [apiUrl, setApiUrl] = useState(session.apiUrl);
  const [staff, setStaff] = useState('');
  const [pin, setPin] = useState('');
  const connect = async () => {
    try { const { token, user } = await login(apiUrl.trim(), staff.trim(), pin); await onSession({ apiUrl: apiUrl.trim(), token, user }); flash(`Connected as ${user.name}`); }
    catch (e) { flash(e.message); }
  };
  const signOut = () => {
    if (pending && !confirm(`${pending} change(s) have not been synced. Sign out anyway? They stay on this phone.`)) return;
    onSignOut();
  };
  const wipe = async () => {
    if (!confirm('Erase ALL CMU data stored on this phone? Unsynced changes will be lost.')) return;
    await wipeLocal(); await reload(); flash('Local data erased');
  };
  return (
    <>
      <header className="top"><h1>Settings</h1></header>
      <section className="card">
        <div className="kv"><span>Signed in as</span><b>{session.user.name}</b></div>
        <div className="kv"><span>Staff ID</span><b>{session.user.staff_id}</b></div>
        <div className="kv"><span>Role</span><b>{session.user.role}</b></div>
      </section>
      {!session.token && (
        <section className="card form"><h3>Connect to CMU server</h3>
          <label>Server URL<input value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="https://script.google.com/macros/s/…/exec" autoCapitalize="off" /></label>
          <label>Staff ID<input value={staff} onChange={e => setStaff(e.target.value)} /></label>
          <label>PIN<input type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} /></label>
          <button className="primary wide" onClick={connect}>Connect</button>
          <p className="muted small">Records you created offline will upload on the first sync.</p>
        </section>
      )}
      <button className="wide" onClick={signOut}>Sign out</button>
      <button className="danger wide" onClick={wipe}>Erase data on this phone</button>
      <p className="muted small center">CMU Database v{APP_VERSION} · EPA Liberia</p>
    </>
  );
}
