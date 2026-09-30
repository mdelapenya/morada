# Desarrollo

## Requisitos

- Node.js 22, con SQLite experimental habilitado por el propio comando de inicio.
- macOS y Google Chrome solo para leer conversaciones reales de Idealista. Las pruebas usan datos sintéticos y se ejecutan también en Linux.

## Preparación y ejecución

Instala las dependencias con `npm ci`.

Inicia la aplicación en el puerto elegido, por ejemplo `PORT=8766 npm start`, y abre la dirección que muestra el terminal. Para dejarla iniciada en segundo plano, usa `PORT=8766 npm run start:background`.

Una instalación nueva empieza sin viviendas. Las instalaciones antiguas pueden cargar una configuración local opcional de una vivienda; no hace falta crearla para empezar de cero.

## Calendario de visitas

Las visitas son datos locales vinculados a una vivienda, una búsqueda y un interesado. `app/public/visit-time.mjs` reúne funciones puras para zonas IANA, horas repetidas o inexistentes y límites de días civiles; lo usan `app/visits.mjs` para validar y `app/public/app.js` para la interfaz. `app/visit-calendar.mjs` genera las descargas iCalendar con instantes UTC. La interfaz propone la zona del navegador, conserva la zona de cada visita y muestra el mismo instante en la zona elegida.

Las exportaciones `.ics` se tratan como datos privados mínimos: no contienen nombre o contacto del interesado, conversaciones ni dirección. La migración de la tabla de visitas anterior, limitada a Madrid, se ejecuta de forma transaccional y conserva las referencias. Las pruebas `test/visit-time.test.mjs` y `test/visits.test.mjs` cubren zonas, transiciones DST y esa compatibilidad con datos sintéticos; no uses la base de datos local ni una sincronización real para comprobar esta funcionalidad.

## Comprobaciones

### Demostración y capturas

Para explorar la aplicación con datos ficticios, ejecuta `npm run demo`. Se crea una base SQLite nueva en un subdirectorio exclusivo de `.demo/`, y el servidor muestra su propia URL local con un puerto libre. Cierra la demo con Ctrl+C. Cada ejecución crea otra base; no reutiliza ni sobrescribe bases existentes.

El generador ignora `IDEALISTA_DB`, `IDEALISTA_RUNTIME_DIR` y `PORT`, y sustituye `IDEALISTA_LEGACY_PROPERTY_FILE` por una configuración vacía creada dentro de esa demo antes de cargar la aplicación. No lee `.local/`, no copia exportaciones, no conecta con Chrome y no reinicia el servidor habitual. La sincronización real está desactivada en el servidor de demostración.

La muestra contiene cinco viviendas, once interesados, búsquedas abiertas y cerradas, una vivienda eliminada, conversaciones, favoritos, descartes, notas y seis visitas con diferentes estados. Los nombres y direcciones son inventados y los correos usan `example.test`. La fecha de referencia de las capturas es el 15 de octubre de 2026; al explorar manualmente el calendario, navega a ese mes.

Para regenerar la [galería](docs/GALERIA.md) y las imágenes del README:

```sh
npm ci
npx playwright install --with-deps chromium
npm run docs:screenshots
```

El comando crea otra base aislada, arranca un servidor temporal y toma las capturas con Chromium de Playwright, en escritorio y móvil. Solo permite solicitudes al servidor de esa demo. Los estados de éxito con avisos y error de sincronización se simulan explícitamente; el resto de las vistas y formularios usa la API y la base sintética. Al terminar se cierran el navegador y el servidor; la base y su manifiesto quedan en `.demo/` para inspección local, excluidos de Git y del build.

`tools/demo-data.mjs` define los datos y las barreras de aislamiento. `tools/capture-docs.mjs` recorre la interfaz y genera `docs/GALERIA.md`. `tools/documentation-scenes.mjs` enumera todas las capturas; el build usa esa lista explícita para incluir únicamente la galería y sus imágenes públicas. No copies capturas de tu sesión personal a `docs/screenshots/`.

`test/demo.test.mjs` comprueba el aislamiento en un proceso separado, con rutas de entorno señuelo: verifica que no se lea `.local/`, que dos demos no compartan datos y que no se ejecute ningún proceso para acceder a Chrome.

### Pruebas y build

Ejecuta, según lo que vayas a revisar:

```sh
npm run lint
npm test
npm run test:ui
npm run build
```

La prueba de interfaz descarga Chromium mediante Playwright cuando sigues el mismo flujo que la integración continua: `npx playwright install --with-deps chromium`.

`npm test` descubre automáticamente todos los archivos `test/*.test.mjs`, incluidos `test/visit-time.test.mjs`, `test/visits.test.mjs` y `test/visit-calendar.test.mjs`. El build copia una lista explícita de módulos de ejecución a `dist/`; tras modificar esa lista, comprueba el manifiesto con `node -e "const m=require('./dist/build-manifest.json'); console.log('app/public/visit-time.mjs' in m, 'app/visits.mjs' in m, 'app/visit-calendar.mjs' in m)"`.
