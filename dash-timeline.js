'use strict';

// A deliberately bounded VOD-only subset of MPEG-DASH SegmentTemplate.
// URL numbering uses unshifted sample timeline units; playback timestamps
// subtract presentationTimeOffset. Dynamic MPDs, DRM and ambiguous gaps fail
// closed and fall back to the original capture pipeline.
(() => {
  const child = (node, name) => [...(node?.children || [])].find(el => el.localName === name) || null;
  const children = (node, name) => [...(node?.children || [])].filter(el => el.localName === name);
  const attr = (node, key) => node?.getAttribute?.(key) ?? '';
  function positiveInteger(value, name, fallback = null) {
    if (value === '' && fallback !== null) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`DASH ${name} 不安全：${value}`);
    return number;
  }
  function nonnegativeInteger(value, name, fallback = null) {
    if (value === '' && fallback !== null) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`DASH ${name} 不安全：${value}`);
    return number;
  }
  function seconds(value) {
    if (!value) return 0;
    // ISO 8601 day/time portion used by MPD@mediaPresentationDuration.
    const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!match) throw new Error('DASH Period 时长格式不支持');
    return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 +
      Number(match[3] || 0) * 60 + Number(match[4] || 0);
  }
  function templateUrl(pattern, fields, base) {
    const escape = '\u0000';
    let text = String(pattern || '').replace(/\$\$/g, escape);
    text = text.replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d{1,2})d)?\$/g, (_, name, width) => {
      const value = String(fields[name] ?? '');
      if (!value || (width && (!/^\d+$/.test(value) || Number(width) > 16))) throw new Error(`DASH 模板变量无效：${name}`);
      return width ? value.padStart(Number(width), '0') : value;
    });
    if (/\$|\u0000/.test(text.replace(/\u0000/g, ''))) throw new Error('DASH 存在未识别的模板占位符');
    text = text.replace(/\u0000/g, '$');
    const url = new URL(text, base);
    if (!/^https?:$/.test(url.protocol)) throw new Error('DASH 音频分片 URL 协议不受支持');
    return url.href;
  }
  function resolveBase(manifestUrl, ancestry) {
    let base = manifestUrl;
    for (const node of ancestry) {
      const value = child(node, 'BaseURL')?.textContent?.trim();
      if (value) base = new URL(value, base).href;
    }
    return base;
  }
  function makePlaylist(document, manifestUrl, selection) {
    const mpd = document.documentElement;
    if (!mpd || mpd.localName !== 'MPD' || attr(mpd, 'type').toLowerCase() === 'dynamic') {
      throw new Error('只支持静态 DASH 点播清单');
    }
    const periods = children(mpd, 'Period');
    if (periods.length !== 1 || selection.period !== periods[0]) throw new Error('多 Period DASH 需使用实时捕获');
    const period = periods[0];
    if (seconds(attr(period, 'start')) > 0.01) throw new Error('DASH Period 非零起点暂不支持');
    const duration = seconds(attr(period, 'duration') || attr(mpd, 'mediaPresentationDuration'));
    if (!(duration > 0 && duration <= 21600)) throw new Error('DASH 缺少可靠的点播时长');
    const ancestry = [mpd, period, selection.adaptation, selection.representation];
    if (ancestry.some(el => child(el, 'SegmentList') || child(el, 'SegmentBase') || child(el, 'ContentProtection'))) {
      throw new Error('DASH SegmentList/SegmentBase/DRM 不属于模板读取模式');
    }
    const templates = ancestry.map(el => child(el, 'SegmentTemplate')).filter(Boolean);
    if (!templates.length) return null;
    const properties = {};
    let timeline = null;
    for (const tpl of templates) {
      for (const key of ['media', 'initialization', 'timescale', 'duration', 'startNumber', 'endNumber', 'presentationTimeOffset']) {
        if (tpl.hasAttribute(key)) properties[key] = attr(tpl, key);
      }
      if (child(tpl, 'SegmentTimeline')) timeline = child(tpl, 'SegmentTimeline');
    }
    if (!properties.media || !properties.initialization) throw new Error('DASH 模板缺少媒体或初始化 URL');
    if (!/^audio\/mp4$/i.test(selection.mimeType) || !/^mp4a\.40\.[25]$/i.test(selection.codecs)) {
      throw new Error('DASH 分片预读当前仅支持 MP4 AAC 音频');
    }
    const timescale = positiveInteger(properties.timescale || '1', 'timescale');
    const pto = nonnegativeInteger(properties.presentationTimeOffset || '0', 'presentationTimeOffset');
    const startNumber = positiveInteger(properties.startNumber || '1', 'startNumber');
    const base = resolveBase(manifestUrl, ancestry);
    const fields = { RepresentationID: attr(selection.representation, 'id'), Bandwidth: attr(selection.representation, 'bandwidth') };
    const initUrl = templateUrl(properties.initialization, fields, base);
    const initMap = { url: initUrl, key: null, range: null };
    const segments = [];
    let number = startNumber;
    const maxSegments = 50000;
    const put = (startUnit, durationUnits) => {
      const start = (startUnit - pto) / timescale;
      const end = (startUnit + durationUnits - pto) / timescale;
      if (!Number.isSafeInteger(startUnit + durationUnits) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error('DASH 分片时间戳无效');
      }
      const prior = segments.at(-1);
      if (prior && Math.abs(start - prior.end) > 0.05) throw new Error('DASH 分片时间线存在间隙或重叠');
      if (!prior && Math.abs(start) > 0.1) throw new Error('DASH 首个分片与点播起点无法对齐');
      if (segments.length >= maxSegments) throw new Error('DASH 分片超过 50000 安全限制');
      const url = templateUrl(properties.media, { ...fields, Number: number, Time: startUnit }, base);
      segments.push({ url, start: Math.max(0, start), end: Math.min(duration, end),
        duration: Math.max(0, Math.min(duration, end) - Math.max(0, start)),
        sequence: number, contextGroup: 1, discontinuity: 0, initMap, key: null, range: null });
      number++;
    };
    if (timeline) {
      let time = null;
      for (const element of children(timeline, 'S')) {
        const length = positiveInteger(attr(element, 'd'), 'S@d');
        if (element.hasAttribute('t')) time = nonnegativeInteger(attr(element, 't'), 'S@t');
        if (time === null) time = 0;
        const repeats = nonnegativeInteger(attr(element, 'r'), 'S@r', 0);
        if (repeats > maxSegments || segments.length + repeats >= maxSegments) throw new Error('DASH Timeline 重复次数超限');
        for (let i = 0; i <= repeats; i++) { put(time, length); time += length; }
      }
    } else {
      const length = positiveInteger(properties.duration || '', 'SegmentTemplate@duration');
      const expected = Math.ceil(duration * timescale / length);
      if (!Number.isSafeInteger(expected) || expected > maxSegments) throw new Error('DASH 固定时长分片数量过多');
      for (let i = 0; i < expected; i++) put(pto + i * length, length);
    }
    if (!segments.length || segments.some(segment => segment.duration <= 0)) throw new Error('DASH 没有有效的音频分片');
    const totalEnd = segments.at(-1).end;
    if (Math.abs(totalEnd - duration) > Math.max(1, Math.min(3, duration * 0.005))) {
      throw new Error('DASH 清单时长与分片时间轴不一致');
    }
    return { dash: true, playlistUrl: manifestUrl, master: false, endList: true, segments, mediaSequence: startNumber };
  }
  self.BrowserDash = Object.freeze({ makePlaylist });
})();
