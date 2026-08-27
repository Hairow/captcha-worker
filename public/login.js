const $ = (sel) => document.querySelector(sel)

const form = $('#login-form')
const errorEl = $('#login-error')
const btn = $('#btn-login')
const turnstileEl = $('#turnstile-container')

let turnstileToken = null

// 已登录则直接回首页
if (localStorage.getItem('token')) {
  location.href = '/'
}

// ---- 初始化 Turnstile ----
// site key 直接读 HTML 中的 meta 标签（公开信息）
function initTurnstile() {
  const siteKey = document.querySelector('meta[name="turnstile-site-key"]')?.content
  if (!siteKey) return // 未配置则跳过（演示模式）

  const script = document.createElement('script')
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
  script.async = true
  script.onload = () => {
    if (!window.turnstile) return
    window.turnstile.render(turnstileEl, {
      sitekey: siteKey,
      callback: (token) => {
        turnstileToken = token
        errorEl.hidden = true
      },
      'expired-callback': () => {
        turnstileToken = null
      },
      'error-callback': () => {
        turnstileToken = null
      },
    })
  }
  document.head.appendChild(script)
}

initTurnstile()

form.addEventListener('submit', async (e) => {
  e.preventDefault()

  const username = $('#username').value.trim()
  const password = $('#password').value

  if (!username || !password) {
    errorEl.textContent = '请输入用户名和密码'
    errorEl.hidden = false
    return
  }

  // 渲染了验证码但未完成时拦截
  if (turnstileEl.innerHTML && !turnstileToken) {
    errorEl.textContent = '请先完成人机验证'
    errorEl.hidden = false
    return
  }

  btn.disabled = true
  btn.textContent = '登录中…'
  errorEl.hidden = true

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, cfTurnstileToken: turnstileToken }),
    })
    const data = await res.json()

    if (!res.ok) {
      // 验证码过期或失效，重置 widget 让用户重新验证
      if (res.status === 403 && window.turnstile) {
        window.turnstile.reset()
        turnstileToken = null
      }
      throw new Error(data.error ?? '登录失败')
    }

    localStorage.setItem('token', data.token)
    localStorage.setItem('user', JSON.stringify(data.user))
    location.href = '/'
  } catch (err) {
    errorEl.textContent = err.message
    errorEl.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = '登 录'
  }
})
