'use strict';

const DB_NAME = 'bscg-browser-media';
const STORE_NAME = 'files';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'token' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地媒体缓存'));
  });
}

async function storeFile(token, file) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({
        token,
        file,
        name: String(file.name || '本地视频'),
        type: String(file.type || ''),
        size: Number(file.size) || 0,
        createdAt: Date.now()
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('本地文件写入失败'));
    });
    const records = await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('无法清理媒体缓存'));
    });
    const now = Date.now();
    const retained = records
      .filter((record) => record.token === token || now - Number(record.createdAt || 0) <= 30 * 60 * 1000)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 2);
    const keep = new Set(retained.map((record) => record.token));
    const stale = records.filter((record) => !keep.has(record.token)).map((record) => record.token);
    if (stale.length) {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        for (const staleToken of stale) transaction.objectStore(STORE_NAME).delete(staleToken);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('无法清理媒体缓存'));
      });
    }
  } finally {
    database.close();
  }
}

addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== parent || data?.marker !== 'BSCG_LOCAL_FILE_STORE_V1') return;
  const token = String(data.token || '');
  const file = data.file;
  if (!token || !(file instanceof Blob) || !file.size || file.size > 512 * 1024 * 1024) {
    parent.postMessage({ marker: 'BSCG_LOCAL_FILE_STORE_RESULT_V1', token, ok: false, error: '本地文件无效或超过 512 MiB' }, '*');
    return;
  }
  chrome.storage.session.get(`localFileAuth:${token}`).then((stored) => {
    const authorization = stored[`localFileAuth:${token}`];
    return chrome.storage.session.remove(`localFileAuth:${token}`).then(() => authorization);
  }).then((authorization) => {
    if (!authorization || Number(authorization.expiresAt) < Date.now() || Number(authorization.size) !== file.size) {
      throw new Error('本地文件桥授权无效或已经过期');
    }
    return storeFile(token, file);
  }).then(() => {
    parent.postMessage({ marker: 'BSCG_LOCAL_FILE_STORE_RESULT_V1', token, ok: true, size: file.size }, '*');
  }).catch((error) => {
    parent.postMessage({ marker: 'BSCG_LOCAL_FILE_STORE_RESULT_V1', token, ok: false, error: error?.message || String(error) }, '*');
  });
});

parent.postMessage({ marker: 'BSCG_LOCAL_FILE_BRIDGE_READY_V1' }, '*');
