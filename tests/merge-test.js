// Pruebas de la fusión de guardados de Code.gs.  Uso: node tests/merge-test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const { makeEnv } = require('./gas-sim.js');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const core = html.match(/\/\/ <sync-core>([\s\S]*?)\/\/ <\/sync-core>/)[1];
const { snapshotTree, diffSnapshots } = new Function(core + '; return { snapshotTree, diffSnapshots, snapshotsEqual, trashKeyOf };')();
const clone = x => JSON.parse(JSON.stringify(x));

function newEnv() {
  const env = makeEnv(path.join(ROOT, 'Code.gs'));
  const mk = (id, type, name, resp, extra = {}, children = []) => ({ id, type, name, status: 'Pendiente', start: '2026-10-01', end: '2026-10-10', hours: 4, responsibles: resp, support: [], children, ...extra });
  const db = {
    lastModified: 1, auditLog: [], trash: [], teams: {}, presupuesto: { years: {}, convenios: [] }, informes: [],
    users: {
      admin: { password: env.hashPassword('a'), name: 'Admin', role: 'admin', status: 'approved' },
      ana: { password: env.hashPassword('a'), name: 'Ana', role: 'editor', status: 'approved' },
      bob: { password: env.hashPassword('b'), name: 'Bob', role: 'editor', status: 'approved' },
      cami: { password: env.hashPassword('c'), name: 'Cami', role: 'editor', status: 'approved' },
    },
    data: [
      mk('P', 'proyecto', 'Proyecto P', ['Ana'], {}, [
        mk('A', 'actividad', 'Act A', [], {}, [
          mk('t1', 'tarea', 'Tarea 1', ['Ana']),
          mk('t2', 'tarea', 'Tarea 2', ['Bob']),
          mk('t3', 'tarea', 'Tarea 3', ['Ana']),
          mk('h1', 'hito', 'Hito 1', ['Bob'], { end: '2026-10-05', start: '2026-10-05' }),
        ])]),
      mk('Q', 'proyecto', 'Proyecto Q', ['Bob'], {}, [mk('q1', 'tarea', 'Q1', ['Bob'])]),
    ]
  };
  env.seed(db);
  return env;
}
class Client {
  constructor(env, user, pass) { this.env = env; this.user = user; this.pass = pass; }
  login() { const r = this.env.post({ action: 'login', user: this.user, pass: this.pass }); assert.equal(r.status, 'success', JSON.stringify(r)); this.adopt(r.payload); return this; }
  adopt(p) { this.data = clone(p.data); this.trash = clone(p.trash || []); this.audit = clone(p.auditLog || []); this.snap = snapshotTree(this.data); this.trashBase = new Set(this.trash.map(t => (t.node && t.node.id) + '|' + t.deletedAt)); }
  find(id, list = this.data) { for (const n of list) { if (n.id === id) return n; const f = this.find(id, n.children || []); if (f) return f; } return null; }
  save(opts = {}) {
    const cur = snapshotTree(this.data), d = diffSnapshots(this.snap, cur);
    const trashNow = new Set(this.trash.map(t => (t.node && t.node.id) + '|' + t.deletedAt));
    const hints = opts.noHints ? undefined : { changed: d.changed, deleted: d.deleted, trashRemoved: [...this.trashBase].filter(k => !trashNow.has(k)), replaceAll: !!opts.replaceAll };
    const r = this.env.post({ action: 'save', user: this.user, pass: this.pass, payload: { data: this.data, users: {}, teams: {}, auditLog: this.audit, trash: this.trash, hints } });
    assert.equal(r.status, 'success', JSON.stringify(r));
    this.snap = cur; this.trashBase = trashNow;
    return r;
  }
  refresh() { const r = this.env.post({ action: 'load', user: this.user, pass: this.pass }); this.adopt(r.payload); return this; }
}
const dbNow = env => env.readDbFile();
const find = (list, id) => { for (const n of list) { if (n.id === id) return n; const f = find(n.children || [], id); if (f) return f; } return null; };
let n = 0; const ok = m => console.log('  ✓ ' + m + ' (' + (++n) + ')');

console.log('Escenarios de fusión');
{ // 1. admin desactualizado no revierte el cambio de otra persona
  const env = newEnv(); const admin = new Client(env, 'admin', 'a').login(); const bob = new Client(env, 'bob', 'b').login();
  bob.find('t2').status = 'En curso'; bob.find('t2').updatedAt = 'x'; bob.save();
  admin.find('t1').name = 'Tarea 1 renombrada'; admin.save();   // admin nunca vio el cambio de Bob
  const d = dbNow(env).data;
  assert.equal(find(d, 't2').status, 'En curso'); assert.equal(find(d, 't1').name, 'Tarea 1 renombrada');
  ok('admin con datos viejos NO revierte el estado cambiado por Bob');
}
{ // 2. cambios en campos distintos del mismo nodo
  const env = newEnv(); const admin = new Client(env, 'admin', 'a').login(); const ana = new Client(env, 'ana', 'a').login();
  ana.find('t1').status = 'Completado'; ana.save();
  admin.find('t1').hours = 99; admin.save();
  const t = find(dbNow(env).data, 't1'); assert.equal(t.status, 'Completado'); assert.equal(t.hours, 99);
  ok('campos distintos de una misma tarea se combinan (estado de Ana + horas del admin)');
}
{ // 3. tarea nueva de otra persona no se borra con un guardado viejo
  const env = newEnv(); const admin = new Client(env, 'admin', 'a').login(); const ana = new Client(env, 'ana', 'a').login();
  ana.find('A').children.push({ id: 'tNEW', type: 'tarea', name: 'Nueva de Ana', status: 'Pendiente', responsibles: [], support: [], children: [] }); ana.save();
  admin.find('t3').notes = 'nota'; admin.save();
  assert.ok(find(dbNow(env).data, 'tNEW'), 'la tarea nueva fue borrada'); assert.equal(find(dbNow(env).data, 't3').notes, 'nota');
  ok('la tarea creada por Ana sobrevive al guardado de un admin desactualizado');
}
{ // 4. eliminación explícita
  const env = newEnv(); const admin = new Client(env, 'admin', 'a').login();
  const A = admin.find('A'); A.children = A.children.filter(c => c.id !== 't3'); admin.save();
  assert.equal(find(dbNow(env).data, 't3'), null); assert.ok(find(dbNow(env).data, 't1'));
  ok('una eliminación explícita sí se aplica');
}
{ // 5. editor desactualizado no borra lo ajeno que no conocía (aunque participe)
  const env = newEnv(); const ana = new Client(env, 'ana', 'a').login(); const admin = new Client(env, 'admin', 'a').login();
  admin.find('A').children.push({ id: 'tX', type: 'tarea', name: 'Admin nueva', status: 'Pendiente', responsibles: ['Ana'], support: [], children: [] }); admin.save();
  ana.find('t1').name = 'T1 por Ana'; ana.save();   // Ana no conoce tX
  assert.ok(find(dbNow(env).data, 'tX'), 'tX borrada'); assert.equal(find(dbNow(env).data, 't1').name, 'T1 por Ana');
  ok('un editor con datos viejos no borra una tarea asignada a él que aún no veía');
}
{ // 6. permisos: editor cambia estado de tarea ajena del mismo proyecto, pero no el nombre
  const env = newEnv(); const ana = new Client(env, 'ana', 'a').login();
  ana.find('t2').status = 'Bloqueado'; ana.find('t2').name = 'HACK'; ana.find('h1').status = 'Completado'; ana.save();
  const d = dbNow(env).data;
  assert.equal(find(d, 't2').status, 'Bloqueado'); assert.equal(find(d, 't2').name, 'Tarea 2'); assert.equal(find(d, 'h1').status, 'Completado');
  ok('editor de otro nodo del proyecto: cambia estado (tarea e hito) pero no el nombre');
}
{ // 7. permisos: editor sin participación en el proyecto
  const env = newEnv(); const cami = new Client(env, 'cami', 'c').login();
  cami.find('t1').status = 'Completado'; cami.find('q1').name = 'HACK'; cami.save();
  assert.equal(find(dbNow(env).data, 't1').status, 'Pendiente'); assert.equal(find(dbNow(env).data, 'q1').name, 'Q1');
  ok('un editor que no participa en el proyecto no cambia nada');
}
{ // 8. editor no puede asignar responsables ni crear proyectos; lo creado nace sin asignados
  const env = newEnv(); const ana = new Client(env, 'ana', 'a').login();
  ana.find('t1').responsibles = ['Ana', 'Cami']; ana.data.push({ id: 'PX', type: 'proyecto', name: 'Mío', responsibles: ['Ana'], support: [], children: [] });
  ana.find('A').children.push({ id: 'tN', type: 'hito', name: 'Hito nuevo', status: 'Pendiente', start: '2026-11-01', end: '2026-11-01', responsibles: ['Ana'], support: [], children: [] }); ana.save();
  const d = dbNow(env).data;
  assert.deepEqual(find(d, 't1').responsibles, ['Ana']); assert.equal(find(d, 'PX'), null);
  assert.deepEqual(find(d, 'tN').responsibles, []); assert.equal(find(d, 'tN').type, 'hito');
  ok('editor: no asigna personas, no crea proyectos; el hito nuevo nace sin asignados');
}
{ // 9. mover una tarea (admin) conserva sus datos y no duplica
  const env = newEnv(); const admin = new Client(env, 'admin', 'a').login();
  const A = admin.find('A'); const t = A.children.splice(A.children.findIndex(c => c.id === 't1'), 1)[0]; admin.find('Q').children.push(t); admin.save();
  const d = dbNow(env).data; const ids = []; (function w(l) { l.forEach(x => { ids.push(x.id); w(x.children || []); }); })(d);
  assert.equal(ids.filter(i => i === 't1').length, 1); assert.ok(find(find(d, 'Q').children, 't1')); assert.deepEqual(find(d, 't1').responsibles, ['Ana']);
  ok('mover una tarea de actividad a otro proyecto: una sola copia y conserva responsables');
}
{ // 10. reordenar
  const env = newEnv(); const admin = new Client(env, 'admin', 'a').login();
  const A = admin.find('A'); A.children.reverse(); admin.save();
  assert.deepEqual(find(dbNow(env).data, 'A').children.map(c => c.id), ['h1', 't3', 't2', 't1']);
  ok('reordenar hijos se respeta cuando el cliente lo cambió');
}
{ // 11. cliente antiguo sin hints
  const env = newEnv(); const admin = new Client(env, 'admin', 'a').login();
  admin.find('t1').name = 'viejo'; admin.save({ noHints: true });
  assert.equal(find(dbNow(env).data, 't1').name, 'viejo');
  ok('cliente antiguo (sin hints) sigue funcionando');
}
{ // 12. restaurar respaldo reemplaza todo
  const env = newEnv(); const admin = new Client(env, 'admin', 'a').login(); const bob = new Client(env, 'bob', 'b').login();
  bob.find('A').children.push({ id: 'tB', type: 'tarea', name: 'de Bob', status: 'Pendiente', responsibles: [], support: [], children: [] }); bob.save();
  admin.data = admin.data.filter(p => p.id === 'P'); admin.save({ replaceAll: true });
  assert.deepEqual(dbNow(env).data.map(p => p.id), ['P']);
  ok('restaurar respaldo (replaceAll) reemplaza todo el árbol');
}
{ // 13. historial y papelera se combinan
  const env = newEnv(); const a = new Client(env, 'admin', 'a').login(); const b = new Client(env, 'bob', 'b').login();
  a.audit.push({ date: '2026-10-01T10:00:00Z', user: 'admin', action: 'status', detail: 'uno' }); a.save();
  b.audit.push({ date: '2026-10-01T11:00:00Z', user: 'bob', action: 'status', detail: 'dos' }); b.save();
  assert.deepEqual(dbNow(env).auditLog.map(e => e.detail), ['uno', 'dos']);
  a.trash.push({ node: { id: 'zz' }, deletedAt: 't1', deletedBy: 'admin' }); a.save();
  b.trash.push({ node: { id: 'yy' }, deletedAt: 't2', deletedBy: 'bob' }); b.save();
  assert.equal(dbNow(env).trash.length, 2);
  a.refresh(); a.trash = a.trash.filter(t => t.node.id !== 'zz'); a.save();   // restaurar zz
  assert.deepEqual(dbNow(env).trash.map(t => t.node.id), ['yy']);
  ok('historial y papelera se unen; restaurar retira solo ese elemento');
}
{ // 14. respuesta del guardado trae el estado fusionado
  const env = newEnv(); const ana = new Client(env, 'ana', 'a').login(); const bob = new Client(env, 'bob', 'b').login();
  bob.find('t2').notes = 'de Bob'; bob.save();
  const r = ana.save(); // guardado sin cambios propios
  assert.equal(find(r.payload.data, 't2').notes, 'de Bob');
  ok('save devuelve el estado fusionado (incluye cambios de otras personas)');
}
{ // 15. bloqueo: toda escritura adquiere y libera; si está tomado responde "ocupado"
  const env = newEnv(); const a = new Client(env, 'admin', 'a').login(); a.find('t1').name = 'x'; a.save();
  assert.deepEqual(env.__lockLog.slice(-2), ['acquire', 'release']);
  const idx = env.__lockLog.length;
  // simular otra ejecución sosteniendo el bloqueo
  const lk = env.LockService.getScriptLock(); lk.waitLock();
  const r = env.post({ action: 'save', user: 'admin', pass: 'a', payload: { data: a.data, hints: { changed: {}, deleted: [] } } });
  lk.releaseLock();
  assert.equal(r.status, 'error'); assert.equal(r.retry, true);
  ok('con el bloqueo tomado, el guardado responde "ocupado" con retry=true (no se pierde ni se pisa)');
  const r2 = env.post({ action: 'heartbeat', user: 'admin', pass: 'a' }); assert.equal(r2.status, 'success');
  ok('heartbeat no necesita bloqueo');
}
{ // 16. IDs en caché: la segunda llamada no busca por nombre
  const env = newEnv(); env.post({ action: 'login', user: 'admin', pass: 'a' }); const c0 = env.__calls.getFilesByName;
  env.post({ action: 'login', user: 'admin', pass: 'a' }); env.post({ action: 'login', user: 'admin', pass: 'a' });
  assert.equal(env.__calls.getFilesByName, c0, 'sigue buscando por nombre');
  ok('ubicación de archivos por ID en caché (sin búsquedas por nombre repetidas)');
}
console.log('\nTodos los escenarios OK (' + n + ')');
