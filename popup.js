'use strict';
const $ = id => document.getElementById(id);
const live = $('live');
const destination = $('destination');
const captureMode = $('captureMode');
let currentTab = null;
let running = false;
let captionsShown = false;
let stopping = false;
let lastError = '';

function show(title, text, kind = '') {
  $('stateTitle').textContent = title;
  $('status').textContent = text;
  $('state').className = `state ${kind}`;
  if (kind === 'error') lastError = text;
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^(https?|file):/i.test(tab.url || '')) throw new Error('请在播放视频或音频的网页中使用');
  if (/^file:/i.test(tab.url || '')) {
    const allowed = await new Promise((resolve) => chrome.extension.isAllowedFileSchemeAccess(resolve));
    if (!allowed) {
      await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      throw new Error('请先在扩展详情页开启“允许访问文件网址”，然后重新打开本地媒体。');
    }
  }
  return tab;
}
function setState(isRunning, isShown = isRunning) {
  running = Boolean(isRunning);
  captionsShown = Boolean(isShown);
  live.textContent = running || captionsShown ? '关闭字幕' : '开始字幕';
  live.classList.toggle('running', running || captionsShown);
  captureMode.disabled = running;
}
async function run(button, action) {
  button.disabled = true;
  try { await action(); } catch (error) { show('操作失败', error?.message || String(error), 'error'); }
  finally { button.disabled = button === live && stopping; }
}
async function waitUntilStopped() {
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const response = await chrome.runtime.sendMessage({ type: 'BSCG_LIVE_UI_READY', tabId: currentTab.id });
      if (!response?.ok) throw new Error(response?.error || '无法读取状态');
      if (!response.running && !response.stopping) {
        setState(false, false);
        show('字幕已关闭', '已生成的文字仍可导出。');
        return;
      }
    }
    show('正在收尾', '稍后重新打开面板查看。');
  } catch (error) { show('无法确认状态', error?.message || String(error), 'error'); }
  finally { stopping = false; live.disabled = false; }
}
chrome.storage.local.get({ defaultDestination: 'chatgpt' }).then(values => { destination.value = values.defaultDestination; });
destination.addEventListener('change', () => chrome.storage.local.set({ defaultDestination: destination.value }));
live.addEventListener('click', () => run(live, async () => {
  currentTab ||= await activeTab();
  if (running || captionsShown) {
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_LIVE_STOP', tabId: currentTab.id });
    if (!response?.ok) throw new Error(response?.error || '关闭失败');
    setState(false, false);
    if (response.stopping) { stopping = true; show('正在收尾', '字幕已关闭。'); void waitUntilStopped(); }
    else show('字幕已关闭', '已生成的文字仍可导出。');
  } else {
    show('正在准备', '首次使用需要下载模型。');
    // The toolbar click authorizes tabCapture. This explicit mode also works
    // without a DOM media element (Web Audio, canvas and custom live players).
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_LIVE_START', tabId: currentTab.id, captureMode: captureMode.value });
    if (!response?.ok) throw new Error(response?.error || '启动失败');
    setState(!response.reused, true);
    show(response.reused ? '字幕已显示' : '字幕已开启', '再次点击可以关闭。', 'running');
  }
}));
$('extract').addEventListener('click', () => run($('extract'), async () => {
  currentTab ||= await activeTab();
  const response = await chrome.runtime.sendMessage({ type: 'BSCG_EXTRACT_CURRENT', tabId: currentTab.id, destination: destination.value });
  if (!response?.ok) throw new Error(response?.error || '字幕提取失败');
  show(response.needsLiveCapture || response.needsLocalConfirm ? '没有现成字幕' : '字幕已提取',
    response.needsLiveCapture || response.needsLocalConfirm ? '点击“开始字幕”生成。' : '已打开所选网页，请检查后手动发送。');
}));
$('export').addEventListener('click', () => run($('export'), async () => {
  currentTab ||= await activeTab();
  const response = await chrome.runtime.sendMessage({ type: 'BSCG_EXPORT_CURRENT', tabId: currentTab.id });
  if (!response?.ok) throw new Error(response?.error || '当前没有可导出的字幕');
  show('导出完成', `${response.rows} 段字幕`);
}));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('feedback').addEventListener('click', () => run($('feedback'), async () => {
  const response = await chrome.runtime.sendMessage({ type: 'BSCG_OPEN_FEEDBACK', tabId: currentTab?.id, error: lastError });
  if (!response?.ok) throw new Error(response?.error || '无法打开反馈页');
}));
(async () => {
  try {
    currentTab = await activeTab();
    const response = await chrome.runtime.sendMessage({ type: 'BSCG_LIVE_UI_READY', tabId: currentTab.id });
    if (!response?.ok) throw new Error(response?.error || '无法读取字幕状态');
    if (response.stopping) { stopping = true; setState(true); live.disabled = true; void waitUntilStopped(); return; }
    if (response.overlayOnTop) captureMode.value = 'tab';
    setState(response.running, response.captionVisibility !== false && (response.running || response.rows > 0));
    show(running ? '字幕正在运行' : '准备好了', '直播或播客未识别时，可选“当前标签页声音”。', running ? 'running' : '');
  } catch (error) { show('当前页面不可用', error?.message || String(error), 'error'); }
})();
