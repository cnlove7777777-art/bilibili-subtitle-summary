'use strict';
// Feedback contains selected technical facts, never the raw log buffer.
// This module runs in both the service worker and the feedback page.
globalThis.BscgFeedback = Object.freeze({
  site(value) {
    try { const u = new URL(value); return /https?:/.test(u.protocol) ? u.hostname : u.protocol === 'file:' ? 'local-file' : ''; }
    catch { return ''; }
  },
  diagnostic(value) {
    const text = String(value || '');
    const name = text.match(/\b(ReferenceError|TypeError|RangeError|SyntaxError|NotAllowedError|SecurityError|NotSupportedError|AbortError)\b/)?.[1] || '';
    const symbol = text.match(/ReferenceError:\s*([A-Za-z_$][\w$]{0,60}) is not defined/)?.[1] || '';
    const component = text.match(/\b(asr-worker|qwen-webgpu-worker|browser-engine|universal|audio-worklet)\.js\b/)?.[1] || '';
    const category = /out.of.memory|内存不足|显存|\bOOM\b/i.test(text) ? 'memory' :
      /webgpu|gpu|adapter|device.lost/i.test(text) ? 'gpu' :
      /capture|音频流|取音|播放器|捕获/i.test(text) ? 'capture' :
      /fetch|network|下载|网络|HTTP/i.test(text) ? 'network' :
      /timeout|超时/i.test(text) ? 'timeout' : name ? 'runtime' : 'other';
    return { category, ...(name ? { name } : {}), ...(symbol ? { symbol } : {}), ...(component ? { component } : {}) };
  },
  report({ version, site, profile, backend, browser, logs = [], error = '' }) {
    const events = logs.filter(entry => ['warn', 'error'].includes(entry?.level)).slice(-8)
      .map(entry => ({ level: entry.level, ...BscgFeedback.diagnostic(entry.msg) }));
    if (error) events.push({ level: 'error', ...BscgFeedback.diagnostic(error) });
    return {
      version: String(version || '').slice(0, 32), site: BscgFeedback.site(site),
      model: ['sensevoice_browser', 'qwen3_asr_0_6b'].includes(profile) ? profile : 'unknown',
      backend: ['webgpu', 'wasm', 'auto'].includes(backend) ? backend : 'auto',
      browserMajor: String(browser || '').match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] || '',
      events: events.slice(-8)
    };
  },
  endpoint(value) {
    if (!value) return '';
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('反馈服务地址必须是无凭据的 HTTPS 地址');
    return url.href;
  }
});
