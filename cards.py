"""重置通知卡片：保留来源文字，只重建展示结构。"""
import html
import re


def card(title, blocks, links, note="", test=False):
    confirmed = "已完成" in title or "确认" in title or "全部到账" in title
    title = re.sub(r"\s*[（(]\s*Tibo(?:\s*(?:已)?确认)?\s*[）)]\s*$", "", title, flags=re.I)
    color = "turquoise" if confirmed else "blue"
    # 独立组件保留引用段落，以圆点替代分段后断开的引用竖线。
    elements = [{"tag": "markdown", "content": re.sub(r"(?m)^>[ \t]?", "• ", paragraph)}
                for block in blocks if block
                for paragraph in re.split(r"\n[ \t]*>[ \t]*\n", block) if paragraph]
    elements.append({"tag": "column_set", "flex_mode": "none", "columns": [
        {"tag": "column", "width": "auto", "elements": [{
            "tag": "button", "text": {"tag": "plain_text", "content": label},
            "type": "default" if i == 0 else "primary",
            "behaviors": [{"type": "open_url", "default_url": url}]
        }]} for i, (label, url) in enumerate(links)
    ]})
    if note:
        elements.append({"tag": "markdown", "content": f"<font color='grey'>{note}</font>",
                         "text_size": "notation"})
    header = {"title": {"tag": "plain_text", "content": title}, "template": color}
    if test:
        header["subtitle"] = {"tag": "plain_text", "content": "历史消息同步测试 · 不代表现在发生重置"}
    return {"schema": "2.0", "config": {"width_mode": "default"}, "header": header,
            "body": {"padding": "12px", "vertical_spacing": "12px", "elements": elements}}


def from_group_message(message, test=False):
    """读取 CLI 的卡片文本，不执行来源内容，也不推断或改写事实。"""
    match = re.fullmatch(r'<card title="(.*?)">\n(.*?)\n</card>', message["content"], re.S)
    if not match:
        raise ValueError("Unsupported source card format")
    title, content = match.groups()
    lines = content.splitlines()
    links = re.findall(r'\[([^\]]+)\]\((https://[^\s)]+)\)', lines[-1])
    if not links or len(links) > 2:
        raise ValueError("Unexpected source card buttons")
    # 保留原卡的元信息与引文，分成两个视觉区域。
    body_lines = lines[:-1]
    split = next((i for i, line in enumerate(body_lines) if not line.startswith("**")), len(body_lines))
    blocks = ["\n".join(body_lines[:split]), "\n".join(body_lines[split:])]
    blocks = [b.replace("<", "＜") for b in blocks]
    note = '来源：AIHOT热点监控推送'
    return card(html.unescape(title), blocks, links, note, test)
