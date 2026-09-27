// 头像相关 API（存储：R2 桶 AVATARS）
//
// 设计要点：
// - 每个用户固定一个 key：avatars/<username>，重新上传直接覆盖，天然去重。
// - 读取接口公开只读：<img> 无法携带 Authorization，头像 URL 只能是不带凭证的 GET。
//   上传/删除必须登录（Cookie 或 Bearer），并校验 Origin 同源（Cookie 鉴权下的 CSRF 防护）。
// - 双重校验：Content-Type 白名单 + 文件头魔数，避免伪造扩展名的脚本/HTML 存进桶里
//   再被当作图片下发（内容型 XSS）。
// - URL 带 t=<上传时间戳> 用于上传后绕过缓存立即刷新，并支持 If-None-Match 返回 304。

import { readToken, verifyToken } from './token.js'

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const MAX_BYTES = 2 * 1024 * 1024 // 单张图片上限 2MB

// 允许的 MIME -> 文件头魔数
const TYPES = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF....WEBP
  'image/gif': [0x47, 0x49, 0x46, 0x38],
}

function json(data, status = 200, extra = null) {
  const headers = new Headers(API_HEADERS)
  for (const [key, value] of Object.entries(extra ?? {})) {
    headers.append(key, value)
  }
  return new Response(JSON.stringify(data), { status, headers })
}

// 每个用户固定一个 key，重新上传直接覆盖
export function avatarKey(username) {
  return `avatars/${encodeURIComponent(username)}`
}

// 带时间戳参数，上传后可立刻绕过浏览器/边缘缓存拿到新图
export function avatarUrl(username, updatedAt) {
  const base = `/api/avatar?username=${encodeURIComponent(username)}`
  return updatedAt ? `${base}&t=${updatedAt}` : base
}

// 查询用户头像地址；未上传或 R2 未配置时返回 null
export async function avatarOf(env, username) {
  if (!env.AVATARS) return null
  const head = await env.AVATARS.head(avatarKey(username))
  return head ? avatarUrl(username, head.uploaded?.getTime?.() ?? Date.now()) : null
}

// 校验文件头是否真的是图片（防止改扩展名上传非图片内容）
async function isRealImage(file) {
  const sig = TYPES[file.type]
  if (!sig) return false
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (!sig.every((b, i) => head[i] === b)) return false
  // webp：前 4 字节 RIFF，第 8-11 字节必须是 WEBP
  if (file.type === 'image/webp') {
    return String.fromCharCode(...head.slice(8, 12)) === 'WEBP'
  }
  return true
}

// GET /api/avatar?username=xxx —— 读取头像（公开只读）
export async function handleAvatarGet(request, env) {
  const username = new URL(request.url).searchParams.get('username') ?? ''
  if (!username) {
    return json({ error: '缺少 username 参数' }, 400)
  }
  if (!env.AVATARS) {
    return json({ error: 'R2 存储未配置，请在 wrangler.jsonc 绑定 AVATARS 桶' }, 503)
  }

  const object = await env.AVATARS.get(avatarKey(username))
  if (!object) {
    return json({ error: '该用户还没有上传头像' }, 404)
  }

  const immutable = new URL(request.url).searchParams.has('t')
  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Content-Length': String(object.size),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    'Access-Control-Allow-Origin': '*',
  })
  if (object.httpEtag) headers.set('ETag', object.httpEtag)
  // 协商缓存：带上一次 ETag 时直接返回 304
  if (object.httpEtag && request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(object.body, { status: 200, headers })
}

// POST /api/avatar —— 上传头像（需登录；multipart 字段 file，或直接发二进制 + 图片 Content-Type）
export async function handleAvatarUpload(request, env) {
  const payload = await verifyToken(env, readToken(request))
  if (!payload) {
    return json({ error: '未登录或 token 已过期' }, 401)
  }
  if (!env.AVATARS) {
    return json({ error: 'R2 存储未配置，请在 wrangler.jsonc 绑定 AVATARS 桶' }, 503)
  }

  const contentType = (request.headers.get('Content-Type') ?? '').split(';')[0].trim()
  let file = null
  if (contentType === 'multipart/form-data') {
    const form = await request.formData().catch(() => null)
    file = form?.get('file') ?? form?.get('avatar')
  } else {
    // 兼容直接上传二进制：curl --data-binary @a.png -H 'Content-Type: image/png'
    file = new File([await request.arrayBuffer()], 'avatar', { type: contentType })
  }

  if (!file || typeof file.size !== 'number' || file.size === 0) {
    return json({ error: '请选择要上传的图片' }, 400)
  }
  if (!TYPES[file.type]) {
    return json({ error: '仅支持 PNG / JPEG / WebP / GIF 格式' }, 415)
  }
  if (file.size > MAX_BYTES) {
    return json({ error: `图片不能超过 ${MAX_BYTES / 1024 / 1024}MB` }, 413)
  }
  if (!(await isRealImage(file))) {
    return json({ error: '文件内容不是有效的图片' }, 415)
  }

  const updatedAt = Date.now()
  await env.AVATARS.put(avatarKey(payload.username), await file.arrayBuffer(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      username: payload.username,
      updatedAt: String(updatedAt),
    },
  })

  return json({
    ok: true,
    avatarUrl: avatarUrl(payload.username, updatedAt),
    updatedAt,
    size: file.size,
    contentType: file.type,
  })
}

// DELETE /api/avatar —— 删除自己的头像（需登录）
export async function handleAvatarDelete(request, env) {
  const payload = await verifyToken(env, readToken(request))
  if (!payload) {
    return json({ error: '未登录或 token 已过期' }, 401)
  }
  if (!env.AVATARS) {
    return json({ error: 'R2 存储未配置，请在 wrangler.jsonc 绑定 AVATARS 桶' }, 503)
  }
  await env.AVATARS.delete(avatarKey(payload.username))
  return json({ ok: true })
}
