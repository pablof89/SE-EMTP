// Simulador mínimo de Google Apps Script para ejecutar Code.gs con Drive en memoria.
const vm = require('vm'), fs = require('fs'), crypto = require('crypto');
function makeEnv(codePath) {
  const files = {}; // name -> {id, content, trashed}
  let idc = 0;
  const calls = { getFilesByName: 0, getFileById: 0 };
  const mkFile = (name, content) => {
    const rec = files[name] || (files[name] = { id: 'id' + (++idc), name, content: '', trashed: false });
    rec.content = content; return rec;
  };
  const fileObj = rec => ({
    getBlob: () => ({ getDataAsString: () => rec.content }),
    setContent: c => { rec.content = c; }, getId: () => rec.id, getName: () => rec.name,
    getUrl: () => 'https://drive/' + rec.id, isTrashed: () => rec.trashed, setTrashed: t => { rec.trashed = t; }
  });
  const folder = {
    getFilesByName: n => { calls.getFilesByName++; const r = files[n]; let used = !r; return { hasNext: () => !used, next: () => { used = true; return fileObj(r); } }; },
    createFile: (n, c) => fileObj(mkFile(n, typeof c === 'string' ? c : '')),
    getFiles: () => { const arr = Object.values(files); let i = 0; return { hasNext: () => i < arr.length, next: () => fileObj(arr[i++]) }; }
  };
  const cacheStore = {}, props = {};
  let lockHeld = false; const lockLog = [];
  const ctx = {
    console, JSON, Math, Date, parseInt, String, Object, Array,
    DriveApp: { getFolderById: () => folder, getFileById: id => { calls.getFileById++; const r = Object.values(files).find(f => f.id === id); if (!r) throw new Error('no file'); return fileObj(r); } },
    CacheService: { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    LockService: { getScriptLock: () => ({
      waitLock: () => { if (lockHeld) throw new Error('lock busy'); lockHeld = true; lockLog.push('acquire'); },
      releaseLock: () => { lockHeld = false; lockLog.push('release'); } }) },
    ContentService: { createTextOutput: s => ({ _s: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    MimeType: { PLAIN_TEXT: 'text' }, MailApp: { sendEmail() {} }, Logger: { log() {} },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, str) => Array.from(crypto.createHash('sha256').update(str).digest()).map(b => b > 127 ? b - 256 : b),
      DigestAlgorithm: { SHA_256: 'sha256' }, base64Decode: x => Buffer.from(x, 'base64'), newBlob: () => ({})
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx);
  ctx.__files = files; ctx.__calls = calls; ctx.__lockLog = lockLog; ctx.__props = props;
  ctx.post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } })._s);
  ctx.seed = db => { mkFile('emtp_db.json', JSON.stringify(db)); mkFile('emtp_meta.json', JSON.stringify({ users: db.users, lastModified: db.lastModified })); };
  ctx.readDbFile = () => JSON.parse(files['emtp_db.json'].content);
  return ctx;
}
module.exports = { makeEnv };
