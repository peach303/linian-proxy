# 黎念 · 免费代理（Deno Deploy）

给静态站 `https://peach303.github.io/linian/` 提供五类能力，聊天数据仍然只存在浏览器里：

- MiniMax 语音合成
- 博查联网搜索
- 图片转发（绕过外链防盗链 / CORS）
- 网易云歌曲元信息
- 网易云公开音频流（302 到 CDN，应用内 `<audio>` 直接播放）

Key 不写进代码：保存在 Deno KV，或通过 Deno Deploy 环境变量提供。网页端只拿到接口，不接触明文 Key。

## 部署

1. 在 [console.deno.com](https://console.deno.com) 新建 Dynamic App，连接本仓库。
2. Entrypoint 填 `proxy.ts`，部署。
3. 在 App 的 KV 里创建 / 绑定一个数据库（变量名保持默认 `KV`）。
4. 在环境变量里加 `ADMIN_PASSWORD`（网页「设置 → 接入」保存配置时要用）。
5. 可选：加 `ALLOWED_ORIGIN=https://peach303.github.io` 限制跨域来源。

部署后的健康检查：

```text
GET https://<app>.deno.net/api/v1/health
```

## 网页端

在「设置 → 接入」里填 MiniMax 的 API Key / GroupId / 音色 ID，以及博查 API Key，点保存。
这些值会通过带管理密码的请求写进 Deno KV，不会回显明文，只显示尾号。

## 接口

```text
GET  /api/v1/health
GET  /api/v1/integrations
PUT  /api/v1/integrations
POST /api/v1/voice/tts
POST /api/v1/search
GET  /api/v1/image?u=...&ref=...
GET  /api/v1/music/resolve?input=...
GET  /api/v1/music/audio?id=...   （默认 302 到音频 CDN；?stream=1 走同源转发）
```
