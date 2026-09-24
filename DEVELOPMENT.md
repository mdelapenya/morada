# Desarrollo

## Requisitos

- Node.js 22, con SQLite experimental habilitado por el propio comando de inicio.
- macOS y Google Chrome solo para leer conversaciones reales de Idealista. Las pruebas usan datos sintéticos y se ejecutan también en Linux.

## Preparación y ejecución

Instala las dependencias con `npm ci`.

Inicia la aplicación en el puerto elegido, por ejemplo `PORT=8766 npm start`, y abre la dirección que muestra el terminal. Para dejarla iniciada en segundo plano, usa `PORT=8766 npm run start:background`.

Una instalación nueva empieza sin viviendas. Las instalaciones antiguas pueden cargar una configuración local opcional de una vivienda; no hace falta crearla para empezar de cero.

## Comprobaciones

Ejecuta, según lo que vayas a revisar:

```sh
npm run lint
npm test
npm run test:ui
npm run build
```

La prueba de interfaz descarga Chromium mediante Playwright cuando sigues el mismo flujo que la integración continua: `npx playwright install --with-deps chromium`.
