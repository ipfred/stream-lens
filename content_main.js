/**
 * content_main.js (MAIN world, document_start, all frames)
 *
 * Hooks two page APIs and reports to content_isolated.js through
 * window.postMessage (PRD 4.1, 5.1):
 *   1. MediaSource.prototype.addSourceBuffer (and SourceBuffer.changeType):
 *      reports the video MIME / codec string as CODEC_DETECTED and the audio one as
 *      AUDIO_DETECTED. SourceBuffer.appendBuffer adds AUDIO_INFO (sample rate and channels
 *      read from the init segment) and MEDIA_STATS (total appended bytes, for the download rate).
 *   2. Element.prototype.attachShadow: forces closed shadow roots to open so
 *      the isolated script can find <video> elements inside them, and posts
 *      SHADOW_ROOT_CREATED (coalesced) so it knows when to walk the DOM.
 *
 * Rules:
 *   - The original function always runs first and its result is returned
 *     unchanged. Our own reporting can never throw into the page.
 *   - No chrome.* API is used here (the MAIN world has none).
 */
(function () {
  'use strict';

  var win = typeof window !== 'undefined' ? window : globalThis;

  // Guard against double injection (for example the same frame injected twice).
  try {
    var FLAG = Symbol.for('__VQI_MAIN__');
    if (win[FLAG]) return;
    Object.defineProperty(win, FLAG, { value: true, configurable: true });
  } catch (e) {
    // If the flag cannot be set we still continue; hooks are idempotent enough.
  }

  var MSG_SOURCE = '__VQI_MAIN__';
  var ISO_SOURCE = '__VQI_ISO__';

  // Most recent CODEC_DETECTED message. The isolated script starts at
  // document_idle and may miss earlier messages, so it can ask for a replay.
  var lastCodecMessage = null;
  // Same for the audio side: the audio MIME type and the parameters read from the init segment.
  var lastAudioMessage = null;
  var lastAudioInfoMessage = null;

  // Total bytes handed to SourceBuffer.appendBuffer, a proxy for what the player downloaded.
  var appendedBytes = 0;
  var statsPending = false;
  var STATS_DELAY_MS = 500;

  // ShadowRoots created by the page (PRD 4.1 "capturedShadowRoots").
  var capturedShadowRoots = new WeakSet();

  // Timer reference captured now, so a page that replaces setTimeout cannot interfere.
  var setTimeoutRef = typeof win.setTimeout === 'function' ? win.setTimeout : null;
  var shadowNotifyPending = false;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  var VIDEO_PREFIXES = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'vp9', 'vp08', 'vp8', 'av01'];
  var AUDIO_PREFIXES = ['mp4a', 'opus', 'vorbis', 'ac-3', 'ec-3', 'flac'];

  /** Mirrors isVideoMime() of utils/quality_evaluator.js (not loadable here). */
  function isVideoMime(mime) {
    if (typeof mime !== 'string' || !mime) return false;
    var lower = mime.toLowerCase();
    var tokens = [];
    var m = /codecs\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/.exec(lower);
    if (m) {
      var part = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
      tokens = part
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
    }
    var startsWithAny = function (token, list) {
      return list.some(function (p) {
        return token.indexOf(p) === 0;
      });
    };
    if (
      tokens.some(function (t) {
        return startsWithAny(t, VIDEO_PREFIXES);
      })
    ) {
      return true;
    }
    if (
      tokens.length > 0 &&
      tokens.every(function (t) {
        return startsWithAny(t, AUDIO_PREFIXES);
      })
    ) {
      return false;
    }
    return /^\s*video\//.test(lower);
  }

  /** True when the MIME type lists an audio codec (audio only or muxed with video). */
  function hasAudioMime(mime) {
    if (typeof mime !== 'string' || !mime) return false;
    var lower = mime.toLowerCase();
    var m = /codecs\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/.exec(lower);
    if (m) {
      var part = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
      var found = part.split(',').some(function (s) {
        var token = s.trim();
        return AUDIO_PREFIXES.some(function (p) {
          return token.indexOf(p) === 0;
        });
      });
      if (found) return true;
    }
    return /^\s*audio\//.test(lower);
  }

  /** Makes a wrapper look like the original (name and toString). Best effort. */
  function disguise(wrapper, original) {
    try {
      var nativeText = Function.prototype.toString.call(original);
      Object.defineProperty(wrapper, 'toString', {
        value: function toString() {
          return nativeText;
        },
        writable: true,
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true });
    } catch (e) {
      // Cosmetic only.
    }
  }

  /** Posts CODEC_DETECTED for a video MIME and AUDIO_DETECTED for an audio one. Never throws. */
  function reportMime(mimeType) {
    try {
      if (hasAudioMime(mimeType)) {
        var audioMessage = {
          source: MSG_SOURCE,
          type: 'AUDIO_DETECTED',
          payload: { mimeType: String(mimeType), timestamp: Date.now() },
        };
        lastAudioMessage = audioMessage;
        lastAudioInfoMessage = null; // the parameters belong to the previous audio stream
        win.postMessage(audioMessage, '*');
      }
      if (!isVideoMime(mimeType)) return;
      var message = {
        source: MSG_SOURCE,
        type: 'CODEC_DETECTED',
        payload: { mimeType: String(mimeType), timestamp: Date.now() },
      };
      lastCodecMessage = message;
      win.postMessage(message, '*');
    } catch (e) {
      // Reporting must never affect the page.
    }
  }

  // -------------------------------------------------------------------------
  // Init segment parsing: audio sample rate and channel count
  // -------------------------------------------------------------------------

  var MP4_CONTAINERS = { moov: true, trak: true, mdia: true, minf: true, stbl: true };
  var MP4_AUDIO_ENTRIES = { mp4a: true, opus: true, 'ac-3': true, 'ec-3': true, flac: true, alac: true };

  function u32(b, p) {
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  }

  function fourcc(b, p) {
    return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]).toLowerCase();
  }

  /**
   * Looks for an audio sample entry in an MP4 / fMP4 init segment (moov > trak > mdia >
   * minf > stbl > stsd). The entry holds the channel count at offset 24 and the sample
   * rate as 16.16 fixed point at offset 32, counted from the start of the entry box.
   */
  function parseMp4Audio(b, start, end, depth) {
    var p = start;
    while (p + 8 <= end) {
      var size = u32(b, p);
      var type = fourcc(b, p + 4);
      var boxEnd = size === 0 ? end : Math.min(end, p + size);
      if (size !== 0 && size < 8) return null;
      if (MP4_CONTAINERS[type] && depth < 6) {
        var inner = parseMp4Audio(b, p + 8, boxEnd, depth + 1);
        if (inner) return inner;
      } else if (type === 'stsd' && p + 16 <= boxEnd) {
        // Full box header (4) and entry count (4), then the sample entries.
        var q = p + 16;
        while (q + 36 <= boxEnd) {
          var entrySize = u32(b, q);
          var entryType = fourcc(b, q + 4);
          if (entrySize < 36) break;
          if (MP4_AUDIO_ENTRIES[entryType]) {
            var channels = (b[q + 24] << 8) | b[q + 25];
            var rate = u32(b, q + 32) >>> 16;
            if (channels > 0 && rate > 0) return { sampleRate: rate, channels: channels };
          }
          q += entrySize;
        }
      }
      if (boxEnd <= p) return null;
      p = boxEnd;
    }
    return null;
  }

  /** Reads an EBML variable length number. `keepMarker` keeps the length bit (element IDs). */
  function readVint(b, p, keepMarker) {
    if (p >= b.length) return null;
    var first = b[p];
    var length = 1;
    var mask = 0x80;
    while (length <= 8 && !(first & mask)) {
      length++;
      mask >>= 1;
    }
    if (length > 8 || p + length > b.length) return null;
    var value = keepMarker ? first : first & (mask - 1);
    var allOnes = (first & (mask - 1)) === mask - 1;
    for (var i = 1; i < length; i++) {
      value = value * 256 + b[p + i];
      if (b[p + i] !== 0xff) allOnes = false;
    }
    return { value: value, length: length, unknown: !keepMarker && allOnes };
  }

  var WEBM_MASTERS = { 0x18538067: true, 0x1654ae6b: true, 0xae: true, 0xe1: true }; // Segment, Tracks, TrackEntry, Audio
  var WEBM_CLUSTER = 0x1f43b675;

  /** Walks Segment > Tracks > TrackEntry > Audio of a WebM init segment. */
  function parseWebmAudio(b, start, end, depth) {
    var p = start;
    var rate = 0;
    var channels = 0;
    while (p < end) {
      var id = readVint(b, p, true);
      if (!id) break;
      var size = readVint(b, p + id.length, false);
      if (!size) break;
      var dataStart = p + id.length + size.length;
      var dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
      if (id.value === WEBM_CLUSTER) break;
      if (WEBM_MASTERS[id.value] && depth < 6) {
        var inner = parseWebmAudio(b, dataStart, dataEnd, depth + 1);
        if (inner) return inner;
      } else if (id.value === 0xb5 && (dataEnd - dataStart === 4 || dataEnd - dataStart === 8)) {
        // SamplingFrequency, a big endian IEEE float.
        var view = new DataView(b.buffer, b.byteOffset + dataStart, dataEnd - dataStart);
        rate = Math.round(dataEnd - dataStart === 4 ? view.getFloat32(0) : view.getFloat64(0));
      } else if (id.value === 0x9f) {
        channels = 0;
        for (var i = dataStart; i < dataEnd; i++) channels = channels * 256 + b[i];
      }
      if (dataEnd <= p) break;
      p = dataEnd;
    }
    return rate > 0 && channels > 0 ? { sampleRate: rate, channels: channels } : null;
  }

  /** { sampleRate, channels } from an init segment, or null (not an init segment, no audio). */
  function parseAudioParams(data) {
    var bytes;
    if (data && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data && typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      return null;
    }
    // Only the start of a segment is looked at, and only when it is an init segment.
    if (bytes.length < 16) return null;
    var limit = Math.min(bytes.length, 65536);
    var head = fourcc(bytes, 4);
    if (head === 'ftyp' || head === 'moov') return parseMp4Audio(bytes, 0, limit, 0);
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return parseWebmAudio(bytes, 0, limit, 0);
    }
    return null;
  }

  /** Posts the cumulative append counter, at most once per STATS_DELAY_MS. */
  function postStats() {
    try {
      win.postMessage({ source: MSG_SOURCE, type: 'MEDIA_STATS', payload: { totalBytes: appendedBytes } }, '*');
    } catch (e) {
      // Reporting must never affect the page.
    }
  }

  function scheduleStats() {
    if (statsPending) return;
    if (!setTimeoutRef) {
      postStats();
      return;
    }
    statsPending = true;
    setTimeoutRef.call(win, function () {
      statsPending = false;
      postStats();
    }, STATS_DELAY_MS);
  }

  function afterAppendBuffer(args) {
    var data = args[0];
    var length = data && typeof data.byteLength === 'number' ? data.byteLength : 0;
    if (length > 0) {
      appendedBytes += length;
      scheduleStats();
    }
    var params = parseAudioParams(data);
    if (params) {
      var message = {
        source: MSG_SOURCE,
        type: 'AUDIO_INFO',
        payload: { sampleRate: params.sampleRate, channels: params.channels },
      };
      lastAudioInfoMessage = message;
      win.postMessage(message, '*');
    }
  }

  /**
   * Tells the isolated script that a shadow root exists, so it walks the DOM for
   * <video> elements only then. Bursts are coalesced into one message.
   */
  function notifyShadowRoot() {
    try {
      if (shadowNotifyPending) return;
      var post = function () {
        shadowNotifyPending = false;
        try {
          win.postMessage({ source: MSG_SOURCE, type: 'SHADOW_ROOT_CREATED' }, '*');
        } catch (e) {
          // Reporting must never affect the page.
        }
      };
      if (setTimeoutRef) {
        shadowNotifyPending = true;
        setTimeoutRef.call(win, post, 50);
      } else {
        post();
      }
    } catch (e) {
      shadowNotifyPending = false;
    }
  }

  /** Replaces proto[name] with a wrapper that calls `after` once the original returned. */
  function wrapMethod(proto, name, after) {
    try {
      if (!proto || typeof proto[name] !== 'function') return;
      // Skip inherited methods: the owning prototype is hooked on its own.
      if (!Object.prototype.hasOwnProperty.call(proto, name)) return;
      var original = proto[name];
      var wrapper = function () {
        var result = Reflect.apply(original, this, arguments);
        try {
          after(arguments);
        } catch (e) {
          // Ignore reporting errors.
        }
        return result;
      };
      disguise(wrapper, original);
      proto[name] = wrapper;
    } catch (e) {
      // Hooking failed; leave the native method untouched.
    }
  }

  // -------------------------------------------------------------------------
  // 1. Codec capture
  // -------------------------------------------------------------------------

  function afterAddSourceBuffer(args) {
    reportMime(args[0]);
  }

  try {
    if (win.MediaSource) {
      wrapMethod(win.MediaSource.prototype, 'addSourceBuffer', afterAddSourceBuffer);
    }
    if (win.ManagedMediaSource) {
      wrapMethod(win.ManagedMediaSource.prototype, 'addSourceBuffer', afterAddSourceBuffer);
    }
    // Quality switches on an existing SourceBuffer (PRD 7: follow within 1-2s).
    if (win.SourceBuffer) {
      wrapMethod(win.SourceBuffer.prototype, 'changeType', function (args) {
        reportMime(args[0]);
      });
      // Download volume and audio parameters (sample rate, channels) come from the appended data.
      wrapMethod(win.SourceBuffer.prototype, 'appendBuffer', afterAppendBuffer);
    }
  } catch (e) {
    // Ignore.
  }

  // Replay support for the isolated script, which loads later than this file.
  try {
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('message', function (event) {
        try {
          var data = event && event.data;
          if (event.source !== win || !data || typeof data !== 'object') return;
          if (data.source !== ISO_SOURCE || data.type !== 'REQUEST_CODEC') return;
          if (lastCodecMessage) win.postMessage(lastCodecMessage, '*');
          if (lastAudioMessage) win.postMessage(lastAudioMessage, '*');
          if (lastAudioInfoMessage) win.postMessage(lastAudioInfoMessage, '*');
          if (appendedBytes > 0) postStats();
        } catch (e) {
          // Ignore.
        }
      });
    }
  } catch (e) {
    // Ignore.
  }

  // -------------------------------------------------------------------------
  // 2. Shadow DOM penetration
  // -------------------------------------------------------------------------

  try {
    var ElementClass = win.Element;
    if (ElementClass && ElementClass.prototype && typeof ElementClass.prototype.attachShadow === 'function') {
      var originalAttachShadow = ElementClass.prototype.attachShadow;
      var attachShadowWrapper = function attachShadow(init) {
        var root;
        var done = false;
        // Try the 'open' variant first. Copy the dictionary so the caller's
        // object is never mutated.
        if (init && typeof init === 'object' && init.mode === 'closed') {
          try {
            var openInit = Object.assign({}, init);
            openInit.mode = 'open';
            root = Reflect.apply(originalAttachShadow, this, [openInit]);
            done = true;
          } catch (e) {
            done = false;
          }
        }
        // Fall back to the page's original arguments (also the normal path).
        if (!done) root = Reflect.apply(originalAttachShadow, this, arguments);
        try {
          if (root && (typeof root === 'object' || typeof root === 'function')) {
            capturedShadowRoots.add(root);
            notifyShadowRoot();
          }
        } catch (e) {
          // Ignore.
        }
        return root;
      };
      disguise(attachShadowWrapper, originalAttachShadow);
      ElementClass.prototype.attachShadow = attachShadowWrapper;
    }
  } catch (e) {
    // Ignore: the native attachShadow stays in place.
  }
})();
