import { signToken, verifyToken, readToken, authCookie, clearAuthCookie } from './token.js'
import { verifyTurnstile } from './turnstile.js'
import { generateSlide, verifySlide } from './slide.js'
import { avatarOf, handleAvatarGet, handleAvatarUpload, handleAvatarDelete } from './avatar.js'

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

// 首页入口：assets 层不会把 / 解析成 index.html，需在 Worker 里显式重定向到它
const HOME_PAGE = '/index.html'

const TOKEN_TTL_MS = 60 * 60 * 1000 // token 有效期 1 小时
const TOKEN_TTL_SEC = Math.floor(TOKEN_TTL_MS / 1000)
// Cookie 名与读写逻辑统一在 src/token.js（AUTH_COOKIE）

// 演示用户表（生产环境建议改为 KV/D1 存储，密码哈希保存）
const USERS = {
  admin: { password: 'admin&550859171', role: 'admin' },
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
//   curl / 小程序等不含 Origin 的非浏览器请求直接放行）
function isSameOrigin(request) {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  return origin === new URL(request.url).origin
}

// 只读方法不做 CSRF 校验
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// 公开演示接口：本来就是给任意来源调用的，豁免同源校验
// （若确认这些接口只需要同源/非浏览器调用，删掉这两项即可全局强制）
const CSRF_EXEMPT_PATHS = new Set(['/api/echo',])

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

    // CSRF 统一拦截：所有写请求（非 GET/HEAD/OPTIONS）必须同源，
    // 放在路由分发之前，新增接口自动生效，无需逐个加判断
    if (!SAFE_METHODS.has(request.method) && !CSRF_EXEMPT_PATHS.has(path) && !isSameOrigin(request)) {
      return json({ error: '跨站请求被拒绝' }, 403)
    }

    // 根路径重定向到首页（assets 优先且 not_found_handling = none，/ 不会命中任何静态文件）
    if ((request.method === 'GET' || request.method === 'HEAD') && path === '/') {
      return Response.redirect(new URL(HOME_PAGE, request.url).toString(), 302)
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

    // ---- 头像（详见 src/avatar.js）----
    // 读取公开只读：<img> 无法携带凭证；写操作由上方统一 CSRF 校验兜底
    if (request.method === 'GET' && path === '/api/avatar') {
      return handleAvatarGet(request, env)
    }

    if (request.method === 'POST' && path === '/api/avatar') {
      return handleAvatarUpload(request, env)
    }

    if (request.method === 'DELETE' && path === '/api/avatar') {
      return handleAvatarDelete(request, env)
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

    // 静态资源由 Cloudflare 的 assets 层处理：命中的文件直接返回，不会进到这里
    // （默认 assets 优先，只有 assets 未命中的请求才会进入 Worker）

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
