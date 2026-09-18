# Estado del proyecto SE-EMTP — punto de retoma

## Repo
- GitHub: `pablof89/SE-EMTP`, rama `main`, publicado en GitHub Pages: https://pablof89.github.io/SE-EMTP/
- Backend: Google Apps Script (Code.gs) + Google Drive como base de datos (`emtp_db.json`)
- Todo el frontend vive en un solo archivo: `index.html`

## Últimos cambios confirmados en git (más reciente primero)
- **Login con usuario O correo electrónico** — frontend ya está commiteado (`a2cf569`).
  ⚠️ **PENDIENTE: falta actualizar `Código.gs` en Apps Script** con la función
  `resolveUserKey()` y los cambios en las acciones `login` y en la "barrera de
  seguridad". El código completo de referencia queda más abajo en este archivo.
- Fix: nombres largos ya no se comprimen letra por letra en Tabla (bug de CSS).
- Búsqueda global (Ctrl/Cmd+K y Ctrl/Cmd+/), acciones en bloque en Tabla,
  duplicar proyecto como plantilla.
- Permisos granulares por nodo, modo oscuro, notificaciones del navegador,
  vista "Mis Tareas", historial de cambios (solo admin), respaldo manual
  (exportar/importar JSON), sincronización en tiempo real entre usuarios,
  contraseñas hasheadas en el backend.

## Pendiente inmediato
1. **Actualizar `Código.gs`** en Apps Script con el login por correo/usuario
   (ver bloque de código abajo) y volver a Implementar → Nueva versión.
2. **Manual de usuario en PDF** — se estaba generando con capturas de pantalla
   reales de la app (perfil editor). Quedó un archivo parcial en
   `Manual_Usuario_Tablero_EMTP.pdf` (sin confirmar si quedó completo o a medias).
   Si sigues en otro equipo, probablemente haya que regenerarlo desde cero.

## Notas de contexto importantes
- El despliegue de GitHub Pages a veces se queda "atascado" (candado de
  deployment trabado). El truco que funcionó dos veces: Settings → Pages →
  cambiar "Source" a "None" → guardar → esperar 30s → volver a configurar
  la rama `main` → guardar. Eso fuerza un despliegue limpio.
- Las contraseñas en el backend están hasheadas (SHA-256+salt) con
  migración automática y transparente de cuentas antiguas en texto plano.
- El usuario (Pablo) sube manualmente el `Código.gs` copiando y pegando en
  el editor de Apps Script — no hay despliegue automático de esa parte.

---

## Código.gs — bloque pendiente de aplicar (login por usuario o correo)

Agregar esta función en cualquier parte del archivo:

```javascript
// Permite iniciar sesión indistintamente con el nombre de usuario o el
// correo electrónico: busca primero coincidencia exacta de la clave
// (username), y si no existe, busca por email (sin distinguir mayúsculas).
function resolveUserKey(db, identifier) {
  if (!identifier) return identifier;
  if (db.users[identifier]) return identifier;
  var idf = identifier.toString().trim().toLowerCase();
  for (var k in db.users) {
    if ((db.users[k].email || '').toLowerCase() === idf) return k;
  }
  return identifier;
}
```

Cambiar la línea donde se lee `reqUser` (cerca del inicio de `doPost`):

```javascript
// ANTES:
var reqUser = json.user;
// DESPUÉS:
var reqUser = resolveUserKey(db, json.user);
```

En el bloque `if (json.action === "login")`, la respuesta exitosa debe incluir
`resolvedUser`:

```javascript
return response({ status: "success", payload: db, resolvedUser: reqUser });
```
