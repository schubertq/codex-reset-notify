#!/usr/bin/env python3
"""Tibo 重置通知：结构化事件筛选、持久化去重和飞书投递。"""

import argparse
import base64
import fcntl
import gzip
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo
from cards import card

SOURCE = "https://aihot.news/api/v1/codex-resets/recent"
CANONICAL = "https://aihot.news/codex-reset"
INTERVAL = 600
MAX_AGE = 48 * 3600
STAGES = {"预告", "发卡预告", "确认完成", "确认发卡", "进展", "补充说明"}
TYPES = {"direct_reset", "reset_credit"}


class RadarError(Exception):
    pass


def timestamp(value):
    if not isinstance(value, str):
        raise RadarError("Invalid source timestamp")
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if d.tzinfo is None:
            raise ValueError()
        return d.timestamp()
    except ValueError as exc:
        raise RadarError("Invalid source timestamp") from exc


def extract(snapshot):
    """仅消费明确事件内的原帖；不消费 related 活动或模型估计确认。"""
    if snapshot.get("schemaVersion") != 1 or not isinstance(snapshot.get("events"), list):
        raise RadarError("Unsupported source schema")
    timestamp(snapshot.get("checkedAt"))
    posts = {}
    for event in snapshot["events"]:
        if event.get("type") not in TYPES:
            continue
        if not isinstance(event.get("posts"), list):
            raise RadarError("Missing event posts")
        for post in event["posts"]:
            if post.get("stage") not in STAGES:
                continue
            post_id = post.get("id", "")
            if not isinstance(post_id, str) or not re.fullmatch(r"\d+", post_id):
                raise RadarError("Invalid post ID")
            if post.get("url") != f"https://x.com/thsottiaux/status/{post_id}":
                raise RadarError("Unexpected source author or URL")
            published = timestamp(post.get("publishedAt"))
            text = post.get("text") or post.get("originalText")
            if not isinstance(text, str) or not text.strip():
                raise RadarError("Missing post text")
            # 同一原帖可能同时发额度和重置卡，合并为一条通知。
            item = posts.setdefault(post_id, {
                "id": post_id, "published": published, "url": post["url"], "parts": []
            })
            part = {"stage": post["stage"], "text": text[:3000].replace("<", "＜"),
                    "type": event["type"]}
            if part not in item["parts"]:
                item["parts"].append(part)
    return sorted(posts.values(), key=lambda p: (p["published"], p["id"]))


def message(post, test=False):
    stages = {p["stage"] for p in post["parts"]}
    if stages & {"确认完成", "确认发卡"}:
        phase = "确认动态"
    elif stages & {"预告", "发卡预告"}:
        phase = "预告"
    else:
        phase = "进展"
    title = ("【历史样例·链路测试】" if test else "") + f"Codex 重置{phase}"
    when = datetime.fromtimestamp(post["published"], ZoneInfo("Asia/Shanghai"))
    blocks = [f"**原帖时间**：{when:%Y-%m-%d %H:%M}（北京时间）\n**适用范围**：以原帖说明为准",
              "\n\n".join(f"[{part['stage']}]\n> " + part['text'].replace("\n", "\n> ") for part in post['parts'])]
    return json.dumps(card(title, blocks, [("查看原帖", post['url']), ("打开重置监控", CANONICAL)],
                           "来源：AIHOT · 适用范围及有效期以原帖和账户页面为准。", test), ensure_ascii=False)


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, published REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY, published REAL NOT NULL, body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt REAL NOT NULL DEFAULT 0, last_error TEXT, sent_at REAL
        );
    """)
    return db


def get(db, key, default=None):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def put(db, key, value):
    db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value)))


def ingest(db, snapshot, now):
    posts = extract(snapshot)
    checked = timestamp(snapshot["checkedAt"])
    if checked > now + 300:
        raise RadarError("Source clock is ahead")
    if now - checked > 3600:
        raise RadarError("Source scan is stale (over one hour)")
    baseline = get(db, "baseline")
    added = 0
    with db:
        current = {post["id"]: post for post in posts}
        for pending in db.execute("SELECT id FROM outbox WHERE status='pending'").fetchall():
            post = current.get(pending["id"])
            if post:
                db.execute("UPDATE outbox SET body=? WHERE id=?", (message(post), post["id"]))
            else:
                db.execute("UPDATE outbox SET status='withdrawn',body='' WHERE id=?", (pending["id"],))
        for post in posts:
            if post["published"] > now + 300:
                raise RadarError("Post clock is ahead")
            exists = db.execute("SELECT 1 FROM seen WHERE id=?", (post["id"],)).fetchone()
            if exists:
                continue
            db.execute("INSERT INTO seen VALUES (?,?)", (post["id"], post["published"]))
            if baseline is not None and post["published"] >= max(baseline, now - MAX_AGE):
                db.execute("INSERT INTO outbox(id,published,body) VALUES (?,?,?)",
                           (post["id"], post["published"], message(post)))
                added += 1
        if baseline is None:
            put(db, "baseline", now)
        put(db, "source_checked_at", snapshot["checkedAt"])
    return added


def retry_after(value, now, fallback=INTERVAL):
    if value:
        try:
            return max(1, int(value))
        except ValueError:
            try:
                return max(1, int(parsedate_to_datetime(value).timestamp() - now))
            except (TypeError, ValueError, OverflowError):
                pass
    return fallback


def fetch(db, now, opener=urllib.request.urlopen):
    if now < get(db, "next_fetch", 0):
        return None
    headers = {"User-Agent": "aihot-api/2.0.0 TiboResetRadar/1.0",
               "Accept": "application/json", "Accept-Encoding": "gzip"}
    etag = get(db, "etag")
    if etag:
        headers["If-None-Match"] = etag
    try:
        with opener(urllib.request.Request(SOURCE, headers=headers), timeout=30) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise RadarError("Source response is too large")
            if response.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            snapshot = json.loads(raw)
            ingest(db, snapshot, now)
            cache = response.headers.get("Cache-Control", "")
            ages = re.findall(r"(?:s-maxage|max-age)=(\d+)", cache)
            with db:
                put(db, "etag", response.headers.get("ETag"))
                put(db, "next_fetch", now + max([INTERVAL] + [int(n) for n in ages]))
            return snapshot
    except urllib.error.HTTPError as exc:
        with db:
            put(db, "next_fetch", now + max(INTERVAL, retry_after(exc.headers.get("Retry-After"), now)))
        exc.close()
        if exc.code == 304 and etag:
            return None
        raise RadarError(f"Source HTTP {exc.code}") from None
    except (OSError, ValueError, RadarError) as exc:
        with db:
            put(db, "next_fetch", now + INTERVAL)
        if isinstance(exc, RadarError):
            raise
        raise RadarError(f"Source request failed ({type(exc).__name__})") from None


def load_config(path):
    config = json.loads(path.read_text())
    mode = config.get("transport")
    if mode in {"lark-user", "lark-bot"}:
        if not re.fullmatch(r"oc_[a-zA-Z0-9]+", config.get("chat_id", "")):
            raise RadarError("Set the target group chat_id in config.json")
    elif mode == "webhook":
        url = urllib.parse.urlparse(config.get("webhook_url", ""))
        if url.scheme != "https" or url.hostname not in {"open.feishu.cn", "open.larksuite.com"} or not url.path.startswith("/open-apis/bot/v2/hook/"):
            raise RadarError("Invalid Feishu webhook URL")
    else:
        raise RadarError("Unsupported delivery transport")
    return config


def send(config, body, key):
    try:
        content = json.loads(body)
        is_card = isinstance(content, dict) and content.get("schema") == "2.0"
    except (ValueError, TypeError):
        is_card = False
    if config["transport"] in {"lark-user", "lark-bot"}:
        identity = "bot" if config["transport"] == "lark-bot" else "user"
        args = [config.get("lark_cli", "lark-cli"), "im", "+messages-send", "--as", identity,
                "--chat-id", config["chat_id"], "--idempotency-key", key]
        if config.get("lark_profile"):
            args += ["--profile", config["lark_profile"]]
        args += ["--msg-type", "interactive", "--content", body] if is_card else ["--text", body]
        env = dict(os.environ, LARKSUITE_CLI_NO_UPDATE_NOTIFIER="1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER="1")
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=45, env=env)
            data = json.loads(result.stdout if result.returncode == 0 else result.stderr)
        except (subprocess.TimeoutExpired, OSError, ValueError) as exc:
            raise RadarError(f"Lark delivery failed ({type(exc).__name__})") from None
        if result.returncode or data.get("ok") is not True:
            error = data.get("error", {})
            raise RadarError(f"Lark delivery rejected: {error.get('type')} / {error.get('code', error.get('subtype'))}")
        return data.get("data", {})
    payload = {"msg_type": "interactive", "card": content} if is_card else {"msg_type": "text", "content": {"text": body}}
    secret = config.get("webhook_secret")
    if secret:
        stamp = str(int(time.time()))
        payload.update(timestamp=stamp, sign=base64.b64encode(
            hmac.new(f"{stamp}\n{secret}".encode(), b"", hashlib.sha256).digest()).decode())
    request = urllib.request.Request(config["webhook_url"], data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
        if data.get("code", data.get("StatusCode")) != 0:
            raise RadarError("Feishu webhook rejected the message")
    except (OSError, ValueError) as exc:
        # 不记录异常 URL，防止 webhook 密钥进入日志。
        raise RadarError(f"Webhook delivery failed ({type(exc).__name__})") from None


def deliver(db, config, now, sender=send, checkpoint=None):
    sent = 0
    rows = db.execute("SELECT * FROM outbox WHERE status='pending' ORDER BY published LIMIT 10").fetchall()
    for row in rows:
        if now - row["published"] > MAX_AGE:
            with db:
                db.execute("UPDATE outbox SET status='expired', body='' WHERE id=?", (row["id"],))
            if checkpoint:
                checkpoint()
            continue
        if row["next_attempt"] > now:
            break
        key = "tibo-" + hashlib.sha256(row["id"].encode()).hexdigest()[:40]
        try:
            sender(config, row["body"], key)
        except RadarError as exc:
            attempts = row["attempts"] + 1
            with db:
                db.execute("UPDATE outbox SET attempts=?,next_attempt=?,last_error=? WHERE id=?",
                           (attempts, now + min(INTERVAL * 2 ** min(attempts - 1, 7), 21600), str(exc), row["id"]))
            if checkpoint:
                checkpoint()
            # 保持同一群内的消息顺序，下一轮继续重试。
            break
        with db:
            db.execute("UPDATE outbox SET status='sent',sent_at=?,body='',last_error=NULL WHERE id=?", (now, row["id"]))
        if checkpoint:
            checkpoint()
        sent += 1
    return sent


def run(db, config, now, sender=send, checkpoint=None):
    # 同一数据库绑定一个通知目标，避免更换配置后向新群补发旧队列。
    target = hashlib.sha256(json.dumps([config['transport'], config.get('chat_id'), config.get('webhook_url')]).encode()).hexdigest()
    if get(db, "target", target) != target:
        raise RadarError("Delivery target changed; use a separate state database")
    with db:
        put(db, "target", target)
    error = None
    try:
        fetch(db, now)
    except RadarError as exc:
        error = str(exc)
    if checkpoint:
        checkpoint()
    # 上游未变化或暂时失败时，仍重试已经入队的通知。
    sent = deliver(db, config, now, sender=sender, checkpoint=checkpoint)
    with db:
        put(db, "last_run", now)
        put(db, "last_error", error)
    if checkpoint:
        checkpoint()
    result = status(db)
    result["sent_this_run"] = sent
    return result


def status(db):
    counts = dict(db.execute("SELECT status,COUNT(*) FROM outbox GROUP BY status").fetchall())
    checked = get(db, "source_checked_at")
    stale = checked is None or time.time() - timestamp(checked) > 3600
    failure = db.execute("SELECT last_error FROM outbox WHERE status='pending' AND last_error IS NOT NULL LIMIT 1").fetchone()
    return {"log_key": "TiboResetRadar", "baseline": get(db, "baseline"),
            "last_run": get(db, "last_run"), "source_checked_at": checked,
            "source_stale": stale, "last_error": get(db, "last_error"),
            "deliveries": counts, "next_fetch": get(db, "next_fetch"),
            "delivery_error": failure[0] if failure else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["poll", "status", "preview", "test-send"])
    parser.add_argument("--config", type=Path, default=Path("config.json"))
    parser.add_argument("--state", type=Path, default=Path(".local/state.sqlite3"))
    parser.add_argument("--snapshot", type=Path, help="预览及测试使用的本地源快照")
    args = parser.parse_args()
    if args.command in {"preview", "test-send"}:
        if not args.snapshot:
            parser.error("preview/test-send 需要 --snapshot，不自动补发历史")
        posts = extract(json.loads(args.snapshot.read_text()))
        if not posts:
            raise RadarError("No eligible reset posts")
        body = message(posts[-1], test=True)
        if args.command == "test-send":
            config = load_config(args.config)
            send(config, body, "tibo-test-" + posts[-1]["id"])
            print(json.dumps({"log_key": "TiboResetRadar", "test_sent": True}))
        else:
            print(body)
        return
    config = load_config(args.config) if args.command == "poll" else None
    args.state.parent.mkdir(parents=True, exist_ok=True)
    with open(str(args.state) + ".lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('{"log_key":"TiboResetRadar","skipped":"already_running"}')
            return
        db = connect(args.state)
        try:
            result = run(db, config, time.time()) if config else status(db)
            print(json.dumps(result, ensure_ascii=False))
        finally:
            db.close()
        if result["last_error"] or result["delivery_error"] or result["source_stale"]:
            raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except (RadarError, FileNotFoundError, json.JSONDecodeError) as exc:
        print(json.dumps({"log_key": "TiboResetRadar", "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
