import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.umask(0o077);
const root = fileURLToPath(new URL('../.local/', import.meta.url));
const sessionFile = path.join(root, 'session.json');
const command = process.argv[2];

function idealistaURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.idealista.com') {
    throw new Error('La página debe pertenecer a https://www.idealista.com.');
  }
  return url.href;
}

async function main() {
  if (!['login', 'inspect'].includes(command)) {
    throw new Error('Uso: npm run login | npm run inspect');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  let target = 'https://www.idealista.com/';
  if (command === 'inspect') {
    try {
      target = idealistaURL(JSON.parse(await readFile(sessionFile, 'utf8')).url);
    } catch {
      throw new Error('Primero ejecuta npm run login y abre la pantalla de chats.');
    }
  }
  const context = await chromium.launchPersistentContext(path.join(root, 'chrome-profile'), {
    channel: 'chrome',
    headless: command === 'inspect',
    viewport: { width: 1440, height: 1000 },
    locale: 'es-ES',
  });
  const page = context.pages()[0] ?? await context.newPage();
  if (command === 'login') {
    let lastURL = target;
    function track(tab) {
      tab.on('framenavigated', frame => {
        if (frame !== tab.mainFrame()) return;
        try { lastURL = idealistaURL(frame.url()); } catch { /* Login externo o página temporal. */ }
      });
    }
    for (const tab of context.pages()) track(tab);
    context.on('page', track);
    const closed = new Promise(resolve => context.once('close', resolve));
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      console.log('Inicia sesión, abre la lista de chats y cierra esta ventana del navegador para guardar la sesión.');
      await closed;
      await writeFile(sessionFile, JSON.stringify({ url: lastURL }, null, 2), { mode: 0o600 });
      console.log('Sesión local guardada. Ya puedes ejecutar npm run inspect.');
    } finally {
      await context.close();
    }
    return;
  }
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.locator('body').waitFor();
    // Da tiempo al chat, que puede cargar después del documento inicial.
    await page.waitForTimeout(3000);
    const capture = {
      capturedAt: new Date().toISOString(),
      url: page.url(),
      title: await page.title(),
      text: await page.locator('body').innerText(),
      links: await page.locator('a[href]').evaluateAll(elements => elements.map(a => ({
        text: a.innerText, url: a.href,
      }))),
    };
    const output = path.join(root, 'inspection');
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(path.join(output, 'page.json'), JSON.stringify(capture, null, 2), { mode: 0o600 });
    await page.screenshot({ path: path.join(output, 'page.png'), fullPage: true });
    console.log('Captura guardada en .local/inspection/. Hay que comprobar si muestra chats, login o un bloqueo; todavía no es una extracción de conversaciones.');
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
