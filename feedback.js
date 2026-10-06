'use strict';
const $ = id => document.getElementById(id);
let diagnostics = {};
let endpoint = '';
let sending = false;
let sent = false;
let requestId = crypto.randomUUID();
let previousPayload = '';
function payload() {
  return { id: requestId, message: $('message').value.trim(), diagnostics: $('includeDiagnostics').checked ? diagnostics : {} };
}
function refresh() {
  const next = JSON.stringify({ message: $('message').value.trim(), diagnostics: $('includeDiagnostics').checked ? diagnostics : {} });
  if (next !== previousPayload) { requestId = crypto.randomUUID(); sent = false; previousPayload = next; }
  $('preview').textContent = JSON.stringify(payload(), null, 2);
  $('message').disabled = sending;
  $('includeDiagnostics').disabled = sending;
  $('send').disabled = !endpoint || sending || sent || !$('message').value.trim();
}
for (const id of ['message', 'includeDiagnostics']) $(id).addEventListener('input', refresh);
$('form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!endpoint || sending || sent || !$('message').value.trim()) return;
  sending = true; refresh();
  $('status').textContent = '正在发送…';
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()),
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(response.status === 429 ? '发送较频繁，请稍后再试。' : '发送未成功，可以复制反馈或保存报告。');
    sent = true; $('status').textContent = '反馈已发送，谢谢。';
  } catch (error) { $('status').textContent = error.name === 'TimeoutError' ? '暂未收到回执，稍后可以重试。' : '发送未成功，可以复制反馈或保存报告。'; }
  finally { sending = false; refresh(); }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(payload(), null, 2)); $('status').textContent = '已复制。'; }
  catch { $('status').textContent = '无法复制，请使用“保存报告”。'; }
});
$('save').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'subtitle-feedback.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('status').textContent = '报告已保存。';
});
(async () => {
  try {
    const [draft, config] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'BSCG_FEEDBACK_CONTEXT', draftId: new URL(location.href).searchParams.get('draft') || '' }),
      fetch(chrome.runtime.getURL('feedback-config.json')).then(response => response.json())
    ]);
    diagnostics = draft?.ok ? draft.diagnostics || {} : {};
    endpoint = BscgFeedback.endpoint(config.endpoint);
    $('status').textContent = endpoint ? '检查内容后发送。' : '当前版本暂未开通在线发送，可复制反馈、保存报告或到商店留言。';
  } catch { $('status').textContent = '暂时无法连接反馈服务，可复制反馈或保存报告。'; }
  refresh();
})();
