'use strict';

(() => {
  const PROBE_BYTES = 512 * 1024;
  const PROBE_TIMEOUT_MS = 30000;
  const PROBE_SETTLE_MS = 750;
  const DEFAULT_PARALLELISM = 4;
  const MAX_PARALLELISM = 6;
  const GLOBAL_PARALLELISM = 4;
  const DOWNLOAD_STALL_TIMEOUT_MS = 90 * 1000;

  const SOURCES = Object.freeze({
    qwenGpu: Object.freeze({
      repo: 'goryodog/tokihisu-qwen3-asr-0.6b-webgpu',
      revision: '62493632e19acdf7b4a5733a2d4a032cf1abce90'
    }),
    senseGpu: Object.freeze({
      repo: 'ruska1117/SenseVoiceSmall-onnx-fp16',
      revision: '03a199168d32793c49683ef4966b156714314858'
    }),
    senseCpu: Object.freeze({
      repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
      revision: '2365baeacb507f821a0c8120fcee3d484dba7a07',
      modelScopeRepo: 'pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue',
      modelScopeRevision: 'master'
    })
  });

  const MIRRORS = Object.freeze([
    Object.freeze({ id: 'huggingface', label: 'Hugging Face', origin: 'https://huggingface.co' }),
    Object.freeze({ id: 'hf-mirror', label: 'HF Mirror', origin: 'https://hf-mirror.com' })
  ]);

  function sourceBase(source, mirror = MIRRORS[0]) {
    return `${mirror.origin}/${source.repo}/resolve/${source.revision}`;
  }

  function asset(sourceId, cacheName, remote, size, routes) {
    const source = SOURCES[sourceId];
    return Object.freeze({
      id: `${sourceId}:${remote}`,
      sourceId,
      cacheName,
      remote,
      size,
      routes: Object.freeze(routes.slice()),
      canonicalUrl: `${sourceBase(source)}/${remote}`
    });
  }

  const ASSETS = Object.freeze([
    asset('qwenGpu', 'bscg-qwen3-asr-0.6b-webgpu-fp16-6249363-v1', 'onnx/audio_encoder_fp16.onnx', 316850, ['qwen-webgpu']),
    asset('qwenGpu', 'bscg-qwen3-asr-0.6b-webgpu-fp16-6249363-v1', 'onnx/audio_encoder_fp16.onnx_data', 372749504, ['qwen-webgpu']),
    asset('qwenGpu', 'bscg-qwen3-asr-0.6b-webgpu-fp16-6249363-v1', 'onnx/decoder_with_past_fp16.onnx', 1325505, ['qwen-webgpu']),
    asset('qwenGpu', 'bscg-qwen3-asr-0.6b-webgpu-fp16-6249363-v1', 'onnx/decoder_with_past_fp16.onnx_data', 1503250432, ['qwen-webgpu']),
    asset('qwenGpu', 'bscg-qwen3-asr-0.6b-webgpu-fp16-6249363-v1', 'processor/tokenizer.json', 11429653, ['qwen-webgpu']),
    asset('senseGpu', 'browser-sensevoice-v2', 'model.onnx', 910161, ['sense-webgpu']),
    asset('senseGpu', 'browser-sensevoice-v2', 'model.onnx.data', 467998334, ['sense-webgpu']),
    asset('senseGpu', 'browser-sensevoice-v2', 'tokens.json', 352064, ['sense-webgpu', 'sense-wasm']),
    asset('senseGpu', 'browser-sensevoice-v2', 'am.mvn', 11203, ['sense-webgpu', 'sense-wasm']),
    asset('senseCpu', 'browser-sensevoice-v2', 'model.int8.onnx', 239233841, ['sense-wasm'])
  ]);

  const TOTAL_BYTES = ASSETS.reduce((sum, file) => sum + file.size, 0);
  const ROUTE_IDS = Object.freeze(['qwen-webgpu', 'sense-webgpu', 'sense-wasm']);
  const ROUTE_LABELS = Object.freeze({
    'qwen-webgpu': 'Qwen3-ASR 0.6B · GPU FP16',
    'sense-webgpu': 'SenseVoice Small · GPU FP16',
    'sense-wasm': 'SenseVoice Small · CPU INT8'
  });
  let activeRun = null;
  let activeSlots = 0;
  const slotWaiters = [];
  const activeTransfers = new Map();

  function errorText(error) {
    return error?.message || String(error);
  }

  function aborted(signal) {
    return signal?.aborted || false;
  }

  function abortError() {
    return new DOMException('模型下载已取消', 'AbortError');
  }

  function mirrorCandidates(sourceId) {
    const source = SOURCES[sourceId];
    const candidates = MIRRORS.map((mirror) => ({
      id: mirror.id,
      label: mirror.label,
      kind: 'huggingface',
      baseUrl: sourceBase(source, mirror)
    }));
    if (source.modelScopeRepo) {
      const revision = source.modelScopeRevision || 'master';
      candidates.push({
        id: 'modelscope',
        label: 'ModelScope 魔搭',
        kind: 'modelscope',
        baseUrl: `https://modelscope.cn/api/v1/models/${source.modelScopeRepo}/repo?Revision=${encodeURIComponent(revision)}&FilePath=`
      });
    }
    return candidates;
  }

  function candidateFileUrl(candidate, file) {
    if (candidate.kind === 'modelscope') return `${candidate.baseUrl}${encodeURIComponent(file.remote)}`;
    return `${candidate.baseUrl}/${file.remote}`;
  }

  function publicFile(file) {
    return {
      id: file.id,
      remote: file.remote,
      size: file.size,
      routes: file.routes,
      status: file.status || 'pending',
      loaded: Number(file.loaded) || 0,
      mirror: file.mirror || '',
      error: file.error || ''
    };
  }

  function routeId(profile, backend) {
    if (profile !== 'sensevoice_browser') return 'qwen-webgpu';
    return `sense-${backend === 'wasm' ? 'wasm' : 'webgpu'}`;
  }

  function readyRoutes(run = activeRun) {
    if (!run) return ROUTE_IDS.slice();
    return ROUTE_IDS.filter((id) => !run.routes[id] || run.routes[id].status === 'complete');
  }

  function routeFiles(route) {
    return ASSETS.filter((file) => file.routes.includes(route));
  }

  function routeSnapshot(run, id) {
    const definitions = routeFiles(id);
    if (!run) {
      return {
        id,
        label: ROUTE_LABELS[id],
        status: 'idle',
        phase: 'idle',
        statusText: '未开始',
        progress: 0,
        loaded: 0,
        total: definitions.reduce((sum, file) => sum + file.size, 0),
        cachedBytes: 0,
        downloadedBytes: 0,
        speedBytesPerSecond: 0,
        completedFiles: 0,
        totalFiles: definitions.length,
        source: '',
        currentFile: '',
        error: '',
        files: definitions.map(publicFile)
      };
    }
    const current = run.files.find((file) => ['downloading', 'retrying', 'waiting'].includes(file.status));
    const selectedSources = Object.values(run.sources)
      .map((source) => source.selected?.label || '')
      .filter((label, index, labels) => label && labels.indexOf(label) === index);
    return {
      id,
      label: ROUTE_LABELS[id],
      status: run.status,
      phase: run.phase,
      statusText: run.statusText,
      progress: run.total > 0 ? Math.min(100, run.loaded / run.total * 100) : 0,
      loaded: run.loaded,
      total: run.total,
      cachedBytes: run.cachedBytes,
      downloadedBytes: run.downloadedBytes,
      speedBytesPerSecond: run.status === 'running' && performance.now() - run.speedSampleAt < 1500
        ? run.speedBytesPerSecond : 0,
      completedFiles: run.completedFiles,
      totalFiles: run.files.length,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || 0,
      source: current?.mirror || selectedSources.join(' / '),
      currentFile: current?.remote.split('/').pop() || '',
      error: run.error || '',
      sources: Object.values(run.sources).map((source) => ({
        id: source.id,
        status: source.status,
        error: source.error || '',
        selected: source.selected ? { ...source.selected } : null,
        probes: (source.probes || []).map((probe) => ({ ...probe }))
      })),
      files: run.files.map(publicFile)
    };
  }

  function aggregateFiles(run) {
    return ASSETS.map((definition) => {
      const copies = ROUTE_IDS.map((id) => run.routes[id]?.files?.find((file) => file.id === definition.id)).filter(Boolean);
      const finished = copies.find((file) => file.status === 'complete') || copies.find((file) => file.status === 'cached');
      if (finished) return { ...publicFile(finished), loaded: definition.size };
      const active = copies.reduce((best, file) => Number(file.loaded) > Number(best?.loaded || 0) ? file : best, null);
      const failed = copies.find((file) => file.status === 'error');
      return publicFile(active || failed || definition);
    });
  }

  function snapshot(run = activeRun) {
    if (!run) return null;
    const routes = ROUTE_IDS.map((id) => routeSnapshot(run.routes[id], id));
    const files = aggregateFiles(run);
    const running = routes.filter((route) => route.status === 'running');
    const completed = routes.filter((route) => route.status === 'complete');
    const errors = routes.filter((route) => route.status === 'error');
    const cancelled = routes.filter((route) => route.status === 'cancelled');
    let status = 'idle';
    if (running.length) status = 'running';
    else if (completed.length === ROUTE_IDS.length) status = 'complete';
    else if (completed.length) status = 'partial';
    else if (errors.length) status = 'error';
    else if (cancelled.length) status = 'cancelled';
    const statusText = status === 'running' ? `正在下载 ${running.length} 个模型`
      : status === 'complete' ? '三个模型均已缓存'
        : status === 'partial' ? `${completed.length}/${ROUTE_IDS.length} 个模型已缓存`
          : status === 'error' ? '模型下载失败'
            : status === 'cancelled' ? '下载已停止' : '尚未开始';
    const loaded = files.reduce((sum, file) => sum + Math.min(file.size, Number(file.loaded) || 0), 0);
    const cachedBytes = files.filter((file) => file.status === 'cached').reduce((sum, file) => sum + file.size, 0);
    const downloadedBytes = files.filter((file) => file.status === 'complete').reduce((sum, file) => sum + file.size, 0);
    return {
      id: run.id,
      status,
      phase: status,
      statusText,
      progress: TOTAL_BYTES > 0 ? Math.min(100, loaded / TOTAL_BYTES * 100) : 0,
      loaded,
      total: TOTAL_BYTES,
      cachedBytes,
      downloadedBytes,
      speedBytesPerSecond: running.reduce((sum, route) => sum + route.speedBytesPerSecond, 0),
      parallelism: GLOBAL_PARALLELISM,
      completedFiles: files.filter((file) => ['cached', 'complete'].includes(file.status)).length,
      totalFiles: ASSETS.length,
      startedAt: run.startedAt,
      finishedAt: running.length ? 0 : Math.max(0, ...routes.map((route) => Number(route.finishedAt) || 0)),
      error: errors.map((route) => `${route.label}：${route.error}`).join('\n'),
      readyRoutes: readyRoutes(run),
      completedRoutes: completed.map((route) => route.id),
      routes,
      files
    };
  }

  function updateLoaded(run) {
    const activeBytes = run.files.reduce((sum, file) =>
      ['downloading', 'retrying'].includes(file.status) ? sum + (Number(file.loaded) || 0) : sum, 0);
    run.loaded = Math.min(run.total, run.cachedBytes + run.downloadedBytes + activeBytes);
    const transferredBytes = run.downloadedBytes + activeBytes;
    const now = performance.now();
    if (now - run.speedSampleAt >= 350) {
      const elapsedSeconds = Math.max(0.001, (now - run.speedSampleAt) / 1000);
      run.speedBytesPerSecond = Math.max(0, (transferredBytes - run.speedSampleBytes) / elapsedSeconds);
      run.speedSampleAt = now;
      run.speedSampleBytes = transferredBytes;
    }
  }

  async function inspectCachedAsset(file) {
    const cache = await caches.open(file.cacheName);
    const response = await cache.match(file.canonicalUrl);
    if (!response) return false;
    if (Number(response.headers.get('x-bscg-model-size')) === file.size) return true;
    // Older inference Workers cached raw responses, sometimes without a usable
    // Content-Length. Validate their body once instead of discarding good data.
    const body = await response.blob();
    const size = body.size;
    if (size !== file.size) {
      await cache.delete(file.canonicalUrl);
      return false;
    }
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.set('content-length', String(size));
    headers.set('x-bscg-model-size', String(size));
    await cache.put(file.canonicalUrl, new Response(body, { headers })).catch(() => {});
    return true;
  }

  function bindAbort(parentSignal, controller) {
    if (!parentSignal) return () => {};
    const onAbort = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
    return () => parentSignal.removeEventListener('abort', onAbort);
  }

  function releaseDownloadSlot() {
    activeSlots = Math.max(0, activeSlots - 1);
    while (activeSlots < GLOBAL_PARALLELISM && slotWaiters.length) {
      const waiter = slotWaiters.shift();
      if (aborted(waiter.signal)) {
        waiter.reject(abortError());
        continue;
      }
      activeSlots += 1;
      waiter.unbind();
      waiter.resolve(releaseDownloadSlot);
    }
  }

  function acquireDownloadSlot(signal) {
    if (aborted(signal)) return Promise.reject(abortError());
    if (activeSlots < GLOBAL_PARALLELISM) {
      activeSlots += 1;
      return Promise.resolve(releaseDownloadSlot);
    }
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, unbind: () => {} };
      const onAbort = () => {
        const index = slotWaiters.indexOf(waiter);
        if (index >= 0) slotWaiters.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiter.unbind = () => signal.removeEventListener('abort', onAbort);
      slotWaiters.push(waiter);
    });
  }

  function waitForTransfer(promise, signal) {
    if (aborted(signal)) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => finish(reject, abortError());
      const finish = (callback, value) => {
        signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(() => finish(resolve), () => finish(resolve));
    });
  }

  async function probeCandidate(file, candidate, parentSignal) {
    const controller = new AbortController();
    const unbind = bindAbort(parentSignal, controller);
    const timeout = setTimeout(() => controller.abort('probe-timeout'), PROBE_TIMEOUT_MS);
    const startedAt = performance.now();
    let received = 0;
    let reader = null;
    try {
      const url = candidateFileUrl(candidate, file);
      let response;
      try {
        response = await fetch(url, {
          cache: 'no-store',
          redirect: 'follow',
          headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (rangeError) {
        if (controller.signal.aborted) throw rangeError;
        response = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) {
        const data = await response.arrayBuffer();
        received = Math.min(data.byteLength, PROBE_BYTES);
      } else {
        reader = response.body.getReader();
        while (received < PROBE_BYTES) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
        }
      }
      if (received < Math.min(PROBE_BYTES, file.size, 32768)) throw new Error('测速样本不足');
      const elapsedMs = Math.max(1, performance.now() - startedAt);
      return {
        id: candidate.id,
        label: candidate.label,
        kind: candidate.kind,
        baseUrl: candidate.baseUrl,
        ok: true,
        bytes: received,
        elapsedMs,
        speedBytesPerSecond: received / (elapsedMs / 1000)
      };
    } catch (error) {
      if (aborted(parentSignal)) throw abortError();
      return {
        id: candidate.id,
        label: candidate.label,
        kind: candidate.kind,
        baseUrl: candidate.baseUrl,
        ok: false,
        bytes: received,
        elapsedMs: Math.max(1, performance.now() - startedAt),
        speedBytesPerSecond: 0,
        error: errorText(error)
      };
    } finally {
      clearTimeout(timeout);
      unbind();
      if (reader) void reader.cancel().catch(() => {});
      controller.abort('probe-complete');
    }
  }

  async function selectSource(run, sourceId, files) {
    const sourceState = run.sources[sourceId];
    sourceState.status = 'probing';
    sourceState.error = '';
    const probeSized = files.filter((file) => file.size >= PROBE_BYTES);
    const candidates = probeSized.length ? probeSized : files;
    const representative = candidates.reduce((smallest, file) => file.size < smallest.size ? file : smallest, candidates[0]);
    const candidatesToProbe = mirrorCandidates(sourceId);
    const pending = new Set();
    const unbinders = [];
    let settleTimer = null;
    let probes;
    try {
      probes = await Promise.all(candidatesToProbe.map(async (candidate) => {
        const controller = new AbortController();
        pending.add(controller);
        unbinders.push(bindAbort(run.controller.signal, controller));
        let result;
        try { result = await probeCandidate(representative, candidate, controller.signal); }
        catch (error) { result = { ...candidate, ok: false, speedBytesPerSecond: 0, error: errorText(error) }; }
        finally { pending.delete(controller); }
        // A reachable mirror must not wait 30 seconds for an unreachable host.
        if (result.ok && !settleTimer) settleTimer = setTimeout(() => {
          for (const other of pending) other.abort('usable-source-found');
        }, PROBE_SETTLE_MS);
        return result;
      }));
    } finally {
      clearTimeout(settleTimer);
      for (const unbind of unbinders) unbind();
    }
    if (aborted(run.controller.signal)) throw abortError();
    sourceState.probes = probes;
    const available = probes.filter((probe) => probe.ok)
      .sort((left, right) => right.speedBytesPerSecond - left.speedBytesPerSecond);
    if (!available.length) {
      const error = `${representative.remote} 的下载地址均不可用：${probes.map((probe) => `${probe.label} ${probe.error || '失败'}`).join('；')}`;
      sourceState.status = 'error';
      sourceState.error = error;
      throw new Error(error);
    }
    sourceState.selected = available[0];
    sourceState.order = [
      ...available,
      ...probes.filter((probe) => !probe.ok)
    ];
    sourceState.status = 'ready';
  }

  async function cacheNetworkResponse(run, file, candidate) {
    const controller = new AbortController();
    const unbind = bindAbort(run.controller.signal, controller);
    const url = candidateFileUrl(candidate, file);
    const cache = await caches.open(file.cacheName);
    let received = 0;
    let stallTimer = null;
    const touchStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort('download-stalled'), DOWNLOAD_STALL_TIMEOUT_MS);
    };
    try {
      touchStallTimer();
      const response = await fetch(url, {
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('服务器未返回可流式读取的响应体');
      touchStallTimer();
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      headers.set('content-length', String(file.size));
      headers.set('x-bscg-model-size', String(file.size));
      headers.set('x-bscg-model-source', candidate.id);
      const counter = new TransformStream({
        transform(chunk, streamController) {
          touchStallTimer();
          received += chunk.byteLength;
          if (received > file.size) {
            streamController.error(new Error(`文件大于预期 ${file.size} 字节`));
            controller.abort('size-overflow');
            return;
          }
          file.loaded = received;
          updateLoaded(run);
          streamController.enqueue(chunk);
        },
        flush() {
          // Reject incomplete bodies before Cache.put can publish an entry
          // carrying the verified-size header to another consumer.
          if (received !== file.size) throw new Error(`大小不符，预期 ${file.size}，实际 ${received}`);
        }
      });
      const cachedResponse = new Response(response.body.pipeThrough(counter, { signal: controller.signal }), {
        status: 200,
        statusText: 'OK',
        headers
      });
      await cache.put(file.canonicalUrl, cachedResponse);
      if (received !== file.size) {
        await cache.delete(file.canonicalUrl);
        throw new Error(`大小不符，预期 ${file.size}，实际 ${received}`);
      }
      return received;
    } catch (error) {
      await cache.delete(file.canonicalUrl).catch(() => false);
      if (aborted(run.controller.signal)) throw abortError();
      if (controller.signal.reason === 'download-stalled') {
        throw new Error(`${candidate.label}：连续 ${DOWNLOAD_STALL_TIMEOUT_MS / 1000} 秒没有收到数据`);
      }
      throw new Error(`${candidate.label}：${errorText(error)}`);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      unbind();
    }
  }

  async function downloadAsset(run, file) {
    const source = run.sources[file.sourceId];
    const attempts = source.order || [];
    let lastError = null;
    for (let index = 0; index < attempts.length; index += 1) {
      if (aborted(run.controller.signal)) throw abortError();
      const candidate = attempts[index];
      file.status = index ? 'retrying' : 'downloading';
      file.loaded = 0;
      file.mirror = candidate.label;
      file.error = '';
      run.statusText = index ? '更换下载源重试' : '下载中';
      updateLoaded(run);
      try {
        const bytes = await cacheNetworkResponse(run, file, candidate);
        file.status = 'complete';
        file.loaded = bytes;
        run.downloadedBytes += bytes;
        run.completedFiles += 1;
        updateLoaded(run);
        return;
      } catch (error) {
        lastError = error;
        file.error = errorText(error);
        file.loaded = 0;
        updateLoaded(run);
      }
    }
    file.status = 'error';
    throw new Error(`${file.remote} 下载失败：${errorText(lastError)}`);
  }

  function markCached(run, file) {
    if (['cached', 'complete'].includes(file.status)) return;
    file.status = 'cached';
    file.loaded = file.size;
    file.error = '';
    run.cachedBytes += file.size;
    run.completedFiles += 1;
    updateLoaded(run);
  }

  async function downloadAssetWithLock(run, file) {
    while (!aborted(run.controller.signal)) {
      if (await inspectCachedAsset(file)) {
        markCached(run, file);
        return;
      }
      const inFlight = activeTransfers.get(file.id);
      if (inFlight) {
        file.status = 'waiting';
        file.loaded = 0;
        run.statusText = '等待共享文件';
        updateLoaded(run);
        await waitForTransfer(inFlight.promise, run.controller.signal);
        continue;
      }

      const releaseSlot = await acquireDownloadSlot(run.controller.signal);
      try {
        const laterTransfer = activeTransfers.get(file.id);
        if (laterTransfer) {
          await waitForTransfer(laterTransfer.promise, run.controller.signal);
          continue;
        }
        if (await inspectCachedAsset(file)) {
          markCached(run, file);
          return;
        }
        const promise = downloadAsset(run, file);
        activeTransfers.set(file.id, { promise, routeId: run.routeId });
        try {
          await promise;
          return;
        } finally {
          if (activeTransfers.get(file.id)?.promise === promise) activeTransfers.delete(file.id);
        }
      } finally {
        releaseSlot();
      }
    }
    throw abortError();
  }

  async function runDownloadPool(run, files) {
    let nextIndex = 0;
    const failures = [];
    async function worker() {
      while (!aborted(run.controller.signal) && nextIndex < files.length) {
        const file = files[nextIndex];
        nextIndex += 1;
        try {
          await downloadAssetWithLock(run, file);
        } catch (error) {
          if (aborted(run.controller.signal)) return;
          file.status = 'error';
          file.error = errorText(error);
          failures.push({ file, error });
        }
      }
    }
    const workers = Array.from({ length: Math.min(run.parallelism, files.length) }, () => worker());
    await Promise.allSettled(workers);
    if (aborted(run.controller.signal)) throw abortError();
    return failures;
  }

  async function executeRoute(run) {
    try {
      await navigator.storage.persist?.().catch(() => false);
      run.phase = 'checking';
      run.statusText = '正在检查已缓存文件…';
      await Promise.all(run.files.map(async (file) => {
        if (await inspectCachedAsset(file)) {
          file.status = 'cached';
          file.loaded = file.size;
          run.cachedBytes += file.size;
          run.completedFiles += 1;
        }
      }));
      updateLoaded(run);
      if (aborted(run.controller.signal)) throw abortError();
      const missing = run.files.filter((file) => file.status !== 'cached');
      if (!missing.length) {
        run.status = 'complete';
        run.phase = 'complete';
        run.statusText = '已缓存';
        run.speedBytesPerSecond = 0;
        run.finishedAt = Date.now();
        return;
      }

      const estimate = await navigator.storage.estimate().catch(() => ({}));
      const available = Math.max(0, (Number(estimate.quota) || 0) - (Number(estimate.usage) || 0));
      const required = missing.reduce((sum, file) => sum + file.size, 0);
      if (available && available < required * 1.02) {
        throw new Error(`存储空间不足：仍需约 ${(required / 1024 ** 3).toFixed(2)} GB，可用约 ${(available / 1024 ** 3).toFixed(2)} GB`);
      }

      run.phase = 'probing';
      run.statusText = '正在并行测速下载地址…';
      const bySource = new Map();
      for (const file of missing) {
        const sourceFiles = bySource.get(file.sourceId) || [];
        sourceFiles.push(file);
        bySource.set(file.sourceId, sourceFiles);
      }
      const sourceEntries = [...bySource];
      const selectionResults = await Promise.allSettled(sourceEntries.map(([sourceId, files]) =>
        selectSource(run, sourceId, files)));
      if (aborted(run.controller.signal)) throw abortError();
      selectionResults.forEach((result, index) => {
        if (result.status === 'fulfilled') return;
        const [sourceId, files] = sourceEntries[index];
        const source = run.sources[sourceId];
        source.status = 'error';
        source.error = source.error || errorText(result.reason);
        for (const file of files) {
          file.status = 'error';
          file.error = source.error;
        }
      });

      const downloadable = missing.filter((file) => run.sources[file.sourceId].status === 'ready');

      if (downloadable.length) {
        run.phase = 'downloading';
        run.downloadStartedAt = Date.now();
        run.statusText = '等待下载文件…';
        await runDownloadPool(run, downloadable);
      }
      const failedFiles = missing.filter((file) => file.status === 'error');
      if (failedFiles.length) {
        run.status = 'error';
        run.phase = 'error';
        run.statusText = `${failedFiles.length} 个文件未完成`;
        const sourceErrors = Object.values(run.sources)
          .filter((source) => source.error)
          .map((source) => source.error);
        const fileErrors = failedFiles
          .filter((file) => !run.sources[file.sourceId].error)
          .slice(0, 3)
          .map((file) => `${file.remote}：${file.error}`);
        run.error = [...sourceErrors, ...fileErrors].join('\n');
        run.speedBytesPerSecond = 0;
        run.finishedAt = Date.now();
        return;
      }
      run.status = 'complete';
      run.phase = 'complete';
      run.loaded = run.total;
      run.statusText = '下载完成';
      run.speedBytesPerSecond = 0;
      run.finishedAt = Date.now();
    } catch (error) {
      if (aborted(run.controller.signal) && run.cancelRequested) {
        for (const file of run.files) {
          if (['downloading', 'retrying', 'waiting', 'pending'].includes(file.status)) {
            file.status = 'cancelled';
            file.loaded = 0;
          }
        }
        updateLoaded(run);
        run.status = 'cancelled';
        run.phase = 'cancelled';
        run.statusText = '已停止；完整文件保留';
        run.speedBytesPerSecond = 0;
        run.finishedAt = Date.now();
        return;
      }
      run.status = 'error';
      run.phase = 'error';
      run.statusText = '下载失败';
      run.error = errorText(error);
      run.speedBytesPerSecond = 0;
      run.finishedAt = Date.now();
    }
  }

  function ensureRun() {
    if (!activeRun) {
      activeRun = {
        id: `model-download-${crypto.randomUUID()}`,
        startedAt: Date.now(),
        routes: {}
      };
    }
    return activeRun;
  }

  function createRouteRun(targetRoute, options = {}) {
    const parallelism = Math.max(1, Math.min(MAX_PARALLELISM, Number(options.parallelism) || DEFAULT_PARALLELISM));
    const files = routeFiles(targetRoute).map((file) => ({ ...file, status: 'pending', loaded: 0, mirror: '', error: '' }));
    const sourceIds = [...new Set(files.map((file) => file.sourceId))];
    const run = {
      routeId: targetRoute,
      status: 'running',
      phase: 'checking',
      statusText: '检查缓存',
      total: files.reduce((sum, file) => sum + file.size, 0),
      loaded: 0,
      cachedBytes: 0,
      downloadedBytes: 0,
      completedFiles: 0,
      parallelism,
      startedAt: Date.now(),
      downloadStartedAt: 0,
      finishedAt: 0,
      error: '',
      speedBytesPerSecond: 0,
      speedSampleAt: performance.now(),
      speedSampleBytes: 0,
      cancelRequested: false,
      manual: !options.automatic,
      consumers: new Set(),
      controller: new AbortController(),
      files,
      sources: Object.fromEntries(sourceIds.map((id) => [id, {
        id,
        status: 'pending',
        selected: null,
        probes: [],
        order: [],
        error: ''
      }]))
    };
    run.promise = executeRoute(run);
    return run;
  }

  function startRoute(targetRoute, options = {}) {
    if (!ROUTE_IDS.includes(targetRoute)) throw new Error('未知模型下载链路');
    const manager = ensureRun();
    const existing = manager.routes[targetRoute];
    if (!existing || existing.status !== 'running') {
      manager.routes[targetRoute] = createRouteRun(targetRoute, options);
    } else if (!options.automatic) existing.manual = true;
    return snapshot(manager);
  }

  function startAll(options = {}) {
    const manager = ensureRun();
    for (const targetRoute of ROUTE_IDS) {
      const existing = manager.routes[targetRoute];
      if (!existing || existing.status !== 'running') {
        manager.routes[targetRoute] = createRouteRun(targetRoute, options);
      } else existing.manual = true;
    }
    return snapshot(manager);
  }

  async function cancelRouteRun(run) {
    if (!run || run.status !== 'running') return;
    run.cancelRequested = true;
    run.phase = 'cancelling';
    run.statusText = '正在停止…';
    run.controller.abort('user-cancelled');
    await run.promise;
  }

  async function ensureRoute(targetRoute, options = {}) {
    const { signal, onProgress } = options;
    if (aborted(signal)) throw abortError();
    const previous = activeRun?.routes[targetRoute];
    if (previous?.cancelRequested && previous.status === 'running') await previous.promise;
    if (aborted(signal)) throw abortError();
    startRoute(targetRoute, { parallelism: options.parallelism || 4, automatic: true });
    const run = activeRun.routes[targetRoute];
    const consumer = {};
    run.consumers.add(consumer);
    const publish = () => onProgress?.(routeSnapshot(run, targetRoute));
    let timer = null;
    let unbind = () => {};
    try {
      publish();
      timer = setInterval(publish, 500);
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        unbind = () => signal?.removeEventListener('abort', onAbort);
        if (aborted(signal)) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        run.promise.then(resolve, reject);
      });
      if (aborted(signal) || run.status === 'cancelled') {
        const error = abortError();
        Object.defineProperty(error, 'code', { value: 'MODEL_DOWNLOAD_CANCELLED' });
        throw error;
      }
      publish();
      if (run.status !== 'complete') {
        const error = new Error(`${ROUTE_LABELS[targetRoute]} 模型下载失败：${run.error || run.statusText}。再次点击会保留完整缓存并重试。`);
        error.code = 'MODEL_DOWNLOAD_FAILED';
        throw error;
      }
      return routeSnapshot(run, targetRoute);
    } finally {
      clearInterval(timer);
      unbind();
      run.consumers.delete(consumer);
      if (!run.manual && !run.consumers.size && run.status === 'running') void cancelRouteRun(run);
    }
  }

  async function cancel(id = '', targetRoute = '') {
    const manager = activeRun;
    if (!manager || (id && manager.id !== id)) return snapshot(manager);
    if (targetRoute) {
      if (!ROUTE_IDS.includes(targetRoute)) throw new Error('未知模型下载链路');
      await cancelRouteRun(manager.routes[targetRoute]);
    } else {
      await Promise.all(ROUTE_IDS.map((route) => cancelRouteRun(manager.routes[route])));
    }
    return snapshot(manager);
  }

  function reset() {
    if (ROUTE_IDS.some((route) => activeRun?.routes[route]?.status === 'running')) throw new Error('模型下载仍在运行');
    activeRun = null;
  }

  self.BscgModelDownload = Object.freeze({
    startAll,
    startRoute,
    ensureRoute,
    cancel,
    reset,
    snapshot,
    isRunning: () => ROUTE_IDS.some((route) => activeRun?.routes[route]?.status === 'running'),
    isRouteReady: (profile, backend) => {
      const route = activeRun?.routes[routeId(profile, backend)];
      return !route || route.status === 'complete';
    },
    totalBytes: TOTAL_BYTES,
    assets: ASSETS,
    sources: SOURCES,
    mirrors: MIRRORS
  });
})();
