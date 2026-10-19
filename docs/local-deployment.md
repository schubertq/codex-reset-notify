# 本地 Python 部署

以下命令均在仓库根目录执行。尚未下载代码时先运行：

```sh
git clone https://github.com/schubertq/codex-reset-notify.git
cd codex-reset-notify
```


Python 3.10+，仅使用标准库；使用 `fcntl` 文件锁，适用于 macOS / Linux。不需要执行 `pip install`。

先在目标群「设置 → 群机器人」添加自定义机器人，复制自己的 Webhook，启用签名校验并记录签名密钥。将它们填入 `config.json` 的 `webhook_url` 和 `webhook_secret`；这条路线使用群自定义机器人，与云端所需的应用机器人不同。若启用关键词限制，需允许通知标题中的 `Codex`。

```sh
cp config.example.json config.json
chmod 600 config.json
# 在 config.json 填写自己的飞书自定义机器人 Webhook 和签名密钥。
python3 radar.py poll
python3 radar.py status
```

首次接入建议先发送一条明确标注的人工部署测试，验证自己的 Webhook 和签名设置。下列命令会向 `config.json` 中的群实际发送一条卡片：

```sh
python3 - <<'CHECK'
import json
from pathlib import Path
import radar
from cards import card
config = radar.load_config(Path("config.json"))
body = json.dumps(card("【部署验证】Codex 通知测试",
    ["这是人工接入测试，不是 Tibo 的真实公告。"],
    [("作者主页", "https://x.com/thsottiaux")]), ensure_ascii=False)
radar.send(config, body, "manual-deployment-check")
print("Test request accepted; verify the card in your own group.")
CHECK
```

`poll` 只执行一轮，首次运行建立基线，不补发旧消息。自行设置每十分钟执行一次的调度，使用 ETag、Cache-Control 和 Retry-After 控制请求频率。本地工具依赖机器持续运行和联网，不能保证秒级到达。

需要持续轮询时，用 `command -v python3` 获取实际解释器路径，在 `crontab -e` 配置一个调度（替换两个绝对路径，保持单实例）：

```cron
*/10 * * * * cd /ABS/PATH/codex-reset-notify && /ABS/PATH/python3 radar.py poll >> .local/poll.log 2>&1
```

部署验收应区分：测试卡片能收到、首次 `poll` 建立基线、下一条真实事件实际送达。`status` 的 `last_error` / `delivery_error` 应为空，首次成功读取源数据后 `source_stale` 应为 `false`。如果所在环境无法访问 AIHOT 或飞书，请先解决网络问题。数据源暂时不可用时会报告错误，不会伪造新消息。

进阶可选：也可使用自己另外安装并完成授权的 `lark-cli` 应用机器人，配置示例如下；它不属于默认 Webhook 部署依赖：

```json
{
  "transport": "lark-bot",
  "chat_id": "oc_REPLACE_WITH_YOUR_CHAT_ID",
  "lark_cli": "lark-cli",
  "lark_profile": "YOUR_PROFILE"
}
```

Webhook 模式无额外 Python 依赖，`lark-cli` 模式需要另行安装该 CLI。目标群改变时使用独立状态库，避免旧队列发送到新群。

## 开发检查


```sh
python3 -m unittest discover -v
cd cloudflare
npm test
```

Cloudflare 测试使用 Node.js 22.13+ 的 `node:sqlite` 和内存数据库，网络请求使用替身，不发送真实消息。运行测试不需要安装 Wrangler；部署时再执行 `npm ci`。

