# 0.16.44：通用视频网站提前音轨链路调研

## 结论

对于**非 DRM** 的普通网页视频，提前音轨链路更适合按媒体传输方式判断，而不是维护一张“支持站点名单”：

- HLS（`.m3u8`，含扩展名为空但 Content-Type 为 mpegurl）——高可行。
- DASH（`.mpd`）——可行；当前通用解析器对完整文件 / SegmentBase 最成熟，SegmentTemplate / SegmentList 仍是主要缺口。
- 渐进式 MP4/M4A/WebM——高可行，尤其支持 Range 时。
- MSE / `blob:`——`blob:` 本身不可下载，但真实 HLS/DASH/媒体请求仍会走网络；能和当前播放 frame 关联时仍可提前读取。
- EME/DRM——不绕过，回退实时浏览器取音或提示不支持。

## 0.16.43 为什么会漏掉一批站点

43 已经观察页面 fetch/XHR、PerformanceResourceTiming 和扩展 webRequest，但 `getGenericMediaSource()` 之前要求页面侧先得到一个可读 `mediaUrl`。对于只暴露 `blob:` / MediaSource 的播放器，页面侧没留下真实 URL 时会提前返回 null，于是后台其实已经嗅到的扩展名为空 HLS/DASH/audio 也进不了候选。

## 0.16.44 的放宽

1. 页面没有可读 `mediaUrl` 时，只要能确认当前播放的 `<video>/<audio>`，仍保留 frame、时钟、duration 与 `blob:`/MSE 身份。
2. 后台 webRequest 观察到的 HLS / DASH / `audio/*` 可以补回候选。
3. blob/MSE 或完全没有可读源时，同 frame 的 `video/mp4`、`video/webm`、`application/mp4` 可作为最后候选，真正使用前仍做 range/container probe。
4. 暂不跨 frame 猜资源，避免广告、hover preview、嵌套播放器被误匹配。

## 下一阶段最值得做

- 完整支持通用 DASH SegmentTemplate / SegmentList。
- 给候选加入最近请求时间、initiator、host、duration 等评分。
- 统计 direct-route 成功率和失败原因（403、Range、DRM、解析失败），用真实数据决定后续放宽。
- 建立更可靠的 iframe / worker document 关联后，再考虑有限跨 frame 候选。
