/**
 * quality_evaluator.js
 *
 * Pure-function library for StreamLens (PRD 4.3).
 * No DOM access and no chrome.* usage, so it can be loaded:
 *   - as a content script (before content_isolated.js, ISOLATED world),
 *   - from the popup via <script src="../utils/quality_evaluator.js">,
 *   - from node (unit tests) via require().
 *
 * Public API lives on a single namespace: globalThis.__VQI_EVAL__
 * (and module.exports when running under node/CommonJS).
 */
(function (root) {
  'use strict';

  // -------------------------------------------------------------------------
  // A. Codec parsing
  // -------------------------------------------------------------------------

  /**
   * Video codec prefixes. Order matters only for readability: prefixes are
   * distinct, except "vp9" / "vp09" and "vp8" / "vp08" which map to one entry.
   */
  const VIDEO_CODECS = [
    { prefixes: ['avc1', 'avc3'], name: 'H.264 (AVC)', efficiency: 1.0 },
    { prefixes: ['hvc1', 'hev1'], name: 'H.265 (HEVC)', efficiency: 1.45 },
    { prefixes: ['vp09', 'vp9'], name: 'VP9', efficiency: 1.4 },
    { prefixes: ['vp08', 'vp8'], name: 'VP8', efficiency: 0.9 },
    { prefixes: ['av01'], name: 'AV1', efficiency: 1.75 },
  ];

  /** Audio codec prefixes. A codecs string made only of these is not video. */
  const AUDIO_PREFIXES = ['mp4a', 'opus', 'vorbis', 'ac-3', 'ec-3', 'flac'];

  const DIRECT_STREAM_NAME = '原生流 (Direct)';
  // MSE / srcObject playback whose codec could not be captured (for example MSE in a worker).
  const UNKNOWN_CODEC_NAME = '未知编码';

  /**
   * Extracts the individual codec tokens from a MIME type or a bare codec
   * string. `video/mp4; codecs="avc1.64002a, mp4a.40.2"` yields
   * ['avc1.64002a', 'mp4a.40.2']. A bare `avc1.64002a` yields ['avc1.64002a'].
   */
  function extractCodecTokens(input) {
    if (typeof input !== 'string') return [];
    let codecsPart = input;
    const match = /codecs\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/i.exec(input);
    if (match) {
      codecsPart = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3];
    } else if (input.indexOf('/') !== -1) {
      // A MIME type without a codecs parameter (e.g. "video/webm") has no tokens.
      return [];
    }
    return codecsPart
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Parses a MIME type / codec string and returns the video codec as
   * { name, efficiency }, or null when no video codec is present
   * (for example audio-only strings).
   */
  function parseCodec(mimeOrCodecString) {
    const tokens = extractCodecTokens(mimeOrCodecString);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      for (let j = 0; j < VIDEO_CODECS.length; j++) {
        const entry = VIDEO_CODECS[j];
        if (entry.prefixes.some((p) => token.startsWith(p))) {
          return { name: entry.name, efficiency: entry.efficiency };
        }
      }
    }
    return null;
  }

  /**
   * True when the MIME string describes video: either a known video codec is
   * listed, or it is a `video/*` type that does not only list audio codecs.
   */
  function isVideoMime(mime) {
    if (typeof mime !== 'string' || !mime) return false;
    if (parseCodec(mime)) return true;
    const tokens = extractCodecTokens(mime);
    const audioOnly =
      tokens.length > 0 && tokens.every((t) => AUDIO_PREFIXES.some((p) => t.startsWith(p)));
    if (audioOnly) return false;
    return /^\s*video\//i.test(mime);
  }

  /**
   * Audio codec prefixes, most specific first ("mp4a" alone is plain AAC and must come
   * after the HE-AAC and MP3 object types that also start with it).
   */
  const AUDIO_CODECS = [
    { prefixes: ['mp4a.40.29'], name: 'HE-AAC v2' },
    { prefixes: ['mp4a.40.5'], name: 'HE-AAC' },
    { prefixes: ['mp4a.69', 'mp4a.6b', 'mp3'], name: 'MP3' },
    { prefixes: ['mp4a'], name: 'AAC' },
    { prefixes: ['opus'], name: 'Opus' },
    { prefixes: ['vorbis'], name: 'Vorbis' },
    { prefixes: ['ec-3'], name: 'E-AC-3' },
    { prefixes: ['ac-3'], name: 'AC-3' },
    { prefixes: ['flac'], name: 'FLAC' },
  ];

  /**
   * Audio codec of a MIME type / codec string as { name }, or null when it lists none.
   * `audio/mpeg` has no codecs parameter and is MP3.
   */
  function parseAudioCodec(mimeOrCodecString) {
    const tokens = extractCodecTokens(mimeOrCodecString);
    for (let i = 0; i < tokens.length; i++) {
      for (let j = 0; j < AUDIO_CODECS.length; j++) {
        if (AUDIO_CODECS[j].prefixes.some((p) => tokens[i].startsWith(p))) {
          return { name: AUDIO_CODECS[j].name };
        }
      }
    }
    if (typeof mimeOrCodecString === 'string' && /^\s*audio\/mpeg/i.test(mimeOrCodecString)) {
      return { name: 'MP3' };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // B. Codec inference from the media URL (non-MSE playback)
  // -------------------------------------------------------------------------

  /**
   * Guesses the container from the URL suffix. The efficiency is always 1.0
   * because the real codec is unknown.
   */
  function inferCodecFromSrc(url) {
    let pathname = typeof url === 'string' ? url : '';
    // Drop query string and hash before looking at the suffix.
    pathname = pathname.split('#')[0].split('?')[0].toLowerCase();
    if (pathname.endsWith('.webm')) return { name: 'WebM (直链)', efficiency: 1.0 };
    if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v')) {
      return { name: 'MP4 (直链)', efficiency: 1.0 };
    }
    return { name: DIRECT_STREAM_NAME, efficiency: 1.0 };
  }

  // -------------------------------------------------------------------------
  // C. Resolution tier (PRD 4.3-B)
  // -------------------------------------------------------------------------

  /** Tier table in match-priority order. */
  const TIERS = [
    { key: '4K', name: '4K 超高清', badgeText: '4K', badgeColor: '#7C3AED', long: 3840, short: 2160 },
    { key: '2K', name: '2K 超清', badgeText: '2K', badgeColor: '#2563EB', long: 2560, short: 1440 },
    { key: '1080P', name: '1080P 蓝光', badgeText: '1080', badgeColor: '#059669', long: 1920, short: 1080 },
    { key: '720P', name: '720P 高清', badgeText: '720', badgeColor: '#0284C7', long: 1280, short: 720 },
    { key: '480P', name: '480P 标清', badgeText: '480', badgeColor: '#D97706', long: 854, short: 480 },
  ];
  const SD_TIER = { key: 'SD', name: '360P 流畅', badgeText: 'SD', badgeColor: '#6B7280' };

  /**
   * Maps a frame size to a tier using longSide/shortSide, so that 21:9 films
   * (1920x800) and 9:16 portrait clips (1080x1920) are rated correctly.
   * Returns { key, name, badgeText, badgeColor, isPortrait }.
   */
  function getResolutionTier(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    const longSide = Math.max(w, h);
    const shortSide = Math.min(w, h);
    const isPortrait = h > w;
    let tier = SD_TIER;
    for (let i = 0; i < TIERS.length; i++) {
      if (longSide >= TIERS[i].long || shortSide >= TIERS[i].short) {
        tier = TIERS[i];
        break;
      }
    }
    return {
      key: tier.key,
      name: tier.name,
      badgeText: tier.badgeText,
      badgeColor: tier.badgeColor,
      isPortrait: isPortrait,
    };
  }

  /** FPS at or above this value is shown as "60帧" in labels (PRD 4.3-B). */
  const HIGH_FPS_THRESHOLD = 50;

  /**
   * Builds the full tier label, e.g. "1080P 蓝光", "1080P 蓝光(竖屏) 60帧".
   */
  function buildLabel(tier, fps) {
    let label = tier.name;
    if (tier.isPortrait) label += '(竖屏)';
    if (Number(fps) >= HIGH_FPS_THRESHOLD) label += ' 60帧';
    return label;
  }

  // -------------------------------------------------------------------------
  // D. Bitrate evaluation (PRD 4.3-C)
  // -------------------------------------------------------------------------

  /**
   * Thresholds in H.264-equivalent kbps. effective < low => 'low';
   * low <= effective <= high => 'medium'; effective > high => 'high'.
   * 4K / 2K / 1080P / 720P come straight from the PRD. 480P and SD are not
   * in the PRD; the values below scale the same way (roughly 1/2 of the next
   * tier up for the low edge) and are chosen by the implementer.
   */
  const BITRATE_THRESHOLDS = {
    '4K': { low: 6000, high: 14000 },
    '2K': { low: 3500, high: 8000 },
    '1080P': { low: 1500, high: 4000 },
    '720P': { low: 800, high: 2000 },
    '480P': { low: 400, high: 1000 },
    SD: { low: 200, high: 600 },
  };

  const QUALITY_TEXTS = {
    '1080P': { low: '伪高清警告 (严重压缩)', medium: '标准蓝光', high: '高码率 / 真蓝光' },
    '4K': { low: '码率偏低 (压缩明显)', medium: '标准', high: '极清高码率' },
    other: { low: '码率偏低 (压缩明显)', medium: '标准', high: '高码率' },
  };

  const UNKNOWN_BITRATE_TEXT = '码率未知';
  const UNKNOWN_CODEC_TEXT = '编码未知，无法判定';

  /**
   * Rates a bitrate for a given tier key after converting it to an H.264
   * equivalent: effectiveKbps = bitrateKbps * codecEfficiency.
   * When `codecKnown` is false the efficiency is only a guess, so a 'low' verdict
   * (which AV1 or VP9 would not deserve) is reported as 'unknown' instead.
   * Returns { qualityLevel: 'high'|'medium'|'low'|'unknown', qualityText, effectiveKbps }.
   */
  function evaluateBitrate(tierKey, bitrateKbps, codecEfficiency, codecKnown) {
    const kbps = Number(bitrateKbps);
    if (!isFinite(kbps) || kbps <= 0) {
      return { qualityLevel: 'unknown', qualityText: UNKNOWN_BITRATE_TEXT, effectiveKbps: 0 };
    }
    let efficiency = Number(codecEfficiency);
    if (!isFinite(efficiency) || efficiency <= 0) efficiency = 1.0;

    const effectiveKbps = kbps * efficiency;
    const t = BITRATE_THRESHOLDS[tierKey] || BITRATE_THRESHOLDS.SD;
    let level = 'medium';
    if (effectiveKbps < t.low) level = 'low';
    else if (effectiveKbps > t.high) level = 'high';

    if (codecKnown === false && level === 'low') {
      return { qualityLevel: 'unknown', qualityText: UNKNOWN_CODEC_TEXT, effectiveKbps: effectiveKbps };
    }

    const texts = QUALITY_TEXTS[tierKey] || QUALITY_TEXTS.other;
    return { qualityLevel: level, qualityText: texts[level], effectiveKbps: effectiveKbps };
  }

  // -------------------------------------------------------------------------
  // E. Aspect ratio
  // -------------------------------------------------------------------------

  const COMMON_RATIOS = [
    [16, 9],
    [4, 3],
    [3, 2],
    [16, 10],
    [5, 4],
    [1, 1],
    [21, 9],
  ];
  const RATIO_TOLERANCE = 0.015; // 1.5% relative difference counts as a match
  const WIDE_THRESHOLD = 2.0; // at or above this, show "N.NN:1 宽屏"

  function gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a || 1;
  }

  /** Returns [num, den] of a common ratio matching long/short, or null. */
  function snapRatio(longSide, shortSide) {
    const r = longSide / shortSide;
    for (let i = 0; i < COMMON_RATIOS.length; i++) {
      const c = COMMON_RATIOS[i];
      if (Math.abs(r - c[0] / c[1]) / (c[0] / c[1]) <= RATIO_TOLERANCE) return c;
    }
    return null;
  }

  /**
   * Returns the aspect ratio as "W:H" text, e.g. "16:9", "9:16", "4:3".
   * Unusual ratios fall back to "N.NN:1" (or "1:N.NN" for portrait).
   * Returns "" for invalid sizes.
   */
  function computeAspectRatio(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!(w > 0) || !(h > 0)) return '';
    const portrait = h > w;
    const longSide = portrait ? h : w;
    const shortSide = portrait ? w : h;

    const snapped = snapRatio(longSide, shortSide);
    let a;
    let b;
    if (snapped) {
      a = snapped[0];
      b = snapped[1];
    } else {
      const g = gcd(Math.round(longSide), Math.round(shortSide));
      a = Math.round(longSide) / g;
      b = Math.round(shortSide) / g;
      if (a > 50 || b > 50) {
        const text = (longSide / shortSide).toFixed(2);
        return portrait ? `1:${text}` : `${text}:1`;
      }
    }
    return portrait ? `${b}:${a}` : `${a}:${b}`;
  }

  /**
   * Human readable aspect ratio for the popup:
   * 1920x804 -> "2.39:1 宽屏", 1920x1080 -> "16:9", 1080x1920 -> "9:16 竖屏".
   */
  function describeAspect(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!(w > 0) || !(h > 0)) return '';
    if (h > w) return `${computeAspectRatio(w, h)} 竖屏`;
    if (w / h >= WIDE_THRESHOLD) return `${(w / h).toFixed(2)}:1 宽屏`;
    return computeAspectRatio(w, h);
  }

  // -------------------------------------------------------------------------
  // F. Formatting helpers
  // -------------------------------------------------------------------------

  const UNKNOWN_BITRATE_DISPLAY = '不支持/未知';

  /** 4250 -> "4.25 Mbps", 850 -> "850 kbps", invalid/<=0 -> "不支持/未知". */
  function formatBitrate(kbps) {
    const n = Number(kbps);
    if (!isFinite(n) || n <= 0) return UNKNOWN_BITRATE_DISPLAY;
    if (n >= 1000) return `${(n / 1000).toFixed(2)} Mbps`;
    return `${Math.round(n)} kbps`;
  }

  /** 24 -> "24.0 FPS". Non-numeric input yields "--". */
  function formatFps(n) {
    const v = Number(n);
    if (n === null || n === undefined || !isFinite(v) || v < 0) return '--';
    return `${v.toFixed(1)} FPS`;
  }

  /** 712 -> "712 kb/s", 4250 -> "4.25 Mb/s", invalid/<=0 -> "未知". Compact form for the info lines. */
  function formatBitrateShort(kbps) {
    const n = Number(kbps);
    if (!isFinite(n) || n <= 0) return '未知';
    if (n >= 1000) return `${(n / 1000).toFixed(2)} Mb/s`;
    return `${Math.round(n)} kb/s`;
  }

  /** Bytes per second, decimal units like the bitrate: 753000 -> "753 KB/s", 1.2e6 -> "1.20 MB/s". */
  function formatSpeed(bytesPerSecond) {
    const n = Number(bytesPerSecond);
    if (!isFinite(n) || n < 0) return '--';
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB/s`;
    if (n >= 1e3) return `${Math.round(n / 1e3)} KB/s`;
    return `${Math.round(n)} B/s`;
  }

  /** 48000 -> "48 kHz", 44100 -> "44.1 kHz". Invalid input yields "". */
  function formatSampleRate(hz) {
    const n = Number(hz);
    if (!isFinite(n) || n <= 0) return '';
    return `${Number((n / 1000).toFixed(2))} kHz`;
  }

  const CHANNEL_LAYOUTS = { 1: '1.0', 2: '2.0', 3: '2.1', 4: '4.0', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1' };

  /** 2 -> "2.0", 6 -> "5.1", 8 -> "7.1". Other counts are written as "12ch". Invalid input yields "". */
  function formatChannels(count) {
    const n = Math.round(Number(count));
    if (!isFinite(n) || n <= 0) return '';
    return CHANNEL_LAYOUTS[n] || `${n}ch`;
  }

  /** "H.264 (AVC)" -> "H.264", "MP4 (直链)" -> "MP4". */
  function shortCodecName(name) {
    return String(name || '').replace(/\s*\(.*\)\s*$/, '') || '--';
  }

  /** 25.43 -> "25.4", 24 -> "24". Non-positive or invalid input yields "". */
  function formatFpsShort(fps) {
    const n = Number(fps);
    if (!isFinite(n) || n <= 0) return '';
    return String(Number(n.toFixed(1)));
  }

  /**
   * The three lines shown by the HUD and the popup, from a report payload:
   *   video: "H.264 · 1920×1080 · 25.4 fps"
   *   audio: "AAC · 48 kHz · 2.0"            ("" when no audio information is known)
   *   rate:  "码率 712 kb/s · 下载 753 KB/s"  (the download part only when it is measured)
   */
  function buildInfoLines(payload) {
    const p = payload || {};
    const fps = formatFpsShort(p.fps);
    const size = Number(p.width) > 0 && Number(p.height) > 0 ? `${p.width}×${p.height}` : '';
    const video = [shortCodecName(p.codec), size, fps ? `${fps} fps` : ''].filter(Boolean).join(' · ');
    const audio = [
      p.audioCodec || '',
      formatSampleRate(p.audioSampleRate),
      formatChannels(p.audioChannels),
    ]
      .filter(Boolean)
      .join(' · ');
    const rate = [`码率 ${formatBitrateShort(p.bitrateKbps)}`];
    const speed = p.downloadBps;
    if (typeof speed === 'number' && isFinite(speed) && speed >= 0) rate.push(`下载 ${formatSpeed(speed)}`);
    return { video, audio, rate: rate.join(' · ') };
  }

  /** Dropped-frame percentage with two decimals, e.g. "0.06" or "0.00". */
  function computeDropRate(total, dropped) {
    const t = Number(total);
    const d = Number(dropped);
    if (!isFinite(t) || !isFinite(d) || t <= 0 || d < 0) return '0.00';
    return ((d / t) * 100).toFixed(2);
  }

  // -------------------------------------------------------------------------
  // G. Evaluation object (PRD 5.2 `evaluation` schema)
  // -------------------------------------------------------------------------

  /**
   * Builds { label, badgeText, badgeColor, qualityLevel, qualityText } from
   * the measured metrics.
   */
  function buildEvaluation(metrics) {
    const m = metrics || {};
    const tier = getResolutionTier(m.width, m.height);
    const bitrate = evaluateBitrate(tier.key, m.bitrateKbps, m.codecEfficiency, m.codecKnown);
    return {
      label: buildLabel(tier, m.fps),
      badgeText: tier.badgeText,
      badgeColor: tier.badgeColor,
      qualityLevel: bitrate.qualityLevel,
      qualityText: bitrate.qualityText,
    };
  }

  // -------------------------------------------------------------------------
  // H. Main video election (shared by content_isolated.js and background.js)
  // -------------------------------------------------------------------------

  /**
   * Picks the best entry: playing beats paused, then larger display area.
   *
   * The PRD describes this as score = (isPlaying ? 1000000 : 0) + displayArea.
   * A flat +1000000 bonus is smaller than a 1080p area (2073600), so a large
   * paused video could outrank a small playing one. Comparing isPlaying first
   * and displayArea second gives the intended "playing always wins" behaviour
   * and is identical to the PRD formula whenever areas are below 1000000.
   *
   * Entries that are falsy or have hasVideo === false are ignored.
   * On ties the earlier entry wins. Returns null when nothing qualifies.
   */
  function electBest(entries) {
    if (!entries || typeof entries.length !== 'number') return null;
    let best = null;
    let bestPlaying = false;
    let bestArea = -Infinity;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || entry.hasVideo === false) continue;
      const playing = !!entry.isPlaying;
      const rawArea = Number(entry.displayArea);
      const area = isFinite(rawArea) ? rawArea : 0;
      if (best === null || (playing && !bestPlaying) || (playing === bestPlaying && area > bestArea)) {
        best = entry;
        bestPlaying = playing;
        bestArea = area;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // I. Bitrate sampling helpers (used by content_isolated.js)
  // -------------------------------------------------------------------------

  /**
   * Converts a decoded byte delta over an elapsed time into kbps:
   * kbps = (deltaBytes * 8) / (elapsedSec * 1000) = deltaBytes * 8 / elapsedMs.
   * Returns 0 for invalid or non-positive input.
   */
  function computeKbps(deltaBytes, elapsedMs) {
    const d = Number(deltaBytes);
    const ms = Number(elapsedMs);
    if (!isFinite(d) || !isFinite(ms) || d <= 0 || ms <= 0) return 0;
    return (d * 8) / ms;
  }

  /**
   * Average of the last `size` numbers in `values` (all of them when `size`
   * is missing). Non-finite items are ignored. Returns 0 for an empty list.
   */
  function slidingAverage(values, size) {
    if (!values || typeof values.length !== 'number') return 0;
    const n = Number(size) > 0 ? Math.floor(Number(size)) : values.length;
    let sum = 0;
    let count = 0;
    for (let i = Math.max(0, values.length - n); i < values.length; i++) {
      const v = Number(values[i]);
      if (isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  const api = {
    // codec
    parseCodec: parseCodec,
    parseAudioCodec: parseAudioCodec,
    isVideoMime: isVideoMime,
    inferCodecFromSrc: inferCodecFromSrc,
    UNKNOWN_CODEC_NAME: UNKNOWN_CODEC_NAME,
    // tier and bitrate
    getResolutionTier: getResolutionTier,
    buildLabel: buildLabel,
    evaluateBitrate: evaluateBitrate,
    buildEvaluation: buildEvaluation,
    // aspect
    computeAspectRatio: computeAspectRatio,
    describeAspect: describeAspect,
    // formatting
    formatBitrate: formatBitrate,
    formatFps: formatFps,
    formatBitrateShort: formatBitrateShort,
    formatSpeed: formatSpeed,
    formatSampleRate: formatSampleRate,
    formatChannels: formatChannels,
    shortCodecName: shortCodecName,
    formatFpsShort: formatFpsShort,
    buildInfoLines: buildInfoLines,
    computeDropRate: computeDropRate,
    // election
    electBest: electBest,
    // bitrate sampling
    computeKbps: computeKbps,
    slidingAverage: slidingAverage,
    // constants
    TIERS: TIERS.concat([SD_TIER]),
    BITRATE_THRESHOLDS: BITRATE_THRESHOLDS,
    HIGH_FPS_THRESHOLD: HIGH_FPS_THRESHOLD,
  };

  root.__VQI_EVAL__ = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
