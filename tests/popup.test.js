'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const EVAL_SOURCE = fs.readFileSync(path.join(ROOT, 'utils/quality_evaluator.js'), 'utf8');
const POPUP_SOURCE = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');
const POPUP_HTML = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makePayload(overrides) {
  return Object.assign(
    {
      hasVideo: true,
      isPlaying: true,
      paused: false,
      buffering: false,
      isIframe: false,
      displayArea: 921600,
      width: 1920,
      height: 804,
      aspectRatio: '2.39:1',
      fps: 24,
      bitrateKbps: 4250,
      bitrateKnown: true,
      codec: 'H.265 (HEVC)',
      codecEfficiency: 0.5,
      totalFrames: 1842,
      droppedFrames: 0,
      dropRate: '0.00',
      evaluation: {
        label: '1080P 蓝光 24帧',
        badgeText: '1080',
        badgeColor: '#059669',
        qualityLevel: 'high',
        qualityText: '高码率 / 真蓝光',
      },
    },
    overrides || {}
  );
}

function stateOf(payload) {
  return { hasVideo: true, best: { payload, frameId: 0, isIframe: !!payload.isIframe, updatedAt: 1 }, frames: [] };
}

/** Minimal fake element: only what popup.js touches. */
function fakeElement(id) {
  const listeners = {};
  return {
    id,
    textContent: '',
    hidden: false,
    checked: false,
    dataset: {},
    style: {},
    addEventListener: (type, fn) => (listeners[type] = fn),
    fire: (type) => listeners[type] && listeners[type](),
  };
}

/** Loads the real popup.html ids into fake elements, then runs popup.js. */
async function createPopup(options) {
  const opts = options || {};
  const elements = {};
  const idPattern = /id="([^"]+)"/g;
  let match;
  while ((match = idPattern.exec(POPUP_HTML))) elements[match[1]] = fakeElement(match[1]);
  elements.content.hidden = true;

  const messages = [];
  const store = Object.assign({}, opts.local);
  const changeListeners = [];
  let interval = null;
  const unloadListeners = [];
  const sandbox = {
    document: { getElementById: (id) => elements[id] || null },
    window: { addEventListener: (type, fn) => type === 'unload' && unloadListeners.push(fn) },
    setInterval: (fn, ms) => {
      interval = { fn, ms, cleared: false };
      return 1;
    },
    clearInterval: () => {
      if (interval) interval.cleared = true;
    },
    chrome: {
      tabs: { query: async () => opts.tabs || [{ id: 5, url: 'https://example.com/watch' }] },
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          const next = typeof opts.state === 'function' ? opts.state() : opts.state;
          if (next instanceof Error) throw next;
          return next;
        },
      },
      storage: {
        local: {
          get: async (defaults) => Object.assign({}, defaults, store),
          set: async (items) => {
            if (opts.setFails) throw new Error('quota');
            Object.assign(store, items);
            // Like Chrome, tell the storage.onChanged listeners about the write.
            const changes = {};
            Object.keys(items).forEach((key) => (changes[key] = { newValue: items[key] }));
            changeListeners.forEach((fn) => fn(changes, 'local'));
          },
        },
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (!opts.noEvaluator) vm.runInContext(EVAL_SOURCE, sandbox);
  vm.runInContext(POPUP_SOURCE, sandbox);
  await flush();
  await flush();
  return {
    el: elements,
    messages,
    store,
    unloadListeners,
    /** Delivers a storage.onChanged event, as another extension page would cause. */
    changed: (changes, area) => changeListeners.forEach((fn) => fn(changes, area === undefined ? 'local' : area)),
    get interval() {
      return interval;
    },
    tick: async () => {
      await interval.fn();
      await flush();
    },
  };
}

test('popup.html has no inline scripts and loads the evaluator before popup.js', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(POPUP_HTML));
  assert.ok(POPUP_HTML.indexOf('quality_evaluator.js') < POPUP_HTML.indexOf('popup.js'));
});

test('renders a playing video in all cards and polls every 1000ms', async () => {
  const popup = await createPopup({ state: stateOf(makePayload()) });
  assert.equal(JSON.stringify(popup.messages[0]), JSON.stringify({ type: 'GET_TAB_STATE', tabId: 5 }));
  assert.equal(popup.interval.ms, 1000);
  assert.equal(popup.el.content.hidden, false);
  assert.equal(popup.el.empty.hidden, true);
  assert.equal(popup.el['status-label'].textContent, '1080P 蓝光 · 24帧');
  assert.equal(popup.el['status-badge'].textContent, '高码率 / 真蓝光');
  assert.equal(popup.el.status.dataset.level, 'high');
  assert.equal(popup.el['info-video'].textContent, 'H.265 · 1920×804 · 24 fps');
  assert.equal(popup.el['meta-aspect'].textContent, '2.39:1 宽屏');
  assert.equal(popup.el['info-rate'].textContent, '码率 4.25 Mb/s');
  assert.equal(popup.el['card-bitrate'].dataset.level, 'high');
  assert.ok(parseInt(popup.el['bitrate-bar'].style.width, 10) > 0);
    assert.equal(popup.el['drops-value'].textContent, '0 / 1842 (0.00%)');
  assert.equal(popup.el['source-value'].textContent, '主页面');
  assert.equal(popup.el['source-state'].textContent, '播放中');
});

test('iframe source is labelled as an embedded player', async () => {
  const popup = await createPopup({ state: stateOf(makePayload({ isIframe: true })) });
  assert.equal(popup.el['source-value'].textContent, 'Iframe 嵌套播放器');
});

test('paused state keeps the last bitrate instead of showing 0', async () => {
  let current = stateOf(makePayload());
  const popup = await createPopup({ state: () => current });
  assert.equal(popup.el['info-rate'].textContent, '码率 4.25 Mb/s');

  // While paused the payload reports 0 kbps and 0 fps.
  current = stateOf(makePayload({ paused: true, isPlaying: false, bitrateKbps: 0, fps: 0 }));
  await popup.tick();
  assert.equal(popup.el['source-state'].textContent, '已暂停');
  assert.equal(popup.el['info-rate'].textContent, '码率 4.25 Mb/s');
  assert.match(popup.el['rate-note'].textContent, /已暂停/);
  assert.match(popup.el['info-video'].textContent, /24 fps/);
});

test('paused payload that already carries the last bitrate is shown as is', async () => {
  const popup = await createPopup({
    state: stateOf(makePayload({ paused: true, isPlaying: false, bitrateKbps: 3000 })),
  });
  assert.equal(popup.el['info-rate'].textContent, '码率 3.00 Mb/s');
  assert.equal(popup.el['source-state'].textContent, '已暂停');
});

test('a stalled video (isPlaying false, not paused) shows buffering, not paused', async () => {
  let current = stateOf(makePayload());
  const popup = await createPopup({ state: () => current });
  current = stateOf(
    makePayload({ paused: false, isPlaying: false, buffering: true, bitrateKbps: 0, fps: 0 })
  );
  await popup.tick();
  assert.equal(popup.el['source-state'].textContent, '缓冲中');
  assert.equal(popup.el['info-rate'].textContent, '码率 4.25 Mb/s');
  assert.match(popup.el['rate-note'].textContent, /缓冲中/);
  assert.match(popup.el['info-video'].textContent, /24 fps/);
});

test('unknown bitrate shows 不支持/未知 and keeps resolution and fps', async () => {
  const popup = await createPopup({
    state: stateOf(
      makePayload({
        bitrateKbps: null,
        bitrateKnown: false,
        evaluation: {
          label: '1080P 蓝光 24帧',
          badgeText: '1080',
          badgeColor: '#059669',
          qualityLevel: 'unknown',
          qualityText: '码率未知',
        },
      })
    ),
  });
  assert.equal(popup.el['info-rate'].textContent, '码率 未知');
  assert.equal(popup.el['card-bitrate'].dataset.level, 'unknown');
  assert.equal(popup.el['bitrate-bar'].style.width, '0%');
  assert.match(popup.el['info-video'].textContent, /1920×804/);
  assert.match(popup.el['info-video'].textContent, /24 fps/);
});

test('low quality shows the fake-HD warning with the tier name', async () => {
  const popup = await createPopup({
    state: stateOf(
      makePayload({
        width: 1920,
        height: 1080,
        bitrateKbps: 600,
        evaluation: {
          label: '1080P 蓝光 24帧',
          badgeText: '1080',
          badgeColor: '#059669',
          qualityLevel: 'low',
          qualityText: '码率过低',
        },
      })
    ),
  });
  assert.equal(popup.el['status-badge'].textContent, '⚠ 疑似假1080P（码率过低）');
  assert.equal(popup.el.status.dataset.level, 'low');
  assert.equal(popup.el['card-bitrate'].dataset.level, 'low');
});

test('shows the empty state when there is no video', async () => {
  const popup = await createPopup({ state: { hasVideo: false, best: null, frames: [] } });
  assert.equal(popup.el.empty.hidden, false);
  assert.equal(popup.el.content.hidden, true);
  assert.equal(
    popup.el['empty-text'].textContent,
    '当前页面未检测到正在播放的 HTML5 视频，或视频使用 Canvas 渲染'
  );
});

test('shows the empty state for restricted pages without messaging background', async () => {
  const popup = await createPopup({
    tabs: [{ id: 9, url: 'chrome://extensions' }],
    state: stateOf(makePayload()),
  });
  assert.equal(popup.messages.length, 0);
  assert.equal(popup.el.empty.hidden, false);
  assert.equal(popup.el.content.hidden, true);
});

test('shows the empty state when the service worker request fails, then recovers', async () => {
  let next = new Error('no receiver');
  const popup = await createPopup({ state: () => next });
  assert.equal(popup.el.empty.hidden, false);
  next = stateOf(makePayload());
  await popup.tick();
  assert.equal(popup.el.empty.hidden, true);
  assert.equal(popup.el.content.hidden, false);
});

test('page-derived strings are written through textContent only', async () => {
  const code = POPUP_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code));
  const hostile = '<img src=x onerror=alert(1)>';
  const popup = await createPopup({ state: stateOf(makePayload({ codec: hostile })) });
  assert.ok(popup.el['info-video'].textContent.includes('<img src=x onerror=alert(1)>'));
});

test('does not rewrite unchanged values on refresh', async () => {
  const popup = await createPopup({ state: stateOf(makePayload()) });
  let writes = 0;
  const el = popup.el['info-video'];
  let value = el.textContent;
  Object.defineProperty(el, 'textContent', {
    get: () => value,
    set: (v) => {
      writes += 1;
      value = v;
    },
  });
  await popup.tick();
  assert.equal(writes, 0);
});

test('OSD switch reads the stored value and writes changes to chrome.storage.local', async () => {
  const popup = await createPopup({ local: { osdEnabled: false }, state: stateOf(makePayload()) });
  assert.equal(popup.el['osd-toggle'].checked, false);
  popup.el['osd-toggle'].checked = true;
  popup.el['osd-toggle'].fire('change');
  await flush();
  assert.equal(popup.store.osdEnabled, true);
});

test('OSD switch defaults to on and reverts with an error when saving fails', async () => {
  const popup = await createPopup({ setFails: true, state: stateOf(makePayload()) });
  assert.equal(popup.el['osd-toggle'].checked, true);
  popup.el['osd-toggle'].checked = false;
  popup.el['osd-toggle'].fire('change');
  await flush();
  assert.equal(popup.el['osd-toggle'].checked, true);
  assert.equal(popup.el['osd-error'].hidden, false);
});

test('popup.html has the detection switch above the content, checked by default', () => {
  assert.match(POPUP_HTML, /id="detect-toggle"[^>]*checked/);
  assert.ok(POPUP_HTML.indexOf('id="detect-toggle"') < POPUP_HTML.indexOf('id="content"'));
  assert.match(POPUP_HTML, /检测画质/);
  assert.match(POPUP_HTML, /关闭后停止检测画质，悬浮窗仅保留开关按钮/);
});

test('detection switch defaults to on and reflects the stored value', async () => {
  const on = await createPopup({ state: stateOf(makePayload()) });
  assert.equal(on.el['detect-toggle'].checked, true);

  const off = await createPopup({ local: { detectionEnabled: false }, state: stateOf(makePayload()) });
  assert.equal(off.el['detect-toggle'].checked, false);
});

test('detection switch writes detectionEnabled to chrome.storage.local', async () => {
  const popup = await createPopup({ state: stateOf(makePayload()) });
  popup.el['detect-toggle'].checked = false;
  popup.el['detect-toggle'].fire('change');
  await flush();
  assert.equal(popup.store.detectionEnabled, false);
  assert.equal(popup.el['detect-error'].hidden, true);
  assert.equal(popup.store.osdEnabled, undefined); // the OSD switch is independent

  popup.el['detect-toggle'].checked = true;
  popup.el['detect-toggle'].fire('change');
  await flush();
  assert.equal(popup.store.detectionEnabled, true);
});

test('detection switch reverts and shows an error when saving fails', async () => {
  const popup = await createPopup({ setFails: true, state: stateOf(makePayload()) });
  popup.el['detect-toggle'].checked = false;
  popup.el['detect-toggle'].fire('change');
  await flush();
  assert.equal(popup.el['detect-toggle'].checked, true);
  assert.equal(popup.el['detect-error'].hidden, false);
  assert.equal(popup.el['detect-error'].textContent, '保存设置失败，请重试');
  assert.equal(popup.el.content.hidden, false); // still detecting
});

test('with detection off the popup shows the disabled text and does not message background', async () => {
  const popup = await createPopup({ local: { detectionEnabled: false }, state: stateOf(makePayload()) });
  assert.equal(popup.messages.length, 0);
  assert.equal(popup.el.content.hidden, true);
  assert.equal(popup.el.empty.hidden, false);
  assert.equal(popup.el['empty-text'].textContent, '检测已关闭，打开上方开关后开始检测');

  await popup.tick();
  await popup.tick();
  assert.equal(popup.messages.length, 0);
  assert.equal(popup.el.content.hidden, true);
});

test('turning detection on from the popup refreshes right away', async () => {
  const popup = await createPopup({ local: { detectionEnabled: false }, state: stateOf(makePayload()) });
  assert.equal(popup.messages.length, 0);

  popup.el['detect-toggle'].checked = true;
  popup.el['detect-toggle'].fire('change');
  await flush();
  await flush();
  assert.equal(popup.messages.length, 1);
  assert.equal(popup.el.content.hidden, false);
  assert.match(popup.el['info-video'].textContent, /1920×804/);
});

test('turning detection on shows the neutral waiting text until data arrives', async () => {
  // The first answer never arrives, so only the immediate waiting text can be on screen.
  const popup = await createPopup({ local: { detectionEnabled: false }, state: () => new Promise(() => {}) });
  assert.equal(popup.el['empty-text'].textContent, '检测已关闭，打开上方开关后开始检测');
  popup.changed({ detectionEnabled: { newValue: true } });
  await flush();
  await flush();
  assert.equal(popup.el.content.hidden, true);
  assert.equal(
    popup.el['empty-text'].textContent,
    '当前页面未检测到正在播放的 HTML5 视频，或视频使用 Canvas 渲染'
  );
});

test('turning detection off hides the content and clears the remembered values', async () => {
  const popup = await createPopup({ state: stateOf(makePayload()) });
  assert.equal(popup.el.content.hidden, false);

  popup.el['detect-toggle'].checked = false;
  popup.el['detect-toggle'].fire('change');
  await flush();
  assert.equal(popup.el.content.hidden, true);
  assert.equal(popup.el['empty-text'].textContent, '检测已关闭，打开上方开关后开始检测');
  const before = popup.messages.length;
  await popup.tick();
  assert.equal(popup.messages.length, before);
});

test('a disabled answer from background shows the disabled text', async () => {
  const popup = await createPopup({
    state: { hasVideo: false, best: null, frames: [], detectionEnabled: false },
  });
  assert.equal(popup.el['empty-text'].textContent, '检测已关闭，打开上方开关后开始检测');
  assert.equal(popup.el.content.hidden, true);
});

test('storage.onChanged keeps the detection switch in sync (local area only)', async () => {
  const popup = await createPopup({ state: stateOf(makePayload()) });
  popup.changed({ detectionEnabled: { newValue: false } }, 'sync');
  assert.equal(popup.el['detect-toggle'].checked, true);

  popup.changed({ detectionEnabled: { newValue: false } });
  assert.equal(popup.el['detect-toggle'].checked, false);
  assert.equal(popup.el.content.hidden, true);

  popup.changed({ detectionEnabled: { newValue: true } });
  assert.equal(popup.el['detect-toggle'].checked, true);
});

test('storage.onChanged for osdEnabled still updates only the OSD switch', async () => {
  const popup = await createPopup({ state: stateOf(makePayload()) });
  popup.changed({ osdEnabled: { newValue: false } });
  assert.equal(popup.el['osd-toggle'].checked, false);
  assert.equal(popup.el['detect-toggle'].checked, true);
  assert.equal(popup.el.content.hidden, false);
});

test('clears the refresh interval on unload', async () => {
  const popup = await createPopup({ state: stateOf(makePayload()) });
  assert.equal(popup.unloadListeners.length, 1);
  popup.unloadListeners[0]();
  assert.equal(popup.interval.cleared, true);
});

test('still renders when the evaluator namespace is missing', async () => {
  const popup = await createPopup({ noEvaluator: true, state: stateOf(makePayload()) });
  assert.equal(popup.el.content.hidden, false);
  assert.equal(popup.el['info-rate'].textContent, '码率 4.25 Mb/s');
  assert.match(popup.el['info-video'].textContent, /1920×804/);
});

// ---------------------------------------------------------------------------
// Compact layout: the three HUD lines, audio row, bitrate note
// ---------------------------------------------------------------------------

test('popup shows the same three lines as the HUD, with audio and download speed', async () => {
  const popup = await createPopup({
    state: stateOf(
      makePayload({
        codec: 'H.264 (AVC)',
        width: 1920,
        height: 1080,
        aspectRatio: '16:9',
        fps: 25.43,
        bitrateKbps: 712,
        audioCodec: 'AAC',
        audioSampleRate: 48000,
        audioChannels: 2,
        downloadBps: 753000,
      })
    ),
  });
  assert.equal(popup.el['info-video'].textContent, 'H.264 · 1920×1080 · 25.4 fps');
  assert.equal(popup.el['info-audio'].textContent, 'AAC · 48 kHz · 2.0');
  assert.equal(popup.el['info-audio-row'].hidden, false);
  assert.equal(popup.el['info-rate'].textContent, '码率 712 kb/s · 下载 753 KB/s');
  assert.equal(popup.el['rate-note'].hidden, true);
});

test('popup hides the audio row and the download part when they are unknown', async () => {
  const popup = await createPopup({ state: stateOf(makePayload()) });
  assert.equal(popup.el['info-audio-row'].hidden, true);
  assert.equal(popup.el['info-rate'].textContent.includes('下载'), false);
});

test('popup explains an unknown bitrate in the note under the bar', async () => {
  const popup = await createPopup({
    state: stateOf(makePayload({ bitrateKbps: null, bitrateKnown: false })),
  });
  assert.equal(popup.el['info-rate'].textContent, '码率 未知');
  assert.equal(popup.el['rate-note'].hidden, false);
  assert.match(popup.el['rate-note'].textContent, /浏览器未提供/);
});

test('popup hides the audio row again when the next report has no audio', async () => {
  let current = stateOf(makePayload({ audioCodec: 'Opus', audioSampleRate: 48000, audioChannels: 2 }));
  const popup = await createPopup({ state: () => current });
  assert.equal(popup.el['info-audio-row'].hidden, false);
  current = stateOf(makePayload());
  await popup.tick();
  assert.equal(popup.el['info-audio-row'].hidden, true);
});

test('popup.html is compact: no old six card grid, detection switch next to the title', () => {
  assert.ok(!/class="grid"/.test(POPUP_HTML));
  assert.ok(POPUP_HTML.indexOf('id="detect-toggle"') < POPUP_HTML.indexOf('id="status"'));
  assert.ok(!/switch-hint/.test(POPUP_HTML), 'no two line hints under the switches');
});

test('popup.css width is 300px or less', () => {
  const css = fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8');
  const width = /body\s*\{[^}]*?width:\s*(\d+)px/.exec(css);
  assert.ok(width && Number(width[1]) <= 300, width && width[1]);
});
