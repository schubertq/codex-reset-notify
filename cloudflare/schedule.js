const HOUR = 3600000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const numbers = {a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12};
const relative = /\b(in|within)\s+(?:the\s+)?(?:next\s+)?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|twelve)?\s*(minutes?|mins?|hours?|hrs?)\b/gi;
const clock = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(PST|PDT|PT|Pacific(?:\s+Time)?|UTC|GMT)\b/gi;
const blocked = /\b(?:not|no|won't|wouldn't|cannot|can't|maybe|might|if|ago|yesterday|last|was|were|already|completed|cancelled|canceled|delayed|postponed)\b|[?？]/i;

function parts(ms, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function format(ms) {
  const p = parts(ms, 'Asia/Shanghai');
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function zoneFor(label) {
  label = label.toUpperCase();
  if (label === 'PST') return {name: 'Etc/GMT+8', offsets: [-8]};
  if (label === 'PDT') return {name: 'Etc/GMT+7', offsets: [-7]};
  if (label === 'UTC' || label === 'GMT') return {name: 'UTC', offsets: [0]};
  return {name: 'America/Los_Angeles', offsets: [-8, -7]};
}
function absoluteTime(text, match, published) {
  const [, hourText, minuteText, meridiem, zoneText] = match;
  let hour = Number(hourText), minute = Number(minuteText ?? 0);
  if (minute > 59 || hour > (meridiem ? 12 : 23) || (meridiem && hour < 1) || (!meridiem && minuteText === undefined)) return null;
  if (meridiem) hour = hour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const zone = zoneFor(zoneText), local = parts(published, zone.name);
  let year = Number(local.year), month = Number(local.month), day = Number(local.day);
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  const named = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/i);
  const tomorrow = /\btomorrow\b/i.test(text);
  if (Number(Boolean(iso)) + Number(Boolean(named)) + Number(tomorrow) + Number(/\btoday\b/i.test(text)) > 1) return null;
  // 未支持的日期、时间范围和模糊时区不借用发帖日期猜测。
  if (/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|next|week|month)\b|\d\s*\/\s*\d/i.test(text)) return null;
  if (!named && (/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i.test(text) || /\bon\s+(?:the\s+)?\d/i.test(text) && !iso)) return null;
  if (/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(text.replace(match[0], ''))) return null;
  if (iso) [year, month, day] = iso.slice(1).map(Number);
  if (named) { month = MONTHS.findIndex(m => m.startsWith(named[1].toLowerCase())) + 1; day = Number(named[2]); year = Number(named[3] ?? year); }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  if (tomorrow) date.setUTCDate(date.getUTCDate() + 1);
  year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; day = date.getUTCDate();
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = zone.offsets.map(offset => wall - offset * HOUR).filter(ms => {
    const p = parts(ms, zone.name);
    return Number(p.year) === year && Number(p.month) === month && Number(p.day) === day && Number(p.hour) === hour && Number(p.minute) === minute;
  });
  // 夏令时跳过/重复的本地时刻无法唯一换算，宁可不显示。
  if (candidates.length !== 1 || candidates[0] < published) return null;
  return candidates[0];
}

// 只解释明确的生效时间，不根据历史习惯预测；调用方负责重置相关性筛选。
export function effectiveSchedule(text, createdAt) {
  const published = Date.parse(createdAt);
  if (!Number.isFinite(published) || blocked.test(text)) return null;
  const results = [];
  for (const sentence of text.split(/\n+|[.!;](?:\s+|$)/)) {
    if (!/\b(?:reset(?:s|ting)?|land(?:ing)?|roll(?:ing)?\s+out|available|take\s+effect)\b/i.test(sentence)) continue;
    if (/\b(?:expires?|expiry|valid|maintenance|meeting|stream|release|launch|interview)\b/i.test(sentence)) continue;
    const relatives = [...sentence.matchAll(relative)], clocks = [...sentence.matchAll(clock)];
    if (relatives.length + clocks.length !== 1 || /\b(?:between|until|from|after|before|unless)\b|\d\s*[-–]\s*\d/i.test(sentence.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, ''))) continue;
    if (relatives.length) {
      const [, relation, amount, unit] = relatives[0];
      if (!amount && !/\bnext\b/i.test(relatives[0][0])) continue;
      const duration = (numbers[amount?.toLowerCase()] ?? Number(amount ?? 1)) * (/^(minute|min)/i.test(unit) ? 60000 : HOUR);
      if (!(duration > 0 && duration <= 7 * 24 * HOUR)) continue;
      results.push({at: published + duration, deadline: relation.toLowerCase() === 'within', source: relatives[0][0], relative: true});
    } else {
      const at = absoluteTime(sentence, clocks[0], published);
      if (at !== null) results.push({at, deadline: /\bby\b/i.test(sentence), source: sentence.trim().slice(0, 300), relative: false});
    }
  }
  if (results.length !== 1) return null;
  const result = results[0];
  return {...result, label: `预计生效时间（北京时间 UTC+8）：${format(result.at)}${result.deadline ? ' 前' : ''}`, basis: result.relative ? `按原帖发布时间换算：${result.source}` : `按原帖时区换算：${result.source}`};
}
