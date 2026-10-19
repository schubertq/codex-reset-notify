"""验证误报、漏报、失败恢复和状态持久化边界。"""
import copy
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from datetime import datetime, timezone

import radar


NOW = time.time()


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def snapshot(post_id="100", stage="预告", published=NOW - 30, kind="direct_reset"):
    return {"schemaVersion": 1, "checkedAt": iso(NOW), "events": [{
        "id": "event-1", "type": kind, "title": "额度应已重置", "status": "announced",
        "presentation": {"status": "likely_completed"},
        "posts": [{"id": post_id, "stage": stage, "publishedAt": iso(published),
                   "text": "稍后将重置", "url": f"https://x.com/thsottiaux/status/{post_id}"}]
    }], "activities": [{"kind": "related", "text": "新模型发布"}]}


class RadarTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "state.sqlite3"
        self.db = radar.connect(self.path)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def seed(self):
        radar.ingest(self.db, snapshot(), NOW)

    def queue(self, post_id="101", offset=20):
        radar.ingest(self.db, snapshot(post_id=post_id, published=NOW + offset), NOW + 60)

    def test_baseline_silent_then_new_post_once_after_restart(self):
        self.assertEqual(radar.ingest(self.db, snapshot(), NOW), 0)
        self.queue()
        self.db.close()
        self.db = radar.connect(self.path)
        self.queue()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)

    def test_ordinary_activity_and_unknown_event_ignored(self):
        s = snapshot(kind="model_release")
        self.assertEqual(radar.extract(s), [])
        self.assertNotIn("新模型", radar.message(radar.extract(snapshot())[0]))

    def test_prediction_not_reported_as_confirmation(self):
        body = radar.message(radar.extract(snapshot())[0])
        self.assertIn("Codex 重置预告", body)
        self.assertNotIn("应已重置", body)

    def test_reply_confirmation_new_id_is_not_deduplicated_with_announcement(self):
        self.seed()
        s = snapshot(post_id="102", stage="确认完成", published=NOW + 20)
        self.assertEqual(radar.ingest(self.db, s, NOW + 60), 1)
        self.assertIn("确认动态", self.db.execute("SELECT body FROM outbox").fetchone()[0])

    def test_same_post_reset_and_credit_merged(self):
        s = snapshot()
        credit = copy.deepcopy(s["events"][0])
        credit["type"] = "reset_credit"
        credit["posts"][0]["stage"] = "发卡预告"
        s["events"].append(credit)
        posts = radar.extract(s)
        self.assertEqual(len(posts), 1)
        self.assertEqual(len(posts[0]["parts"]), 2)

    def test_old_backfill_silent(self):
        self.seed()
        self.assertEqual(radar.ingest(self.db, snapshot("999", published=NOW - 86400), NOW + 60), 0)

    def test_bad_snapshot_does_not_advance_baseline(self):
        s = snapshot()
        s["events"][0]["posts"][0]["publishedAt"] = "bad"
        with self.assertRaises(radar.RadarError):
            radar.ingest(self.db, s, NOW)
        self.assertIsNone(radar.get(self.db, "baseline"))

    def test_untrusted_author_rejected(self):
        s = snapshot()
        s["events"][0]["posts"][0]["url"] = "https://x.com/someone/status/100"
        with self.assertRaises(radar.RadarError):
            radar.extract(s)

    def test_stale_source_rejected(self):
        with self.assertRaises(radar.RadarError):
            radar.ingest(self.db, snapshot(), NOW + 7200)
        self.assertIsNone(radar.get(self.db, "baseline"))

    def test_retry_order_and_success(self):
        self.seed()
        s = snapshot("101", published=NOW + 20)
        s["events"].extend(snapshot("102", published=NOW + 30)["events"])
        radar.ingest(self.db, s, NOW + 60)
        calls = []

        def fail(config, body, key):
            calls.append(key)
            raise radar.RadarError("offline")

        radar.deliver(self.db, {}, NOW + 60, fail)
        radar.deliver(self.db, {}, NOW + 61, fail)
        self.assertEqual(len(calls), 1)
        self.assertEqual(radar.deliver(self.db, {}, NOW + 661, lambda *args: None), 2)
        self.assertEqual(radar.deliver(self.db, {}, NOW + 662, lambda *args: None), 0)

    def test_304_still_delivers_pending(self):
        self.seed()
        self.queue()
        with self.db:
            radar.put(self.db, "etag", "etag")
        with patch("radar.urllib.request.urlopen", side_effect=HTTPError(radar.SOURCE, 304, "", {}, io.BytesIO())):
            # fetch 的 opener 可注入，单独验证条件请求。
            radar.fetch(self.db, NOW + 60, opener=radar.urllib.request.urlopen)
        self.assertEqual(radar.deliver(self.db, {}, NOW + 60, lambda *args: None), 1)

    def test_source_429_honors_retry_after(self):
        def limited(*args, **kwargs):
            raise HTTPError(radar.SOURCE, 429, "", {"Retry-After": "1800"}, io.BytesIO())
        with self.assertRaises(radar.RadarError):
            radar.fetch(self.db, NOW, opener=limited)
        self.assertEqual(radar.get(self.db, "next_fetch"), NOW + 1800)

    def test_invalid_snapshot_does_not_save_etag(self):
        class Response(io.BytesIO):
            headers = {"ETag": "bad-etag"}
        with self.assertRaises(radar.RadarError):
            radar.fetch(self.db, NOW, opener=lambda *a, **k: Response(b'{"schemaVersion":9}'))
        self.assertIsNone(radar.get(self.db, "etag"))

    def test_pending_expires(self):
        self.seed()
        self.queue()
        self.assertEqual(radar.deliver(self.db, {}, NOW + radar.MAX_AGE + 100, lambda *a: self.fail()), 0)
        self.assertEqual(self.db.execute("SELECT status FROM outbox").fetchone()[0], "expired")

    def test_destination_change_rejected(self):
        with self.db:
            radar.put(self.db, "target", "different")
        with self.assertRaises(radar.RadarError):
            radar.run(self.db, {"transport": "lark-user", "chat_id": "oc_new"}, NOW)

    def test_webhook_error_and_secret_not_logged(self):
        config = {"transport": "webhook", "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/SECRET"}
        with patch("radar.urllib.request.urlopen", side_effect=OSError(config["webhook_url"])):
            with self.assertRaises(radar.RadarError) as e:
                radar.send(config, "test", "key")
        self.assertNotIn("SECRET", str(e.exception))

    def test_dedicated_bot_profile_preserves_target_and_idempotency(self):
        config = {"transport": "lark-bot", "chat_id": "oc_target",
                  "lark_profile": "codex-reset-notify"}
        with patch("radar.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = '{"ok": true, "data": {"message_id": "om_test"}}'
            self.assertEqual(radar.send(config, "notice", "stable-key")["message_id"], "om_test")
        args = run.call_args.args[0]
        self.assertEqual(args[args.index("--profile") + 1], "codex-reset-notify")
        self.assertEqual(args[args.index("--as") + 1], "bot")
        self.assertEqual(args[args.index("--chat-id") + 1], "oc_target")
        self.assertEqual(args[args.index("--idempotency-key") + 1], "stable-key")

    def test_withdrawn_pending_not_sent(self):
        self.seed()
        self.queue()
        radar.ingest(self.db, snapshot(), NOW + 60)
        self.assertEqual(radar.deliver(self.db, {}, NOW + 60, lambda *a: self.fail()), 0)
        self.assertEqual(self.db.execute("SELECT status FROM outbox").fetchone()[0], "withdrawn")

    def test_source_cannot_mention_everyone(self):
        s = snapshot()
        s["events"][0]["posts"][0]["text"] = '<at user_id="all">everyone</at>'
        self.assertNotIn("<at", radar.message(radar.extract(s)[0]))


if __name__ == "__main__":
    unittest.main()
