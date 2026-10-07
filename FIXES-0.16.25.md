# 0.16.25 审查修复记录

日期：2026-10-07

本文件记录 0.16.25 针对代码审查发现问题的修复，便于后续 Agent / 人工继续二次审查。

## 已修复

1. **隐私说明与自动总结行为不一致**
   - README 与 privacy.html 现在明确说明：用户点击“总结”并选择目标 AI 后，扩展会在字幕 TXT 附件就绪后自动触发 Send / Run。
   - 移除了已经下线的“浏览器本地 ONNX / WebGPU 字幕翻译”隐私描述；当前字幕翻译为用户配置的本地或远程 OpenAI-compatible API。
   - 更新日期改为 2026-10-07。

2. **翻译全局并发闸门可能突破 4 并发**
   - 修复 semaphore 唤醒逻辑：等待者在被唤醒前先预占 slot，避免一次 release 同时放行整个等待队列。
   - 新增回归测试，12 个并发翻译请求下最大 in-flight 必须保持为 4。

3. **停止/切页/失败后翻译请求可能继续运行**
   - 前瞻翻译器新增 AbortController。
   - 用户停止、页面切换、字幕任务失败、整轨直取失败并回退实时取音时，会取消仍在进行的翻译请求。
   - translateLines 支持父级 AbortSignal，并区分“取消”和“超时”。
   - 请求定时器在请求完成后主动清理，避免成功请求仍保留长 timeout timer。

4. **通用视频网站轻微 URL 变化会误停字幕**
   - 通用页面身份比较现在忽略 URL fragment 和常见 tracking / 分享 / 播放位置参数，并对 query 排序。
   - 仍保留未知/业务 query 参数，因此真正的视频 ID/episode query 改变仍会停止旧任务，避免串音。
   - 新增回归测试覆盖 tracking/hash 变化与真实 id 变化。

5. **配置 default_popup 后 action.onClicked 死代码**
   - 删除 background.js 中不会被 Chrome 触发的 chrome.action.onClicked 处理。
   - file:// 权限检查迁移到 popup.js 的 activeTab()，未授权时直接打开扩展详情页并给出明确提示。
   - 新增静态回归检查。

6. **HLS 整轨路径存在多 GiB JS 内存风险**
   - 将 HLS 聚合网络缓冲上限从 2 GiB 降为 320 MiB，并将单分片上限设为 32 MiB。
   - 超限时明确失败并回退实时取音，避免 Offscreen Document 因超大整轨缓存被浏览器回收。
   - 这是内存安全护栏；后续如果要支持超长/超高码率 HLS 整轨，应继续做“边下载边解复用/边识别”的流式重构。

7. **验证包与仓库代码可能不同步**
   - GitHub Actions 在 push 的回归检查通过后自动打包当前工作区（包含恢复并校验后的 ONNX Runtime WASM）并上传 artifact。
   - 后续二审可直接使用该 artifact，保证检查对象与通过 CI 的提交一致。

## 本轮验证重点

- Manifest / content-script 版本同步为 0.16.25。
- 原有四组 Node 回归测试继续执行。
- 新增并发闸门、通用站点 URL 身份、popup file:// 权限路径、隐私自动提交说明四类回归检查。
- GitHub Actions 通过后再生成源码 ZIP artifact。

## 后续审查建议

后续 Agent 可继续重点检查：多 iframe 播放器、DRM/跨域媒体失败回退、长时间直播资源释放、WebGPU device lost、浏览器休眠/Service Worker 被回收后的恢复，以及超长 HLS 真正的流式解复用。
