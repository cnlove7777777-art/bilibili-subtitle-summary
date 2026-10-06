'use strict';

function bscgPageAllowsControls(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (url.hostname === 'live.bilibili.com') return /^\/(?:blanc\/)?[1-9]\d*\/?$/.test(url.pathname);
    if (/^(?:www\.|m\.)?huya\.com$/i.test(url.hostname)) {
      return /^\/[\w-]+\/?$/.test(url.pathname) &&
        !/^\/(?:g|l|s|download|search|category|index|my)\/?$/i.test(url.pathname);
    }
  } catch {}
  return true;
}

// This function is also passed to chrome.scripting.executeScript. Keep it
// self-contained so the service worker and every player frame use one selector.
function bscgFindMedia(mode = 'clock') {
  const roots = [document];
  // Open shadow roots are used by podcast/web-component players. Cache their
  // discovery briefly: subtitle positioning runs much faster than DOM changes.
  const now = Date.now();
  const cache = document.__bscgMediaRoots;
  if (cache && now - cache.at < 2000) {
    roots.push(...cache.roots.filter(root => root.host?.isConnected));
  } else {
    for (let i = 0; i < roots.length; i += 1) {
      for (const node of roots[i].querySelectorAll('*')) {
        if (node.shadowRoot && !String(node.id || '').startsWith('bscg-')) roots.push(node.shadowRoot);
      }
    }
    document.__bscgMediaRoots = { at: now, roots: roots.slice(1) };
  }
  const candidates = [];
  const styles = new WeakMap();
  const previewSelector = '[data-hover-preview], [data-video-preview], .bili-live-card, .bili-video-card, ' +
    '.video-preview, .live-preview, .hover-preview, .preview-player';
  for (const root of roots) {
    for (const video of root.querySelectorAll('video, audio')) {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      const audio = video.tagName?.toLowerCase() === 'audio';
      const playing = !video.paused && !video.ended && video.readyState >= 2;
      const audible = !video.muted && Number(video.volume ?? 1) > 0;
      let hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.05 ||
        /opacity\(\s*(?:0(?:\.0+)?|0%)\s*\)/i.test(style.filter || '') || video.getAttribute('aria-hidden') === 'true';
      let preview = false;
      for (let node = video; node?.nodeType === 1; node = node.parentElement || node.getRootNode?.().host) {
        if (node.matches(previewSelector)) preview = true;
        const link = node.tagName === 'A' && node.hasAttribute('href') ? node :
          node.matches('.live-card, .room-card, .video-card') ? node.querySelector('a[href]') : null;
        if (!video.controls && link) {
          try {
            const target = new URL(link.href, location.href);
            const current = new URL(location.href);
            if (target.origin + target.pathname + target.search !== current.origin + current.pathname + current.search) preview = true;
          } catch {}
        }
        const ancestorStyle = styles.get(node) || getComputedStyle(node);
        styles.set(node, ancestorStyle);
        if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true' ||
            ancestorStyle.display === 'none' || /hidden|collapse/.test(ancestorStyle.visibility) ||
            Number(ancestorStyle.opacity) <= 0.05 || /opacity\(\s*(?:0(?:\.0+)?|0%)\s*\)/i.test(ancestorStyle.filter || '')) hidden = true;
      }
      // Card previews can be large, audible or report an infinite duration.
      // Their DOM role, rather than mute state or duration, distinguishes them.
      if (preview || (mode === 'controls' && !audio && hidden)) continue;
      const drawable = !audio && !hidden && rect.width >= 120 && rect.height >= 90;
      const visible = drawable && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      // Hidden/zero-size audio is normal for podcast players. Ignore idle hidden
      // preload elements; a playing audible source is an explicit media signal.
      if (!drawable && !(playing && audible) && !(audio && video.controls && !hidden)) continue;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const score = (playing && audible ? 4e12 : playing ? 2e12 : 0) +
        (video.duration === Infinity ? 1e12 : duration >= 45 ? 4e11 : 0) +
        (visible ? 1e9 : 0) + Math.max(0, rect.width) * Math.max(0, rect.height);
      candidates.push({ video, rect, drawable, visible, playing, audible, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (mode === 'all' || mode === 'controls') return candidates;
  const best = candidates[0];
  if (mode === 'element') return best || null;
  if (!best) return null;
  const video = best.video;
  return {
    currentTime: Math.max(0, Number(video.currentTime) || 0),
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    isLive: video.duration === Infinity,
    paused: Boolean(video.paused), playbackRate: Number(video.playbackRate) || 1,
    preservesPitch: video.preservesPitch,
    kind: video.tagName?.toLowerCase() === 'audio' ? 'audio' : 'video',
    width: best.rect.width, height: best.rect.height, score: best.score
  };
}
