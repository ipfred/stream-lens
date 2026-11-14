'use strict';

/**
 * Smoke tests for content_isolated.js. The script runs in a vm context with a
 * small fake DOM, fake chrome API, fake timers and a controllable clock, so the
 * sampling, reporting and OSD logic can be checked without Chrome.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const EVAL_SOURCE = fs.readFileSync(path.join(ROOT, 'utils', 'quality_evaluator.js'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'content_isolated.js'), 'utf8');

class FakeNode {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = [];
    this.shadowRoot = null;
    this.isConnected = true;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  attachShadow() {
    // Kept on a private field: tests peek into the closed root, the page cannot.
    this.closedRoot = new FakeNode('shadow');
    return this.closedRoot;
  }
  find(className) {
    if (String(this.className || '').split(/\s+/).includes(className)) return this;
    const kids = this.children.concat(this.closedRoot ? [this.closedRoot] : []);
    for (const kid of kids) {
      const hit = kid.find(className);
      if (hit) return hit;
    }
    return null;
  }
  addEventListener(type, fn) {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
  }
  querySelectorAll() {
    return [];
  }
  // Collects text of the whole fake subtree.
  deepText() {
    const kids = this.children.concat(this.closedRoot ? [this.closedRoot] : []);
    return (this.textContent || '') + kids.map((c) => c.deepText()).join('');
  }
}

class FakeVideo extends FakeNode {
  constructor(options) {
    super('video');
    Object.assign(
      this,
      {
        videoWidth: 1920,
        videoHeight: 1080,
        paused: false,
        ended: false,
        seeking: false,
        readyState: 4,
        currentSrc: 'https://cdn.example.com/movie.mp4',
        webkitVideoDecodedByteCount: 0,
        total: 0,
        dropped: 0,
        rect: { width: 960, height: 540, top: 100, bottom: 640, left: 100, right: 1060 },
        rvfc: null,
        rvfcCancelled: [],
      },
      options
    );
  }
  getBoundingClientRect() {
    return this.rect;
  }
  getVideoPlaybackQuality() {
    return { totalVideoFrames: this.total, droppedVideoFrames: this.dropped };
  }
  requestVideoFrameCallback(cb) {
    this.rvfcRequests = (this.rvfcRequests || 0) + 1;
    this.rvfc = cb;
    return 42;
  }
  cancelVideoFrameCallback(handle) {
    this.rvfcCancelled.push(handle);
    this.rvfc = null;
  }
  fire(type) {
    this.listeners.filter((l) => l.type === type).forEach((l) => l.fn({ target: this }));
  }
}

function createFrame(options) {
  const opts = options || {};
  const videos = opts.videos || [];
  const sent = [];
  const posted = [];
  const windowListeners = [];
  const intervals = [];
  const clock = { t: 1000 };
  const storageListeners = [];
  const runtimeListeners = [];
  const storageSet = [];
  const sandbox = {};
  const observers = [];
  const stats = { starQueries: 0, observersCreated: 0, rvfcRequests: 0, clearedIntervals: 0 };
  let pendingGet = null;

  const body = new FakeNode('body');
  const documentElement = new FakeNode('html');
  documentElement.clientWidth = 1280;
  documentElement.clientHeight = 720;
  const docListeners = [];
  const doc = {
    body,
    documentElement,
    fullscreenElement: null,
    createElement: (tag) => new FakeNode(tag),
    querySelectorAll: (sel) => {
      if (sel === 'video') return videos.filter((v) => v.isConnected);
      if (sel === '*') {
        stats.starQueries++;
        return opts.elements || [];
      }
      return [];
    },
    addEventListener: (type, fn) => docListeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) docListeners.splice(i, 1);
    },
  };

  sandbox.document = doc;
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  if (opts.iframe) sandbox.top = {};
  sandbox.location = { hostname: 'video.example.com' };
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 720;
  sandbox.performance = { now: () => clock.t };
  sandbox.addEventListener = (type, fn) => windowListeners.push({ type, fn });
  sandbox.removeEventListener = (type, fn) => {
    const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) windowListeners.splice(i, 1);
  };
  sandbox.postMessage = (message) => posted.push(message);
  let intervalId = 0;
  sandbox.setInterval = (fn, ms) => {
    intervals.push({ fn, ms, id: ++intervalId });
    return intervalId;
  };
  sandbox.clearInterval = (id) => {
    const i = intervals.findIndex((x) => x.id === id);
    if (i >= 0) {
      intervals.splice(i, 1);
      stats.clearedIntervals++;
    }
  };
  sandbox.setTimeout = () => 1;
  sandbox.clearTimeout = () => {};
  sandbox.MutationObserver = class {
    constructor() {
      stats.observersCreated++;
      this.connected = false;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  };
  sandbox.chrome = {
    runtime: {
      id: 'test-extension',
      lastError: opts.lastError ? { message: 'boom' } : undefined,
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve(opts.reply ? opts.reply() : undefined);
      },
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    },
    storage: {
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
      local: {
        // opts.holdGet delays the answer until frame.releaseGet() is called.
        get: (defaults, cb) => {
          const answer = () => cb(Object.assign({}, defaults, opts.storage));
          if (opts.holdGet) pendingGet = answer;
          else answer();
        },
        // opts.rejectSet makes set() return a rejected promise, like a failed write.
        set: (items) => {
          storageSet.push(items);
          if (opts.rejectSet) return Promise.reject(new Error('quota'));
          return undefined;
        },
      },
    },
  };
  if (opts.noStorage) delete sandbox.chrome.storage;
  if (opts.throwingGet) {
    sandbox.chrome.storage.local.get = () => {
      throw new Error('storage unavailable');
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(EVAL_SOURCE, sandbox);
  vm.runInContext(SOURCE, sandbox);

  const win = vm.runInContext('window', sandbox);
  return {
    sandbox,
    stats,
    observers,
    releaseGet: () => pendingGet && pendingGet(),
    body,
    doc,
    sent,
    posted,
    clock,
    storageSet,
    runtimeListeners,
    storageListeners,
    windowListeners,
    docListeners,
    intervals,
    win,
    /** Advances the clock by one second and runs the reporting interval. */
    tick() {
      clock.t += 1000;
      intervals.forEach((i) => i.fn());
    },
    last() {
      return sent[sent.length - 1];
    },
    osdText() {
      const host = body.children[0];
      return host ? host.deepText() : null;
    },
  };
}

/** Simulates one second of playback: frames presented and bytes decoded. */
function play(video, frames, bytes) {
  for (let i = 0; i < frames && video.rvfc; i++) video.rvfc();
  video.total += frames;
  video.webkitVideoDecodedByteCount += bytes;
}

/** The 1000 ms reporting interval (the idle HUD timer runs at another period). */
const reportTimers = (frame) => frame.intervals.filter((i) => i.ms === 1000);
const idleTimers = (frame) => frame.intervals.filter((i) => i.ms !== 1000);

test('reports fps, bitrate, codec and evaluation for a playing MP4', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });

  frame.tick(); // baseline sample
  play(video, 60, 600000);
  frame.tick();
  play(video, 60, 600000);
  frame.tick();

  const msg = frame.last();
  assert.equal(msg.type, 'VIDEO_METRICS_UPDATE');
  const p = msg.payload;
  assert.equal(p.hasVideo, true);
  assert.equal(p.isPlaying, true);
  assert.equal(p.isIframe, false);
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.equal(p.aspectRatio, '16:9');
  assert.equal(p.displayArea, 960 * 540);
  assert.equal(p.fps, 60);
  assert.equal(p.bitrateKbps, 4800);
  assert.equal(p.bitrateKnown, true);
  assert.equal(p.codec, 'MP4 (直链)');
  assert.equal(p.codecEfficiency, 1);
  assert.equal(p.totalFrames, 120);
  assert.equal(p.dropRate, '0.00');
  assert.equal(p.frameUrl, 'video.example.com');
  assert.equal(p.evaluation.badgeText, '1080');
  assert.equal(p.evaluation.qualityLevel, 'high');
  assert.equal(p.evaluation.label, '1080P 蓝光 60帧');
});

test('OSD is rendered into the body with the summary line', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();

  assert.equal(frame.body.children.length, 1);
  const text = frame.osdText();
  assert.match(text, /MP4 · 1920×1080 · 60 fps/);
  assert.match(text, /码率 4\.80 Mb\/s/);
  const css = frame.body.children[0].style.cssText;
  assert.match(css, /z-index:2147483647/);
  assert.match(css, /top:116px/); // video top (100) + 16
  assert.match(css, /right:236px/); // 1280 - 1060 + 16
});

test('pausing keeps the last valid fps and bitrate and marks the payload paused', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();

  video.paused = true;
  frame.tick(); // no frames, no bytes
  const p = frame.last().payload;
  assert.equal(p.paused, true);
  assert.equal(p.isPlaying, false);
  assert.equal(p.fps, 60);
  assert.equal(p.bitrateKbps, 4800);
  assert.equal(p.evaluation.qualityLevel, 'high');
  assert.equal(frame.body.children[0].find('tag').hidden, false);
});

test('bitrate is a 3 sample sliding average', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  [1000000, 500000, 500000, 500000].forEach((bytes) => {
    play(video, 30, bytes);
    frame.tick();
  });
  // Last three samples: 4000, 4000, 4000 kbps (the 8000 kbps sample dropped out).
  assert.equal(frame.last().payload.bitrateKbps, 4000);
});

test('bitrate is unknown when the byte counter is unsupported or always zero', () => {
  const video = new FakeVideo();
  delete video.webkitVideoDecodedByteCount;
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 30, 0);
  frame.tick();
  let p = frame.last().payload;
  assert.equal(p.bitrateKbps, null);
  assert.equal(p.bitrateKnown, false);
  assert.equal(p.evaluation.qualityLevel, 'unknown');
  assert.equal(p.fps, 30);

  const zero = new FakeVideo();
  const frame2 = createFrame({ videos: [zero] });
  frame2.tick();
  play(zero, 30, 0);
  frame2.tick();
  p = frame2.last().payload;
  assert.equal(p.bitrateKnown, false);
});

test('MSE codec from content_main.js is used for blob sources and updates immediately', () => {
  const video = new FakeVideo({ currentSrc: 'blob:https://video.example.com/abc' });
  const frame = createFrame({ videos: [video] });
  frame.tick();

  const handler = frame.windowListeners.find((l) => l.type === 'message').fn;
  handler({
    source: frame.win,
    data: {
      source: '__VQI_MAIN__',
      type: 'CODEC_DETECTED',
      payload: { mimeType: 'video/mp4; codecs="hvc1.1.6.L93.B0"', timestamp: 1 },
    },
  });
  let p = frame.last().payload;
  assert.equal(p.codec, 'H.265 (HEVC)');
  assert.equal(p.codecEfficiency, 1.45);

  // Quality switch to AV1 is reflected right away.
  handler({
    source: frame.win,
    data: { source: '__VQI_MAIN__', type: 'CODEC_DETECTED', payload: { mimeType: 'video/mp4; codecs="av01.0.05M.08"' } },
  });
  assert.equal(frame.last().payload.codec, 'AV1');

  // Foreign messages are ignored.
  handler({ source: {}, data: { source: '__VQI_MAIN__', type: 'CODEC_DETECTED', payload: { mimeType: 'video/webm; codecs="vp9"' } } });
  handler({ source: frame.win, data: { source: 'page', type: 'CODEC_DETECTED', payload: { mimeType: 'video/webm; codecs="vp9"' } } });
  assert.equal(frame.last().payload.codec, 'AV1');
});

test('the isolated script asks content_main.js to replay a missed codec message', () => {
  const frame = createFrame({ videos: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(frame.posted[0])), { source: '__VQI_ISO__', type: 'REQUEST_CODEC' });
});

test('emptied clears the codec and the bitrate history', () => {
  const video = new FakeVideo({ currentSrc: 'blob:https://video.example.com/abc' });
  const frame = createFrame({ videos: [video] });
  const handler = frame.windowListeners.find((l) => l.type === 'message').fn;
  frame.tick();
  handler({
    source: frame.win,
    data: { source: '__VQI_MAIN__', type: 'CODEC_DETECTED', payload: { mimeType: 'video/webm; codecs="vp9"' } },
  });
  play(video, 30, 300000);
  frame.tick();
  assert.equal(frame.last().payload.codec, 'VP9');
  assert.ok(frame.last().payload.bitrateKbps > 0);

  video.fire('emptied');
  const p = frame.last().payload;
  assert.equal(p.codec, '未知编码');
  assert.equal(p.codecKnown, false);
  assert.equal(p.bitrateKbps, null);
});

test('loadedmetadata resets bitrate but keeps the codec captured before it', () => {
  const video = new FakeVideo({ currentSrc: 'blob:https://video.example.com/abc' });
  const frame = createFrame({ videos: [video] });
  const handler = frame.windowListeners.find((l) => l.type === 'message').fn;
  frame.tick();
  play(video, 30, 300000);
  frame.tick();
  handler({
    source: frame.win,
    data: { source: '__VQI_MAIN__', type: 'CODEC_DETECTED', payload: { mimeType: 'video/webm; codecs="vp9"' } },
  });
  video.fire('loadedmetadata');
  const p = frame.last().payload;
  assert.equal(p.codec, 'VP9');
  assert.equal(p.bitrateKbps, null);
});

test('resize triggers an immediate report with the new resolution', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  const before = frame.sent.length;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.fire('resize');
  assert.equal(frame.sent.length, before + 1);
  assert.equal(frame.last().payload.evaluation.badgeText, '720');
});

test('a playing video beats a larger paused one', () => {
  const big = new FakeVideo({ paused: true, rect: { width: 1900, height: 1000, top: 0, bottom: 1000, left: 0, right: 1900 } });
  const small = new FakeVideo({ videoWidth: 640, videoHeight: 360, rect: { width: 320, height: 180, top: 0, bottom: 180, left: 0, right: 320 } });
  const frame = createFrame({ videos: [big, small] });
  frame.tick();
  assert.equal(frame.last().payload.width, 640);
});

test('invalid videos (no dimensions) are ignored and no message is sent', () => {
  const video = new FakeVideo({ videoWidth: 0, videoHeight: 0 });
  const frame = createFrame({ videos: [video] });
  frame.tick();
  frame.tick();
  // Only the one-time announcement of the top frame, no metrics.
  assert.equal(frame.sent.length, 1);
  assert.equal(frame.sent[0].payload.hasVideo, false);
  assert.equal(frame.body.children.length, 0);
});

test('an iframe without a video sends nothing', () => {
  const frame = createFrame({ videos: [], iframe: true });
  frame.tick();
  frame.tick();
  assert.equal(frame.sent.length, 0);
});

test('a source change followed by loadstart does not zero the fps on the next tick', () => {
  const video = new FakeVideo({ currentSrc: 'blob:https://video.example.com/a' });
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  assert.equal(frame.last().payload.fps, 60);

  // In a real browser the new currentSrc is already visible when loadstart fires.
  video.currentSrc = 'blob:https://video.example.com/b';
  video.fire('emptied');
  video.fire('loadstart');
  assert.equal(frame.last().payload.fps, 60); // old value stays visible
  play(video, 60, 600000);
  frame.tick();
  assert.equal(frame.last().payload.fps, 60);
});

test('hidden videos fall back to videoWidth * videoHeight * 0.1 for the area', () => {
  const video = new FakeVideo({ rect: { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 } });
  const frame = createFrame({ videos: [video] });
  frame.tick();
  assert.equal(frame.last().payload.displayArea, Math.round(1920 * 1080 * 0.1));
  // Without a rect the OSD uses the viewport top-right.
  assert.match(frame.body.children[0].style.cssText, /top:16px/);
  assert.match(frame.body.children[0].style.cssText, /right:16px/);
});

test('removing the video sends hasVideo:false once, cancels rVFC, and removes the OSD', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  assert.equal(frame.body.children.length, 1);

  video.isConnected = false;
  frame.tick();
  frame.tick();
  frame.tick();
  const falses = frame.sent.filter((m) => m.payload.hasVideo === false);
  assert.equal(falses.length, 1);
  assert.deepEqual(video.rvfcCancelled, [42]);
  assert.equal(video.listeners.length, 0);
  assert.equal(frame.body.children.length, 0);
});

test('fps falls back to getVideoPlaybackQuality when rVFC is missing', () => {
  const video = new FakeVideo();
  video.requestVideoFrameCallback = undefined;
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 30, 300000);
  frame.tick();
  play(video, 30, 300000);
  frame.tick();
  assert.equal(frame.last().payload.fps, 30);
});

test('dropped frames are reported with a percentage', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  video.dropped = 3;
  frame.tick();
  const p = frame.last().payload;
  assert.equal(p.droppedFrames, 3);
  assert.equal(p.totalFrames, 60);
  assert.equal(p.dropRate, '5.00');
});

test('iframes report isIframe: true', () => {
  const frame = createFrame({ videos: [new FakeVideo()], iframe: true });
  frame.tick();
  assert.equal(frame.last().payload.isIframe, true);
});

test('osdEnabled=false in storage hides the OSD, OSD_STATE and storage changes toggle it', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], storage: { osdEnabled: false } });
  frame.tick();
  assert.equal(frame.body.children.length, 0);

  const onMessage = frame.runtimeListeners[0];
  onMessage({ type: 'OSD_STATE', enabled: true }, {}, () => {});
  assert.equal(frame.body.children.length, 1);

  frame.storageListeners[0]({ osdEnabled: { newValue: false } }, 'local');
  assert.equal(frame.body.children.length, 0);

  frame.storageListeners[0]({ osdEnabled: { newValue: true } }, 'sync'); // other area ignored
  assert.equal(frame.body.children.length, 0);
  frame.storageListeners[0]({ osdEnabled: { newValue: true } }, 'local');
  assert.equal(frame.body.children.length, 1);
});

function clickOsdClose(frame) {
  const button = frame.body.children[0].find('close');
  assert.ok(button);
  const click = button.listeners.find((l) => l.type === 'click').fn;
  let prevented = false;
  let stopped = false;
  click({ preventDefault: () => (prevented = true), stopPropagation: () => (stopped = true) });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
}

test('the OSD close button hides the HUD and turns detection off: writes osdEnabled=false and detectionEnabled=false', () => {
  const frame = createFrame({ videos: [new FakeVideo()] });
  frame.tick();
  assert.equal(frame.body.children.length, 1);
  clickOsdClose(frame);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.storageSet)), [{ detectionEnabled: false, osdEnabled: false }]);
  assert.equal(frame.body.children.length, 0);
  frame.tick();
  frame.tick();
  assert.equal(frame.body.children.length, 0, 'the idle HUD does not come back while osdEnabled is false');
});

test('after the OSD close button the frame is really off: no reports, timers, observer or rVFC', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  assert.ok(video.listeners.length > 0);
  const count = frame.sent.length;

  clickOsdClose(frame);
  await settle();
  assert.equal(reportTimers(frame).length, 0);
  assert.equal(frame.observers[0].connected, false);
  assert.equal(video.listeners.length, 0);
  assert.deepEqual(video.rvfcCancelled, [42]);
  assert.equal(frame.windowListeners.length, 0);
  assert.equal(frame.docListeners.length, 0);
  assert.equal(frame.body.children.length, 0);

  frame.tick();
  frame.tick();
  video.fire('resize');
  await settle();
  assert.equal(frame.sent.length, count);
  assert.equal(frame.body.children.length, 0);
});

test('after the OSD close button, detection resumes with detectionEnabled=true and the HUD needs osdEnabled=true', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  clickOsdClose(frame);
  await settle();
  const count = frame.sent.length;

  on(frame);
  assert.equal(reportTimers(frame).length, 1);
  frame.tick();
  play(video, 30, 300000);
  frame.tick();
  await settle();
  assert.ok(frame.sent.length > count);
  assert.equal(frame.last().payload.hasVideo, true);
  assert.equal(frame.body.children.length, 0, 'the x also persisted osdEnabled=false');

  frame.storageListeners[0]({ osdEnabled: { newValue: true } }, 'local');
  assert.equal(frame.body.children.length, 1);
});

test('the OSD close button echoed back through storage.onChanged is harmless', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  clickOsdClose(frame);
  await settle();
  assert.doesNotThrow(() => off(frame));
  frame.storageListeners[0]({ osdEnabled: { newValue: false } }, 'local');
  assert.equal(reportTimers(frame).length, 0);
  assert.equal(frame.body.children.length, 0);
  assert.deepEqual(video.rvfcCancelled, [42]);
});

test('if persisting the OSD close button fails, detection and the HUD come back', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], rejectSet: true });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  clickOsdClose(frame);
  assert.equal(reportTimers(frame).length, 0, 'off immediately, before the write result is known');
  assert.equal(frame.body.children.length, 0);
  await settle();
  assert.equal(reportTimers(frame).length, 1);
  assert.equal(frame.observers[frame.observers.length - 1].connected, true);
  assert.ok(video.listeners.length > 0);

  const count = frame.sent.length;
  frame.tick();
  play(video, 30, 300000);
  frame.tick();
  await settle();
  assert.ok(frame.sent.length > count);
  assert.equal(frame.body.children.length, 1);
});

test('the OSD close button title explains that detection stops and no longer mentions Alt+Shift+V', () => {
  const frame = createFrame({ videos: [new FakeVideo()] });
  frame.tick();
  const button = frame.body.children[0].find('close');
  assert.ok(button.title.includes('停止检测'));
  assert.ok(button.title.includes('检测画质'));
  assert.ok(button.title.includes('悬浮窗'));
  assert.equal(button.title.includes('Alt+Shift+V'), false);
});

test('fullscreen: OSD moves into a containing fullscreen element and hides for the video itself', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  assert.equal(frame.body.children.length, 1);

  const container = new FakeNode('div');
  container.appendChild(video);
  frame.doc.fullscreenElement = container;
  frame.docListeners.filter((l) => l.type === 'fullscreenchange').forEach((l) => l.fn());
  assert.equal(container.children.length, 2);
  assert.equal(frame.body.children.length, 0);

  frame.doc.fullscreenElement = video;
  frame.docListeners.filter((l) => l.type === 'fullscreenchange').forEach((l) => l.fn());
  assert.equal(container.children.length, 1); // only the video remains

  frame.doc.fullscreenElement = null;
  frame.docListeners.filter((l) => l.type === 'fullscreenchange').forEach((l) => l.fn());
  assert.equal(frame.body.children.length, 1);
});

test('GET_FRAME_STATE answers with the latest payload', () => {
  const frame = createFrame({ videos: [new FakeVideo()] });
  frame.tick();
  let response;
  frame.runtimeListeners[0]({ type: 'GET_FRAME_STATE' }, {}, (r) => (response = r));
  assert.equal(response.payload.hasVideo, true);
});

test('after the extension context is invalidated the script stops cleanly', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  const count = frame.sent.length;
  frame.sandbox.chrome.runtime.id = undefined;
  frame.tick();
  frame.tick();
  assert.equal(frame.sent.length, count);
  assert.equal(frame.body.children.length, 0);
  assert.deepEqual(video.rvfcCancelled, [42]);
});

test('a throwing chrome.runtime.sendMessage never escapes', () => {
  const frame = createFrame({ videos: [new FakeVideo()] });
  frame.sandbox.chrome.runtime.sendMessage = () => {
    throw new Error('Extension context invalidated.');
  };
  assert.doesNotThrow(() => frame.tick());
});

/** A fake shadow host whose open root contains the given videos. */
function fakeShadowHost(rootVideos) {
  const host = { isConnected: true, shadowRoot: null };
  host.shadowRoot = {
    host,
    querySelectorAll: (sel) => (sel === 'video' ? rootVideos.filter((v) => v.isConnected) : []),
  };
  return host;
}

test('videos inside open shadow roots are found without re-walking the DOM every tick', () => {
  const inner = new FakeVideo();
  const host = fakeShadowHost([inner]);
  const frame = createFrame({ videos: [], elements: [host] });
  assert.equal(frame.stats.starQueries, 1); // the first scan walks once

  frame.tick();
  assert.equal(frame.last().payload.hasVideo, true);
  frame.tick();
  frame.tick();
  frame.tick();
  assert.equal(frame.stats.starQueries, 1);
});

test('SHADOW_ROOT_CREATED triggers a walk, at most once per 2 seconds', () => {
  const frame = createFrame({ videos: [], elements: [] });
  const handler = frame.windowListeners.find((l) => l.type === 'message').fn;
  const created = () =>
    handler({ source: frame.win, data: { source: '__VQI_MAIN__', type: 'SHADOW_ROOT_CREATED' } });
  frame.tick();
  frame.tick();
  frame.tick(); // clock 4000, last walk at 1000
  assert.equal(frame.stats.starQueries, 1);

  created();
  frame.tick(); // 5000: walk allowed
  assert.equal(frame.stats.starQueries, 2);

  created();
  frame.tick(); // 6000: only 1000 ms since the last walk, deferred
  assert.equal(frame.stats.starQueries, 2);
  frame.tick(); // 7000: the pending walk runs
  assert.equal(frame.stats.starQueries, 3);
  frame.tick();
  assert.equal(frame.stats.starQueries, 3);

  // Messages with a foreign source never trigger a walk.
  handler({ source: frame.win, data: { source: 'page', type: 'SHADOW_ROOT_CREATED' } });
  frame.tick();
  frame.tick();
  assert.equal(frame.stats.starQueries, 3);
});

test('a blob source without a captured codec is reported as unknown, not as a direct stream', () => {
  // 1080p at about 1000 kbps would be rated low for H.264, but the codec could be AV1.
  const video = new FakeVideo({ currentSrc: 'blob:https://video.example.com/abc' });
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 30, 125000);
  frame.tick();
  const p = frame.last().payload;
  assert.equal(p.codec, '未知编码');
  assert.equal(p.codecKnown, false);
  assert.equal(p.bitrateKbps, 1000);
  assert.equal(p.evaluation.qualityLevel, 'unknown');
  assert.match(frame.osdText(), /未知编码/);

  // A captured codec makes the rating definite again.
  const handler = frame.windowListeners.find((l) => l.type === 'message').fn;
  handler({
    source: frame.win,
    data: { source: '__VQI_MAIN__', type: 'CODEC_DETECTED', payload: { mimeType: 'video/mp4; codecs="avc1.64002a"' } },
  });
  assert.equal(frame.last().payload.codecKnown, true);
  assert.equal(frame.last().payload.evaluation.qualityLevel, 'low');
});

test('a new media item keeps the previous fps until its first sample (no 0 FPS flash)', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  assert.equal(frame.last().payload.fps, 60);

  video.fire('emptied');
  assert.equal(frame.last().payload.fps, 60);
  video.fire('loadstart');
  assert.equal(frame.last().payload.fps, 60);

  play(video, 24, 240000);
  frame.tick();
  assert.equal(frame.last().payload.fps, 24);
});

test('only the frame that background elected draws the OSD', async () => {
  let owner = true;
  const frame = createFrame({ videos: [new FakeVideo()], reply: () => ({ osdOwner: owner }) });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  frame.tick();
  await settle();
  assert.equal(frame.body.children.length, 1);

  owner = false;
  frame.tick();
  await settle();
  assert.equal(frame.body.children.length, 0);
  assert.equal(frame.last().payload.hasVideo, true); // metrics keep flowing

  owner = true;
  frame.tick();
  await settle();
  assert.equal(frame.body.children.length, 1);
});

// ---------------------------------------------------------------------------
// Detection master switch (chrome.storage.local `detectionEnabled`)
// ---------------------------------------------------------------------------

const settle = () => new Promise((resolve) => setImmediate(resolve));
const off = (frame) => frame.storageListeners[0]({ detectionEnabled: { newValue: false } }, 'local');
const on = (frame) => frame.storageListeners[0]({ detectionEnabled: { newValue: true } }, 'local');

test('detectionEnabled=false: no report timer, observer, rVFC, message or listener; idle HUD only', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], storage: { detectionEnabled: false } });
  frame.tick();
  frame.tick();
  await settle();

  assert.equal(reportTimers(frame).length, 0);
  assert.equal(idleTimers(frame).length, 1);
  assert.equal(frame.stats.observersCreated, 0);
  assert.equal(video.rvfcRequests || 0, 0);
  assert.equal(video.listeners.length, 0);
  assert.equal(frame.sent.length, 0);
  assert.equal(frame.posted.length, 0);
  assert.equal(frame.body.children.length, 1);
  assert.equal(frame.osdText().includes('检测已关闭'), true);
  assert.equal(frame.windowListeners.length, 0);
  assert.equal(frame.docListeners.length, 0);
  assert.equal(frame.stats.starQueries, 0);
  // The permanent listeners stay so the flag can be turned on again.
  assert.equal(frame.runtimeListeners.length, 1);
  assert.equal(frame.storageListeners.length, 1);
});

test('detection is on by default and a stored true behaves the same', () => {
  const byDefault = createFrame({ videos: [new FakeVideo()] });
  assert.equal(byDefault.intervals.length, 1);
  const stored = createFrame({ videos: [new FakeVideo()], storage: { detectionEnabled: true } });
  assert.equal(stored.intervals.length, 1);
  assert.equal(stored.stats.observersCreated, 1);
});

test('turning detection off stops reports, detaches the video, cancels rVFC and keeps the idle OSD', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  assert.equal(frame.body.children.length, 1);
  assert.ok(video.listeners.length > 0);
  const count = frame.sent.length;

  off(frame);
  assert.equal(reportTimers(frame).length, 0);
  assert.equal(frame.observers[0].connected, false);
  assert.equal(video.listeners.length, 0);
  assert.deepEqual(video.rvfcCancelled, [42]);
  assert.equal(frame.body.children.length, 1);
  assert.equal(frame.osdText().includes('检测已关闭'), true);
  assert.equal(frame.windowListeners.length, 0);
  assert.equal(frame.docListeners.length, 0);

  // Late events and a stray interval callback do nothing.
  frame.tick();
  frame.tick();
  video.fire('resize');
  await settle();
  assert.equal(frame.sent.length, count);
  assert.equal(frame.body.children.length, 1);
});

test('turning detection off twice is harmless', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  off(frame);
  assert.doesNotThrow(() => off(frame));
  assert.deepEqual(video.rvfcCancelled, [42]);
});

test('turning detection on again resumes reporting, re-attaches and asks for the codec, no reload', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  off(frame);
  frame.posted.length = 0;
  const count = frame.sent.length;

  on(frame);
  assert.equal(reportTimers(frame).length, 1);
  assert.equal(idleTimers(frame).length, 0);
  assert.equal(frame.stats.observersCreated, 2);
  assert.ok(video.listeners.length > 0);
  assert.ok(video.rvfc, 'a new rVFC loop is running');
  assert.deepEqual(
    JSON.parse(JSON.stringify(frame.posted)),
    [{ source: '__VQI_ISO__', type: 'REQUEST_CODEC' }]
  );
  assert.equal(frame.windowListeners.filter((l) => l.type === 'message').length, 1);

  frame.tick(); // baseline of the new state
  play(video, 30, 300000);
  frame.tick();
  assert.ok(frame.sent.length > count);
  assert.equal(frame.last().payload.hasVideo, true);
  assert.equal(frame.last().payload.fps, 30);
  assert.equal(frame.body.children.length, 1);
});

test('re-enabling does not double count frames from the old rVFC loop', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  const oldLoop = video.rvfc;
  off(frame);
  on(frame);
  frame.tick();
  oldLoop(); // a callback that was already queued must not count
  play(video, 30, 300000);
  frame.tick();
  assert.equal(frame.last().payload.fps, 30);
});

test('the top frame announces itself again after re-enabling, and shadow roots are walked again', () => {
  const inner = new FakeVideo();
  const host = { isConnected: true, shadowRoot: null };
  host.shadowRoot = { host, querySelectorAll: (sel) => (sel === 'video' ? [inner] : []) };
  const frame = createFrame({ videos: [], elements: [host] });
  frame.tick();
  assert.equal(frame.last().payload.hasVideo, true);
  assert.equal(frame.stats.starQueries, 1);

  off(frame);
  frame.sent.length = 0;
  on(frame);
  assert.equal(frame.stats.starQueries, 2);
  frame.tick();
  assert.equal(frame.last().payload.hasVideo, true);
  assert.equal(inner.listeners.length > 0, true);
});

test('a storage change before the initial read finishes wins', async () => {
  const frame = createFrame({ videos: [new FakeVideo()], holdGet: true });
  assert.equal(frame.intervals.length, 0); // nothing starts before the answer
  assert.equal(frame.stats.observersCreated, 0);

  off(frame);
  frame.releaseGet(); // the stored answer says enabled, but it is older
  assert.equal(reportTimers(frame).length, 0);
  assert.equal(frame.stats.observersCreated, 0);
  assert.equal(frame.osdText().includes('检测已关闭'), true);

  const second = createFrame({ videos: [new FakeVideo()], holdGet: true, storage: { detectionEnabled: false } });
  on(second);
  second.releaseGet(); // stored false is older than the change to true
  assert.equal(reportTimers(second).length, 1);
  assert.equal(idleTimers(second).length, 0);
  assert.equal(second.body.children.length, 0);
});

test('nothing is detected before the initial read answers, then it starts', () => {
  const frame = createFrame({ videos: [new FakeVideo()], holdGet: true });
  assert.equal(frame.intervals.length, 0);
  assert.equal(frame.sent.length, 0);
  frame.releaseGet();
  assert.equal(frame.intervals.length, 1);
});

test('without chrome.storage the script defaults to detection on', () => {
  const frame = createFrame({ videos: [new FakeVideo()], noStorage: true });
  assert.equal(frame.intervals.length, 1);
});

test('a failing storage read defaults to detection on', () => {
  const frame = createFrame({ videos: [new FakeVideo()], throwingGet: true });
  assert.equal(frame.intervals.length, 1);
  const withError = createFrame({ videos: [new FakeVideo()], lastError: true, storage: { detectionEnabled: false } });
  assert.equal(withError.intervals.length, 1);
});

test('detectionEnabled changes in other storage areas are ignored', () => {
  const frame = createFrame({ videos: [new FakeVideo()] });
  frame.storageListeners[0]({ detectionEnabled: { newValue: false } }, 'sync');
  frame.storageListeners[0]({ detectionEnabled: { newValue: false } }, 'session');
  assert.equal(reportTimers(frame).length, 1);
  assert.equal(frame.observers[0].connected, true);

  const disabled = createFrame({ videos: [new FakeVideo()], storage: { detectionEnabled: false } });
  disabled.storageListeners[0]({ detectionEnabled: { newValue: true } }, 'sync');
  assert.equal(reportTimers(disabled).length, 0);
});

test('a removed detectionEnabled value (newValue undefined) means enabled again', () => {
  const frame = createFrame({ videos: [new FakeVideo()], storage: { detectionEnabled: false } });
  frame.storageListeners[0]({ detectionEnabled: {} }, 'local');
  assert.equal(frame.intervals.length, 1);
});

test('the OSD switch keeps working in both modes', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  assert.equal(frame.body.children.length, 1);
  frame.storageListeners[0]({ osdEnabled: { newValue: false } }, 'local');
  assert.equal(frame.body.children.length, 0);

  off(frame);
  assert.equal(frame.body.children.length, 0); // osdEnabled is false: no idle HUD either
  frame.runtimeListeners[0]({ type: 'OSD_STATE', enabled: true }, {}, () => {});
  assert.equal(frame.body.children.length, 1); // the idle HUD shows at once

  on(frame);
  frame.tick();
  assert.equal(frame.body.children.length, 1);
  assert.equal(frame.osdText().includes('检测已关闭'), false);
});

test('a late metrics response after turning detection off cannot change the OSD owner', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const frame = createFrame({ videos: [new FakeVideo()], reply: () => gate.then(() => ({ osdOwner: false })) });
  frame.tick();
  off(frame);
  on(frame);
  release();
  await settle();
  frame.tick();
  assert.equal(frame.body.children.length, 1); // owner stayed unknown (allowed)
});

test('GET_FRAME_STATE has no answer while detection is off', () => {
  const frame = createFrame({ videos: [new FakeVideo()] });
  frame.tick();
  off(frame);
  let response;
  frame.runtimeListeners[0]({ type: 'GET_FRAME_STATE' }, {}, (r) => (response = r));
  assert.equal(response, undefined);
});

test('a permanent shutdown stays permanent: re-enabling does not restart a stopped script', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  frame.sandbox.chrome.runtime.id = undefined;
  frame.tick(); // shutdown
  assert.equal(frame.intervals.length, 0);
  off(frame);
  on(frame);
  assert.equal(frame.intervals.length, 0);
  assert.equal(frame.stats.observersCreated, 1);
});

test('onNewMedia restarts the FPS window, so a mid-window loadstart is not under-counted', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  assert.equal(frame.last().payload.fps, 60);

  frame.clock.t += 500; // half a second into the next window
  video.fire('loadstart');
  play(video, 60, 600000);
  frame.tick(); // one second after the loadstart: 60 frames in 1000 ms
  assert.equal(frame.last().payload.fps, 60);
});

// ---------------------------------------------------------------------------
// Idle HUD (detection off) and the HUD detection toggle
// ---------------------------------------------------------------------------

function clickHud(frame, className) {
  const button = frame.body.children[0].find(className);
  assert.ok(button, className + ' button exists');
  const click = button.listeners.find((l) => l.type === 'click').fn;
  click({ preventDefault() {}, stopPropagation() {} });
}

/** What the user sees in the HUD: text, dot colour, paused tag, button label. */
function hudView(frame) {
  const host = frame.body.children[0];
  if (!host) return null;
  return JSON.stringify({
    text: host.find('text').textContent,
    dot: host.find('dot').style.background,
    tagHidden: host.find('tag').hidden,
    toggle: host.find('toggle').textContent,
    css: host.style.cssText,
  });
}

const IDLE_TEXT = '检测已关闭';

test('detection off via storage keeps the HUD with idle text, gray dot and a button to turn detection on', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  assert.equal(frame.body.children[0].find('toggle').textContent, '暂停');
  assert.ok(frame.osdText().includes('fps'));

  off(frame);
  assert.equal(frame.body.children.length, 1);
  const host = frame.body.children[0];
  assert.equal(host.find('text').textContent, IDLE_TEXT);
  assert.equal(host.find('dot').style.background, '#9ca3af');
  assert.equal(host.find('tag').hidden, true);
  assert.equal(host.find('toggle').textContent, '开启');
  assert.ok(host.find('toggle').title.includes('开启'));
  assert.equal(frame.osdText().includes('fps'), false);
});

test('while detection is off nothing in the HUD changes and nothing is sent', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], reply: () => gate.then(() => ({ osdOwner: false })) });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  const staleListeners = video.listeners.slice();
  const staleLoop = video.rvfc;
  const count = frame.sent.length;

  off(frame);
  const before = hudView(frame);
  frame.posted.length = 0;

  // Late answer of a report that was in flight, stale video events and a stale rVFC callback.
  release();
  await settle();
  staleListeners.forEach((l) => l.fn({ target: video }));
  assert.ok(staleLoop);
  staleLoop();
  // The video keeps changing, the clock advances and every timer fires.
  video.paused = true;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.total += 500;
  video.webkitVideoDecodedByteCount += 9000000;
  for (let i = 0; i < 5; i++) frame.tick();
  await settle();

  assert.equal(hudView(frame), before);
  assert.equal(frame.sent.length, count);
  assert.equal(frame.posted.length, 0);
  assert.equal(frame.observers[0].connected, false);
  assert.equal(video.listeners.length, 0);
  assert.equal(reportTimers(frame).length, 0);
});

test('a metrics answer that arrives after detection was turned off is ignored', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const frame = createFrame({ videos: [new FakeVideo()], reply: () => gate.then(() => ({ osdOwner: false })) });
  frame.tick();
  off(frame);
  release();
  await settle();
  assert.equal(frame.body.children.length, 1, 'osdOwner=false must not remove the idle HUD');
  assert.equal(frame.osdText().includes(IDLE_TEXT), true);
});

test('clicking the HUD toggle while detecting writes detectionEnabled=false, stops everything and keeps the HUD', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  const count = frame.sent.length;

  clickHud(frame, 'toggle');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(frame.storageSet)), [{ detectionEnabled: false }]);
  assert.equal(reportTimers(frame).length, 0);
  assert.equal(frame.observers[0].connected, false);
  assert.equal(video.listeners.length, 0);
  assert.deepEqual(video.rvfcCancelled, [42]);
  assert.equal(frame.body.children.length, 1);
  assert.equal(frame.body.children[0].find('text').textContent, IDLE_TEXT);
  assert.equal(frame.body.children[0].find('toggle').textContent, '开启');
  frame.tick();
  assert.equal(frame.sent.length, count);
});

test('clicking the HUD toggle while off writes detectionEnabled=true and detection resumes with metrics', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], storage: { detectionEnabled: false } });
  assert.equal(frame.body.children[0].find('text').textContent, IDLE_TEXT);

  clickHud(frame, 'toggle');
  assert.deepEqual(JSON.parse(JSON.stringify(frame.storageSet)), [{ detectionEnabled: true }]);
  assert.equal(reportTimers(frame).length, 1);
  assert.equal(idleTimers(frame).length, 0);
  assert.equal(frame.body.children.length, 1);
  assert.equal(frame.osdText().includes('fps'), false, 'no stale or invented metrics before the first report');
  assert.equal(frame.body.children[0].find('toggle').textContent, '暂停');

  frame.tick();
  play(video, 30, 300000);
  frame.tick();
  await settle();
  assert.equal(frame.last().payload.hasVideo, true);
  assert.ok(frame.osdText().includes('30 fps'));
  assert.equal(frame.body.children[0].find('toggle').textContent, '暂停');
});

test('a rejected toggle write rolls back', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], rejectSet: true });
  frame.tick();
  clickHud(frame, 'toggle');
  assert.equal(reportTimers(frame).length, 0);
  await settle();
  assert.equal(reportTimers(frame).length, 1);
  assert.equal(frame.observers[frame.observers.length - 1].connected, true);

  const idle = createFrame({ videos: [new FakeVideo()], rejectSet: true, storage: { detectionEnabled: false } });
  clickHud(idle, 'toggle');
  assert.equal(reportTimers(idle).length, 1);
  await settle();
  assert.equal(reportTimers(idle).length, 0);
  assert.equal(idle.body.children[0].find('text').textContent, IDLE_TEXT);
});

test('a rejected toggle write does not roll back when a newer storage change arrived', async () => {
  const frame = createFrame({ videos: [new FakeVideo()], rejectSet: true });
  frame.tick();
  clickHud(frame, 'toggle'); // off, write pending
  off(frame); // another surface wrote detectionEnabled=false meanwhile
  await settle();
  assert.equal(reportTimers(frame).length, 0);
  assert.equal(frame.body.children[0].find('text').textContent, IDLE_TEXT);

  const second = createFrame({ videos: [new FakeVideo()], rejectSet: true });
  second.tick();
  clickHud(second, 'toggle'); // off, write pending
  on(second); // the popup switched it back on meanwhile
  off(second); // and off again
  await settle();
  assert.equal(reportTimers(second).length, 0);
});

test('a rejected write of the x button restores the HUD even when detection stays as the newer change says', async () => {
  const frame = createFrame({ videos: [new FakeVideo()], rejectSet: true });
  frame.tick();
  clickOsdClose(frame);
  off(frame);
  await settle();
  assert.equal(reportTimers(frame).length, 0);
  assert.equal(frame.body.children.length, 1, 'osdEnabled rolled back, idle HUD visible');
  assert.equal(frame.osdText().includes(IDLE_TEXT), true);
});

test('a page loaded with detectionEnabled=false shows the idle HUD after the read and never detects', async () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], holdGet: true, storage: { detectionEnabled: false } });
  assert.equal(frame.body.children.length, 0, 'nothing before the stored answer');
  assert.equal(frame.intervals.length, 0);
  frame.releaseGet();
  assert.equal(frame.body.children.length, 1);
  assert.equal(frame.osdText().includes(IDLE_TEXT), true);
  frame.tick();
  frame.tick();
  await settle();
  assert.equal(frame.sent.length, 0);
  assert.equal(frame.posted.length, 0);
  assert.equal(frame.stats.observersCreated, 0);
  assert.equal(video.rvfcRequests || 0, 0);
  assert.equal(video.listeners.length, 0);
});

test('an osdEnabled storage change before the slow initial read wins', () => {
  const frame = createFrame({ videos: [new FakeVideo()], holdGet: true, storage: { detectionEnabled: false, osdEnabled: false } });
  frame.storageListeners[0]({ osdEnabled: { newValue: true } }, 'local');
  frame.releaseGet(); // stored osdEnabled=false is older
  assert.equal(frame.body.children.length, 1);
});

test('osdEnabled=false hides the idle HUD and turning it on shows it', () => {
  const frame = createFrame({ videos: [new FakeVideo()], storage: { detectionEnabled: false, osdEnabled: false } });
  frame.tick();
  assert.equal(frame.body.children.length, 0);
  frame.storageListeners[0]({ osdEnabled: { newValue: true } }, 'local');
  assert.equal(frame.body.children.length, 1);
  frame.runtimeListeners[0]({ type: 'OSD_STATE', enabled: false }, {}, () => {});
  assert.equal(frame.body.children.length, 0);
  frame.runtimeListeners[0]({ type: 'OSD_STATE', enabled: true }, {}, () => {});
  assert.equal(frame.body.children.length, 1);
});

test('a permanent shutdown removes the idle HUD and its timer', () => {
  const frame = createFrame({ videos: [new FakeVideo()], storage: { detectionEnabled: false } });
  assert.equal(frame.body.children.length, 1);
  assert.equal(idleTimers(frame).length, 1);
  frame.sandbox.chrome.runtime.id = undefined;
  frame.tick(); // the idle timer notices the invalidated context
  assert.equal(frame.body.children.length, 0);
  assert.equal(frame.intervals.length, 0);
  frame.tick();
  assert.equal(frame.body.children.length, 0);
});

test('the idle HUD needs a sizable video in this frame', () => {
  const none = createFrame({ videos: [], storage: { detectionEnabled: false } });
  none.tick();
  assert.equal(none.body.children.length, 0);

  const small = new FakeVideo({ rect: { width: 100, height: 50, top: 10, bottom: 60, left: 10, right: 110 } });
  const frame = createFrame({ videos: [small], storage: { detectionEnabled: false } });
  frame.tick();
  assert.equal(frame.body.children.length, 0);

  small.rect = { width: 640, height: 360, top: 10, bottom: 370, left: 10, right: 650 };
  frame.tick();
  assert.equal(frame.body.children.length, 1);

  small.isConnected = false;
  frame.tick();
  assert.equal(frame.body.children.length, 0);
});

test('the video that carried the HUD stays the idle anchor even when it is small', () => {
  const small = new FakeVideo({ rect: { width: 120, height: 60, top: 10, bottom: 70, left: 10, right: 130 } });
  const frame = createFrame({ videos: [small] });
  frame.tick();
  assert.equal(frame.body.children.length, 1);
  off(frame);
  assert.equal(frame.body.children.length, 1);
  frame.tick();
  assert.equal(frame.body.children.length, 1);
});

test('the idle HUD follows a playing video over a larger paused one', () => {
  const paused = new FakeVideo({ paused: true, rect: { width: 960, height: 540, top: 100, bottom: 640, left: 100, right: 1060 } });
  const playing = new FakeVideo({ rect: { width: 480, height: 270, top: 300, bottom: 570, left: 100, right: 580 } });
  const frame = createFrame({ videos: [paused, playing], storage: { detectionEnabled: false } });
  assert.ok(frame.body.children[0].style.cssText.includes('top:316px'));
  playing.paused = true;
  paused.paused = false;
  frame.tick();
  assert.ok(frame.body.children[0].style.cssText.includes('top:116px'));
});

test('the idle HUD hides while the video itself is fullscreen and returns afterwards', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], storage: { detectionEnabled: false } });
  assert.equal(frame.body.children.length, 1);
  frame.doc.fullscreenElement = video;
  frame.tick();
  assert.equal(frame.body.children.length, 0);
  frame.doc.fullscreenElement = null;
  frame.tick();
  assert.equal(frame.body.children.length, 1);
});

test('the HUD toggle does not run any detection work in idle mode (no star queries, no rVFC)', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video], storage: { detectionEnabled: false } });
  for (let i = 0; i < 5; i++) frame.tick();
  assert.equal(frame.stats.starQueries, 0);
  assert.equal(video.rvfcRequests || 0, 0);
  assert.equal(frame.windowListeners.length, 0);
  assert.equal(frame.docListeners.length, 0);
});

test('an osdEnabled change or OSD_STATE before the startup read never shows the idle HUD while detection is stored on', () => {
  const frame = createFrame({ videos: [new FakeVideo()], holdGet: true, storage: { detectionEnabled: true } });
  frame.storageListeners[0]({ osdEnabled: { newValue: true } }, 'local');
  frame.runtimeListeners[0]({ type: 'OSD_STATE', enabled: true }, {}, () => {});
  frame.tick();
  assert.equal(frame.body.children.length, 0, 'no idle HUD before the stored detection flag is known');
  assert.equal(idleTimers(frame).length, 0);
  frame.releaseGet();
  frame.tick();
  assert.equal(frame.osdText() === null || !frame.osdText().includes(IDLE_TEXT), true);
  assert.equal(idleTimers(frame).length, 0);
  assert.equal(reportTimers(frame).length, 1);
});

test('the idle timer runs only while osdEnabled is true', () => {
  const frame = createFrame({ videos: [new FakeVideo()] });
  frame.tick();
  clickOsdClose(frame); // detection off and OSD off
  assert.equal(frame.body.children.length, 0);
  assert.equal(frame.intervals.length, 0, 'no interval remains after the x button');

  frame.storageListeners[0]({ osdEnabled: { newValue: true } }, 'local');
  assert.equal(idleTimers(frame).length, 1);
  assert.equal(frame.body.children.length, 1);
  frame.runtimeListeners[0]({ type: 'OSD_STATE', enabled: false }, {}, () => {});
  assert.equal(frame.intervals.length, 0);
  assert.equal(frame.body.children.length, 0);

  const stored = createFrame({ videos: [new FakeVideo()], storage: { detectionEnabled: false, osdEnabled: false } });
  assert.equal(stored.intervals.length, 0, 'page loaded with both off keeps no timer');
});

// ---------------------------------------------------------------------------
// HUD info lines: audio, download rate
// ---------------------------------------------------------------------------

/** Delivers a message from content_main.js (MAIN world) to the isolated script. */
function fromMain(frame, type, payload) {
  const handler = frame.windowListeners.find((l) => l.type === 'message').fn;
  handler({ source: frame.win, data: { source: '__VQI_MAIN__', type, payload } });
}

function lineText(frame, className) {
  const row = frame.body.children[0].find(className);
  return { text: row.find('value').textContent, hidden: row.hidden };
}

test('HUD shows three rows: video, audio and rate, in the format of the request', () => {
  const video = new FakeVideo({ currentSrc: 'blob:https://v.example.com/a' });
  const frame = createFrame({ videos: [video] });
  frame.tick();
  fromMain(frame, 'CODEC_DETECTED', { mimeType: 'video/mp4; codecs="avc1.64002a"' });
  fromMain(frame, 'AUDIO_DETECTED', { mimeType: 'audio/mp4; codecs="mp4a.40.2"' });
  fromMain(frame, 'AUDIO_INFO', { sampleRate: 48000, channels: 2 });
  play(video, 25, 89000);
  frame.tick();

  assert.equal(lineText(frame, 'line-video').text, 'H.264 · 1920×1080 · 25 fps');
  assert.equal(lineText(frame, 'line-audio').text, 'AAC · 48 kHz · 2.0');
  assert.equal(lineText(frame, 'line-audio').hidden, false);
  assert.match(lineText(frame, 'line-rate').text, /^码率 \d+ kb\/s$/);
});

test('HUD hides the audio row while nothing is known about the audio', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 30, 300000);
  frame.tick();
  assert.equal(lineText(frame, 'line-audio').hidden, true);
  assert.equal(frame.last().payload.audioCodec, '');
  assert.equal(frame.last().payload.audioSampleRate, 0);
  assert.equal(frame.last().payload.audioChannels, 0);
});

test('payload carries the audio codec, sample rate and channels', () => {
  const video = new FakeVideo({ currentSrc: 'blob:https://v.example.com/a' });
  const frame = createFrame({ videos: [video] });
  frame.tick();
  fromMain(frame, 'AUDIO_DETECTED', { mimeType: 'audio/webm; codecs="opus"' });
  fromMain(frame, 'AUDIO_INFO', { sampleRate: 48000, channels: 6 });
  frame.tick();
  const p = frame.last().payload;
  assert.equal(p.audioCodec, 'Opus');
  assert.equal(p.audioSampleRate, 48000);
  assert.equal(p.audioChannels, 6);
  assert.equal(lineText(frame, 'line-audio').text, 'Opus · 48 kHz · 5.1');
});

test('a new audio codec clears the sample rate and channels of the previous stream', () => {
  const video = new FakeVideo({ currentSrc: 'blob:https://v.example.com/a' });
  const frame = createFrame({ videos: [video] });
  frame.tick();
  fromMain(frame, 'AUDIO_DETECTED', { mimeType: 'audio/mp4; codecs="mp4a.40.2"' });
  fromMain(frame, 'AUDIO_INFO', { sampleRate: 48000, channels: 2 });
  fromMain(frame, 'AUDIO_DETECTED', { mimeType: 'audio/webm; codecs="opus"' });
  const p = frame.last().payload;
  assert.equal(p.audioCodec, 'Opus');
  assert.equal(p.audioSampleRate, 0);
  assert.equal(lineText(frame, 'line-audio').text, 'Opus');
});

test('invalid AUDIO_INFO / MEDIA_STATS / AUDIO_DETECTED values are ignored', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  fromMain(frame, 'AUDIO_INFO', { sampleRate: 0, channels: 2 });
  fromMain(frame, 'AUDIO_INFO', { sampleRate: 'x', channels: -1 });
  fromMain(frame, 'AUDIO_DETECTED', { mimeType: 5 });
  fromMain(frame, 'AUDIO_DETECTED', { mimeType: 'video/mp4; codecs="avc1.64002a"' });
  fromMain(frame, 'MEDIA_STATS', { totalBytes: 'abc' });
  fromMain(frame, 'MEDIA_STATS', { totalBytes: -5 });
  frame.tick();
  const p = frame.last().payload;
  assert.equal(p.audioCodec, '');
  assert.equal(p.audioSampleRate, 0);
  assert.equal(p.downloadBps, null);
});

test('download rate is the growth of the appended bytes over the last seconds', () => {
  const video = new FakeVideo({ currentSrc: 'blob:https://v.example.com/a' });
  const frame = createFrame({ videos: [video] });
  frame.tick();
  assert.equal(frame.last().payload.downloadBps, null, 'unknown without MEDIA_STATS');
  assert.equal(lineText(frame, 'line-rate').text.includes('下载'), false);

  let total = 0;
  for (let i = 0; i < 5; i++) {
    total += 753000;
    fromMain(frame, 'MEDIA_STATS', { totalBytes: total });
    play(video, 25, 89000);
    frame.tick();
  }
  assert.equal(frame.last().payload.downloadBps, 753000);
  assert.match(lineText(frame, 'line-rate').text, /^码率 \d+ kb\/s · 下载 753 KB\/s$/);

  // The player stops downloading: the rate falls to 0 within the window, not stuck at the old value.
  for (let i = 0; i < 5; i++) {
    play(video, 25, 89000);
    frame.tick();
  }
  assert.equal(frame.last().payload.downloadBps, 0);
  assert.match(lineText(frame, 'line-rate').text, /下载 0 B\/s$/);
});

test('a counter that goes backwards (page reset) does not produce a negative or huge rate', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  fromMain(frame, 'MEDIA_STATS', { totalBytes: 5000000 });
  frame.tick();
  fromMain(frame, 'MEDIA_STATS', { totalBytes: 100 });
  frame.tick();
  const speed = frame.last().payload.downloadBps;
  assert.ok(speed === null || speed >= 0, String(speed));
});

test('turning detection off and on forgets audio information and the download counter', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  fromMain(frame, 'AUDIO_DETECTED', { mimeType: 'audio/mp4; codecs="mp4a.40.2"' });
  fromMain(frame, 'AUDIO_INFO', { sampleRate: 48000, channels: 2 });
  fromMain(frame, 'MEDIA_STATS', { totalBytes: 1000000 });
  frame.tick();
  assert.equal(frame.last().payload.audioCodec, 'AAC');

  off(frame);
  on(frame);
  frame.tick();
  const p = frame.last().payload;
  assert.equal(p.audioCodec, '');
  assert.equal(p.downloadBps, null);
});

test('idle HUD shows only the neutral text: the three rows are hidden', () => {
  const video = new FakeVideo();
  const frame = createFrame({ videos: [video] });
  frame.tick();
  play(video, 60, 600000);
  frame.tick();
  off(frame);
  const host = frame.body.children[0];
  assert.equal(host.find('line-video').hidden, true);
  assert.equal(host.find('line-audio').hidden, true);
  assert.equal(host.find('line-rate').hidden, true);
  assert.equal(host.find('text').hidden, false);
  assert.equal(host.find('text').textContent, '检测已关闭');
});

test('HUD only uses textContent for page derived strings and builds icons with createElementNS', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code));
});
