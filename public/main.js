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

// ---- 头像（R2 存储）----
const avatarBtn = $('#avatar-btn')
const avatarImg = $('#avatar-img')
const avatarFallback = $('#avatar-fallback')
const avatarMask = $('#avatar-mask')
const avatarInput = $('#avatar-input')
const avatarTip = $('#avatar-tip')
const avatarRemove = $('#btn-avatar-remove')
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
let uploading = false

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra }
}

// 遮罩层：仅在「未上传」与「上传中」时出现，有头像时必须隐藏，否则会盖住图片
function setMask(text) {
  if (!text) {
    avatarMask.hidden = true
    return
  }
  avatarMask.textContent = text
  avatarMask.hidden = false
}

// 显示头像；无头像时显示用户名首字符 + 「请上传头像」提示
function showAvatar(url) {
  if (url) {
    avatarImg.src = url
    avatarImg.hidden = false
    avatarFallback.hidden = true
    avatarRemove.hidden = false
    setMask(null)
  } else {
    avatarImg.removeAttribute('src')
    avatarImg.hidden = true
    avatarFallback.hidden = false
    avatarRemove.hidden = true
    setMask('请上传头像')
  }
}

function showTip(text, isError = true) {
  avatarTip.textContent = text ?? ''
  avatarTip.classList.toggle('error', Boolean(text) && isError)
  avatarTip.classList.toggle('ok', Boolean(text) && !isError)
}

avatarImg.addEventListener('error', () => {
  showAvatar(null)
})

avatarInput.addEventListener('change', async () => {
  const file = avatarInput.files?.[0]
  avatarInput.value = '' // 允许重复选择同一文件
  if (!file || uploading) return

  if (!file.type.startsWith('image/')) {
    showTip('请选择图片文件')
    return
  }
  if (file.size > AVATAR_MAX_BYTES) {
    showTip('图片不能超过 2MB')
    return
  }

  uploading = true
  setMask('上传中…')
  showTip('')
  try {
    const form = new FormData()
    form.append('file', file)
    const data = await api('/avatar', {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
    showAvatar(data.avatarUrl)
    saveUser({ avatarUrl: data.avatarUrl })
    showTip('头像已更新', false)
  } catch (err) {
    showTip(err.message)
  } finally {
    setMask(avatarImg.hidden ? '请上传头像' : null)
    uploading = false
  }
})

avatarRemove.addEventListener('click', async () => {
  if (uploading) return
  uploading = true
  try {
    await api('/avatar', { method: 'DELETE', headers: authHeaders() })
    showAvatar(null)
    saveUser({ avatarUrl: null })
    showTip('头像已移除', false)
  } catch (err) {
    showTip(err.message)
  } finally {
    uploading = false
  }
})

// 渲染用户信息（用户名 / 角色 / 头像）
function renderUser(user) {
  userInfo.textContent = `${user.username}（${user.role}）`
  avatarFallback.textContent = user.username.slice(0, 1).toUpperCase()
  showAvatar(user.avatarUrl)
}

// 同步更新本地缓存的用户信息，使「个人信息」里的头像与服务端一致
function saveUser(patch) {
  const cached = JSON.parse(localStorage.getItem('user') ?? 'null')
  if (cached) localStorage.setItem('user', JSON.stringify({ ...cached, ...patch }))
}

// 登录时已缓存用户信息（含头像），先立即渲染，避免头像区等待 /api/me
const cachedUser = JSON.parse(localStorage.getItem('user') ?? 'null')
if (cachedUser?.username) {
  renderUser(cachedUser)
  userbox.hidden = false
}

// 校验 token 并获取最新用户信息（含头像地址）
try {
  const data = await api('/me', {
    headers: authHeaders(),
  })
  renderUser(data.user)
  localStorage.setItem('user', JSON.stringify(data.user))
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
