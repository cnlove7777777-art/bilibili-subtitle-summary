// 字幕翻译客户端：OpenAI 兼容 /chat/completions 与 /models。
// 本地（UNSLOTH Studio、llama.cpp 直连）与远程（任意 OpenAI 兼容端点）共用同一
// 协议，只有 baseUrl / apiKey / model 不同。后台服务 Worker 经 importScripts 引入，
// 设置页只通过 chrome.runtime 消息调用，不在页面上下文直接 fetch。
(function attach(globalScope) {
  'use strict';

  const TRANSLATE_DEFAULTS = {
    translateEnabled: false,
    translateMode: 'local',
    translateLocalBaseUrl: 'http://127.0.0.1:8888/v1',
    translateLocalApiKey: '',
    translateLocalModel: '',
    translateRemoteBaseUrl: 'https://api.openai.com/v1',
    translateRemoteApiKey: '',
    translateRemoteModel: '',
    translateTargetLanguage: 'zh',
    // translated：只显示译文（默认，直接显示翻译内容，不做原地替换）
    // bilingual：译文为主 + 原文字号更小，两部分同屏
    translateDisplayMode: 'translated'
  };

  // code 写入存储；label 供设置页展示。
  const TRANSLATE_DISPLAY_MODES = [
    { code: 'translated', label: '仅译文（默认）' },
    { code: 'bilingual', label: '双语（原文小字）' }
  ];

  // code 写入提示词；label 供设置页展示。
  const TRANSLATE_LANGUAGES = [
    { code: 'zh', label: '中文（简体）' },
    { code: 'zh-Hant', label: '中文（繁体）' },
    { code: 'en', label: '英语' },
    { code: 'ja', label: '日语' },
    { code: 'ko', label: '韩语' },
    { code: 'fr', label: '法语' },
    { code: 'de', label: '德语' },
    { code: 'es', label: '西班牙语' },
    { code: 'ru', label: '俄语' },
    { code: 'pt', label: '葡萄牙语' }
  ];

  // 本地 GGUF（UNSLOTH Studio / llama.cpp）首次请求要把权重读进显存，实测冷启动
  // 可达 45 秒以上，模型列表本身也会等推理服务就绪；超时按冷启动上限放宽，
  // 宁可等一次也不要在首帧就把整轨前瞻翻译判死。
  const TRANSLATE_MODEL_LIST_TIMEOUT_MS = 45 * 1000;
  const TRANSLATE_REQUEST_TIMEOUT_MS = 240 * 1000;
  const TRANSLATE_MAX_TOTAL_CONCURRENCY = 4;
  const TRANSLATE_MAX_MODEL_ENTRIES = 200;

  function translateLanguageLabel(code) {
    const found = TRANSLATE_LANGUAGES.find((entry) => entry.code === code);
    return found ? found.label : String(code || '');
  }

  // 把「当前生效的那一侧」配置抽出来：本地/远程字段不同，但下游只认同一结构。
  function translateActiveConfig(settings) {
    const merged = { ...TRANSLATE_DEFAULTS, ...(settings || {}) };
    const remote = String(merged.translateMode || '').trim() === 'remote';
    const rawCode = String(merged.translateTargetLanguage || '').trim();
    const rawDisplay = String(merged.translateDisplayMode || '').trim();
    return {
      enabled: Boolean(merged.translateEnabled),
      mode: remote ? 'remote' : 'local',
      baseUrl: remote
        ? String(merged.translateRemoteBaseUrl || '').trim().replace(/\/+$/, '')
        : String(merged.translateLocalBaseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: remote
        ? String(merged.translateRemoteApiKey || '').trim()
        : String(merged.translateLocalApiKey || '').trim(),
      model: remote
        ? String(merged.translateRemoteModel || '').trim()
        : String(merged.translateLocalModel || '').trim(),
      targetLanguage: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(rawCode) ? rawCode : 'zh',
      displayMode: TRANSLATE_DISPLAY_MODES.some((entry) => entry.code === rawDisplay) ? rawDisplay : 'translated'
    };
  }

  function translateModelsUrl(config) {
    return `${config.baseUrl}/models`;
  }

  function translateCompletionsUrl(config) {
    return `${config.baseUrl}/chat/completions`;
  }

  function translateIsReady(config) {
    return Boolean(
      config &&
      config.enabled &&
      config.model &&
      /^https?:\/\//i.test(String(config.baseUrl || ''))
    );
  }

  function translateUnavailableReason(config) {
    if (!config || !config.enabled) return '翻译未启用';
    if (!/^https?:\/\//i.test(String(config.baseUrl || ''))) return 'Base URL 无效（需 http/https）';
    if (!config.model) return '未选择模型';
    return '';
  }

  function translateAuthHeaders(config) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    return headers;
  }

  const abortSignalCleanups = new WeakMap();

  function abortSignalFor(timeoutMs, parentSignal = null) {
    const controller = new AbortController();
    let parentAbort = null;
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 0));
    const cleanup = () => {
      clearTimeout(timer);
      if (parentSignal && parentAbort) parentSignal.removeEventListener('abort', parentAbort);
      abortSignalCleanups.delete(controller.signal);
    };
    if (parentSignal) {
      parentAbort = () => controller.abort(parentSignal.reason);
      if (parentSignal.aborted) controller.abort(parentSignal.reason);
      else parentSignal.addEventListener('abort', parentAbort, { once: true });
    }
    controller.signal.addEventListener('abort', cleanup, { once: true });
    abortSignalCleanups.set(controller.signal, cleanup);
    return controller.signal;
  }

  function cleanupAbortSignal(signal) {
    abortSignalCleanups.get(signal)?.();
  }

  async function readResponseError(response) {
    try {
      const text = await response.text();
      try {
        const payload = JSON.parse(text);
        const message = payload?.error?.message || payload?.error || payload?.message || payload?.detail;
        if (message) return `HTTP ${response.status}：${String(message).slice(0, 240)}`;
      } catch { /* 非 JSON 错误体 */ }
      return text ? `HTTP ${response.status}：${String(text).slice(0, 240)}` : `HTTP ${response.status}`;
    } catch (error) {
      return `HTTP ${response.status}（${error?.message || '读取错误详情失败'}）`;
    }
  }

  function toHttpError(response) {
    return readResponseError(response).then((detail) => new Error(detail));
  }

  // 模型清单：同时兼容 OpenAI（data[].id）与 llama.cpp 新版（models[].name + data[].id）。
  async function listTranslateModels(config) {
    if (!/^https?:\/\//i.test(String(config?.baseUrl || ''))) throw new Error('Base URL 无效（需 http/https）');
    const signal = abortSignalFor(TRANSLATE_MODEL_LIST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(translateModelsUrl(config), { method: 'GET', headers: translateAuthHeaders(config), signal });
    } catch (error) {
      cleanupAbortSignal(signal);
      throw new Error(`无法连接翻译服务：${error?.message || String(error)}`);
    }
    let payload;
    try {
      if (!response.ok) {
        const detail = await readResponseError(response);
        throw new Error(
          /^HTTP 40[13]/.test(detail) ? `${detail}（请确认 API Key 与 Base URL）` : `获取模型列表失败：${detail}`
        );
      }
      payload = await response.json().catch((error) => {
        throw new Error(`模型列表不是合法 JSON：${error?.message || String(error)}`);
      });
    } finally {
      cleanupAbortSignal(signal);
    }
    const entries = [];
    const seen = new Set();
    const push = (id, extra = {}) => {
      const value = String(id || '').trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      entries.push({ id: value, ownedBy: String(extra.ownedBy || ''), quant: String(extra.quant || ''), loaded: Boolean(extra.loaded) });
    };
    for (const entry of Array.isArray(payload?.data) ? payload.data : []) {
      push(entry?.id || entry?.name, { ownedBy: entry?.owned_by || entry?.ownedBy, quant: entry?.quant, loaded: entry?.loaded });
    }
    for (const entry of Array.isArray(payload?.models) ? payload.models : []) {
      push(entry?.name || entry?.model || entry?.id, { ownedBy: entry?.owned_by, quant: entry?.quant, loaded: entry?.loaded });
    }
    if (!entries.length) throw new Error('模型列表为空：请确认服务已加载可对话模型');
    return entries.slice(0, TRANSLATE_MAX_MODEL_ENTRIES);
  }

  // 逐行翻译：一次请求送一批字幕，模型必须按行数原样返回。
  function translateSystemPrompt(targetLanguage) {
    const label = translateLanguageLabel(targetLanguage);
    return `你是专业的影视字幕翻译。规则：\n1. 用户消息的每一行是一条独立字幕；逐行翻译成${label}，行序、行数严格一一对应。\n2. 只输出译文本身，不要编号、引号、解释、前后缀或字幕外的任何内容。\n3. 不要合并、拆分、总结或增删行。\n4. 专有名词、品牌、技术术语按目标语通行译名；确实无通行译名时保留原文。\n5. 识别噪声、语气词、笑声等无法翻译的行，输出空行。`;
  }

  function translateUserContent(lines) {
    return lines.map((line) => String(line).replace(/\r?\n/g, ' ').trim()).join('\n');
  }

  function estimateMaxTokens(lines) {
    const totalCharacters = lines.reduce((sum, line) => sum + Array.from(String(line || '')).length, 0);
    return Math.max(160, Math.min(4000, Math.ceil(totalCharacters * 0.9) + 80));
  }

  function cleanTranslatedLine(value) {
    return String(value || '')
      .replace(/^\s*(?:[-*•·]\s*|\d+\s*[.\)、\-]\s*)/, '')
      .replace(/^[`"'“”‘’]+|[`"'“”‘’]+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 解析模型返回：按行拆分；只有一行输入时允许整段当一条。
  function parseTranslatedLines(rawContent, expectedCount) {
    const content = String(rawContent || '').replace(/\r\n?/g, '\n');
    if (!content.trim()) return null;
    if (expectedCount <= 1) {
      return [cleanTranslatedLine(content.replace(/\n+/g, ' '))];
    }
    const lines = content.split('\n').map((line) => cleanTranslatedLine(line));
    if (lines.length < expectedCount) return null;
    return lines.slice(0, expectedCount);
  }

  // 全局并发闸门：多个页签同时开翻译时，别把本地单实例服务打爆。
  const translateSlotWaiters = [];
  let translateInFlight = 0;

  async function acquireTranslateSlot() {
    if (translateInFlight < TRANSLATE_MAX_TOTAL_CONCURRENCY) {
      translateInFlight += 1;
      return releaseTranslateSlot;
    }
    // Reserve the released slot before waking the waiter; otherwise one release
    // can wake the whole queue before any resumed Promise increments the count.
    await new Promise((resolve) => translateSlotWaiters.push(resolve));
    return releaseTranslateSlot;
  }

  function releaseTranslateSlot() {
    translateInFlight = Math.max(0, translateInFlight - 1);
    drainTranslateSlots();
  }

  function drainTranslateSlots() {
    while (translateSlotWaiters.length && translateInFlight < TRANSLATE_MAX_TOTAL_CONCURRENCY) {
      const resolve = translateSlotWaiters.shift();
      translateInFlight += 1;
      resolve();
    }
  }

  // texts -> { ok, texts } 或 { ok:false, error }；调用方失败时应回退展示原文。
  async function translateLines(config, texts, parentSignal = null) {
    const lines = (Array.isArray(texts) ? texts : []).map((line) => String(line || ''));
    if (!lines.length) return { ok: true, texts: [] };
    const release = await acquireTranslateSlot();
    const signal = abortSignalFor(TRANSLATE_REQUEST_TIMEOUT_MS, parentSignal);
    try {
      const response = await fetch(translateCompletionsUrl(config), {
        method: 'POST',
        headers: translateAuthHeaders(config),
        signal,
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: translateSystemPrompt(config.targetLanguage) },
            { role: 'user', content: translateUserContent(lines) }
          ],
          temperature: 0.2,
          max_tokens: estimateMaxTokens(lines),
          stream: false
        })
      });
      if (!response.ok) throw await toHttpError(response);
      const payload = await response.json().catch((error) => {
        throw new Error(`翻译响应不是合法 JSON：${error?.message || String(error)}`);
      });
      const parsed = parseTranslatedLines(payload?.choices?.[0]?.message?.content, lines.length);
      if (!parsed) {
        throw new Error(
          `翻译结果行数不匹配（期望 ${lines.length} 行）：${String(payload?.choices?.[0]?.message?.content || '').slice(0, 120)}`
        );
      }
      return { ok: true, texts: parsed.map((line) => line || '') };
    } catch (error) {
      const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError' || signal.aborted;
      const cancelled = Boolean(parentSignal?.aborted);
      return {
        ok: false,
        error: cancelled ? '翻译请求已取消' :
          aborted ? `翻译请求超时（${Math.round(TRANSLATE_REQUEST_TIMEOUT_MS / 1000)} 秒）` :
          (error?.message || String(error))
      };
    } finally {
      cleanupAbortSignal(signal);
      release();
    }
  }

  const api = {
    TRANSLATE_DEFAULTS,
    TRANSLATE_LANGUAGES,
    TRANSLATE_REQUEST_TIMEOUT_MS,
    translateActiveConfig,
    translateLanguageLabel,
    translateModelsUrl,
    translateCompletionsUrl,
    translateIsReady,
    translateUnavailableReason,
    listTranslateModels,
    translateSystemPrompt,
    translateUserContent,
    estimateMaxTokens,
    parseTranslatedLines,
    translateLines
  };

  globalScope.BSCG_TRANSLATE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
