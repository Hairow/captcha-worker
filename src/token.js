function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

function secret(env) {
  return new TextEncoder().encode(env.JWT_SECRET ?? 'dev-secret')
}

// 从 Authorization: Bearer xxx 解析 token
export function bearerToken(request) {
  const auth = request.headers.get('Authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : null
}

// 登录态 Cookie 名（读写共用，避免两处硬编码不一致）
export const AUTH_COOKIE = 'Authorization'

// 从 Cookie 解析 token（HttpOnly，JS 读不到，只能由浏览器自动携带）
function cookieToken(request) {
  const cookie = request.headers.get('Cookie') ?? ''
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() !== AUTH_COOKIE) continue
    try {
      return decodeURIComponent(part.slice(idx + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

// 读取请求携带的 token：优先 Authorization（便于 curl / 非浏览器客户端），
// 回退到 HttpOnly Cookie（浏览器前端走这条）
export function readToken(request) {
  return bearerToken(request) ?? cookieToken(request)
}

// 生成 Set-Cookie 值；localhost 等 http 环境下不带 Secure，否则浏览器不会保存
export function authCookie(token, { maxAge = 3600, secure = true } = {}) {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

// 清除登录 Cookie（同名 + 立即过期）
export function clearAuthCookie({ secure = true } = {}) {
  return authCookie('', { maxAge: 0, secure })
}

// 用 HMAC-SHA256 签名生成无状态 token：payload.signature
export async function signToken(env, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    secret(env),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const sig = await crypto.subtle.sign('HMAC', key, data)
  return `${base64url(data)}.${base64url(sig)}`
}

// 校验 token，返回 payload；无效或过期返回 null
export async function verifyToken(env, token) {
  if (!token) return null
  const [payloadB64, sigB64] = token.split('.')
  if (!payloadB64 || !sigB64) return null
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      secret(env),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecode(sigB64),
      new TextEncoder().encode(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    )
    if (!valid) return null
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
