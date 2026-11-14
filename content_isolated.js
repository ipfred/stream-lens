/**
 * content_isolated.js (ISOLATED world, document_idle, all frames)
 *
 * Loaded after utils/quality_evaluator.js, which provides globalThis.__VQI_EVAL__.
 *
 * Sections (PRD 4.2):
 *   A. Discovery: find <video> in the document and in open shadow roots, pick the main video.
 *      The cheap `video` query runs on every rescan. The expensive walk over every element
 *      (to find shadow roots) runs only when content_main.js reports a new shadow root, plus
 *      a slow periodic pass for roots that never go through attachShadow (declarative DOM).
 *   B. Per-video stats: FPS (requestVideoFrameCallback), bitrate (decoded byte delta,
 *      3 sample sliding average), drop rate, state resets, cleanup.
 *   C. Codec: CODEC_DETECTED messages from content_main.js, fallback to the URL suffix.
 *   D. Reporting: VIDEO_METRICS_UPDATE to background.js every 1000ms.
 *   E. OSD HUD: closed Shadow DOM overlay, fullscreen aware, toggled by storage / messages.
 *      It stays visible when detection is off (idle HUD without any metric) and carries a
 *      button that switches detection on and off.
 *
 * Every entry point is wrapped in try/catch so the host page is never affected.
 */
(function () {
  'use strict';

  var EVAL = globalThis.__VQI_EVAL__;
  if (!EVAL) return;

  // Guard against double injection into the same frame.
  if (globalThis.__VQI_ISOLATED_STARTED__) return;
  globalThis.__VQI_ISOLATED_STARTED__ = true;

  var REPORT_INTERVAL_MS = 1000;
  var RESCAN_DEBOUNCE_MS = 250;
  var SHADOW_WALK_MIN_MS = 2000; // minimum gap between two full element walks
  var SHADOW_WALK_PERIODIC_MS = 30000; // safety net for declarative shadow roots
  var BITRATE_WINDOW = 3; // samples (3 seconds at 1 sample per second)
  var DOWNLOAD_WINDOW = 4; // samples, i.e. the download rate is averaged over 3 seconds
  var MAX_SHADOW_DEPTH = 8;
  var MAIN_SOURCE = '__VQI_MAIN__';
  var ISO_SOURCE = '__VQI_ISO__';
  var DETECTION_KEY = 'detectionEnabled';
  var OSD_KEY = 'osdEnabled';
  var IDLE_INTERVAL_MS = 1500;
  var IDLE_MIN_WIDTH = 160; // ignore tiny videos (ads, previews) for the idle HUD
  var IDLE_MIN_HEIGHT = 90;

  // -------------------------------------------------------------------------
  // Module state
  // -------------------------------------------------------------------------

  /** WeakMap<video, state> keeps per-video history without leaking (PRD 6.3). */
  var states = new WeakMap();
  /** Strong set used only for iteration; pruned during every rescan. */
  var tracked = new Set();
  var observedRoots = new WeakSet(); // replaced by a fresh set on every activation
  /** Open shadow roots found by the last walks. Pruned when the host leaves the DOM. */
  var shadowRoots = new Set();
  var shadowDirty = true; // a full walk is due (new shadow root reported, or first scan)
  var lastWalkAt = -Infinity;

  var observer = null;
  var rescanTimer = null;
  var tickTimer = null;
  // `stopped` is the permanent shutdown (extension context invalidated). `detecting` is the
  // user-controlled master switch: true only while detection is on and the script is active.
  var stopped = false;
  var detecting = false;
  var generation = 0; // bumped on every activation, so answers to old reports can be ignored
  var detectionDecided = false; // the stored flag or a storage change has been applied
  var osdDecided = false; // same for osdEnabled

  var latestCodec = null; // { name, efficiency, mimeType }
  var latestAudio = null; // { name } from AUDIO_DETECTED
  var latestAudioInfo = null; // { sampleRate, channels } from AUDIO_INFO (read from the init segment)
  // Cumulative bytes the page appended to its SourceBuffers (MEDIA_STATS). The download rate is the
  // growth over the last DOWNLOAD_WINDOW samples. Direct (non-MSE) playback has no such counter.
  var mediaBytes = null;
  var bytesWindow = []; // { t, bytes }
  var downloadBps = null;
  var current = null; // { payload, video } of the latest report
  var lastSentHasVideo = false;
  var announced = false; // whether this frame has sent at least one report
  // Whether this frame holds the tab's elected video and may draw the OSD. background.js
  // answers every report with it. null (no answer yet) counts as allowed.
  var osdOwner = null;
  var osdEnabled = true;
  var osd = null; // lazily created HUD parts
  // Idle HUD (detection off): a slow timer only positions the panel next to a video.
  var idleTimer = null;
  var idleAnchor = null; // video that carried the HUD when detection was switched off
  // Bumped by every local detection request and every detectionEnabled storage change, so a
  // late rejected write only rolls back when nothing newer happened meanwhile.
  var detectionRev = 0;
  var osdRev = 0; // same idea for osdEnabled

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  /** True while the extension context is still valid (false after update/reload). */
  function alive() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function clamp(n, min, max) {
    return Math.min(Math.max(n, min), max);
  }

  function isPlayingVideo(video) {
    return !video.paused && !video.ended && video.readyState >= 2;
  }

  function isValidVideo(video) {
    return !!video && video.isConnected && video.videoWidth > 0 && video.videoHeight > 0;
  }

  /** Rect area, or videoWidth * videoHeight * 0.1 when hidden / zero sized (PRD 4.2-A). */
  function displayAreaOf(video) {
    var area = 0;
    try {
      var r = video.getBoundingClientRect();
      area = r.width * r.height;
    } catch (e) {
      area = 0;
    }
    if (!(area > 0)) area = video.videoWidth * video.videoHeight * 0.1;
    return Math.round(area);
  }

  /** True when `node` is `container` or is nested in it, also across shadow roots. */
  function isInside(node, container) {
    var n = node;
    var guard = 0;
    while (n && guard++ < 200) {
      if (n === container) return true;
      n = n.parentNode || n.host || null;
    }
    return false;
  }

  function getQuality(video) {
    try {
      if (typeof video.getVideoPlaybackQuality === 'function') {
        var q = video.getVideoPlaybackQuality();
        return { total: q.totalVideoFrames || 0, dropped: q.droppedVideoFrames || 0 };
      }
    } catch (e) {
      // Fall through.
    }
    return { total: 0, dropped: 0 };
  }

  // -------------------------------------------------------------------------
  // A. Discovery
  // -------------------------------------------------------------------------

  /** Walks every element of `root` to find open shadow roots (expensive on big DOMs). */
  function walkShadowRoots(root, depth) {
    try {
      if (depth >= MAX_SHADOW_DEPTH) return;
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var sr = all[j].shadowRoot;
        if (sr) {
          shadowRoots.add(sr);
          observeRoot(sr);
          walkShadowRoots(sr, depth + 1);
        }
      }
    } catch (e) {
      // Ignore a broken subtree.
    }
  }

  /** Collects <video> elements from the document and from the known shadow roots. */
  function collectVideos(out) {
    try {
      var vids = document.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) out.add(vids[i]);
    } catch (e) {
      // Ignore.
    }
    shadowRoots.forEach(function (sr) {
      try {
        if (!sr.host || !sr.host.isConnected) {
          shadowRoots.delete(sr);
          return;
        }
        var inner = sr.querySelectorAll('video');
        for (var k = 0; k < inner.length; k++) out.add(inner[k]);
      } catch (e) {
        shadowRoots.delete(sr);
      }
    });
  }

  /** Runs the full shadow walk when one is due and the minimum gap has passed. */
  function maybeWalk() {
    var t = now();
    var due = (shadowDirty && t - lastWalkAt >= SHADOW_WALK_MIN_MS) || t - lastWalkAt >= SHADOW_WALK_PERIODIC_MS;
    if (!due) return;
    lastWalkAt = t;
    shadowDirty = false;
    walkShadowRoots(document, 0);
  }

  function observeRoot(root) {
    try {
      if (!observer || observedRoots.has(root)) return;
      observedRoots.add(root);
      observer.observe(root, { childList: true, subtree: true });
    } catch (e) {
      // Ignore.
    }
  }

  /** Finds videos, attaches new ones, and cleans up the ones that left the DOM. */
  function rescan() {
    try {
      if (!detecting) return;
      var found = new Set();
      maybeWalk();
      collectVideos(found);
      found.forEach(function (video) {
        if (!states.has(video)) attach(video);
      });
      Array.from(tracked).forEach(function (video) {
        if (!video.isConnected || !found.has(video)) detach(video);
      });
    } catch (e) {
      // Ignore.
    }
  }

  function scheduleRescan() {
    if (rescanTimer || stopped || !detecting) return;
    rescanTimer = setTimeout(function () {
      rescanTimer = null;
      rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  /** Picks the active video of this frame with the shared election rule. */
  function pickActive() {
    var entries = [];
    tracked.forEach(function (video) {
      try {
        if (!isValidVideo(video)) return;
        entries.push({
          hasVideo: true,
          isPlaying: isPlayingVideo(video),
          displayArea: displayAreaOf(video),
          video: video,
        });
      } catch (e) {
        // Skip this video.
      }
    });
    var best = EVAL.electBest(entries);
    return best ? best.video : null;
  }

  // -------------------------------------------------------------------------
  // B. Per-video stats
  // -------------------------------------------------------------------------

  function createState(video) {
    return {
      video: video,
      listeners: [],
      rvfcHandle: null,
      rvfcActive: false,
      frameCount: 0,
      fps: 0,
      lastValidFps: 0,
      fpsPending: false,
      lastTotalFrames: null,
      lastSampleAt: now(),
      lastBytes: null,
      kbpsWindow: [],
      lastValidKbps: null,
      src: video.currentSrc || '',
    };
  }

  /**
   * Clears history that belongs to one loaded media item. `full` also restarts the FPS
   * measurement (new media); otherwise only the bitrate window is reset. The previous FPS
   * value stays visible until the first new sample, so the UI never flashes 0 FPS.
   */
  function resetState(st, full) {
    st.lastBytes = null;
    st.kbpsWindow = [];
    st.lastValidKbps = null;
    if (full) {
      st.frameCount = 0;
      st.fps = 0;
      st.fpsPending = true;
      st.lastTotalFrames = null;
    }
  }

  function addListener(st, target, type, handler) {
    target.addEventListener(type, handler, true);
    st.listeners.push({ target: target, type: type, handler: handler });
  }

  /** Starts tracking a video: listeners (once), rVFC loop. */
  function attach(video) {
    var st = createState(video);
    states.set(video, st);
    tracked.add(video);

    var onNewMedia = function () {
      try {
        resetState(st, true);
        // The FPS window restarts with the new media, so the first sample is not
        // divided by the time that passed before this event.
        st.lastSampleAt = now();
        // Remember the new source, otherwise the next sample() sees a "changed"
        // currentSrc and resets the FPS measurement a second time.
        st.src = video.currentSrc || '';
        // The codec belongs to the media that was just replaced. Only the active
        // (or the only) video may clear it, otherwise a preview video starting
        // would erase the codec of the one being watched.
        if (!current || current.video === video) {
          latestCodec = null;
          latestAudio = null;
          latestAudioInfo = null;
        }
        report();
      } catch (e) {
        // Ignore.
      }
    };
    var onMetadata = function () {
      // The codec is intentionally kept: for MSE, addSourceBuffer runs before
      // loadedmetadata, so clearing it here would drop the fresh value.
      try {
        resetState(st, false);
        report();
      } catch (e) {
        // Ignore.
      }
    };
    var onStateEvent = function () {
      try {
        report();
      } catch (e) {
        // Ignore.
      }
    };
    addListener(st, video, 'emptied', onNewMedia);
    addListener(st, video, 'loadstart', onNewMedia);
    addListener(st, video, 'loadedmetadata', onMetadata);
    addListener(st, video, 'resize', onStateEvent); // PRD 4.2-B: immediate recompute
    addListener(st, video, 'play', onStateEvent);
    addListener(st, video, 'playing', onStateEvent);
    addListener(st, video, 'pause', onStateEvent);
    addListener(st, video, 'ended', onStateEvent);

    startFrameLoop(st);
  }

  /** requestVideoFrameCallback loop that counts presented frames. */
  function startFrameLoop(st) {
    var video = st.video;
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    st.rvfcActive = true;
    var loop = function () {
      try {
        if (stopped || !detecting || states.get(video) !== st) return;
        st.frameCount++;
        st.rvfcHandle = video.requestVideoFrameCallback(loop);
      } catch (e) {
        st.rvfcActive = false;
      }
    };
    try {
      st.rvfcHandle = video.requestVideoFrameCallback(loop);
    } catch (e) {
      st.rvfcActive = false;
    }
  }

  /** Removes listeners and cancels the rVFC handle (PRD 6.3). */
  function detach(video) {
    try {
      var st = states.get(video);
      if (st) {
        st.listeners.forEach(function (l) {
          try {
            l.target.removeEventListener(l.type, l.handler, true);
          } catch (e) {
            // Ignore.
          }
        });
        st.listeners = [];
        if (st.rvfcHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
          try {
            video.cancelVideoFrameCallback(st.rvfcHandle);
          } catch (e) {
            // Ignore.
          }
        }
        st.rvfcHandle = null;
        st.rvfcActive = false;
        states.delete(video);
      }
    } catch (e) {
      // Ignore.
    }
    tracked.delete(video);
  }

  /** Settles FPS and bitrate for one video. Called once per tick. */
  function sample(st, t) {
    var video = st.video;
    var elapsed = t - st.lastSampleAt;
    if (elapsed < 200) return;
    st.lastSampleAt = t;

    // New source without a usable event: drop the old history.
    var src = video.currentSrc || '';
    if (src !== st.src) {
      resetState(st, true);
      st.src = src;
    }

    var playing = !video.paused && !video.ended;

    // --- FPS ---
    var measured = null;
    if (st.rvfcActive) {
      measured = (st.frameCount * 1000) / elapsed;
      st.frameCount = 0;
    } else {
      var total = getQuality(video).total;
      if (st.lastTotalFrames !== null && total >= st.lastTotalFrames) {
        measured = ((total - st.lastTotalFrames) * 1000) / elapsed;
      }
      st.lastTotalFrames = total;
    }
    if (measured !== null) {
      if (st.fpsPending) {
        st.fpsPending = false;
        st.lastValidFps = 0; // drop the value of the previous media
      }
      st.fps = playing && measured > 0 ? measured : 0;
      if (st.fps > 0) st.lastValidFps = st.fps;
    }

    // --- Bitrate ---
    var bytes = video.webkitVideoDecodedByteCount;
    if (typeof bytes === 'number' && isFinite(bytes)) {
      if (st.lastBytes === null || bytes < st.lastBytes) {
        // First sample, or the counter restarted with a new media item.
        if (st.lastBytes !== null) {
          st.kbpsWindow = [];
          st.lastValidKbps = null;
        }
      } else if (playing && !video.seeking) {
        var instant = EVAL.computeKbps(bytes - st.lastBytes, elapsed);
        if (instant > 0) {
          st.kbpsWindow.push(instant);
          if (st.kbpsWindow.length > BITRATE_WINDOW) st.kbpsWindow.shift();
          st.lastValidKbps = EVAL.slidingAverage(st.kbpsWindow, BITRATE_WINDOW);
        }
        // delta <= 0 keeps lastValidKbps (PRD 6.1).
      }
      st.lastBytes = bytes;
    }
  }

  /** Download rate in bytes per second from the appended-bytes counter; null while unknown. */
  function sampleDownload(t) {
    if (mediaBytes === null) {
      downloadBps = null;
      return;
    }
    bytesWindow.push({ t: t, bytes: mediaBytes });
    if (bytesWindow.length > DOWNLOAD_WINDOW) bytesWindow.shift();
    var first = bytesWindow[0];
    var last = bytesWindow[bytesWindow.length - 1];
    var dt = last.t - first.t;
    downloadBps = dt >= 200 && last.bytes >= first.bytes ? ((last.bytes - first.bytes) * 1000) / dt : null;
  }

  function sampleAll() {
    var t = now();
    sampleDownload(t);
    tracked.forEach(function (video) {
      try {
        var st = states.get(video);
        if (st && isValidVideo(video)) sample(st, t);
      } catch (e) {
        // Skip this video.
      }
    });
  }

  // -------------------------------------------------------------------------
  // C. Codec
  // -------------------------------------------------------------------------

  function onWindowMessage(event) {
    try {
      if (event.source !== window) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.source !== MAIN_SOURCE) return;
      if (data.type === 'SHADOW_ROOT_CREATED') {
        shadowDirty = true;
        scheduleRescan();
        return;
      }
      if (data.type === 'AUDIO_DETECTED') {
        var audioMime = data.payload && data.payload.mimeType;
        var audio = typeof audioMime === 'string' ? EVAL.parseAudioCodec(audioMime) : null;
        if (!audio) return;
        latestAudio = { name: audio.name };
        latestAudioInfo = null; // the parameters belong to the previous audio stream
        report();
        return;
      }
      if (data.type === 'AUDIO_INFO') {
        var rate = Number(data.payload && data.payload.sampleRate);
        var channels = Number(data.payload && data.payload.channels);
        if (!(rate > 0) || !(channels > 0)) return;
        latestAudioInfo = { sampleRate: rate, channels: channels };
        report();
        return;
      }
      if (data.type === 'MEDIA_STATS') {
        var total = Number(data.payload && data.payload.totalBytes);
        if (isFinite(total) && total >= 0) mediaBytes = total;
        return;
      }
      if (data.type !== 'CODEC_DETECTED') return;
      var mime = data.payload && data.payload.mimeType;
      if (typeof mime !== 'string') return;
      var parsed = EVAL.parseCodec(mime);
      if (!parsed) return;
      latestCodec = { name: parsed.name, efficiency: parsed.efficiency, mimeType: mime };
      report(); // quality switch: refresh right away
    } catch (e) {
      // Ignore.
    }
  }

  /**
   * MSE codec for blob / srcObject playback, URL based guess otherwise. A blob or
   * empty source without a captured codec (MSE in a worker, failed hook) is reported
   * as unknown instead of a direct stream, with a neutral efficiency and known: false.
   */
  function resolveCodec(video) {
    var src = video.currentSrc || '';
    if (!src || src.indexOf('blob:') === 0) {
      if (latestCodec) {
        return { name: latestCodec.name, efficiency: latestCodec.efficiency, known: true };
      }
      return { name: EVAL.UNKNOWN_CODEC_NAME, efficiency: 1.0, known: false };
    }
    var guess = EVAL.inferCodecFromSrc(src);
    return { name: guess.name, efficiency: guess.efficiency, known: true };
  }

  // -------------------------------------------------------------------------
  // D. Reporting
  // -------------------------------------------------------------------------

  function buildPayload(video, st) {
    var width = video.videoWidth;
    var height = video.videoHeight;
    var quality = getQuality(video);
    var codec = resolveCodec(video);
    var fps = st.fps > 0 ? st.fps : st.lastValidFps; // keep last stable value when paused
    fps = Math.round(fps * 10) / 10;
    var kbps = st.lastValidKbps > 0 ? Math.round(st.lastValidKbps) : null;
    var evaluation = EVAL.buildEvaluation({
      width: width,
      height: height,
      fps: fps,
      bitrateKbps: kbps,
      codecEfficiency: codec.efficiency,
      codecKnown: codec.known,
    });
    var host = '';
    try {
      host = location.hostname;
    } catch (e) {
      host = '';
    }
    return {
      hasVideo: true,
      isPlaying: isPlayingVideo(video),
      paused: !!video.paused,
      buffering: !video.paused && !video.ended && video.readyState < 3,
      isIframe: window.top !== window,
      displayArea: displayAreaOf(video),
      width: width,
      height: height,
      aspectRatio: EVAL.computeAspectRatio(width, height),
      fps: fps,
      bitrateKbps: kbps,
      bitrateKnown: kbps !== null,
      codec: codec.name,
      codecEfficiency: codec.efficiency,
      codecKnown: codec.known,
      audioCodec: latestAudio ? latestAudio.name : '',
      audioSampleRate: latestAudioInfo ? latestAudioInfo.sampleRate : 0,
      audioChannels: latestAudioInfo ? latestAudioInfo.channels : 0,
      downloadBps: downloadBps === null ? null : Math.round(downloadBps),
      totalFrames: quality.total,
      droppedFrames: quality.dropped,
      dropRate: EVAL.computeDropRate(quality.total, quality.dropped),
      evaluation: evaluation,
      timestamp: Date.now(),
      frameUrl: host,
    };
  }

  /** background.js answers each report with { osdOwner } (one OSD per tab). */
  function onReportResponse(response) {
    try {
      if (stopped || !detecting || !response || typeof response.osdOwner !== 'boolean') return;
      if (response.osdOwner === osdOwner) return;
      osdOwner = response.osdOwner;
      renderOsd();
    } catch (e) {
      // Ignore.
    }
  }

  function send(payload) {
    if (!detecting) return;
    announced = true;
    try {
      var sentIn = generation;
      var result = chrome.runtime.sendMessage({ type: 'VIDEO_METRICS_UPDATE', payload: payload });
      if (result && typeof result.then === 'function') {
        result.then(function (response) {
          if (sentIn === generation) onReportResponse(response);
        }, function () {});
      }
    } catch (e) {
      // "Extension context invalidated" and similar: stop when the context is gone.
      if (!alive()) shutdown();
    }
  }

  /** Builds and sends the current frame state, then refreshes the OSD. */
  function report() {
    try {
      if (stopped || !detecting) return;
      if (!alive()) {
        shutdown();
        return;
      }
      var video = pickActive();
      if (!video) {
        current = null;
        // Tell background once so it drops this frame; its 5s prune covers the rest.
        // The top frame also announces itself once without a video: background uses
        // the sender's documentId to detect a new top-level document and drops the
        // data of the previous page, which matters for pages that never get a video.
        if (lastSentHasVideo || (!announced && window.top === window)) {
          lastSentHasVideo = false;
          send({ hasVideo: false });
        }
        renderOsd();
        return;
      }
      var st = states.get(video);
      if (!st) return;
      var payload = buildPayload(video, st);
      current = { payload: payload, video: video };
      lastSentHasVideo = true;
      send(payload);
      renderOsd();
    } catch (e) {
      // Never throw into the page.
    }
  }

  function tick() {
    try {
      if (stopped || !detecting) return;
      if (!alive()) {
        shutdown();
        return;
      }
      rescan();
      sampleAll();
      report();
    } catch (e) {
      // Ignore.
    }
  }

  // -------------------------------------------------------------------------
  // E. OSD HUD
  // -------------------------------------------------------------------------

  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';

  var OSD_CSS =
    ':host{all:initial}' +
    '.card{position:relative;display:inline-flex;align-items:flex-start;gap:10px;padding:9px 8px 9px 14px;' +
    'border-radius:12px;overflow:hidden;background:rgba(15,18,32,.7);' +
    '-webkit-backdrop-filter:blur(14px) saturate(150%);backdrop-filter:blur(14px) saturate(150%);' +
    'border:1px solid rgba(255,255,255,.12);box-shadow:0 6px 20px rgba(0,0,0,.38);color:#f3f4f8;' +
    'white-space:nowrap;user-select:none;pointer-events:none;' +
    'font:500 12.5px/1.3 ' + FONT + ';font-variant-numeric:tabular-nums}' +
    // Quality colour stripe on the left edge.
    '.dot{position:absolute;left:0;top:0;bottom:0;width:4px;background:#9ca3af;transition:background-color .3s}' +
    '.lines{display:flex;flex-direction:column;gap:5px;min-width:176px}' +
    '.line{display:flex;align-items:center;gap:8px;min-height:17px}' +
    '.line[hidden]{display:none}' +
    '.icon{display:inline-flex;flex:none;width:15px;height:15px;color:#aeb4c8}' +
    '.icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
    '.value{overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.45)}' +
    '.text{font-weight:600}' +
    '.text[hidden]{display:none}' +
    '.tag{margin-left:2px;padding:1px 6px;border-radius:999px;background:rgba(251,191,36,.22);color:#fde68a;font-size:11px;font-weight:600}' +
    '.tag[hidden]{display:none}' +
    '.side{display:flex;flex-direction:column;align-items:flex-end;gap:6px}' +
    '.close{pointer-events:auto;cursor:pointer;border:0;background:transparent;color:#d1d5db;' +
    'font:700 15px/1 sans-serif;padding:0 3px;opacity:.55;transition:opacity .15s}' +
    '.close:hover{opacity:1}' +
    '.toggle{pointer-events:auto;cursor:pointer;border:1px solid rgba(255,255,255,.22);' +
    'background:rgba(255,255,255,.06);color:#e5e7eb;font:600 11px/1 ' + FONT + ';' +
    'padding:3px 7px;border-radius:999px;transition:background-color .15s}' +
    '.toggle:hover{background:rgba(255,255,255,.18)}';

  var HOST_BASE =
    'all:initial!important;position:fixed!important;z-index:2147483647!important;' +
    'pointer-events:none!important;margin:0!important;padding:0!important;';

  var DOT_COLORS = { high: '#10b981', medium: '#3b82f6', low: '#ef4444', unknown: '#9ca3af' };

  var SVG_NS = 'http://www.w3.org/2000/svg';
  // 24x24 stroke icons: film strip, audio waveform, speedometer.
  var ICON_PATHS = {
    video: ['M4 5h16v14H4z', 'M8 5v14M16 5v14', 'M4 10h4M4 14h4M16 10h4M16 14h4'],
    audio: ['M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2'],
    rate: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 12l4-4', 'M12 7v1M7 12h1M17 12h-1'],
  };

  /** <span class="icon"> with an inline SVG. Without createElementNS the span stays empty. */
  function makeIcon(name) {
    var span = document.createElement('span');
    span.className = 'icon';
    try {
      if (typeof document.createElementNS !== 'function') return span;
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      ICON_PATHS[name].forEach(function (d) {
        var path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
      });
      span.appendChild(svg);
    } catch (e) {
      // The icon is decoration only.
    }
    return span;
  }

  /** One info row: icon plus a value element. Returns { row, value }. */
  function makeLine(iconName, className) {
    var row = document.createElement('div');
    row.className = 'line ' + className;
    var value = document.createElement('span');
    value.className = 'value';
    row.appendChild(makeIcon(iconName));
    row.appendChild(value);
    return { row: row, value: value };
  }

  function ensureOsd() {
    if (osd) return osd;
    var host = document.createElement('div');
    var root = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = OSD_CSS;
    var card = document.createElement('div');
    card.className = 'card';
    var dot = document.createElement('span');
    dot.className = 'dot';
    var lines = document.createElement('div');
    lines.className = 'lines';
    var video = makeLine('video', 'line-video');
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '已暂停';
    tag.hidden = true;
    video.row.appendChild(tag);
    var audio = makeLine('audio', 'line-audio');
    var rate = makeLine('rate', 'line-rate');
    // Neutral text ("检测已关闭", "正在检测..."): replaces the three rows.
    var text = document.createElement('span');
    text.className = 'text';
    text.hidden = true;
    lines.appendChild(video.row);
    lines.appendChild(audio.row);
    lines.appendChild(rate.row);
    lines.appendChild(text);
    var toggle = document.createElement('button');
    toggle.className = 'toggle';
    toggle.type = 'button';
    toggle.addEventListener('click', function (e) {
      try {
        e.preventDefault();
        e.stopPropagation();
        requestDetection(!detecting);
      } catch (err) {
        // Ignore.
      }
    });
    var close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.title = '关闭悬浮窗并停止检测 (在扩展弹窗中重新打开“悬浮窗”和“检测画质”)';
    close.addEventListener('click', function (e) {
      try {
        e.preventDefault();
        e.stopPropagation();
        // The x hides the HUD and stops detection. Both are persisted, so every other frame,
        // background.js and the popup follow through storage.onChanged.
        requestDetection(false, true);
      } catch (err) {
        // Ignore.
      }
    });
    var side = document.createElement('div');
    side.className = 'side';
    side.appendChild(close);
    side.appendChild(toggle);
    card.appendChild(dot);
    card.appendChild(lines);
    card.appendChild(side);
    root.appendChild(style);
    root.appendChild(card);
    osd = {
      host: host,
      dot: dot,
      text: text,
      tag: tag,
      toggle: toggle,
      video: video,
      audio: audio,
      rate: rate,
      cssText: '',
    };
    updateToggle(osd);
    return osd;
  }

  function removeOsd() {
    try {
      if (osd && osd.host.parentNode) osd.host.parentNode.removeChild(osd.host);
    } catch (e) {
      // Ignore.
    }
  }

  /** Where the HUD should live, or null when it must stay hidden (video fullscreen). */
  function desiredParent(video) {
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) {
      if (fs === video || fs.tagName === 'VIDEO') return null; // cannot render inside <video>
      if (isInside(video, fs)) return fs.shadowRoot || fs;
    }
    return document.body || document.documentElement;
  }

  /** Writes the three info rows from a payload; the audio row hides without audio information. */
  function setInfoContent(parts, payload) {
    var info = EVAL.buildInfoLines(payload);
    parts.video.value.textContent = info.video;
    parts.audio.value.textContent = info.audio;
    parts.audio.row.hidden = !info.audio;
    parts.rate.value.textContent = info.rate;
    parts.video.row.hidden = false;
    parts.rate.row.hidden = false;
    parts.text.textContent = '';
    parts.text.hidden = true;
  }

  /** Label of the HUD button follows the mode: pause while detecting, start while idle. */
  function updateToggle(parts) {
    try {
      if (detecting) {
        parts.toggle.textContent = '暂停';
        parts.toggle.title = '暂停检测,保留悬浮窗 (再次点击可恢复)';
      } else {
        parts.toggle.textContent = '开启';
        parts.toggle.title = '开启检测画质';
      }
    } catch (e) {
      // Ignore.
    }
  }

  /** Positions the HUD at the top-right of the video rect and moves it under `parent`. */
  function placeOsd(parts, video, parent) {
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    var vh = document.documentElement.clientHeight || window.innerHeight || 0;
    var top = 16;
    var right = 16;
    var visible = true;
    var r = video.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {
        visible = false;
      } else {
        top = clamp(r.top + 16, 0, Math.max(0, vh - 48));
        right = clamp(vw - r.right + 16, 0, Math.max(0, vw - 120));
      }
    }
    var css =
      HOST_BASE +
      'display:' + (visible ? 'block' : 'none') + '!important;' +
      'top:' + Math.round(top) + 'px!important;right:' + Math.round(right) + 'px!important;';
    if (css !== parts.cssText) {
      parts.host.style.cssText = css;
      parts.cssText = css;
    }

    if (parts.host.parentNode !== parent) parent.appendChild(parts.host);
  }

  /** Fixed, value free content used while detection is off or just resuming. */
  function setNeutralContent(parts, label) {
    parts.video.value.textContent = '';
    parts.audio.value.textContent = '';
    parts.rate.value.textContent = '';
    parts.video.row.hidden = true;
    parts.audio.row.hidden = true;
    parts.rate.row.hidden = true;
    parts.text.hidden = false;
    parts.text.textContent = label;
    parts.dot.style.background = DOT_COLORS.unknown;
    parts.dot.title = label;
    parts.tag.hidden = true;
    updateToggle(parts);
  }

  /** Largest sizable video of this frame (anchor included), preferring a playing one. */
  function pickIdleVideo() {
    var list = [];
    try {
      var vids = document.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) list.push(vids[i]);
    } catch (e) {
      // Ignore.
    }
    if (idleAnchor && !idleAnchor.isConnected) idleAnchor = null;
    if (idleAnchor && list.indexOf(idleAnchor) < 0) list.push(idleAnchor);
    var best = null;
    var bestPlaying = false;
    var bestArea = -1;
    for (var k = 0; k < list.length; k++) {
      try {
        var v = list[k];
        if (!v.isConnected) continue;
        var r = v.getBoundingClientRect();
        if (v !== idleAnchor && (r.width < IDLE_MIN_WIDTH || r.height < IDLE_MIN_HEIGHT)) continue;
        var playing = isPlayingVideo(v);
        var area = r.width * r.height;
        if (best === null || (playing && !bestPlaying) || (playing === bestPlaying && area > bestArea)) {
          best = v;
          bestPlaying = playing;
          bestArea = area;
        }
      } catch (e) {
        // Skip this video.
      }
    }
    return best;
  }

  /** HUD while detection is off: fixed text, no metric, positioned next to a video. */
  function renderIdleOsd() {
    // Until the stored detection flag is known, "off" is only the default, not a fact.
    if (!detectionDecided) return;
    if (!osdEnabled || stopped) {
      removeOsd();
      return;
    }
    var video = pickIdleVideo();
    var parent = video ? desiredParent(video) : null;
    if (!video || !parent) {
      removeOsd();
      return;
    }
    var parts = ensureOsd();
    setNeutralContent(parts, '检测已关闭');
    placeOsd(parts, video, parent);
  }

  /** Draws, positions, and re-parents the HUD according to the latest report. */
  function renderOsd() {
    try {
      if (!detecting) {
        renderIdleOsd();
        return;
      }
      if (!osdEnabled || osdOwner === false || !current || !current.payload.hasVideo || !current.video.isConnected) {
        removeOsd();
        return;
      }
      var video = current.video;
      var payload = current.payload;
      var parent = desiredParent(video);
      if (!parent) {
        removeOsd();
        return;
      }
      var parts = ensureOsd();

      // Content
      setInfoContent(parts, payload);
      var level = payload.evaluation.qualityLevel;
      parts.dot.style.background = DOT_COLORS[level] || DOT_COLORS.unknown;
      parts.dot.title = payload.evaluation.qualityText;
      parts.tag.hidden = !payload.paused;
      updateToggle(parts);

      placeOsd(parts, video, parent);
    } catch (e) {
      // Ignore.
    }
  }

  function idleTick() {
    try {
      if (stopped || detecting) return;
      if (!alive()) {
        shutdown();
        return;
      }
      renderOsd();
    } catch (e) {
      // Ignore.
    }
  }

  function startIdle() {
    try {
      if (stopped || detecting) return;
      if (osdEnabled) {
        if (!idleTimer) idleTimer = setInterval(idleTick, IDLE_INTERVAL_MS);
      } else {
        stopIdle(); // nothing to position while the panel is hidden
      }
      renderOsd();
    } catch (e) {
      // Ignore.
    }
  }

  function stopIdle() {
    try {
      if (idleTimer) clearInterval(idleTimer);
    } catch (e) {
      // Ignore.
    }
    idleTimer = null;
    idleAnchor = null;
  }

  /**
   * Applies a detection change at once and persists it (together with osdEnabled=false when
   * `hideOsd` is set). A rejected write is rolled back only when no newer change (local
   * request or storage event) arrived meanwhile.
   */
  function requestDetection(enabled, hideOsd) {
    try {
      var rev = ++detectionRev;
      var oRev = osdRev;
      var items = { [DETECTION_KEY]: enabled };
      if (hideOsd) {
        osdDecided = true;
        setOsdEnabled(false);
        items[OSD_KEY] = false;
      }
      setDetection(enabled);
      if (!alive()) return;
      var pending = chrome.storage.local.set(items);
      if (pending && typeof pending.then === 'function') {
        pending.then(null, function () {
          try {
            if (hideOsd && oRev === osdRev) setOsdEnabled(true);
            if (rev === detectionRev) setDetection(!enabled);
          } catch (err) {
            // Ignore.
          }
        });
      }
    } catch (e) {
      // Ignore.
    }
  }

  function setOsdEnabled(enabled) {
    osdEnabled = !!enabled;
    if (!detecting && detectionDecided && !stopped) {
      startIdle(); // starts or stops the idle timer to match osdEnabled, then renders
    } else {
      renderOsd();
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function onFullscreenChange() {
    renderOsd();
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    try {
      if (!message) return false;
      if (message.type === 'OSD_STATE') {
        setOsdEnabled(message.enabled);
      } else if (message.type === 'GET_FRAME_STATE') {
        if (current) sendResponse({ payload: current.payload });
      }
    } catch (e) {
      // Ignore.
    }
    return false;
  }

  function onStorageChanged(changes, area) {
    try {
      if (area !== 'local' || !changes) return;
      if (changes[DETECTION_KEY]) {
        detectionRev++;
        setDetection(changes[DETECTION_KEY].newValue !== false);
      }
      if (changes.osdEnabled) {
        osdDecided = true;
        osdRev++;
        setOsdEnabled(changes.osdEnabled.newValue !== false);
      }
    } catch (e) {
      // Ignore.
    }
  }

  /** Starts all per-page work. Idempotent; does nothing after a permanent shutdown. */
  function activate() {
    if (stopped || detecting) return;
    detecting = true;
    generation++;
    stopIdle();
    try {
      // The idle HUD (if shown) stays up with neutral text until the first report.
      if (osd && osd.host.parentNode) setNeutralContent(osd, '正在检测...');
      observedRoots = new WeakSet();
      shadowDirty = true;
      lastWalkAt = -Infinity;
      window.addEventListener('message', onWindowMessage);
      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', onFullscreenChange);

      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(scheduleRescan);
        observer.observe(document, { childList: true, subtree: true });
      }

      // content_main.js may have seen addSourceBuffer before this script loaded, or
      // while detection was off.
      try {
        window.postMessage({ source: ISO_SOURCE, type: 'REQUEST_CODEC' }, '*');
      } catch (e) {
        // Ignore.
      }

      rescan();
      tickTimer = setInterval(tick, REPORT_INTERVAL_MS);
    } catch (e) {
      // Never throw into the page.
    }
  }

  /**
   * Stops all per-page work and drops the collected state, so that a later activate()
   * starts from scratch. Idempotent. No message is sent: background.js clears its own
   * state when it sees the same storage change.
   */
  function deactivate() {
    if (!detecting) return;
    detecting = false;
    generation++; // answers to reports sent while detecting are ignored from now on
    try {
      // Keep the HUD: remember its video as the idle anchor before `current` is dropped.
      idleAnchor = osd && osd.host.parentNode && current && current.video ? current.video : null;
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = null;
      if (observer) observer.disconnect();
      observer = null;
      observedRoots = new WeakSet();
      Array.from(tracked).forEach(detach);
      tracked.clear();
      shadowRoots.clear();
      current = null;
      latestCodec = null;
      latestAudio = null;
      latestAudioInfo = null;
      mediaBytes = null;
      bytesWindow = [];
      downloadBps = null;
      osdOwner = null;
      lastSentHasVideo = false;
      announced = false;
      shadowDirty = true;
      lastWalkAt = -Infinity;
      window.removeEventListener('message', onWindowMessage);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    } catch (e) {
      // Ignore.
    }
  }

  function setDetection(enabled) {
    detectionDecided = true;
    if (stopped) return;
    if (enabled) {
      activate();
    } else {
      deactivate();
      startIdle(); // also covers a page that loads with detection already off
    }
  }

  /** Stops everything for good, for example after "Extension context invalidated". */
  function shutdown() {
    if (stopped) return;
    stopped = true;
    try {
      deactivate();
      stopIdle();
      removeOsd();
    } catch (e) {
      // Ignore.
    }
  }

  function start() {
    try {
      var readable = false;
      if (alive()) {
        try {
          chrome.runtime.onMessage.addListener(onRuntimeMessage);
        } catch (e) {
          // Ignore.
        }
        try {
          chrome.storage.onChanged.addListener(onStorageChanged);
        } catch (e) {
          // Ignore.
        }
        try {
          var pending = chrome.storage.local.get({ detectionEnabled: true, osdEnabled: true }, function (items) {
            try {
              var failed = !!chrome.runtime.lastError;
              // A storage change that arrived first is newer than this answer.
              if (!osdDecided && !failed) setOsdEnabled(!items || items.osdEnabled !== false);
              if (!detectionDecided) setDetection(failed || !items || items.detectionEnabled !== false);
            } catch (e) {
              // Ignore.
            }
          });
          readable = true;
          if (pending && typeof pending.catch === 'function') pending.catch(function () {});
        } catch (e) {
          // Keep the defaults (enabled).
        }
      }
      // Do not detect before the stored answer arrives. Without a readable storage the
      // defaults apply.
      if (!readable && !detectionDecided) setDetection(true);
    } catch (e) {
      // Never throw into the page.
    }
  }

  start();
})();
