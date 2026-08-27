// Cloudflare Turnstile 服务端校验
// 文档：https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

/**
 * 校验 Turnstile token。
 * - 未配置 TURNSTILE_SECRET_KEY 时跳过校验（本地开发/演示模式）
 * - 校验通过返回 { success: true }；失败返回 { success: false, error }
 */
export async function verifyTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return { success: true, skipped: true }
  }
  if (!token) {
    return { success: false, error: 'missing-turnstile-token' }
  }

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  })
  // 传入访客 IP，增强验证准确性
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip) body.set('remoteip', ip)

  let res
  try {
    res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch {
    return { success: false, error: 'verify-service-error' }
  }

  const data = await res.json().catch(() => null)
  if (!data) return { success: false, error: 'verify-service-error' }

  // 可选：hostname 白名单（逗号分隔），防止 token 被跨站使用
  const allowed = (env.TURNSTILE_HOSTNAMES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (allowed.length && data.hostname && !allowed.includes(data.hostname)) {
    return { success: false, error: 'hostname-mismatch', errorCodes: ['hostname-mismatch'] }
  }

  return { success: !!data.success, errorCodes: data['error-codes'] ?? [] }
}
