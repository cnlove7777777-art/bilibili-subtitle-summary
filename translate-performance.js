(function (scope) {
  'use strict';
  const LIMIT_MS = 100;
  function fingerprint(config) {
    return JSON.stringify([config.mode, config.model, config.mode === 'onnx' ? '' : config.baseUrl, config.sourceLanguage, config.targetLanguage]);
  }
  function validate(config, texts, expected) {
    if (!Array.isArray(texts) || texts.length !== expected || texts.some(text => typeof text !== 'string' || !text.trim())) {
      throw new Error('翻译未返回对应的非空译文');
    }
    return texts;
  }
  function samplesForSource(language) {
    const samples = {
      ja: ['今日は天気がいいですね。', '次の駅で降りてください。', 'この方法なら時間を節約できます。', '少し待ってください。', '次の手順を説明します。', '会議は十分後に始まります。'],
      zh: ['今天天气很好。', '请在下一站下车。', '这个方法可以节省时间。', '请稍等一下。', '接下来说明操作步骤。', '会议十分钟后开始。'],
      en: ['The weather is nice today.', 'Please get off at the next station.', 'This method can save time.', 'Please wait a moment.', 'We will explain the next step.', 'The meeting starts in ten minutes.'],
      ko: ['오늘 날씨가 좋네요.', '다음 역에서 내려 주세요.', '이 방법으로 시간을 절약할 수 있습니다.', '잠시 기다려 주세요.', '다음 단계를 설명하겠습니다.', '회의는 십 분 후에 시작합니다.'],
      yue: ['今日天氣幾好。', '請喺下一站落車。', '呢個方法可以慳時間。', '請等一陣。', '跟住講下一個步驟。', '會議十分鐘後開始。']
    };
    return samples[language] || [...samples.ja.slice(0, 3), ...samples.en.slice(3)];
  }
  async function measure(config, translate, now = () => performance.now()) {
    const sameLanguage = config.sourceLanguage?.split('-')[0] === config.targetLanguage?.split('-')[0];
    const measuredSourceLanguage = sameLanguage ? (config.targetLanguage?.startsWith('ja') ? 'en' : 'ja') : config.sourceLanguage;
    const measuredConfig = { ...config, sourceLanguage: measuredSourceLanguage };
    const samples = samplesForSource(measuredSourceLanguage);
    const start = now();
    const warmup = await translate(measuredConfig, [samples[0]]);
    if (!warmup.ok) throw new Error(warmup.error || '预热失败');
    validate(config, warmup.texts, 1);
    const warmupMs = now() - start;
    const timings = [], translations = [];
    for (const source of samples) {
      const began = now();
      const result = await translate(measuredConfig, [source]);
      const elapsed = now() - began;
      if (!result.ok) throw new Error(result.error || '测速翻译失败');
      validate(config, result.texts, 1);
      timings.push(elapsed); translations.push(result.texts[0]);
    }
    const sorted = timings.slice().sort((a, b) => a - b);
    const p95Ms = sorted[Math.ceil(sorted.length * .95) - 1];
    return { fingerprint: fingerprint(config), measuredAt: Date.now(), limitMs: LIMIT_MS, warmupMs,
      measuredSourceLanguage, sameLanguageAvoided: sameLanguage,
      samples, translations, timings, medianMs: (sorted[2] + sorted[3]) / 2, p95Ms,
      meets100msTarget: p95Ms <= LIMIT_MS, scope: 'single-sentence-translation' };
  }
  scope.BSCG_TRANSLATION_PERFORMANCE = { LIMIT_MS, fingerprint, validate, measure, samplesForSource };
})(globalThis);
