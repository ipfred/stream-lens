/**
 * popup.js - detail panel for StreamLens (PRD 4.5).
 *
 * Flow: find the active tab, ask background.js for the aggregated state
 * (GET_TAB_STATE), render it, and repeat every 1000ms while the popup is open.
 * The OSD switch reads and writes chrome.storage.local key `osdEnabled`;
 * content scripts react through storage.onChanged. The detection switch does the same
 * with `detectionEnabled` (default on); while it is off the popup does not message
 * background.js and shows a disabled text.
 *
 * Safety: every value that originates from the page (codec names, labels,
 * host names) is written with textContent only, never innerHTML.
 */
(function () {
  'use strict';

  var REFRESH_MS = 1000;
  var BAR_FULL_FACTOR = 1.5; // bar is full at 1.5x the "high" threshold of the tier
  var EMPTY_TEXT = '当前页面未检测到正在播放的 HTML5 视频，或视频使用 Canvas 渲染';
  var DISABLED_TEXT = '检测已关闭，打开上方开关后开始检测';
  var RESTRICTED_TEXT = '此页面（浏览器内置页或应用商店）不允许扩展读取视频信息';
  var FAKE_CHECK_TIERS = { '4K': true, '2K': true, '1080P': true, '720P': true };

  var EVAL = typeof globalThis !== 'undefined' && globalThis.__VQI_EVAL__ ? globalThis.__VQI_EVAL__ : null;

  // -------------------------------------------------------------------------
  // Formatting helpers, with a fallback when the evaluator namespace is missing
  // -------------------------------------------------------------------------

  /** The three HUD lines (video / audio / rate). Minimal fallback without the evaluator. */
  function buildInfoLines(payload) {
    if (EVAL && EVAL.buildInfoLines) return EVAL.buildInfoLines(payload);
    var fps = Number(payload.fps) > 0 ? ' · ' + Number(payload.fps).toFixed(1) + ' fps' : '';
    var kbps = Number(payload.bitrateKbps);
    var rate = !(kbps > 0) ? '未知' : kbps >= 1000 ? (kbps / 1000).toFixed(2) + ' Mb/s' : Math.round(kbps) + ' kb/s';
    return {
      video: String(payload.codec || '--') + ' · ' + payload.width + '×' + payload.height + fps,
      audio: payload.audioCodec || '',
      rate: '码率 ' + rate,
    };
  }

  function describeAspect(width, height) {
    if (EVAL && EVAL.describeAspect) return EVAL.describeAspect(width, height);
    return width > 0 && height > 0 ? (width / height).toFixed(2) + ':1' : '';
  }

  function tierKeyOf(width, height) {
    if (EVAL && EVAL.getResolutionTier) return EVAL.getResolutionTier(width, height).key;
    return '';
  }

  // -------------------------------------------------------------------------
  // DOM access: only write when the value changed (avoids flicker)
  // -------------------------------------------------------------------------

  var els = {};
  var ids = [
    'content', 'empty', 'empty-text', 'status', 'status-label', 'status-badge',
    'info-video', 'meta-aspect', 'info-audio-row', 'info-audio', 'info-rate',
    'card-bitrate', 'bitrate-bar', 'rate-note',
    'drops-value', 'source-value', 'source-state',
    'osd-toggle', 'osd-error', 'detect-toggle', 'detect-error',
  ];

  function bindElements() {
    ids.forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  function setText(el, value) {
    if (!el) return;
    var text = String(value);
    if (el.textContent !== text) el.textContent = text;
  }

  function setAttr(el, name, value) {
    if (!el) return;
    if (el.dataset[name] !== value) el.dataset[name] = value;
  }

  function setHidden(el, hidden) {
    if (el && el.hidden !== hidden) el.hidden = hidden;
  }

  function setWidth(el, percent) {
    if (!el) return;
    var width = percent + '%';
    if (el.style.width !== width) el.style.width = width;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Last bitrate seen while playing, shown while paused if the payload lacks one. */
  var lastValidKbps = 0;
  var lastValidFps = 0;

  function showEmpty(text) {
    lastValidKbps = 0;
    lastValidFps = 0;
    setText(els['empty-text'], text);
    setHidden(els.empty, false);
    setHidden(els.content, true);
  }

  /** "1080P 蓝光 60帧" -> "1080P 蓝光 · 60帧" */
  function formatStatusLabel(label) {
    return String(label || '').replace(/ (\d+帧)$/, ' · $1');
  }

  /** Text for the quality badge, including the fake-HD warning. */
  function formatQualityBadge(payload, evaluation) {
    var level = evaluation.qualityLevel;
    var text = evaluation.qualityText || '';
    if (level === 'low') {
      var key = tierKeyOf(payload.width, payload.height);
      if (FAKE_CHECK_TIERS[key]) return '⚠ 疑似假' + key + '（码率过低）';
      return '⚠ ' + text;
    }
    return text;
  }

  function bitratePercent(payload, kbps, level) {
    if (!(kbps > 0) || level === 'unknown' || !EVAL || !EVAL.BITRATE_THRESHOLDS) return 0;
    var key = tierKeyOf(payload.width, payload.height);
    var t = EVAL.BITRATE_THRESHOLDS[key];
    if (!t) return 0;
    var efficiency = Number(payload.codecEfficiency) > 0 ? Number(payload.codecEfficiency) : 1;
    var pct = ((kbps * efficiency) / (t.high * BAR_FULL_FACTOR)) * 100;
    return Math.max(2, Math.min(100, Math.round(pct)));
  }

  function renderPayload(payload) {
    var evaluation = payload.evaluation || {};
    var level = evaluation.qualityLevel || 'unknown';
    // isPlaying is false for a stall (readyState < 2) too, so only `paused` means paused.
    var paused = !!payload.paused;
    var buffering = !!payload.buffering;

    // Keep the last valid values so a paused video never shows 0 kbps / 0 fps.
    var kbps = Number(payload.bitrateKbps);
    if (kbps > 0) lastValidKbps = kbps;
    else if ((paused || buffering) && lastValidKbps > 0) kbps = lastValidKbps;
    else kbps = 0;
    var fps = Number(payload.fps);
    if (fps > 0) lastValidFps = fps;
    else if ((paused || buffering) && lastValidFps > 0) fps = lastValidFps;

    // Status header
    setAttr(els.status, 'level', level);
    setText(els['status-label'], formatStatusLabel(evaluation.label) || '--');
    setText(els['status-badge'], formatQualityBadge(payload, evaluation) || '--');

    // Info lines, the same three as the on-page HUD. A paused or stalled video shows the last values.
    var width = Number(payload.width) || 0;
    var height = Number(payload.height) || 0;
    var bitrateKnown = kbps > 0;
    var lines = buildInfoLines(
      Object.assign({}, payload, { bitrateKbps: bitrateKnown ? kbps : null, fps: fps > 0 ? fps : 0 })
    );
    setText(els['info-video'], lines.video);
    setText(els['meta-aspect'], describeAspect(width, height) || payload.aspectRatio || '');
    setText(els['info-audio'], lines.audio);
    setHidden(els['info-audio-row'], !lines.audio);
    setText(els['info-rate'], lines.rate);

    // Bitrate bar and the note under it
    setAttr(els['card-bitrate'], 'level', bitrateKnown ? level : 'unknown');
    setWidth(els['bitrate-bar'], bitratePercent(payload, kbps, bitrateKnown ? level : 'unknown'));
    var note = '';
    if (!bitrateKnown) note = '浏览器未提供解码字节数，无法计算码率';
    else if (paused) note = '已暂停（显示最近值）';
    else if (buffering) note = '缓冲中（显示最近值）';
    setText(els['rate-note'], note);
    setHidden(els['rate-note'], !note);

    // Dropped frames
    var total = Number(payload.totalFrames) || 0;
    var dropped = Number(payload.droppedFrames) || 0;
    var dropRate = payload.dropRate !== undefined && payload.dropRate !== null ? payload.dropRate : '0.00';
    setText(els['drops-value'], dropped + ' / ' + total + ' (' + dropRate + '%)');

    // Source and playback state
    var sourceText = payload.isIframe ? 'Iframe 嵌套播放器' : '主页面';
    setText(els['source-value'], sourceText);
    var state = paused ? 'paused' : buffering ? 'buffering' : 'playing';
    setAttr(els['source-state'], 'state', state);
    setText(els['source-state'], state === 'paused' ? '已暂停' : state === 'buffering' ? '缓冲中' : '播放中');

    setHidden(els.empty, true);
    setHidden(els.content, false);
  }

  function renderState(state) {
    if (state && state.detectionEnabled === false) {
      showEmpty(DISABLED_TEXT);
      return;
    }
    var best = state && state.hasVideo && state.best ? state.best : null;
    if (!best || !best.payload || best.payload.hasVideo === false) {
      showEmpty(EMPTY_TEXT);
      return;
    }
    renderPayload(best.payload);
  }

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  function isRestrictedUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    return (
      /^(chrome|chrome-extension|chrome-search|chrome-untrusted|edge|about|devtools|view-source):/i.test(url) ||
      /^https:\/\/chrome\.google\.com\/webstore/i.test(url) ||
      /^https:\/\/chromewebstore\.google\.com\//i.test(url)
    );
  }

  var activeTab = null;
  var timer = null;
  var refreshing = false;
  var detectionOn = true; // mirrors chrome.storage.local `detectionEnabled`

  async function queryActiveTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      if (!detectionOn) {
        showEmpty(DISABLED_TEXT);
        return;
      }
      if (!activeTab) activeTab = await queryActiveTab();
      if (!activeTab || typeof activeTab.id !== 'number') {
        showEmpty(EMPTY_TEXT);
        return;
      }
      if (isRestrictedUrl(activeTab.url)) {
        showEmpty(RESTRICTED_TEXT);
        return;
      }
      var state = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE', tabId: activeTab.id });
      // The switch may have been turned off while the request was in flight.
      if (!detectionOn) showEmpty(DISABLED_TEXT);
      else renderState(state);
    } catch (e) {
      // Service worker unavailable or tab gone: show the empty state.
      showEmpty(EMPTY_TEXT);
    } finally {
      refreshing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Detection switch
  // -------------------------------------------------------------------------

  function showDetectError(message) {
    setText(els['detect-error'], message || '');
    setHidden(els['detect-error'], !message);
  }

  async function loadDetectionState() {
    try {
      var items = await chrome.storage.local.get({ detectionEnabled: true });
      detectionOn = !items || items.detectionEnabled !== false;
      els['detect-toggle'].checked = detectionOn;
      showDetectError('');
    } catch (e) {
      showDetectError('无法读取检测设置');
    }
  }

  /** Applies a new switch value from the user or from storage.onChanged. */
  function applyDetection(enabled) {
    els['detect-toggle'].checked = enabled;
    if (enabled === detectionOn) return;
    detectionOn = enabled;
    if (enabled) {
      showEmpty(EMPTY_TEXT); // neutral text until the first data arrives
      refresh();
    } else {
      showEmpty(DISABLED_TEXT);
    }
  }

  async function onDetectToggleChange() {
    var checkbox = els['detect-toggle'];
    var wanted = !!checkbox.checked;
    try {
      await chrome.storage.local.set({ detectionEnabled: wanted });
      showDetectError('');
      applyDetection(wanted);
    } catch (e) {
      checkbox.checked = !wanted;
      showDetectError('保存设置失败，请重试');
    }
  }

  // -------------------------------------------------------------------------
  // OSD switch
  // -------------------------------------------------------------------------

  function showOsdError(message) {
    setText(els['osd-error'], message || '');
    setHidden(els['osd-error'], !message);
  }

  async function loadOsdState() {
    try {
      var items = await chrome.storage.local.get({ osdEnabled: true });
      els['osd-toggle'].checked = !items || items.osdEnabled !== false;
      showOsdError('');
    } catch (e) {
      showOsdError('无法读取悬浮面板设置');
    }
  }

  async function onOsdToggleChange() {
    var checkbox = els['osd-toggle'];
    var wanted = !!checkbox.checked;
    try {
      await chrome.storage.local.set({ osdEnabled: wanted });
      showOsdError('');
    } catch (e) {
      checkbox.checked = !wanted;
      showOsdError('保存设置失败，请重试');
    }
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  async function init() {
    bindElements();
    els['osd-toggle'].addEventListener('change', onOsdToggleChange);
    els['detect-toggle'].addEventListener('change', onDetectToggleChange);

    // Reflect changes made by the keyboard shortcut while the popup is open.
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes) return;
        if (changes.osdEnabled) els['osd-toggle'].checked = changes.osdEnabled.newValue !== false;
        if (changes.detectionEnabled) applyDetection(changes.detectionEnabled.newValue !== false);
      });
    } catch (e) {
      // Not critical.
    }

    await loadDetectionState();
    await loadOsdState();
    await refresh();
    timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener('unload', function () {
      if (timer !== null) clearInterval(timer);
      timer = null;
    });
  }

  init().catch(function () {
    // A popup error must not leave a blank panel.
    try {
      showEmpty(EMPTY_TEXT);
    } catch (e) {
      // Ignore.
    }
  });
})();
