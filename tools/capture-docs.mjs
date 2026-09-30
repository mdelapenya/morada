import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createDemo, demoNow } from './demo-data.mjs';
import { documentationScenes } from './documentation-scenes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/screenshots');
await mkdir(output, { recursive: true });
const demo = await createDemo();
let browser;
const captured = new Set();
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1, locale: 'es-ES', timezoneId: 'Europe/Madrid', reducedMotion: 'reduce' });
  // No external navigation or requests, even if a screenshot flow is changed accidentally.
  await context.route('**/*', route => new URL(route.request().url()).origin === demo.url
    ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date(demoNow));
  const workspace = (home = demo.homes.garden, extra = {}) => '/?' + new URLSearchParams({ propertyId: home.id, ...extra });
  async function go(url = '/') {
    await page.goto(demo.url + url, { waitUntil: 'networkidle' });
    await page.locator('main:visible').waitFor();
  }
  async function shoot(name) {
    assert.ok(documentationScenes.some(([key]) => key === name), `Unknown scene: ${name}`);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    const modalOpen = await page.locator('dialog[open]').count() > 0;
    await page.screenshot({ path: path.join(output, name + '.png'), fullPage: !modalOpen, animations: 'disabled' });
    captured.add(name);
    console.log(`Captura sintética: ${name}`);
  }
  const close = id => page.locator(`#${id} [data-close]`).first().click();
  async function manage(button) {
    if (await page.locator('#manageDisclosure').getAttribute('open') === null) await page.locator('#manageSummary').click();
    await page.locator('#' + button).click();
  }
  async function ana() {
    await go(workspace());
    await page.getByRole('button', { name: /^Ver ficha de Ana Ejemplo/ }).click();
    await page.locator('#detailBody').getByText('Confirmada', { exact: true }).waitFor();
  }
  await go(); await shoot('viviendas');
  await page.locator('#homeList').click(); await shoot('viviendas-lista');
  await page.locator('#homeAddProperty').click();
  await page.locator('#newPropertyForm [name=title]').fill('Casa del Bosque');
  await page.locator('#newPropertyForm [name=address]').fill('Camino Inventado, 5 · Ciudad Demo');
  await page.locator('#newPropertyForm [name=monthlyRent]').fill('1050');
  await shoot('vivienda-nueva'); await close('propertyDialog');
  await page.locator('#homeDeleted').click();
  await page.locator('.home-restore').waitFor(); await shoot('viviendas-eliminadas');
  await page.locator('.home-purge').click(); await shoot('vivienda-borrar'); await close('purgePropertyDialog');
  await go(workspace()); await shoot('interesados');
  await page.locator('[data-status=favorites]').click();
  await page.locator('#count').getByText(/2 interesados/).waitFor(); await shoot('favoritos');
  await page.locator('[data-status=discarded]').click();
  await page.getByRole('button', { name: 'Ver ficha de Darío Modelo' }).waitFor(); await shoot('descartados');
  await go(workspace(demo.homes.garden, { name: 'Nadie coincide' }));
  // Use the actual search control rather than relying on a URL parameter name.
  await page.locator('#name').fill('Nadie coincide');
  await page.locator('#empty').waitFor(); await shoot('sin-resultados');
  await go(workspace());
  await manage('editProperty'); await shoot('vivienda-editar');
  await page.locator('#deleteProperty').click(); await shoot('vivienda-eliminar');
  await close('deletePropertyDialog');
  await go(workspace()); await manage('editPeriod'); await shoot('busqueda-editar');
  await close('periodDialog');
  await page.locator('#addApplicant').click();
  const form = page.locator('#newApplicantForm');
  await form.locator('[name=name]').fill('Nora Ejemplo');
  await form.locator('[name=email]').fill('nora@example.test');
  await form.locator('[name=peopleCount]').fill('2');
  await form.locator('[name=monthlyIncome]').fill('3400');
  await form.locator('[name=incomeScope]').selectOption('grupo');
  await form.locator('[name=notes]').fill('Contacto ficticio recibido durante una visita.');
  await shoot('interesado-nuevo'); await close('applicantDialog');
  await ana(); await shoot('ficha');
  await page.locator('#detail').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await shoot('conversacion');
  await page.locator('#detail').evaluate(element => { element.scrollTop = 0; });
  await page.getByRole('button', { name: 'Elegir a Ana Ejemplo y cerrar búsqueda' }).click();
  await shoot('busqueda-cerrar'); await close('closePeriodDialog');
  await go(workspace(demo.homes.rented)); await shoot('busqueda-cerrada');
  await manage('reopenPeriod'); await shoot('busqueda-reabrir'); await close('reopenPeriodDialog');
  await manage('newPeriod'); await shoot('busqueda-nueva'); await close('periodDialog');
  await go(workspace(demo.homes.empty)); await shoot('busqueda-vacia');
  await go('/?view=calendar');
  await page.locator('#agendaItems').getByText('Ana Ejemplo').waitFor(); await shoot('calendario');
  await page.locator('#calendarStatus').selectOption('cancelled');
  await page.locator('#agendaItems').getByText('Gloria Demostración').waitFor(); await shoot('calendario-canceladas');
  await ana(); await page.getByRole('button', { name: 'Programar visita', exact: true }).click();
  await page.locator('#visitForm [name=startLocal]').fill('2026-10-15T18:45');
  await page.locator('#visitAgendaPreview').getByText('Ático de la Terraza').waitFor();
  await shoot('visita-nueva'); await close('visitDialog');
  await page.getByRole('button', { name: /Editar visita del/ }).click();
  await page.locator('#visitAgendaState').getByText(/citas en este día/).waitFor();
  await shoot('visita-editar');
  await page.locator('#visitForm [name=startLocal]').fill('2026-10-15T18:00');
  await page.getByRole('button', { name: 'Guardar visita', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar de todos modos' }).waitFor(); await shoot('visita-conflicto');
  await go(workspace()); await page.locator('#syncOptionsSummary').click(); await shoot('sincronizacion-opciones');
  let simulatedJob = { id: 'synthetic-sync', state: 'succeeded', phase: null,
    propertyId: demo.homes.garden.id, periodId: demo.homes.garden.activePeriodId,
    sinceDate: '2026-10-01', requestedMode: 'incremental', effectiveMode: 'full', examined: 8, candidates: 8,
    imported: 1, updated: 5, newIncomingApplicants: 1, newIncomingMessages: 1,
    fullCoverage: false, skippedUnverified: 1, earlyStopped: false };
  const syncRoute = url => /\/sync$/.test(new URL(url).pathname);
  await page.route(syncRoute, route => route.fulfill({ json: { job: simulatedJob, supportsSyncModes: true } }));
  await go(workspace()); await page.locator('#syncDetailsSummary').click(); await shoot('sincronizacion-avisos');
  simulatedJob = { ...simulatedJob, state: 'failed', error: 'Chrome no respondió a tiempo durante la lectura. Comprueba que la pestaña esté abierta y visible y vuelve a sincronizar.' };
  await go(workspace()); await shoot('sincronizacion-error'); await page.unroute(syncRoute);
  await page.setViewportSize({ width: 390, height: 844 });
  await go(); await page.locator('#homeGrid').click(); await shoot('movil-viviendas');
  await go(workspace()); await shoot('movil-interesados');
  await go('/?view=calendar'); await shoot('movil-calendario');
  assert.deepEqual(errors, []);
  assert.equal(captured.size, documentationScenes.length);
  const groups = [...new Set(documentationScenes.map(([, group]) => group))];
  const gallery = ['# Galería de Morada', '',
    'Todas las imágenes se han generado con datos ficticios en una base independiente. Los nombres, direcciones, ingresos, mensajes y anuncios son inventados; los correos usan el dominio reservado `example.test`.', '',
    'Las capturas usan el 15 de octubre de 2026 como fecha de referencia. Los dos resultados de sincronización están simulados: no se ha abierto Chrome ni accedido a Idealista.', '',
    '[Volver a la guía de uso](../README.md) · [Regenerar las capturas](../DEVELOPMENT.md#demostración-y-capturas)', '',
    ...groups.flatMap(group => [`## ${group}`, '', ...documentationScenes.filter(([, value]) => value === group).flatMap(([name, , title]) => [
      '<details>', `<summary>${title}</summary>`, '', `![${title}](screenshots/${name}.png)`, '', '</details>', '',
    ])])].join('\n');
  await writeFile(path.join(root, 'docs/GALERIA.md'), gallery);
  console.log(`${captured.size} capturas publicadas en docs/screenshots. Base sintética conservada en .demo/.`);
} finally {
  await browser?.close();
  await demo.close();
}
