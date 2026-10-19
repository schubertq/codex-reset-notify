const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']]);

export function hasMedia(post) {
  return Array.isArray(post.attachments?.media_keys) && post.attachments.media_keys.length > 0;
}

function imageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.username && !url.password && !url.port &&
      url.pathname.startsWith('/media/') ? url.href : null;
  } catch { return null; }
}

export function eventPhotos(post, includes) {
  const keys = Array.isArray(post.attachments?.media_keys) ? post.attachments.media_keys : [];
  const media = Array.isArray(includes?.media) ? includes.media : [];
  // 只取当前帖子实际关联的图片，不能把父帖、引用帖或头像当作附件。
  return [...new Set(keys)].flatMap(key => {
    const photo = media.find(value => value?.media_key === key && value.type === 'photo');
    const url = photo && imageURL(photo.url);
    return url ? [{url}] : [];
  }).slice(0, 4);
}

export function displayText(post) {
  let text = post.note_tweet?.text ?? post.text;
  const entities = post.note_tweet?.entities ?? post.entities;
  const keys = post.attachments?.media_keys ?? [];
  for (const entity of Array.isArray(entities?.urls) ? entities.urls : []) {
    if (typeof entity.url === 'string' && entity.media_key && keys.includes(entity.media_key)) text = text.split(entity.url).join('');
  }
  return text.trim();
}

export function hasText(text) {
  return /[\p{L}\p{N}]/u.test(text.replace(/https?:\/\/\S+/g, '').replace(/@[A-Za-z0-9_]+/g, ''));
}

export async function uploadPhotos(photos, token) {
  const keys = [];
  const deadline = AbortSignal.timeout(12000);
  for (const photo of photos.slice(0, 4)) {
    try {
      const url = imageURL(photo?.url);
      if (!url) continue;
      // 不跟随重定向，也不携带 X 或飞书凭据访问图片源站。
      // Workers 不支持 error 模式；manual 配合下方状态校验仍拒绝所有重定向。
      const response = await fetch(url, {redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)])});
      const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || !IMAGE_TYPES.has(type) || !response.body || Number(response.headers.get('Content-Length')) > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        continue;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new Error('Image too large');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      if (!size) continue;
      const form = new FormData();
      form.set('image_type', 'message');
      form.set('image', new Blob(chunks, {type}), 'image.' + IMAGE_TYPES.get(type));
      const uploaded = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
        method: 'POST', headers: {Authorization: `Bearer ${token}`}, body: form, signal: deadline,
      });
      if (!uploaded.ok) continue;
      const data = await uploaded.json();
      if (data.code === 0 && /^img_[A-Za-z0-9_-]+$/.test(data.data?.image_key ?? '')) keys.push(data.data.image_key);
    } catch { /* 图片失败不阻塞原帖通知。 */ }
  }
  return keys;
}
