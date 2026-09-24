# Guía para agentes

## Propósito y documentación

Morada es una aplicación local para organizar interesados de anuncios de
Idealista. La interfaz y el README están en español; mantén ese idioma en texto
visible al usuario.

- [README.md](README.md) describe el producto y sus límites para usuarios.
- [DEVELOPMENT.md](DEVELOPMENT.md) contiene la instalación y la operación de
  desarrollo.
- No conviertas esta guía en una especificación del producto: conserva las
  decisiones funcionales en código, pruebas y la documentación correspondiente.

## Entorno y comandos

- Se requiere Node.js 22. SQLite se activa con `--experimental-sqlite` en los
  comandos que abren la base de datos.
- Instala dependencias reproducibles con `npm ci`.
- Ejecuta `npm run lint`, `npm test`, `npm run test:ui` y `npm run build` según
  el área modificada. `npm test` ejecuta las pruebas de servidor y unidad con el
  fixture sintético `test/legacy-property.json`; la suite actual tiene 90 pruebas.
- Para una prueba de interfaz aislada instala Chromium con
  `npx playwright install --with-deps chromium` y después ejecuta `npm run test:ui`.
- `npm start` ejecuta el servidor; `npm run start:background` usa el iniciador
  desacoplado. `npm run db:build` importa exportaciones locales y
  `npm run export:today` es una utilidad operativa, no una prueba.
- Las variables admitidas son `PORT`, `IDEALISTA_DB`,
  `IDEALISTA_RUNTIME_DIR` e `IDEALISTA_LEGACY_PROPERTY_FILE`. No inventes otras
  ni cambies sus valores por defecto sin actualizar código y documentación.

CI usa Node 22 y ejecuta, en este orden: `npm ci`, lint, pruebas de unidad y
servidor, instalación de Chromium, UI y build. Reproduce ese orden completo
antes de cerrar un cambio amplio. Una comprobación local no afirma que se haya
ejecutado la integración alojada.

## Mapa del código

- `app/database.mjs` abre SQLite, aplica migraciones y contiene las operaciones
  de propiedades, periodos, interesados, importaciones y atención de sync.
- `app/server.mjs` sirve la API local y `app/public/`; conserva validación de
  cuerpos, límites, host/origen local y cabeceras de seguridad.
- `app/sync.mjs` coordina el worker y la importación; `app/sync-attention.mjs`,
  `app/arrival.mjs` y `app/reply.mjs` calculan estados derivados.
- `app/import.mjs` importa exportaciones; `app/legacy-property.mjs` ofrece solo
  compatibilidad opcional; `app/start-background.mjs` gestiona el arranque en
  segundo plano.
- `scripts/exporter.mjs` lee y valida conversaciones; `scripts/sync-worker.mjs`
  es su protocolo de proceso hijo; `scripts/current-chrome.mjs` localiza la
  pestaña ya abierta. `scripts/message-history.mjs` calcula líneas base.
- `scripts/browser.mjs`, `scripts/probe-cookies.mjs` y
  `scripts/export-today.mjs` son utilidades operativas. `test/` usa fixtures e
  inyección de dependencias; `tools/build.mjs` crea el artefacto.
- La interfaz está en `app/public/index.html`, `app/public/app.js` y
  `app/public/style.css`. Al modificarla, conserva escape seguro de contenido,
  el aislamiento de las fixtures y los controles de API local.

## Datos privados y ejecución local

- `.local/` contiene la base SQLite real, exportaciones, copias, sesiones y
  registros privados. Nunca lo incluyas en commits, salidas, fixtures ni build.
- `IDEALISTA_LEGACY_PROPERTY_FILE` solo puede apuntar a configuración local de
  compatibilidad; una instalación nueva debe funcionar vacía. Las pruebas usan
  exclusivamente el fixture sintético del repositorio.
- No añadas listados reales, nombres, ingresos, mensajes, PII, secretos,
  cookies, identificadores de procesos ni rutas privadas a documentación o
  resultados. No guardes valores sensibles por defecto.
- Nunca uses la base de un usuario para pruebas. Para cambios de esquema o
  importación trabaja sobre una copia desechable, conserva una copia de
  seguridad cuando proceda y verifica esquema, datos e integridad antes de dar
  el resultado por bueno.
- No mates procesos ajenos ni sustituyas una base existente. Si una tarea exige
  reiniciar el runtime, usa el iniciador desacoplado, inspecciona puerto,
  directorio de trabajo y trabajos activos, respalda lo necesario y comprueba
  inmediatamente la salud del servicio.

## Sincronización con Idealista

- La sincronización real requiere macOS, Google Chrome y la pestaña autenticada
  de conversaciones ya abierta, con permiso para JavaScript desde Apple Events.
  Lee el DOM de esa pestaña; no envía respuestas ni contactos externos.
- No copies perfiles o cookies, no intentes sortear permisos, autenticación o
  bloqueos, y no ejecutes una sincronización real durante validación o pruebas.
- La identidad de una conversación es fuente del anuncio + periodo + chat
  externo. No deduzcas identidad ni agrupes conversaciones por nombre.
- Las propiedades pueden tener varios periodos y fuentes de anuncio. Un periodo
  cerrado es histórico e inmutable; una eliminación normal es recuperable. El
  borrado permanente conserva tombstones para impedir reimportaciones ambiguas.
- Las importaciones deben validar primero y ser atómicas: ante fallo se conserva
  lo previo, incluido un historial no visitado o más completo.
- La primera sincronización de una combinación periodo/fuente/configuración
  hace una línea base completa. La sincronización normal ordenada por actividad
  reciente recoge las actualizaciones y puede parar tras cinco chats conocidos
  consecutivos sin cambios, incluidos mensajes enviados y recibidos.
- La sincronización completa manual es diagnóstica. No marques `fullCoverage`
  si se aplicó la parada temprana o no se verificó el recorrido completo.
- La atención es durable: su revisión cambia con datos entrantes, el ACK debe
  corresponder a esa revisión y es distinto de `pending`/último remitente.

## Cambios y verificación

- Mantén los límites de propiedad, periodo, fuente y estado en cada consulta y
  operación de escritura. Rechaza cambios sobre periodos cerrados.
- Amplía pruebas de unidad/servidor para lógica de base, importación y sync;
  amplía `test/ui.mjs` para flujos de interfaz. Usa datos sintéticos y pruebas
  aisladas, nunca Chrome ni datos reales.
- Ejecuta la comprobación proporcional al cambio; para funcionalidades amplias
  ejecuta la canalización local completa. No añadas pruebas redundantes que solo
  repliquen la implementación.
- El build usa una lista explícita en `tools/build.mjs`. Si un archivo necesario
  en runtime cambia o se añade, actualiza esa lista junto con documentación y
  `package.json`/lockfile cuando corresponda.
- Antes de terminar, revisa que enlaces, rutas documentadas, scripts y nombres
  de entorno existan. No presentes cambios de comportamiento sin evidencia de
  las comprobaciones ejecutadas.
