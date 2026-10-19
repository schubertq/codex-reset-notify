import {displayText, hasText} from './media.js';

export const beijingTime = value => new Date(value).toLocaleString('sv-SE', {timeZone: 'Asia/Shanghai'});
// Markdown 只用于我们生成的标签和引用前缀，原帖及译文不能注入 @人或卡片语法。
export const cardText = text => text.replace(/\\/g, '\\\\').replace(/([`*_~\[\]])/g, '\\$1').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 正文由调用方转义；引用框本身可点击打开被引用的帖子。
export function quoteCard(content, url, author = 'Tibo · @thsottiaux', imageKeys = []) {
  return {tag: 'interactive_container', has_border: true, border_color: 'grey-200', corner_radius: '12px',
    background_style: 'grey-50', padding: '12px 12px 12px 12px',
    behaviors: [{type: 'open_url', default_url: url}],
    elements: [{tag: 'markdown', content: '**' + cardText(author) + '**'},
      ...(content ? [{tag: 'markdown', content}] : []),
      ...imageKeys.map(key => ({tag: 'img', img_key: key, alt: {tag: 'plain_text', content: '引用帖图片'}, mode: 'fit_horizontal', preview: true})),
      ...(!content && !imageKeys.length ? [{tag: 'markdown', content: '该引用帖没有可预览内容，请点击查看原帖。'}] : [])]};
}
const textOf = post => post?.note_tweet?.text ?? post?.text ?? '';

function audience(text) {
  // 套餐必须出现在用户/账户范围短语中，不能借用旁边的产品介绍。
  if (/\bPro\s*500\b/i.test(text)) return {label: 'Pro 500 用户', specific: true};
  const planPhrase = text.match(/\b(?:Plus|Pro|Business|Enterprise|Team)(?:(?:\s*[,/、]\s*|\s+(?:and|or)\s+|\s+)(?:Plus|Pro|Business|Enterprise|Team))*\s+(?:users|accounts|plans)\b/i)?.[0];
  const plans = planPhrase && ['Plus', 'Pro', 'Business', 'Enterprise', 'Team'].filter(plan => new RegExp(`\\b${plan}\\b`, 'i').test(planPhrase));
  if (plans?.length) return {label: plans.join('、') + ' 用户', specific: true};
  if (/\b(?:all paid|everyone'?s paid)\s+(?:ChatGPT\s+)?(?:accounts|users)\b/i.test(text)) return {label: /all paid ChatGPT/i.test(text) ? '所有付费 ChatGPT 账户' : '所有付费账户', specific: true};
  if (/\ball plans\b/i.test(text)) return {label: '全部套餐', specific: true};
  if (/\ball accounts\b/i.test(text)) return {label: '所有账户（套餐未说明）', specific: false};
  return null;
}
function products(text) {
  return [/\bcodex\b/i.test(text) && 'Codex', /\bChatGPT\s+Work\b/i.test(text) && 'ChatGPT Work', /\bChatGPT\b/i.test(text.replace(/ChatGPT\s+Work/gi, '')) && 'ChatGPT'].filter(Boolean);
}
export function scopeOf(post, contextPost) {
  const current = textOf(post), context = textOf(contextPost);
  const ownContext = contextPost?.author_id === post.author_id;
  const here = audience(current), prior = ownContext ? audience(context) : null;
  const chosen = prior?.specific && !here?.specific ? prior : here ?? prior;
  const directProducts = products(current), priorProducts = ownContext ? products(context) : [];
  const names = directProducts.length ? directProducts : priorProducts;
  const inherited = Boolean(chosen && chosen === prior || !directProducts.length && priorProducts.length);
  return {label: [chosen?.label, names.join('、')].filter(Boolean).join(' · ') || '未说明', inherited};
}
export function resetMetadata(item) {
  const context = item.contextPost?.author_id === item.post.author_id ? item.contextPost : null;
  // 产品名本身不等于账户范围；仅展示正文或同作者原帖明确说明的用户范围。
  if (!audience(textOf(item.post)) && !audience(textOf(context))) return '';
  return '**适用范围**：' + scopeOf(item.post, context).label;
}
export function originalExcerpt(post, limit = 3000, resetOnly = false) {
  const displayed = displayText(post);
  const original = hasText(displayed) ? displayed : displayed.replace(/https?:\/\/\S+/g, '').trim();
  const paragraphs = original.split(/\n\s*\n/);
  const relevant = resetOnly && original.length > 500 ? paragraphs.filter(part => /\breset(?:s|ting)?\b|重置/i.test(part)) : [];
  const text = relevant.length ? relevant.join('\n\n') : original;
  const clipped = text.length > limit || text !== original;
  return text.slice(0, limit) + (clipped ? '\n（原文节选，完整内容请查看原帖）' : '');
}
export function translatedBody(post, translation, limit = 3000, resetOnly = false) {
  const translated = typeof translation === 'string' && translation.trim();
  if (!translated) return originalExcerpt(post, limit, resetOnly);
  return translated.slice(0, limit) + (translated.length > limit || displayText(post).length > 3000 ? '\n（长帖摘译，完整内容请查看原帖）' : '');
}
export function scheduleBasis(schedule) {
  if (schedule.relative) return '按原帖发布时间换算，属于预告时间，不代表已到账。';
  if (/\bPST\b/i.test(schedule.source)) return '原帖写明 PST，按 UTC−8 字面换算；若作者泛指当地 PT，夏令时可能相差一小时。预告不代表已到账。';
  return '按原帖注明的时区换算，属于预告时间，不代表已到账。';
}
