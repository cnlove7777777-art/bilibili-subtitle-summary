(function () {
  'use strict';

  function captionDisplayRows(timeline, hold, holdUntil, preview, now, currentTime = Infinity, replayUntil = 0) {
    // Replaying a cached interval always wins over a late result from elsewhere.
    if (timeline?.content) return [{ ...timeline, provisional: false }];
    if (currentTime < replayUntil) return [];
    const finalRow = hold?.content && now < holdUntil && Number(hold.from) <= currentTime + 0.18 ? hold : null;
    if (preview && Number(preview.from) > currentTime + 0.18) preview = null;
    const draft = preview?.content && (!finalRow?.id || finalRow.id !== preview.id) &&
      (!finalRow || Number(preview.from) >= Number(finalRow.from) - 0.05) ? preview : null;
    if (draft?.singleLine && !finalRow) return [{ ...draft, provisional: true }];
    return [finalRow?.content ? { ...finalRow, provisional: false } : null,
      draft ? { ...draft, provisional: true } : null].filter(Boolean);
  }

  function paintCaptionRows(mount, displayRows) {
    mount.replaceChildren();
    for (const row of displayRows) {
      const cue = document.createElement('div');
      cue.className = row.provisional ? 'cue preview' : displayRows.length > 1 ? 'cue old' : 'cue';
      // 双语模式：译文是主行，识别原文作为字号更小的第二行；切换为"仅译文"后
      // 后台不再下发 sourceContent，这里自然退化成单行。
      if (row.sourceContent) {
        const main = document.createElement('span');
        main.className = 'cue-main';
        main.textContent = row.content;
        const source = document.createElement('span');
        source.className = 'cue-src';
        source.textContent = row.sourceContent;
        cue.append(main, source);
      } else {
        cue.textContent = row.content;
      }
      cue.style.maxWidth = '58ch';
      cue.style.overflowWrap = 'anywhere';
      if (!row.provisional && displayRows.length > 1) cue.style.marginBottom = '5px';
      mount.appendChild(cue);
    }
  }

  function finalCaptionHoldMs(text) {
    return Math.max(3500, Math.min(10000, Array.from(String(text)).length * 160));
  }

  function setCaptionSurfaceVisible(element, visible) {
    if (!element) return;
    element.classList.toggle('hidden', !visible);
    element.inert = !visible;
    element.setAttribute('aria-hidden', String(!visible));
  }

  function pageAllowsControls() {
    if (!bscgPageAllowsControls(location.href)) return false;
    if (window.top !== window) {
      try { return bscgPageAllowsControls(window.top.location.href); }
      catch { return !document.referrer || bscgPageAllowsControls(document.referrer); }
    }
    return true;
  }

  let scanCaptureHooks = null;
  // Install capture before either the iframe or duplicate-overlay early return.
  installInpageCapture();

  // 所有帧都安装自动连续扫描控制器。它只在整轨 URL 无法重放时启用，绝不随机
  // 跳段；扫描结束会完整恢复时间、倍速、音量、静音和播放状态。
  if (!window.__bscgBrowserScanController) {
    window.__bscgBrowserScanController = true;
    let scanState = null;
    const findScanVideo = () => [...document.querySelectorAll('video')].map((video) => {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const playing = !video.paused && !video.ended && video.readyState >= 2;
      const score = (duration >= 45 ? 1e12 : 0) + (playing ? 3e11 : 0) + rect.width * rect.height;
      const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.05 || video.getAttribute('aria-hidden') === 'true';
      return { video, duration, score, hidden, width: rect.width, height: rect.height };
    }).filter((item) => item.duration > 0 && !item.hidden && item.width >= 120 && item.height >= 90)
      .sort((a, b) => b.score - a.score)[0]?.video || null;
    const sendScan = (message) => {
      try { return chrome.runtime.sendMessage(message).catch(() => null); } catch { return Promise.resolve(null); }
    };
    const restoreScan = async (state) => {
      if (!state) return;
      if (state.restorePromise) return state.restorePromise;
      state.restoring = true;
      state.restorePromise = (async () => {
      clearInterval(state.timer);
      state.video.removeEventListener('ended', state.onEnded);
      state.video.removeEventListener('ratechange', state.onRateChange);
      // Flush and disconnect capture before the restoration seek can reset its
      // generation or replace the final phrase's media timestamps.
      await scanCaptureHooks?.stop(state.sessionId).catch(() => {});
      try { state.video.pause(); } catch {}
      try { state.video.currentTime = Math.max(0, Math.min(state.original.duration || Infinity, state.original.currentTime)); } catch {}
      try { state.video.playbackRate = state.original.playbackRate; } catch {}
      try { state.video.defaultPlaybackRate = state.original.defaultPlaybackRate; } catch {}
      try { state.video.preservesPitch = state.original.preservesPitch; } catch {}
      try { state.video.muted = state.original.muted; state.video.volume = state.original.volume; state.video.loop = state.original.loop; } catch {}
      if (!state.original.paused) {
        try { await state.video.play(); } catch {}
      }
      if (scanState === state) scanState = null;
      })();
      return state.restorePromise;
    };
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'BSCG_SCAN_PROBE') {
        const video = findScanVideo();
        sendResponse(video ? { ok: true, duration: video.duration, score: (video.duration >= 45 ? 1e12 : 0) + video.clientWidth * video.clientHeight } : { ok: false });
        return false;
      }
      if (message?.type === 'BSCG_SCAN_STOP') {
        const state = scanState;
        if (!state || (message.sessionId && message.sessionId !== state.sessionId)) return false;
        restoreScan(state).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
      }
      if (message?.type === 'BSCG_SCAN_PAUSE' || message?.type === 'BSCG_SCAN_RESUME') {
        const state = scanState;
        if (!state || state.restoring || (message.sessionId && message.sessionId !== state.sessionId)) return false;
        void (async () => {
          try {
            if (message.type === 'BSCG_SCAN_PAUSE') {
              state.video.pause();
            } else {
              if (state.restoring || state.ending) { sendResponse({ ok: true, ignored: true }); return; }
              state.video.defaultPlaybackRate = state.rate;
              state.video.playbackRate = state.rate;
              await state.video.play();
            }
            void sendScan({ type: 'BSCG_VIDEO_POSITION', sessionId: state.sessionId,
              currentTime: state.video.currentTime, duration: state.video.duration,
              playbackRate: state.video.playbackRate, preservesPitch: state.video.preservesPitch,
              paused: state.video.paused });
            sendResponse({ ok: true, paused: state.video.paused });
          } catch (error) {
            sendResponse({ ok: false, error: error?.message || String(error) });
          }
        })();
        return true;
      }
      if (message?.type !== 'BSCG_SCAN_START') return false;
      if (scanState) { sendResponse({ ok: false, error: '本帧已有自动扫描任务' }); return false; }
      const video = findScanVideo();
      if (!video) return false;
      let rate = Math.max(1, Math.min(8, Number(message.playbackRate) || 4));
      const state = {
        sessionId: String(message.sessionId || ''), video, rate, restoring: false, timer: 0,
        original: {
          currentTime: Number(video.currentTime) || 0, duration: Number(video.duration) || 0,
          playbackRate: Number(video.playbackRate) || 1, defaultPlaybackRate: Number(video.defaultPlaybackRate) || 1,
          preservesPitch: video.preservesPitch !== false,
          muted: Boolean(video.muted), volume: Number(video.volume), loop: Boolean(video.loop), paused: Boolean(video.paused)
        },
        onEnded: null, onRateChange: null
      };
      scanState = state;
      state.onRateChange = () => {
        if (!state.restoring && Math.abs(video.playbackRate - state.rate) > 0.05) {
          try { video.playbackRate = state.rate; } catch {}
        }
      };
      state.onEnded = () => {
        state.ending = true;
        clearInterval(state.timer);
        void (async () => {
          await scanCaptureHooks?.stop(state.sessionId).catch(() => {});
          await sendScan({ type: 'BSCG_SCAN_ENDED', sessionId: state.sessionId, duration: video.duration });
          await restoreScan(state);
        })();
      };
      video.addEventListener('ended', state.onEnded, { once: true });
      video.addEventListener('ratechange', state.onRateChange);
      void (async () => {
        try {
          video.pause();
          video.loop = false;
          video.muted = false;
          video.volume = 1;
          try { video.preservesPitch = false; } catch {}
          if (rate > 1 && video.preservesPitch !== false) rate = state.rate = 1;
          video.defaultPlaybackRate = rate;
          video.playbackRate = rate;
          if (video.currentTime > 0.15) {
            video.currentTime = 0;
            await new Promise((resolve) => {
              const done = () => resolve();
              video.addEventListener('seeked', done, { once: true });
              setTimeout(done, 2500);
            });
          }
          if (state.restoring) throw new Error('扫描已取消');
          const ready = await sendScan({ type: 'BSCG_SCAN_READY', sessionId: state.sessionId,
            currentTime: video.currentTime, duration: video.duration,
            playbackRate: video.playbackRate, preservesPitch: video.preservesPitch });
          if (!ready?.ok) throw new Error(ready?.error || '扫描识别任务未就绪');
          if (state.restoring) throw new Error('扫描已取消');
          scanCaptureHooks?.start(state.sessionId, rate);
          await video.play();
          if (video.playbackRate < rate * 0.8) throw new Error(`播放器把 ${rate}× 限制为 ${video.playbackRate}×`);
          if (state.restoring) throw new Error('扫描已取消');
          void sendScan({ type: 'BSCG_VIDEO_POSITION', sessionId: state.sessionId,
            currentTime: video.currentTime, duration: video.duration, playbackRate: video.playbackRate,
            preservesPitch: video.preservesPitch, paused: video.paused });
          state.timer = setInterval(() => {
            if (rate > 1 && video.preservesPitch !== false) {
              void sendScan({ type: 'BSCG_SCAN_ERROR', sessionId: state.sessionId,
                error: '播放器重新开启了保调，已停止倍速采集；请用 1× 重新识别' });
              clearInterval(state.timer);
              return;
            }
            void sendScan({
              type: 'BSCG_VIDEO_POSITION', sessionId: state.sessionId, currentTime: video.currentTime, duration: video.duration,
              playbackRate: video.playbackRate, preservesPitch: video.preservesPitch, paused: video.paused, wallTime: Date.now()
            });
            void sendScan({
              type: 'BSCG_SCAN_PROGRESS', sessionId: state.sessionId,
              currentTime: video.currentTime, duration: video.duration, playbackRate: video.playbackRate
            });
          }, 500);
          sendResponse({ ok: true, duration: video.duration, playbackRate: video.playbackRate,
            rateFallback: rate < Number(message.playbackRate) });
        } catch (error) {
          await restoreScan(state);
          sendResponse({ ok: false, error: error?.message || String(error) });
        }
      })();
      return true;
    });
  }

  // 顶层帧：承载视频画面左侧居中的竖长条入口（上"字幕"下"总结"）与整页字幕覆盖层。
  // 非顶层帧：不渲染任何入口；但如果本帧里有播放器视频，由 runIframeReporter
  // 承担播放位置上报与帧内字幕渲染，并通知顶层显示入口。
  if (window.top !== window) {
    runIframeReporter();
    return;
  }

  const CS_VERSION = '0.16.44'; // 与 manifest 版本握手，防止更新后旧页面静默调用旧后台
  let staleBg = false;        // 后台 service worker 版本落后于界面脚本（扩展更新后未重载）

  const DESTINATIONS = {
    chatgpt: { label: 'ChatGPT' },
    aistudio: { label: 'Gemini' },
    deepseek: { label: 'DeepSeek' }
  };

  // 已注入过则只唤醒悬浮窗（SPA 路由切换时脚本会重新执行）。
  const existing = document.getElementById('bscg-live-host');
  if (existing) {
    existing.dispatchEvent(new CustomEvent('bscg-reveal-controls'));
    return;
  }

  const host = document.createElement('div');
  host.id = 'bscg-live-host';
  Object.assign(host.style, {
    position: 'fixed', inset: '0', zIndex: '2147483646',
    pointerEvents: 'none', display: 'none'
  });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{all:initial;--ink:#243342;--sub:#7b8aa0;--line:#d7e6fa;--paper:#ffffff;--primary:#2f7cf6;--primary-deep:#1f66d6;--tint:#eaf3ff}
      button{font:700 12px/1.2 system-ui,"Microsoft YaHei",sans-serif}
      /* 左下角入口：折叠态只露出一小截色条，悬停色条（或键盘聚焦）才展开。
         折叠态 #dock 必须 pointer-events:none —— 否则整块预留区域（原 58×114）都会
         吃 hover，鼠标扫过"按钮原本占的位置"就自动展开，等于没折叠。 */
      #dock{position:fixed;left:0;top:50%;bottom:auto;transform:translateY(-50%);pointer-events:none;display:flex;flex-direction:column;width:40px;padding-left:8px;box-sizing:border-box;filter:drop-shadow(0 5px 11px rgba(47,124,246,.25))}
      #dock::before{content:"";position:absolute;left:2px;top:0;bottom:0;width:1.25px;border-radius:999px;background:linear-gradient(180deg,#70bbff,#2f7cf6 55%,#1f66d6);opacity:.85;transition:opacity .22s ease;pointer-events:none}
      /* 折叠态唯一可命中的区域：色条左右各留 2~3px 的透明条，够好点又不会覆盖到
         隐藏按钮的那一列（按钮列从 padding-left:8px 起）。 */
      #dock::after{content:"";position:absolute;left:0;top:0;bottom:0;width:11px;background:transparent;pointer-events:auto}
      #dock>button,#dock>#activity{opacity:0;transform:translateX(-6px);pointer-events:none;transition:opacity .22s ease,transform .22s ease}
      #dock:not(.expanded):not(:has(:focus-visible))>button,#dock:not(.expanded):not(:has(:focus-visible))>#activity{opacity:0!important}
      /* 悬停色条展开、或键盘聚焦时才恢复整块可交互，侧边菜单与卡片才有得悬停。 */
      #dock.expanded,#dock:has(:focus-visible){pointer-events:auto}
      #dock.expanded>button,#dock.expanded>#activity,#dock:has(:focus-visible)>button,#dock:has(:focus-visible)>#activity{opacity:1;transform:none;pointer-events:auto}
      #dock.expanded::before,#dock:has(:focus-visible)::before{opacity:0}
      #dock>#activity{width:32px}
      #menu::before,#translation-menu::before,#activity::after{content:"";position:absolute;left:100%;top:0;bottom:0;width:12px}
      #menu::before,#translation-menu::before{left:auto;right:100%}
      #translation-menu{position:absolute;left:46px;bottom:32px;width:150px;padding:8px;box-sizing:border-box;border:1px solid var(--line);border-radius:11px;background:var(--paper);color:var(--ink);box-shadow:0 10px 30px rgba(47,124,246,.2);font:10px/1.5 system-ui,sans-serif}
      #translation-menu[hidden]{display:none}
      #translation-menu .translation-title{font-weight:700;margin-bottom:4px}
      #translation-menu button{display:block;width:100%;margin-top:4px;padding:6px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);text-align:left;cursor:pointer}
      #translation-menu button[aria-pressed="true"]{background:var(--tint);border-color:var(--primary);color:var(--primary-deep)}
      #translation-note{margin-top:6px;color:var(--sub);font-size:9px}
      #dock>button{display:block;box-sizing:border-box;width:32px;height:32px;padding:0;border:1px solid var(--line);background:var(--paper);color:var(--primary);font:800 9px/1.2 system-ui,"Microsoft YaHei",sans-serif;letter-spacing:1px;text-indent:1px;cursor:pointer;transition:background .15s,color .15s,transform .1s}
      #cap-btn{border-radius:8px 8px 0 0;border-bottom:0}
      #sum-btn{border-radius:0 0 8px 8px;border-top:0}
      #dock>button:hover{background:var(--tint)}
      #dock>button:active{transform:translateY(1px)}
      #cap-btn.on{background:var(--primary);border-color:var(--primary);color:#fff}
      #sum-btn.cancel{background:#fff1f1;border-color:#efb6b6;color:#a33b3b}
      #cap-btn.busy,#sum-btn.busy{background:var(--tint);color:var(--primary);cursor:wait;opacity:.9}
      /* 总结悬停 1 秒弹出的侧边菜单 */
      #menu{position:absolute;left:46px;bottom:0;width:142px;box-sizing:border-box;padding:7px 8px;border:1px solid var(--line);border-radius:11px;background:var(--paper);color:var(--ink);box-shadow:0 10px 30px rgba(47,124,246,.2);opacity:0;visibility:hidden;transform:translateX(6px);transition:opacity .15s ease,transform .15s ease,visibility .15s;font:10px/1.45 system-ui,"Microsoft YaHei",sans-serif}
      #menu.open{opacity:1;visibility:visible;transform:none}
      #menu .menu-label{margin:2px 0 0;color:var(--sub);font-size:9px;font-weight:700}
      #menu .menu-dests{display:flex;gap:3px;margin-top:4px}
      #menu .menu-dests button{flex:1;margin:0;padding:4px 2px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);cursor:pointer;font:700 9px/1 system-ui,"Microsoft YaHei",sans-serif;transition:background .12s}
      #menu .menu-dests button:hover{background:var(--tint)}
      #menu .menu-dests button.active{background:var(--primary);border-color:var(--primary);color:#fff}
      #menu>button{display:block;width:100%;margin-top:4px;padding:6px 7px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);cursor:pointer;font:10px/1.2 system-ui,"Microsoft YaHei",sans-serif;text-align:left;transition:background .12s}
      #menu>button:hover{background:var(--tint)}
      #menu>button:disabled{opacity:.45;cursor:not-allowed}
      #menu-audio.active{border-color:#9fc2f4;background:var(--tint);color:var(--primary-deep)}
      /* 顶部三个点：与下面按钮同宽、独立四角圆角，悬停弹出最新日志 */
      #activity{position:relative;box-sizing:border-box;width:100%;height:13px;margin-bottom:3px;border:1px solid var(--line);border-radius:5px;background:var(--paper);color:var(--primary);opacity:1;visibility:visible;pointer-events:auto}
      #activity[data-state="busy"]{color:var(--primary-deep)}
      #activity[data-state="error"]{color:#c45b4d}
      #activity-log{display:flex;align-items:center;justify-content:center;gap:3px;box-sizing:border-box;width:100%;height:100%;border:0;padding:0;background:transparent;color:inherit;border-radius:inherit;cursor:pointer}
      #activity .dot{display:block;width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.3;animation:bscg-dot 1.5s ease-in-out infinite;animation-play-state:paused}
      #activity .dot:nth-child(2){animation-delay:.2s}#activity .dot:nth-child(3){animation-delay:.4s}
      #activity[data-state="busy"] .dot{animation-play-state:running}
      #activity-error{display:none;font:700 9px/1 system-ui,sans-serif}
      #activity[data-state="error"] .dot{display:none}#activity[data-state="error"] #activity-error{display:block}
      /* 悬停卡片：left 跟随长条实际占位，不再用固定偏移（固定值会因圆角/边距而看起来错位） */
      #activity-card{position:absolute;left:calc(100% + 8px);bottom:-1px;width:210px;max-height:150px;box-sizing:border-box;padding:7px 9px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);box-shadow:0 10px 30px rgba(47,124,246,.2);font:10.5px/1.5 system-ui,"Microsoft YaHei",sans-serif;overflow:hidden}
      #activity-card[hidden]{display:none}
      #activity-card .ac-title{display:flex;justify-content:space-between;gap:7px;margin-bottom:4px;color:var(--sub);font:700 9.5px/1 system-ui,"Microsoft YaHei",sans-serif;letter-spacing:.03em}
      #activity-card .ac-hint{font-weight:600}
      #activity-card ol{margin:0;padding:0;list-style:none}
      #activity-card li{display:flex;gap:5px;padding:2px 0;word-break:break-word}
      #activity-card li span.at{flex:0 0 46px;color:var(--sub);font:600 9.5px/1.5 ui-monospace,Consolas,monospace}
      #activity-card li span.tx{flex:1 1 auto;min-width:0}
      #activity-card li[data-level="warn"] span.tx{color:#9a6b1e}
      #activity-card li[data-level="error"] span.tx{color:#c45b4d}
      #activity-card ol:empty::after{content:"暂无进展";color:var(--sub)}
      @keyframes bscg-dot{0%,70%,100%{opacity:.3}35%{opacity:1}}
      #captions{position:fixed;box-sizing:border-box;text-align:center;pointer-events:none;color:#fff;font:600 24px/1.5 system-ui,"Microsoft YaHei",sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.35);transition:opacity .12s ease}
      #captions.hidden{opacity:0}#captions.hidden,#captions.hidden *{visibility:hidden!important;pointer-events:none!important}
      #caption-tools{position:relative;display:flex;width:max-content;margin:0 auto 6px;gap:1px;padding:3px 8px;border:0;border-radius:999px;background:rgba(15,23,42,.5);backdrop-filter:blur(6px);opacity:0;visibility:hidden;transform:translateY(3px);transition:opacity .15s,transform .15s;pointer-events:none;text-shadow:none}
      #captions:not(.hidden):hover #caption-tools::after{content:"";position:absolute;left:0;right:0;top:100%;height:6px;pointer-events:auto}
      #captions:not(.hidden):hover #caption-tools,#captions:not(.hidden) #caption-tools:focus-within{opacity:1;visibility:visible;pointer-events:auto;transform:none}#caption-tools button{border:0;background:transparent;color:rgba(255,255,255,.72);min-width:24px;padding:4px 5px;border-radius:6px;font:600 11px/1 system-ui,sans-serif;cursor:pointer;transition:color .12s,background .12s}#caption-tools button:hover{color:#fff;background:rgba(255,255,255,.14)}#caption-scale{align-self:center;min-width:32px;text-align:center;font:600 10.5px/1 system-ui,sans-serif;color:rgba(255,255,255,.6)}.tool-sep{align-self:stretch;width:1px;margin:2px 3px;background:rgba(255,255,255,.22)}
      #cue-mount{display:table;margin:0 auto;pointer-events:auto;cursor:grab;touch-action:none}#cue-mount.dragging{cursor:grabbing}.cue{display:table;margin:0 auto;padding:4px 14px 5px;border-radius:10px;background:rgba(12,18,28,.6);backdrop-filter:blur(5px);box-decoration-break:clone;-webkit-box-decoration-break:clone;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.35);white-space:pre-line}.cue.preview{opacity:.9;background:rgba(12,18,28,.52);outline:1px solid rgba(255,255,255,.16)}.cue.old{opacity:.72;font-size:.82em}.cue-main{display:block}.cue-src{display:block;margin-top:2px;font-size:.72em;font-weight:500;line-height:1.35;opacity:.78}
      #seek-preview{position:fixed;z-index:2147483647;box-sizing:border-box;max-width:320px;padding:6px 12px 7px;border-radius:10px;background:rgba(12,18,28,.72);backdrop-filter:blur(6px);color:#fff;font:600 12.5px/1.45 system-ui,"Microsoft YaHei",sans-serif;text-align:center;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.28);opacity:1;transition:opacity .1s}
      #seek-preview.hidden{opacity:0}
      #sp-time{display:block;font:700 10.5px/1 system-ui,sans-serif;letter-spacing:.04em;color:rgba(255,255,255,.65);margin-bottom:2px}
      #sp-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal}
      @media(max-width:620px){#dock{width:35px}#dock>button,#dock>#activity{width:27px}#dock>button{height:28px}#menu,#translation-menu{left:41px;width:129px}#captions{font-size:18px}}
      @media(prefers-reduced-motion:reduce){#dock::before,#dock>button,#dock>#activity,#menu,#captions{transition:none}#activity .dot{animation:none;opacity:.65}}
    </style>
    <div id="dock">
      <div id="activity" data-state="idle" role="status" aria-label="">
        <button id="activity-log" type="button" title="查看日志" aria-label="查看日志"><span class="dot" aria-hidden="true"></span><span class="dot" aria-hidden="true"></span><span class="dot" aria-hidden="true"></span><span id="activity-error" aria-hidden="true">!</span></button>
        <div id="activity-card" hidden role="status" aria-live="polite">
          <div class="ac-title"><span>最新进展</span><span class="ac-hint">点击查看全部日志</span></div>
          <ol id="activity-lines"></ol>
        </div>
      </div>
      <button id="cap-btn" type="button" aria-pressed="false" aria-haspopup="true" aria-expanded="false" title="点击开启/关闭字幕；悬停 1 秒设置当前视频翻译">字幕</button>
      <button id="sum-btn" type="button" aria-haspopup="true" aria-expanded="false" title="点击准备总结；字幕与提示词就绪后，由你在 AI 页面确认发送">总结</button>
      <div id="translation-menu" hidden aria-label="当前视频翻译">
        <div class="translation-title">当前视频字幕翻译</div>
        <button type="button" data-translation="inherit" aria-pressed="true">跟随全局设置</button>
        <button type="button" data-translation="on" aria-pressed="false">翻译</button>
        <button type="button" data-translation="off" aria-pressed="false">不翻译</button>
        <button type="button" id="translation-speed">单句翻译测速</button>
        <div id="translation-note">仅影响当前视频，不修改全局设置</div>
      </div>
      <div id="menu" role="menu" aria-label="字幕助手选项">
        <div class="menu-label">总结准备到</div>
        <div class="menu-dests">
          <button type="button" data-dest="chatgpt">ChatGPT</button>
          <button type="button" data-dest="aistudio">Gemini</button>
          <button type="button" data-dest="deepseek">DeepSeek</button>
        </div>
        <button id="menu-genfile" type="button" title="完整转写当前视频并回显，可导出 SRT；不打开 AI 页面">生成字幕文件</button>
        <button id="menu-export" type="button" disabled>导出 SRT</button>
        <button id="menu-clear" type="button" title="删除当前页已缓存的结果并停止本页任务；之后生成/总结都会按当前设置重新识别">清除缓存</button>
        <button id="menu-audio" type="button" title="切换远场音频控制；强度在完整设置中选择">远场控制：关</button>
        <button id="menu-logs" type="button">日志</button>
        <button id="menu-feedback" type="button">反馈问题</button>
        <button id="menu-settings" type="button">完整设置</button>
      </div>
    </div>
    <div id="captions" class="hidden" inert aria-hidden="true" aria-live="polite">
      <div id="caption-tools" aria-label="字幕显示设置">
        <button id="caption-smaller" type="button" title="缩小字幕">A−</button>
        <span id="caption-scale">100%</span>
        <button id="caption-larger" type="button" title="放大字幕">A+</button>
        <span class="tool-sep" aria-hidden="true"></span>
        <button id="caption-reset" type="button" title="恢复默认位置">复位</button>
      </div>
      <div id="cue-mount" title="拖动字幕可调整位置"></div>
    </div>
    <div id="seek-preview" class="hidden" aria-hidden="true"><span id="sp-time"></span><span id="sp-text"></span></div>`;
  document.documentElement.appendChild(host);

  const dock = root.querySelector('#dock');
  const translationMenu = root.querySelector('#translation-menu');
  const translationNote = root.querySelector('#translation-note');
  const capBtn = root.querySelector('#cap-btn');
  const sumBtn = root.querySelector('#sum-btn');
  const menu = root.querySelector('#menu');
  const menuGenFile = root.querySelector('#menu-genfile');
  const menuExport = root.querySelector('#menu-export');
  const menuClear = root.querySelector('#menu-clear');
  const menuAudio = root.querySelector('#menu-audio');
  const menuSettings = root.querySelector('#menu-settings');
  const menuDestButtons = [...menu.querySelectorAll('.menu-dests button')];
  const captions = root.querySelector('#captions');
  const cueMount = root.querySelector('#cue-mount');
  const captionScaleLabel = root.querySelector('#caption-scale');
  const activity = root.querySelector('#activity');
  const seekPreview = root.querySelector('#seek-preview');
  const spTime = root.querySelector('#sp-time');
  const spText = root.querySelector('#sp-text');

  // ---- 常驻进度条：顶部三个点，悬停即可看到最新进展，不必点开日志页 ----
  const activityCard = root.querySelector('#activity-card');
  const activityLines = root.querySelector('#activity-lines');
  const activityBar = root.querySelector('#activity');
  const recentLogs = [];
  const RECENT_LOG_MAX = 40;
  const ACTIVITY_CARD_LINES = 3;
  let activityHideTimer = null;

  function activityTime(at) {
    try {
      return new Date(Number(at) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    } catch { return ''; }
  }

  // 最新进展放最上面：进度条只展示最近几条，悬停时一眼看到刚刚发生了什么。
  // render 可注入，便于在不依赖 DOM 的情况下验证缓冲行为。
  function recordActivity(level, text, render = renderActivityCard) {
    const detail = String(text || '').trim();
    if (!detail) return;
    const previous = recentLogs[recentLogs.length - 1];
    if (previous && previous.text === detail) return; // 同一条状态重复推送不占位
    recentLogs.push({ at: Date.now(), level: level === 'error' || level === 'warn' ? level : 'info', text: detail });
    if (recentLogs.length > RECENT_LOG_MAX) recentLogs.splice(0, recentLogs.length - RECENT_LOG_MAX);
    render();
  }

  // 卡片只显示最近几条，顺序为由新到旧；纯函数，便于测试。
  function activityCardLines(entries, limit = ACTIVITY_CARD_LINES) {
    return entries.slice(-limit).reverse();
  }

  function renderActivityCard() {
    const latest = activityCardLines(recentLogs);
    activityLines.replaceChildren(...latest.map((entry) => {
      const item = document.createElement('li');
      item.dataset.level = entry.level;
      const time = document.createElement('span');
      time.className = 'at';
      time.textContent = activityTime(entry.at);
      const text = document.createElement('span');
      text.className = 'tx';
      text.textContent = entry.text;
      item.append(time, text);
      return item;
    }));
  }

  function showActivityCard() {
    if (activityHideTimer) { clearTimeout(activityHideTimer); activityHideTimer = null; }
    renderActivityCard();
    activityCard.hidden = false;
  }

  // 留一点延迟再收起，方便鼠标从三个点移到卡片上继续读。
  function scheduleHideActivityCard() {
    if (activityHideTimer) clearTimeout(activityHideTimer);
    activityHideTimer = setTimeout(() => {
      activityHideTimer = null;
      activityCard.hidden = true;
    }, 160);
  }

  const rows = [];
  const MAX_ROWS = 20000;
  let activeVideo = null;
  let running = false;
  let overlayOnTop = false;
  let frameHasVideo = false; // 播放器 iframe 已报告本页有视频（顶层看不到跨域 iframe 里的 video）
  const frameMediaPresence = new Map();
  let captionsVisible = false;
  let currentSessionId = '';
  let liveMode = '';
  let lastCueText = '';
  let captureHoldRow = null;
  let captureHoldUntil = 0;
  let replayUntil = 0;
  let livePreviewRow = null;
  let livePreviewRevision = 0;
  let livePreviewTypingTimer = 0;
  let autoResumeAfterSwitch = false;
  const finalizedPreviewIds = new Set();
  let currentPageIdentity = pageIdentity();
  let ignoreLiveMessages = false;
  let awaitingNewSession = false;
  let lastPositionReportAt = 0;
  let pageHydrationTimer = 0;
  let pageHydrationDeadline = 0;
  let activityError = false;
  let lastStatusLog = '';
  let captionsDismissed = false;
  let captionActionVersion = 0;
  let finishedCaptionSessionId = '';
  let menuTimer = 0;
  let voiceEnhanceEnabled = false;
  let voiceEnhancePreset = 'balanced';
  let transitioning = false;
  let captionCancelRequested = false;
  let summarizing = false;
  let summaryTaskId = '';
  let summaryRequestId = '';
  let summaryCancelRequested = false;
  const finishedTaskIds = new Set();
  let fileGenerating = false;
  let currentDestination = 'chatgpt';
  let captionScale = 1;
  let captionOffsetX = 0;
  let captionOffsetY = 0;
  let captionPreferenceTimer = 0;
  let autoStartAttempted = ''; // 当前页面已尝试过"自动字幕"，每个视频只问一次
  let autoStartFailedFor = ''; // 自动字幕启动失败的视频：不再自动重试，手动点「字幕」才重试
  let uploadedLocalFileToken = '';
  let uploadedLocalFileName = '';
  const boundVideos = new WeakSet();

  function localBytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
    }
    return btoa(binary);
  }

  async function storeLocalFileViaBridge(file, token) {
    const authorization = await sendRuntime({ type: 'BSCG_LOCAL_FILE_AUTHORIZE', token, size: file.size });
    if (!authorization?.ok) throw new Error(authorization?.error || '无法授权本地媒体桥');
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('local-file-bridge.html');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed!important;width:1px!important;height:1px!important;left:-10000px!important;top:-10000px!important;border:0!important;opacity:0!important;pointer-events:none!important';
    document.documentElement.appendChild(iframe);
    try {
      await new Promise((resolve, reject) => {
        let sent = false;
        const timeout = setTimeout(() => finish(new Error('本地媒体桥响应超时')), 30000);
        const finish = (error) => {
          clearTimeout(timeout);
          removeEventListener('message', onMessage);
          if (error) reject(error);
          else resolve();
        };
        const sendFile = () => {
          if (sent || !iframe.contentWindow) return;
          sent = true;
          iframe.contentWindow.postMessage({ marker: 'BSCG_LOCAL_FILE_STORE_V1', token, file }, '*');
        };
        const onMessage = (event) => {
          if (event.source !== iframe.contentWindow) return;
          const data = event.data;
          if (data?.marker === 'BSCG_LOCAL_FILE_BRIDGE_READY_V1') {
            sendFile();
            return;
          }
          if (data?.marker !== 'BSCG_LOCAL_FILE_STORE_RESULT_V1' || data.token !== token) return;
          finish(data.ok ? null : new Error(data.error || '本地文件写入失败'));
        };
        addEventListener('message', onMessage);
        iframe.addEventListener('load', () => setTimeout(sendFile, 0), { once: true });
        iframe.addEventListener('error', () => finish(new Error('无法载入本地媒体桥')), { once: true });
      });
    } finally {
      iframe.remove();
    }
  }

  async function prepareLocalFileToken() {
    if (location.protocol !== 'file:') return '';
    if (uploadedLocalFileToken) return uploadedLocalFileToken;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,audio/*,.mp4,.m4v,.webm,.mkv,.mov,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus';
    input.style.display = 'none';
    document.documentElement.appendChild(input);
    const filePromise = new Promise((resolve) => {
      let settled = false;
      let focusTimer = 0;
      const finish = (file) => {
        if (settled) return;
        settled = true;
        clearTimeout(focusTimer);
        removeEventListener('focus', onFocus);
        resolve(file || null);
      };
      const onFocus = () => {
        focusTimer = setTimeout(() => finish(input.files?.[0] || null), 400);
      };
      input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true });
      addEventListener('focus', onFocus, { once: true });
    });
    input.click();
    const file = await filePromise;
    input.remove();
    // null 明确表示用户取消了本地文件授权；调用方必须保持为无副作用退出，
    // 不能把它误当成“没有直取地址”而继续启动页面扫描/音频接管。
    if (!file) return null;
    if (!file.size || file.size > 512 * 1024 * 1024) {
      showFeedback('本地文件超过 512 MiB，改用连续播放捕获后备', 5000, true);
      return '';
    }
    const token = crypto.randomUUID();
    try {
      setStatus('正在把本地文件交给浏览器媒体缓存…');
      await storeLocalFileViaBridge(file, token);
      uploadedLocalFileToken = token;
      uploadedLocalFileName = file.name;
      showFeedback(`已读取本地文件：${file.name}`, 2600);
      return token;
    } catch (bridgeError) {
      console.warn('[BSCG] Blob 媒体桥不可用，回退分块兼容通道', bridgeError);
      setStatus('浏览器媒体桥不可用，正在使用兼容读取…');
    }
    let response = await sendRuntime({
      type: 'BSCG_LOCAL_FILE_BEGIN', token, name: file.name, size: file.size, mimeType: file.type || ''
    });
    if (!response?.ok) throw new Error(response?.error || '无法开始读取本地文件');
    const chunkSize = 192 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
      response = await sendRuntime({ type: 'BSCG_LOCAL_FILE_CHUNK', token, data: localBytesToBase64(bytes) });
      if (!response?.ok) throw new Error(response?.error || '本地文件传输失败');
      if (offset === 0 || offset + chunkSize >= file.size || Math.floor(offset / chunkSize) % 16 === 0) {
        const percent = Math.min(100, Math.round((offset + bytes.byteLength) / file.size * 100));
        setStatus(`正在读取本地文件：${percent}%`);
      }
    }
    response = await sendRuntime({ type: 'BSCG_LOCAL_FILE_END', token });
    if (!response?.ok) throw new Error(response?.error || '本地文件传输不完整');
    uploadedLocalFileToken = token;
    uploadedLocalFileName = file.name;
    showFeedback(`已读取本地文件：${file.name}`, 2600);
    return token;
  }

  // 扩展重载/更新后，旧页面的 content script 上下文会失效：chrome.runtime 变为
  // undefined，继续轮询只会每 300–800ms 抛一次 TypeError。检测到失效后停掉
  // 所有定时器并静默退出，等页面刷新后由新脚本接管。
  let contextInvalid = false;
  function extensionAlive() {
    if (contextInvalid) return false;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      contextInvalid = true;
      try { host.style.display = 'none'; } catch {}
      return false;
    }
    return true;
  }
  const noteContextError = (error) => {
    if (/Extension context invalidated|reloaded|invalidated/i.test(String(error?.message || error))) {
      contextInvalid = true;
      try { host.style.display = 'none'; } catch {}
      return true;
    }
    return false;
  };
  const sendRuntime = (message) => {
    if (!extensionAlive()) return Promise.resolve(undefined);
    try {
      // 上下文失效时 sendMessage 会同步抛错，而不是返回 rejected promise
      return chrome.runtime.sendMessage(message).catch((error) => {
        noteContextError(error);
        return undefined;
      });
    } catch (error) {
      noteContextError(error);
      return Promise.resolve(undefined);
    }
  };

  // Status detail stays in the diagnostic log; it never changes dock geometry.
  function setStatus(text) {
    logUiStatus(text);
  }

  function genericPageIdentity(value) {
    const url = new URL(value || location.href);
    url.hash = '';
    const transient = /^(?:utm_.+|spm|spm_id_from|share_.+|feature|si|pp|ref|referrer|source|from|autoplay|start|t|time_continue)$/i;
    for (const key of [...url.searchParams.keys()]) {
      if (transient.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  }

  function pageIdentity() {
    try {
      const url = new URL(location.href);
      if (url.hostname === 'live.bilibili.com') {
        const room = url.pathname.match(/^\/(?:blanc\/)?([1-9]\d*)\/?$/)?.[1];
        return room ? `bilibili-live:${room}` : `bilibili-live:index:${url.pathname}`;
      }
      if (/(^|\.)bilibili\.com$/i.test(url.hostname)) {
        const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || '';
        const page = Math.max(1, Number(url.searchParams.get('p')) || 1);
        return `bilibili:${bvid}:p${page}`;
      }
      if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
        const videoId = url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
        return `youtube:${videoId}`;
      }
      return `url:${genericPageIdentity(url.href)}`;
    } catch {
      return `url:${location.href}`;
    }
  }

  function clearCueState() {
    replayUntil = 0;
    stopLivePreviewTyping();
    rows.length = 0;
    lastCueText = '';
    captureHoldRow = null;
    captureHoldUntil = 0;
    livePreviewRow = null;
    livePreviewRevision = 0;
    cueMount.replaceChildren();
    setupSeekPreviewFor(null);
    refreshExportState();
  }

  function resetForPageChange(nextIdentity) {
    clearTimeout(translationHoverTimer);
    setTranslationMenuOpen(false);
    captionActionVersion += 1;
    captionsDismissed = false;
    activityError = false;
    finishedCaptionSessionId = '';
    currentPageIdentity = nextIdentity;
    currentSessionId = '';
    liveMode = '';
    frameHasVideo = false;
    frameMediaPresence.clear();
    overlayOnTop = false;
    ignoreLiveMessages = true;
    awaitingNewSession = false;
    captionCancelRequested = true;
    summaryCancelRequested = true;
    summarizing = false;
    summaryRequestId = '';
    setSummaryTask('');
    sumBtn.classList.remove('busy');
    clearCueState();
    setRunning(false);
    setCaptionVisibility(false);
    setStatus('检测到新视频，点击"字幕"重新生成');
    void sendRuntime({ type: 'BSCG_LIVE_STOP' });
    schedulePageHydration();
  }

  function schedulePageHydration() {
    clearTimeout(pageHydrationTimer);
    pageHydrationDeadline = Date.now() + 15000;
    const retry = async () => {
      try {
        if (await hydrateLiveState(false)) return;
      } catch {}
      if (Date.now() < pageHydrationDeadline) pageHydrationTimer = setTimeout(retry, 600);
    };
    pageHydrationTimer = setTimeout(retry, 400);
  }

  function checkPageIdentity() {
    const nextIdentity = pageIdentity();
    if (nextIdentity !== currentPageIdentity) resetForPageChange(nextIdentity);
  }

  function visibleVideo() {
    if (!pageAllowsControls()) return null;
    const candidates = bscgFindMedia('controls');
    return candidates.find((candidate) => candidate.visible) || candidates[0] || null;
  }

  function captionRect(candidate) {
    if (candidate?.drawable && candidate?.visible !== false) return candidate.rect;
    // Audio-only players and tab audio use a stable viewport-sized caption area.
    const width = Math.min(960, Math.max(240, innerWidth - 32));
    const left = (innerWidth - width) / 2;
    return { left, top: 0, right: left + width, bottom: innerHeight, width, height: innerHeight };
  }

  // Fixed dock: keep the compact launcher vertically centered on the left edge.
  // Clear the old inline bottom offset as well, so an extension hot-update cannot
  // leave a page stuck at the previous lower-left position.
  function positionDock() {
    if (dock.style.top !== '50%') dock.style.top = '50%';
    if (dock.style.bottom) dock.style.bottom = '';
  }

  // “自动字幕”：页面出现视频后按设置自动开始本地字幕。每个视频只询问一次；
  // 用户已手动操作、已在生成或后台判定不需要时保持安静；启动失败不打扰浏览。
  function maybeAutoStart() {
    if (!pageAllowsControls() || document.hidden || staleBg || (captionsDismissed && !autoResumeAfterSwitch) || running ||
        (rows.length && !autoResumeAfterSwitch) || captionsVisible || awaitingNewSession || transitioning) return;
    if (autoStartAttempted === currentPageIdentity) return;
    if (autoStartFailedFor === currentPageIdentity) return; // 本次视频已失败：不再自动重试，避免“错误→正在捕获→错误”循环
    if (!visibleVideo() && !frameHasVideo) return;
    autoStartAttempted = currentPageIdentity;
    setTimeout(async () => {
      if (document.hidden) { autoStartAttempted = ''; return; }
      if (staleBg || (captionsDismissed && !autoResumeAfterSwitch) || !extensionAlive() || running ||
          (rows.length && !autoResumeAfterSwitch) || captionsVisible || transitioning) return;
      try {
        const response = await sendRuntime({ type: 'BSCG_AUTO_START_CHECK', pageUrl: location.href });
        if (!response?.ok || !response.autoStart) return;
        if (document.hidden || (captionsDismissed && !autoResumeAfterSwitch) || running ||
            (rows.length && !autoResumeAfterSwitch) || captionsVisible || transitioning) return;
        await startRecognition(true);
        showFeedback('已按设置自动开启字幕', 3000);
      } catch {
        autoStartFailedFor = currentPageIdentity; // 失败是终态：用户手动点「字幕」才重试
        setCaptionVisibility(false);
      }
    }, 650);
  }

  function positionCaptions() {
    if (!pageAllowsControls()) {
      host.style.display = 'none';
      activeVideo = null;
      setCaptionSurfaceVisible(captions, false);
      setupSeekPreviewFor(null);
      return;
    }
    for (const [frameId, seenAt] of frameMediaPresence) {
      if (Date.now() - seenAt > 32000) frameMediaPresence.delete(frameId);
    }
    frameHasVideo = frameMediaPresence.size > 0;
    const candidate = visibleVideo();
    activeVideo = candidate?.video || null;
    // 视频可能在跨域 iframe 里（顶层看不到 <video>）：只要任一帧报告了视频、
    // 或字幕会话正在进行、或已有结果，就保留入口；有进度时也保留，
    // 这样顶部的进度条（三个点）随时可悬停查看最新日志。
    const display = (candidate || frameHasVideo || running || rows.length || transitioning || awaitingNewSession || summarizing || fileGenerating || summaryTaskId || recentLogs.length) ? 'block' : 'none';
    if (host.style.display !== display) host.style.display = display;
    positionDock();
    maybeAutoStart();
    setupSeekPreviewFor(candidate?.video || null);
    if (!candidate && !overlayOnTop && (frameHasVideo || liveMode !== 'live')) {
      // A player frame renders its own captions unless tab audio owns the overlay.
      setCaptionSurfaceVisible(captions, false);
      return;
    }
    setCaptionSurfaceVisible(captions, captionsVisible);
    if (candidate && !boundVideos.has(candidate.video)) {
      boundVideos.add(candidate.video);
      candidate.video.addEventListener('seeked', () => {
        if (candidate.video !== activeVideo || liveMode === 'live') return;
        replayUntil = Math.max(0, ...rows.map(row => Number(row.to) || 0));
        captureHoldRow = null;
        captureHoldUntil = 0;
        stopLivePreviewTyping();
        livePreviewRow = null;
        livePreviewRevision = 0;
        lastCueText = '';
        void sendRuntime({ type: 'BSCG_LIVE_SEEK', currentTime: candidate.video.currentTime });
        renderCurrentCue();
      });
      candidate.video.addEventListener('timeupdate', () => reportVideoPosition(candidate.video), { passive: true });
      candidate.video.addEventListener('ended', () => {
        if (running && candidate.video === activeVideo) void sendRuntime({ type: 'BSCG_LIVE_MEDIA_ENDED', sessionId: currentSessionId });
      });
      for (const eventName of ['play', 'pause', 'ratechange']) {
        candidate.video.addEventListener(eventName, () => reportVideoPosition(candidate.video, true), { passive: true });
      }
    }
    const rect = captionRect(candidate);
    const horizontalInset = Math.max(18, Math.min(72, rect.width * 0.07));
    const captionWidth = Math.max(180, rect.width - horizontalInset * 2);
    const baseLeft = rect.left + horizontalInset;
    const baseTop = Math.max(rect.top + 60, rect.bottom - Math.max(130, rect.height * 0.22));
    const left = Math.max(rect.left + 8, Math.min(rect.right - captionWidth - 8, baseLeft + captionOffsetX));
    const top = Math.max(rect.top + 30, Math.min(rect.bottom - 56, baseTop + captionOffsetY));
    captions.style.left = `${left}px`;
    captions.style.width = `${captionWidth}px`;
    captions.style.top = `${top}px`;
    captions.style.fontSize = `${Math.round(Math.max(18, Math.min(30, rect.width * 0.026)) * captionScale)}px`;
  }

  function syncCaptionButton() {
    const on = captionsVisible || (running && !captionsDismissed);
    capBtn.classList.toggle('on', on);
    capBtn.setAttribute('aria-pressed', String(on));
    capBtn.title = `${on ? '关闭字幕' : '显示字幕'}；悬停 1 秒设置当前视频翻译`;
  }

  function updateActivity() {
    const busy = ((running || awaitingNewSession || transitioning) && !captionsDismissed && !captionCancelRequested) ||
      summarizing || Boolean(summaryTaskId) || fileGenerating;
    const next = activityError ? 'error' : busy ? 'busy' : 'idle';
    if (activity.dataset.state === next) return;
    activity.dataset.state = next;
    activity.setAttribute('aria-label', next === 'busy' ? '处理中' : next === 'error' ? '操作失败，点击反馈' : '');
    const activityButton = root.querySelector('#activity-log');
    activityButton.title = next === 'error' ? '反馈问题' : '查看日志';
    activityButton.setAttribute('aria-label', activityButton.title);
  }

  function setRunning(value) {
    running = Boolean(value);
    syncCaptionButton();
    updateActivity();
  }

  function setSummaryTask(taskId) {
    const requestedTaskId = String(taskId || '');
    summaryTaskId = finishedTaskIds.has(requestedTaskId) ? '' : requestedTaskId;
    sumBtn.textContent = summaryTaskId ? '取消' : '总结';
    sumBtn.classList.toggle('cancel', Boolean(summaryTaskId));
    sumBtn.setAttribute('aria-pressed', String(Boolean(summaryTaskId)));
    sumBtn.title = summaryTaskId ? '取消当前任务' : '点击准备总结；最终发送由你在 AI 页面确认';
    updateActivity();
  }

  function setCaptionVisibility(value) {
    captionsVisible = Boolean(value) && !captionsDismissed;
    setCaptionSurfaceVisible(captions, captionsVisible);
    if (!captionsVisible) setupSeekPreviewFor(null);
    syncCaptionButton();
    updateActivity();
  }

  function logUiStatus(text, isError = false) {
    const detail = String(text || '').trim();
    const key = `${isError ? 'error' : 'info'}:${detail}`;
    if (!detail || key === lastStatusLog) return;
    lastStatusLog = key;
    recordActivity(isError ? 'error' : 'info', detail);
    void sendRuntime({ type: 'BSCG_LOG', source: 'ui', level: isError ? 'error' : 'info', text: detail });
  }

  function showFeedback(text, _duration = 2400, isError = false) {
    logUiStatus(text, isError);
    if (isError) activityError = true;
    updateActivity();
  }

  async function openLogs() {
    const response = await sendRuntime({ type: 'BSCG_OPEN_OPTIONS', section: 'logs' });
    if (!response?.ok) { showFeedback(response?.error || '无法打开日志', 0, true); return; }
    activityError = false;
    updateActivity();
  }
  root.querySelector('#activity-log').addEventListener('click', () => {
    if (activityError) void sendRuntime({ type: 'BSCG_OPEN_FEEDBACK' });
    else void openLogs();
  });
  // 鼠标移到三个点上就看到最新进展；移到卡片上继续阅读不会中断。
  activityBar.addEventListener('mouseenter', showActivityCard);
  activityBar.addEventListener('mouseleave', scheduleHideActivityCard);
  activityBar.addEventListener('focusin', showActivityCard);
  activityBar.addEventListener('focusout', scheduleHideActivityCard);
  activityCard.addEventListener('mouseenter', showActivityCard);
  activityCard.addEventListener('mouseleave', scheduleHideActivityCard);
  activityCard.addEventListener('click', () => { activityError = false; updateActivity(); void openLogs(); });
  updateActivity();
  renderActivityCard();
  root.querySelector('#menu-feedback').addEventListener('click', () => {
    void sendRuntime({ type: 'BSCG_OPEN_FEEDBACK' });
    setMenuOpen(false);
  });
  root.querySelector('#menu-logs').addEventListener('click', () => { void openLogs(); setMenuOpen(false); });

  function saveCaptionPreferencesSoon() {
    clearTimeout(captionPreferenceTimer);
    captionPreferenceTimer = setTimeout(() => {
      try {
        void chrome.storage.local.set({
          liveCaptionFontScale: captionScale,
          liveCaptionOffsetX: captionOffsetX,
          liveCaptionOffsetY: captionOffsetY
        }).catch(() => {});
      } catch {}
    }, 180);
  }

  function updateCaptionScale(nextScale) {
    captionScale = Math.max(0.7, Math.min(1.8, Math.round(nextScale * 10) / 10));
    captionScaleLabel.textContent = `${Math.round(captionScale * 100)}%`;
    positionCaptions();
    saveCaptionPreferencesSoon();
  }

  async function loadCaptionPreferences() {
    try {
      const saved = await chrome.storage.local.get(['liveCaptionFontScale', 'liveCaptionOffsetX', 'liveCaptionOffsetY', 'defaultDestination', 'voiceEnhance', 'voiceEnhancePreset']);
      captionScale = Math.max(0.7, Math.min(1.8, Number(saved.liveCaptionFontScale) || 1));
      captionOffsetX = Number(saved.liveCaptionOffsetX) || 0;
      captionOffsetY = Number(saved.liveCaptionOffsetY) || 0;
      captionScaleLabel.textContent = `${Math.round(captionScale * 100)}%`;
      updateMenuDestination(saved.defaultDestination);
      updateVoiceControl(Boolean(saved.voiceEnhance), saved.voiceEnhancePreset || 'balanced');
      positionCaptions();
    } catch {}
  }

  function renderCurrentCue() {
    const currentTime = Math.max(0, Number(activeVideo?.currentTime) || 0);
    const timeline = liveMode === 'live' ? null : rows.findLast((row) => row.from <= currentTime && row.to > currentTime) || null;
    const realtime = ['capture', 'live'].includes(liveMode);
    const displayRows = captionDisplayRows(timeline, realtime ? captureHoldRow : null,
      captureHoldUntil, realtime ? livePreviewRow : null, performance.now(), liveMode === 'live' ? Infinity : currentTime, replayUntil);
    const renderKey = JSON.stringify(displayRows.map((row) => [row.provisional, row.content, row.sourceContent || '']));
    if (renderKey === lastCueText) return;
    lastCueText = renderKey;
    paintCaptionRows(cueMount, displayRows);
  }

  function stopLivePreviewTyping() {
    if (livePreviewTypingTimer) clearInterval(livePreviewTypingTimer);
    livePreviewTypingTimer = 0;
  }

  function animateLivePreview(nextPreview) {
    stopLivePreviewTyping();
    // Inference already incurred latency. Display its whole revision at once;
    // a 38 ms character animation added >1.3 s for a two-line subtitle.
    livePreviewRow = { ...nextPreview, content: String(nextPreview?.content || '') };
    renderCurrentCue();
  }

  function reportVideoPosition(video, force = false) {
    if (!running || !video || video !== activeVideo) return;
    const now = performance.now();
    if (!force && now - lastPositionReportAt < 450) return;
    lastPositionReportAt = now;
    void sendRuntime({
      type: 'BSCG_VIDEO_POSITION',
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      preservesPitch: video.preservesPitch,
      paused: video.paused,
      wallTime: Date.now()
    });
  }

  // ================= 时间轴悬停字幕预览 =================
  // 鼠标放在播放器进度条上时，按悬停时间点回显已有字幕（来自实时/文件/缓存结果）。
  const SEEK_BAR_SELECTORS = [
    '.ytp-progress-bar', '.bpx-player-progress', '.squirtle-progress', '.bilibili-player-video-progress',
    '.dplayer-bar-wrap', '.vjs-progress-holder', '.plyr__progress__container', '.art-control-progress',
    '.xgplayer-progress', '.prism-progress', '.jw-slider-time'
  ];
  let seekBar = null;
  let seekBarVideo = null;
  let seekBarNative = false; // Chrome 原生播放器：进度条在 video 的 shadow DOM 里拿不到，用视频底部控件条近似命中
  let lastSeekMove = 0;
  let seekScanAt = -Infinity;

  function formatClock(totalSec) {
    const total = Math.max(0, Math.floor(Number(totalSec) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function cueAtTime(time) {
    // 精确命中（时间落在某行区间内）优先；未命中时取时间上最近的一行，
    // 让悬停预览稳定出现——预生成字幕的行区间有间隙（静音段），
    // 严格区间匹配会让预览时有时无，用户观感是"坏了"。
    for (const row of rows) {
      if (time >= row.from - 0.05 && time <= row.to + 0.05) return row;
    }
    let nearest = null;
    let nearestDistance = Infinity;
    for (const row of rows) {
      const distance = time < row.from ? row.from - time : time > row.to ? time - row.to : 0;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = row;
      }
    }
    return nearest;
  }

  function hideSeekPreview() {
    seekPreview.classList.add('hidden');
  }

  // 原生播放器控件条：底部一条高度有限区域；时间轴在中间（左侧是 播放/音量/时间，右侧是 画中画/全屏）。
  function nativeSeekBand(video) {
    const rect = video.getBoundingClientRect();
    const height = Math.max(32, Math.min(72, rect.height * 0.13));
    const left = rect.left + Math.min(rect.width * 0.3, 190);
    const right = rect.right - Math.min(rect.width * 0.2, 140);
    return { rect, top: rect.bottom - height, bottom: rect.bottom, left, right: Math.max(left + 40, right) };
  }

  function onSeekMouseMove(event) {
    if (!captionsVisible) { hideSeekPreview(); return; }
    const now = performance.now();
    if (now - lastSeekMove < 33 || !seekBarVideo) return;
    lastSeekMove = now;
    const duration = Number(seekBarVideo.duration);
    if (!Number.isFinite(duration) || duration <= 0 || !rows.length) { hideSeekPreview(); return; }
    let ratio;
    let anchorTop;
    if (seekBarNative) {
      const band = nativeSeekBand(seekBarVideo);
      if (event.clientY < band.top || event.clientY > band.bottom || event.clientX < band.left || event.clientX > band.right) { hideSeekPreview(); return; }
      ratio = Math.max(0, Math.min(1, (event.clientX - band.left) / (band.right - band.left)));
      anchorTop = band.top;
    } else {
      const rect = seekBar.getBoundingClientRect();
      ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      anchorTop = rect.top;
    }
    const time = ratio * duration;
    const cue = cueAtTime(time);
    if (!cue || !cue.content) { hideSeekPreview(); return; }
    spTime.textContent = formatClock(time);
    spText.textContent = cue.sourceContent ? `${cue.content}\n${cue.sourceContent}` : cue.content;
    seekPreview.classList.remove('hidden');
    const half = seekPreview.offsetWidth / 2;
    seekPreview.style.left = `${Math.max(8, Math.min(innerWidth - seekPreview.offsetWidth - 8, event.clientX - half))}px`;
    seekPreview.style.top = `${Math.max(8, anchorTop - seekPreview.offsetHeight - 10)}px`;
  }

  function attachSeekBar(bar, native = false) {
    if (seekBar) {
      seekBar.removeEventListener('mousemove', onSeekMouseMove);
      seekBar.removeEventListener('mouseleave', hideSeekPreview);
    }
    seekBar = bar;
    seekBarNative = Boolean(bar && native);
    if (seekBar) {
      seekBar.addEventListener('mousemove', onSeekMouseMove);
      seekBar.addEventListener('mouseleave', hideSeekPreview);
    }
  }

  function setupSeekPreviewFor(video) {
    if (!captionsVisible || !rows.length || liveMode === 'live' || !video) {
      attachSeekBar(null);
      seekBarVideo = null;
      seekScanAt = -Infinity;
      hideSeekPreview();
      return;
    }
    if (seekBarVideo === video && seekBar && seekBar.isConnected) return;
    if (seekBarVideo === video && performance.now() - seekScanAt < 2000) return;
    seekBarVideo = video;
    seekScanAt = performance.now();
    let bar = null;
    for (const sel of SEEK_BAR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.isConnected && el.getBoundingClientRect().width > 120) { bar = el; break; }
    }
    if (!bar) {
      // 通用启发：在播放器容器里找"宽而扁"的进度条元素
      const vr = video.getBoundingClientRect();
      const container = video.closest('[class*="player" i], [class*="Player" i], [id*="player" i]') || video.parentElement?.parentElement || null;
      let best = null;
      let bestWidth = 0;
      if (container) {
        for (const el of container.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width >= vr.width * 0.5 && r.height >= 3 && r.height <= 36 && r.top >= vr.top + vr.height * 0.45 && r.width / Math.max(1, r.height) >= 4) {
            if (r.width > bestWidth) { best = el; bestWidth = r.width; }
          }
        }
      }
      bar = best;
    }
    // Chrome 原生播放器（本地视频等）：没有可匹配的进度条元素，退回用 video 元素本身近似命中
    if (!bar && video.controls) {
      bar = video;
      attachSeekBar(bar, true);
      return;
    }
    attachSeekBar(bar);
  }

  function refreshExportState() {
    menuExport.disabled = rows.length === 0;
  }

  function mergeSegments(segments) {
    for (const row of segments || []) {
      if (!row?.content) continue;
      const normalized = {
        from: Math.max(0, Number(row.from) || 0),
        to: Math.max(Number(row.from) || 0, Number(row.to) || 0),
        content: String(row.content)
      };
      if (row.sourceContent) normalized.sourceContent = String(row.sourceContent);
      if (row.originalContent) normalized.originalContent = String(row.originalContent);
      const existingIndex = rows.findIndex((item) => Math.abs(Number(item.from) - normalized.from) < 0.05);
      if (existingIndex >= 0) rows[existingIndex] = normalized; else rows.push(normalized);
    }
    rows.sort((a, b) => a.from - b.from);
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
    refreshExportState();
  }

  function resetForSession(sessionId, preserveRows = false) {
    if (!sessionId || sessionId === currentSessionId) return;
    replayUntil = 0;
    currentSessionId = sessionId;
    if (!preserveRows) clearCueState();
  }

  // 点击"字幕"：直接生成实时字幕（已有完整结果时复用），再次点击关闭。
  function queuedStatusText(value = {}) {
    const blocker = String(value.queueBlocker || '').trim();
    if (blocker) return `本页等待中：${blocker}。结束后自动开始。`;
    const ahead = Math.max(1, Number(value.queueAhead) || 1);
    return `本页等待中：前面 ${ahead} 个任务。结束后自动开始。`;
  }

  async function startRecognition(automatic = false) {
    captionsDismissed = false;
    activityError = false;
    capBtn.classList.add('busy');
    setStatus('正在启动本地字幕…');
    awaitingNewSession = true;
    setCaptionVisibility(true);
    try {
      if (captionCancelRequested) {
        awaitingNewSession = false;
        setCaptionVisibility(false);
        setStatus('字幕已取消');
        return;
      }
      // file:// 页已经在播放用户明确打开的媒体。实时字幕直接监听现有播放器，
      // 不应再次索要同一文件；文件选择器只保留给“总结/生成完整字幕”整轨读取。
      const localFileToken = location.protocol === 'file:' ? uploadedLocalFileToken : '';
      const response = await sendRuntime({ type: 'BSCG_LIVE_START', automatic, fromControls: true, pageUrl: location.href, localFileToken, localFileName: uploadedLocalFileName });
      if (!response?.ok) throw new Error(response?.error || '实时字幕启动失败');
      if (response.superseded) {
        awaitingNewSession = false;
        setRunning(false);
        setCaptionVisibility(false);
        return;
      }
      autoResumeAfterSwitch = false;
      if (captionCancelRequested || captionsDismissed) {
        await sendRuntime({ type: 'BSCG_LIVE_STOP', fromControls: true });
        awaitingNewSession = false;
        setRunning(false);
        setCaptionVisibility(false);
        showFeedback('字幕已取消', 2400);
        return;
      }
      if (ignoreLiveMessages && response.alreadyRunning && !response.sessionId) throw new Error('上一条视频的字幕任务正在结束，请稍后再试');
      ignoreLiveMessages = false;
      awaitingNewSession = false;
      const alreadyFinished = response.reused || finishedCaptionSessionId === response.sessionId;
      liveMode = alreadyFinished && response.mode !== 'live' ? 'file' : response.mode || 'capture';
      resetForSession(response.sessionId, liveMode !== 'live' && (rows.length > 0 || response.segments?.length > 0));
      mergeSegments(response.segments);
      setRunning(!alreadyFinished);
      if (response.reused) {
        setStatus(`已复用之前的字幕（${response.rows} 段）`);
        showFeedback('已复用缓存；重新识别请先清除缓存', 3000);
      } else if (response.queued) {
        setStatus(queuedStatusText(response));
      } else {
        setStatus(response.alreadyRunning ? '实时字幕正在运行' : '实时字幕已启动');
        showFeedback('字幕已启动，正在生成第一句', 3000);
      }
    } catch (error) {
      awaitingNewSession = false;
      throw error;
    } finally {
      capBtn.classList.remove('busy');
    }
  }

  async function stopRecognition() {
    autoResumeAfterSwitch = false;
    setStatus('正在处理最后一段…');
    const response = await sendRuntime({ type: 'BSCG_LIVE_STOP', fromControls: true });
    if (!response?.ok) throw new Error(response?.error || '停止失败');
  }

  async function toggleCaptions() {
    autoResumeAfterSwitch = false;
    captionActionVersion += 1;
    autoStartAttempted = currentPageIdentity;
    if (transitioning) {
      captionCancelRequested = true;
      captionsDismissed = true;
      setCaptionVisibility(false);
      showFeedback('已请求取消字幕', 2200);
      return;
    }
    if (staleBg) { showFeedback('扩展已更新：请到 chrome://extensions 点"重新加载"后刷新本页', 4200); return; }
    transitioning = true;
    captionCancelRequested = false;
    activityError = false;
    capBtn.classList.add('busy');
    try {
      if (!running && !captionsVisible) {
        if (rows.length && liveMode !== 'live' && (liveMode === 'file' ||
            (finishedCaptionSessionId && finishedCaptionSessionId === currentSessionId))) {
          liveMode = 'file';
          captionsDismissed = false;
          setCaptionVisibility(true);
          renderCurrentCue();
          const response = await sendRuntime({ type: 'BSCG_CAPTIONS_SHOW', fromControls: true,
            mode: 'file', sessionId: currentSessionId, segments: rows, pageUrl: location.href });
          if (!response?.ok) throw new Error(response?.error || '显示字幕失败');
        } else {
          await startRecognition();
        }
      } else {
        if (liveMode !== 'live' && finishedCaptionSessionId && finishedCaptionSessionId === currentSessionId) liveMode = 'file';
        captionsDismissed = true;
        setCaptionVisibility(false);
        setRunning(false);
        showFeedback('正在关闭字幕…');
        await stopRecognition();
        setRunning(false);
        showFeedback('字幕已关闭', 2400);
      }
    } catch (error) {
      setRunning(false);
      setCaptionVisibility(false);
      showFeedback(`字幕操作失败：${error?.message || String(error)}`, 8000, true);
    } finally {
      transitioning = false;
      captionCancelRequested = false;
      capBtn.classList.remove('busy');
      updateActivity();
    }
  }

  async function cancelSummaryTask() {
    summaryCancelRequested = true;
    const taskId = summaryTaskId;
    const hadPendingRequest = Boolean(summaryRequestId);
    showFeedback(taskId ? '正在取消总结任务…' : '已取消总结请求', 2400);
    if (!taskId && !summaryRequestId) return;
    const response = await sendRuntime({ type: 'BSCG_TASK_CANCEL', taskId, requestId: summaryRequestId });
    if (!response?.ok) throw new Error(response?.error || '取消总结任务失败');
    setSummaryTask('');
    summaryRequestId = '';
    showFeedback(response.cancelled || hadPendingRequest ? '总结任务已取消' : '总结任务已经结束', 2600);
  }

  // 点击"总结"：直接走完整字幕流程；任务排队或运行时再次点击即取消。
  async function summarizeVideo() {
    if (staleBg) { showFeedback('扩展已更新：请到 chrome://extensions 点"重新加载"后刷新本页', 4200); return; }
    summaryCancelRequested = false;
    summaryRequestId = crypto.randomUUID();
    summarizing = true;
    activityError = false;
    updateActivity();
    sumBtn.textContent = '取消';
    sumBtn.classList.add('cancel');
    sumBtn.setAttribute('aria-pressed', 'true');
    sumBtn.title = '取消当前总结请求';
    sumBtn.classList.add('busy');
    const destination = currentDestination;
    const label = DESTINATIONS[destination]?.label || destination;
    try {
      const localFileToken = await prepareLocalFileToken();
      if (localFileToken === null) {
        showFeedback('已取消选择，未启动总结', 2400);
        return;
      }
      showFeedback(`正在准备字幕（${label}）…`, 4000);
      let response = await sendRuntime({ type: 'BSCG_EXTRACT_CURRENT', destination, requestId: summaryRequestId, pageUrl: location.href, localFileToken, localFileName: uploadedLocalFileName });
      if (!response?.ok) throw new Error(response?.error || '字幕提取失败');
      if (summaryCancelRequested) return;
      if (response.needsLocalConfirm || response.needsLiveCapture) {
        showFeedback('无现成字幕，后台转写中…', 3000);
        const retry = { type: 'BSCG_EXTRACT_CURRENT', destination, requestId: summaryRequestId, allowLocalTranscription: true, pageUrl: location.href, localFileToken, localFileName: uploadedLocalFileName };
        if (response.cid) retry.expectedCid = response.cid;
        if (response.videoId) retry.expectedVideoId = response.videoId;
        response = await sendRuntime(retry);
        if (!response?.ok) throw new Error(response?.error || '本地转写失败');
        if (summaryCancelRequested) {
          if (response.taskId) await sendRuntime({ type: 'BSCG_TASK_CANCEL', taskId: response.taskId });
          return;
        }
        if (response.deduped) {
          setSummaryTask(response.taskId);
          showFeedback('转写进行中，已按最新选择更新', 2800);
          return;
        }
        if (response.backgroundTask) {
          setSummaryTask(response.taskId);
          showFeedback(response.queued
            ? `${queuedStatusText(response)} 完成后打开 ${label}`
            : `转写已开始，完成后打开 ${label}`, 3000);
          return;
        }
      }
      showFeedback(`已在 ${label} 准备 ${response.rows} 段字幕；请检查后手动发送`, 4200);
      summaryRequestId = '';
    } catch (error) {
      if (summaryCancelRequested) showFeedback('总结任务已取消', 2600);
      else showFeedback(`总结失败：${error?.message || String(error)}`, 8000, true);
    } finally {
      summarizing = false;
      if (!summaryTaskId) summaryRequestId = '';
      if (!summaryTaskId) setSummaryTask('');
      sumBtn.classList.remove('busy');
      updateActivity();
    }
  }

  async function handleSummaryClick() {
    try {
      if (summarizing || summaryTaskId) await cancelSummaryTask();
      else await summarizeVideo();
    } catch (error) {
      showFeedback(`总结操作失败：${error?.message || String(error)}`, 8000, true);
    }
  }

  // 菜单"生成字幕文件"：走完整转写流程，结果回显（可导出 SRT），不打开 AI 页面。
  async function generateSubtitleFile() {
    if (fileGenerating) return;
    if (staleBg) { showFeedback('扩展已更新：请到 chrome://extensions 点"重新加载"后刷新本页', 4200); return; }
    fileGenerating = true;
    captionActionVersion += 1;
    captionsDismissed = false;
    activityError = false;
    updateActivity();
    menuGenFile.disabled = true;
    try {
      const localFileToken = await prepareLocalFileToken();
      if (localFileToken === null) {
        showFeedback('已取消选择，未启动任务', 2400);
        return;
      }
      setStatus('正在准备完整字幕…');
      setCaptionVisibility(true);
      await sendRuntime({ type: 'BSCG_CAPTIONS_SHOW', fromControls: true });
      let response = await sendRuntime({ type: 'BSCG_EXTRACT_CURRENT', destination: 'file', pageUrl: location.href, localFileToken, localFileName: uploadedLocalFileName });
      if (!response?.ok) throw new Error(response?.error || '字幕生成失败');
      if (response.needsLocalConfirm || response.needsLiveCapture) {
        setStatus('无现成字幕，后台转写中…');
        const retry = { type: 'BSCG_EXTRACT_CURRENT', destination: 'file', allowLocalTranscription: true, pageUrl: location.href, localFileToken, localFileName: uploadedLocalFileName };
        if (response.cid) retry.expectedCid = response.cid;
        if (response.videoId) retry.expectedVideoId = response.videoId;
        response = await sendRuntime(retry);
        if (!response?.ok) throw new Error(response?.error || '完整转写失败');
        if (response.deduped) {
          setSummaryTask(response.taskId);
          setStatus('完整转写已在后台进行');
          showFeedback('转写进行中，已按最新选择更新', 2800);
          return;
        }
        if (response.backgroundTask) {
          setSummaryTask(response.taskId);
          setStatus(response.queued ? queuedStatusText(response) : '后台转写中，完成后自动显示结果');
          showFeedback(response.queued ? queuedStatusText(response) : '转写已开始，完成后自动显示', 3000);
          return;
        }
      }
      if (!response.file) throw new Error('字幕文件生成失败');
      setStatus(`字幕文件已生成（${response.rows} 段）`);
      showFeedback('字幕文件已生成', 2600);
    } catch (error) {
      showFeedback(`生成字幕文件失败：${error?.message || String(error)}`, 8000, true);
    } finally {
      fileGenerating = false;
      menuGenFile.disabled = false;
      updateActivity();
    }
  }

  capBtn.addEventListener('click', () => { void toggleCaptions(); });
  sumBtn.addEventListener('click', () => { void handleSummaryClick(); });

  // Fixed hit area includes the left margin and child menus. Fade the contents,
  // never move the hovered element out from under the pointer.
  let dockHideTimer = null;
  let translationHoverTimer = null;
  let translationHideTimer = null;
  dock.addEventListener('pointerenter', () => {
    clearTimeout(dockHideTimer);
    dock.classList.add('expanded');
  });
  dock.addEventListener('pointerleave', () => {
    clearTimeout(dockHideTimer);
    dockHideTimer = setTimeout(() => {
      if (dock.matches(':hover') || dock.matches(':has(:focus-visible)')) return;
      dock.classList.remove('expanded');
      setTranslationMenuOpen(false);
      setMenuOpen(false);
    }, 350);
  });

  function setTranslationMenuOpen(open) {
    clearTimeout(translationHideTimer);
    translationMenu.hidden = !open;
    capBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      clearTimeout(dockHideTimer);
      dock.classList.add('expanded');
      setMenuOpen(false);
      void refreshTranslationPreference();
    }
  }

  function renderTranslationPreference(response) {
    for (const button of translationMenu.querySelectorAll('[data-translation]')) {
      button.setAttribute('aria-pressed', String(button.dataset.translation === response.choice));
    }
    translationNote.textContent = response.enabled && !response.ready
      ? `${response.reason}；请在完整设置中配置翻译模型`
      : `当前${response.enabled ? '翻译' : '不翻译'} · ${response.sourceLanguage || 'auto'} → ${response.targetLanguage || '未指定'} · ${response.translationMode || ''} · 仅影响此视频`;
  }

  async function refreshTranslationPreference() {
    const identity = currentPageIdentity;
    try {
      const response = await sendRuntime({ type: 'BSCG_VIDEO_TRANSLATION_GET', pageUrl: location.href });
      if (identity !== currentPageIdentity || !response?.ok) return;
      renderTranslationPreference(response);
    } catch (error) { translationNote.textContent = error?.message || '读取翻译设置失败'; }
  }

  function scheduleTranslationMenu() {
    clearTimeout(translationHideTimer);
    clearTimeout(translationHoverTimer);
    translationHoverTimer = setTimeout(() => setTranslationMenuOpen(true), 1000);
  }
  capBtn.addEventListener('pointerenter', scheduleTranslationMenu);
  capBtn.addEventListener('focus', scheduleTranslationMenu);
  capBtn.addEventListener('pointerleave', (event) => {
    clearTimeout(translationHoverTimer);
    // The menu belongs to the dock. Its shared leave timer allows crossing the
    // gap or moving slowly through the menu without racing a button timer.
    if (event.relatedTarget && dock.contains(event.relatedTarget)) clearTimeout(dockHideTimer);
  });
  capBtn.addEventListener('blur', () => clearTimeout(translationHoverTimer));
  translationMenu.addEventListener('pointerenter', () => {
    clearTimeout(translationHideTimer);
    clearTimeout(dockHideTimer);
  });
  for (const button of translationMenu.querySelectorAll('[data-translation]')) {
    button.addEventListener('click', async () => {
      const identity = currentPageIdentity;
      const buttons = [...translationMenu.querySelectorAll('[data-translation]')];
      buttons.forEach(item => { item.disabled = true; });
      try {
        const response = await sendRuntime({ type: 'BSCG_VIDEO_TRANSLATION_SET', pageUrl: location.href,
          choice: button.dataset.translation, captionsVisible, segments: rows });
        if (identity !== currentPageIdentity) return;
        if (!response?.ok) throw new Error(response?.error || '设置当前视频翻译失败');
        renderTranslationPreference(response);
        showFeedback(response.enabled && !response.ready ? response.reason
          : `当前视频已${response.enabled ? '开启' : '关闭'}翻译；全局设置未修改`, 3500);
      } catch (error) { showFeedback(error?.message || String(error), 5000, true); }
      finally { buttons.forEach(item => { item.disabled = false; }); }
    });
  }

  root.querySelector('#translation-speed').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    translationNote.textContent = '正在预热并逐句测速；请先停止字幕和总结任务…';
    try {
      const response = await sendRuntime({ type: 'BSCG_TRANSLATE_BENCHMARK' });
      if (!response?.ok) throw new Error(response?.error || '测速失败');
      const r = response.report;
      translationNote.textContent = `单句中位数 ${Math.round(r.medianMs)} ms · P95 ${Math.round(r.p95Ms)} ms；100 ms 仅供参考，不自动关闭翻译`;
    } catch (error) { translationNote.textContent = error?.message || '测速失败'; }
    finally { button.disabled = false; }
  });

  // 总结按钮悬停 1 秒弹出侧边菜单；移开后自动收起。
  function setMenuOpen(value) {
    if (value) setTranslationMenuOpen(false);
    menu.classList.toggle('open', value);
    sumBtn.setAttribute('aria-expanded', String(value));
  }
  sumBtn.addEventListener('mouseenter', () => {
    clearTimeout(menuTimer);
    menuTimer = setTimeout(() => setMenuOpen(true), 1000);
  });
  sumBtn.addEventListener('mouseleave', () => {
    clearTimeout(menuTimer);
    menuTimer = setTimeout(() => { if (!menu.matches(':hover')) setMenuOpen(false); }, 260);
  });
  menu.addEventListener('mouseenter', () => clearTimeout(menuTimer));
  menu.addEventListener('mouseleave', () => {
    menuTimer = setTimeout(() => { if (!sumBtn.matches(':hover')) setMenuOpen(false); }, 260);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.composedPath().includes(host)) setTranslationMenuOpen(false);
    if (menu.classList.contains('open') && !event.composedPath().includes(host)) setMenuOpen(false);
  }, { capture: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setTranslationMenuOpen(false);
    if (event.key === 'Escape' && menu.classList.contains('open')) {
      sumBtn.focus();
      setMenuOpen(false);
    }
  });

  function updateMenuDestination(value) {
    if (!DESTINATIONS[value]) value = 'chatgpt';
    currentDestination = value;
    menuDestButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.dest === value));
  }
  menuDestButtons.forEach((btn) => btn.addEventListener('click', () => {
    updateMenuDestination(btn.dataset.dest);
    try {
      void chrome.storage.local.set({ defaultDestination: currentDestination }).catch(() => {});
    } catch {}
    showFeedback(`总结目标：${DESTINATIONS[currentDestination]?.label || currentDestination}`, 2200);
  }));

  menuGenFile.addEventListener('click', () => { void generateSubtitleFile(); });

  menuExport.addEventListener('click', async () => {
    menuExport.disabled = true;
    try {
      const response = await sendRuntime({ type: 'BSCG_EXPORT_CURRENT', pageUrl: location.href, segments: rows });
      if (!response?.ok) throw new Error(response?.error || '导出失败');
      showFeedback(`已导出：${response.fileName}（${response.rows} 段）`, 3000);
    } catch (error) {
      showFeedback(`导出失败：${error?.message || String(error)}`, 8000, true);
    } finally {
      refreshExportState();
    }
  });

  // 清除缓存：删除当前页已缓存结果并停止本页任务；之后生成/总结都会按当前设置重新识别。
  menuClear.addEventListener('click', async () => {
    menuClear.disabled = true;
    try {
      if (running) await stopRecognition();
      setRunning(false);
      setCaptionVisibility(false);
      clearCueState();
      currentSessionId = '';
      const response = await sendRuntime({ type: 'BSCG_CLEAR_CACHE' });
      if (!response?.ok) throw new Error(response?.error || '无法清除缓存');
      setSummaryTask('');
      showFeedback('缓存已清除', 2600);
    } catch (error) {
      showFeedback(`清除缓存失败：${error?.message || String(error)}`, 8000, true);
    } finally {
      menuClear.disabled = false;
      refreshExportState();
    }
  });

  function updateVoiceControl(enabled, preset) {
    voiceEnhanceEnabled = Boolean(enabled);
    voiceEnhancePreset = ['gentle', 'balanced', 'strong'].includes(preset) ? preset : 'balanced';
    const label = { gentle: '轻度', balanced: '平衡', strong: '强' }[voiceEnhancePreset];
    menuAudio.textContent = voiceEnhanceEnabled ? `远场控制：${label}` : '远场控制：关';
    menuAudio.classList.toggle('active', voiceEnhanceEnabled);
  }

  menuAudio.addEventListener('click', async () => {
    const enabled = !voiceEnhanceEnabled;
    try {
      await chrome.storage.local.set({ voiceEnhance: enabled });
      updateVoiceControl(enabled, voiceEnhancePreset);
      showFeedback(enabled ? '远场音频控制已开启，下次重新识别生效' : '远场音频控制已关闭，下次重新识别生效', 3200);
    } catch (error) {
      showFeedback(`无法保存音频控制设置：${error?.message || String(error)}`, 3600, true);
    }
  });

  menuSettings.addEventListener('click', async () => {
    try {
      const response = await sendRuntime({ type: 'BSCG_OPEN_OPTIONS' });
      if (!response?.ok) throw new Error(response?.error || '无法打开完整设置');
      setMenuOpen(false);
    } catch (error) {
      showFeedback(error?.message || '无法打开完整设置', 3600);
    }
  });

  root.querySelector('#caption-smaller').addEventListener('click', () => updateCaptionScale(captionScale - 0.1));
  root.querySelector('#caption-larger').addEventListener('click', () => updateCaptionScale(captionScale + 0.1));
  root.querySelector('#caption-reset').addEventListener('click', () => {
    captionOffsetX = 0;
    captionOffsetY = 0;
    positionCaptions();
    saveCaptionPreferencesSoon();
    showFeedback('字幕位置已复位');
  });
  cueMount.addEventListener('pointerdown', (event) => {
    if (!cueMount.firstElementChild || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const originalX = captionOffsetX;
    const originalY = captionOffsetY;
    cueMount.classList.add('dragging');
    cueMount.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      captionOffsetX = originalX + moveEvent.clientX - startX;
      captionOffsetY = originalY + moveEvent.clientY - startY;
      positionCaptions();
    };
    const finish = () => {
      cueMount.classList.remove('dragging');
      cueMount.removeEventListener('pointermove', move);
      cueMount.removeEventListener('pointerup', finish);
      cueMount.removeEventListener('pointercancel', finish);
      saveCaptionPreferencesSoon();
    };
    cueMount.addEventListener('pointermove', move);
    cueMount.addEventListener('pointerup', finish);
    cueMount.addEventListener('pointercancel', finish);
  });
  addEventListener('resize', positionCaptions, { passive: true });
  addEventListener('scroll', positionCaptions, { passive: true, capture: true });
  function syncFullscreenHost() {
    const fullscreenElement = document.fullscreenElement;
    if (fullscreenElement && fullscreenElement.tagName !== 'VIDEO') {
      if (host.parentNode !== fullscreenElement) fullscreenElement.appendChild(host);
      host.dataset.fullscreenHost = 'container';
    } else {
      // <video> 是空元素，不能承载扩展控件；明确保留在文档根节点。多数站点全屏的是播放器容器，会走上面的可见路径。
      if (host.parentNode !== document.documentElement) document.documentElement.appendChild(host);
      host.dataset.fullscreenHost = fullscreenElement?.tagName === 'VIDEO' ? 'native-video' : 'document';
    }
    positionCaptions();
  }
  document.addEventListener('fullscreenchange', () => setTimeout(syncFullscreenHost, 80));
  addEventListener('yt-navigate-finish', checkPageIdentity);
  addEventListener('popstate', checkPageIdentity);
  addEventListener('hashchange', checkPageIdentity);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) maybeAutoStart();
  });
  addEventListener('focus', () => {
    // An active tab in an unfocused window may have failed the background
    // eligibility check. Recheck once the user actually returns to this window.
    if (!document.hidden && !running) {
      autoStartAttempted = '';
      maybeAutoStart();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'BSCG_LOG_ENTRY') {
      // 后台进度广播：进度条悬停卡片直接展示，不必再点开日志页。
      const entry = message.entry || {};
      recordActivity(entry.level, entry.text);
      return;
    }
    if (message?.type === 'BSCG_CAPTIONS_VISIBILITY') {
      // A page click already applied its intent synchronously. Its echo must
      // not undo a more recent click while background work is still returning.
      if (message.fromControls) return;
      captionActionVersion += 1;
      captionsDismissed = !message.visible;
      if (message.mode === 'file') {
        liveMode = 'file';
        resetForSession(message.sessionId, true);
        mergeSegments(message.segments);
        setRunning(false);
      }
      setCaptionVisibility(message.visible);
      if (!message.visible) setRunning(false);
      renderCurrentCue();
      return;
    }
    if (message?.type === 'BSCG_TASK_FINISHED') {
      if (message.taskId) {
        finishedTaskIds.add(String(message.taskId));
        if (finishedTaskIds.size > 20) finishedTaskIds.delete(finishedTaskIds.values().next().value);
      }
      if (message.taskId && message.taskId === summaryTaskId) {
        setSummaryTask('');
        summaryRequestId = '';
        if (message.cancelled) showFeedback('总结任务已取消', 2600);
      }
      return;
    }
    if (message?.type === 'BSCG_TAB_FRAME_VIDEO') {
      // 播放器 iframe 报告本页有视频：即使顶层没有可定位的 <video> 也显示入口。
      const frameId = String(message.frameId ?? 'legacy');
      if (message.present !== false && pageAllowsControls()) frameMediaPresence.set(frameId, Date.now());
      else frameMediaPresence.delete(frameId);
      frameHasVideo = frameMediaPresence.size > 0;
      positionCaptions();
      return;
    }
    if (message?.type === 'BSCG_FILE_RESULT') {
      // Store/export the transcript without changing the latest caption toggle.
      liveMode = 'file';
      mergeSegments(message.segments || []);
      renderCurrentCue();
      setStatus(`字幕文件已生成（${message.rows || rows.length} 段）`);
      return;
    }
    if (ignoreLiveMessages && !(message?.type === 'BSCG_LIVE_STARTED' && awaitingNewSession)) return;
    if (message?.type?.startsWith('BSCG_LIVE_') && message.type !== 'BSCG_LIVE_STARTED' &&
        message.type !== 'BSCG_LIVE_REUSED' && message.sessionId && currentSessionId &&
        message.sessionId !== currentSessionId) return;
    if (message?.type === 'BSCG_LIVE_STARTED') {
      if (message.captionVisibility === false) captionsDismissed = true;
      stopLivePreviewTyping();
      ignoreLiveMessages = false;
      awaitingNewSession = false;
      liveMode = message.mode || 'capture';
      overlayOnTop = Boolean(message.overlayOnTop);
      livePreviewRow = null;
      livePreviewRevision = 0;
      resetForSession(message.sessionId, liveMode !== 'live' && (rows.length > 0 || message.segments?.length > 0));
      mergeSegments(message.segments);
      setRunning(true);
      setCaptionVisibility(true);
      setStatus('实时字幕已启动');
    } else if (message?.type === 'BSCG_LIVE_REUSED') {
      if (message.captionVisibility === false) captionsDismissed = true;
      stopLivePreviewTyping();
      ignoreLiveMessages = false;
      awaitingNewSession = false;
      liveMode = 'file';
      livePreviewRow = null;
      livePreviewRevision = 0;
      resetForSession(message.sessionId, true);
      mergeSegments(message.segments || []);
      finishedCaptionSessionId = message.sessionId || currentSessionId;
      setRunning(false);
      setCaptionVisibility(true);
      setStatus(`已复用之前的字幕（${message.rows || rows.length} 段）`);
    } else if (message?.type === 'BSCG_LIVE_QUEUED') {
      setStatus(message.text || '本页识别已排队；前一个任务结束后自动开始。');
    } else if (message?.type === 'BSCG_LIVE_PROGRESS') {
      recordActivity(message.level, message.text || '处理中…');
      setStatus(message.text || '处理中…');
    } else if (message?.type === 'BSCG_PROGRESS') {
      recordActivity(message.level, message.text || '处理中…');
      setStatus(message.text || '处理中…');
    } else if (message?.type === 'BSCG_LIVE_HANDOFF') {
      autoResumeAfterSwitch = true;
      autoStartAttempted = '';
      autoStartFailedFor = '';
      setStatus(message.text || '字幕已切换到新页面');
    } else if (message?.type === 'BSCG_LIVE_FINAL' && message.segment?.content) {
      const segment = { ...message.segment };
      finalizedPreviewIds.add(segment.id);
      if (finalizedPreviewIds.size > 32) finalizedPreviewIds.delete(finalizedPreviewIds.values().next().value);
      captureHoldRow = segment;
      captureHoldUntil = performance.now() + finalCaptionHoldMs(segment.content);
      if (livePreviewRow?.id === segment.id) livePreviewRow = null;
      renderCurrentCue();
    } else if (message?.type === 'BSCG_LIVE_SEGMENT' && message.segment?.content) {
      const segment = { ...message.segment, sequence: Number.isFinite(message.sequence) ? message.sequence : rows.length };
      const existingIndex = rows.findIndex((row) => Math.abs(Number(row.from) - Number(segment.from)) < 0.05);
      if (existingIndex >= 0) rows[existingIndex] = segment; else rows.push(segment);
      rows.sort((a, b) => Number(a.from) - Number(b.from));
      if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
      if (!message.finalDisplayManaged && ['capture', 'live'].includes(liveMode)) {
        captureHoldRow = segment;
        const readableMs = Math.max(4000, Math.min(10000, (Number(segment.to) - Number(segment.from)) * 750));
        captureHoldUntil = performance.now() + readableMs;
      }
      const ahead = Math.max(0, Number(message.bufferedTo || 0) - Number(activeVideo?.currentTime || 0));
      const cpu = Number.isFinite(message.cpuLoad) ? ` · CPU ${Math.round(message.cpuLoad)}%` : '';
      setStatus(`已生成 ${rows.length} 段${ahead ? ` · 前瞻 ${Math.floor(ahead)} 秒` : ''}${cpu}`);
      refreshExportState();
      renderCurrentCue();
    } else if (message?.type === 'BSCG_LIVE_PREVIEW' && message.segment?.content) {
      if (message.sessionId && currentSessionId && message.sessionId !== currentSessionId) return;
      const previewId = String(message.previewId || message.segment.id || 'current');
      if (finalizedPreviewIds.has(previewId)) return;
      const revision = Math.max(0, Number(message.revision ?? message.segment.revision) || 0);
      if (livePreviewRow?.id === previewId && revision < livePreviewRevision) return;
      const nextPreview = {
        id: previewId,
        revision,
        from: Math.max(0, Number(message.segment.from) || 0),
        to: Math.max(Number(message.segment.from) || 0, Number(message.segment.to) || Number(message.segment.from) || 0),
        content: String(message.segment.content),
        singleLine: Boolean(message.segment.singleLine),
        sourceContent: String(message.segment.sourceContent || ''),
        stableContent: String(message.segment.stableContent || '')
      };
      livePreviewRevision = revision;
      animateLivePreview(nextPreview);
    } else if (message?.type === 'BSCG_LIVE_PREVIEW_CLEAR') {
      if (message.sessionId && currentSessionId && message.sessionId !== currentSessionId) return;
      const previewId = String(message.previewId || '');
      const revision = Math.max(0, Number(message.revision) || 0);
      if (livePreviewRow && (!previewId || livePreviewRow.id === previewId) && (!revision || revision >= livePreviewRevision)) {
        stopLivePreviewTyping();
        livePreviewRow = null;
        livePreviewRevision = 0;
        lastCueText = '';
        renderCurrentCue();
      }
    } else if (message?.type === 'BSCG_LIVE_INVALIDATE_RANGE') {
      stopLivePreviewTyping();
      const from = Math.max(0, Number(message.from) || 0);
      const to = Math.max(from, Number(message.to) || from);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (Number(rows[index].to) > from && Number(rows[index].from) < to) rows.splice(index, 1);
      }
      captureHoldRow = null;
      captureHoldUntil = 0;
      livePreviewRow = null;
      livePreviewRevision = 0;
      lastCueText = '';
      refreshExportState();
      renderCurrentCue();
    } else if (message?.type === 'BSCG_LIVE_STOPPED') {
      finishedCaptionSessionId = message.keepVisible ? message.sessionId || currentSessionId : '';
      stopLivePreviewTyping();
      livePreviewRow = null;
      livePreviewRevision = 0;
      setRunning(false);
      setCaptionVisibility(Boolean(message.keepVisible));
      if (message.keepVisible && !['capture', 'live'].includes(liveMode)) liveMode = 'file';
      const stoppedText = liveMode === 'live'
        ? (message.reason === 'live-interrupted' ? '直播音频中断，恢复播放后请重新开启字幕' : '直播字幕已停止')
        : (message.keepVisible ? '整轨前瞻已完成' : '已停止');
      setStatus(`${stoppedText}，共 ${message.rows || rows.length} 段`);
    } else if (message?.type === 'BSCG_LIVE_ERROR') {
      stopLivePreviewTyping();
      livePreviewRow = null;
      livePreviewRevision = 0;
      setRunning(false);
      setCaptionVisibility(false);
      showFeedback(`字幕失败：${message.error || '实时字幕失败'}`, 8000, true);
    }
  });

  async function hydrateLiveState(acceptRunning = true) {
    const identity = pageIdentity();
    const sessionAtRequest = currentSessionId;
    const actionAtRequest = captionActionVersion;
    const response = await sendRuntime({ type: 'BSCG_LIVE_UI_READY', pageUrl: location.href });
    if (identity !== pageIdentity() || sessionAtRequest !== currentSessionId || actionAtRequest !== captionActionVersion) return false;
    if (!response?.ok || (!acceptRunning && (response.running || response.stopping))) return false;
    // 版本握手：后台比界面旧，说明扩展更新后没有重载——明确提示，避免静默失败。
    if (response.extVersion && CS_VERSION !== '0.0.0' && response.extVersion !== CS_VERSION) {
      staleBg = true;
      showFeedback('扩展已更新：请到 chrome://extensions 点"重新加载"，再刷新本页', 8000);
    }
    ignoreLiveMessages = false;
    setSummaryTask(response.taskRunning ? response.taskId : '');
    liveMode = response.mode || '';
    overlayOnTop = Boolean(response.overlayOnTop);
    resetForSession(response?.sessionId);
    mergeSegments(response?.segments);
    if (typeof response.captionVisibility === 'boolean') captionsDismissed = !response.captionVisibility;
    if (!response.running && rows.length && liveMode !== 'live') liveMode = 'file';
    livePreviewRow = response?.previewSegment?.content ? { ...response.previewSegment } : null;
    captureHoldRow = response?.finalSegment?.content ? { ...response.finalSegment } : null;
    livePreviewRevision = Math.max(0, Number(response?.previewSegment?.revision) || 0);
    renderCurrentCue();
    setRunning(Boolean(response?.running));
    setCaptionVisibility(!response.stopping && (response.running || response.captionVisibility === true));
    if (response?.running && response?.queued) {
      setStatus(queuedStatusText(response));
    } else if (response?.running) setStatus(`实时字幕正在运行${rows.length ? ` · ${rows.length} 段` : ''}`);
    else if (rows.length) setStatus(`已生成 ${rows.length} 段，可继续查看或导出`);
    return true;
  }
  void hydrateLiveState().catch(() => {});
  void loadCaptionPreferences();
  positionCaptions();
  syncFullscreenHost();
  setInterval(() => {
    if (!extensionAlive()) return; // 上下文失效后停止轮询，避免刷错误日志
    checkPageIdentity(); positionCaptions();
  }, 800);
  function renderCaptionFrame() {
    if (!extensionAlive()) return;
    renderCurrentCue();
    reportVideoPosition(activeVideo);
    requestAnimationFrame(renderCaptionFrame);
  }
  requestAnimationFrame(renderCaptionFrame);
  refreshExportState();

  // ================= iframe 视频代理 =================
  // 跨站/同域播放器常把 <video> 放在 iframe 里（如 kanav.ad 的弹幕播放器），
  // 顶层帧拿不到它的位置与时钟。本帧若包含符合条件的视频，就承担：
  //   1) 向后台上报播放位置/跳转，维持实时字幕时钟（capture 模式必需）；
  //   2) 通知顶层显示页面左下角的入口气泡（BSCG_FRAME_VIDEO_PRESENT）；
  //   3) 在本帧内把字幕渲染到视频画面上（此时顶层字幕层保持隐藏）。
  // 不渲染任何入口气泡，避免 0.7 之前"气泡跟着 iframe 跑"的问题。
  function runIframeReporter() {
    if (window.__bscgFrameAgent || document.getElementById('bscg-frame-agent')) return;
    // 太小的帧基本都是广告位；真正的播放器 iframe 不会小于 400x300。
    if (innerWidth < 400 || innerHeight < 300) {
      if (window.__bscgFrameProbe) return;
      window.__bscgFrameProbe = true;
      let probes = 0;
      const grow = setInterval(() => {
        probes += 1;
        if (innerWidth >= 400 && innerHeight >= 300) { clearInterval(grow); window.__bscgFrameProbe = false; runIframeReporter(); }
        else if (probes > 20) { clearInterval(grow); window.__bscgFrameProbe = false; }
      }, 500);
      return;
    }
    window.__bscgFrameAgent = true;

    let video = null;
    const boundMedia = new WeakSet();
    let running = false;
    let hydrated = false;
    let lastReportAt = 0;
    let lastRelayAt = 0;
    let lastPresence = null;
    let lastCueText = '';
    let holdRow = null;
    let holdUntil = 0;
    let replayUntil = 0;
    let previewRow = null;
    let previewRevision = 0;
    let previewTypingTimer = 0;
    const finalizedPreviewIds = new Set();
    let currentSessionId = '';
    let frameMode = '';
    let topOwnsOverlay = false;
    let captionsDismissed = false;
    let displayRevision = 0;
    let rows = [];
    let captionsEl = null;
    let frameCaptionsVisible = false;
    let cueMount = null;
    let seekBar = null;
    let seekBarVideo = null;
    let seekScanAt = -Infinity;
    let lastSeekMove = 0;
    let seekPreviewEl = null;
    let spTimeEl = null;
    let spTextEl = null;

    let contextInvalid = false;
    function send(message) {
      if (contextInvalid || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return Promise.resolve();
      try {
        return chrome.runtime.sendMessage(message).catch((error) => {
          if (/invalidated|reloaded/i.test(String(error?.message || error))) contextInvalid = true;
          return undefined;
        });
      } catch (error) {
        if (/invalidated|reloaded/i.test(String(error?.message || error))) contextInvalid = true;
        return Promise.resolve();
      }
    }

    function findVideo() {
      if (!pageAllowsControls()) return null;
      const candidates = bscgFindMedia('controls');
      return (candidates.find(candidate => candidate.visible) || candidates[0])?.video || null;
    }

    function setFrameCaptionVisibility(visible) {
      frameCaptionsVisible = Boolean(visible);
      setCaptionSurfaceVisible(captionsEl, frameCaptionsVisible && Boolean(video) && pageAllowsControls());
    }

    function ensureOverlay() {
      if (captionsEl) return;
      const agent = document.createElement('div');
      agent.id = 'bscg-frame-agent';
      Object.assign(agent.style, { position: 'fixed', inset: '0', zIndex: '2147483646', pointerEvents: 'none' });
      const root = agent.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host{all:initial}
          #captions{position:fixed;box-sizing:border-box;text-align:center;pointer-events:none;color:#fff;font:700 24px/1.46 system-ui,"Microsoft YaHei",sans-serif;text-shadow:0 1px 3px #000}
          #captions.hidden{opacity:0;visibility:hidden;pointer-events:none}
          #seek-preview{position:fixed;z-index:2147483647;box-sizing:border-box;max-width:320px;padding:6px 12px 7px;border-radius:10px;background:rgba(12,18,28,.72);backdrop-filter:blur(6px);color:#fff;font:600 12.5px/1.45 system-ui,"Microsoft YaHei",sans-serif;text-align:center;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.28);opacity:1;transition:opacity .1s}
          #seek-preview.hidden{opacity:0}
          #sp-time{display:block;font:700 10.5px/1 system-ui,sans-serif;letter-spacing:.04em;color:rgba(255,255,255,.65);margin-bottom:2px}
          #sp-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal}
          .cue{display:table;margin:0 auto;padding:4px 14px 5px;border-radius:10px;background:rgba(12,18,28,.6);box-decoration-break:clone;-webkit-box-decoration-break:clone;white-space:pre-line}.cue.preview{opacity:.9;background:rgba(12,18,28,.52);outline:1px solid rgba(255,255,255,.16)}.cue-main{display:block}.cue-src{display:block;margin-top:2px;font-size:.72em;font-weight:500;line-height:1.35;opacity:.78}
        </style>
        <div id="captions" class="hidden" inert aria-hidden="true" aria-live="polite"><div id="cue-mount"></div></div>
        <div id="seek-preview" class="hidden" aria-hidden="true"><span id="sp-time"></span><span id="sp-text"></span></div>`;
      document.documentElement.appendChild(agent);
      captionsEl = root.querySelector('#captions');
      cueMount = root.querySelector('#cue-mount');
      seekPreviewEl = root.querySelector('#seek-preview');
      spTimeEl = root.querySelector('#sp-time');
      spTextEl = root.querySelector('#sp-text');
    }

    function relayPresence(force = false, present = Boolean(video)) {
      const now = Date.now();
      if (!force && lastPresence === present && now - lastRelayAt < 15000) return;
      lastRelayAt = now;
      lastPresence = present;
      void send({ type: 'BSCG_FRAME_VIDEO_PRESENT', present });
    }

    function report(force = false) {
      if (!video) return;
      const now = performance.now();
      if (!force && now - lastReportAt < 450) return;
      lastReportAt = now;
      void send({
        type: 'BSCG_VIDEO_POSITION',
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
        preservesPitch: video.preservesPitch,
        paused: video.paused,
        wallTime: Date.now()
      });
    }

    function renderCue() {
      if (!video || !captionsEl) return;
      const nativeRect = video.getBoundingClientRect();
      const drawable = video.tagName !== 'AUDIO' && nativeRect.width >= 120 && nativeRect.height >= 90;
      const rect = captionRect({ rect: nativeRect, drawable });
      const horizontalInset = Math.max(18, Math.min(72, rect.width * 0.07));
      captionsEl.style.left = `${rect.left + horizontalInset}px`;
      captionsEl.style.width = `${Math.max(180, rect.width - horizontalInset * 2)}px`;
      captionsEl.style.top = `${Math.max(rect.top + 30, rect.bottom - Math.max(96, rect.height * 0.18))}px`;
      captionsEl.style.fontSize = `${Math.round(Math.max(16, Math.min(30, rect.width * 0.026)))}px`;
      const currentTime = Math.max(0, Number(video.currentTime) || 0);
      const timeline = frameMode === 'live' ? null : rows.findLast((row) => row.from <= currentTime && row.to > currentTime) || null;
      const realtime = ['capture', 'live'].includes(frameMode);
      const displayRows = captionDisplayRows(timeline, realtime ? holdRow : null, holdUntil,
        realtime ? previewRow : null, performance.now(), frameMode === 'live' ? Infinity : currentTime, replayUntil);
      const renderKey = JSON.stringify(displayRows.map((row) => [row.provisional, row.content, row.sourceContent || '']));
      if (renderKey === lastCueText) return;
      lastCueText = renderKey;
      paintCaptionRows(cueMount, displayRows);
    }

    function stopPreviewTyping() {
      if (previewTypingTimer) clearInterval(previewTypingTimer);
      previewTypingTimer = 0;
    }

    function animatePreview(nextPreview) {
      stopPreviewTyping();
      previewRow = { ...nextPreview, content: String(nextPreview?.content || '') };
      renderCue();
    }

    function adopt(found) {
      video = found;
      video.dataset.bscgAgentBound = '1';
      if (!boundMedia.has(found)) {
        boundMedia.add(found);
        found.addEventListener('seeked', () => {
          if (video !== found || frameMode === 'live') return;
          replayUntil = Math.max(0, ...rows.map(row => Number(row.to) || 0));
          holdRow = null;
          holdUntil = 0;
          previewRow = null;
          previewRevision = 0;
          lastCueText = '';
          void send({ type: 'BSCG_LIVE_SEEK', currentTime: found.currentTime });
          renderCue();
        });
        found.addEventListener('timeupdate', () => { if (video === found) report(false); }, { passive: true });
        found.addEventListener('ended', () => {
          if (running && video === found) void send({ type: 'BSCG_LIVE_MEDIA_ENDED', sessionId: currentSessionId });
        });
        for (const eventName of ['play', 'pause', 'ratechange']) {
          found.addEventListener(eventName, () => { if (video === found) report(true); }, { passive: true });
        }
      }
      ensureOverlay();
      relayPresence(true);
      if (!hydrated) {
        hydrated = true;
        const revisionAtRequest = displayRevision;
        void send({ type: 'BSCG_LIVE_UI_READY' }).then((response) => {
          if (!response?.ok || !video || revisionAtRequest !== displayRevision) return;
          running = Boolean(response.running);
          if (typeof response.captionVisibility === 'boolean') captionsDismissed = !response.captionVisibility;
          frameMode = response.mode || '';
          topOwnsOverlay = Boolean(response.overlayOnTop);
          currentSessionId = String(response.sessionId || '');
          rows = (response.segments || []).map((row) => ({
            from: Math.max(0, Number(row.from) || 0),
            to: Math.max(Number(row.from) || 0, Number(row.to) || 0),
            content: String(row.content || '')
          })).filter((row) => row.content);
          previewRow = response.previewSegment?.content ? { ...response.previewSegment } : null;
          holdRow = response.finalSegment?.content ? { ...response.finalSegment } : null;
          previewRevision = Math.max(0, Number(response.previewSegment?.revision) || 0);
          setFrameCaptionVisibility(!(topOwnsOverlay || captionsDismissed || response.stopping || (!running && response.captionVisibility !== true)));
          renderCue();
        });
      }
    }

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'BSCG_CAPTIONS_VISIBILITY') {
        displayRevision += 1;
        captionsDismissed = !message.visible;
        if (message.mode === 'file') {
          frameMode = 'file';
          running = false;
          currentSessionId = message.sessionId || currentSessionId;
          rows = (message.segments || []).filter((row) => row?.content);
        }
        if (message.visible) ensureOverlay();
        setFrameCaptionVisibility(!topOwnsOverlay && message.visible);
        if (!message.visible) setupSeekPreview();
        renderCue();
        return;
      }
      if (message?.type?.startsWith('BSCG_LIVE_') && message.type !== 'BSCG_LIVE_STARTED' &&
          message.type !== 'BSCG_LIVE_REUSED' && message.sessionId && currentSessionId &&
          message.sessionId !== currentSessionId) return;
      if (message?.type === 'BSCG_LIVE_STARTED' || message?.type === 'BSCG_LIVE_REUSED') {
        displayRevision += 1;
        if (message.captionVisibility === false) captionsDismissed = true;
        stopPreviewTyping();
        running = message.type === 'BSCG_LIVE_STARTED';
        currentSessionId = String(message.sessionId || currentSessionId || '');
        frameMode = running ? message.mode || 'capture' : 'file';
        topOwnsOverlay = Boolean(message.overlayOnTop);
        rows = [];
        replayUntil = 0;
        holdRow = null;
        previewRow = null;
        previewRevision = 0;
        for (const row of message.segments || []) {
          if (!row?.content) continue;
          const seeded = {
            from: Math.max(0, Number(row.from) || 0),
            to: Math.max(Number(row.from) || 0, Number(row.to) || 0),
            content: String(row.content)
          };
          if (row.sourceContent) seeded.sourceContent = String(row.sourceContent);
          rows.push(seeded);
        }
        rows.sort((a, b) => a.from - b.from);
        ensureOverlay();
        setFrameCaptionVisibility(!topOwnsOverlay && !captionsDismissed);
        renderCue();
      } else if (message?.type === 'BSCG_LIVE_FINAL' && message.segment?.content) {
        const segment = { ...message.segment };
        finalizedPreviewIds.add(segment.id);
        if (finalizedPreviewIds.size > 32) finalizedPreviewIds.delete(finalizedPreviewIds.values().next().value);
        holdRow = segment;
        holdUntil = performance.now() + finalCaptionHoldMs(segment.content);
        if (previewRow?.id === segment.id) previewRow = null;
        renderCue();
      } else if (message?.type === 'BSCG_LIVE_SEGMENT' && message.segment?.content) {
        const segment = {
          from: Math.max(0, Number(message.segment.from) || 0),
          to: Math.max(Number(message.segment.from) || 0, Number(message.segment.to) || 0),
          content: String(message.segment.content)
        };
        if (message.segment.sourceContent) segment.sourceContent = String(message.segment.sourceContent);
        const index = rows.findIndex((row) => Math.abs(row.from - segment.from) < 0.05);
        if (index >= 0) rows[index] = segment; else rows.push(segment);
        rows.sort((a, b) => a.from - b.from);
        if (!message.finalDisplayManaged) {
          holdRow = segment;
          holdUntil = performance.now() + Math.max(4000, Math.min(10000, (segment.to - segment.from) * 750));
        }
        renderCue();
      } else if (message?.type === 'BSCG_LIVE_PREVIEW' && message.segment?.content) {
        if (message.sessionId && currentSessionId && message.sessionId !== currentSessionId) return;
        const previewId = String(message.previewId || message.segment.id || 'current');
        if (finalizedPreviewIds.has(previewId)) return;
        const revision = Math.max(0, Number(message.revision ?? message.segment.revision) || 0);
        if (previewRow?.id === previewId && revision < previewRevision) return;
        const nextPreview = {
          id: previewId,
          revision,
          from: Math.max(0, Number(message.segment.from) || 0),
          to: Math.max(Number(message.segment.from) || 0, Number(message.segment.to) || Number(message.segment.from) || 0),
          content: String(message.segment.content),
          singleLine: Boolean(message.segment.singleLine),
          sourceContent: String(message.segment.sourceContent || ''),
          stableContent: String(message.segment.stableContent || '')
        };
        previewRevision = revision;
        animatePreview(nextPreview);
      } else if (message?.type === 'BSCG_LIVE_PREVIEW_CLEAR') {
        if (message.sessionId && currentSessionId && message.sessionId !== currentSessionId) return;
        const previewId = String(message.previewId || '');
        const revision = Math.max(0, Number(message.revision) || 0);
        if (previewRow && (!previewId || previewRow.id === previewId) && (!revision || revision >= previewRevision)) {
          stopPreviewTyping();
          previewRow = null;
          previewRevision = 0;
          lastCueText = '';
          renderCue();
        }
      } else if (message?.type === 'BSCG_LIVE_INVALIDATE_RANGE') {
        stopPreviewTyping();
        const from = Math.max(0, Number(message.from) || 0);
        const to = Math.max(from, Number(message.to) || from);
        rows = rows.filter((row) => !(row.to > from && row.from < to));
        holdRow = null;
        previewRow = null;
        previewRevision = 0;
        lastCueText = '';
        renderCue();
      } else if (message?.type === 'BSCG_LIVE_STOPPED' || message?.type === 'BSCG_LIVE_ERROR') {
        displayRevision += 1;
        stopPreviewTyping();
        running = false;
        previewRow = null;
        previewRevision = 0;
        setFrameCaptionVisibility(!(topOwnsOverlay || captionsDismissed || !message.keepVisible));
        setupSeekPreview();
      }
    });

    // ---- 时间轴悬停字幕预览（与顶层同逻辑，作用于本帧的播放器）----
    const SEEK_BAR_SELECTORS = ['.dplayer-bar-wrap', '.ytp-progress-bar', '.bpx-player-progress', '.vjs-progress-holder', '.plyr__progress__container', '.art-control-progress', '.xgplayer-progress'];
    function fmtClock(totalSec) {
      const total = Math.max(0, Math.floor(Number(totalSec) || 0));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const mm = String(m).padStart(2, '0');
      const ss = String(total % 60).padStart(2, '0');
      return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
    }
    function hideSeekPreview() {
      if (seekPreviewEl) seekPreviewEl.classList.add('hidden');
    }
    function onSeekMove(event) {
      if (captionsDismissed || topOwnsOverlay || !captionsEl || captionsEl.classList.contains('hidden') || frameMode === 'live') { hideSeekPreview(); return; }
      const now = performance.now();
      if (now - lastSeekMove < 33 || !video || !seekBar) return;
      lastSeekMove = now;
      const duration = Number(video.duration);
      if (!Number.isFinite(duration) || duration <= 0 || !rows.length) { hideSeekPreview(); return; }
      let ratio;
      let anchorTop;
      if (seekBar === video) {
        // Chrome 原生播放器：用视频底部控件条近似命中时间轴
        const rect = video.getBoundingClientRect();
        const height = Math.max(32, Math.min(72, rect.height * 0.13));
        const left = rect.left + Math.min(rect.width * 0.3, 190);
        const right = rect.right - Math.min(rect.width * 0.2, 140);
        if (event.clientY < rect.bottom - height || event.clientY > rect.bottom || event.clientX < left || event.clientX > Math.max(left + 40, right)) { hideSeekPreview(); return; }
        ratio = Math.max(0, Math.min(1, (event.clientX - left) / (Math.max(left + 40, right) - left)));
        anchorTop = rect.bottom - height;
      } else {
        const rect = seekBar.getBoundingClientRect();
        ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
        anchorTop = rect.top;
      }
      const time = ratio * duration;
      let cue = null;
      for (const row of rows) {
        if (time >= row.from - 0.05 && time <= row.to + 0.05) { cue = row; break; }
      }
      if (!cue || !cue.content) { hideSeekPreview(); return; }
      ensureOverlay();
      seekPreviewEl.style.left = `${Math.max(8, Math.min(innerWidth - seekPreviewEl.offsetWidth - 8, event.clientX - seekPreviewEl.offsetWidth / 2))}px`;
      seekPreviewEl.style.top = `${Math.max(8, anchorTop - seekPreviewEl.offsetHeight - 10)}px`;
      spTimeEl.textContent = fmtClock(time);
      spTextEl.textContent = cue.sourceContent ? `${cue.content}\n${cue.sourceContent}` : cue.content;
      seekPreviewEl.classList.remove('hidden');
    }
    function attachSeekBar(bar) {
      if (seekBar) {
        seekBar.removeEventListener('mousemove', onSeekMove);
        seekBar.removeEventListener('mouseleave', hideSeekPreview);
      }
      seekBar = bar;
      if (seekBar) {
        seekBar.addEventListener('mousemove', onSeekMove);
        seekBar.addEventListener('mouseleave', hideSeekPreview);
      }
    }
    function setupSeekPreview() {
      if (!video || !captionsEl || captionsEl.classList.contains('hidden') || captionsDismissed ||
          topOwnsOverlay || !rows.length || frameMode === 'live') {
        attachSeekBar(null);
        seekBarVideo = null;
        seekScanAt = -Infinity;
        hideSeekPreview();
        return;
      }
      if (seekBarVideo === video && seekBar?.isConnected) return;
      if (seekBarVideo === video && performance.now() - seekScanAt < 2000) return;
      seekBarVideo = video;
      seekScanAt = performance.now();
      let bar = null;
      for (const sel of SEEK_BAR_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && el.isConnected && el.getBoundingClientRect().width > 120) { bar = el; break; }
      }
      if (!bar && video) {
        const vr = video.getBoundingClientRect();
        const container = video.closest('[class*="player" i], [class*="video" i], [id*="player" i]') || video.parentElement?.parentElement || null;
        let best = null;
        let bestWidth = 0;
        if (container) {
          for (const el of container.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.width >= vr.width * 0.5 && r.height >= 3 && r.height <= 36 && r.top >= vr.top + vr.height * 0.45 && r.width / Math.max(1, r.height) >= 4) {
              if (r.width > bestWidth) { best = el; bestWidth = r.width; }
            }
          }
        }
        bar = best;
      }
      // Chrome 原生播放器：退回用 video 元素本身近似命中
      if (!bar && video && video.controls) bar = video;
      attachSeekBar(bar);
    }
    const scan = () => {
      const found = findVideo();
      if (!found) {
        video = null;
        if (lastPresence !== false) relayPresence(true, false);
        setCaptionSurfaceVisible(captionsEl, false);
        setupSeekPreview();
        return;
      }
      if (found && found !== video) adopt(found);
      if (video) {
        setCaptionSurfaceVisible(captionsEl, frameCaptionsVisible);
        relayPresence(false);
        if (running) report(false);
        renderCue();
        setupSeekPreview();
      }
    };
    scan();
    setInterval(() => {
      if (contextInvalid || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
      scan();
    }, 1000);
    function renderFrame() {
      if (contextInvalid) return;
      if (video && frameCaptionsVisible) renderCue();
      requestAnimationFrame(renderFrame);
    }
    requestAnimationFrame(renderFrame);
  }

  // ================= 页面内音频捕获（浏览器引擎一键启动）=================
  function installInpageCapture() {
  if (window.__bscgInpageCaptureInstalled) return;
  window.__bscgInpageCaptureInstalled = true;
  // 把本帧的 <video> 元素接进 WebAudio 直接取 PCM，供实时字幕使用。
  // chrome.tabCapture 要求扩展“已被唤起”（快捷键/工具栏点击），页面内的悬浮
  // 按钮给不了这个授权；元素直取没有这个限制。B站/YouTube 的 MSE 视频是同源
  // 流，取音不会被污染；跨源 <video src> 会被浏览器整体静音，启动前按 URL
  // 识别，运行中用零信号看门狗兜底，都让后台回退到 tabCapture 路径。
  const inpageCaptures = new Map();
  const INPAGE_MAX_QUEUED_CHUNKS = 12;
  // 页面内取音只负责把连续 PCM 小帧送到离屏引擎；VAD、滚动预览与最终
  // 断句统一由引擎完成，避免兜底路径先攒完整句子而失去低延迟字幕。
  const INPAGE_STREAM_FRAME_SECONDS = 0.20;
  const taintedMediaElements = new WeakSet();
  let inpageAudioContext = null;
  let inpageWorkletReady = null;
  const inpageSourceCache = new WeakMap();
  const inpagePlaybackCache = new WeakMap();

  function inpageBytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
    }
    return btoa(binary);
  }

  function inpageToPcm16(samples) {
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
    }
    return new Uint8Array(pcm.buffer);
  }

  function inpageResampleTo16k(input, inputRate) {
    if (inputRate === 16000) return input;
    const ratio = inputRate / 16000;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
      let sum = 0;
      for (let source = start; source < end; source += 1) sum += input[source];
      output[index] = sum / (end - start);
    }
    return output;
  }

  function findCapturableVideo() {
    return bscgFindMedia('all').find(({ video }) => !taintedMediaElements.has(video))?.video || null;
  }

  function elementTaintsAudio(videoEl) {
    // MediaElementSource 对跨源内容一律输出静音；blob:/data:（MSE）视为同源
    const src = videoEl.currentSrc || videoEl.src || '';
    if (!src || /^(blob|data|mediasource):/i.test(src)) return false;
    try { return new URL(src, location.href).origin !== location.origin; } catch { return false; }
  }

  // 过程细节一律写运行日志；只有用户需要动手的提示才进气泡
  function logCapture(state, text, level = 'info') {
    chrome.runtime.sendMessage({ type: 'BSCG_LOG', source: 'content', level, text }).catch(() => {});
  }

  function noteCapture(state, text) {
    logCapture(state, text);
    chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_NOTE', sessionId: state.sessionId, text }).catch(() => {});
  }

  function releaseElementCaptureStream(state) {
    const stream = state?.elementCaptureStream;
    state.elementCaptureStream = null;
    if (!stream) return;
    try { stream.getTracks().forEach((track) => track.stop()); } catch {}
  }

  function restoreCaptureOutput(state) {
    releaseElementCaptureStream(state);
    try { if (state?.playback?.gain) state.playback.gain.value = 1; } catch {}
  }

  function tryElementCaptureStream(el) {
    const capture = el?.captureStream || el?.mozCaptureStream;
    if (typeof capture !== 'function') return null;
    let stream = null;
    try {
      stream = capture.call(el);
      if (stream?.getAudioTracks?.().some((track) => track.readyState !== 'ended')) return stream;
    } catch {}
    try { stream?.getTracks?.().forEach((track) => track.stop()); } catch {}
    return null;
  }

  // 实时监听优先用 HTMLMediaElement.captureStream()：它复制播放流，不接管元素
  // 原有扬声器输出。本地 file:// 视频因此即使采集启动/停止失败也不会被静音。
  // 自动整轨扫描需要主动静音扬声器，才使用可控的 MediaElementSource 旁路。
  function bindCaptureElement(state, el) {
    try { state.source?.disconnect(state.processor); } catch {}
    restoreCaptureOutput(state);
    state.videoEl = el;
    state.source = null;
    state.playback = null;
    state.sourceKind = '';
    state.boundSourceUrl = String(el.currentSrc || el.src || '');

    if (!state.silentOutput) {
      const stream = tryElementCaptureStream(el);
      if (stream) {
        state.elementCaptureStream = stream;
        state.source = state.audioContext.createMediaStreamSource(stream);
        state.sourceKind = 'element-stream';
        state.source.connect(state.processor);
        return;
      }
      if (state.requireCopyStream) {
        throw new Error(state.isLive ? '播放器无法直接取音；请从扩展面板选择“当前标签页声音”' : '当前本地播放器无法复制音频流；已停止字幕且保持原声音不变');
      }
    }

    let reused = inpageSourceCache.get(el);
    if (!reused) {
      reused = state.audioContext.createMediaElementSource(el);
      const playback = state.audioContext.createGain();
      playback.gain.value = state.silentOutput ? 0 : 1;
      reused.connect(playback);
      playback.connect(state.audioContext.destination);
      inpageSourceCache.set(el, reused);
      inpagePlaybackCache.set(el, playback);
    }
    state.source = reused;
    state.sourceKind = 'media-element';
    state.playback = inpagePlaybackCache.get(el) || null;
    if (state.playback) state.playback.gain.value = state.silentOutput ? 0 : 1;
    state.source.connect(state.processor);
  }

  // 把采集挂到新的媒体元素（播放器重建视频元素、或视频元素里没有声音需要
  // 改挂 <audio> 时共用）。实时优先复制流；MediaElementSource 仅作为兼容后备。
  function adoptCaptureElement(state, el) {
    try { state.videoEl?.removeEventListener('ended', state.onMediaEnded); } catch {}
    try { state.videoEl?.removeEventListener('seeking', state.onMediaSeeking); } catch {}
    state.onMediaSeeking?.();
    bindCaptureElement(state, el);
    try { el.addEventListener('ended', state.onMediaEnded, { once: true }); } catch {}
    try { el.addEventListener('seeking', state.onMediaSeeking); } catch {}
  }

  // 个别播放器把视频轨和音频轨拆成两个元素：画面在 <video>、声音在 <audio>。
  // 视频元素长时间取不到声音时按这些特征找真正的音频元素。
  function findFallbackAudioElement() {
    for (const audio of document.querySelectorAll('audio')) {
      if (taintedMediaElements.has(audio) || audio.muted) continue;
      if (!(audio.currentSrc || audio.src || '')) continue;
      if (audio.paused) continue;
      if (audio.readyState < 2) continue;
      const longEnough = !Number.isFinite(audio.duration) || audio.duration >= 45;
      if (longEnough) return audio;
    }
    return null;
  }

  function queueLiveCaptureBoundary(state) {
    if (!state.isLive || state.boundaryQueued || state.stopping) return;
    state.boundaryQueued = true;
    void flushInpageCapture(state, false);
    // Same send chain as PCM: commit the preceding utterance before new-source PCM.
    state.sendChain = state.sendChain.then(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_BOUNDARY', sessionId: state.sessionId });
      if (!response?.ok) throw new Error(response?.error || '后台拒绝了直播音频边界');
    }).catch((error) => {
      state.sendFailure ||= error;
      void stopInpageCapture('send-error', state.sessionId).catch(() => {});
    });
  }

  function maintainLiveCapture(state) {
    if (!state.isLive || state.stopping) return true;
    const now = Date.now();
    if (state.reconnectSince && now - state.reconnectSince >= 30000) {
      noteCapture(state, '直播音频中断超过 30 秒，已停止字幕；恢复播放后可重新开启');
      void stopInpageCapture('live-interrupted', state.sessionId).catch(() => {});
      return false;
    }
    const current = state.videoEl;
    const deadStream = state.sourceKind === 'element-stream' &&
      !state.elementCaptureStream?.getAudioTracks?.().some((track) => track.readyState !== 'ended');
    const sourceChanged = state.boundSourceUrl !== String(current?.currentSrc || current?.src || '');
    const stalled = state.audioContext.state === 'running' && !current?.paused && now - (state.lastCallbackAt || state.startedAt) > 5000;
    if (current?.isConnected && !current.ended && (current.paused || current.readyState >= 2) &&
        state.source && !deadStream && !sourceChanged && !stalled) return true;
    if (!state.reconnectSince) {
      state.reconnectSince = now;
      queueLiveCaptureBoundary(state);
      noteCapture(state, '直播播放器正在重连，等待音频恢复…');
    }
    const next = findCapturableVideo();
    if (!next || next.ended || next.readyState < 2 || now - state.lastRebindAt < 1500) return false;
    state.lastRebindAt = now;
    try {
      adoptCaptureElement(state, next);
      state.lastCallbackAt = now;
    } catch (error) {
      logCapture(state, `直播音频重绑等待：${error?.message || error}`, 'warn');
    }
    return false;
  }

  async function flushInpageCapture(state, final = false) {
    if (!state || inpageCaptures.get(state.sessionId) !== state || (!state.sampleCount && !final)) return;
    if (state.sampleCount) {
      if (state.stopping && !final) return;
      if (!final && state.outstandingChunks >= INPAGE_MAX_QUEUED_CHUNKS) {
        state.sendFailure ||= new Error('音频处理速度跟不上播放速度，已停止以避免占用过多内存');
        void stopInpageCapture('backpressure', state.sessionId).catch(() => {});
        return;
      }
      if (!state.voiceSeen && final) {
        state.chunks = [];
        state.sampleCount = 0;
        state.silenceSamples = 0;
        await state.sendChain;
        return;
      }
      const merged = new Float32Array(state.sampleCount);
      let offset = 0;
      for (const chunk of state.chunks) { merged.set(chunk, offset); offset += chunk.length; }
      state.chunks = [];
      state.sampleCount = 0;
      state.voiceSeen = false;
      state.silenceSamples = 0;
      const pcm = inpageToPcm16(inpageResampleTo16k(merged, state.pcmSampleRate || state.audioContext.sampleRate));
      const sequence = state.sequence++;
      const payload = {
        type: 'BSCG_CAPTURE_CHUNK',
        sessionId: state.sessionId,
        sequence,
        captureGeneration: state.generation,
        capturedAt: Date.now(),
        timing: state.pendingTiming || {
          currentTime: Number(state.videoEl.currentTime) || 0,
          playbackRate: Number(state.videoEl.playbackRate) || 1,
          paused: Boolean(state.videoEl.paused)
        },
        durationSeconds: pcm.byteLength / 2 / 16000,
        pcmBase64: inpageBytesToBase64(pcm)
      };
      state.outstandingChunks += 1;
      const delivery = state.sendChain.catch(() => {}).then(async () => {
        if (state.sendFailure) throw state.sendFailure;
        if (payload.captureGeneration !== state.generation) return;
        const response = await chrome.runtime.sendMessage(payload);
        if (!response?.ok) throw new Error(response?.error || '后台拒绝了音频分段');
        if (!final && (sequence === 0 || (sequence + 1) % 20 === 0)) {
          logCapture(state, `页面内流式音频已送出 ${sequence + 1} 帧（本帧 ${payload.durationSeconds.toFixed(2)} 秒${state.scanMode ? '，已恢复语速' : ''}）`);
        }
      }).finally(() => {
        state.outstandingChunks = Math.max(0, state.outstandingChunks - 1);
      });
      state.sendChain = delivery;
      void delivery.catch((error) => {
        state.sendFailure ||= error;
        void stopInpageCapture('send-error', state.sessionId).catch(() => {});
      });
    }
    if (final) await state.sendChain;
  }

  async function stopInpageCapture(reason = 'user', expectedSessionId = '') {
    const state = expectedSessionId ? inpageCaptures.get(expectedSessionId) : null;
    if (!state) {
      if (expectedSessionId) {
        chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_STOPPED', sessionId: expectedSessionId }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_ENDED', sessionId: expectedSessionId, reason }).catch(() => {});
      }
      return;
    }
    if (state.stopPromise) return state.stopPromise;
    state.stopping = true;
    state.stopPromise = (async () => {
      let failure = state.sendFailure || null;
      try {
        // Worklets can hold a sub-2048-sample tail. Drain it while the original
        // scan rate and final media time still describe the captured samples.
        if (state.processorKind === 'worklet') {
          state.flushingWorklet = true;
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 400);
            state.resolveWorkletFlush = () => { clearTimeout(timer); resolve(); };
            try { state.source.disconnect(state.processor); state.processor.port.postMessage({ type: 'flush' }); }
            catch { state.resolveWorkletFlush(); }
          });
          state.flushingWorklet = false;
          state.resolveWorkletFlush = null;
        }
        const tail = state.captureResampler?.flush();
        if (tail?.length) { state.chunks.push(tail); state.sampleCount += tail.length; }
        try {
          if (state.processorKind === 'worklet') state.processor.port.onmessage = null;
          else state.processor.onaudioprocess = null;
        } catch (error) { failure ||= error; }
        try { state.processor.disconnect(); } catch (error) { failure ||= error; }
        try { state.monitor.disconnect(); } catch (error) { failure ||= error; }
        try { state.source.disconnect(state.processor); } catch {}
        try { state.videoEl?.removeEventListener('ended', state.onMediaEnded); } catch {}
        try { state.videoEl?.removeEventListener('seeking', state.onMediaSeeking); } catch {}
        restoreCaptureOutput(state);
        // 共享 AudioContext 与元素 source 常驻（source→destination 保持接通），
        // 停止采集后视频照常出声；MediaElementSource 对同一元素只能创建一次。
        await flushInpageCapture(state, true);
      } catch (error) {
        failure ||= error;
      } finally {
        // 任一节点清理或最后 PCM 投递失败，都不能阻止扬声器恢复。
        restoreCaptureOutput(state);
        if (state.watchdogTimer) clearInterval(state.watchdogTimer);
        inpageCaptures.delete(state.sessionId);
        try { await chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_STOPPED', sessionId: state.sessionId }); } catch (error) { failure ||= error; }
        try { await chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_ENDED', sessionId: state.sessionId, reason }); } catch (error) { failure ||= error; }
      }
      if (failure) throw failure;
    })();
    return state.stopPromise;
  }

  async function startInpageCapture(message) {
    if (inpageCaptures.size >= 3) throw new Error('并发音频捕获已达上限（3 个）');
    if (inpageCaptures.has(message.sessionId)) return;
    const videoEl = findCapturableVideo();
    if (!videoEl) throw new Error('请先播放视频或音频；特殊播放器可从扩展面板选择“当前标签页声音”');
    if (elementTaintsAudio(videoEl)) {
      taintedMediaElements.add(videoEl);
      throw new Error('播放器限制了直接取音；请从扩展面板选择“当前标签页声音”');
    }
    if (!inpageAudioContext) inpageAudioContext = new AudioContext();
    await inpageAudioContext.resume();
    if (inpageAudioContext.state !== 'running') throw new Error('页面音频上下文未获得运行权限');
    let processor = null;
    let processorKind = 'worklet';
    try {
      inpageWorkletReady ||= inpageAudioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
      await inpageWorkletReady;
      processor = new AudioWorkletNode(inpageAudioContext, 'bili-asr-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
      });
    } catch (workletError) {
      processorKind = 'script-processor';
      processor = inpageAudioContext.createScriptProcessor(4096, 1, 1);
      logCapture({ sessionId: message.sessionId }, `AudioWorklet 不可用，启用页面兼容采样：${workletError?.message || workletError}`, 'warn');
    }
    const monitor = inpageAudioContext.createGain();
    monitor.gain.value = 0;
    const state = {
      sessionId: message.sessionId,
      videoEl,
      audioContext: inpageAudioContext,
      source: null,
      playback: null,
      sourceKind: '',
      elementCaptureStream: null,
      processor,
      processorKind,
      monitor,
      silentOutput: Boolean(message.silentOutput),
      scanMode: Boolean(message.scanMode), scanActive: false,
      pcmSampleRate: message.scanMode ? 16000 : inpageAudioContext.sampleRate,
      isLive: Boolean(message.isLive),
      startedAt: Date.now(), reconnectSince: 0, lastRebindAt: 0, boundaryQueued: false,
      requireCopyStream: Boolean(message.requireCopyStream),
      chunks: [],
      sampleCount: 0,
      voiceSeen: false,
      heardVoice: false,
      silenceSamples: 0,
      noiseFloor: 0.003,
      sequence: 0,
      generation: 0,
      pendingTiming: null,
      silentWatchSamples: 0,
      notifiedNoVoice: 0,
      audioFallbackTried: false,
      recentMaxRms: 0,
      lastCallbackAt: 0,
      watchdogTimer: null,
      voiceNoted: false,
      sendChain: Promise.resolve(),
      sendFailure: null,
      outstandingChunks: 0,
      stopPromise: null,
      stopping: false,
      onMediaEnded: null,
      onMediaSeeking: null
    };
    state.onMediaEnded = () => {
      if (state.isLive) { queueLiveCaptureBoundary(state); return; }
      // A clip can finish while its first model download is still in progress.
      // The scan will seek to the start after model readiness; do not cancel it.
      if (state.scanMode && !state.scanActive) return;
      void stopInpageCapture('media-ended', state.sessionId).catch(() => {});
    };
    state.onMediaSeeking = () => {
      if (state.isLive) { queueLiveCaptureBoundary(state); return; }
      state.generation += 1;
      state.chunks = [];
      state.sampleCount = 0;
      state.pendingTiming = null;
      state.captureResampler = null;
      state.voiceSeen = false;
      state.silenceSamples = 0;
      try { state.processor.port?.postMessage({ type: 'reset' }); } catch {}
      void chrome.runtime.sendMessage({
        type: 'BSCG_CAPTURE_RESET', sessionId: state.sessionId,
        captureGeneration: state.generation,
        timing: { currentTime: Number(state.videoEl.currentTime) || 0, playbackRate: Number(state.videoEl.playbackRate) || 1, paused: Boolean(state.videoEl.paused) }
      }).catch(() => {});
    };
    try {
      bindCaptureElement(state, videoEl);
      videoEl.addEventListener('ended', state.onMediaEnded, { once: true });
      videoEl.addEventListener('seeking', state.onMediaSeeking);
      processor.connect(monitor);
      monitor.connect(inpageAudioContext.destination);
    } catch (error) {
      try { state.source?.disconnect(processor); } catch {}
      try { videoEl.removeEventListener('ended', state.onMediaEnded); } catch {}
      try { videoEl.removeEventListener('seeking', state.onMediaSeeking); } catch {}
      restoreCaptureOutput(state);
      try { processor.disconnect(); } catch {}
      try { monitor.disconnect(); } catch {}
      throw error;
    }
    inpageCaptures.set(state.sessionId, state);
    const handleInpageSamples = (inputSamples) => {
      if (inpageCaptures.get(state.sessionId) !== state || (state.stopping && !state.flushingWorklet)) return;
      if (state.isLive && !maintainLiveCapture(state)) return;
      if (state.isLive && state.reconnectSince) {
        state.reconnectSince = 0;
        noteCapture(state, '直播音频已恢复，继续实时字幕');
      }
      state.boundaryQueued = false;
      state.lastCallbackAt = Date.now();
      if (state.videoEl.seeking) return;
      // 播放器重建了视频元素：换绑到新元素继续采集；找不到就结束本会话
      if (!state.videoEl.isConnected) {
        const next = findCapturableVideo();
        if (next && next !== state.videoEl) {
          adoptCaptureElement(state, next);
        } else if (!next) {
          void stopInpageCapture('media-gone', state.sessionId).catch(() => {});
          return;
        }
      }
      if (state.scanMode) {
        if (!state.scanActive || (!state.flushingWorklet && state.videoEl.paused)) return;
        const rate = Number(state.videoEl.playbackRate) || 1;
        if (Math.abs(rate - state.scanPlaybackRate) > 0.05 || (rate !== 1 && state.videoEl.preservesPitch !== false)) {
          state.sendFailure ||= new Error('播放器改变了扫描倍速或保调状态；请用 1× 重新识别');
          void chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_ERROR', sessionId: state.sessionId, error: state.sendFailure.message }).catch(() => {});
          void stopInpageCapture('rate-changed', state.sessionId).catch(() => {});
          return;
        }
        state.captureResampler ||= BscgCaptureAudio.createResampler(state.audioContext.sampleRate, rate);
        inputSamples = state.captureResampler.process(inputSamples);
      }
      if (!inputSamples.length) return;
      const copy = new Float32Array(inputSamples);
      // Only the legacy element-source path needs volume compensation.
      // captureStream copies source audio independently of element volume/mute.
      if (state.sourceKind === 'media-element' && state.videoEl.volume > 0.01) {
        const gain = Math.min(8, 1 / state.videoEl.volume);
        if (gain > 1.01) {
          for (let index = 0; index < copy.length; index += 1) copy[index] *= gain;
        }
      }
      let energy = 0;
      let nonzero = false;
      for (let index = 0; index < copy.length; index += 1) {
        energy += copy[index] * copy[index];
        if (copy[index] !== 0) nonzero = true;
      }
      const rms = Math.sqrt(energy / Math.max(1, copy.length));
      if (rms > state.recentMaxRms) state.recentMaxRms = rms;
      // 静默看门狗：视频在播却一直听不到人声时，分阶段报状态并尝试自救，
      // 避免会话永远停在“等待声音”而不给任何解释。
      if (!state.heardVoice && !state.videoEl.paused && state.videoEl.readyState >= 2) {
        state.silentWatchSamples += copy.length;
        const waited = state.silentWatchSamples / state.pcmSampleRate;
        if (waited >= 5 && state.notifiedNoVoice < 1) {
          state.notifiedNoVoice = 1;
          if (state.videoEl.muted || state.videoEl.volume === 0) {
            noteCapture(state, '正在监听，但视频处于静音/零音量；取消静音后才能识别人声');
          } else {
            logCapture(state, `监听 ${waited.toFixed(0)} 秒未检测到人声（峰值电平 ${state.recentMaxRms.toFixed(4)}）`);
          }
          state.recentMaxRms = 0;
        }
        if (waited >= 14 && state.notifiedNoVoice < 2) {
          state.notifiedNoVoice = 2;
          const audioEl = state.audioFallbackTried ? null : findFallbackAudioElement();
          if (audioEl) {
            state.audioFallbackTried = true;
            noteCapture(state, '视频元素里没有声音，改挂页面的音频元素继续监听…');
            adoptCaptureElement(state, audioEl);
            state.silentWatchSamples = 0;
            state.notifiedNoVoice = 1;
            state.recentMaxRms = 0;
          } else if (!nonzero && !state.videoEl.muted && state.videoEl.volume > 0) {
            taintedMediaElements.add(state.videoEl);
            noteCapture(state, '页面内取到的是静音数据（视频可能被加密保护）。请重新点「字幕」重试；若仍失败请按 Alt+Shift+S。');
            chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_ERROR', sessionId: state.sessionId, error: '页面内取音被浏览器静音（跨源或加密内容）' }).catch(() => {});
            void stopInpageCapture('tainted-silence', state.sessionId).catch(() => {});
            return;
          } else {
            noteCapture(state, '仍未检测到声音；请确认视频在播放且未静音');
            state.silentWatchSamples = 0;
            state.notifiedNoVoice = 1;
            state.recentMaxRms = 0;
          }
        }
      } else if (state.heardVoice) {
        state.silentWatchSamples = 0;
      }
      if (rms < state.noiseFloor * 2.2) state.noiseFloor = state.noiseFloor * 0.96 + rms * 0.04;
      const voiced = rms >= Math.max(0.0045, Math.min(0.03, state.noiseFloor * 2.8 + 0.0015));
      if (voiced) {
        if (!state.voiceNoted) {
          state.voiceNoted = true;
          logCapture(state, `已检测到声音（电平 ${rms.toFixed(4)}），开始流式送入识别…`);
        }
        state.voiceSeen = true;
        state.heardVoice = true;
        state.silenceSamples = 0;
      } else {
        state.silenceSamples += copy.length;
      }
      state.chunks.push(copy);
      state.sampleCount += copy.length;
      state.pendingTiming = {
        currentTime: Math.max(0, Number(state.videoEl.currentTime) || 0),
        playbackRate: state.scanMode ? 1 : Math.max(0.1, Number(state.videoEl.playbackRate) || 1),
        speedRestored: state.scanMode,
        capturePlaybackRate: Number(state.videoEl.playbackRate) || 1,
        paused: state.flushingWorklet ? false : Boolean(state.videoEl.paused)
      };
      if (state.sampleCount >= state.pcmSampleRate * INPAGE_STREAM_FRAME_SECONDS) {
        void flushInpageCapture(state, false);
      }
    };
    if (processorKind === 'worklet') {
      processor.port.onmessage = (event) => {
        if (event.data?.type === 'flushed') { state.resolveWorkletFlush?.(); return; }
        handleInpageSamples(event.data);
      };
    } else {
      processor.onaudioprocess = (event) => handleInpageSamples(event.inputBuffer.getChannelData(0));
    }
    const bindName = videoEl.tagName === 'AUDIO' ? '音频' : '视频';
    const srcHint = String(videoEl.currentSrc || videoEl.src || '').slice(0, 56);
    const sourceLabel = state.sourceKind === 'element-stream' ? '复制流' : '兼容旁路';
    logCapture(state, `已绑定页面${bindName}元素开始监听（${sourceLabel}）${srcHint ? `（${srcHint}…）` : ''}`);
    // 心跳独立于采样回调，专门回答“音频线程到底有没有在跑”。
    state.watchdogTimer = setInterval(() => {
      if (inpageCaptures.get(state.sessionId) !== state) { clearInterval(state.watchdogTimer); return; }
      // Resume independently of source rebinding; a suspended context cannot
      // produce the callback that would otherwise exit the reconnect state.
      if (state.audioContext.state !== 'running') state.audioContext.resume().catch(() => {});
      if (state.isLive && !maintainLiveCapture(state)) return;
      if (state.isLive && Date.now() - (state.lastHealthReportAt || 0) < 8000) return;
      state.lastHealthReportAt = Date.now();
      if (state.audioContext.state !== 'running') {
        logCapture(state, `页面音频上下文已挂起（${state.audioContext.state}），尝试恢复…`, 'warn');
        return;
      }
      const sinceMs = state.lastCallbackAt ? Date.now() - state.lastCallbackAt : Infinity;
      if (sinceMs > 4000) {
        logCapture(state, '页面声音通道 4 秒没有产出数据（回调停摆）', 'warn');
        return;
      }
      if (state.videoEl.paused) {
        logCapture(state, `已绑定的页面${state.videoEl.tagName === 'AUDIO' ? '音频' : '视频'}元素处于暂停状态；正在播放的可能不是它`);
      }
    }, state.isLive ? 1000 : 8000);
    chrome.runtime.sendMessage({ type: 'BSCG_CAPTURE_STARTED', sessionId: message.sessionId }).catch(() => {});
  }

  scanCaptureHooks = {
    start(sessionId, rate) {
      const state = inpageCaptures.get(sessionId);
      if (!state?.scanMode || state.stopping) return;
      state.captureResampler = null;
      state.scanPlaybackRate = rate;
      state.chunks = [];
      state.sampleCount = 0;
      state.pendingTiming = null;
      try { state.processor.port?.postMessage({ type: 'reset' }); } catch {}
      state.scanActive = true;
    },
    async stop(sessionId) {
      const state = inpageCaptures.get(sessionId);
      if (state?.scanMode) await stopInpageCapture('scan-complete', sessionId);
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'BSCG_INPAGE_CAPTURE_START') {
      // 本帧没有可捕获的视频就不回应，让真正带视频的帧认领；若所有帧都没有，
      // 后台收不到响应会自动回退到 tabCapture 路径。
      if (!findCapturableVideo()) return;
      startInpageCapture(message).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === 'BSCG_INPAGE_CAPTURE_STOP') {
      if (!inpageCaptures.has(message.sessionId)) return; // 本帧不是捕获帧
      stopInpageCapture('user', message.sessionId).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === 'BSCG_INPAGE_CAPTURE_SEEK') {
      const state = inpageCaptures.get(message.sessionId);
      if (!state) return; // 本帧不是捕获帧
      state.generation = Math.max(0, Number(message.captureGeneration) || 0);
      state.chunks = [];
      state.sampleCount = 0;
      state.voiceSeen = false;
      state.heardVoice = false;
      state.silenceSamples = 0;
      state.silentWatchSamples = 0;
      state.notifiedNoVoice = 0;
      sendResponse({ ok: true, captureGeneration: state.generation });
      return false;
    }
  });
  }
})();
