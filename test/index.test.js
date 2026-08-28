import { describe, it, expect, afterEach, vi } from 'vitest'
import worker from '../src/index.js'
import { generateSlide } from '../src/slide.js'

const ENV = { API_NAME: 'test-worker', JWT_SECRET: 'test-secret' }

function request(path, init, env = ENV) {
  return worker.fetch(new Request(`https://example.com${path}`, init), env)
}

function loginBody(overrides = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123', ...overrides }),
  }
}

// mock siteverify 接口
function stubSiteverify(success) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  ))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API Worker', () => {
  it('GET /api 返回健康状态', async () => {
    const res = await request('/api')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('ok')
  })

  it('GET /api/hello 返回问候', async () => {
    const res = await request('/api/hello?name=CodeBuddy')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.message).toBe('Hello, CodeBuddy!')
  })

  it('GET /api/time 返回时间', async () => {
    const res = await request('/api/time')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.time).toBeTruthy()
  })

  it('POST /api/echo 回显内容', async () => {
    const res = await request('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.received).toEqual({ foo: 'bar' })
  })

  it('POST /api/login 未配置 Turnstile 时跳过验证直接登录', async () => {
    const res = await request('/api/login', loginBody())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.token).toBeTruthy()
    expect(data.user).toEqual({ username: 'admin', role: 'admin' })
  })

  it('POST /api/login 配置 Turnstile 且验证通过时返回 token', async () => {
    stubSiteverify(true)
    const env = { ...ENV, TURNSTILE_SECRET_KEY: 'secret' }
    const res = await request('/api/login', loginBody({ cfTurnstileToken: 'dummy-token' }), env)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.token).toBeTruthy()
  })

  it('POST /api/login Turnstile 验证失败返回 403', async () => {
    stubSiteverify(false)
    const env = { ...ENV, TURNSTILE_SECRET_KEY: 'secret' }
    const res = await request('/api/login', loginBody({ cfTurnstileToken: 'bad-token' }), env)
    expect(res.status).toBe(403)
  })

  it('POST /api/login 配置 Turnstile 但缺少 token 返回 403', async () => {
    const env = { ...ENV, TURNSTILE_SECRET_KEY: 'secret' }
    const res = await request('/api/login', loginBody(), env)
    expect(res.status).toBe(403)
  })

  it('POST /api/login 错误密码返回 401', async () => {
    const res = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('GET /api/me 携带有效 token 返回用户', async () => {
    const login = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'demo123' }),
    })
    const { token } = await login.json()

    const res = await request('/api/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.user).toEqual({ username: 'demo', role: 'user' })
  })

  it('GET /api/me 无 token 返回 401', async () => {
    const res = await request('/api/me')
    expect(res.status).toBe(401)
  })

  it('未知 API 路由返回 404', async () => {
    const res = await request('/api/nothing')
    expect(res.status).toBe(404)
  })
})

describe('滑动验证码 API', () => {
  it('GET /api/slide/generate 返回两张 SVG 图片且不下发缺口坐标', async () => {
    const res = await request('/api/slide/generate')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.token).toBeTruthy()
    expect(data.background).toContain('<svg')
    expect(data.puzzle).toContain('<svg')
    expect(data.puzzleSize).toBe(40)
    expect(data.puzzleY).toBeGreaterThanOrEqual(0)
    // 缺口水平坐标是验证核心，绝不下发
    expect(data.targetX).toBeUndefined()
    expect(data.targetY).toBeUndefined()
  })

  it('拼图块使用背景坐标裁剪 + 内容平移，图案与缺口严格一致', () => {
    const gen = generateSlide()
    // clip 矩形必须用背景坐标系坐标，才能在本地空间抠出缺口区域
    expect(gen.puzzle).toContain(`<rect x="${gen.targetX}" y="${gen.targetY}" width="40" height="40" rx="4"/>`)
    // 裁剪后的内容整体平移到 0~40 画布内
    expect(gen.puzzle).toContain(`transform="translate(${-gen.targetX} ${-gen.targetY})"`)
  })

  it('缺口水平位置集中在中间偏右范围（100~200px）', () => {
    for (let i = 0; i < 50; i++) {
      const gen = generateSlide()
      expect(gen.targetX).toBeGreaterThanOrEqual(100)
      expect(gen.targetX).toBeLessThanOrEqual(200)
    }
  })

  // 生成一段模拟真人轨迹：从 0 平滑逼近 targetX，带 y 抖动与停顿
  function humanTrack(targetX) {
    const track = []
    let t = 0
    for (let i = 0; i < 30; i++) {
      const x = (targetX * i) / 29
      t += i % 7 === 0 ? 120 : 20
      track.push({ x: +x.toFixed(1), y: +(Math.sin(i * 1.3) * 3).toFixed(1), t })
    }
    return { track, duration: t }
  }

  it('POST /api/slide/verify 位置对准 + 正常轨迹通过', async () => {
    // 坐标直接取模块（服务端内部使用），模拟"知道正确位置"的客户端
    const gen = generateSlide()
    const { track, duration } = humanTrack(gen.targetX)
    const res = await request('/api/slide/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gen.token, x: gen.targetX, y: 0, track, duration }),
    })
    const data = await res.json()
    expect(data.success).toBe(true)
  })

  it('POST /api/slide/verify 位置偏差过大被拒', async () => {
    const gen = generateSlide()
    const { track, duration } = humanTrack(gen.targetX)
    const res = await request('/api/slide/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gen.token, x: gen.targetX + 20, y: 0, track, duration }),
    })
    const data = await res.json()
    expect(data.success).toBe(false)
  })

  it('POST /api/slide/verify 轨迹点数过少被拒', async () => {
    const gen = generateSlide()
    const res = await request('/api/slide/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gen.token, x: gen.targetX, y: 0, track: [{ x: 0, y: 0, t: 10 }], duration: 500 }),
    })
    const data = await res.json()
    expect(data.success).toBe(false)
  })

  it('POST /api/slide/verify token 一次性：验证后重复使用被拒', async () => {
    const gen = generateSlide()
    const { track, duration } = humanTrack(gen.targetX)
    const body = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gen.token, x: gen.targetX, y: 0, track, duration }),
    }
    await request('/api/slide/verify', body) // 第一次消费 token
    const second = await request('/api/slide/verify', body) // 第二次必须失败
    const data = await second.json()
    expect(data.success).toBe(false)
  })
})
