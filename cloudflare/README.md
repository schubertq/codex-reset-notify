# Cloudflare 部署

从仓库根目录开始，按顺序操作。此路线需要自己的 Cloudflare 账号、飞书企业自建应用和 X 开发者应用；不能仅凭一个飞书群 Webhook 运行。示例保持接收与监控关闭，配置完成后再启用。

## 1. 安装与测试

Node.js 22.13+、npm、Git、curl；后面的交互式 `read` 示例使用 Bash，可先执行 `bash`。X 回调和上下文查询可能计入 API 用量，先确认自己的应用权限及额度，不在此教程中自动充值或升级套餐。

```sh
# 尚未克隆时先执行这两行；已有代码则从 cd cloudflare 开始。
git clone https://github.com/schubertq/codex-reset-notify.git
cd codex-reset-notify
cd cloudflare
npm ci
npm test
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
```

之后命令均在 `cloudflare/` 执行，使用被 Git 忽略的 `wrangler.jsonc`。示例 Worker 名称 `my-codex-reset-notify`、数据库与队列名称均需确认是自己要新建的资源；名称冲突时更换名称并同步下面命令。不要覆盖已有线上 Worker 或复用其数据库。

## 2. 准备飞书应用与目标群

1. 在[飞书开发者后台](https://open.feishu.cn/app)创建企业自建应用，启用机器人能力，记录自己的 App ID 和 App Secret。
2. 在权限管理申请 `im:message:send_as_bot`（以应用身份发消息）和 `im:resource`（上传图片/文件资源）。此服务不需要用户身份发信权限，也不需要读取群消息历史。
3. 创建并发布应用版本，取得租户管理员审批；把自己和告警接收人加入应用可用范围。仅保存开发配置不会让生产机器人生效。
4. 把应用机器人加入自己的通知群，确认它具有发言权限。取得该群的 `chat_id`（`oc_` 开头），不要填写群分享链接。可在开发者后台的[获取机器人所在群列表 API 调试台](https://open.feishu.cn/document/server-docs/group/chat/list)使用本应用的 tenant token 查到群 ID；按调试台要求临时授权该查询接口即可，运行服务本身不轮询群列表。

这条路线使用中国区 `open.feishu.cn`；国际版 Lark 租户需要另行适配 API 域名。跨租户/外部群是否允许加入应用机器人取决于租户与应用能力，先用自己能加入机器人的群验收。飞书发信和图片规则以[消息 API 文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1)为准。

## 3. 创建 Cloudflare 资源并初始化数据库

```sh
npx wrangler d1 create my-codex-reset-notify
npx wrangler queues create my-codex-reset-notifications --message-retention-period-secs 86400
npx wrangler queues create my-codex-reset-notifications-dlq --message-retention-period-secs 86400
```

把 D1 返回的真实 `database_id` 填入 `wrangler.jsonc`，替换全零占位符；`database_name` 与创建的名称保持一致。两个队列名分别对应 `queues.producers[].queue` / `queues.consumers[].queue` 和 `dead_letter_queue`。多账号登录时，在本地配置补充自己的 `account_id`，确保 Worker、D1 和队列属于同一账号。

填写最小配置：`FEISHU_APP_ID`、`RESET_CHAT_ID`；保持 `X_ENABLED` 和 `MONITOR_ENABLED` 为字符串 `"false"`，其他可选配置暂留空。随后应用迁移文件，并首次发布停用接收的 Worker：

```sh
npx wrangler d1 migrations apply my-codex-reset-notify --remote
npx wrangler deploy
```

应看到六个迁移文件全部成功，以及自己 Worker 的 HTTPS 地址。初次部署先于 secret put，避免命令为不存在的 Worker 创建占位服务。后续 `wrangler secret put/delete` 也会立即发布新版本，执行时留意自己操作的 Worker 名称。[Secrets 说明](https://developers.cloudflare.com/workers/configuration/secrets/)

## 4. 配置自己的密钥并验证飞书投递

从同一个 X App 获取 OAuth 2.0 Client Secret 和 App-only Bearer Token。当前代码只验证 `X-Twitter-Webhooks-Signature-OAuth2`，请使用 OAuth 2.0 Client Secret；Bearer Token 不能替代签名密钥，也不要把 OAuth 1.0 API Secret 填成 OAuth 2.0 Client Secret。[X 签名说明](https://docs.x.com/x-api/webhooks/quickstart)

```sh
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put X_OAUTH2_CLIENT_SECRET
npx wrangler secret put X_BEARER_TOKEN
```

逐条在提示中输入自己的值。不要把它们写进 `vars`。本地开发可复制 `.dev.vars.example` 为 `.dev.vars`，但该文件不会替你上传生产密钥。

接入测试会向 `RESET_CHAT_ID` 中的群实际发送一张「云端链路测试」卡片。先设置自己的地址，再配置临时测试身份：

```sh
export WORKER_URL='https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
npx wrangler secret put SMOKE_TEST_ID
# 输入一个本次唯一的非空名称，例如 deployment-check-1。
npx wrangler secret put SMOKE_TEST_TOKEN
# 输入自己生成的临时随机测试口令；下一步 read 中输入同一个口令。
read -r -s SMOKE_TEST_TOKEN
export SMOKE_TEST_TOKEN
curl --fail-with-body --silent --show-error --request POST "$WORKER_URL/admin/smoke" \
  --header "Authorization: Bearer $SMOKE_TEST_TOKEN"
npx wrangler d1 execute my-codex-reset-notify --remote \
  --command "SELECT id,status,message_id FROM receipts WHERE id LIKE 'smoke-%' ORDER BY created_at DESC LIMIT 5"
```

HTTP 202 仅代表已入队。确认群内实际出现测试卡片，并在 D1 看到本次 `smoke-<SMOKE_TEST_ID>` 为 `sent` 且有消息 ID；消费者异步执行，必要时稍后再次查回执。未出现时用 `npx wrangler tail` 查 `TiboResetRadar` 日志，并检查应用已发布、机器人在群内、权限已生效和群 ID。`pending` / `delivery_retry` 都不代表投递完成。

确认成功后关闭测试入口：

```sh
npx wrangler secret delete SMOKE_TEST_TOKEN
npx wrangler secret delete SMOKE_TEST_ID
unset SMOKE_TEST_TOKEN
```

## 5. 注册 X 回调并查询目标作者

[Webhook 注册](https://docs.x.com/x-api/webhooks/quickstart)和[创建订阅](https://docs.x.com/x-api/activity/create-x-activity-subscription)是两个步骤；仅在开发者后台填回调地址不等于已经订阅作者。下面命令读取自己的 Bearer Token，不把原文写入命令历史；API 返回若含 `errors`，应先处理错误再继续，不能只看 HTTP 200。

```sh
read -r -s X_BEARER_TOKEN
export X_BEARER_TOKEN
export X_WEBHOOK_URL="$WORKER_URL/webhooks/x"
curl --fail-with-body --silent --show-error --request POST 'https://api.x.com/2/webhooks' \
  --header "Authorization: Bearer $X_BEARER_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "{\"url\":\"$X_WEBHOOK_URL\"}"
```

返回 `data.valid=true` 表示 CRC 通过；将 `data.id` 原样作为字符串记录为自己的 `X_WEBHOOK_ID`。若提示 URL 已存在，使用 `GET /2/webhooks` 核对自己的同一回调，不要反复创建。CRC 可以在 `X_ENABLED=false` 时完成，注册失败优先检查 Client Secret 和公网 HTTPS 可达性。

```sh
curl --fail-with-body --silent --show-error 'https://api.x.com/2/users/by/username/thsottiaux' \
  --header "Authorization: Bearer $X_BEARER_TOKEN"
export X_TIBO_USER_ID='REPLACE_WITH_DATA_ID'
export X_WEBHOOK_ID='REPLACE_WITH_WEBHOOK_ID'
node -p 'new Date().toISOString()'
```

用用户查询的 `data.id` 替换上面的作者 ID，用自己的回调 ID 替换占位符，长数字始终按字符串处理。把这些值以及 `X_WEBHOOK_URL` 写入 `wrangler.jsonc`。把 Node 命令输出的 UTC 时间填为 `X_SUBSCRIPTION_START_AT`，设 `X_ENABLED="true"`，保持监控关闭并重新部署：

```sh
npx wrangler deploy
curl --fail-with-body --silent --show-error "$WORKER_URL/health"
```

应返回 `x_enabled:true`。确认接收已启用后，再创建一次作者新帖订阅：

```sh
curl --fail-with-body --silent --show-error --request POST 'https://api.x.com/2/activity/subscriptions' \
  --header "Authorization: Bearer $X_BEARER_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "{\"event_type\":\"post.create\",\"filter\":{\"user_id\":\"$X_TIBO_USER_ID\"},\"tag\":\"codex-reset-notify\",\"webhook_id\":\"$X_WEBHOOK_ID\"}"
curl --fail-with-body --silent --show-error "https://api.x.com/2/activity/subscriptions?user_id=$X_TIBO_USER_ID" \
  --header "Authorization: Bearer $X_BEARER_TOKEN"
```

从创建响应的 `data.subscription.subscription_id` 取得订阅 ID，并在列表响应中核对 `event_type=post.create`、`filter.user_id` 和 `webhook_id` 完全匹配。将 `X_SUBSCRIPTION_ID` 写入本地配置。未指定 `expires_at` 的订阅持续有效直至删除；发生权限或平台限制时按实际响应处理。`post.create` 已包括该作者自己的回复、引用和转帖，不需要另建其他用户的回复订阅。[事件说明](https://docs.x.com/x-api/activity/introduction)

若同一 App 已有该作者的线上订阅，同作者的隔离验收应使用另一个 App；也可复用现有 App，为另一位测试作者创建独立回调和短期订阅，配合下文的全部动态群验证真实投递，但这不能代替 Tibo 重置帖的专项验收。不要重复创建相同事件与作者的订阅、修改旧订阅的 `webhook_id` 或重新生成线上密钥：重叠订阅可能被拒绝，重复创建还可能刷新已有订阅的到期时间。仅更换 Worker 名称不能隔离 X 侧订阅。[重复订阅与有效期](https://docs.x.com/x-api/activity/introduction)

## 6. 可选能力与配置检查

| 功能 | 必须具备的配置 |
| --- | --- |
| 重置群接收 | `FEISHU_APP_ID`、`RESET_CHAT_ID`、飞书 Secret；`X_ENABLED="true"`、`X_TIBO_USER_ID`、`X_SUBSCRIPTION_START_AT`、X Client Secret；实际绑定此回调的 `post.create` 订阅 |
| 语义筛选（必需） | 保留 `ai.binding="AI"` 并确保 Workers AI 可用；使用 `@cf/openai/gpt-oss-120b` 判断整帖和实际回复／引用链，不要求正文出现 Codex；模型失败进入重试，不退回关键词规则 |
| 父帖上下文查询 | `X_BEARER_TOKEN`；依赖关联对象的回复必须成功取得上下文 |
| 全部动态群 | 再填写自己的 `ALL_POSTS_CHAT_ID` / `ALL_POSTS_START_AT`，应用机器人也需在第二个群内；每个目的地独立去重 |
| 管理员告警 | `MONITOR_ENABLED="true"`、`ADMIN_UNION_ID`、`X_SUBSCRIPTION_ID`、`X_WEBHOOK_ID`、`X_WEBHOOK_URL` 和有效 Bearer Token；管理员需在应用可用范围内并能接收机器人私信 |
| 中文翻译 | 与语义筛选共用 Workers AI 额度，使用 Qwen 翻译；翻译失败保留原文，不能删除筛选必需的 AI 绑定 |

所有配置改动均需 `npx wrangler deploy` 才会生效。告警使用同一应用下取得的 `union_id`（`on_` 开头），不能填写 `open_id`、群 ID 或网页用户 ID；尚未准备好时保持监控关闭，不影响业务通知。第二个群不填写时保持相关两项为空。

最终验收分三层：`/health` 仅证明接收开关；smoke 的群内卡片与 D1 `sent` 回执证明飞书链路；下一条真正的 X 回调及其业务回执才证明完整实时链路。没有新帖时无需期待测试消息；不要人为发布假的 Tibo 公告来验收。确认订阅后可清除终端内的 Token：

```sh
unset X_BEARER_TOKEN
```

## 语义验收

语义判断覆盖预告、进行中、已完成与异常；同一次事件的不同原帖分别成卡。`semantic-cases.json` 包含历史原帖和人工构造的反例，预期标注不发送给模型。运行真实验收时使用仅含 AI 绑定的独立配置，避免加载生产数据库和飞书密钥：

```sh
node evaluate-semantic.cjs /path/to/ai-only.jsonc /path/to/results.jsonl 10 500
```

逐条执行，上限为十个样本、500 Neurons；遇到接口或格式错误即停，重复运行复用相同代码版本的结果。需先核对账户可用额度，单元测试通过不代表真实模型验收通过。[额度与计费](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## 运行边界

- 每五分钟 Cron 清理旧版本遗留快照，并在监控开启时检查积压；订阅检查每小时进行，不轮询历史帖子。
- 队列消费者并发为 1；最多 72 次重试，每次延迟五分钟；超过六小时的业务消息停止投递。稳定 UUID 和数据库租约减少重复，不承诺严格 exactly-once。
- 队列和失败队列保留消息 24 小时；D1 去重回执保留 ID、状态和时间。语义结果及必要原帖正文保留七天，供重试和上下文复用；旧卡片不改写。源帖删除／编辑同步尚未实现。
- 图片仅使用回调或实际父帖查询携带的 `pbs.twimg.com/media/` 地址，最多四张、单张 8 MiB，不跟随重定向。翻译失败显示原文，图片失败保留原帖入口。
- 免费额度、API 权限和平台限额不由仓库提供保证；部署成功不会自动替你获得 X 额度或飞书外部群权限。平台整体故障也可能使同平台告警失效。

卡片发送后保持正文、颜色和状态不变；同一重置事件的后续新帖会生成独立卡片。蓝色表示预告及相关进展，绿色仅用于明确完成，红色表示延期或异常；关联推断始终有说明。
