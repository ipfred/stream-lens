/**
 * background.js (MV3 service worker)
 *
 * Aggregates per-frame video metrics reported by content_isolated.js, elects the
 * best video of each tab, manages the action badge, and forwards the
 * toggle-osd command (PRD 4.4).
 *
 * State: tabFramesMap = Map<tabId, Map<frameId, { payload, updatedAt }>>.
 * The service worker can be stopped at any time, so the map is mirrored to
 * chrome.storage.session (debounced) and restored on startup. The content
 * scripts send a heartbeat every second, which also repopulates the map.
 *
 * There is no alarms permission, so stale entries are pruned lazily on every
 * message and with a setTimeout while the worker is alive.
 */
'use strict';

// utils/quality_evaluator.js has no window/document access, so it runs in a
// service worker and sets self.__VQI_EVAL__. Fall back to inline logic if the
// import fails for any reason.
try {
  importScripts('utils/quality_evaluator.js');
} catch (e) {
  // Handled by the inline fallbacks below.
}

const EVAL = globalThis.__VQI_EVAL__ || null;

const STALE_MS = 5000;
// An entry that missed about two heartbeats (1 s each) no longer counts for the
// election, so a frame that vanished silently stops owning the badge and the OSD
// before the 5 s prune removes it.
const ELECTION_FRESH_MS = 3000;
const PRUNE_INTERVAL_MS = 2000;
const PERSIST_DEBOUNCE_MS = 500;
const NAVIGATION_GRACE_MS = 1500;
const SESSION_KEY = 'vqi_tab_frames';
const DETECTION_KEY = 'detectionEnabled';

/** @type {Map<number, Map<number, {payload: object, updatedAt: number}>>} */
const tabFramesMap = new Map();
/** Last badge values applied per tab, to avoid redundant API calls. */
const badgeCache = new Map();
/**
 * documentId of the last top-level document (frameId 0) that reported, per tab.
 * A different id means a new top-level document (navigation or reload). It does not
 * need the tabs permission, unlike changeInfo.url in tabs.onUpdated.
 */
const topDocumentIds = new Map();

let pruneTimer = null;
let persistTimer = null;
/** Master switch (chrome.storage.local `detectionEnabled`). Updated by `ready` and onChanged. */
let detectionEnabled = true;
/** True once a storage change has set detectionEnabled, so a slower initial read cannot undo it. */
let detectionChanged = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Runs an extension API call and swallows both sync errors and rejections. */
function quiet(fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return result;
  } catch (e) {
    return undefined;
  }
}

/**
 * Same rule as electBest in utils/quality_evaluator.js: playing first, then the
 * larger displayArea. Used only if the shared file could not be imported.
 */
function inlineElectBest(entries) {
  let best = null;
  for (const entry of entries) {
    if (!entry || entry.hasVideo === false) continue;
    if (
      best === null ||
      (entry.isPlaying && !best.isPlaying) ||
      (!!entry.isPlaying === !!best.isPlaying && (entry.displayArea || 0) > (best.displayArea || 0))
    ) {
      best = entry;
    }
  }
  return best;
}

const electBest = EVAL && typeof EVAL.electBest === 'function' ? EVAL.electBest : inlineElectBest;

function isTabId(value) {
  return typeof value === 'number' && value >= 0 && Number.isInteger(value);
}

// ---------------------------------------------------------------------------
// Persistence (chrome.storage.session mirror)
// ---------------------------------------------------------------------------

function serializeState() {
  const out = {};
  tabFramesMap.forEach((frames, tabId) => {
    const frameObj = {};
    frames.forEach((entry, frameId) => {
      frameObj[frameId] = entry;
    });
    out[tabId] = frameObj;
  });
  return out;
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    quiet(() => chrome.storage.session.set({ [SESSION_KEY]: serializeState() }));
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Loads the master switch, then the mirrored state unless detection is off. Never
 * rejects; entries already in memory win.
 */
const ready = (async () => {
  try {
    const flags = await chrome.storage.local.get({ [DETECTION_KEY]: true });
    if (!detectionChanged) detectionEnabled = !flags || flags[DETECTION_KEY] !== false;
  } catch (e) {
    // Unreadable: keep the default (enabled).
  }
  if (!detectionEnabled) return;
  try {
    const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (!stored || typeof stored !== 'object') return;
    const cutoff = Date.now() - STALE_MS;
    for (const tabKey of Object.keys(stored)) {
      const tabId = Number(tabKey);
      if (!isTabId(tabId)) continue;
      const frames = stored[tabKey] || {};
      for (const frameKey of Object.keys(frames)) {
        const frameId = Number(frameKey);
        const entry = frames[frameKey];
        if (!Number.isInteger(frameId) || !entry || !entry.payload || entry.updatedAt < cutoff) continue;
        let map = tabFramesMap.get(tabId);
        if (!map) {
          map = new Map();
          tabFramesMap.set(tabId, map);
        }
        if (!map.has(frameId)) map.set(frameId, entry);
      }
    }
    tabFramesMap.forEach((_, tabId) => refreshTab(tabId));
  } catch (e) {
    // storage.session is unavailable or empty: start with an empty map.
  }
})();

// ---------------------------------------------------------------------------
// Election and badge
// ---------------------------------------------------------------------------

/** Removes frames that have not reported for STALE_MS. */
function pruneTab(tabId) {
  const frames = tabFramesMap.get(tabId);
  if (!frames) return;
  const cutoff = Date.now() - STALE_MS;
  frames.forEach((entry, frameId) => {
    if (entry.updatedAt < cutoff) frames.delete(frameId);
  });
  if (frames.size === 0) tabFramesMap.delete(tabId);
}

/** Returns { best, frames } for a tab after pruning. `best` is null without a video. */
function getTabState(tabId) {
  pruneTab(tabId);
  const frames = tabFramesMap.get(tabId);
  const list = [];
  if (frames) {
    frames.forEach((entry, frameId) => {
      list.push({ frameId, payload: entry.payload, updatedAt: entry.updatedAt });
    });
  }
  const freshCutoff = Date.now() - ELECTION_FRESH_MS;
  const candidates = list
    .filter((f) => f.updatedAt >= freshCutoff)
    .map((f) => ({
      hasVideo: f.payload.hasVideo !== false,
      isPlaying: !!f.payload.isPlaying,
      displayArea: f.payload.displayArea,
      frame: f,
    }));
  const elected = electBest(candidates);
  const bestFrame = elected ? elected.frame : null;
  return {
    hasVideo: !!bestFrame,
    best: bestFrame
      ? {
          payload: bestFrame.payload,
          frameId: bestFrame.frameId,
          isIframe: !!bestFrame.payload.isIframe,
          updatedAt: bestFrame.updatedAt,
        }
      : null,
    frames: list.map((f) => ({
      frameId: f.frameId,
      payload: f.payload,
      updatedAt: f.updatedAt,
      isBest: !!bestFrame && f.frameId === bestFrame.frameId,
    })),
  };
}

/** Applies badge text and color for a tab, skipping calls when nothing changed. */
function updateBadge(tabId, best) {
  const evaluation = best && best.payload && best.payload.evaluation;
  const text = (evaluation && evaluation.badgeText) || '';
  const color = (evaluation && evaluation.badgeColor) || '#6B7280';
  const prev = badgeCache.get(tabId);
  if (prev && prev.text === text && prev.color === color) return;
  badgeCache.set(tabId, { text, color });

  quiet(() => chrome.action.setBadgeText({ tabId, text }));
  if (text) {
    quiet(() => chrome.action.setBadgeBackgroundColor({ tabId, color }));
    if (typeof chrome.action.setBadgeTextColor === 'function') {
      quiet(() => chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }));
    }
  }
}

/** Prunes, elects, and updates the badge for one tab. */
function refreshTab(tabId) {
  if (!detectionEnabled) return { hasVideo: false, best: null, frames: [] };
  const state = getTabState(tabId);
  updateBadge(tabId, state.best);
  if (tabFramesMap.size > 0) schedulePrune();
  return state;
}

function schedulePrune() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    Array.from(tabFramesMap.keys()).forEach(refreshTab);
    persistSoon();
  }, PRUNE_INTERVAL_MS);
}

function clearTab(tabId) {
  tabFramesMap.delete(tabId);
  persistSoon();
}

/**
 * Detects a new top-level document from the documentId of frame 0 reports and drops
 * the entries of all other frames, which belong to the previous page. Frames of the
 * new page that already reported are dropped too, and send their next heartbeat
 * within a second. Subframe-only loads never change the documentId of frame 0, so
 * valid data is kept in that case.
 */
function trackTopDocument(tabId, frameId, sender) {
  if (frameId !== 0) return;
  const documentId = sender && typeof sender.documentId === 'string' ? sender.documentId : null;
  if (!documentId) return;
  const previous = topDocumentIds.get(tabId);
  topDocumentIds.set(tabId, documentId);
  if (previous && previous !== documentId) {
    const frames = tabFramesMap.get(tabId);
    if (frames) {
      frames.forEach((_, id) => {
        if (id !== 0) frames.delete(id);
      });
    }
    badgeCache.delete(tabId);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function handleMetricsUpdate(message, sender) {
  // Detection is off: store nothing and send no osdOwner, so frames keep their OSD state.
  if (!detectionEnabled) return {};
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!isTabId(tabId)) return null;
  const frameId = sender && Number.isInteger(sender.frameId) ? sender.frameId : 0;
  const payload = message.payload;
  if (!payload || typeof payload !== 'object') return null;
  trackTopDocument(tabId, frameId, sender);

  if (payload.hasVideo === false) {
    const frames = tabFramesMap.get(tabId);
    if (frames) {
      frames.delete(frameId);
      if (frames.size === 0) tabFramesMap.delete(tabId);
    }
  } else {
    let frames = tabFramesMap.get(tabId);
    if (!frames) {
      frames = new Map();
      tabFramesMap.set(tabId, frames);
    }
    frames.set(frameId, { payload, updatedAt: Date.now() });
  }
  const state = refreshTab(tabId);
  persistSoon();
  // Only the frame that holds the elected video of the tab draws the OSD.
  return { osdOwner: !!state.best && state.best.frameId === frameId };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === 'VIDEO_METRICS_UPDATE') {
      // Wait for the restore so it cannot overwrite fresh data. The response tells
      // the frame whether it owns the tab's OSD (see handleMetricsUpdate).
      ready.then(() => {
        let result = null;
        try {
          result = handleMetricsUpdate(message, sender);
        } catch (e) {
          // Ignore malformed messages.
        }
        try {
          if (typeof sendResponse === 'function') sendResponse(result || {});
        } catch (e) {
          // The frame may be gone.
        }
      });
      return true; // asynchronous response
    }

    if (message.type === 'GET_TAB_STATE') {
      const tabId = message.tabId;
      ready.then(() => {
        try {
          const state = isTabId(tabId) ? refreshTab(tabId) : { hasVideo: false, best: null, frames: [] };
          sendResponse(Object.assign({}, state, { detectionEnabled }));
        } catch (e) {
          // The popup may have closed.
        }
      });
      return true; // asynchronous response
    }
  } catch (e) {
    // Never let a bad message break the worker.
  }
  return false;
});

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
  badgeCache.delete(tabId);
  topDocumentIds.delete(tabId);
});

/**
 * Navigation handling.
 *
 * Same-document navigations (hash change, history.pushState in SPAs such as YouTube
 * or Bilibili) only report a url change, so valid data is kept.
 *
 * The tab status also flips to 'loading' when an iframe loads, and with only the
 * storage + activeTab permissions changeInfo.url is usually not populated. So the
 * main mechanism does not depend on it: trackTopDocument() drops stale frame data when
 * frame 0 reports a new documentId. Here, frame data is dropped only when the event
 * does carry a url (a top-level navigation); otherwise it is kept, so subframe loads
 * never wipe valid data. Entries of frames that are gone expire after STALE_MS.
 *
 * Chrome resets per-tab badge values when a navigation commits, which can happen
 * after an old-page heartbeat already refilled the cache. So the cache is dropped
 * on 'loading' and 'complete', and again before the delayed reconcile. The badge
 * itself is not touched on 'loading', which avoids flicker for iframe loads.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    if (changeInfo.url) clearTab(tabId);
    badgeCache.delete(tabId);
    setTimeout(() => {
      badgeCache.delete(tabId);
      refreshTab(tabId);
    }, NAVIGATION_GRACE_MS);
  } else if (changeInfo.status === 'complete') {
    badgeCache.delete(tabId);
    refreshTab(tabId);
  }
});

// ---------------------------------------------------------------------------
// Master switch
// ---------------------------------------------------------------------------

/** Drops all tab state and clears the badge of every known tab. */
function disableDetection() {
  const tabIds = new Set();
  tabFramesMap.forEach((_, tabId) => tabIds.add(tabId));
  badgeCache.forEach((_, tabId) => tabIds.add(tabId));
  tabFramesMap.clear();
  badgeCache.clear();
  topDocumentIds.clear();
  if (pruneTimer) {
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }
  persistSoon(); // mirrors the now empty map
  const clearBadge = (tabId) => quiet(() => chrome.action.setBadgeText({ tabId, text: '' }));
  tabIds.forEach(clearBadge);
  // Tabs that were badged before a worker restart are in neither map.
  try {
    const result = chrome.tabs.query({});
    if (result && typeof result.then === 'function') {
      result
        .then((tabs) => {
          (tabs || []).forEach((tab) => {
            if (isTabId(tab.id) && !tabIds.has(tab.id)) clearBadge(tab.id);
          });
        })
        .catch(() => {});
    }
  } catch (e) {
    // Ignore query failures.
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  try {
    if (area !== 'local' || !changes || !changes[DETECTION_KEY]) return;
    const enabled = changes[DETECTION_KEY].newValue !== false;
    detectionChanged = true;
    if (enabled === detectionEnabled) return;
    detectionEnabled = enabled;
    // Turning on needs nothing else: the content scripts repopulate the state.
    if (!enabled) disableDetection();
  } catch (e) {
    // Ignore.
  }
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-osd') return;
  try {
    const stored = await chrome.storage.local.get({ osdEnabled: true });
    const enabled = stored.osdEnabled === false; // flip: previously off means on now
    await chrome.storage.local.set({ osdEnabled: enabled });
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    for (const tab of tabs) {
      if (!isTabId(tab.id)) continue;
      // No frameId: every frame of the tab receives the message.
      quiet(() => chrome.tabs.sendMessage(tab.id, { type: 'OSD_STATE', enabled }));
    }
  } catch (e) {
    // Restricted pages (chrome://, Web Store) cannot receive messages.
  }
});
