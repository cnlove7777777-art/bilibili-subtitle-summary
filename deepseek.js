(async function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('bili_subtitle_upload') !== '1') return;
  const jobId = params.get('job');
  if (!jobId) return;

  const key = `job:${jobId}`;
  const payload = (await chrome.storage.local.get(key))[key];
  if (!payload?.text || payload.destination !== 'deepseek') return showBanner('没有找到待上传的 DeepSeek 字幕任务；请回到视频页面重新提取。', true);
  const validSource = validateSource(payload);
  const fileNameMatchesBody = validateFileName(payload);
  if (payload.jobId !== jobId || !validSource || !fileNameMatchesBody || Date.now() - payload.createdAt > 60 * 60 * 1000) {
    await chrome.storage.local.remove(key);
    return showBanner('字幕任务身份不一致或已过期；为避免串视频，已拒绝上传。', true);
  }

  function validateSource(item) {
    try {
      const source = new URL(item.sourceUrl);
      if (item.sourcePlatform === 'bilibili') return source.pathname.includes(`/video/${item.sourceVideoId}`) && Boolean(item.sourcePartId);
      if (item.sourcePlatform === 'youtube') {
        const id = source.searchParams.get('v') || source.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
        return /(^|\.)youtube\.com$/i.test(source.hostname) && id === item.sourceVideoId && item.sourcePartId === item.sourceVideoId;
      }
      if (item.sourcePlatform === 'web') return /^(https?|file):$/.test(source.protocol) && /^[a-f0-9]{24}$/.test(item.sourceVideoId) && item.sourcePartId === item.sourceVideoId;
      return false;
    } catch { return false; }
  }

  // 附件名与文件正文第一行 `视频：<标题>` 必须指向同一个视频；否则宁可不上传，
  // 也不能把"名字是 A、内容是 B"的字幕文件交给外部模型。
  function validateFileName(item) {
    const header = /^视频：([^\n]*)/.exec(String(item?.text || ''))?.[1] || '';
    if (!header || Array.from(header).length < 4) return true;
    const named = String(item?.fileName || '').replace(/-字幕\.txt$/i, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
    return named === header;
  }

  function waitFor(getter, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const value = getter();
        if (value) { clearInterval(timer); resolve(value); }
        else if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error('等待 DeepSeek 输入区超时')); }
      }, 250);
    });
  }
  let boxHideTimer = 0;
  function showBanner(text, error = false, actions, dismissMs = 0) {
    let box = document.getElementById('bscg-deepseek-banner');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bscg-deepseek-banner';
      Object.assign(box.style, { position: 'fixed', right: '18px', bottom: '84px', zIndex: '2147483647', maxWidth: '370px', padding: '12px 15px', borderRadius: '11px', color: '#fff', font: '14px/1.5 system-ui', boxShadow: '0 8px 28px #0005', transition: 'opacity .35s ease' });
      document.documentElement.appendChild(box);
    }
    if (boxHideTimer) { clearTimeout(boxHideTimer); boxHideTimer = 0; }
    box.style.opacity = '1';
    box.style.background = error ? '#a93636' : '#147b68';
    box.replaceChildren(document.createTextNode(text));
    if (!Array.isArray(actions)) actions = actions ? [actions] : [];
    for (const action of actions) {
      const button = document.createElement('button');
      button.textContent = action.label;
      Object.assign(button.style, { display: 'block', marginTop: '8px', padding: '7px 10px', border: '0', borderRadius: '7px', cursor: 'pointer' });
      button.onclick = action.run;
      box.appendChild(button);
    }
    // 成功类提示看一眼就够：自动淡出。带操作按钮的提示保留，避免用户来不及点。
    const wait = Number(dismissMs) || (!error && !actions.length ? 6000 : 0);
    if (wait > 0) {
      boxHideTimer = setTimeout(() => {
        box.style.opacity = '0';
        boxHideTimer = setTimeout(() => { box.style.display = 'none'; }, 400);
      }, wait);
    } else {
      box.style.display = 'block';
    }
  }
  // 误报抑制：附件控件类名一变，就可能把"已附加/已发出"误判成"没确认到"。
  // 判定逻辑三条链路共用 attachment-guard.js。
  function messageAlreadySent(editor) {
    return Boolean(attachmentGuard?.composerLooksSent?.(editor));
  }

  function fileNameInComposer(editor) {
    return Boolean(attachmentGuard?.fileNameInComposer?.(editor, payload.fileName));
  }

  async function resolveAttachment(editor) {
    const attached = await verifyAttached();
    if (attached.ok) return attached;
    if (messageAlreadySent(editor)) return { ok: true, sent: true, stale: attached.stale };
    if (fileNameInComposer(editor)) return { ok: true, recovered: true, stale: attached.stale };
    return attached;
  }
  // 刷新后 URL 仍带 job 参数、任务在 60 分钟内仍有效，可整体重跑一次上传流程。
  function retryPage() {
    location.reload();
  }
  function makeFile() {
    return new File([payload.text], payload.fileName, { type: 'text/plain', lastModified: Date.now() });
  }
  function fillPrompt(editor, text) {
    editor.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
  function putIntoInput(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, transfer.files); else input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  // 附件判定交给 attachment-guard.js（三条链路共用）：只认真正的附件条目，
  // 并识别上一次总结遗留的字幕附件。
  const attachmentGuard = globalThis.BSCG_ATTACHMENT_GUARD;
  function verifyAttached(timeout = 15000) {
    if (!attachmentGuard) return Promise.resolve({ ok: false, stale: [] });
    return attachmentGuard.waitForAttachment(payload.fileName, { timeout });
  }
  function downloadFallback() {
    const url = URL.createObjectURL(makeFile());
    const link = document.createElement('a');
    link.href = url;
    link.download = payload.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    chrome.storage.local.remove(key);
  }

  try {
    const editor = await waitFor(() => [...document.querySelectorAll('textarea')]
      .find((item) => /DeepSeek|发送消息/i.test(item.getAttribute('placeholder') || '')) || document.querySelector('textarea'));
    // 先填提示词：即使后面文件控件等待/上传失败，用户至少保留已填好的提示词。
    fillPrompt(editor, payload.prompt || '完整总结视频字幕中的观点和内容。');
    // DeepSeek 的文件控件可能不带 .txt accept 或出现较晚：先按类型匹配，
    // 再退回任意可用的非纯媒体 file input，避免整个上传流程直接卡死。
    const input = await waitFor(() => [...document.querySelectorAll('input[type="file"]')]
      .find((item) => !item.disabled && /\.txt|text\//i.test(item.getAttribute('accept') || ''))
      || [...document.querySelectorAll('input[type="file"]')]
        .find((item) => !item.disabled && !/^(image|audio|video)\//.test((item.getAttribute('accept') || '').toLowerCase())));
    putIntoInput(input, makeFile());
    const attached = await resolveAttachment(editor);
    if (attached.stale.length) {
      // 编辑器里还有别的字幕附件：继续发送会让模型同时看到两份互不相干的字幕，
      // 表现就是"文件名与实际内容不符"。宁可停下来让用户先清空。
      await chrome.storage.local.remove(key);
      return showBanner('编辑器里还留着上一次总结的字幕附件。请先删除它，再回到视频页重新点“总结”；' +
        '或点击下方按钮直接下载本次字幕 TXT。', true, [
        { label: '下载本次字幕 TXT', run: downloadFallback },
        { label: '刷新页面重试', run: retryPage }
      ]);
    }
    if (attached.ok) {
      await chrome.storage.local.remove(key);
      if (attached.sent) return; // 用户已经手动发出，不需要再提示
      if (payload.autoSend) {
        // autoSend 模式：附件就绪后直接点击发送按钮。
        const start = Date.now();
        let sent = false;
        while (Date.now() - start < 20000 && !sent) {
          const sendButton = [...document.querySelectorAll('button')]
            .find((item) => (/发送|send/i.test(`${item.getAttribute('aria-label') || ''}${item.textContent || ''}`)) && !item.disabled);
          if (sendButton) {
            sendButton.click();
            sent = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        showBanner(sent ? '已自动发送：字幕 TXT 与提示词已提交给 DeepSeek。' : '自动发送没有完成：发送按钮未就绪。内容已填好，可手动点击发送。', !sent);
      } else {
        showBanner('字幕 TXT 和提示词已经放入 DeepSeek；检查后再发送。');
      }
    } else {
      // 只有"收件区里确实没有本次附件、且消息也还没发出去"时才提示。
      showBanner('没有确认到附件卡片，已停止自动操作（不会上传或发送不完整的字幕）。' +
        '可点击下方按钮直接下载本次字幕 TXT 核对内容。', true, [
        { label: '下载字幕 TXT', run: downloadFallback },
        { label: '刷新页面重试', run: retryPage }
      ]);
    }
  } catch (error) {
    showBanner(error.message || String(error), true, [
      { label: '刷新页面重试', run: retryPage },
      { label: '下载字幕 TXT', run: downloadFallback }
    ]);
  }
})();
