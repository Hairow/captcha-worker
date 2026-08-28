// 滑动验证码服务端逻辑（PNG 图片版）
// - generateSlide：随机生成拼图缺口位置，用 resvg 把 SVG 渲染成 PNG（背景图 + 拼图块）。
//   前端只拿到图片与一次性 uuid，拿不到缺口坐标（坐标只保存在服务端用于校验）。
// - verifySlide：校验 uuid、滑块终点位置与拖动轨迹（行为评分全部在服务端判定）。
//
// 为什么输出 PNG 而不是 SVG：SVG 是文本格式，缺口坐标 targetX/targetY 必然以明文
// 出现在 SVG 文档里（遮罩 rect、clipPath、translate），前端解码 data URL 即可提取，
// 等于把缺口位置直接交给了客户端。渲染成 PNG 后坐标被"烤"进像素，无法再提取。
// 实现：Workers 无 canvas，使用 @resvg/resvg-wasm（Rust resvg 的纯 WASM 构建）。
//
// 存储说明：uuid 与缺口位置绑定存放在 KV（5 分钟 TTL，一次性消费）。
// KV 天然跨实例共享、按 TTL 自动过期，生产多实例部署无需额外处理。
// 本地 wrangler dev 自动使用本地 KV 模拟；单元测试传入内存 mock 即可。

import { initWasm, Resvg } from '@resvg/resvg-wasm'
// ESM Worker 不能用 wasm_modules 绑定（仅 service-worker 格式支持），
// 必须静态 import .wasm：wrangler 构建时把文件编译成 WebAssembly.Module 作为默认导出。
// vitest 通过 vitest.config.js 的自定义插件做相同转换，测试与运行时行为一致。
import wasmModule from './resvg_bg.wasm'

let resvgReady
function ensureResvg() {
  resvgReady ??= initWasm(wasmModule)
  return resvgReady
}

// 把 PNG 字节转成 base64 data URL（分块避免 String.fromCharCode 参数过多爆栈）
function pngToDataUrl(png) {
  let bin = ''
  for (let i = 0; i < png.length; i += 0x8000) {
    bin += String.fromCharCode(...png.subarray(i, i + 0x8000))
  }
  return 'data:image/png;base64,' + btoa(bin)
}

// 渲染 SVG 字符串为 PNG（透明背景，拼图块外部透明）
async function renderPng(svg) {
  await ensureResvg()
  const resvg = new Resvg(svg, { background: 'rgba(0,0,0,0)' })
  return pngToDataUrl(resvg.render().asPng())
}

const PUZZLE_SIZE = 40 // 拼图块尺寸（与前端保持一致）
const BG_W = 300 // 画布宽
const BG_H = 150 // 画布高
const TTL_MS = 5 * 60 * 1000 // uuid 有效期
const TTL_S = TTL_MS / 1000 // KV expirationTtl（秒）
const TOLERANCE = 5 // 滑块终点允许的偏差（px）
const PASS_SCORE = 60 // 通过分数线

const fmt = (n) => +n.toFixed(1)

// 加密级随机 uuid（UUID v4，标准 8-4-4-4-12 格式）
function randomUuid() {
  return crypto.randomUUID()
}

// 生成一组随机的背景形状（背景图与拼图块共用，保证拼图内容与背景缺口区域一致）
function buildShapes() {
  const shapes = []
  const hue1 = Math.floor(Math.random() * 360)
  const hue2 = (hue1 + 40 + Math.floor(Math.random() * 80)) % 360

  for (let i = 0; i < 50; i++) {
    shapes.push(
      `<circle cx="${fmt(Math.random() * BG_W)}" cy="${fmt(Math.random() * BG_H)}" r="${fmt(4 + Math.random() * 12)}" fill="hsla(${Math.floor(Math.random() * 360)},70%,85%,${(0.15 + Math.random() * 0.25).toFixed(2)})"/>`
    )
  }
  for (let i = 0; i < 14; i++) {
    shapes.push(
      `<path d="M${fmt(Math.random() * BG_W)} ${fmt(Math.random() * BG_H)}L${fmt(Math.random() * BG_W)} ${fmt(Math.random() * BG_H)}" stroke="rgba(255,255,255,${(0.1 + Math.random() * 0.2).toFixed(2)})" stroke-width="${fmt(1 + Math.random() * 2)}"/>`
    )
  }
  return { shapes, hue1, hue2 }
}

// 背景图：渐变底色 + 随机形状，缺口处画半透明圆角遮罩（视觉上的"洞"）
function buildBackground(parts, targetX, targetY) {
  const { shapes, hue1, hue2 } = parts
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BG_W}" height="${BG_H}" viewBox="0 0 ${BG_W} ${BG_H}">
  <defs>
    <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue1},62%,72%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},55%,58%)"/>
    </linearGradient>
  </defs>
  <rect width="${BG_W}" height="${BG_H}" fill="url(#bg-grad)"/>
  ${shapes.join('\n  ')}
  <rect x="${fmt(targetX)}" y="${fmt(targetY)}" width="${PUZZLE_SIZE}" height="${PUZZLE_SIZE}" rx="4" fill="rgba(0,0,0,0.5)"/>
</svg>`
}

// 拼图块：clipPath 抠出背景上缺口区域的形状，得到与背景严格一致的拼图内容
// 坐标系统说明（SVG 渲染顺序：先在本地坐标系裁剪内容，再应用 transform）：
// - clip 矩形必须用背景坐标系坐标 (targetX, targetY)，在本地空间正确抠出缺口区域；
// - 再用 transform 把整块内容平移到 0~PUZZLE_SIZE 画布内。
// 若把 clip 直接写成本地坐标 (0,0)，clip 会在 transform 之前裁剪背景左上角，图案与缺口对不上。
function buildPuzzle(parts, targetX, targetY) {
  const { shapes, hue1, hue2 } = parts
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PUZZLE_SIZE}" height="${PUZZLE_SIZE}" viewBox="0 0 ${PUZZLE_SIZE} ${PUZZLE_SIZE}">
  <defs>
    <linearGradient id="pz-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue1},62%,72%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},55%,58%)"/>
    </linearGradient>
    <clipPath id="pz-clip">
      <rect x="${fmt(targetX)}" y="${fmt(targetY)}" width="${PUZZLE_SIZE}" height="${PUZZLE_SIZE}" rx="4"/>
    </clipPath>
  </defs>
  <g clip-path="url(#pz-clip)" transform="translate(${-targetX} ${-targetY})">
    <rect width="${BG_W}" height="${BG_H}" fill="url(#pz-grad)"/>
    ${shapes.join('\n    ')}
  </g>
</svg>`
}

export async function generateSlide(env) {
  // 缺口位置：水平方向集中在中间偏右区域（100~200px，画布宽 300），
  // 垂直方向随机并留出安全边距
  const targetX = Math.floor(Math.random() * 101) + 100
  const targetY = Math.floor(Math.random() * (BG_H - PUZZLE_SIZE - 20)) + 10
  const uuid = randomUuid()

  const parts = buildShapes()
  // uuid -> 缺口坐标写入 KV，TTL 到期由 KV 自动清理，无需手动扫过期
  await env.SLIDE_KV.put(
    uuid,
    JSON.stringify({ targetX, targetY, exp: Date.now() + TTL_MS }),
    { expirationTtl: TTL_S }
  )

  // 并行渲染两张 PNG（渲染在内存中完成，SVG 字符串不落盘也不下发）
  const [background, puzzle] = await Promise.all([
    renderPng(buildBackground(parts, targetX, targetY)),
    renderPng(buildPuzzle(parts, targetX, targetY)),
  ])

  return {
    uuid,
    targetX, // 仅供服务端校验使用，路由层不会下发给客户端
    targetY,
    background,
    puzzle,
    width: BG_W,
    height: BG_H,
    puzzleSize: PUZZLE_SIZE,
    expiresIn: TTL_MS,
  }
}

export async function verifySlide(body, env) {
  const { uuid, x, y, track, duration } = body ?? {}

  // ---- 1. uuid 校验（一次性 + 未过期） ----
  if (!uuid) {
    return { success: false, message: '验证码已失效，请重试' }
  }
  const raw = await env.SLIDE_KV.get(uuid)
  if (!raw) {
    return { success: false, message: '验证码已失效，请重试' }
  }
  await env.SLIDE_KV.delete(uuid) // 一次性：无论成败都消费掉，防重放
  let rec
  try {
    rec = JSON.parse(raw)
  } catch {
    return { success: false, message: '验证码已失效，请重试' }
  }
  if (rec.exp < Date.now()) {
    return { success: false, message: '验证码已过期，请重试' }
  }

  // ---- 2. 位置校验（位置为王：容差 5px，不向客户端暴露偏差值） ----
  const diff = Math.abs((x ?? 0) - rec.targetX)
  if (diff > TOLERANCE) {
    return { success: false, message: '滑块位置未对准，请重试' }
  }

  // ---- 3. 硬性拦截（绝对规则，大概率是脚本） ----
  if (!Array.isArray(track) || track.length < 10) {
    return { success: false, message: '轨迹点数太少，疑似脚本注入' }
  }
  if (duration < 300) {
    return { success: false, message: '拖动时间极短，疑似直接注入坐标' }
  }
  if (duration > 10000) {
    return { success: false, message: '验证码超时' }
  }
  // 轨迹应从滑块起点附近开始（防"只提交终点坐标"）
  if (Math.abs(track[0].x) > 10) {
    return { success: false, message: '轨迹起点异常，请从滑块处开始拖动' }
  }

  // ---- 4. 行为评分（低误杀策略：位置命中给基础分，特征有则加分、无则给基础分） ----
  let score = 40

  // 4.1 Y 轴抖动
  const ys = track.map((p) => p.y ?? 0)
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length
  const yStdDev = Math.sqrt(ys.reduce((s, v) => s + (v - meanY) ** 2, 0) / ys.length)
  score += yStdDev > 1.5 ? 10 : 5

  // 4.2 速度波动
  const velocities = []
  for (let i = 1; i < track.length; i++) {
    const dt = track[i].t - track[i - 1].t
    const dx = track[i].x - track[i - 1].x
    if (dt > 0) velocities.push(Math.abs(dx / dt))
  }
  const meanV = velocities.length ? velocities.reduce((a, b) => a + b, 0) / velocities.length : 0
  const vStdDev = velocities.length
    ? Math.sqrt(velocities.reduce((s, v) => s + (v - meanV) ** 2, 0) / velocities.length)
    : 0
  score += vStdDev > 2 ? 10 : 5

  // 4.3 终点微调（最后几个采样点几乎不动，符合真人松手前微调习惯）
  const xs = track.map((p) => p.x)
  const last5 = xs.slice(-5)
  const diffLast5 = last5[last5.length - 1] - last5[0]
  if (Math.abs(diffLast5) < 5) score += 10

  // 4.4 停顿（真人拖动中常伴随 100ms 以上停顿）
  let pauses = 0
  for (let i = 1; i < track.length; i++) {
    if (track[i].t - track[i - 1].t > 100) pauses++
  }
  score += pauses >= 2 ? 10 : 5

  // 4.5 合理耗时区间
  score += duration >= 500 && duration <= 5000 ? 10 : 5

  // 4.6 防高级机器人：极度平稳的匀速直线（无抖、无波动、无停顿、无微调）
  if (yStdDev < 0.1 && vStdDev < 0.1 && pauses === 0 && Math.abs(diffLast5) < 2) {
    score -= 30
  }

  const pass = score >= PASS_SCORE
  return {
    success: pass,
    score,
    message: pass ? '验证成功' : `行为轨迹评分过低（${score}/${PASS_SCORE}）`,
  }
}
