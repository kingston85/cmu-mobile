/**
 * CMU Database — sync API for the Android app (EPA Liberia, ERRS / Chemical Management Unit)
 *
 * Install:
 *  1. Open the Google Sheet that will hold the mobile CMU data → Extensions → Apps Script.
 *  2. Paste this whole file into Code.gs and save.
 *  3. Run `setup` once (authorise when asked). It creates the sheets, the Users sheet,
 *     the Audit Log and a Drive folder for inspection photos.
 *  4. Add staff to the Users sheet (staff_id, name, role = admin | officer | director, pin, active = TRUE).
 *  5. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 *     Copy the URL ending in /exec and paste it into the app's sign-in screen.
 *  When you change this code later: Deploy → Manage deployments → Edit (pencil) → Version: New version.
 *  That keeps the same /exec URL so installed phones keep working.
 */

const TABLES = {
  importers:    { sheet: 'Importers',    fields: ['name', 'reg_no', 'sector', 'contact_person', 'phone', 'email', 'address', 'county', 'status'] },
  chemicals:    { sheet: 'Chemicals',    fields: ['name', 'cas_no', 'un_no', 'category', 'hazard_class', 'hmis_health', 'use', 'notes'] },
  permits:      { sheet: 'Permits',      fields: ['permit_no', 'importer_id', 'permit_type', 'issue_date', 'expiry_date', 'status', 'notes'] },
  consignments: { sheet: 'Consignments', fields: ['importer_id', 'chemical_id', 'permit_id', 'quantity', 'unit', 'port', 'bill_of_lading', 'arrival_date', 'fee_usd', 'status', 'notes'] },
  inspections:  { sheet: 'Inspections',  fields: ['site_name', 'importer_id', 'consignment_id', 'inspection_type', 'inspection_date', 'county', 'compliance', 'findings', 'actions', 'follow_up_date', 'lat', 'lng', 'gps_accuracy_m'] },
};
const SYSTEM = ['id', 'version', 'updated_at', 'updated_by', 'deleted', 'server_updated_at'];
const USERS = ['staff_id', 'name', 'role', 'pin', 'active', 'token', 'last_login'];
const PHOTOS = ['id', 'inspection_id', 'taken_at', 'url', 'uploaded_by', 'uploaded_at'];
const AUDIT = ['timestamp', 'staff_id', 'name', 'table', 'record_id', 'action', 'source'];
const PHOTO_FOLDER = 'CMU Inspection Photos';

/* ------------------------------------------------------------------ setup */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('CMU Mobile')
    .addItem('Set up / repair sheets', 'setup')
    .addItem('Sign out all phones (reset tokens)', 'resetTokens')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.values(TABLES).forEach(t => ensureSheet_(ss, t.sheet, SYSTEM.slice(0, 1).concat(t.fields, SYSTEM.slice(1)), true));
  const users = ensureSheet_(ss, 'Users', USERS, false);
  ensureSheet_(ss, 'Photos', PHOTOS, false);
  ensureSheet_(ss, 'Audit Log', AUDIT, false);
  if (users.getLastRow() === 1) {
    users.appendRow(['ADMIN01', 'CMU Administrator', 'admin', '1234', 'TRUE', '', '']);
  }
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PHOTO_FOLDER_ID')) {
    props.setProperty('PHOTO_FOLDER_ID', DriveApp.createFolder(PHOTO_FOLDER).getId());
  }
  try {
    SpreadsheetApp.getUi().alert('CMU Mobile is set up.\n\nAdd staff on the Users sheet (change the ADMIN01 PIN!), then Deploy → New deployment → Web app.');
  } catch (e) { /* run from editor */ }
}

function ensureSheet_(ss, name, headers, isData) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#dcfce7');
    sh.setFrozenRows(1);
  } else {
    const existing = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
    if (isData && existing.indexOf('id') === -1 && sh.getLastRow() > 1) {
      throw new Error('Sheet "' + name + '" already exists with other data (no "id" column). Use a new Google Sheet for CMU Mobile, or rename that sheet first.');
    }
    const missing = headers.filter(h => existing.indexOf(h) === -1);
    if (missing.length) sh.getRange(1, existing.filter(String).length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#dcfce7');
  }
  sh.getRange('A:ZZ').setNumberFormat('@'); // keep dates and IDs as plain text
  return sh;
}

function resetTokens() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Users');
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const col = head.indexOf('token') + 1;
  if (sh.getLastRow() > 1) sh.getRange(2, col, sh.getLastRow() - 1, 1).clearContent();
}

/* ------------------------------------------------------------------ web API */

function doGet() {
  return json_({ ok: true, service: 'CMU Database API', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'login') return json_(login_(body.staff_id, body.pin));
    const user = auth_(body.token);
    if (!user) return json_({ ok: false, error: 'Session expired or account disabled. Sign out and sign in again.' });
    switch (body.action) {
      case 'pull': return json_(pull_(body.since, user));
      case 'push': return json_(push_(body.changes || [], user));
      case 'photo': return json_(photo_(body.photo, user));
      default: return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ helpers */

function read_(sh) {
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  return { head: head, rows: values };
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

function rowToObj_(head, row) {
  const o = {};
  head.forEach((h, i) => { if (h) o[h] = cell_(row[i]); });
  return o;
}

function audit_(user, table, id, action) {
  SpreadsheetApp.getActive().getSheetByName('Audit Log')
    .appendRow([new Date().toISOString(), user.staff_id, user.name, table, id, action, 'android']);
}

/* ------------------------------------------------------------------ actions */

function login_(staffId, pin) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Users');
  const t = read_(sh);
  const c = name => t.head.indexOf(name);
  const i = t.rows.findIndex(r =>
    String(r[c('staff_id')]).trim().toUpperCase() === String(staffId || '').trim().toUpperCase() &&
    String(r[c('pin')]).trim() === String(pin || '').trim());
  if (i === -1) return { ok: false, error: 'Wrong staff ID or PIN' };
  const r = t.rows[i];
  if (String(r[c('active')]).toUpperCase() !== 'TRUE') return { ok: false, error: 'This account is disabled' };
  let token = String(r[c('token')] || '');
  if (!token) {
    token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
    sh.getRange(i + 2, c('token') + 1).setValue(token);
  }
  sh.getRange(i + 2, c('last_login') + 1).setValue(new Date().toISOString());
  const user = { staff_id: String(r[c('staff_id')]), name: String(r[c('name')]), role: String(r[c('role')]).toLowerCase() };
  audit_(user, 'Users', user.staff_id, 'login');
  return { ok: true, token: token, user: user };
}

function auth_(token) {
  if (!token) return null;
  const t = read_(SpreadsheetApp.getActive().getSheetByName('Users'));
  const c = name => t.head.indexOf(name);
  const r = t.rows.find(x => String(x[c('token')]) === String(token) && String(x[c('active')]).toUpperCase() === 'TRUE');
  return r ? { staff_id: String(r[c('staff_id')]), name: String(r[c('name')]), role: String(r[c('role')]).toLowerCase() } : null;
}

function pull_(since, user) {
  const ss = SpreadsheetApp.getActive();
  const serverTime = new Date().toISOString();
  const data = {};
  Object.keys(TABLES).forEach(k => {
    const t = read_(ss.getSheetByName(TABLES[k].sheet));
    data[k] = t.rows
      .map(r => rowToObj_(t.head, r))
      .filter(o => o.id && (!since || String(o.server_updated_at) > String(since)));
  });
  return { ok: true, serverTime: serverTime, user: user, data: data };
}

function push_(changes, user) {
  if (user.role === 'director') return { ok: false, error: 'Director accounts are read-only' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActive();
    const cache = {};
    const results = [];
    changes.forEach(ch => {
      const def = TABLES[ch.table];
      const rec = ch.record || {};
      if (!def || !rec.id) { results.push({ id: rec.id, status: 'error', error: 'bad record' }); return; }
      if (!cache[ch.table]) { const sh = ss.getSheetByName(def.sheet); cache[ch.table] = Object.assign({ sh: sh }, read_(sh)); }
      const t = cache[ch.table];

      // add any new columns the app sends
      const extra = Object.keys(rec).filter(k => t.head.indexOf(k) === -1);
      if (extra.length) {
        t.sh.getRange(1, t.head.length + 1, 1, extra.length).setValues([extra]).setFontWeight('bold');
        t.head = t.head.concat(extra);
        t.rows = t.rows.map(r => r.concat(extra.map(() => '')));
      }
      const idCol = t.head.indexOf('id'), verCol = t.head.indexOf('version');
      const idx = t.rows.findIndex(r => String(r[idCol]) === String(rec.id));
      if (idx !== -1 && Number(rec.version) <= Number(t.rows[idx][verCol])) {
        results.push({ id: rec.id, status: 'conflict', server: rowToObj_(t.head, t.rows[idx]) });
        return;
      }
      const now = new Date().toISOString();
      const merged = Object.assign(idx === -1 ? {} : rowToObj_(t.head, t.rows[idx]), rec, { server_updated_at: now });
      const row = t.head.map(h => (merged[h] === undefined || merged[h] === null ? '' : String(merged[h])));
      if (idx === -1) { t.sh.appendRow(row); t.rows.push(row); }
      else { t.sh.getRange(idx + 2, 1, 1, row.length).setValues([row]); t.rows[idx] = row; }
      audit_(user, def.sheet, rec.id, Number(rec.deleted) ? 'delete' : idx === -1 ? 'create' : 'update');
      results.push({ id: rec.id, status: 'ok' });
    });
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

function photo_(p, user) {
  if (user.role === 'director') return { ok: false, error: 'Director accounts are read-only' };
  const sh = SpreadsheetApp.getActive().getSheetByName('Photos');
  const t = read_(sh);
  const existing = t.rows.find(r => String(r[0]) === String(p.id));
  if (existing) return { ok: true, url: existing[3] }; // already uploaded (retry)
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID'));
  const blob = Utilities.newBlob(Utilities.base64Decode(p.base64), 'image/jpeg', p.inspection_id + '_' + p.id + '.jpg');
  const file = folder.createFile(blob);
  const url = file.getUrl();
  sh.appendRow([p.id, p.inspection_id, p.taken_at || '', url, user.staff_id, new Date().toISOString()]);
  return { ok: true, url: url };
}
