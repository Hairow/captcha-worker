/**
 * login.js —— 登录页逻辑
 *
 * 流程：读取 Turnstile Site Key（HTML meta）→ turnstile.render() 渲染 →
 *       渲染后立即 execute() 自动执行验证 → callback 拿到 token → 提交
 *       账号密码 + token 到 /api/login → 成功存 token 跳转首页。
 *
 * 关键约定：
 *  - 统一采用 execution: 'execute' + 自动 execute() 的自适应写法，
 *    兼容后台「小组件模式」的三种设置：
 *      托管（Managed）         → execute() 触发验证，低风险静默通过，高风险弹交互挑战
 *      非交互式（Non-interactive）→ 角落 spinner 自动验证，高风险弹交互挑战
 *      不可见（Invisible）     → 完全隐形验证（Invisible 必须显式 execute() 才会执行）
 *    即：由 Cloudflare 根据流量风险决定验证强度，前端无需感知具体形态。
 *  - Turnstile 官方脚本在 login.html 中以 <script> 静态引入（?render=explicit，
 *    显式模式：禁用自动渲染，渲染时机与参数完全由本文件控制）。
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

// 等待 token 生成（execute() 后异步完成），timeout 毫秒内未生成返回 false
function waitForToken(timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (turnstileToken) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start > timeout) {
        clearInterval(timer)
        resolve(false)
      }
    }, 100)
  })
}

function initTurnstile() {
  // site key 直接读 HTML 中的 meta 标签（公开信息）
  const siteKey = document.querySelector('meta[name="turnstile-site-key"]')?.content
  if (!siteKey) return // 未配置则跳过（演示模式）

  ensureTurnstile(() => {
    // 自适应模式：execution: 'execute' 不渲染交互勾选框，渲染后立即手动
    // execute() 触发验证（Invisible 模式必须显式 execute() 才会执行）
    window.turnstile.render(turnstileEl, {
      sitekey: siteKey,
      execution: 'execute',
      // 验证通过：拿到一次性 token，随表单提交给服务端 siteverify
      callback: (token) => {
        turnstileToken = token
        errorEl.hidden = true
        console.log('[Turnstile] 人机验证通过', { token, at: new Date().toISOString() })
      },
      // token 过期（约 5 分钟）：清空，提交时会提示用户重新验证
      'expired-callback': () => {
        turnstileToken = null
      },
      // 验证出错：清空 token
      'error-callback': () => {
        turnstileToken = null
      },
    })
    // 渲染后立即自动执行验证（token 异步产生，低风险 1~2 秒内完成）
    window.turnstile.execute(turnstileEl)
  })
}

initTurnstile()

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

  // 提交前校验 Turnstile：自适应模式下验证在后台自动进行，
  // token 未就绪时重新触发 execute() 并等待其完成
  if (!turnstileToken) {
    if (window.turnstile) {
      try {
        window.turnstile.execute(turnstileEl)
      } catch { /* widget 可能仍在初始化，忽略 */ }
      const ok = await waitForToken()
      if (!ok) {
        errorEl.textContent = '人机验证未完成，请稍后重试'
        errorEl.hidden = false
        return
      }
    } else {
      // 官方脚本加载超时（ensureTurnstile 静默放弃）：提示网络问题
      errorEl.textContent = '人机验证服务加载失败，请刷新页面重试'
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
      // 验证码过期或失效（403），重置并自动重新验证（自适应模式无需用户操作）
      if (res.status === 403 && window.turnstile) {
        window.turnstile.reset(turnstileEl)
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
