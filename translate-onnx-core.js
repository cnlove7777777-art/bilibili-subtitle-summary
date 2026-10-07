'use strict';

import './translate.js';

export function generatedContent(output) {
  const generated = output?.[0]?.generated_text;
  const raw = typeof generated === 'string' ? generated
    : Array.isArray(generated) ? generated.at(-1)?.content : '';
  let content = String(raw || '');
  // Some chat templates put the opening <think> in the input rather than the
  // generated output. A lone closing marker still separates reasoning from text.
  const thinkingEnd = content.lastIndexOf('</think>');
  if (thinkingEnd >= 0) content = content.slice(thinkingEnd + '</think>'.length);
  if (content.includes('<think>')) return ''; // Incomplete reasoning is not a translation.
  return content.trim().replace(/^```(?:json|text)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
}

export function parseOnnxBatch(content, expectedCount) {
  if (!content) return null;
  try {
    const texts = JSON.parse(content);
    if (!Array.isArray(texts) || texts.length !== expectedCount ||
        !texts.every((text) => typeof text === 'string')) return null;
    return texts.map((text) => text.replace(/\s+/g, ' ').trim());
  } catch {
    if (/^[\[{]/.test(content)) return null;
    // Older or smaller models may still return plain lines. Only exact counts
    // are accepted; never truncate extra lines or guess sentence boundaries.
    const texts = content.replace(/\r\n?/g, '\n').split('\n');
    if (texts.length !== expectedCount) return null;
    return texts.map(cleanSingleTranslation);
  }
}

function cleanSingleTranslation(text) {
  return String(text || '').replace(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)/, '')
    .replace(/^["“”]+|["“”]+$/g, '').replace(/\s+/g, ' ').trim();
}

// Called by the actual decode loop after each generated token. This is not a
// Promise.race: stopping releases the serial Worker queue and its GPU workload.
export function createTranslationGuard({ maxTokens, budgetMs, now = () => performance.now() }) {
  const began = now();
  let promptLength = null;
  const guard = (sequences) => sequences.map(ids => {
    promptLength ??= ids.length - 1;
    const tokens = ids.slice(promptLength);
    if (now() - began >= budgetMs) guard.reason = 'deadline';
    else if (tokens.length >= maxTokens) guard.reason = 'token-limit';
    else for (let width = 1; width <= 12; width++) {
      const count = Math.max(4, Math.ceil(12 / width));
      const size = width * count;
      if (tokens.length < size) continue;
      const tail = tokens.slice(-size);
      if (tail.every((id, i) => id === tail[i % width])) { guard.reason = 'repetition'; break; }
    }
    return Boolean(guard.reason);
  });
  guard.reason = '';
  return guard;
}

async function generateTranslation(model, lines, targetLanguage, structured, sourceLanguage, options) {
  const target = globalThis.BSCG_TRANSLATE.translateLanguageLabel(targetLanguage);
  const messages = [
    { role: 'system', content: globalThis.BSCG_TRANSLATE.translateSystemPrompt(targetLanguage, sourceLanguage, lines.length, options?.qualityRetry) },
    { role: 'user', content: structured
      ? `Return a JSON array of exactly ${lines.length} translations in ${target}, in the same order. Do not merge entries.\n${JSON.stringify(lines)}`
      : lines[0] }
  ];
  // The pipeline's automatic chat rendering does not forward enable_thinking.
  // Render explicitly, then pass the string so the template is applied once.
  const prompt = model.tokenizer.apply_chat_template(messages, {
    tokenize: false, add_generation_prompt: true, enable_thinking: false
  });
  const maxTokens = Math.max(48, Math.min(1536, Array.from(lines.join('')).length * 2 + 24 + (structured ? lines.length * 8 : 0)));
  const guard = createTranslationGuard({ maxTokens, budgetMs: options?.realtime ? 2500 : 12000 });
  const output = await model(prompt, {
    max_new_tokens: maxTokens, stopping_criteria: [guard],
    do_sample: false, return_full_text: false, add_special_tokens: false
  });
  if (guard.reason) throw new Error(`ONNX 翻译生成已停止（${guard.reason}），未发布残缺译文`);
  return generatedContent(output);
}

async function translateUniqueLines(model, lines, targetLanguage, sourceLanguage, options) {
  if (!lines.length) return [];
  if (lines.length > 1) {
    const content = await generateTranslation(model, lines, targetLanguage, true, sourceLanguage, options);
    const texts = parseOnnxBatch(content, lines.length);
    if (texts) return texts;
  }
  // A formatting failure must not end the subtitle session. Retry each original
  // row separately; one generation owns exactly one row, even if it wraps lines.
  const texts = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) { texts.push(''); continue; }
    const content = await generateTranslation(model, [lines[index]], targetLanguage, false, sourceLanguage, options);
    const parsed = parseOnnxBatch(content, 1);
    if (!content) throw new Error(`ONNX 第 ${index + 1} 条字幕未输出译文（输出为空或思考未结束）`);
    // A JSON-looking but malformed response is not safe to display as a caption.
    if (!parsed && /^[\[{]/.test(content)) throw new Error(`ONNX 第 ${index + 1} 条字幕返回了不完整的结构化结果`);
    texts.push(parsed ? parsed[0] : cleanSingleTranslation(content));
  }
  return texts;
}

export async function translateOnnxLines(model, inputLines, targetLanguage, sourceLanguage = 'auto', options = {}) {
  const lines = inputLines.map(globalThis.BSCG_TRANSLATE.normalizeSubtitleText);
  sourceLanguage = globalThis.BSCG_TRANSLATE.translationSourceLanguage(lines, sourceLanguage);
  const unique = [...new Set(lines.filter(Boolean))];
  const translated = new Map([['', '']]);
  // Bound autoregressive head-of-line blocking and malformed-batch retry cost.
  // Deduplicate only within this request; never let a cache mask benchmark work
  // or reuse a translation under a different model/language/prompt context.
  for (let start = 0; start < unique.length;) {
    const batch = [];
    let characters = 0;
    while (start < unique.length && batch.length < 4) {
      const line = unique[start];
      if (batch.length && characters + line.length > 240) break;
      batch.push(line);
      characters += line.length;
      start++;
    }
    const texts = await translateUniqueLines(model, batch, targetLanguage, sourceLanguage, options);
    batch.forEach((line, index) => translated.set(line, texts[index]));
  }
  return lines.map(line => translated.get(line));
}
