"""确认转成卡片时不会改写源消息或丢失来源说明。"""
import unittest
from cards import from_group_message


class CardTests(unittest.TestCase):
    def test_preserves_source_claims_and_buttons(self):
        m = {"create_time": "2026-10-13 09:10", "content": '<card title="Codex 额度重置：Tibo 已宣布">\n**预计生效**：北京时间 09:03–16:00（AIHOT 推算）\n**适用范围**：未说明\n> 第8天/ 重置\n[查看原帖](https://x.com/thsottiaux/status/100) [打开重置监控](https://aihot.news/codex-reset)\n</card>'}
        result = from_group_message(m)
        self.assertEqual(result['header']['title']['content'], 'Codex 额度重置：Tibo 已宣布')
        self.assertNotIn('subtitle', result['header'])
        blocks = result['body']['elements']
        self.assertEqual(blocks[0]['content'], '**预计生效**：北京时间 09:03–16:00（AIHOT 推算）\n**适用范围**：未说明')
        self.assertEqual(blocks[1]['content'], '• 第8天/ 重置')
        self.assertEqual(blocks[2]['columns'][0]['elements'][0]['behaviors'][0]['default_url'], 'https://x.com/thsottiaux/status/100')

    def test_unknown_card_stops_instead_of_fabricating(self):
        with self.assertRaises(ValueError):
            from_group_message({'content': 'missing original card'})

    def test_quote_paragraphs_remain_separate_display_components(self):
        m = {"create_time": "2026-10-15 13:20", "content": '<card title="Codex 额度重置已完成（Tibo 确认）">\n**适用范围**：未说明\n> 关于我的重置按钮丢了的报道，实在是言过其实了\n>\n> 第 10 天/ 重置\n[查看原帖](https://x.com/thsottiaux/status/2110595484180214059)\n</card>'}
        result = from_group_message(m)
        self.assertEqual(result['header']['title']['content'], 'Codex 额度重置已完成')
        elements = result['body']['elements']
        self.assertEqual(elements[1]['content'], '• 关于我的重置按钮丢了的报道，实在是言过其实了')
        self.assertEqual(elements[2]['content'], '• 第 10 天/ 重置')
        self.assertEqual(elements[3]['tag'], 'column_set')
