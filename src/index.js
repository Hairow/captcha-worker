import { signToken, verifyToken, bearerToken } from './token.js'
import { verifyTurnstile } from './turnstile.js'
import { generateSlide, verifySlide } from './slide.js'

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const TOKEN_TTL_MS = 60 * 60 * 1000 // token 有效期 1 小时

// 演示用户表（生产环境建议改为 KV/D1 存储，密码哈希保存）
const USERS = {
  admin: { password: 'admin123', role: 'admin' },
  demo: { password: 'demo123', role: 'user' },
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: API_HEADERS,
  })
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
      return json({
        token: await signToken(env, payload),
        user: { username, role: user.role },
        expiresAt: new Date(payload.exp).toISOString(),
      })
    }

    // 当前用户信息：GET /api/me（需 Bearer token）
    if (request.method === 'GET' && path === '/api/me') {
      const payload = await verifyToken(env, bearerToken(request))
      if (!payload) {
        return json({ error: '未登录或 token 已过期' }, 401)
      }
      return json({ user: { username: payload.username, role: payload.role } })
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

    // 滑动验证码：生成两张 SVG 图片 + 一次性 token（GET）
    if (request.method === 'GET' && path === '/api/slide/generate') {
      const data = generateSlide()
      // 缺口水平坐标（targetX）是验证核心，绝不下发给客户端；
      // puzzleY 仅用于前端把拼图块放到与缺口相同的垂直位置（不参与验证）
      return json({
        token: data.token,
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
      return json(verifySlide(body))
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
        hint: 'Available routes: /api, /api/login, /api/me, /api/hello, /api/time, /api/echo, /api/slide/generate, /api/slide/verify',
      },
      404
    )
  },
}
