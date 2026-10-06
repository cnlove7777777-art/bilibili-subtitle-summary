(async function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('bili_subtitle_upload') !== '1') return;
  const jobId = params.get('job');
  if (!jobId) return;

  const key = `job:${jobId}`;
  const payload = (await chrome.storage.local.get(key))[key];
  if (!payload?.text) return showBanner('没有找到待上传字幕；请回到视频页面重新提取。', true);
  if (payload.destination && payload.destination !== 'chatgpt') return;
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

  // ChatGPT 会在启动阶段多次重建输入区。同一个任务只允许当前文档中的一个
  // content-script 实例操作，避免重复 change 事件把同一文件上传两次。
  const documentLock = 'data-bscg-chat-job';
  if (document.documentElement.getAttribute(documentLock) === jobId) return;
  document.documentElement.setAttribute(documentLock, jobId);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function waitFor(getter, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const value = getter();
        if (value) { clearInterval(timer); resolve(value); }
        else if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error('等待 ChatGPT 输入区超时')); }
      }, 250);
    });
  }

  function showBanner(text, error = false, actions = [], autoHide = 0) {
    let box = document.getElementById('bscg-chat-banner');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bscg-chat-banner';
      Object.assign(box.style, { position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647', maxWidth: '360px', padding: '12px 38px 12px 15px', borderRadius: '11px', color: '#fff', font: '14px/1.5 system-ui', boxShadow: '0 8px 28px #0005' });
      document.documentElement.appendChild(box);
    }
    clearTimeout(box._bscgTimer);
    box.style.background = error ? '#bd3c3c' : '#16866f';
    box.replaceChildren(document.createTextNode(text));
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭提示');
    Object.assign(close.style, { position: 'absolute', top: '5px', right: '8px', padding: '2px 6px', border: '0', color: '#fff', background: 'transparent', cursor: 'pointer', font: '20px/1 system-ui' });
    close.onclick = () => box.remove();
    box.appendChild(close);
    if (!Array.isArray(actions)) actions = actions ? [actions] : [];
    for (const action of actions) {
      const button = document.createElement('button');
      button.textContent = action.label;
      Object.assign(button.style, { margin: '8px 8px 0 0', padding: '7px 10px', border: '0', borderRadius: '7px', cursor: 'pointer' });
      button.onclick = action.run;
      box.appendChild(button);
    }
    if (autoHide > 0) box._bscgTimer = setTimeout(() => box.remove(), autoHide);
  }

  function findEditor() {
    return document.querySelector('#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"][role="textbox"]');
  }

  function fillPrompt(editor, text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return;
    }
    editor.replaceChildren();
    const p = document.createElement('p');
    p.textContent = text;
    editor.appendChild(p);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  }

  function makeFile() {
    return new File([payload.text], payload.fileName, { type: 'text/plain', lastModified: Date.now() });
  }

  function putIntoInput(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, transfer.files); else input.files = transfer.files;
    // React 的 file input 使用 change。额外派发 input 可能让 ChatGPT 对同一文件
    // 建立两个上传任务，表现为附件先出现、随后提示上传失败。
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function fileInputScore(input, editor) {
    if (!input.isConnected || input.disabled) return -Infinity;
    const accept = (input.getAttribute('accept') || '').toLowerCase();
    const supportsDocuments = !accept || /text|\.txt|\.pdf|\.doc|document|application\//.test(accept);
    const mediaOnly = /^(image|audio|video)\//.test(accept) && !supportsDocuments;
    if (mediaOnly) return -Infinity;
    const form = editor.closest('form');
    let score = 0;
    if (form?.contains(input)) score += 100;
    if (/text|\.txt/.test(accept)) score += 60;
    if (/\.pdf|\.doc|document|application\//.test(accept)) score += 30;
    if (!accept) score += 10;
    if (input.multiple) score += 5;
    return score;
  }

  function findFileInput(editor) {
    return [...document.querySelectorAll('input[type="file"]')]
      .map((input, index) => ({ input, index, score: fileInputScore(input, editor) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score || b.index - a.index)[0]?.input || null;
  }

  function findAttachmentCard() {
    // ChatGPT 启动阶段会重建输入区，因此这里按"附件条目"判定，只认真正的附件节点，
    // 不再把编辑区/提示词里出现的标题当成附件。
    if (!attachmentGuard?.state) return null;
    return attachmentGuard.state(payload.fileName).ours[0] || null;
  }

  // 上一次总结遗留的字幕附件会被追加进来，导致模型同时看到两份内容（表现为"文件名与
  // 内容不符"）。判定逻辑与另外两条链路共用 attachment-guard.js。
  const attachmentGuard = globalThis.BSCG_ATTACHMENT_GUARD;
  function findStaleSubtitleCard() {
    if (!attachmentGuard) return null;
    return attachmentGuard.state(payload.fileName).stale[0] || null;
  }

  function uploadFailureText() {
    const pattern = /上传.{0,12}(失败|问题|重试)|文件.{0,12}上传.{0,12}(失败|问题)|failed to upload|upload failed|problem uploading|unable to upload|error uploading/i;
    const candidates = document.querySelectorAll('[role="alert"], [data-sonner-toast], [data-testid*="toast"], [class*="toast"]');
    for (const element of candidates) {
      const text = String(element.textContent || '').trim();
      if (text && pattern.test(text)) return text.slice(0, 180);
    }
    return '';
  }

  async function verifyUpload(timeout = 30000) {
    const start = Date.now();
    let stableSince = 0;
    while (Date.now() - start < timeout) {
      const failure = uploadFailureText();
      if (failure) return { status: 'failed', message: failure };
      if (findAttachmentCard()) {
        if (!stableSince) stableSince = Date.now();
        // 附件卡片可能在实际上传完成前就出现。连续稳定一段时间且没有错误，
        // 才能视为准备完成。
        if (Date.now() - stableSince >= 6000) return { status: 'attached' };
      } else {
        stableSince = 0;
      }
      await sleep(300);
    }
    return { status: findAttachmentCard() ? 'attached' : 'unknown' };
  }

  function downloadFallback() {
    const url = URL.createObjectURL(makeFile());
    const link = document.createElement('a');
    link.href = url;
    link.download = payload.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    void chrome.storage.local.remove(key);
  }

  // 误报抑制：附件卡片类名一变就可能把"已附加/已发出"误判成"无法确认"。
  // 判定逻辑三条链路共用 attachment-guard.js。
  function messageAlreadySent(editor) {
    return Boolean(attachmentGuard?.composerLooksSent?.(editor));
  }

  function fileNameInComposer(editor) {
    return Boolean(attachmentGuard?.fileNameInComposer?.(editor, payload.fileName));
  }

  function retryPage() {
    location.reload();
  }

  // autoSend 模式：附件就绪后直接点击发送，一次完成总结，不再等用户检查。
  function findSendButton() {
    return [...document.querySelectorAll('button')]
      .find((button) => (button.id === 'composer-submit-btn' || button.dataset?.testid === 'send-button' || /send|发送/i.test(`${button.getAttribute('aria-label') || ''}${button.dataset?.testid || ''}`)) && !button.disabled);
  }

  async function autoSendWhenReady() {
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const button = findSendButton();
      if (button) {
        button.click();
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  function clearDeliveryQuery() {
    const url = new URL(location.href);
    url.searchParams.delete('bili_subtitle_upload');
    url.searchParams.delete('job');
    history.replaceState(history.state, '', url.href);
  }

  try {
    const editor = await waitFor(findEditor);
    fillPrompt(editor, payload.prompt || '完整总结视频字幕中的观点和内容。');
    // 输入区出现不代表 ChatGPT 上传服务已经完成初始化；等页面稳定后再取
    // 当前输入区对应的 file input，避免拿到启动阶段遗留的隐藏控件。
    await sleep(1500);
    const file = makeFile();
    let input = await waitFor(() => findFileInput(editor), 15000);
    await sleep(800);
    if (!input.isConnected || input.disabled) input = await waitFor(() => findFileInput(editor), 10000);
    if (!input) {
      showBanner('没有找到 ChatGPT 文件上传控件；提示词已填好，可下载 TXT 后手动添加。', true, { label: '下载字幕 TXT', run: downloadFallback });
      return;
    }
    putIntoInput(input, file);

    const upload = await verifyUpload();
    // 用户可能在上传确认之前就手动发出去了；附件显然曾就位，不该再报错。
    const alreadySent = messageAlreadySent(editor);
    if (findStaleSubtitleCard()) {
      await chrome.storage.local.remove(key);
      showBanner('编辑器里还留着上一次总结的字幕附件。请先删除它，再回到视频页重新点“总结”；' +
        '也可点击下方按钮直接下载本次字幕 TXT。', true, [
        { label: '下载本次字幕 TXT', run: downloadFallback },
        { label: '刷新页面重试', run: retryPage }
      ]);
    } else if (upload.status === 'attached') {
      await chrome.storage.local.remove(key);
      clearDeliveryQuery();
      if (payload.autoSend) {
        const sent = await autoSendWhenReady();
        showBanner(sent ? '已自动发送：字幕 TXT 与提示词已提交，可在本页查看总结。' : '自动发送没有完成：发送按钮未就绪。内容已填好，可手动点击发送。', !sent, [], sent ? 7000 : 0);
      } else {
        showBanner('字幕 TXT 已上传，提示词也已填好；检查后再发送。', false, [], 7000);
      }
    } else if (upload.status === 'failed') {
      showBanner('ChatGPT 报告附件上传失败。本页不会自动重复上传，以免卡住；可刷新后重试。', true, [
        { label: '刷新页面重试', run: retryPage },
        { label: '下载字幕 TXT', run: downloadFallback }
      ]);
    } else if (alreadySent || fileNameInComposer(editor)) {
      // 已经发出、或收件区里确实带着本次附件：不再打扰。
      await chrome.storage.local.remove(key);
      clearDeliveryQuery();
      if (!alreadySent) showBanner('字幕 TXT 已上传，提示词也已填好；检查后再发送。', false, [], 7000);
    } else {
      showBanner('暂时无法确认附件状态，已停止重复操作。若页面没有附件，可刷新后重试。', true, [
        { label: '刷新页面重试', run: retryPage },
        { label: '下载字幕 TXT', run: downloadFallback }
      ]);
    }
  } catch (error) {
    showBanner(error.message || String(error), true, [
      { label: '刷新页面重试', run: retryPage },
      { label: '下载字幕 TXT', run: downloadFallback }
    ]);
  }
})();
