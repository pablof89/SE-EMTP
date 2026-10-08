# Pruebas

Sin dependencias del proyecto: simulan Google Apps Script (Drive, bloqueo, caché) en memoria.

- `node tests/merge-test.js` — fusión de guardados de `Code.gs` (17 escenarios: cambios simultáneos, eliminaciones, movimientos, permisos, bloqueo).
- `node tests/e2e.js` — abre `index.html` en Chromium contra `Code.gs` simulado (requiere Playwright; `PLAYWRIGHT_PATH` y `CHROME_PATH` opcionales).
