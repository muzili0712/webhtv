import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./webhtv-dual-ui-prototype.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
assert.ok(script, 'inline prototype script is missing');
assert.ok(css, 'inline prototype CSS is missing');

const listeners = new Map();
const app = { dataset: {}, innerHTML: '' };
const label = { textContent: '' };

function camelCaseData(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function selectorParts(selector) {
  const positive = selector.replace(/:not\([^)]*\)/g, '');
  return {
    tag: positive.match(/^[a-z]+/i)?.[0],
    classes: [...positive.matchAll(/\.([\w-]+)/g)].map((match) => match[1]),
    attrs: [...positive.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((match) => [match[1], match[2]]),
    notHidden: selector.includes(':not([hidden])'),
  };
}

function openingTags() {
  return [...`${html}\n${app.innerHTML}`.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)].map((match) => ({
    tag: match[1].toLowerCase(),
    attrsText: match[2],
  }));
}

function tagMatches(entry, selector) {
  const parts = selectorParts(selector);
  if (parts.tag && entry.tag !== parts.tag.toLowerCase()) return false;
  const className = entry.attrsText.match(/class="([^"]*)"/)?.[1] || '';
  if (!parts.classes.every((name) => className.split(/\s+/).includes(name))) return false;
  if (parts.notHidden && /\shidden(?:\s|=|$)/.test(entry.attrsText)) return false;
  return parts.attrs.every(([name, value]) => {
    const attribute = entry.attrsText.match(new RegExp(`(?:^|\\s)${name}(?:="([^"]*)")?(?=\\s|$)`));
    return Boolean(attribute) && (value === undefined || attribute[1] === value);
  });
}

function makeElement(entry) {
  const dataset = {};
  for (const match of entry.attrsText.matchAll(/data-([\w-]+)="([^"]*)"/g)) {
    dataset[camelCaseData(match[1])] = match[2];
  }
  return {
    dataset,
    tagName: entry.tag.toUpperCase(),
    setAttribute(name, value) { this[name] = value; },
    closest(selector) { return tagMatches(entry, selector) ? this : null; },
  };
}

function findAll(selector) {
  return openingTags().filter((entry) => tagMatches(entry, selector)).map(makeElement);
}

const document = {
  getElementById: (id) => (id === 'app' ? app : id === 'preview-label' ? label : null),
  querySelector: (selector) => findAll(selector)[0] || null,
  querySelectorAll: (selector) => findAll(selector),
  addEventListener: (type, listener) => {
    const entries = listeners.get(type) || [];
    entries.push(listener);
    listeners.set(type, entries);
  },
  body: {
    get textContent() { return app.innerHTML.replace(/<[^>]*>/g, ' '); },
  },
};

const context = {
  document,
  console: { assert: (ok, message) => assert.ok(ok, message) },
  Object,
  Array,
  String,
  Date,
};
vm.createContext(context);
vm.runInContext(script, context);

function state() {
  return vm.runInContext('state', context);
}

function emit(type, selector, properties = {}) {
  const target = document.querySelector(selector);
  assert.ok(target, `cannot dispatch ${type}; selector is not rendered: ${selector}`);
  const event = {
    target,
    preventDefault() {},
    ...properties,
  };
  for (const listener of listeners.get(type) || []) listener(event);
}

function keydown(key) {
  for (const listener of listeners.get('keydown') || []) listener({ key, preventDefault() {} });
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function cssVar(block, name) {
  return block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
}

assert.doesNotMatch(html, /https?:\/\/|<script[^>]+src=|<link[^>]+href=|\bfetch\s*\(|XMLHttpRequest|WebSocket/i, 'prototype must stay static and offline');
assert.doesNotMatch(script, /state\.[A-Za-z_$][\w$]*\s*=(?!=)/, 'all top-level state changes must route through updateState');

for (const [mode, width, height] of [['tv', '960', '540'], ['mobile', '540', '960'], ['mobile-player', '960', '540']]) {
  emit('click', `[data-device="${mode}"]`);
  assert.equal(state().device, mode, `${mode} control must exercise setDevice through the registered click handler`);
  assert.equal(app.dataset.designWidthInDp, width, `${mode} design_width_in_dp is missing`);
  assert.equal(app.dataset.designHeightInDp, height, `${mode} design_height_in_dp is missing`);
  assert.match(label.textContent, new RegExp(`design_width_in_dp=${width}.*design_height_in_dp=${height}`), `${mode} Autosize mapping is not visible`);
}

emit('click', '[data-device="mobile"]');
assert.ok(document.querySelector('[data-action="open-search"]'), 'mobile home must expose persistent search');
emit('click', '[data-page="vod"]');
assert.ok(document.querySelector('[data-action="open-search"]'), 'mobile VOD must expose persistent search');
emit('click', '[data-page="home"]');
emit('click', '[data-action="open-detail"]');
assert.equal(state().page, 'detail', 'content card must reach detail through the click handler');
emit('click', '[data-action="open-player-settings"]');
assert.equal(state().settingsVisible, true, 'detail settings action must update shared state');
assert.ok(document.querySelector('[data-settings-context="detail"]:not([hidden])'), 'detail settings action must render the shared settings panel');
for (const labelText of ['字幕', '弹幕', '画面', '倍速', '清晰度', '当前线路']) assert.match(document.body.textContent, new RegExp(labelText), `shared settings are missing ${labelText}`);
const originalQuality = state().playerSettings.quality;
emit('click', '[data-setting="quality"]');
assert.notEqual(state().playerSettings.quality, originalQuality, 'quality control must mutate shared settings through the handler');
emit('click', '[data-action="play"]');
assert.equal(state().device, 'mobile-player', 'mobile video must enter the landscape player');
assert.equal(state().settingsVisible, true, 'orientation change must preserve the open settings panel');
assert.ok(document.querySelector('[data-settings-context="player"]:not([hidden])'), 'player must render the same visible settings panel');
assert.match(document.body.textContent, new RegExp(state().playerSettings.quality), 'detail setting must carry into player');
emit('click', '[data-action="close-player"]');
assert.equal(state().device, 'mobile', 'closing landscape player must restore portrait mobile');
assert.equal(state().page, 'detail', 'closing player must restore its origin page');

emit('click', '[data-page="profile"]');
emit('click', '[data-action="play-audio"]');
assert.equal(state().device, 'mobile', 'mobile audio must remain 540 × 960 portrait');
assert.ok(document.querySelector('[data-player-kind="audio"]'), 'portrait audio player must render');
emit('click', '[data-action="minimize-audio"]');
assert.equal(state().audioMiniVisible, true, 'audio minimize action must persist a mini player');
emit('click', '[data-page="vod"]');
assert.ok(document.querySelector('[data-mini-player="audio"]'), 'mini audio player must persist across mobile pages');

emit('click', '[data-page="settings"]');
assert.match(document.body.textContent, /手机分组设置/, 'mobile settings must use a mobile semantic heading');
emit('click', '[data-action="open-settings-section"][data-section="playback"]');
assert.ok(document.querySelector('[data-settings-section="playback"]'), 'playback settings category must have a reachable page');
emit('click', '[data-page="settings"]');
emit('click', '[data-action="open-settings-section"][data-section="sources"]');
emit('click', '[data-action="manage-sources"][data-source-kind="vod"]');
assert.equal(state().sourceManager, 'vod', 'VOD manager must be stateful');
const firstVod = state().sources.vod[0];
emit('click', `[data-action="toggle-source"][data-source-id="${firstVod.id}"]`);
assert.notEqual(state().sources.vod[0].enabled, firstVod.enabled, 'source enable action must mutate local mock state');
emit('click', '[data-action="add-source"]');
assert.ok(state().sources.vod.length >= 4, 'source add action must mutate the local collection');
const added = state().sources.vod.at(-1);
emit('click', `[data-action="make-default-source"][data-source-id="${added.id}"]`);
assert.equal(state().defaultSources.vod, added.id, 'default source action must update mock state');
emit('click', `[data-action="remove-source"][data-source-id="${added.id}"]`);
assert.ok(!state().sources.vod.some((source) => source.id === added.id), 'source remove action must update mock state');
const strategy = state().sourceStrategy;
emit('click', '[data-action="cycle-source-strategy"]');
assert.notEqual(state().sourceStrategy, strategy, 'source strategy must be interactive mock state');

emit('click', '[data-device="tv"]');
emit('click', '[data-action="wallpaper-shortcut"]');
assert.equal(state().page, 'personalize', 'TV top bar wallpaper shortcut must be reachable');
emit('click', '[data-page="home"]');
const initialFocus = state().focusIndex;
keydown('ArrowDown');
assert.notEqual(state().focusIndex, initialFocus, 'TV directional keys must update the focus model');
assert.equal(app.dataset.focusIndex, String(state().focusIndex), 'TV focus state must be rendered on the artboard');

emit('click', '[data-page="detail"]');
emit('click', '[data-action="open-player-settings"]');
keydown('Escape');
assert.equal(state().settingsVisible, false, 'Escape must close a temporary settings layer first');
emit('click', '[data-page="history"]');
emit('click', '[data-action="open-dialog"][data-dialog="confirm"]');
keydown('Escape');
assert.equal(state().dialog, null, 'Escape must close a dialog before leaving the page');

emit('click', '[data-device="mobile"]');
emit('click', '[data-page="detail"]');
emit('click', '[data-action="play"]');
const osdBefore = state().osdVisible;
emit('click', '[data-gesture-surface]');
assert.notEqual(state().osdVisible, osdBefore, 'single tap on video must toggle OSD');
emit('dblclick', '[data-gesture-surface]', { clientX: 800 });
assert.match(state().gestureMessage, /快进 10 秒/, 'double tap on right side must seek forward');
emit('pointerdown', '[data-gesture-surface]', { timeStamp: 100 });
emit('pointerup', '[data-gesture-surface]', { timeStamp: 900 });
assert.match(state().gestureMessage, /长按 2×/, 'long press must exercise temporary 2× feedback');

for (const capability of ['tmdb-detail', 'person-detail', 'web-theme-detail', 'episodes', 'keep', 'viewing-report', 'cast-push-scan-receive-device', 'empty-error-network', 'maintenance-update-restore-health']) {
  const selector = `[data-coverage="${capability}"]`;
  assert.ok(document.querySelector(selector), `coverage mapping is missing ${capability}`);
  emit('click', selector);
  assert.ok(document.querySelector('[data-page-view]'), `${capability} coverage mapping must reach a rendered template/state`);
}

const lightBlock = css.match(/#app\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] || '';
const lightInk = cssVar(lightBlock, '--ink');
for (const variable of ['--surface-card', '--surface-strong', '--dialog-bg', '--field-bg']) {
  const surface = cssVar(lightBlock, variable);
  assert.ok(surface, `light theme must define semantic ${variable}`);
  assert.ok(contrastRatio(lightInk, surface) >= 4.5, `${variable} is not legible in light theme`);
}
for (const selector of ['.card', '.hero', '.search-input', '.settings-panel', '.dialog']) {
  const rule = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] || '';
  assert.match(rule, /var\(--(?:surface|dialog|field)/, `${selector} must use semantic theme surfaces`);
}

const stateBeforeAggregate = JSON.parse(JSON.stringify(state()));
const browserChecks = vm.runInContext('runOfflineAcceptanceCheck()', context);
assert.match(String(browserChecks), /complete/, 'browser-console acceptance aggregate did not complete');
assert.deepEqual(JSON.parse(JSON.stringify(state())), stateBeforeAggregate, 'acceptance aggregate must restore the complete pre-check state');

console.log('PASS offline scope and centralized state flow');
console.log('PASS actual click, keyboard, pointer, and render paths');
console.log('PASS three Autosize artboards and kind-aware orientation');
console.log('PASS shared settings, semantic light surfaces, and source mock state');
console.log('PASS page/behavior coverage mappings and state restoration');
