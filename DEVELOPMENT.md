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

Ejecuta, según lo que vayas a revisar:

```sh
npm run lint
npm test
npm run test:ui
npm run build
```

La prueba de interfaz descarga Chromium mediante Playwright cuando sigues el mismo flujo que la integración continua: `npx playwright install --with-deps chromium`.

`npm test` descubre automáticamente todos los archivos `test/*.test.mjs`, incluidos `test/visit-time.test.mjs`, `test/visits.test.mjs` y `test/visit-calendar.test.mjs`. El build copia una lista explícita de módulos de ejecución a `dist/`; tras modificar esa lista, comprueba el manifiesto con `node -e "const m=require('./dist/build-manifest.json'); console.log('app/public/visit-time.mjs' in m, 'app/visits.mjs' in m, 'app/visit-calendar.mjs' in m)"`.
