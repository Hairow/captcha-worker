import { describe, it, expect, afterEach, vi } from 'vitest'
import worker from '../src/index.js'

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
