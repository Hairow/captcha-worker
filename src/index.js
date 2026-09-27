import { signToken, verifyToken, readToken, authCookie, clearAuthCookie } from './token.js'
import { verifyTurnstile } from './turnstile.js'
import { generateSlide, verifySlide } from './slide.js'

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const TOKEN_TTL_MS = 60 * 60 * 1000 // token 有效期 1 小时
const TOKEN_TTL_SEC = Math.floor(TOKEN_TTL_MS / 1000)
const AUTH_COOKIE = 'token' // HttpOnly：JS 读不到，防 XSS 窃取登录态

// ---- 头像配置（R2 存储）----
const AVATAR_MAX_BYTES = 2 * 1024 * 1024 // 单张图片上限 2MB
// 允许的 MIME -> 文件魔数前缀（同时校验 Content-Type 与文件头，防止伪装扩展名）
const AVATAR_TYPES = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
}

// 每个用户固定一个 key，重新上传直接覆盖，天然去重
function avatarKey(username) {
  return `avatars/${encodeURIComponent(username)}`
}

// 带时间戳参数，上传后可立刻绕过浏览器/边缘缓存拿到新图
function avatarUrl(username, updatedAt) {
  const base = `/api/avatar?username=${encodeURIComponent(username)}`
  return updatedAt ? `${base}&t=${updatedAt}` : base
}

// 校验文件头是否真的是图片（避免把脚本/HTML 存进 R2 后被当作图片下发）
async function isRealImage(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const sig = AVATAR_TYPES[file.type]
  if (!sig) return false
  if (!sig[0].every((b, i) => head[i] === b)) return false
  // webp：前 4 字节 RIFF，第 8-11 字节必须是 WEBP
  if (file.type === 'image/webp') {
    return String.fromCharCode(...head.slice(8, 12)) === 'WEBP'
  }
  return true
}

// 查询用户头像地址；未上传或 R2 未配置时返回 null
async function avatarOf(env, username) {
  if (!env.AVATARS) return null
  const head = await env.AVATARS.head(avatarKey(username))
  return head ? avatarUrl(username, head.uploaded?.getTime?.() ?? Date.now()) : null
}

// 演示用户表（生产环境建议改为 KV/D1 存储，密码哈希保存）
const USERS = {
  admin: { password: 'admin123', role: 'admin' },
  demo: { password: 'demo123', role: 'user' },
}

// extra 用于附加 Set-Cookie 等响应头（append 而非覆盖，保证可多次设置）
function json(data, status = 200, extra = null) {
  const headers = new Headers(API_HEADERS)
  for (const [key, value] of Object.entries(extra ?? {})) {
    headers.append(key, value)
  }
  return new Response(JSON.stringify(data), { status, headers })
}

// Cookie 鉴权下的 CSRF 防护：浏览器发的写请求必须带同源 Origin
// （SameSite=Lax 已挡掉大部分跨站场景，这里作为二次校验；
//   curl 等不含 Origin 的非浏览器请求直接放行）
function isSameOrigin(request) {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  return origin === new URL(request.url).origin
}

// 是否走 https（决定 Cookie 是否带 Secure；本地 http 不能带，否则浏览器不保存）
function isSecure(request) {
  return new URL(request.url).protocol === 'https:'
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: API_HEADERS })
    }

    // 健康检查
    if (request.method === 'GET' && path === '/api') {
      return json({
        name: env.API_NAME ?? 'captcha-worker-api',
        status: 'ok',
        message: 'API is running',
      })
    }

    // 登录接口：POST /api/login { username, password, cfTurnstileToken }
    if (request.method === 'POST' && path === '/api/login') {
      const body = await request.json().catch(() => null)
      const username = body?.username ?? ''
      const password = body?.password ?? ''

      // Turnstile 人机验证
      const turnstile = await verifyTurnstile(env, body?.cfTurnstileToken, request)
      if (!turnstile.success) {
        // 附带具体错误码，便于前端展示与排查（如 invalid-input-secret / timeout-or-duplicate）
        return json(
          {
            error: '人机验证失败，请重试',
            turnstileError: turnstile.error,
            errorCodes: turnstile.errorCodes ?? [],
          },
          403
        )
      }

      // 允许通过 env 覆盖管理员密码：ADMIN_PASSWORD / ADMIN_USERNAME
      const users =
        env.ADMIN_USERNAME || env.ADMIN_PASSWORD
          ? { [env.ADMIN_USERNAME ?? 'admin']: { password: env.ADMIN_PASSWORD ?? 'admin123', role: 'admin' } }
          : USERS

      const user = users[username]
      if (!user || user.password !== password) {
        return json({ error: '用户名或密码错误' }, 401)
      }

      const payload = {
        username,
        role: user.role,
        exp: Date.now() + TOKEN_TTL_MS,
      }
      // token 只写入 HttpOnly Cookie，不放进响应体，前端 JS 拿不到
      return json(
        {
          user: { username, role: user.role, avatarUrl: await avatarOf(env, username) },
          expiresAt: new Date(payload.exp).toISOString(),
        },
        200,
        { 'Set-Cookie': authCookie(await signToken(env, payload), { maxAge: TOKEN_TTL_SEC, secure: isSecure(request) }) }
      )
    }

    // 退出登录：POST /api/logout（清除 HttpOnly Cookie）
    if (request.method === 'POST' && path === '/api/logout') {
      return json({ ok: true }, 200, { 'Set-Cookie': clearAuthCookie({ secure: isSecure(request) }) })
    }

    // 当前用户信息：GET /api/me（Cookie 自动携带；也兼容 Authorization: Bearer）
    if (request.method === 'GET' && path === '/api/me') {
      const payload = await verifyToken(env, readToken(request))
      if (!payload) {
        return json({ error: '未登录或 token 已过期' }, 401)
      }
      return json({
        user: {
          username: payload.username,
          role: payload.role,
          avatarUrl: await avatarOf(env, payload.username),
        },
      })
    }

    // 头像读取：GET /api/avatar?username=xxx（图片不能带 Authorization 头，故公开只读）
    if (request.method === 'GET' && path === '/api/avatar') {
      const username = url.searchParams.get('username') ?? ''
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

      const immutable = url.searchParams.has('t')
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

    // 头像上传：POST /api/avatar（需登录；multipart 字段 file，或直接发二进制 + 图片 Content-Type）
    if (request.method === 'POST' && path === '/api/avatar') {
      if (!isSameOrigin(request)) {
        return json({ error: '跨站请求被拒绝' }, 403)
      }
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
        const bytes = await request.arrayBuffer()
        file = new File([bytes], 'avatar', { type: contentType })
      }

      if (!file || typeof file.size !== 'number' || file.size === 0) {
        return json({ error: '请选择要上传的图片' }, 400)
      }
      if (!AVATAR_TYPES[file.type]) {
        return json({ error: '仅支持 PNG / JPEG / WebP / GIF 格式' }, 415)
      }
      if (file.size > AVATAR_MAX_BYTES) {
        return json({ error: `图片不能超过 ${AVATAR_MAX_BYTES / 1024 / 1024}MB` }, 413)
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

    // 头像删除：DELETE /api/avatar（需登录）
    if (request.method === 'DELETE' && path === '/api/avatar') {
      if (!isSameOrigin(request)) {
        return json({ error: '跨站请求被拒绝' }, 403)
      }
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

    // 问候接口
    if (request.method === 'GET' && path === '/api/hello') {
      const name = url.searchParams.get('name') ?? 'World'
      return json({
        message: `Hello, ${name}!`,
        from: 'Cloudflare Worker',
        timestamp: new Date().toISOString(),
      })
    }

    // 时间接口（返回服务器时间与客户端所在地区）
    if (request.method === 'GET' && path === '/api/time') {
      const country = request.cf?.country ?? 'unknown'
      return json({
        time: new Date().toISOString(),
        country,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    }

    // 滑动验证码：生成两张 PNG 图片 + 一次性 uuid（GET）
    if (request.method === 'GET' && path === '/api/slide/generate') {
      const data = await generateSlide(env)
      // 缺口水平坐标（targetX）是验证核心，绝不下发给客户端；
      // puzzleY 仅用于前端把拼图块放到与缺口相同的垂直位置（不参与验证）
      return json({
        uuid: data.uuid,
        background: data.background,
        puzzle: data.puzzle,
        width: data.width,
        height: data.height,
        puzzleSize: data.puzzleSize,
        puzzleY: data.targetY,
        expiresIn: data.expiresIn,
      })
    }

    // 滑动验证码：服务端校验位置与轨迹（POST）
    if (request.method === 'POST' && path === '/api/slide/verify') {
      const body = await request.json().catch(() => null)
      return json(await verifySlide(body, env))
    }

    // 回显接口（POST JSON）
    if (request.method === 'POST' && path === '/api/echo') {
      const body = await request.json().catch(() => null)
      return json({
        received: body,
        method: request.method,
        headers: {
          'user-agent': request.headers.get('user-agent'),
        },
      })
    }

    // 非 API 路径交给静态资源（public 目录）处理
    if (!path.startsWith('/api') && env.ASSETS) {
      return env.ASSETS.fetch(request)
    }

    // 404 兜底
    return json(
      {
        error: 'Not Found',
        path,
        hint: 'Available routes: /api, /api/login, /api/logout, /api/me, /api/avatar, /api/hello, /api/time, /api/echo, /api/slide/generate, /api/slide/verify',
      },
      404
    )
  },
}
