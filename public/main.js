const $ = (sel) => document.querySelector(sel)

const token = localStorage.getItem('token')

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, options)
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ---- 登录检查（守卫已提前到 index.html 内联脚本，这里兜底：token 失效/过期时同样跳转） ----
if (!token) {
  location.replace('/login.html')
}

const statusEl = $('#api-status')
const userbox = $('#userbox')
const userInfo = $('#user-info')

// 校验 token 并获取用户信息
try {
  const data = await api('/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  userInfo.textContent = `${data.user.username}（${data.user.role}）`
  userbox.hidden = false
} catch {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  location.replace('/login.html')
}

// ---- 退出登录 ----
$('#btn-logout').addEventListener('click', () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  location.href = '/login.html'
})

// ---- 连接状态 ----
try {
  const info = await api('')
  statusEl.textContent = `已连接：${info.name}`
  statusEl.classList.add('ok')
} catch {
  statusEl.textContent = '连接失败，请刷新重试'
  statusEl.classList.add('error')
}

// ---- 打招呼 ----
$('#btn-hello').addEventListener('click', async () => {
  const name = $('#name-input').value.trim() || 'World'
  const data = await api(`/hello?name=${encodeURIComponent(name)}`)
  $('#output-hello').textContent = data.message
})

// ---- 服务器时间 ----
$('#btn-time').addEventListener('click', async () => {
  const data = await api('/time')
  const local = new Date(data.time).toLocaleString()
  $('#output-time').textContent = `${local}（地区：${data.country}）`
})

// ---- 数据回显 ----
$('#btn-echo').addEventListener('click', async () => {
  const payload = {
    message: $('#echo-input').value,
    clientTs: Date.now(),
  }
  const data = await api('/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  $('#output-echo').textContent = JSON.stringify(data.received, null, 2)
})
