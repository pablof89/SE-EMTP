// Prueba en navegador: tablero real + Code.gs simulado en memoria.  Uso: node tests/e2e.js
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
// Requiere Playwright + Chromium. Rutas ajustables por entorno.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const CHROME = process.env.CHROME_PATH || undefined;
const { makeEnv } = require('./gas-sim.js');
const fs = require('fs'), assert = require('assert');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const URLRE = /script\.google\.com\/macros/;
let n = 0; const ok = m => console.log('  ✓ ' + m + ' (' + (++n) + ')');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function newEnv() {
  const env = makeEnv(path.join(ROOT, 'Code.gs'));
  const mk = (id, type, name, resp, extra = {}, children = []) => ({ id, type, name, status: 'Pendiente', start: '2026-10-01', end: '2026-10-10', hours: 4, responsibles: resp, support: [], deps: [], notes: '', files: [], children, ...extra });
  const pw = x => env.hashPassword(x);
  env.seed({ lastModified: 1, auditLog: [], trash: [], teams: {}, presupuesto: { years: {}, convenios: [] }, informes: [],
    users: { admin: { password: pw('a'), name: 'Admin', role: 'admin', status: 'approved' }, ana: { password: pw('a'), name: 'Ana', role: 'editor', status: 'approved' }, bob: { password: pw('b'), name: 'Bob', role: 'editor', status: 'approved' } },
    data: [mk('P', 'proyecto', 'Proyecto P', ['Ana'], { eje: '', objetivoEspecifico: '', fase: '', objetivo: 'x' }, [mk('A', 'actividad', 'Act A', [], {}, [mk('t1', 'tarea', 'Tarea 1', ['Ana']), mk('t2', 'tarea', 'Tarea 2', ['Bob'])])])] });
  return env;
}

async function openUser(browser, env, user, pass, hooks = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.route('**/*', async route => {
    const u = route.request().url();
    if (URLRE.test(u)) {
      if (hooks.intercept) { const handled = await hooks.intercept(route); if (handled) return; }
      const body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(env.post(body)) });
    }
    if (u === 'http://app.test/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    return route.abort(); // sin recursos externos (fuentes, íconos)
  });
  await page.goto('http://app.test/');
  await page.fill('#loginUser', user); await page.fill('#loginPass', pass);
  return { ctx, page };
}
const login = async page => { await page.click('#btnLoginBtn'); await page.waitForFunction(() => document.getElementById('mainApp').style.display !== 'none', null, { timeout: 15000 }); };
const srv = env => env.readDbFile();
const findN = (l, id) => { for (const n of l) { if (n.id === id) return n; const f = findN(n.children || [], id); if (f) return f; } return null; };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  console.log('Pruebas en navegador (tablero real + Code.gs simulado)');

  // 1. Login: mensajes claros según el tipo de falla
  { const env = newEnv(); let mode = 'net';
    const { page, ctx } = await openUser(browser, env, 'admin', 'a', { intercept: async route => { if (mode === 'net') { await route.abort('failed'); return true; } if (mode === 'html') { await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><title>Error</title>Servicio invocado demasiadas veces</html>' }); return true; } return false; } });
    await page.click('#btnLoginBtn'); await page.waitForFunction(() => document.getElementById('loginError').style.display === 'block', null, { timeout: 15000 });
    let t = await page.textContent('#loginError'); assert.match(t, /No se pudo contactar al servidor/); ok('login sin red → "No se pudo contactar al servidor… red institucional"');
    mode = 'html'; await page.click('#btnLoginBtn'); await page.waitForFunction(() => /Google devolvió/.test(document.getElementById('loginError').textContent), null, { timeout: 15000 });
    ok('login con página de error de Google → mensaje específico (no "error de conexión" genérico)');
    mode = 'ok'; await login(page); ok('login normal OK tras recuperarse'); await ctx.close(); }

  // 2. Cambio de otra persona aparece sin recargar (bug del "modal" que bloqueaba la sincronización)
  { const env = newEnv();
    const A = await openUser(browser, env, 'admin', 'a'); await login(A.page);
    const B = await openUser(browser, env, 'ana', 'a'); await login(B.page);
    await B.page.evaluate(() => updateField('t1', 'status', 'Completado'));
    await sleep(2500); assert.equal(findN(srv(env).data, 't1').status, 'Completado'); ok('Ana cambia estado → llega al servidor');
    await A.page.evaluate(() => syncTick()); await sleep(800);
    const st = await A.page.evaluate(() => findNode('t1').status); assert.equal(st, 'Completado'); ok('el admin ve el cambio de Ana tras sincronizar, sin recargar (antes nunca lo veía)');
    // 3. admin edita otro campo con datos ya al día, y luego Ana edita sin que el admin sincronice
    await A.page.evaluate(() => updateField('t1', 'hours', 77)); await sleep(2500);
    await B.page.evaluate(() => updateField('t1', 'notes', 'nota de Ana')); await sleep(2500);
    const t1 = findN(srv(env).data, 't1'); assert.equal(t1.hours, 77); assert.equal(t1.notes, 'nota de Ana'); assert.equal(t1.status, 'Completado'); ok('ediciones simultáneas de dos cuentas se combinan en el servidor');
    await B.page.evaluate(() => syncTick()); await sleep(800);
    assert.equal(await B.page.evaluate(() => findNode('t1').hours), 77); ok('la otra cuenta también termina viendo todo'); 
    assert.deepEqual(A.page.errors.concat(B.page.errors), []); await A.ctx.close(); await B.ctx.close(); }

  // 4. Falla de red al guardar: banner, reintento y recuperación sin perder el cambio
  { const env = newEnv(); let fail = false;
    const A = await openUser(browser, env, 'ana', 'a', { intercept: async route => { if (fail && /"action":"save"/.test(route.request().postData() || '')) { await route.abort('failed'); return true; } return false; } });
    await login(A.page); fail = true;
    await A.page.evaluate(() => updateField('t1', 'status', 'En curso')); await sleep(2500);
    assert.equal(await A.page.evaluate(() => getComputedStyle(document.getElementById('saveBanner')).display), 'flex'); ok('si el guardado falla aparece el banner de aviso');
    assert.equal(findN(srv(env).data, 't1').status, 'Pendiente');
    fail = false; await A.page.click('#saveBanner button', { timeout: 3000 }).catch(() => {}); /* si el reintento automático ya se adelantó, el banner ya se ocultó */ await A.page.waitForFunction(() => getComputedStyle(document.getElementById('saveBanner')).display === 'none', null, { timeout: 15000 });
    assert.equal(findN(srv(env).data, 't1').status, 'En curso'); assert.equal(await A.page.evaluate(() => getComputedStyle(document.getElementById('saveBanner')).display), 'none'); ok('al volver la red el cambio se guarda (reintento automático o "Reintentar ahora") y el banner se oculta'); await A.ctx.close(); }

  // 5. Servidor ocupado (bloqueo): reintento automático
  { const env = newEnv(); let busy = 2;
    const A = await openUser(browser, env, 'ana', 'a', { intercept: async route => { if (busy > 0 && /"action":"save"/.test(route.request().postData() || '')) { busy--; await route.fulfill({ status: 200, contentType: 'text/plain', body: JSON.stringify({ status: 'error', retry: true, message: 'El servidor está ocupado' }) }); return true; } return false; } });
    await login(A.page);
    await A.page.evaluate(() => updateField('t1', 'status', 'Completado')); await sleep(7500);
    assert.equal(findN(srv(env).data, 't1').status, 'Completado'); ok('"servidor ocupado" se reintenta solo (con espera creciente) y termina guardando'); await A.ctx.close(); }

  // 6. Cambio de la otra cuenta llega mientras hay cambios sin enviar: no se pierde nada
  { const env = newEnv();
    const A = await openUser(browser, env, 'admin', 'a'); await login(A.page);
    const B = await openUser(browser, env, 'bob', 'b'); await login(B.page);
    await B.page.evaluate(() => updateField('t2', 'status', 'Bloqueado')); await sleep(2000);
    await A.page.evaluate(() => { updateField('t1', 'name', 'Renombrada por admin'); return syncTick(); }); await sleep(2000);
    const d = srv(env).data; assert.equal(findN(d, 't1').name, 'Renombrada por admin'); assert.equal(findN(d, 't2').status, 'Bloqueado');
    assert.equal(await A.page.evaluate(() => findNode('t2').status), 'Bloqueado'); ok('cambio propio pendiente + cambio ajeno: ambos terminan en servidor y en pantalla'); await A.ctx.close(); await B.ctx.close(); }

  // 7. Estado de tarea ajena (regla de proyecto) persiste en el servidor
  { const env = newEnv(); const A = await openUser(browser, env, 'ana', 'a'); await login(A.page);
    await A.page.evaluate(() => updateField('t2', 'status', 'Completado')); await sleep(2500);
    assert.equal(findN(srv(env).data, 't2').status, 'Completado'); ok('Ana cambia el estado de una tarea de Bob (mismo proyecto): queda guardado en servidor');
    await A.page.evaluate(() => { findNode('t2').name = 'x'; saveData(); }); await sleep(2500);
    assert.equal(findN(srv(env).data, 't2').name, 'Tarea 2'); assert.equal(await A.page.evaluate(() => findNode('t2').name), 'Tarea 2'); ok('un cambio no permitido (nombre de tarea ajena) se descarta y la pantalla vuelve a la versión del servidor'); await A.ctx.close(); }

  await browser.close(); console.log('\nTodas las pruebas del navegador OK (' + n + ')');
})().catch(e => { console.error('FALLÓ:', e); process.exit(1); });
