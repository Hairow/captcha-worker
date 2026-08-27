# captcha-worker

Cloudflare Worker 项目：**前端静态资源 + 后端 API 一体化**。前端文件放在 `public/`，由 Worker 通过 Workers Static Assets 直接托管，无需单独部署。

## 项目结构

```
captcha-worker/
├── src/index.js         # API 路由（原生 Worker fetch）
├── src/token.js         # HMAC token 签名与校验
├── src/turnstile.js     # Cloudflare Turnstile 服务端校验
├── wrangler.toml        # Worker 配置（含 assets 静态资源托管）
├── public/              # 前端静态资源（无需构建，直接部署）
│   ├── index.html       # 首页（需登录）
│   ├── login.html       # 登录页
│   ├── login.js
│   ├── main.js
│   └── style.css
├── test/                # Vitest 单元测试
├── package.json
└── README.md
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动（前后端一体，http://localhost:8787）
npm run dev
```

浏览器打开 http://localhost:8787 会自动跳转到登录页，使用演示账号登录（见下）。

## 登录

| 账号  | 密码     | 角色  |
| ----- | -------- | ----- |
| admin | admin123 | admin |
| demo  | demo123  | user  |

- 登录页集成 **Cloudflare Turnstile** 人机验证，验证通过后才允许登录。
- 登录成功返回 HMAC 签名的 token（有效期 1 小时），前端存于 `localStorage`。
- 可通过环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 覆盖管理员账号；
  token 签名密钥通过 `JWT_SECRET` 设置（生产环境用 `wrangler secret put JWT_SECRET`）。

## Turnstile 配置

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com) → Turnstile 创建站点，获取 Site Key 与 Secret Key。
2. 将 Site Key 填入 `public/login.html` 的 meta 标签（site key 是公开信息，可直接写在 HTML 中）：
   ```html
   <meta name="turnstile-site-key" content="你的-Site-Key" />
   ```
3. **本地开发**：在 `.dev.vars` 中配置 Secret Key（文件已被 .gitignore 忽略，不会提交）：
   ```
   TURNSTILE_SECRET_KEY = "你的-Secret-Key"
   ```
4. **生产环境**：用 `wrangler secret put TURNSTILE_SECRET_KEY` 设置 Secret Key（服务端校验用）。
5. 可选：`TURNSTILE_HOSTNAMES` 设置 hostname 白名单（逗号分隔），防止 token 被跨站使用。

> Site Key 留空时登录页不显示验证码（本地开发/演示模式）；
> 服务端未配置 Secret Key 时跳过校验，配置后强制调用 siteverify 校验，
> token 5 分钟有效且单次使用（自带防重放）。

> `.dev.vars` 中还可配置 `JWT_SECRET`、`ADMIN_USERNAME`、`ADMIN_PASSWORD` 等本地开发变量；
> 敏感变量不要写在 `wrangler.toml`（会被提交），统一放 `.dev.vars`（本地）/ `wrangler secret put`（生产）。

## API 接口

| 方法 | 路径        | 说明                         |
| ---- | ----------- | ---------------------------- |
| GET  | `/api`      | 健康检查                     |
| POST | `/api/login` | 登录，返回 token（`{ username, password, cfTurnstileToken }`）|
| GET  | `/api/me`   | 当前用户信息（需 `Authorization: Bearer <token>`）|
| GET  | `/api/hello?name=x` | 返回问候语            |
| GET  | `/api/time` | 返回服务器时间与访问地区     |
| POST | `/api/echo` | 回显请求体（JSON）           |

> 其他路径（如 `/`、`/login.html`）由静态资源自动托管；SPA 模式下未匹配路径回退到 `index.html`。

## 测试

```bash
npm run test
```

## 部署

```bash
npm run deploy
```

一条命令即可将前端 + API 部署到 Cloudflare Workers，访问 `https://<worker>.workers.dev` 即可。

## 扩展

- 添加 API 路由：在 `src/index.js` 的 `fetch` 中新增 `path` 判断分支。
- 添加静态文件：直接放入 `public/` 目录。
- 绑定 KV / D1：在 `wrangler.toml` 中按注释示例配置。
