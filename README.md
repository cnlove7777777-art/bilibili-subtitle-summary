> **最新版本：v0.16.51（Chrome Web Store 审核候选版）** · [下载完整可安装扩展 ZIP](https://github.com/cnlove7777777-art/bilibili-subtitle-summary/releases/tag/v0.16.51) · [自动化验证](https://github.com/cnlove7777777-art/bilibili-subtitle-summary/actions/workflows/verify.yml)
>
> 本次更新包含 YouTube CC、高速识别、HLS/DASH 长视频随机访问、站点字幕记忆与隐私说明。完整 WASM 运行库包含于 Release ZIP，仓库的 `release-parts/v0.16.51/` 用于由 CI 无损重组并验证该 ZIP；请勿将源码目录直接当作可安装扩展。

<div align="center">
  <img src="icons/icon128.png" width="96" alt="Browser Live Captions icon">
  <h1>全网视频实时字幕与总结</h1>
  <p><b>Browser Live Captions & Summary</b></p>
  <p>浏览器内完成音轨发现、语音识别、实时字幕、可选翻译，并把字幕准备到 AI 网页用于总结。</p>
</div>

## 0.16.44 是哪条代码线？

**0.16.44 直接以 Chrome Web Store 提审用的 0.16.43 为基线。** 它保留 0.16.43 已有的逐视频“翻译 / 不翻译 / 跟随全局设置”悬浮菜单、浏览器本地 ONNX 翻译、OpenAI-compatible 本地/远程翻译、实时字幕翻译以及“仅译文”显示策略。

仓库中的回归测试会检查这些能力是否仍然存在，避免以后因为拿错旧目录或旧分支而出现“版本号变大、功能反而回退”的情况。

## 主要能力

- **网页视频实时字幕**：Bilibili、YouTube 以及可发现媒体流/标签页音频的通用视频网站。
- **浏览器本地 ASR**：Qwen3-ASR 0.6B / SenseVoice Small，可走 WebGPU / WASM / ONNX 路径。
- **翻译三种后端**：浏览器本地 ONNX；用户配置的本地 OpenAI-compatible 服务；用户配置的远程 OpenAI-compatible API。
- **逐视频翻译开关**：鼠标悬停字幕按钮可选择“跟随全局设置 / 翻译 / 不翻译”。
- **仅译文 / 双语**：仅译文模式不会把未验证的识别原文当译文发到字幕层；双语模式保留小字原文。
- **实时捕获与整轨前瞻**：能直接取得音轨时做前瞻识别；无法直取时可捕获当前标签页声音。
- **视频总结**：把字幕 TXT 与提示词准备到 ChatGPT、Google AI Studio（Gemini）或 DeepSeek。**最终 Send / Run 由用户手动确认，扩展不会自动提交。**
- **本地媒体**：支持 `file://` 视频/音频；首次使用需在 Chrome 扩展详情页开启“允许访问文件网址”。

## 翻译行为

全局设置可选择翻译后端、目标语言与显示模式。视频页面上的字幕按钮还有一个当前视频覆盖设置：

- **跟随全局设置**：使用设置页的翻译开关。
- **翻译**：只对当前视频强制启用翻译。
- **不翻译**：只对当前视频强制关闭翻译。

`仅译文` 模式会等待通过质量检查的译文；翻译失败时不会把未验证的日文/其他原文伪装成译文显示。`双语` 模式则允许译文和原文同时显示。

## 从源码安装

为了让 Git 仓库保持轻量，约几十 MB 的浏览器 ML 运行库不提交到 Git。**0.16.44 的完整发布 ZIP 已包含并校验这些运行库，推荐直接使用发布 ZIP做浏览器验收。**

Git 仓库用于源码审查与开发。固定 npm 包可以恢复大部分浏览器 ML 运行库；但 0.16.43/0.16.44 实际使用的 `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` 构建产物已经不在当前固定 npm 包的同名发布路径中，因此源码仓库不会假装它能 100% 从 npm 重建完整 CWS 包。若目录中已经包含发布 ZIP 的运行库，`node scripts/restore-runtime.mjs` 会先按 SHA-256 验证并复用它们。

```bash
git clone https://github.com/cnlove7777777-art/bilibili-subtitle-summary.git
cd bilibili-subtitle-summary
node tests/review-regressions.mjs
```

然后打开 `chrome://extensions`：

1. 开启“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 选择仓库目录。

运行库版本仍固定为：

- `@huggingface/transformers@3.8.1`
- `onnxruntime-web@1.22.0-dev.20250409-89f8206ba4`

发布 ZIP 已包含 0.16.43 实际工作的完整 runtime，并按记录的 SHA-256 验证；GitHub Actions 负责源码回归，不再用一个已经缺少历史 asyncify 产物的 npm 发布结构冒充完整 CWS 打包验证。

## 验证

```bash
node tests/review-regressions.mjs
```

0.16.44 的审查回归会检查：版本一致性、所有扩展 JS 语法、翻译悬浮菜单、本地 ONNX 翻译文件、“仅译文”防原文泄漏、手动最终发送、SPA URL 身份、`file://` 权限路径、HTTP 翻译取消/timeout 清理，以及全局翻译并发上限。

真实 WebGPU 性能、模型准确率、各视频网站的临时播放器策略与 DRM 仍属于浏览器/硬件验收范围。

## 隐私

详细说明见 [`privacy.html`](privacy.html) / [`PRIVACY.md`](PRIVACY.md)。本地 ASR 和本地 ONNX 翻译在浏览器中执行；只有用户主动配置远程翻译 API 时，待翻译字幕才会发送到该 API。视频总结会在用户主动选择目标 AI 后准备附件和提示词，但最终提交必须由用户手动确认。

## 开源许可

项目自身代码使用 [MIT License](LICENSE)。第三方运行库的许可与来源见 [`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt) 和 `vendor/` 下的许可证文件。
