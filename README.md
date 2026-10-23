# 黎念 · 免费代理（Deno Deploy）

给静态站 `https://peach303.github.io/linian/` 提供这些能力，聊天数据仍然只存在浏览器里：

- MiniMax 语音合成
- 博查联网搜索
- 图片转发（绕过外链防盗链 / CORS）
- 网易云 / QQ 音乐歌曲元信息
- 网易云 / QQ 音乐音频流（公开音源 302 到 CDN；登录后换 VIP / 高音质地址）
- 网易云歌词（给歌词截句用）
- 音乐账号会话（Cookie 只存 Deno KV，网页只拿短期令牌）

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
GET  /api/v1/music/resolve?input=...                              （自动识别网易云 / QQ）
GET  /api/v1/music/audio?id=...&session=...                       （网易云；默认 302 到音频 CDN，?stream=1 同源转发）
GET  /api/v1/music/audio?mid=...&session=...                      （QQ 音乐）
GET  /api/v1/music/lyric?id=...                                   （网易云 LRC → 可用歌词句）
GET  /api/v1/music/netease/qr                                     （拿扫码 key + 二维码内容）
GET  /api/v1/music/netease/poll?key=...                            （轮询扫码结果；成功返回 session）
GET  /api/v1/music/status?session=...                              （查会话对应的账号）
POST /api/v1/music/qq/login                                       （body: { cookie }）
POST /api/v1/music/logout                                         （body: { session }）
```

网易云走扫码登录；QQ 音乐网页端没有稳定的公开扫码接口，改成在设置页粘贴 y.qq.com 的 Cookie。
两种登录都只把 Cookie 存在 Deno KV（180 天），网页 localStorage 里只有随机 session 令牌。
VIP / 高音质是否可用仍取决于账号权限、版权、DRM 和地区限制；拿不到地址时接口会失败，不会伪造播放。
