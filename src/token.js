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
