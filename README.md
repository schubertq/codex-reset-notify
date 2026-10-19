# Codex 重置通知

**秒级推送通知 · 只有重置消息 · 中文飞书卡片**

跟踪 [Tibo（@thsottiaux）](https://x.com/thsottiaux) 的公开动态，将 Codex 额度重置、重置卡发放和后续进展推送到飞书。

## 加入通知群

### [👉 点击加入「Codex 重置通知」话题群](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=ea7n5446-e742-453d-95e3-6f043e7536b7)

无需加入企业或自行部署，使用现有飞书账号即可入群。手机用户可扫码加入：

<a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=ea7n5446-e742-453d-95e3-6f043e7536b7"><img src="docs/join-feishu.png" width="200" height="200" alt="扫码加入 Codex 重置通知飞书群"></a>

## 核心特点

- **及时通知**：X 官方事件回调触发，云端持续运行，不依赖你的电脑在线。
- **语义筛选**：结合原帖和回复／引用上下文，区分预告、进行中、完成与异常。
- **来源可查**：中文译文、原帖图片与引用上下文，一键查看原帖。
- **进展独立成卡**：预告、进展和确认分别通知，已发送卡片保持原样。
- **去重与重试**：重复回调去重，投递失败自动重试。

实际时延受平台、网络和翻译等影响，见[测速说明](docs/performance.md)。通知不代表个人账户已到账。

## 自行部署

- [Cloudflare 云端部署](cloudflare/README.md)：需要自己的 X 开发者应用与飞书应用。
- [本地 Python 部署](docs/local-deployment.md)：使用 AIHOT，无需 X Token，需要本机持续联网。

[MIT 开源协议](LICENSE)
