// 发送侧附件判定：DeepSeek / ChatGPT / Google AI Studio 三条链路共用。
//
// 为什么需要它：旧实现把页面任意 div/span 的文字都当作"已附带"，而提示词与编辑区
// 本来就会出现字幕标题，于是文件根本没上传成功也会报"已发送"，用户看到的就是
// "文件名与内容不符"。另外，编辑器里若留着上一次总结的旧字幕附件，新文件会被追加
// 进去，模型同时看到两份内容，症状一模一样。这里把两件事都判定清楚。
(() => {
  'use strict';
  if (globalThis.BSCG_ATTACHMENT_GUARD) return;

  // 字幕文件名形如 `<标题>-字幕.txt`；只认这种带后缀的真实文件条目。
  const SUBTITLE_FILE = /-字幕[^\\/]*\.(txt|srt|vtt|md)\b/i;
  const MEDIA_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|webm|mp3|wav|m4a|ogg)\b/i;
  const CANDIDATE_SELECTORS = [
    '[title]', '[aria-label]', '[download]', 'mat-chip',
    '[data-testid*="file" i]', '[data-testid*="attach" i]',
    '[class*="file" i]', '[class*="attach" i]'
  ];

  function textOf(element) {
    return String(
      element?.getAttribute?.('title') ||
      element?.getAttribute?.('aria-label') ||
      element?.getAttribute?.('download') ||
      element?.textContent ||
      ''
    );
  }

  // 收集"真正像附件条目"的元素。编辑区（textarea/input/contenteditable）内部的节点一律
  // 排除，否则用户正在编辑的提示词会被误判成附件。
  function collectCandidates(root) {
    const scope = root || document;
    const found = [];
    const seen = new Set();
    for (const selector of CANDIDATE_SELECTORS) {
      let list = [];
      try { list = [...scope.querySelectorAll(selector)]; } catch { list = []; }
      for (const element of list) {
        if (seen.has(element)) continue;
        seen.add(element);
        if (element.closest?.('textarea, input, [contenteditable="true"]')) continue;
        found.push(element);
      }
    }
    return found;
  }

  // 判定附件状态。name 是本次要上传的文件名。
  //   ours  —— 确认本次文件已经在附件区
  //   stale —— 附件区里属于其它字幕任务的文件（上次总结遗留），会让模型看到两份内容
  function state(name, options = {}) {
    const wanted = String(name || '').toLowerCase();
    const includeMedia = Boolean(options.includeMedia);
    const ours = [];
    const stale = [];
    for (const element of collectCandidates(options.root)) {
      const text = textOf(element);
      const trimmed = text.trim();
      if (!trimmedRole(trimmed)) continue; // 过滤掉超长节点（多为整块容器/正文）
      if (wanted && text.toLowerCase().includes(wanted)) { ours.push(element); continue; }
      if (MEDIA_FILE.test(trimmed) && !includeMedia) continue;
      if (SUBTITLE_FILE.test(trimmed)) stale.push(element);
    }
    return { ours, stale };
  }

  // 附件条目本身很短（文件名 + 按钮文字）。整块容器或正文会包含换行/超长文本。
  function trimmedRole(text) {
    if (!text || text.length > 300) return false;
    return !/\n/.test(text);
  }

  async function waitForAttachment(name, options = {}) {
    const timeout = Number(options.timeout) || 15000;
    const interval = Number(options.interval) || 300;
    const start = Date.now();
    for (;;) {
      const current = state(name, options);
      if (current.ours.length) return { ok: true, stale: current.stale };
      if (Date.now() - start >= timeout) return { ok: false, stale: current.stale };
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // ---- 误报抑制：附件控件类名一变，就可能把"已经附加甚至已经发出"误判成"没确认到" ----
  // 编辑器文本：DeepSeek 用 textarea，ChatGPT 用 contenteditable。
  function editorText(editor) {
    if (!editor) return '';
    if (typeof editor.value === 'string') return editor.value;
    return String(editor.textContent || '');
  }

  // 编辑器已清空、没有待发内容：说明消息已经发出（附件显然曾就位），不该再报错。
  function composerLooksSent(editor) {
    return editorText(editor).trim().length === 0;
  }

  // 收件区里是否出现承载本次文件名的叶子元素（排除编辑器与提示词本身）。
  function fileNameInComposer(editor, name) {
    const wanted = String(name || '').toLowerCase();
    if (!wanted) return false;
    const scope = composerRoot(editor);
    if (!scope || typeof scope.querySelectorAll !== 'function') return false;
    const editorContent = editorText(editor);
    let nodes = [];
    try { nodes = [...scope.querySelectorAll('span, div, a, p, button')]; } catch { return false; }
    for (const node of nodes.slice(-600)) {
      if (node === editor || node.contains?.(editor)) continue;
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA' || tag === 'INPUT') continue;
      const text = String(node.textContent || '').trim();
      if (!text || text.length > 120) continue;
      if (!text.toLowerCase().includes(wanted)) continue;
      if (editorContent && editorContent.includes(text)) continue; // 提示词里的标题不算附件
      if (node.querySelector?.('span, div, a, p')) continue;       // 只要承载文件名的叶子节点
      return true;
    }
    return false;
  }

  // 收件区范围：编辑器所在表单，或向上三层容器，兜底为 body。
  function composerRoot(editor) {
    if (!editor) return null;
    return editor.closest?.('form')
      || editor.parentElement?.parentElement?.parentElement
      || editor.parentElement
      || null;
  }

  globalThis.BSCG_ATTACHMENT_GUARD = { state, waitForAttachment, textOf, SUBTITLE_FILE, MEDIA_FILE,
    editorText, composerLooksSent, fileNameInComposer, composerRoot };
})();
