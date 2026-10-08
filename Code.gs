/**
 * Tablero SE EMTP — Backend (Google Apps Script)
 * Versión corregida tras auditoría de seguridad, más los cambios de permisos
 * y visibilidad pedidos después. Cambios marcados con "PARCHE:" en cada bloque:
 *
 *  1) login/load ya no devuelven contraseñas al cliente.
 *  2) save valida el rol y aplica los cambios nodo por nodo respetando
 *     permisos, en vez de aceptar y sobrescribir el árbol completo tal cual
 *     lo envíe cualquier usuario autenticado.
 *  3) Ya no existe un admin por defecto con contraseña de fábrica. Si la base
 *     de datos no existe, hay que crearla una vez a mano con initializeDatabase().
 *  4) Límite de intentos de login por usuario (bloqueo temporal tras varios
 *     intentos fallidos), usando PropertiesService.
 *  5) La contraseña temporal de recuperación se genera con Utilities.getUuid()
 *     en vez de Math.random().
 *  6) VISIBILIDAD: ahora se envían TODOS los proyectos a cualquier usuario
 *     aprobado (antes solo los propios). Ver quiénes participan en qué ya no
 *     es un límite de seguridad — es una preferencia que el frontend resuelve
 *     con el filtro "Mis proyectos / Todos los proyectos". Lo que sigue
 *     restringido por rol es la EDICIÓN, no la lectura.
 *  7) PERMISOS: un editor ya no puede modificar los campos de un proyecto
 *     donde no participa (antes sí podía, para cualquier proyecto). Tampoco
 *     puede crear proyectos nuevos, ni cambiar quién está asignado como
 *     responsable o apoyo — ambas cosas quedan reservadas a administradores.
 *  8) RENDIMIENTO: "heartbeat" (la consulta más frecuente, cada pocos
 *     minutos por cada persona conectada) ya no lee ni convierte a JSON el
 *     archivo completo de la base de datos — usa un archivo aparte, mucho
 *     más liviano (emtp_meta.json), que se mantiene sincronizado solo cada
 *     vez que se guarda algo. Además, el historial y la papelera nunca
 *     crecen sin límite en el servidor, sin importar lo que mande el
 *     navegador. No requiere ningún paso manual: el archivo liviano se crea
 *     solo la primera vez que haga falta.
 *  9) ESTADO DE TAREAS/HITOS: un editor que participa en algún nodo de un
 *     proyecto puede cambiar el ESTADO de cualquier tarea o hito de ese
 *     proyecto (igual que el tablero: canChangeStatus). Ningún otro campo
 *     de un nodo ajeno se acepta — ver mergeNodeWithPermissions.
 * 10) CONCURRENCIA: los guardados y demás escrituras se ejecutan de a uno
 *     (LockService). Antes, dos guardados simultáneos leían la misma base y el
 *     último pisaba al primero.
 * 11) GUARDADO POR CAMBIOS: el tablero ahora informa qué campos modificó y qué
 *     elementos eliminó ("hints"). El servidor solo aplica eso sobre su versión
 *     actual, en vez de aceptar el árbol completo que tenía el navegador (que
 *     podía estar desactualizado y borrar lo que otras personas hicieron).
 *     Esto incluye a los administradores. Los clientes antiguos (sin "hints")
 *     siguen funcionando como antes.
 * 12) HISTORIAL Y PAPELERA se combinan en vez de reemplazarse.
 * 13) RENDIMIENTO: los archivos de la base se ubican por ID (en caché) y no por
 *     búsqueda de nombre en cada llamada.
 * 14) "save" devuelve el estado ya fusionado, para que el navegador quede al día.
 */

// ── PUNTO DE ENTRADA ────────────────────────────────────────────────────
var WRITE_ACTIONS = ['save', 'register', 'recoverPassword', 'removeUser', 'changePassword'];

function doPost(e) {
  if (!e || !e.postData) return response({ status: "error", message: "Sin datos" });

  var lock = null;
  try {
    var json = JSON.parse(e.postData.contents);
    var folder = DriveApp.getFolderById("1Ja1od5-h-mPmVKmxKIu8ClvLzsTcTCl_"); // TU ID DE CARPETA

    // PARCHE (rendimiento): "heartbeat" se atiende ANTES de tocar el archivo
    // completo de la base de datos. Es la acción que más se repite (cada
    // pocos minutos, por cada persona con el tablero abierto), así que
    // evitar que cada una de esas consultas obligue a leer y convertir a
    // JSON todo el archivo (proyectos + historial + papelera) es lo que más
    // impacta en la lentitud y en toparse con los límites de uso de Drive.
    // Solo lee un archivo mucho más liviano (emtp_meta.json).
    if (json.action === "heartbeat") {
      var meta = loadMeta(folder);
      if (!meta) {
        return response({ status: "error", message: "La base de datos no existe todavía." });
      }
      var hbUser = meta.users[json.user];
      if (!json.user || !json.pass || !hbUser || !verifyPassword(json.pass, hbUser.password) ||
          (hbUser.status !== 'approved' && hbUser.role !== 'admin')) {
        return response({ status: "error", message: "Acceso denegado. No tienes permisos." });
      }
      var hbResult = handleHeartbeatResult(json.user);
      hbResult.lastModified = meta.lastModified || 0;
      return response(hbResult);
    }

    // PARCHE (concurrencia): toda escritura espera su turno ANTES de leer la base,
    // para que cada una parta de la versión más reciente.
    if (WRITE_ACTIONS.indexOf(json.action) !== -1) {
      lock = LockService.getScriptLock();
      try {
        lock.waitLock(30000);
      } catch (lockErr) {
        lock = null;
        return response({ status: "error", retry: true, message: "El servidor está ocupado guardando otros cambios. Se reintentará automáticamente." });
      }
    }

    var dbFile = getNamedFile(folder, "emtp_db.json");

    // PARCHE (3): ya no se crea un admin de fábrica con contraseña conocida.
    // Si el archivo de base de datos no existe, se detiene con un mensaje claro
    // en vez de dejar una cuenta admin/admin123 accesible para cualquiera que
    // conozca la URL pública del endpoint.
    if (!dbFile) {
      return response({
        status: "error",
        message: "La base de datos no existe todavía. Un administrador debe ejecutar " +
                  "initializeDatabase() una vez desde el editor de Apps Script antes de usar el tablero."
      });
    }

    var db = JSON.parse(dbFile.getBlob().getDataAsString());
    if (!db.auditLog) db.auditLog = [];
    if (!db.lastModified) db.lastModified = 0;
    if (!db.users) db.users = {};
    if (!db.data) db.data = [];
    if (!db.teams) db.teams = {};
    if (!db.trash) db.trash = [];
    if (!db.presupuesto) db.presupuesto = { years: {}, convenios: [] };
    if (!db.informes) db.informes = [];

    var reqUser = json.user;
    var reqPass = json.pass;

    // ── RUTAS PÚBLICAS ─────────────────────────────────────────────────

    // REGISTRO
    if (json.action === "register") {
      var newUser = json.newUser;
      var newPass = json.newPass;
      if (!newUser || !newPass) return response({ status: "error", message: "Faltan datos" });
      if (db.users[newUser]) return response({ status: "error", message: "El usuario ya existe" });
      db.users[newUser] = {
        password: hashPassword(newPass),
        name: newUser,
        role: 'user',
        status: 'pending',
        email: (json.newEmail || ''),
        team: ''
      };
      saveDb(folder, db);
      return response({ status: "success", message: "Registrado con éxito. Esperando validación del administrador." });
    }

    // RECUPERAR CONTRASEÑA (envía clave temporal al correo)
    if (json.action === "recoverPassword") {
      var idf = (json.email || json.user || '').toString().trim().toLowerCase();
      if (!idf) return response({ status: "error", message: "Indica tu correo o usuario." });
      var foundKey = null;
      for (var k in db.users) {
        if (k.toLowerCase() === idf || ((db.users[k].email || '').toLowerCase() === idf)) { foundKey = k; break; }
      }
      // No confirmamos si la cuenta existe o no con mensajes distintos, para no
      // filtrar qué correos/usuarios están registrados a quien no tiene acceso.
      if (!foundKey || !db.users[foundKey].email) {
        return response({ status: "success", message: "Si la cuenta existe, te enviamos una contraseña temporal a su correo asociado." });
      }
      var dest = db.users[foundKey].email;
      // PARCHE (5): generador aleatorio criptográficamente más sólido que Math.random().
      var temp = generateSecureToken(10);
      db.users[foundKey].password = hashPassword(temp);
      db.lastModified = new Date().getTime();
      saveDb(folder, db);
      MailApp.sendEmail(dest, "Recuperación de contraseña - Tablero SE EMTP",
        "Hola " + (db.users[foundKey].name || foundKey) + ":\n\n" +
        "Tu contraseña temporal es: " + temp + "\n\n" +
        "Inicia sesión con ella y cámbiala desde el botón de la llave (🔑) en la barra superior.\n\n" +
        "Tablero SE EMTP - Ministerio de Educación de Chile");
      return response({ status: "success", message: "Si la cuenta existe, te enviamos una contraseña temporal a su correo asociado." });
    }

    // LOGIN
    if (json.action === "login") {
      // PARCHE (4): límite de intentos fallidos antes de siquiera revisar la contraseña.
      var lockCheck = checkLoginLock(reqUser);
      if (lockCheck.locked) {
        return response({ status: "error", message: "Demasiados intentos fallidos. Intenta de nuevo en " + lockCheck.minutesLeft + " minuto(s)." });
      }

      var u = db.users[reqUser];
      if (!u || !verifyPassword(reqPass, u.password)) {
        registerFailedLogin(reqUser);
        return response({ status: "error", message: "Credenciales incorrectas" });
      }
      if (u.status !== 'approved' && u.role !== 'admin') {
        return response({ status: "error", message: "Tu cuenta está esperando la aprobación del administrador." });
      }

      clearLoginLock(reqUser);

      // Migración transparente: si la contraseña aún estaba en texto plano, se hashea ahora.
      if (!isHashed(u.password)) {
        migrateLegacyPassword(folder, reqUser, reqPass);
      }

      // PARCHE (1): la respuesta ya no incluye contraseñas ni datos fuera del alcance del usuario.
      return response({ status: "success", payload: buildClientPayload(db, reqUser) });
    }

    // ── BARRERA DE SEGURIDAD (rutas privadas) ──────────────────────────
    var authUser = db.users[reqUser];
    if (!reqUser || !reqPass || !authUser || !verifyPassword(reqPass, authUser.password) ||
        (authUser.status !== 'approved' && authUser.role !== 'admin')) {
      return response({ status: "error", message: "Acceso denegado. No tienes permisos." });
    }
    var reqRole = authUser.role;
    var reqDisplayName = authUser.name || reqUser;

    // ── RUTAS PRIVADAS ──────────────────────────────────────────────────
    var result = {};

    if (json.action === "load") {
      // PARCHE (1): mismo filtrado que en login.
      result = { status: "success", payload: buildClientPayload(db, reqUser) };
    }

    else if (json.action === "save") {
      // PARCHE (2): ya no se acepta el árbol completo tal cual lo mande cualquier
      // usuario autenticado. Se valida el rol y se fusiona nodo por nodo respetando
      // quién puede modificar o eliminar qué, en vez de sobrescribir todo.
      if (reqRole === 'viewer') {
        return response({ status: "error", message: "Tu rol no permite guardar cambios." });
      }

      var incomingData = (json.payload && json.payload.data) || [];
      var hints = normalizeHints(json.payload && json.payload.hints);
      db.data = mergeDataWithPermissions(db.data, incomingData, reqUser, reqRole, reqDisplayName, hints);

      if (json.payload && json.payload.teams) db.teams = json.payload.teams;
      // PARCHE (rendimiento): límite de respaldo en el servidor — sin
      // importar lo que mande el navegador, el historial y la papelera
      // nunca crecen sin control (eso hace cada vez más lento leer el
      // archivo completo en cada acción).
      if (json.payload && json.payload.auditLog) {
        db.auditLog = hints ? mergeAuditLog(db.auditLog, json.payload.auditLog) : json.payload.auditLog.slice(-300);
      }
      // PARCHE (papelera): se guarda tal cual, sin fusión node-a-node — es
      // un registro plano, no el árbol de proyectos, así que no necesita el
      // mismo cuidado de permisos que mergeDataWithPermissions.
      if (json.payload && json.payload.trash) {
        db.trash = hints ? mergeTrash(db.trash, json.payload.trash, hints.trashRemoved) : json.payload.trash.slice(-200);
      }

      // PARCHE (presupuesto): permisos aplicados en el servidor, no solo
      // ocultos en la pantalla — ver mergePresupuesto/mergeInformes arriba.
      var reqIsAdmin = reqRole === 'admin';
      var reqIsFin = reqIsAdmin || !!(db.users[reqUser] && db.users[reqUser].finanzas);
      if (json.payload && json.payload.presupuesto) mergePresupuesto(db, json.payload.presupuesto, reqIsAdmin, reqIsFin);
      if (json.payload && json.payload.informes) mergeInformes(db, json.payload.informes);

      if (reqRole === 'admin' && json.payload && json.payload.users) {
        var incomingUsers = json.payload.users;
        // Cualquier contraseña que llegue en texto plano (recién creada/editada por el
        // admin) se hashea antes de persistir. Las que ya vienen hasheadas se dejan igual.
        for (var uk in incomingUsers) {
          var pw = incomingUsers[uk].password;
          if (pw && !isHashed(pw)) incomingUsers[uk].password = hashPassword(pw);
          // Si el admin editó datos de un usuario pero el campo password llegó vacío
          // (porque el cliente ya no lo recibe — ver PARCHE 1), conservamos el hash existente.
          if (!pw && db.users[uk]) incomingUsers[uk].password = db.users[uk].password;
        }
        // PARCHE: se FUSIONA con lo que ya existe en el servidor, en vez de
        // reemplazar toda la lista. Antes, si alguien se registraba o era
        // aprobado DESPUÉS de que el admin cargara la página, la próxima vez
        // que ese admin guardara cualquier cosa (aunque fuera una tarea),
        // esa cuenta nueva desaparecía por completo de la base de datos —
        // porque el navegador del admin nunca la había recibido y por lo
        // tanto no venía en su payload. Ahora se agregan/actualizan los
        // usuarios que llegan, pero no se borra a nadie que el admin no
        // haya visto nunca.
        var mergedUsers = {};
        for (var existingKey in db.users) mergedUsers[existingKey] = db.users[existingKey];
        for (var incomingKey in incomingUsers) mergedUsers[incomingKey] = incomingUsers[incomingKey];
        db.users = mergedUsers;
      }

      db.lastModified = new Date().getTime();
      saveDb(folder, db);
      // El navegador recibe el estado ya fusionado (incluye lo de otras personas y
      // descarta lo que su rol no permite), para quedar exactamente igual al servidor.
      result = { status: "success", lastModified: db.lastModified, payload: buildClientPayload(db, reqUser) };
    }

    // PARCHE: eliminar un usuario es ahora una acción explícita y propia,
    // no algo que se infiere de que falte en el payload de "save" — así el
    // servidor sabe con certeza que es un borrado intencional del admin, y
    // no una cuenta que el navegador del admin simplemente nunca había visto.
    else if (json.action === "removeUser") {
      if (reqRole !== 'admin') {
        result = { status: "error", message: "Solo un administrador puede eliminar usuarios." };
      } else {
        var targetUser = json.targetUser;
        if (!targetUser || !db.users[targetUser]) {
          result = { status: "error", message: "Ese usuario no existe." };
        } else if (targetUser === reqUser) {
          result = { status: "error", message: "No puedes eliminar tu propia cuenta." };
        } else {
          delete db.users[targetUser];
          db.lastModified = new Date().getTime();
          saveDb(folder, db);
          result = { status: "success" };
        }
      }
    }

    // CAMBIAR CONTRASEÑA (el usuario ya validó su clave actual en la barrera)
    else if (json.action === "changePassword") {
      var np = json.newPass;
      if (!np || np.length < 4) {
        result = { status: "error", message: "La nueva contraseña debe tener al menos 4 caracteres." };
      } else {
        db.users[reqUser].password = hashPassword(np);
        db.lastModified = new Date().getTime();
        saveDb(folder, db);
        result = { status: "success", message: "Contraseña actualizada." };
      }
    }

    else if (json.action === "uploadFile") {
      var fileData = Utilities.base64Decode(json.data);
      var blob = Utilities.newBlob(fileData, json.mimetype, json.filename);
      var file = folder.createFile(blob);
      result = { status: "success", url: file.getUrl(), name: file.getName(), id: file.getId() };
    }

    else if (json.action === "getFiles") {
      var files = folder.getFiles();
      var fileList = [];
      while (files.hasNext()) {
        var f = files.next();
        if (f.getName() !== "emtp_db.json" && f.getName() !== "emtp_meta.json") fileList.push({ name: f.getName(), url: f.getUrl(), id: f.getId() });
      }
      result = { status: "success", files: fileList };
    }

    // ELIMINAR ARCHIVO (solo admin) — envía a la papelera de Drive.
    else if (json.action === "deleteFile") {
      if (reqRole !== 'admin') {
        result = { status: "error", message: "Solo administradores pueden eliminar archivos." };
      } else {
        try {
          DriveApp.getFileById(json.fileId).setTrashed(true);
          result = { status: "success" };
        } catch (delErr) {
          result = { status: "error", message: "No se pudo eliminar el archivo: " + delErr.toString() };
        }
      }
    }

    return response(result);

  } catch (err) {
    return response({ status: "error", message: err.toString() });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (relErr) { /* ya liberado */ } }
  }
}

// ── PERSISTENCIA ─────────────────────────────────────────────────────────
// Ubica un archivo de la carpeta por su ID (guardado en caché 6 h). Buscarlo por
// nombre en cada llamada es lento; si el ID en caché ya no sirve, se vuelve a buscar.
function getNamedFile(folder, name) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  var key = 'fid_' + name;
  if (cache) {
    var id = cache.get(key);
    if (id) {
      try {
        var cached = DriveApp.getFileById(id);
        if (!cached.isTrashed()) return cached;
      } catch (e) { /* ID obsoleto: se busca de nuevo */ }
    }
  }
  var it = folder.getFilesByName(name);
  if (!it.hasNext()) return null;
  var file = it.next();
  if (cache) { try { cache.put(key, file.getId(), 21600); } catch (e) {} }
  return file;
}

function readDb(folder) {
  var f = getNamedFile(folder, "emtp_db.json");
  return f ? JSON.parse(f.getBlob().getDataAsString()) : null;
}

function saveDb(folder, dbObj) {
  var str = JSON.stringify(dbObj);
  var f = getNamedFile(folder, "emtp_db.json");
  if (f) f.setContent(str);
  else folder.createFile("emtp_db.json", str, MimeType.PLAIN_TEXT);
  // PARCHE (rendimiento): cada vez que se guarda la base completa, se
  // actualiza también un archivo liviano aparte con solo lo que "heartbeat"
  // necesita (usuarios, para validar la contraseña, y la fecha de último
  // cambio) — así heartbeat nunca tiene que leer ni convertir a JSON todo
  // el archivo completo (que incluye todos los proyectos, el historial y
  // la papelera, cada vez más pesado). Se mantiene sincronizado solo.
  saveMeta(folder, dbObj);
}

function saveMeta(folder, dbObj) {
  var meta = { users: dbObj.users, lastModified: dbObj.lastModified };
  var str = JSON.stringify(meta);
  var f = getNamedFile(folder, "emtp_meta.json");
  if (f) f.setContent(str);
  else folder.createFile("emtp_meta.json", str, MimeType.PLAIN_TEXT);
}

// Lee el archivo liviano; si no existe todavía (primera vez que corre este
// parche), lo genera una vez a partir de la base completa y sigue de ahí.
function loadMeta(folder) {
  var f = getNamedFile(folder, "emtp_meta.json");
  if (f) {
    try {
      return JSON.parse(f.getBlob().getDataAsString());
    } catch (e) { /* archivo corrupto o vacío: se regenera abajo */ }
  }
  var db = readDb(folder);
  if (!db) return null;
  saveMeta(folder, db);
  return { users: db.users || {}, lastModified: db.lastModified || 0 };
}

// Migración de una contraseña antigua en texto plano a hash, bajo el mismo
// bloqueo que las demás escrituras y partiendo de la base más reciente.
function migrateLegacyPassword(folder, user, plain) {
  var lk = LockService.getScriptLock();
  try { lk.waitLock(15000); } catch (e) { return; } // se migrará en el próximo ingreso
  try {
    var db = readDb(folder);
    if (db && db.users && db.users[user] && !isHashed(db.users[user].password)) {
      db.users[user].password = hashPassword(plain);
      saveDb(folder, db);
    }
  } finally {
    try { lk.releaseLock(); } catch (e) {}
  }
}

function response(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── PARCHE (3): CREACIÓN INICIAL DE LA BASE DE DATOS ─────────────────────
// Ejecutar UNA SOLA VEZ, a mano, desde el editor de Apps Script (botón "Ejecutar"
// con esta función seleccionada) para crear el archivo emtp_db.json con un
// administrador cuya contraseña se genera al azar y se imprime en el registro
// de ejecución (Ver → Registros / Ctrl+Enter). Cámbiala apenas inicies sesión.
function initializeDatabase() {
  var folder = DriveApp.getFolderById("1Ja1od5-h-mPmVKmxKIu8ClvLzsTcTCl_"); // TU ID DE CARPETA
  var existing = folder.getFilesByName("emtp_db.json");
  if (existing.hasNext()) {
    Logger.log("emtp_db.json ya existe. No se hizo nada, para no pisar datos existentes.");
    return;
  }
  var tempAdminPass = generateSecureToken(12);
  var db = {
    data: [],
    users: {
      admin: {
        password: hashPassword(tempAdminPass),
        name: 'Administrador',
        role: 'admin',
        status: 'approved',
        email: ''
      }
    },
    teams: {},
    auditLog: [],
    trash: [],
    presupuesto: { years: {}, convenios: [] },
    informes: [],
    lastModified: new Date().getTime()
  };
  saveDb(folder, db);
  Logger.log("Base de datos creada. Usuario: admin — Contraseña temporal: " + tempAdminPass);
  Logger.log("Inicia sesión con esa contraseña y cámbiala de inmediato.");
}

// ── CONTRASEÑAS: hash SHA-256 + salt ──────────────────────────────────
// Formato almacenado: "salt:hashHex" (salt de 16 hex, hash de 64 hex).
// Las contraseñas antiguas en texto plano se siguen aceptando (verifyPassword
// hace fallback) y se migran a hash automáticamente en el próximo login.
function hashPassword(plain, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + plain);
  var hex = raw.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
  return salt + ':' + hex;
}
function isHashed(pw) {
  return typeof pw === 'string' && /^[a-f0-9]{16}:[a-f0-9]{64}$/.test(pw);
}
function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (isHashed(stored)) {
    var salt = stored.split(':')[0];
    return hashPassword(plain, salt) === stored;
  }
  return stored === plain; // compatibilidad con contraseñas antiguas sin hashear
}

// PARCHE (5): generador de tokens aleatorios usando UUID (más robusto que Math.random()).
// Se usa tanto para la contraseña temporal de recuperación como para el admin inicial.
function generateSecureToken(len) {
  len = len || 10;
  var raw = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  return raw.slice(0, len);
}

// ── PARCHE (4): LÍMITE DE INTENTOS DE LOGIN ───────────────────────────────
// Usa PropertiesService (igual que la presencia de usuarios en heartbeat) para
// llevar la cuenta de intentos fallidos por usuario, con bloqueo temporal.
var LOGIN_MAX_ATTEMPTS = 5;
var LOGIN_WINDOW_MS = 15 * 60 * 1000;   // ventana de 15 minutos para contar intentos
var LOGIN_LOCK_MS = 15 * 60 * 1000;     // bloqueo de 15 minutos tras exceder el límite

function checkLoginLock(user) {
  if (!user) return { locked: false };
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('loginfail_' + user);
  if (!raw) return { locked: false };
  var info = JSON.parse(raw);
  var now = new Date().getTime();
  if (info.lockedUntil && now < info.lockedUntil) {
    return { locked: true, minutesLeft: Math.ceil((info.lockedUntil - now) / 60000) };
  }
  return { locked: false };
}

function registerFailedLogin(user) {
  if (!user) return;
  var props = PropertiesService.getScriptProperties();
  var now = new Date().getTime();
  var raw = props.getProperty('loginfail_' + user);
  var info = raw ? JSON.parse(raw) : { count: 0, firstAttempt: now, lockedUntil: 0 };

  // Si la ventana de conteo ya expiró, se reinicia.
  if (now - info.firstAttempt > LOGIN_WINDOW_MS) {
    info = { count: 0, firstAttempt: now, lockedUntil: 0 };
  }

  info.count += 1;
  if (info.count >= LOGIN_MAX_ATTEMPTS) {
    info.lockedUntil = now + LOGIN_LOCK_MS;
  }
  props.setProperty('loginfail_' + user, JSON.stringify(info));
}

function clearLoginLock(user) {
  if (!user) return;
  PropertiesService.getScriptProperties().deleteProperty('loginfail_' + user);
}

// ── PARCHE (1): FILTRADO DE DATOS SEGÚN ROL ───────────────────────────────
// Construye la respuesta que se le entrega al cliente: nunca incluye
// contraseñas, y para quien no es admin solo incluye los proyectos donde
// participa en algún nodo (mismo criterio que "getVisibleData" del frontend,
// aplicado ahora también en el servidor para que un cliente modificado no
// pueda saltárselo).
// ── MÓDULO PRESUPUESTO ──────────────────────────────────────────────────
// Igual que con los proyectos, la SEGURIDAD real está acá, no en el
// navegador: quien no tiene el permiso "Finanzas" jamás recibe la lista de
// convenios (con institución, RUT y códigos SIGFE) — solo recibe totales ya
// agregados por asignación y por proyecto, calculados aquí mismo.
var PRESUPUESTO_CATALOGO = [
  { id: '621', cod: '24.03.621', glosa: 'Glosa 04' },
  { id: '055', cod: '24.03.055', glosa: 'Glosa 03' },
  { id: '105', cod: '33.01.105', glosa: 'Glosa 17' },
  { id: '2407', cod: '24.07.001', glosa: 'Glosa —' },
  { id: '3302', cod: '33.02.001', glosa: 'Glosa 1' }
];
var PRESUPUESTO_TRAMITES = ['En diseño', 'Enviado a Jurídica', 'En ajuste', 'Enviado a contraparte', 'Ingresado para firma', 'Totalmente tramitado'];
var INFORME_ETAPAS = ['Recibido', 'Coordinador', 'Asignado', 'En revisión', 'Aprobado', 'Certificado'];

function computeResumenAgg(presu) {
  var agg = {};
  var years = presu.years || {};
  var convenios = presu.convenios || [];
  for (var y in years) agg[y] = {};
  convenios.forEach(function (c) {
    (c.cuotas || []).forEach(function (cu) {
      var y = String(cu.anio);
      if (!agg[y]) agg[y] = {};
      for (var asigId in (cu.imp || {})) {
        if (!agg[y][asigId]) agg[y][asigId] = { comp: 0, dev: 0, tra: 0, proyectos: {} };
        var slot = agg[y][asigId];
        var m = cu.imp[asigId] || 0;
        slot.comp += m;
        if (cu.estado === 'Devengado' || cu.estado === 'Transferido') slot.dev += m;
        if (cu.estado === 'Transferido') slot.tra += m;
        var pname = c.proyectoNombre || '(sin proyecto)';
        if (!slot.proyectos[pname]) slot.proyectos[pname] = { comp: 0, dev: 0, tra: 0, n: 0 };
        var p = slot.proyectos[pname];
        p.comp += m; p.n += 1;
        if (cu.estado === 'Devengado' || cu.estado === 'Transferido') p.dev += m;
        if (cu.estado === 'Transferido') p.tra += m;
      }
    });
  });
  return agg;
}

function buildPresupuestoPayload(db, isFin) {
  var presu = db.presupuesto || { years: {}, convenios: [] };
  return {
    catalogo: PRESUPUESTO_CATALOGO,
    tramites: PRESUPUESTO_TRAMITES,
    etapasInforme: INFORME_ETAPAS,
    years: presu.years || {},
    resumenAgg: computeResumenAgg(presu),
    // PARCHE (seguridad real): el detalle de convenios (institución, RUT,
    // SIGFE, CDP) solo se envía si el usuario tiene el permiso Finanzas.
    // Quien no lo tiene recibe un arreglo vacío, no una versión "recortada"
    // en el navegador — nunca sale del servidor.
    convenios: isFin ? (presu.convenios || []) : [],
    informes: db.informes || []
  };
}

// PARCHE: fusiona el presupuesto respetando permisos, igual que con los
// proyectos. "years" (presupuesto inicial por asignación) solo lo puede
// tocar un administrador. Los convenios y sus cuotas solo quien tiene
// permiso Finanzas — y si alguien sin ese permiso llega a mandar algo
// (payload manipulado), se ignora en vez de aceptarse.
function mergePresupuesto(db, incoming, isAdmin, isFin) {
  if (!db.presupuesto) db.presupuesto = { years: {}, convenios: [] };
  if (!incoming) return;
  if (isAdmin && incoming.years) {
    db.presupuesto.years = incoming.years;
  }
  if (isFin && incoming.convenios) {
    db.presupuesto.convenios = incoming.convenios;
  }
}

// PARCHE: los informes (bandeja, derivaciones, certificados) los puede
// modificar cualquier editor o administrador — es el mismo grupo que ya
// tiene acceso a Secretaría/Gestión/analistas en el tablero.
function mergeInformes(db, incoming) {
  if (incoming) db.informes = incoming.slice(-500);
}

function buildClientPayload(db, reqUser) {
  var authUser = db.users[reqUser] || {};
  var isAdmin = authUser.role === 'admin';
  var isFin = isAdmin || !!authUser.finanzas;

  // PARCHE (visibilidad): ahora CUALQUIER usuario aprobado puede ver TODOS
  // los proyectos (antes solo veía los propios). El propio cliente decide,
  // con el filtro "Mis proyectos / Todos los proyectos", cuáles mostrar por
  // defecto — esto ya no es una restricción de seguridad, es una preferencia
  // de visualización. Lo que SÍ sigue restringido por rol es la EDICIÓN
  // (ver canModifyNodeServer/mergeDataWithPermissions más abajo).
  return {
    data: db.data,
    users: sanitizeUsersForClient(db.users),
    teams: db.teams,
    auditLog: isAdmin ? db.auditLog : [],
    // PARCHE (papelera): igual que con los proyectos, se envía completa —
    // el cliente ya filtra a "solo lo mío" para quien no es admin.
    trash: db.trash || [],
    presupuesto: buildPresupuestoPayload(db, isFin),
    lastModified: db.lastModified
  };
}

// Elimina el campo password de todos los usuarios. El cliente nunca necesita
// leerlo (solo lo sobrescribe cuando un admin define una contraseña nueva).
function sanitizeUsersForClient(users) {
  var clean = {};
  for (var k in users) {
    var u = users[k];
    clean[k] = {
      name: u.name, role: u.role, status: u.status, email: u.email, team: u.team
    };
  }
  return clean;
}

function nodeParticipates(node, identifiers) {
  var resp = node.responsibles || [];
  var supp = node.support || [];
  for (var i = 0; i < identifiers.length; i++) {
    if (resp.indexOf(identifiers[i]) !== -1 || supp.indexOf(identifiers[i]) !== -1) return true;
  }
  return false;
}
function treeParticipates(node, identifiers) {
  if (nodeParticipates(node, identifiers)) return true;
  var children = node.children || [];
  for (var i = 0; i < children.length; i++) {
    if (treeParticipates(children[i], identifiers)) return true;
  }
  return false;
}

// ── PARCHE (2): GUARDADO CON PERMISOS POR NODO ────────────────────────────
// En vez de aceptar el árbol "data" completo tal cual lo envíe cualquier
// usuario autenticado, se fusiona contra la versión ya guardada, aplicando
// las mismas reglas que el frontend usa para decidir qué se puede editar o
// eliminar (canModifyNode / canDeleteNode), pero exigidas también aquí.
//
// Reglas (igual que el cliente, actualizadas):
//  - admin: puede modificar y eliminar cualquier cosa, incluyendo crear
//    proyectos nuevos y asignar responsables/apoyos.
//  - editor: puede modificar los campos de una actividad, tarea o PROYECTO
//    solo si participa en algún nodo de esa rama (antes cualquier editor
//    podía modificar cualquier proyecto; ya no). No puede eliminar un
//    proyecto completo, no puede crear proyectos nuevos, y no puede cambiar
//    quién está asignado como responsable/apoyo (eso es solo de admin).
//  - Un proyecto fuera del alcance del usuario (no participa en ningún nodo,
//    ni en la versión guardada ni en la enviada) se deja intacto, ignorando
//    lo que haya llegado para él — protección ante un payload manipulado.
//    (Antes esto coincidía con "visibilidad"; ahora todos ven todos los
//    proyectos, pero esta protección de EDICIÓN se mantiene igual.)
function canModifyNodeServer(node, identifiers, isAdmin) {
  if (isAdmin) return true;
  if (!node) return false;
  // PARCHE: un proyecto ya no es editable por cualquier editor — se exige
  // que participe en algún nodo de ese proyecto, igual que actividades/tareas.
  if (node.type === 'proyecto') return treeParticipates(node, identifiers);
  if (node.type === 'tarea' || node.type === 'hito') return nodeParticipates(node, identifiers);
  if (node.type === 'actividad') {
    if (nodeParticipates(node, identifiers)) return true;
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) if (nodeParticipates(children[i], identifiers)) return true;
    return false;
  }
  return false;
}
function canDeleteNodeServer(node, identifiers, isAdmin) {
  if (isAdmin) return true;
  if (!node) return false;
  if (node.type === 'proyecto') return false;
  return canModifyNodeServer(node, identifiers, isAdmin);
}

// PARCHE: solo un administrador puede cambiar quién está asignado como
// responsable o apoyo (y cómo se reparten las horas entre ellos). Se usa
// tanto al fusionar un nodo existente como al aceptar uno nuevo.
var ASSIGNMENT_FIELDS = ['responsibles', 'support', 'hoursPerPerson'];
function stripAssignmentFields(node) {
  var clean = {};
  for (var key in node) {
    if (ASSIGNMENT_FIELDS.indexOf(key) !== -1) continue;
    clean[key] = node[key];
  }
  clean.responsibles = [];
  clean.support = [];
  clean.hoursPerPerson = {};
  return clean;
}

function byId(arr) {
  var map = {};
  (arr || []).forEach(function (n) { map[n.id] = n; });
  return map;
}
function unionIds(arrA, arrB) {
  var ids = [];
  var seen = {};
  (arrA || []).forEach(function (n) { if (!seen[n.id]) { ids.push(n.id); seen[n.id] = true; } });
  (arrB || []).forEach(function (n) { if (!seen[n.id]) { ids.push(n.id); seen[n.id] = true; } });
  return ids;
}

// ── FUSIÓN POR CAMBIOS ("hints") ──────────────────────────────────────────
// El navegador informa, además del árbol, QUÉ cambió desde la última vez que
// se sincronizó con el servidor:
//   changed: { idDelNodo: [campos modificados] }  ('*' = nodo nuevo; '__children'
//            = cambió el orden de sus hijos; '__parent' = cambió de padre)
//   deleted: [ids eliminados]   trashRemoved: [claves retiradas de la papelera]
// El servidor aplica SOLO eso sobre su versión actual. Así, un navegador con
// datos desactualizados ya no puede borrar ni pisar lo que otras personas
// hicieron mientras tanto. Sin "hints" (cliente antiguo) se usa el
// comportamiento anterior.
function arrToSet(arr) {
  var set = {};
  (arr || []).forEach(function (x) { set[x] = true; });
  return set;
}
function normalizeHints(h) {
  if (!h || typeof h !== 'object') return null;
  return {
    changed: (h.changed && typeof h.changed === 'object') ? h.changed : {},
    deleted: arrToSet(h.deleted),
    trashRemoved: arrToSet(h.trashRemoved),
    replaceAll: !!h.replaceAll
  };
}
function fieldChanged(list, key) {
  return !!list && (list.indexOf('*') !== -1 || list.indexOf(key) !== -1);
}
function indexAllNodes(nodes, map) {
  (nodes || []).forEach(function (n) { map[n.id] = n; indexAllNodes(n.children, map); });
  return map;
}
function collectIds(nodes, set) {
  (nodes || []).forEach(function (n) { set[n.id] = true; collectIds(n.children, set); });
  return set;
}
function stripAssignmentsDeep(node) {
  var clean = stripAssignmentFields(node);
  clean.children = (node.children || []).map(stripAssignmentsDeep);
  return clean;
}
function canMoveServer(node, ctx) {
  return ctx.isAdmin || canModifyNodeServer(node, ctx.identifiers, false);
}

// Un nodo que existe en el servidor y ya no aparece bajo este padre en lo enviado.
function resolveMissingNode(existingNode, ctx) {
  if (!ctx.hints) {
    return canDeleteNodeServer(existingNode, ctx.identifiers, ctx.isAdmin) ? null : existingNode;
  }
  if (ctx.inIds[existingNode.id]) {
    // sigue existiendo en otra parte del árbol enviado: se movió de padre
    return canMoveServer(existingNode, ctx) ? null : existingNode;
  }
  if (ctx.hints.deleted[existingNode.id]) {
    return canDeleteNodeServer(existingNode, ctx.identifiers, ctx.isAdmin) ? null : existingNode;
  }
  return existingNode; // el navegador no lo conocía (lo creó otra persona): se conserva
}

// projectParticipant: true si el usuario participa en algún nodo del proyecto que
// contiene este nodo (se calcula una vez por proyecto en mergeDataWithPermissions).
function mergeNodeWithPermissions(existingNode, incomingNode, ctx, projectParticipant) {
  var identifiers = ctx.identifiers, isAdmin = ctx.isAdmin, hints = ctx.hints;
  if (!existingNode && !incomingNode) return null;
  if (existingNode && !incomingNode) return resolveMissingNode(existingNode, ctx);

  if (!existingNode && incomingNode) {
    var elsewhere = ctx.exAll[incomingNode.id];
    if (elsewhere) {
      // El nodo ya existía bajo otro padre: es un movimiento, no una creación.
      if (!canMoveServer(elsewhere, ctx)) return null;
      existingNode = elsewhere;
    } else {
      // Nodo nuevo. Solo un admin crea proyectos; un editor puede crear
      // actividades/tareas/hitos, pero sin asignar personas (lo hace un admin).
      if (incomingNode.type === 'proyecto' && !isAdmin) return null;
      return isAdmin ? incomingNode : stripAssignmentsDeep(incomingNode);
    }
  }

  // Ambos existen: se copian los campos propios solo si el usuario puede
  // modificar el nodo; si no puede, se conserva la versión ya guardada tal
  // cual. Con "hints" solo se copian los campos que el navegador dice haber
  // cambiado.
  var fields = hints ? ((hints.changed || {})[existingNode.id] || []) : null;
  var canModify = canModifyNodeServer(existingNode, identifiers, isAdmin);
  var merged = {};
  for (var key in existingNode) merged[key] = existingNode[key];

  if (canModify) {
    for (var key2 in incomingNode) {
      if (key2 === 'children') continue;
      // aunque pueda modificar el nodo, un no-admin no cambia quién está asignado
      if (!isAdmin && ASSIGNMENT_FIELDS.indexOf(key2) !== -1) continue;
      if (hints && !fieldChanged(fields, key2)) continue;
      merged[key2] = incomingNode[key2];
    }
    if (hints) {
      // campos que el navegador eliminó del nodo
      fields.forEach(function (f) {
        if (f === '*' || f.indexOf('__') === 0 || f === 'children') return;
        if (!isAdmin && ASSIGNMENT_FIELDS.indexOf(f) !== -1) return;
        if (!(f in incomingNode)) delete merged[f];
      });
    }
  } else if (projectParticipant && (existingNode.type === 'tarea' || existingNode.type === 'hito')) {
    // quien participa en el proyecto (pero no en esta tarea/hito) solo cambia el ESTADO
    ['status', 'updatedAt'].forEach(function (k) {
      if (incomingNode[k] !== undefined && (!hints || fieldChanged(fields, k))) merged[k] = incomingNode[k];
    });
  }

  // Los hijos se fusionan recursivamente sin importar si el nodo padre en sí
  // es editable, porque el permiso real de cada nodo se evalúa individualmente.
  var exChildren = existingNode.children || [];
  var inChildren = incomingNode.children || [];
  var exMap = byId(exChildren);
  var inMap = byId(inChildren);
  var ids = unionIds(exChildren, inChildren);

  var mergedChildren = [];
  ids.forEach(function (id) {
    var mc = mergeNodeWithPermissions(exMap[id], inMap[id], ctx, projectParticipant);
    if (mc) mergedChildren.push(mc);
  });

  // El orden de los hijos solo se toma del navegador si él lo cambió.
  var orderChanged = !hints || fieldChanged(fields, '__children');
  if (inChildren.length && orderChanged) {
    var order = inChildren.map(function (c) { return c.id; });
    mergedChildren.sort(function (a, b) {
      var ia = order.indexOf(a.id); if (ia === -1) ia = 9999;
      var ib = order.indexOf(b.id); if (ib === -1) ib = 9999;
      return ia - ib;
    });
  }
  merged.children = mergedChildren;
  return merged;
}

function mergeDataWithPermissions(existingData, incomingData, reqUser, role, displayName, hints) {
  var isAdmin = role === 'admin';
  // Cliente antiguo (sin hints) o restauración de respaldo: el admin reemplaza todo.
  if (isAdmin && (!hints || hints.replaceAll)) return incomingData;

  var identifiers = [reqUser, displayName].filter(function (x) { return !!x; });
  var ctx = {
    identifiers: identifiers, isAdmin: isAdmin, hints: hints,
    exAll: indexAllNodes(existingData, {}), inIds: collectIds(incomingData, {})
  };
  var exMap = byId(existingData);
  var inMap = byId(incomingData);
  var ids = unionIds(existingData, incomingData);

  var result = [];
  ids.forEach(function (id) {
    var exP = exMap[id];
    var inP = inMap[id];

    // Ausente en lo enviado: solo un admin elimina elementos del nivel superior.
    if (exP && !inP) {
      if (isAdmin && hints && !ctx.inIds[id] && hints.deleted[id]) return; // eliminado
      if (isAdmin && hints && ctx.inIds[id]) return;                       // se movió a otro padre
      result.push(exP);
      return;
    }

    // Nuevo en el nivel superior: solo un admin (un editor no crea proyectos).
    if (!exP && inP) {
      if (isAdmin) {
        var created = mergeNodeWithPermissions(null, inP, ctx, true);
        if (created) result.push(created);
      }
      return;
    }

    // Proyecto en ambos lados: si el usuario no participa en él ni en la versión
    // guardada ni en la enviada, se ignora cualquier cambio — protección ante un
    // payload manipulado. (Todos ven todos los proyectos, pero no los editan.)
    if (!isAdmin && !treeParticipates(exP, identifiers) && !treeParticipates(inP, identifiers)) {
      result.push(exP);
      return;
    }
    result.push(mergeNodeWithPermissions(exP, inP, ctx, isAdmin ? true : treeParticipates(exP, identifiers)));
  });

  // Orden de los proyectos: solo si un admin lo cambió.
  if (isAdmin && hints && fieldChanged((hints.changed || {})['__root'], '__children')) {
    var order = incomingData.map(function (n) { return n.id; });
    result.sort(function (a, b) {
      var ia = order.indexOf(a.id); if (ia === -1) ia = 9999;
      var ib = order.indexOf(b.id); if (ib === -1) ib = 9999;
      return ia - ib;
    });
  }
  return result;
}

// Historial: se UNE lo que ya había con lo que envía el navegador (sin duplicar).
function mergeAuditLog(existing, incoming) {
  var seen = {}, out = [];
  (existing || []).concat(incoming || []).forEach(function (e) {
    var k = [e.date, e.user, e.action, e.detail].join('|');
    if (!seen[k]) { seen[k] = true; out.push(e); }
  });
  out.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); });
  return out.slice(-300);
}

// Papelera: se une lo existente con lo enviado, menos lo que el navegador retiró
// (restaurado o purgado). Clave de cada entrada: id del nodo + fecha de eliminación.
function trashKey(t) { return ((t && t.node && t.node.id) || '') + '|' + ((t && t.deletedAt) || ''); }
function mergeTrash(existing, incoming, removedSet) {
  var seen = {}, out = [];
  (existing || []).concat(incoming || []).forEach(function (t) {
    var k = trashKey(t);
    if (seen[k] || (removedSet && removedSet[k])) return;
    seen[k] = true; out.push(t);
  });
  return out.slice(-200);
}

// ── PRESENCIA (usuarios en línea) ─────────────────────────────────────────
function handleHeartbeatResult(user) {
  var props = PropertiesService.getScriptProperties();
  var now = new Date().getTime();

  props.setProperty('presence_' + user, now.toString());

  var allProps = props.getProperties();
  var online = [];
  var cutoff = now - 60000; // 60 segundos
  for (var key in allProps) {
    if (key.indexOf('presence_') === 0) {
      var lastSeen = parseInt(allProps[key]);
      if (lastSeen >= cutoff) {
        online.push(key.replace('presence_', ''));
      }
    }
  }

  return { status: 'success', online: online };
}
