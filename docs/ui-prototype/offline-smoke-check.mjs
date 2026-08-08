import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./webhtv-dual-ui-prototype.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('inline prototype script is missing');

const app = { dataset: {}, innerHTML: '' };
const label = { textContent: '' };
const document = {
  getElementById: (id) => (id === 'app' ? app : label),
  querySelector: (selector) => {
    if (selector.includes('data-wallpaper')) return app.dataset.wallpaper === selector.match(/data-wallpaper="([^"]+)/)?.[1] ? app : null;
    if (selector.includes('data-device')) return html.includes(selector.match(/data-device="([^"]+)/)?.[1]) ? {} : null;
    if (selector.includes('.player-setting-panel[hidden]')) return app.innerHTML.includes('player-setting-panel" hidden') ? {} : null;
    const value = selector.match(/data-(?:page-view|player-kind|dialog-template)="([^"]+)/)?.[1];
    return value && app.innerHTML.includes(value) ? {} : null;
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: { get textContent() { return app.innerHTML; } },
};
const context = { document, console: { assert: (ok, message) => { if (!ok) throw new Error(message); } }, Object, Array, String };
vm.createContext(context);
vm.runInContext(script, context);
const results = vm.runInContext('[runSmokeCheck(),runPageSmokeCheck(),runPlayerSmokeCheck(),runSettingsSmokeCheck(),runCoverageSmokeCheck(),runOfflineAcceptanceCheck()]', context);
if (!results.slice(1).every((result) => String(result).includes('complete'))) throw new Error(`incomplete smoke results: ${results}`);
console.log(results.join(' | '));
