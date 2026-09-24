import { execFileSync } from 'node:child_process';

function jxa(source) {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', source], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 20000,
  }).trim();
}

export function connect() {
  const target = JSON.parse(jxa(`
    ObjC.import('AppKit');
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.google.Chrome');
    let result = null;
    for (let i = 0; i < apps.count && !result; i++) {
      const pid = apps.objectAtIndex(i).processIdentifier;
      for (const w of Application(pid).windows()) {
        const tabs = w.tabs();
        for (let tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
          const t = tabs[tabIndex];
          if (/^https:\\/\\/www\\.idealista\\.com\\/conversations(?:[/?#]|$)/.test(t.url())) {
            result = { pid, window: Number(w.id()), tab: Number(t.id()), tabIndex: tabIndex + 1 }; break;
          }
        }
        if (result) break;
      }
    }
    JSON.stringify(result);
  `));
  if (!target) throw new Error('No hay una pestaña de conversaciones de Idealista abierta en Chrome.');
  function evaluate(expression) {
    const source = `JSON.stringify((() => {
      if (location.origin !== 'https://www.idealista.com' || !location.pathname.startsWith('/conversations')) throw new Error('La pestaña ha cambiado');
      if (/Se ha detectado un uso indebido|El acceso se ha bloqueado|demasiadas peticiones/i.test(document.body.innerText)) throw new Error('Idealista ha bloqueado el acceso');
      return (${expression});
    })())`;
    return JSON.parse(jxa(`Application(${target.pid}).windows.byId(${target.window}).tabs.byId(${target.tab}).execute({javascript:${JSON.stringify(source)}});`));
  }
  evaluate.activate = () => {
    jxa(`const chrome=Application(${target.pid});const w=chrome.windows.byId(${target.window});w.activeTabIndex=${target.tabIndex};w.index=1;chrome.activate();JSON.stringify(true);`);
  };
  return evaluate;
}

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
