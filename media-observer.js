'use strict';

// Runs in the page's MAIN world from document_start. Performance entries are
// allowed to roll out of the browser buffer, so retain only the small set of
// media URLs needed by the full-track resolver.
(() => {
  if (window.__BROWSER_SENSEVOICE_MEDIA_OBSERVER__) return;
  window.__BROWSER_SENSEVOICE_MEDIA_OBSERVER__ = true;
  Object.defineProperty(window, '__BROWSER_SENSEVOICE_INITIAL_PAGE__', { value: location.href });

  const records = [];
  const playurlRecords = [];
  const seen = new Set();
  const isFragment = (url) => /\.(?:m4s|cmfa|cmfv|ts)(?:$|[?#])/i.test(url);
  const mediaFile = (url) => /\.(?:mp4|m4a|m4v|mov|webm|mp3|aac|ogg|opus|flac|wav)(?:$|[?#])/i.test(url);
  const isBilibiliPlayurl = (value) => {
    try {
      const url = new URL(String(value || ''), location.href);
      return /(^|\.)bilibili\.com$/i.test(url.hostname) && /\/x\/player\/(?:wbi\/)?playurl$/i.test(url.pathname);
    } catch {
      return false;
    }
  };
  const isInteresting = (value) => {
    const url = String(value || '');
    return /\.(?:m3u8|mpd)(?:$|[?#])/i.test(url) || isFragment(url) || mediaFile(url) ||
      /(?:^|\.)googlevideo\.com\/videoplayback/i.test(url);
  };
  const remember = (value, kind = '') => {
    try {
      const url = new URL(String(value || ''), location.href).href;
      if (!/^https?:/i.test(url) || (!kind && !isInteresting(url))) return;
      if (!kind) {
        if (/\.m3u8(?:$|[?#])/i.test(url)) kind = 'hls';
        else if (/\.mpd(?:$|[?#])/i.test(url)) kind = 'dash';
        else kind = isFragment(url) ? 'fragment' : 'media';
      }
      if (kind === 'media' && isFragment(url)) kind = 'fragment';
      const key = `${kind}\n${url}`;
      if (seen.has(key)) return;
      seen.add(key);
      records.push({ url, kind, at: performance.now() });
      while (records.length > 240) {
        const removed = records.shift();
        seen.delete(`${removed.kind}\n${removed.url}`);
      }
    } catch {
      // Invalid or opaque URLs are not useful to the direct-track reader.
    }
  };

  Object.defineProperty(window, '__BROWSER_SENSEVOICE_MEDIA_URLS__', {
    configurable: false,
    enumerable: false,
    get: () => records.slice()
  });

  const rememberPlayurl = (requestUrl, payload, requestedPage = location.href) => {
    try {
      const request = new URL(String(requestUrl || ''), location.href);
      const data = payload?.data;
      if (!isBilibiliPlayurl(request.href) || payload?.code !== 0 || !data) return;
      const pageBvid = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || '';
      const page = new URL(requestedPage);
      if (page.pathname !== location.pathname || page.searchParams.get('p') !== new URL(location.href).searchParams.get('p')) return;
      const bvid = String(request.searchParams.get('bvid') || data.bvid || pageBvid || '');
      const cid = String(request.searchParams.get('cid') || data.cid || '');
      if (!bvid || !cid || (pageBvid && bvid !== pageBvid)) return;
      playurlRecords.push({ bvid, cid, data, pageNumber: Math.max(1, Number(page.searchParams.get('p')) || 1), url: request.href, at: performance.now() });
      while (playurlRecords.length > 12) playurlRecords.shift();
    } catch {
      // A malformed or non-JSON response is not useful to the resolver.
    }
  };

  Object.defineProperty(window, '__BROWSER_SENSEVOICE_PLAYURLS__', {
    configurable: false,
    enumerable: false,
    get: () => playurlRecords.slice()
  });

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) remember(entry.name);
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    // Resource Timing is an optimization; DOM/player state remains available.
  }

  // Extensionless manifests cannot be identified from their URL. Preserve
  // fetch semantics and inspect only the returned Content-Type.
  try {
    const nativeFetch = window.fetch;
    window.fetch = function browserSenseVoiceFetch(...args) {
      const requestUrl = args[0]?.url || args[0];
      const requestedPage = location.href;
      remember(requestUrl);
      return nativeFetch.apply(this, args).then((response) => {
        const type = response.headers?.get('content-type') || '';
        if (/mpegurl/i.test(type)) remember(response.url || requestUrl, 'hls');
        else if (/dash\+xml/i.test(type)) remember(response.url || requestUrl, 'dash');
        else if (/^audio\//i.test(type)) remember(response.url || requestUrl, isFragment(response.url || requestUrl) ? 'audio-fragment' : 'media');
        else if (/^video\//i.test(type)) remember(response.url || requestUrl, 'media');
        if (isBilibiliPlayurl(response.url || requestUrl)) {
          void response.clone().json().then((payload) => rememberPlayurl(response.url || requestUrl, payload, requestedPage)).catch(() => {});
        }
        return response;
      });
    };
  } catch {
    // Some hardened pages freeze window.fetch.
  }

  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function browserSenseVoiceOpen(method, url, ...rest) {
      const requestedPage = location.href;
      remember(url);
      this.addEventListener('load', () => {
        try {
          const responseUrl = this.responseURL || url;
          const type = this.getResponseHeader('content-type') || '';
          if (/mpegurl/i.test(type)) {
            remember(this.responseURL || url, 'hls');
          } else if (/dash\+xml/i.test(type)) {
            remember(this.responseURL || url, 'dash');
          } else if (/^audio\//i.test(type)) {
            remember(responseUrl, isFragment(responseUrl) ? 'audio-fragment' : 'media');
          } else if (/^video\//i.test(type)) {
            remember(responseUrl, 'media');
          }
          if (isBilibiliPlayurl(responseUrl)) {
            const payload = typeof this.response === 'object' && this.response
              ? this.response
              : JSON.parse(String(this.responseText || ''));
            rememberPlayurl(responseUrl, payload, requestedPage);
          }
        } catch {
          // Cross-origin response metadata may be unavailable to the page.
        }
      }, { once: true });
      return nativeOpen.call(this, method, url, ...rest);
    };
  } catch {
    // XHR interception is best-effort only.
  }
})();
