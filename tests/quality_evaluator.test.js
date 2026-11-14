'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../utils/quality_evaluator.js');

test('exposes the namespace on globalThis', () => {
  assert.equal(globalThis.__VQI_EVAL__, E);
});

test('getResolutionTier: tier boundaries', () => {
  const cases = [
    [3840, 2160, '4K'],
    [3840, 1600, '4K'],
    [2560, 1440, '2K'],
    [2560, 1080, '2K'],
    [1920, 1080, '1080P'],
    [1920, 800, '1080P'], // 21:9 film must not be judged as 720P
    [1280, 720, '720P'],
    [1280, 536, '720P'],
    [854, 480, '480P'],
    [640, 360, 'SD'],
    [0, 0, 'SD'],
  ];
  for (const [w, h, key] of cases) {
    assert.equal(E.getResolutionTier(w, h).key, key, `${w}x${h}`);
  }
});

test('getResolutionTier: just below each boundary falls to the next tier', () => {
  assert.equal(E.getResolutionTier(3839, 2159).key, '2K');
  assert.equal(E.getResolutionTier(2559, 1439).key, '1080P');
  assert.equal(E.getResolutionTier(1919, 1079).key, '720P');
  assert.equal(E.getResolutionTier(1279, 719).key, '480P');
  assert.equal(E.getResolutionTier(853, 479).key, 'SD');
});

test('getResolutionTier: portrait video', () => {
  const t1080 = E.getResolutionTier(1080, 1920);
  assert.equal(t1080.key, '1080P');
  assert.equal(t1080.isPortrait, true);
  assert.equal(E.getResolutionTier(800, 1920).key, '1080P');
  const t4k = E.getResolutionTier(2160, 3840);
  assert.equal(t4k.key, '4K');
  assert.equal(t4k.isPortrait, true);
  assert.equal(E.getResolutionTier(1920, 1080).isPortrait, false);
});

test('getResolutionTier: badge text and colour', () => {
  const expected = {
    '4K': ['4K', '#7C3AED'],
    '2K': ['2K', '#2563EB'],
    '1080P': ['1080', '#059669'],
    '720P': ['720', '#0284C7'],
    '480P': ['480', '#D97706'],
    SD: ['SD', '#6B7280'],
  };
  const samples = { '4K': [3840, 2160], '2K': [2560, 1440], '1080P': [1920, 1080], '720P': [1280, 720], '480P': [854, 480], SD: [640, 360] };
  for (const key of Object.keys(expected)) {
    const t = E.getResolutionTier(...samples[key]);
    assert.equal(t.badgeText, expected[key][0]);
    assert.equal(t.badgeColor, expected[key][1]);
  }
});

test('parseCodec: every PRD prefix', () => {
  const cases = [
    ['avc1.64002a', 'H.264 (AVC)', 1.0],
    ['avc3.64002a', 'H.264 (AVC)', 1.0],
    ['hvc1.1.6.L93.B0', 'H.265 (HEVC)', 1.45],
    ['hev1.1.6.L93.B0', 'H.265 (HEVC)', 1.45],
    ['vp09.00.10.08', 'VP9', 1.4],
    ['vp9', 'VP9', 1.4],
    ['vp08.00.10.08', 'VP8', 0.9],
    ['vp8', 'VP8', 0.9],
    ['av01.0.08M.08', 'AV1', 1.75],
  ];
  for (const [input, name, efficiency] of cases) {
    assert.deepEqual(E.parseCodec(input), { name, efficiency }, input);
  }
});

test('parseCodec: full MIME strings', () => {
  assert.deepEqual(E.parseCodec('video/mp4; codecs="avc1.64002a"'), { name: 'H.264 (AVC)', efficiency: 1.0 });
  assert.deepEqual(E.parseCodec('video/webm; codecs="vp09.00.10.08"'), { name: 'VP9', efficiency: 1.4 });
});

test('parseCodec: combined video + audio picks the video codec', () => {
  const r = E.parseCodec('video/mp4; codecs="avc1.64002a, mp4a.40.2"');
  assert.deepEqual(r, { name: 'H.264 (AVC)', efficiency: 1.0 });
  // audio listed first
  assert.equal(E.parseCodec('video/mp4; codecs="mp4a.40.2, hvc1.1.6.L93.B0"').name, 'H.265 (HEVC)');
  // uppercase input
  assert.equal(E.parseCodec('VIDEO/MP4; CODECS="AV01.0.08M.08"').name, 'AV1');
});

test('parseCodec: audio-only and invalid input return null', () => {
  assert.equal(E.parseCodec('audio/mp4; codecs="mp4a.40.2"'), null);
  assert.equal(E.parseCodec('audio/webm; codecs="opus"'), null);
  assert.equal(E.parseCodec('audio/webm; codecs="vorbis"'), null);
  assert.equal(E.parseCodec('audio/mp4; codecs="ac-3"'), null);
  assert.equal(E.parseCodec('audio/mp4; codecs="ec-3"'), null);
  assert.equal(E.parseCodec('audio/mp4; codecs="flac"'), null);
  assert.equal(E.parseCodec('video/webm'), null);
  assert.equal(E.parseCodec(''), null);
  assert.equal(E.parseCodec(undefined), null);
  assert.equal(E.parseCodec(42), null);
});

test('isVideoMime', () => {
  assert.equal(E.isVideoMime('video/mp4; codecs="avc1.64002a"'), true);
  assert.equal(E.isVideoMime('video/mp4; codecs="avc1.64002a, mp4a.40.2"'), true);
  assert.equal(E.isVideoMime('video/webm'), true);
  assert.equal(E.isVideoMime('audio/mp4; codecs="mp4a.40.2"'), false);
  assert.equal(E.isVideoMime('audio/webm; codecs="opus"'), false);
  assert.equal(E.isVideoMime(''), false);
  assert.equal(E.isVideoMime(null), false);
});

test('inferCodecFromSrc', () => {
  assert.equal(E.inferCodecFromSrc('https://x.com/a/b.webm?token=1').name, 'WebM (直链)');
  assert.equal(E.inferCodecFromSrc('https://x.com/a/b.MP4#t=3').name, 'MP4 (直链)');
  assert.equal(E.inferCodecFromSrc('blob:https://x.com/uuid').name, '原生流 (Direct)');
  assert.equal(E.inferCodecFromSrc('').name, '原生流 (Direct)');
  assert.equal(E.inferCodecFromSrc(undefined).efficiency, 1.0);
});

test('evaluateBitrate: codec efficiency conversion', () => {
  // HEVC 3000 kbps -> 4350 effective on 1080P -> high
  const hevc = E.evaluateBitrate('1080P', 3000, 1.45);
  assert.equal(hevc.qualityLevel, 'high');
  assert.equal(hevc.qualityText, '高码率 / 真蓝光');
  assert.ok(Math.abs(hevc.effectiveKbps - 4350) < 1e-6);
  // H.264 1200 kbps -> low
  const low = E.evaluateBitrate('1080P', 1200, 1.0);
  assert.equal(low.qualityLevel, 'low');
  assert.equal(low.qualityText, '伪高清警告 (严重压缩)');
  // H.264 2500 kbps -> medium
  const mid = E.evaluateBitrate('1080P', 2500, 1.0);
  assert.equal(mid.qualityLevel, 'medium');
  assert.equal(mid.qualityText, '标准蓝光');
});

test('evaluateBitrate: threshold edges on 1080P', () => {
  assert.equal(E.evaluateBitrate('1080P', 1499, 1).qualityLevel, 'low');
  assert.equal(E.evaluateBitrate('1080P', 1500, 1).qualityLevel, 'medium');
  assert.equal(E.evaluateBitrate('1080P', 4000, 1).qualityLevel, 'medium');
  assert.equal(E.evaluateBitrate('1080P', 4001, 1).qualityLevel, 'high');
});

test('evaluateBitrate: thresholds for other tiers', () => {
  const table = {
    '4K': [6000, 14000],
    '2K': [3500, 8000],
    '720P': [800, 2000],
    '480P': [400, 1000],
    SD: [200, 600],
  };
  for (const key of Object.keys(table)) {
    const [lo, hi] = table[key];
    assert.equal(E.evaluateBitrate(key, lo - 1, 1).qualityLevel, 'low', `${key} low`);
    assert.equal(E.evaluateBitrate(key, lo, 1).qualityLevel, 'medium', `${key} lo edge`);
    assert.equal(E.evaluateBitrate(key, hi, 1).qualityLevel, 'medium', `${key} hi edge`);
    assert.equal(E.evaluateBitrate(key, hi + 1, 1).qualityLevel, 'high', `${key} high`);
  }
});

test('evaluateBitrate: quality texts', () => {
  assert.equal(E.evaluateBitrate('4K', 20000, 1).qualityText, '极清高码率');
  assert.equal(E.evaluateBitrate('4K', 1000, 1).qualityText, '码率偏低 (压缩明显)');
  assert.equal(E.evaluateBitrate('2K', 5000, 1).qualityText, '标准');
  assert.equal(E.evaluateBitrate('720P', 3000, 1).qualityText, '高码率');
});

test('evaluateBitrate: unknown bitrate', () => {
  for (const v of [undefined, null, NaN, 0, -5, 'abc', Infinity]) {
    const r = E.evaluateBitrate('1080P', v, 1);
    assert.equal(r.qualityLevel, 'unknown', String(v));
    assert.equal(r.qualityText, '码率未知', String(v));
  }
});

test('evaluateBitrate: bad efficiency falls back to 1.0', () => {
  assert.equal(E.evaluateBitrate('1080P', 2500, undefined).qualityLevel, 'medium');
  assert.equal(E.evaluateBitrate('1080P', 2500, 0).qualityLevel, 'medium');
});

test('buildEvaluation: label with 60 fps (PRD example)', () => {
  const ev = E.buildEvaluation({ width: 1920, height: 1080, fps: 60, bitrateKbps: 4850, codecEfficiency: 1.0 });
  assert.deepEqual(ev, {
    label: '1080P 蓝光 60帧',
    badgeText: '1080',
    badgeColor: '#059669',
    qualityLevel: 'high',
    qualityText: '高码率 / 真蓝光',
  });
});

test('buildEvaluation: label thresholds and portrait', () => {
  assert.equal(E.buildEvaluation({ width: 1920, height: 1080, fps: 49.9 }).label, '1080P 蓝光');
  assert.equal(E.buildEvaluation({ width: 1920, height: 1080, fps: 50 }).label, '1080P 蓝光 60帧');
  assert.equal(E.buildEvaluation({ width: 1080, height: 1920, fps: 30 }).label, '1080P 蓝光(竖屏)');
  assert.equal(E.buildEvaluation({ width: 1080, height: 1920, fps: 60 }).label, '1080P 蓝光(竖屏) 60帧');
  assert.equal(E.buildEvaluation({ width: 3840, height: 2160, fps: 60 }).label, '4K 超高清 60帧');
});

test('buildEvaluation: 1920x800 is 1080P and unknown bitrate is tolerated', () => {
  const ev = E.buildEvaluation({ width: 1920, height: 800, fps: 24 });
  assert.equal(ev.label, '1080P 蓝光');
  assert.equal(ev.badgeText, '1080');
  assert.equal(ev.qualityLevel, 'unknown');
  assert.equal(ev.qualityText, '码率未知');
  assert.doesNotThrow(() => E.buildEvaluation());
});

test('computeDropRate', () => {
  assert.equal(E.computeDropRate(3600, 2), '0.06');
  assert.equal(E.computeDropRate(1842, 0), '0.00');
  assert.equal(E.computeDropRate(0, 0), '0.00');
  assert.equal(E.computeDropRate(100, 50), '50.00');
  assert.equal(E.computeDropRate(undefined, undefined), '0.00');
});

test('describeAspect and computeAspectRatio', () => {
  assert.equal(E.describeAspect(1920, 804), '2.39:1 宽屏');
  assert.equal(E.describeAspect(1920, 1080), '16:9');
  assert.equal(E.describeAspect(1080, 1920), '9:16 竖屏');
  assert.equal(E.describeAspect(640, 480), '4:3');
  assert.equal(E.describeAspect(0, 0), '');
  assert.equal(E.computeAspectRatio(1920, 1080), '16:9');
  assert.equal(E.computeAspectRatio(1280, 720), '16:9');
  assert.equal(E.computeAspectRatio(1366, 768), '16:9'); // snapped (1.7786)
  assert.equal(E.computeAspectRatio(1080, 1920), '9:16');
  assert.equal(E.computeAspectRatio(1920, 804), '2.39:1');
  assert.equal(E.computeAspectRatio(0, 10), '');
});

test('formatBitrate', () => {
  assert.equal(E.formatBitrate(4250), '4.25 Mbps');
  assert.equal(E.formatBitrate(1000), '1.00 Mbps');
  assert.equal(E.formatBitrate(850), '850 kbps');
  assert.equal(E.formatBitrate(850.4), '850 kbps');
  assert.equal(E.formatBitrate(0), '不支持/未知');
  assert.equal(E.formatBitrate(NaN), '不支持/未知');
  assert.equal(E.formatBitrate(undefined), '不支持/未知');
});

test('formatFps', () => {
  assert.equal(E.formatFps(24), '24.0 FPS');
  assert.equal(E.formatFps(59.94), '59.9 FPS');
  assert.equal(E.formatFps(0), '0.0 FPS');
  assert.equal(E.formatFps(undefined), '--');
  assert.equal(E.formatFps(NaN), '--');
});

test('electBest: playing beats a larger paused video', () => {
  const paused = { hasVideo: true, isPlaying: false, displayArea: 2000000, id: 'paused' };
  const playing = { hasVideo: true, isPlaying: true, displayArea: 10000, id: 'playing' };
  assert.equal(E.electBest([paused, playing]).id, 'playing');
  assert.equal(E.electBest([playing, paused]).id, 'playing');
});

test('electBest: area breaks ties, hasVideo false and empty input are ignored', () => {
  const a = { hasVideo: true, isPlaying: true, displayArea: 100, id: 'a' };
  const b = { hasVideo: true, isPlaying: true, displayArea: 500, id: 'b' };
  const c = { hasVideo: false, isPlaying: true, displayArea: 99999999, id: 'c' };
  assert.equal(E.electBest([a, b, c]).id, 'b');
  assert.equal(E.electBest([c]), null);
  assert.equal(E.electBest([]), null);
  assert.equal(E.electBest(null), null);
  assert.equal(E.electBest([null, a]).id, 'a');
});

test('electBest: first entry wins a tie', () => {
  const a = { hasVideo: true, isPlaying: false, displayArea: 100, id: 'a' };
  const b = { hasVideo: true, isPlaying: false, displayArea: 100, id: 'b' };
  assert.equal(E.electBest([a, b]).id, 'a');
});

test('electBest: a small playing video beats a large paused one (area above 1,000,000)', () => {
  const paused = { hasVideo: true, isPlaying: false, displayArea: 1920 * 1080, id: 'paused' };
  const playing = { hasVideo: true, isPlaying: true, displayArea: 1280 * 720, id: 'playing' };
  assert.equal(E.electBest([paused, playing]).id, 'playing');
});

test('unknown codec: a low verdict becomes unknown, other verdicts are kept', () => {
  assert.equal(E.UNKNOWN_CODEC_NAME, '未知编码');
  // 1080P, 1000 kbps is low for H.264.
  assert.equal(E.evaluateBitrate('1080P', 1000, 1.0, true).qualityLevel, 'low');
  assert.equal(E.evaluateBitrate('1080P', 1000, 1.0).qualityLevel, 'low');
  const unknown = E.evaluateBitrate('1080P', 1000, 1.0, false);
  assert.equal(unknown.qualityLevel, 'unknown');
  assert.match(unknown.qualityText, /编码未知/);
  assert.equal(E.evaluateBitrate('1080P', 3000, 1.0, false).qualityLevel, 'medium');
  assert.equal(E.evaluateBitrate('1080P', 6000, 1.0, false).qualityLevel, 'high');
  assert.equal(E.buildEvaluation({ width: 1920, height: 1080, fps: 30, bitrateKbps: 1000, codecEfficiency: 1, codecKnown: false }).qualityLevel, 'unknown');
});

// ---------------------------------------------------------------------------
// Audio codec and the three info lines (HUD and popup)
// ---------------------------------------------------------------------------

test('parseAudioCodec: names for the common audio codecs', () => {
  const cases = [
    ['audio/mp4; codecs="mp4a.40.2"', 'AAC'],
    ['mp4a.40.2', 'AAC'],
    ['audio/mp4; codecs="mp4a.40.5"', 'HE-AAC'],
    ['audio/mp4; codecs="mp4a.40.29"', 'HE-AAC v2'],
    ['audio/mp4; codecs="mp4a.6b"', 'MP3'],
    ['audio/mpeg', 'MP3'],
    ['audio/webm; codecs="opus"', 'Opus'],
    ['audio/webm; codecs="vorbis"', 'Vorbis'],
    ['audio/mp4; codecs="ac-3"', 'AC-3'],
    ['audio/mp4; codecs="ec-3"', 'E-AC-3'],
    ['audio/mp4; codecs="flac"', 'FLAC'],
    ['video/mp4; codecs="avc1.64002a, mp4a.40.2"', 'AAC'],
  ];
  for (const [mime, name] of cases) {
    assert.equal(E.parseAudioCodec(mime).name, name, mime);
  }
});

test('parseAudioCodec: no audio codec gives null', () => {
  for (const mime of ['video/mp4; codecs="avc1.64002a"', 'video/webm', '', null, undefined, 42]) {
    assert.equal(E.parseAudioCodec(mime), null, String(mime));
  }
});

test('formatBitrateShort / formatSpeed / formatSampleRate / formatChannels', () => {
  assert.equal(E.formatBitrateShort(712), '712 kb/s');
  assert.equal(E.formatBitrateShort(4250), '4.25 Mb/s');
  assert.equal(E.formatBitrateShort(0), '未知');
  assert.equal(E.formatBitrateShort(null), '未知');
  assert.equal(E.formatSpeed(753000), '753 KB/s');
  assert.equal(E.formatSpeed(1200000), '1.20 MB/s');
  assert.equal(E.formatSpeed(512), '512 B/s');
  assert.equal(E.formatSpeed(0), '0 B/s');
  assert.equal(E.formatSpeed(-1), '--');
  assert.equal(E.formatSpeed(NaN), '--');
  assert.equal(E.formatSampleRate(48000), '48 kHz');
  assert.equal(E.formatSampleRate(44100), '44.1 kHz');
  assert.equal(E.formatSampleRate(0), '');
  assert.equal(E.formatChannels(2), '2.0');
  assert.equal(E.formatChannels(6), '5.1');
  assert.equal(E.formatChannels(8), '7.1');
  assert.equal(E.formatChannels(1), '1.0');
  assert.equal(E.formatChannels(12), '12ch');
  assert.equal(E.formatChannels(0), '');
  assert.equal(E.shortCodecName('H.264 (AVC)'), 'H.264');
  assert.equal(E.shortCodecName('MP4 (直链)'), 'MP4');
  assert.equal(E.shortCodecName(''), '--');
  assert.equal(E.formatFpsShort(25.43), '25.4');
  assert.equal(E.formatFpsShort(24), '24');
  assert.equal(E.formatFpsShort(0), '');
});

test('buildInfoLines: the example from the request, three lines', () => {
  const lines = E.buildInfoLines({
    codec: 'H.264 (AVC)',
    width: 1920,
    height: 1080,
    fps: 25.43,
    audioCodec: 'AAC',
    audioSampleRate: 48000,
    audioChannels: 2,
    bitrateKbps: 712,
    downloadBps: 753000,
  });
  assert.equal(lines.video, 'H.264 · 1920×1080 · 25.4 fps');
  assert.equal(lines.audio, 'AAC · 48 kHz · 2.0');
  assert.equal(lines.rate, '码率 712 kb/s · 下载 753 KB/s');
});

test('buildInfoLines: missing pieces are left out instead of printed as placeholders', () => {
  const direct = E.buildInfoLines({ codec: 'MP4 (直链)', width: 1280, height: 720, fps: 0, bitrateKbps: null, downloadBps: null });
  assert.equal(direct.video, 'MP4 · 1280×720');
  assert.equal(direct.audio, '');
  assert.equal(direct.rate, '码率 未知');
  const codecOnly = E.buildInfoLines({ codec: 'H.264 (AVC)', width: 640, height: 360, fps: 30, audioCodec: 'Opus', bitrateKbps: 900 });
  assert.equal(codecOnly.audio, 'Opus');
  assert.equal(codecOnly.rate, '码率 900 kb/s');
  assert.deepEqual({ ...E.buildInfoLines(undefined) }, { video: '--', audio: '', rate: '码率 未知' });
});
