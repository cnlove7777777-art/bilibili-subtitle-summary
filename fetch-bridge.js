'use strict';

// Isolated-world bridge installed in every frame. A page-world fetch keeps the
// exact frame origin, cookies and referrer required by many signed HLS CDNs.
(() => {
  if (window.__BROWSER_SENSEVOICE_FETCH_BRIDGE__) return;
  window.__BROWSER_SENSEVOICE_FETCH_BRIDGE__ = true;

  const armed = new Set();
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.marker !== 'BROWSER_SENSEVOICE_PAGE_FETCH_V1') return;
    const requestId = String(data.requestId || '');
    if (!armed.has(requestId) || !['start', 'chunk', 'end', 'error'].includes(data.type)) return;
    if (data.type === 'chunk' && (typeof data.data !== 'string' || data.data.length > 400000)) return;
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: `BILI_ASR_PAGE_FETCH_${String(data.type).toUpperCase()}`,
      requestId,
      data: data.data || '',
      loaded: Number(data.loaded) || 0,
      total: Number(data.total) || 0,
      contentType: String(data.contentType || ''),
      error: String(data.error || '')
    }).catch(() => {});
    if (data.type === 'end' || data.type === 'error') armed.delete(requestId);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'BILI_ASR_PAGE_FETCH_ARM') return false;
    const requestId = String(message.requestId || '');
    if (!requestId) {
      sendResponse({ ok: false });
      return false;
    }
    armed.add(requestId);
    setTimeout(() => armed.delete(requestId), 2 * 60 * 1000);
    sendResponse({ ok: true });
    return false;
  });
})();
