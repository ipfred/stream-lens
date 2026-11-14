'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'content_main.js'), 'utf8');

/**
 * Builds a fake page global with MediaSource, SourceBuffer, Element and a
 * recording postMessage, then runs content_main.js inside it.
 */
function createPage(options) {
  const opts = options || {};
  const posted = [];
  const listeners = [];
  const calls = { addSourceBuffer: [], attachShadow: [] };
  const sandbox = {};

  class MediaSource {
    addSourceBuffer(mime) {
      calls.addSourceBuffer.push(mime);
      if (opts.addSourceBufferThrows) throw new Error('NotSupportedError');
      return { fake: 'sourceBuffer', mime };
    }
  }
  class SourceBuffer {
    changeType(mime) {
      calls.changeType = mime;
    }
  }
  class Element {
    attachShadow(init) {
      calls.attachShadow.push(init);
      if (opts.openThrows && init && init.mode === 'open') throw new Error('open refused');
      return { fake: 'shadowRoot', mode: init && init.mode };
    }
  }

  sandbox.MediaSource = MediaSource;
  sandbox.SourceBuffer = SourceBuffer;
  sandbox.Element = Element;
  sandbox.window = sandbox;
  sandbox.postMessage = (message, target) => {
    if (opts.postMessageThrows) throw new Error('postMessage failed');
    posted.push({ message, target });
  };
  sandbox.addEventListener = (type, fn) => listeners.push({ type, fn });
  const timers = [];
  if (opts.withTimers) sandbox.setTimeout = (fn, ms) => timers.push({ fn, ms });
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  return { sandbox, posted, listeners, timers, calls, MediaSource, SourceBuffer, Element };
}

const VIDEO_MIME = 'video/mp4; codecs="avc1.64002a"';

test('addSourceBuffer: original result is returned and a video MIME is reported', () => {
  const page = createPage();
  const ms = new page.MediaSource();
  const result = ms.addSourceBuffer(VIDEO_MIME);

  assert.equal(result.fake, 'sourceBuffer');
  assert.equal(result.mime, VIDEO_MIME);
  assert.deepEqual(page.calls.addSourceBuffer, [VIDEO_MIME]);
  assert.equal(page.posted.length, 1);
  const msg = page.posted[0].message;
  assert.equal(page.posted[0].target, '*');
  assert.equal(msg.source, '__VQI_MAIN__');
  assert.equal(msg.type, 'CODEC_DETECTED');
  assert.equal(msg.payload.mimeType, VIDEO_MIME);
  assert.equal(typeof msg.payload.timestamp, 'number');
});

test('addSourceBuffer: audio-only MIME is reported as AUDIO_DETECTED, never as a video codec', () => {
  const page = createPage();
  const ms = new page.MediaSource();
  ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  ms.addSourceBuffer('audio/webm; codecs="opus"');
  assert.deepEqual(page.posted.map((p) => p.message.type), ['AUDIO_DETECTED', 'AUDIO_DETECTED']);
  assert.equal(page.posted[0].message.payload.mimeType, 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(page.calls.addSourceBuffer.length, 2);
});

test('addSourceBuffer: combined video+audio and other video codecs are reported', () => {
  const page = createPage();
  const ms = new page.MediaSource();
  ms.addSourceBuffer('video/mp4; codecs="avc1.4d401f, mp4a.40.2"');
  ms.addSourceBuffer('video/webm; codecs="vp09.00.10.08"');
  ms.addSourceBuffer('video/mp4; codecs="av01.0.05M.08"');
  const types = page.posted.map((p) => p.message.type);
  assert.equal(types.filter((t) => t === 'CODEC_DETECTED').length, 3);
  // The muxed one also carries an audio codec.
  assert.equal(types.filter((t) => t === 'AUDIO_DETECTED').length, 1);
});

test('addSourceBuffer: a throwing postMessage does not break the page', () => {
  const page = createPage({ postMessageThrows: true });
  const ms = new page.MediaSource();
  let result;
  assert.doesNotThrow(() => {
    result = ms.addSourceBuffer(VIDEO_MIME);
  });
  assert.equal(result.fake, 'sourceBuffer');
});

test('addSourceBuffer: errors of the original method still reach the page', () => {
  const page = createPage({ addSourceBufferThrows: true });
  const ms = new page.MediaSource();
  assert.throws(() => ms.addSourceBuffer(VIDEO_MIME), /NotSupportedError/);
  assert.equal(page.posted.length, 0);
});

test('changeType: a quality switch to a video type is reported', () => {
  const page = createPage();
  const sb = new page.SourceBuffer();
  sb.changeType('video/webm; codecs="vp9"');
  assert.equal(page.calls.changeType, 'video/webm; codecs="vp9"');
  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].message.payload.mimeType, 'video/webm; codecs="vp9"');
});

test('wrapper keeps a native looking toString and name', () => {
  const page = createPage();
  const text = page.MediaSource.prototype.addSourceBuffer.toString();
  assert.match(text, /addSourceBuffer/);
  assert.equal(page.MediaSource.prototype.addSourceBuffer.name, 'addSourceBuffer');
});

test('attachShadow: closed mode is forced to open without mutating the caller object', () => {
  const page = createPage();
  const el = new page.Element();
  const init = { mode: 'closed', delegatesFocus: true };
  const root = el.attachShadow(init);

  assert.equal(root.mode, 'open');
  assert.equal(init.mode, 'closed');
  assert.equal(page.calls.attachShadow.length, 1);
  assert.equal(page.calls.attachShadow[0].mode, 'open');
  assert.equal(page.calls.attachShadow[0].delegatesFocus, true);
});

test('attachShadow: open mode passes through unchanged', () => {
  const page = createPage();
  const root = new page.Element().attachShadow({ mode: 'open' });
  assert.equal(root.mode, 'open');
  assert.equal(page.calls.attachShadow.length, 1);
});

test('attachShadow: falls back to the original arguments when the open call throws', () => {
  const page = createPage({ openThrows: true });
  const el = new page.Element();
  const root = el.attachShadow({ mode: 'closed' });

  assert.equal(root.mode, 'closed');
  assert.equal(page.calls.attachShadow.length, 2);
  assert.equal(page.calls.attachShadow[0].mode, 'open');
  assert.equal(page.calls.attachShadow[1].mode, 'closed');
});

test('REQUEST_CODEC replays the latest codec message', () => {
  const page = createPage();
  new page.MediaSource().addSourceBuffer(VIDEO_MIME);
  assert.equal(page.posted.length, 1);

  const handler = page.listeners.find((l) => l.type === 'message').fn;
  const win = vm.runInContext('window', page.sandbox);
  handler({ source: win, data: { source: '__VQI_ISO__', type: 'REQUEST_CODEC' } });
  assert.equal(page.posted.length, 2);
  assert.equal(page.posted[1].message.payload.mimeType, VIDEO_MIME);

  // Messages from other windows or with another source are ignored.
  handler({ source: {}, data: { source: '__VQI_ISO__', type: 'REQUEST_CODEC' } });
  handler({ source: win, data: { source: 'other', type: 'REQUEST_CODEC' } });
  assert.equal(page.posted.length, 2);
});

test('double injection does not wrap the methods twice', () => {
  const page = createPage();
  vm.runInContext(SOURCE, page.sandbox);
  new page.MediaSource().addSourceBuffer(VIDEO_MIME);
  assert.equal(page.posted.length, 1);
});

test('attachShadow: a burst of shadow roots posts one coalesced SHADOW_ROOT_CREATED', () => {
  const page = createPage({ withTimers: true });
  const el = new page.Element();
  el.attachShadow({ mode: 'open' });
  el.attachShadow({ mode: 'closed' });
  el.attachShadow({ mode: 'open' });
  assert.equal(page.posted.length, 0);
  assert.equal(page.timers.length, 1);

  page.timers[0].fn();
  assert.equal(page.posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted[0].message)), {
    source: '__VQI_MAIN__',
    type: 'SHADOW_ROOT_CREATED',
  });

  el.attachShadow({ mode: 'open' }); // a later root notifies again
  assert.equal(page.timers.length, 2);
});

test('attachShadow: without a timer the notification is posted at once, and errors stay hidden', () => {
  const page = createPage();
  new page.Element().attachShadow({ mode: 'open' });
  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].message.type, 'SHADOW_ROOT_CREATED');

  const broken = createPage({ postMessageThrows: true });
  assert.doesNotThrow(() => new broken.Element().attachShadow({ mode: 'closed' }));
});

// ---------------------------------------------------------------------------
// appendBuffer: audio parameters from real init segments, and the appended byte counter
// (fixtures are the first 1 KB of ffmpeg generated fragmented MP4 / WebM files)
// ---------------------------------------------------------------------------

const FIXTURES = path.join(__dirname, 'fixtures');

function createAppendPage() {
  // A page with a SourceBuffer that has appendBuffer, plus MediaSource and Element like createPage.
  const sandbox = {};
  const posted = [];
  const listeners = [];
  const timers = [];
  class AppendableBuffer {
    appendBuffer(data) {
      return data;
    }
  }
  class FakeMediaSource {
    addSourceBuffer() {
      return {};
    }
  }
  class FakeElement {
    attachShadow() {
      return {};
    }
  }
  Object.assign(sandbox, {
    MediaSource: FakeMediaSource,
    Element: FakeElement,
    SourceBuffer: AppendableBuffer,
    ArrayBuffer,
    Uint8Array,
    DataView,
  });
  sandbox.window = sandbox;
  sandbox.postMessage = (message) => posted.push(message);
  sandbox.addEventListener = (type, fn) => listeners.push({ type, fn });
  sandbox.setTimeout = (fn, ms) => timers.push({ fn, ms });
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return {
    sandbox,
    posted,
    listeners,
    timers,
    MediaSource: FakeMediaSource,
    buffer: new AppendableBuffer(),
  };
}

function audioInfoOf(file) {
  const page = createAppendPage();
  const bytes = fs.readFileSync(path.join(FIXTURES, file));
  page.buffer.appendBuffer(new Uint8Array(bytes).buffer);
  const info = page.posted.find((m) => m.type === 'AUDIO_INFO');
  return info ? JSON.parse(JSON.stringify(info.payload)) : null;
}

test('appendBuffer: AAC init segments give the sample rate and channel count', () => {
  assert.deepEqual(audioInfoOf('init_aac.mp4'), { sampleRate: 48000, channels: 2 });
  assert.deepEqual(audioInfoOf('init_aac_mono44.mp4'), { sampleRate: 44100, channels: 1 });
});

test('appendBuffer: Opus WebM init segments give the sample rate and channel count', () => {
  assert.deepEqual(audioInfoOf('init_opus.webm'), { sampleRate: 48000, channels: 2 });
  assert.deepEqual(audioInfoOf('init_opus_mono.webm'), { sampleRate: 48000, channels: 1 });
});

test('appendBuffer: a typed array view is read with its own offset', () => {
  const page = createAppendPage();
  const bytes = fs.readFileSync(path.join(FIXTURES, 'init_aac.mp4'));
  const padded = new Uint8Array(bytes.length + 40);
  padded.set(bytes, 40);
  page.buffer.appendBuffer(new Uint8Array(padded.buffer, 40, bytes.length));
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted.find((m) => m.type === 'AUDIO_INFO').payload)), {
    sampleRate: 48000,
    channels: 2,
  });
});

test('appendBuffer: media segments, garbage and tiny buffers give no audio info and never throw', () => {
  const page = createAppendPage();
  const noise = new Uint8Array(4096).map((_, i) => (i * 31 + 7) & 0xff);
  const truncated = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'init_aac.mp4'))).subarray(0, 60);
  const lyingBox = new Uint8Array(32);
  lyingBox.set([0xff, 0xff, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76]); // moov claiming 4 GB
  for (const data of [noise, truncated, lyingBox, new Uint8Array(4), 'text', null, undefined, {}]) {
    assert.doesNotThrow(() => page.buffer.appendBuffer(data));
  }
  assert.equal(page.posted.filter((m) => m.type === 'AUDIO_INFO').length, 0);
});

test('appendBuffer: the original is called and its result returned unchanged', () => {
  const page = createAppendPage();
  const data = new Uint8Array(8);
  assert.equal(page.buffer.appendBuffer(data), data);
  assert.equal(page.sandbox.SourceBuffer.prototype.appendBuffer.toString().includes('appendBuffer'), true);
});

test('appendBuffer: appended bytes are summed and posted as MEDIA_STATS, coalesced by a timer', () => {
  const page = createAppendPage();
  page.buffer.appendBuffer(new Uint8Array(1000));
  page.buffer.appendBuffer(new Uint8Array(2500));
  assert.equal(page.posted.filter((m) => m.type === 'MEDIA_STATS').length, 0, 'nothing before the timer fires');
  assert.equal(page.timers.length, 1, 'one timer for the burst');
  page.timers[0].fn();
  const stats = page.posted.filter((m) => m.type === 'MEDIA_STATS');
  assert.equal(stats.length, 1);
  assert.equal(stats[0].payload.totalBytes, 3500);
  page.buffer.appendBuffer(new Uint8Array(500));
  page.timers[1].fn();
  assert.equal(page.posted.filter((m) => m.type === 'MEDIA_STATS').pop().payload.totalBytes, 4000);
});

test('audio MIME: AUDIO_DETECTED is replayed together with the audio info on REQUEST_CODEC', () => {
  const page = createAppendPage();
  new page.MediaSource().addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  page.buffer.appendBuffer(new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'init_aac.mp4'))).buffer);
  page.posted.length = 0;
  const handler = page.listeners.find((l) => l.type === 'message').fn;
  const win = vm.runInContext('window', page.sandbox);
  handler({ source: win, data: { source: '__VQI_ISO__', type: 'REQUEST_CODEC' } });
  const types = page.posted.map((m) => m.type).sort();
  assert.deepEqual(types, ['AUDIO_DETECTED', 'AUDIO_INFO', 'MEDIA_STATS']);
});

test('audio MIME: a new audio codec drops the audio info of the previous stream from the replay', () => {
  const page = createAppendPage();
  const ms = new page.MediaSource();
  ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  page.buffer.appendBuffer(new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'init_aac.mp4'))).buffer);
  ms.addSourceBuffer('audio/webm; codecs="opus"');
  page.posted.length = 0;
  const handler = page.listeners.find((l) => l.type === 'message').fn;
  handler({ source: vm.runInContext('window', page.sandbox), data: { source: '__VQI_ISO__', type: 'REQUEST_CODEC' } });
  assert.equal(page.posted.some((m) => m.type === 'AUDIO_INFO'), false);
  assert.equal(page.posted.find((m) => m.type === 'AUDIO_DETECTED').payload.mimeType, 'audio/webm; codecs="opus"');
});
