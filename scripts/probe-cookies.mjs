import { chromium } from 'playwright';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.local', 'cookie-probe');
const interactive = process.argv.includes('--interactive');
const target = new URL(process.argv.slice(2).find(arg => arg !== '--interactive') ?? 'https://www.idealista.com/');
if (target.protocol !== 'https:' || target.hostname !== 'www.idealista.com') {
  throw new Error('La URL debe pertenecer a https://www.idealista.com.');
}

async function main() {
  const cookies = [];
  for (const name of ['cc', 'didomi_token']) {
    const file = path.join(root, `.${name}`);
    await chmod(file, 0o600);
    const value = (await readFile(file, 'utf8')).trim();
    if (!value || /[\s;]/.test(value)) {
      throw new Error(`Formato no válido en .${name}; se espera solamente el valor de la cookie.`);
    }
    cookies.push({ name, value, domain: '.idealista.com', path: '/', secure: true });
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 1000 } });
    await context.addCookies(cookies);
    const page = await context.newPage();
    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    const text = await page.locator('body').innerText();
    const blocked = response?.status() === 403 || response?.status() === 429 || /uso indebido|acceso se ha bloqueado|access denied|access.*blocked/i.test(text);
    const snapshot = {
      capturedAt: new Date().toISOString(),
      url: page.url(),
      status: response?.status(),
      blocked,
      title: await page.title(),
      text,
      links: await page.locator('a[href]').evaluateAll(elements => elements.map(a => ({ text: a.innerText, url: a.href }))),
    };
    await writeFile(path.join(output, 'page.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await page.screenshot({ path: path.join(output, 'page.png'), fullPage: true });
    console.log(JSON.stringify({ status: snapshot.status, blocked, capture: '.local/cookie-probe/page.json' }));
    if (interactive) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await terminal.question('Completa la verificación manualmente y abre los chats. Pulsa Intro aquí cuando termines para guardar la sesión. ');
      } finally {
        terminal.close();
      }
      await writeFile(path.join(output, 'after-manual.json'), JSON.stringify({ url: page.url(), text: await page.locator('body').innerText() }, null, 2), { mode: 0o600 });
      await page.screenshot({ path: path.join(output, 'after-manual.png'), fullPage: true });
    }
    await context.storageState({ path: path.join(output, 'storage.json') });
  } finally {
    await browser.close();
  }
}

main().catch(() => {
  console.error('No se pudo completar la prueba de cookies. Comprueba los archivos locales y la disponibilidad del navegador. No se muestran detalles que puedan contener tokens.');
  process.exitCode = 1;
});
