'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makePayload(overrides) {
  return Object.assign(
    {
      hasVideo: true,
      isPlaying: true,
      isIframe: false,
      displayArea: 921600,
      width: 1920,
      height: 1080,
      fps: 60,
      bitrateKbps: 4850,
      codec: 'H.264 (AVC)',
      evaluation: {
        label: '1080P 蓝光 60帧',
        badgeText: '1080',
        badgeColor: '#059669',
        qualityLevel: 'high',
        qualityText: '高码率 / 真蓝光',
      },
    },
    overrides || {}
  );
}

/** Runs background.js in a vm with a fake chrome API and manual timers. */
async function createWorker(options) {
  const opts = options || {};
  const listeners = {};
  const badge = { text: [], color: [], textColor: [] };
  const sent = [];
  const timers = [];
  const cleared = [];
  let releaseLocalGet = () => {};
  const localGate = opts.holdLocalGet ? new Promise((resolve) => (releaseLocalGet = resolve)) : null;
  const store = { local: Object.assign({}, opts.local), session: Object.assign({}, opts.session) };
  const sandbox = {};

  const event = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  sandbox.chrome = {
    runtime: { onMessage: event('runtime.onMessage') },
    tabs: {
      onRemoved: event('tabs.onRemoved'),
      onUpdated: event('tabs.onUpdated'),
      query: async () => opts.activeTabs || [{ id: 7 }],
      sendMessage: async (tabId, message) => {
        sent.push({ tabId, message });
      },
    },
    commands: { onCommand: event('commands.onCommand') },
    action: {
      setBadgeText: async (arg) => badge.text.push(arg),
      setBadgeBackgroundColor: async (arg) => badge.color.push(arg),
      setBadgeTextColor: async (arg) => badge.textColor.push(arg),
    },
    storage: {
      onChanged: event('storage.onChanged'),
      local: {
        get: async (defaults) => {
          const snapshot = Object.assign({}, defaults, store.local);
          if (localGate) await localGate; // the answer is read now but delivered late
          return snapshot;
        },
        set: async (items) => {
          // Like Chrome, report the change to the listener (area 'local').
          const changes = {};
          Object.keys(items).forEach((key) => {
            changes[key] = { oldValue: store.local[key], newValue: items[key] };
          });
          Object.assign(store.local, items);
          if (listeners['storage.onChanged']) listeners['storage.onChanged'](changes, 'local');
        },
      },
      session: {
        get: async (key) => (key in store.session ? { [key]: store.session[key] } : {}),
        set: async (items) => Object.assign(store.session, items),
      },
    },
  };
  sandbox.importScripts = (file) => {
    if (opts.importFails) throw new Error('import failed');
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox);
  };
  sandbox.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  sandbox.clearTimeout = (id) => cleared.push(id);
  sandbox.Date = opts.Date || Date;
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  if (!opts.holdLocalGet) await flush();

  const send = async (payload, tabId, frameId, documentId) => {
    listeners['runtime.onMessage'](
      { type: 'VIDEO_METRICS_UPDATE', payload },
      { tab: { id: tabId }, frameId, documentId }
    );
    await flush();
  };
  const getState = async (tabId) => {
    let response;
    const returned = listeners['runtime.onMessage'](
      { type: 'GET_TAB_STATE', tabId },
      {},
      (r) => (response = r)
    );
    assert.equal(returned, true);
    await flush();
    return response;
  };
  return { listeners, badge, sent, timers, cleared, store, send, getState, sandbox, releaseLocalGet };
}

test('a metrics update sets the badge text and color for the tab', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0);

  assert.equal(w.badge.text.length, 1);
  assert.equal(w.badge.text[0].tabId, 7);
  assert.equal(w.badge.text[0].text, '1080');
  assert.equal(w.badge.color[0].color, '#059669');
  assert.equal(w.badge.textColor[0].color, '#FFFFFF');
});

test('identical updates do not repeat badge API calls', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0);
  await w.send(makePayload(), 7, 0);
  await w.send(makePayload(), 7, 0);
  assert.equal(w.badge.text.length, 1);
  assert.equal(w.badge.color.length, 1);
});

test('GET_TAB_STATE returns the elected best frame and all frames', async () => {
  const w = await createWorker();
  // Main page: large but paused. Iframe: small and playing. Playing wins.
  await w.send(makePayload({ isPlaying: false, displayArea: 2000000, isIframe: false }), 7, 0);
  await w.send(
    makePayload({
      isIframe: true,
      displayArea: 90000,
      evaluation: { badgeText: '720', badgeColor: '#0284C7', label: 'x', qualityLevel: 'medium', qualityText: '标准' },
    }),
    7,
    3
  );

  const state = await w.getState(7);
  assert.equal(state.hasVideo, true);
  assert.equal(state.best.frameId, 3);
  assert.equal(state.best.isIframe, true);
  assert.equal(state.best.payload.evaluation.badgeText, '720');
  assert.equal(state.frames.length, 2);
  assert.equal(state.frames.filter((f) => f.isBest).length, 1);
  assert.equal(w.badge.text[w.badge.text.length - 1].text, '720');
});

test('between two playing frames the larger display area wins', async () => {
  const w = await createWorker();
  await w.send(makePayload({ displayArea: 1000 }), 7, 0);
  await w.send(makePayload({ displayArea: 5000 }), 7, 1);
  const state = await w.getState(7);
  assert.equal(state.best.frameId, 1);
});

test('hasVideo:false removes the frame and clears the badge', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0);
  await w.send({ hasVideo: false }, 7, 0);

  const state = await w.getState(7);
  assert.equal(state.hasVideo, false);
  assert.equal(state.best, null);
  assert.deepEqual(JSON.parse(JSON.stringify(state.frames)), []);
  assert.equal(w.badge.text[w.badge.text.length - 1].text, '');
});

test('entries older than 5 seconds are pruned', async () => {
  let offset = 0;
  const realNow = Date.now.bind(Date);
  class FakeDate extends Date {
    static now() {
      return realNow() + offset;
    }
  }
  const w = await createWorker({ Date: FakeDate });
  await w.send(makePayload(), 7, 0);
  assert.equal((await w.getState(7)).hasVideo, true);

  offset = 5100;
  const state = await w.getState(7);
  assert.equal(state.hasVideo, false);
  assert.equal(w.badge.text[w.badge.text.length - 1].text, '');
});

test('tabs.onRemoved deletes the tab state', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0);
  w.listeners['tabs.onRemoved'](7);
  assert.equal((await w.getState(7)).hasVideo, false);
});

test('tabs.onUpdated: a top-level navigation (loading with url) clears frames', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0);

  w.listeners['tabs.onUpdated'](7, { url: 'https://example.com/#hash' }); // same-document change
  w.listeners['tabs.onUpdated'](7, { status: 'loading' }); // iframe or reload: data kept
  w.listeners['tabs.onUpdated'](7, { status: 'complete' });
  assert.equal((await w.getState(7)).hasVideo, true);

  w.listeners['tabs.onUpdated'](7, { status: 'loading', url: 'https://example.com/next' });
  assert.equal((await w.getState(7)).hasVideo, false);
});

test('a subframe load (loading without url) does not drop the video of the tab', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0);
  w.listeners['tabs.onUpdated'](7, { status: 'loading' });
  const state = await w.getState(7);
  assert.equal(state.hasVideo, true);
  assert.equal(w.badge.text[w.badge.text.length - 1].text, '1080');
});

test('badge cache is invalidated on loading, complete and the delayed reconcile', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0);
  assert.equal(w.badge.text.length, 1);

  // Old page heartbeat arrives after "loading", then Chrome resets the badge at commit.
  w.listeners['tabs.onUpdated'](7, { status: 'loading', url: 'https://example.com/next' });
  await w.send(makePayload(), 7, 0);
  assert.equal(w.badge.text.length, 2); // cache was dropped, so the badge is applied again

  // The new page reports the same tier: "complete" forces a re-apply.
  w.listeners['tabs.onUpdated'](7, { status: 'complete' });
  assert.equal(w.badge.text.length, 3);
  assert.equal(w.badge.text[2].text, '1080');

  // The delayed reconcile also re-applies the badge.
  w.timers.filter((t) => t.ms === 1500).forEach((t) => t.fn());
  assert.ok(w.badge.text.length >= 4);
});

test('metrics responses tell only the elected frame to draw the OSD', async () => {
  const w = await createWorker();
  const reply = async (payload, frameId) => {
    let response;
    w.listeners['runtime.onMessage'](
      { type: 'VIDEO_METRICS_UPDATE', payload },
      { tab: { id: 7 }, frameId },
      (r) => (response = r)
    );
    await flush();
    return response;
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await reply(makePayload({ displayArea: 1000 }), 0))), { osdOwner: true });
  assert.equal((await reply(makePayload({ displayArea: 5000 }), 3)).osdOwner, true);
  assert.equal((await reply(makePayload({ displayArea: 1000 }), 0)).osdOwner, false);
  assert.equal((await reply({ hasVideo: false }, 3)).osdOwner, false);
  assert.equal((await reply(makePayload({ displayArea: 1000 }), 0)).osdOwner, true);
});

test('messages without a tab (for example from the popup) are ignored', async () => {
  const w = await createWorker();
  await w.send(makePayload(), undefined, 0);
  w.listeners['runtime.onMessage']({ type: 'VIDEO_METRICS_UPDATE', payload: makePayload() }, {});
  await flush();
  assert.equal(w.badge.text.length, 0);
});

test('toggle-osd flips osdEnabled and broadcasts to the active tab', async () => {
  const w = await createWorker({ activeTabs: [{ id: 11 }] });
  await w.listeners['commands.onCommand']('toggle-osd');
  assert.equal(w.store.local.osdEnabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(w.sent)), [
    { tabId: 11, message: { type: 'OSD_STATE', enabled: false } },
  ]);

  await w.listeners['commands.onCommand']('toggle-osd');
  assert.equal(w.store.local.osdEnabled, true);
  assert.equal(w.sent[1].message.enabled, true);

  await w.listeners['commands.onCommand']('something-else');
  assert.equal(w.sent.length, 2);
});

test('state is mirrored to storage.session and restored by a new worker', async () => {
  const first = await createWorker();
  await first.send(makePayload(), 7, 2);
  // Run the debounced persist timer.
  first.timers.forEach((t) => t.fn());
  await flush();
  assert.ok(first.store.session.vqi_tab_frames['7']['2']);

  const second = await createWorker({ session: JSON.parse(JSON.stringify(first.store.session)) });
  const state = await second.getState(7);
  assert.equal(state.hasVideo, true);
  assert.equal(state.best.frameId, 2);
});

test('works with the inline election fallback when the import fails', async () => {
  const w = await createWorker({ importFails: true });
  await w.send(makePayload({ isPlaying: false, displayArea: 2000000 }), 7, 0);
  await w.send(makePayload({ isPlaying: true, displayArea: 10 }), 7, 1);
  const state = await w.getState(7);
  assert.equal(state.best.frameId, 1);
});

test('a new documentId for frame 0 drops the subframe entries of the previous page', async () => {
  const w = await createWorker();
  await w.send(makePayload({ displayArea: 1000 }), 7, 0, 'doc-A');
  await w.send(makePayload({ displayArea: 9000, evaluation: { badgeText: '720', badgeColor: '#0284C7' } }), 7, 4, 'sub-1');
  assert.equal((await w.getState(7)).best.frameId, 4);

  // The same top document keeps everything (subframe-only loads do not change it).
  await w.send(makePayload({ displayArea: 1000 }), 7, 0, 'doc-A');
  assert.equal((await w.getState(7)).frames.length, 2);

  // Navigation without any changeInfo.url: frame 0 reports from a new document.
  await w.send(makePayload({ displayArea: 1000 }), 7, 0, 'doc-B');
  const state = await w.getState(7);
  assert.equal(state.frames.length, 1);
  assert.equal(state.best.frameId, 0);
  assert.equal(w.badge.text[w.badge.text.length - 1].text, '1080');
});

test('a new top document without a video clears the old page data', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 3, 'sub-1');
  await w.send({ hasVideo: false }, 7, 0, 'doc-A'); // announcement of page A
  assert.equal((await w.getState(7)).hasVideo, true);

  await w.send({ hasVideo: false }, 7, 0, 'doc-B'); // announcement of page B
  const state = await w.getState(7);
  assert.equal(state.hasVideo, false);
  assert.equal(w.badge.text[w.badge.text.length - 1].text, '');
});

test('subframe reports and missing documentIds never clear data', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0, 'doc-A');
  await w.send(makePayload(), 7, 2, 'sub-1');
  await w.send(makePayload(), 7, 2, 'sub-2'); // a subframe reloaded: frame 0 unchanged
  await w.send(makePayload(), 7, 0); // no documentId available
  assert.equal((await w.getState(7)).frames.length, 2);
});

test('an entry that missed about two heartbeats no longer owns the tab', async () => {
  let offset = 0;
  const realNow = Date.now.bind(Date);
  class FakeDate extends Date {
    static now() {
      return realNow() + offset;
    }
  }
  const w = await createWorker({ Date: FakeDate });
  await w.send(makePayload({ displayArea: 9000 }), 7, 3); // owner frame, then it vanishes silently
  offset = 3500;
  const reply = await (async () => {
    let response;
    w.listeners['runtime.onMessage'](
      { type: 'VIDEO_METRICS_UPDATE', payload: makePayload({ displayArea: 100 }) },
      { tab: { id: 7 }, frameId: 0 },
      (r) => (response = r)
    );
    await flush();
    return response;
  })();
  assert.equal(reply.osdOwner, true);
  assert.equal((await w.getState(7)).best.frameId, 0);
});

// ---------------------------------------------------------------------------
// Detection master switch (chrome.storage.local `detectionEnabled`)
// ---------------------------------------------------------------------------

/** Sends a report and returns the response object of the worker. */
async function report(w, payload, tabId, frameId) {
  let response;
  w.listeners['runtime.onMessage'](
    { type: 'VIDEO_METRICS_UPDATE', payload },
    { tab: { id: tabId }, frameId },
    (r) => (response = r)
  );
  await flush();
  return response;
}

test('a report while detection is off returns {} and stores nothing', async () => {
  const w = await createWorker({ local: { detectionEnabled: false } });
  const response = await report(w, makePayload(), 7, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {});
  assert.equal('osdOwner' in response, false);
  assert.equal(w.badge.text.length, 0);
  const state = await w.getState(7);
  assert.equal(state.hasVideo, false);
  assert.equal(state.frames.length, 0);
});

test('GET_TAB_STATE reports detectionEnabled false while off and true otherwise', async () => {
  const off = await createWorker({ local: { detectionEnabled: false } });
  const stateOff = await off.getState(7);
  assert.deepEqual(JSON.parse(JSON.stringify(stateOff)), {
    hasVideo: false,
    best: null,
    frames: [],
    detectionEnabled: false,
  });

  const on = await createWorker();
  await on.send(makePayload(), 7, 0);
  const stateOn = await on.getState(7);
  assert.equal(stateOn.detectionEnabled, true);
  assert.equal(stateOn.hasVideo, true);
});

test('turning detection off clears tab state, badges and the session mirror', async () => {
  const w = await createWorker({ activeTabs: [{ id: 7 }, { id: 9 }] });
  await w.send(makePayload(), 7, 0, 'doc-A');
  await w.send(makePayload(), 8, 0);
  w.timers.forEach((t) => t.fn()); // persist the state once
  await flush();
  assert.ok(w.store.session.vqi_tab_frames['7']);
  w.badge.text.length = 0;
  w.timers.length = 0; // only timers scheduled by the switch itself may persist from here

  await w.sandbox.chrome.storage.local.set({ detectionEnabled: false });
  await flush();

  const cleared = w.badge.text.filter((b) => b.text === '').map((b) => b.tabId).sort();
  assert.deepEqual(cleared, [7, 8, 9]); // known tabs plus the one only chrome.tabs.query knows
  assert.equal((await w.getState(7)).hasVideo, false);

  w.timers.forEach((t) => t.fn()); // persist timer
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(w.store.session.vqi_tab_frames)), {});
});

test('turning detection off cancels the pending prune timer', async () => {
  const w = await createWorker();
  await w.send(makePayload(), 7, 0);
  const prune = w.timers.find((t) => t.ms === 2000);
  assert.ok(prune);
  await w.sandbox.chrome.storage.local.set({ detectionEnabled: false });
  await flush();
  // A cleared timer must not run: simulate the worker honoring clearTimeout.
  assert.ok(w.cleared.includes(w.timers.indexOf(prune) + 1));
});

test('a worker started with detection off does not restore the session state', async () => {
  const first = await createWorker();
  await first.send(makePayload(), 7, 2);
  first.timers.forEach((t) => t.fn());
  await flush();
  const session = JSON.parse(JSON.stringify(first.store.session));
  assert.ok(session.vqi_tab_frames['7']);

  const off = await createWorker({ session, local: { detectionEnabled: false } });
  assert.equal((await off.getState(7)).hasVideo, false);
  assert.equal(off.badge.text.length, 0);
  // Nothing was restored in the background either: it stays empty after turning on.
  await off.sandbox.chrome.storage.local.set({ detectionEnabled: true });
  await flush();
  assert.equal((await off.getState(7)).hasVideo, false);

  const on = await createWorker({ session });
  assert.equal((await on.getState(7)).hasVideo, true);
});

test('turning detection back on accepts reports again', async () => {
  const w = await createWorker({ local: { detectionEnabled: false } });
  assert.deepEqual(JSON.parse(JSON.stringify(await report(w, makePayload(), 7, 0))), {});

  await w.sandbox.chrome.storage.local.set({ detectionEnabled: true });
  await flush();
  const response = await report(w, makePayload(), 7, 0);
  assert.equal(response.osdOwner, true);
  assert.equal(w.badge.text[w.badge.text.length - 1].text, '1080');
  assert.equal((await w.getState(7)).hasVideo, true);
});

test('only the local area and the detectionEnabled key change the switch', async () => {
  const w = await createWorker();
  w.listeners['storage.onChanged']({ detectionEnabled: { newValue: false } }, 'sync');
  w.listeners['storage.onChanged']({ osdEnabled: { newValue: false } }, 'local');
  assert.equal((await report(w, makePayload(), 7, 0)).osdOwner, true);
});

test('a change that arrives before the initial read finishes wins', async () => {
  const w = await createWorker({ local: { detectionEnabled: true }, holdLocalGet: true });
  // The stored value (true) is already read but not delivered when the change comes in.
  w.listeners['storage.onChanged']({ detectionEnabled: { newValue: false } }, 'local');
  w.releaseLocalGet();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(await report(w, makePayload(), 7, 0))), {});
});

test('toggle-osd still flips only osdEnabled while detection is off', async () => {
  const w = await createWorker({ local: { detectionEnabled: false }, activeTabs: [{ id: 11 }] });
  await w.listeners['commands.onCommand']('toggle-osd');
  assert.equal(w.store.local.osdEnabled, false);
  assert.equal(w.store.local.detectionEnabled, false);
});
