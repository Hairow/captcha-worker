/**
 * login.js —— 登录页逻辑
 *
 * 流程：读取 Turnstile Site Key（HTML meta）→ 静默后台验证（不可见模式）→
 *       提交账号密码 + 验证 token 到 /api/login → 成功存 token 跳转首页。
 *
 * 关键约定：
 *  - Turnstile 官方脚本在 login.html 中以 <script> 静态引入（render=explicit）。
 *  - 固定不可见模式（execution: 'execute'），需与 Turnstile 后台
 *    「小组件模式」设置为 Invisible 保持一致。
 *  - Site Key 是公开信息写在 HTML meta；Secret Key 在服务端（.dev.vars）。
 */

const $ = (sel) => document.querySelector(sel)

// ---- DOM 元素引用 ----
const form = $('#login-form') // 登录表单
const errorEl = $('#login-error') // 错误提示条
const btn = $('#btn-login') // 提交按钮
const turnstileEl = $('#turnstile-container') // Turnstile 渲染容器

// 当前 Turnstile 验证 token；null 表示尚未完成验证（提交时会被拦截/重新触发）
let turnstileToken = null

// ---- 登录态检查 ----
// 本地已有 token 则直接回首页，避免重复登录
if (localStorage.getItem('token')) {
  location.href = '/'
}

// ---- 初始化 Turnstile ----
// 等待官方脚本加载完成（脚本 async defer，加载完成时间不确定，用轮询等待）
function ensureTurnstile(cb, timeout = 10000) {
  const start = Date.now()
  const timer = setInterval(() => {
    if (window.turnstile) {
      // 库已就绪，执行回调
      clearInterval(timer)
      cb()
    } else if (Date.now() - start > timeout) {
      // 超时未加载（如网络被墙），静默放弃，登录仍可提交（服务端会兜底校验）
      clearInterval(timer)
    }
  }, 50)
}

function initTurnstile() {
  // site key 直接读 HTML 中的 meta 标签（公开信息）
  const siteKey = document.querySelector('meta[name="turnstile-site-key"]')?.content
  if (!siteKey) return // 未配置则跳过（演示模式）

  ensureTurnstile(() => {
    // 显式渲染到容器；execution: 'execute' = 不可见模式，不显示勾选框
    window.turnstile.render(turnstileEl, {
      sitekey: siteKey,
      execution: 'execute',
      // 验证通过：拿到一次性 token，随表单提交给服务端 siteverify
      callback: (token) => {
        turnstileToken = token
        errorEl.hidden = true
        console.log('[Turnstile] 人机验证通过', { token, at: new Date().toISOString() })
      },
      // token 过期（约 5 分钟）：清空，提交时会重新触发验证
      'expired-callback': () => {
        turnstileToken = null
      },
      // 验证出错：清空 token
      'error-callback': () => {
        turnstileToken = null
      },
    })
    // 页面加载即自动发起静默验证（不可见模式）
    window.turnstile.execute(turnstileEl)
  })
}

initTurnstile()

// 等待 token 产生（不可见模式下验证是异步的），带超时避免一直卡住
function requestTurnstileToken(timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (turnstileToken) {
        clearInterval(timer)
        resolve(turnstileToken)
      } else if (Date.now() - start > timeout) {
        clearInterval(timer)
        reject(new Error('人机验证超时，请重试'))
      }
    }, 100)
  })
}

// ---- 登录提交 ----
form.addEventListener('submit', async (e) => {
  e.preventDefault() // 阻止原生表单提交，走 fetch

  // 读取并校验输入
  const username = $('#username').value.trim()
  const password = $('#password').value

  if (!username || !password) {
    errorEl.textContent = '请输入用户名和密码'
    errorEl.hidden = false
    return
  }

  // 提交前确保已拿到 Turnstile token；没有则触发一次静默验证并等待结果
  if (!turnstileToken && window.turnstile) {
    window.turnstile.execute(turnstileEl)
    try {
      turnstileToken = await requestTurnstileToken()
    } catch (err) {
      errorEl.textContent = err.message
      errorEl.hidden = false
      return
    }
  }

  // 提交中 UI 状态
  btn.disabled = true
  btn.textContent = '登录中…'
  errorEl.hidden = true

  try {
    // 发送登录请求（含 Turnstile token）
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, cfTurnstileToken: turnstileToken }),
    })
    const data = await res.json()

    if (!res.ok) {
      // 验证码过期或失效（403），重置 widget 并重新触发静默验证
      if (res.status === 403 && window.turnstile) {
        window.turnstile.reset()
        turnstileToken = null
        window.turnstile.execute(turnstileEl)
      }
      // 附带 Turnstile 具体错误码（如 invalid-input-response），方便排查
      const codes = data.errorCodes?.length ? `（${data.errorCodes.join(', ')}）` : ''
      throw new Error(`${data.error ?? '登录失败'}${codes}`)
    }

    // 登录成功：持久化 token 与用户信息，跳回首页
    localStorage.setItem('token', data.token)
    localStorage.setItem('user', JSON.stringify(data.user))
    location.href = '/'
  } catch (err) {
    // 显示错误信息
    errorEl.textContent = err.message
    errorEl.hidden = false
  } finally {
    // 恢复按钮状态
    btn.disabled = false
    btn.textContent = '登 录'
  }
})
