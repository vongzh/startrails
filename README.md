# Startrails · 星迹

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="web/public/brand/logo-on-dark.svg">
  <img src="web/public/brand/logo-on-light.svg" alt="Startrails · 星迹" width="224">
</picture>

**一份订阅源，扇出成 19 个客户端各自能吃的订阅地址。** 自托管的常驻服务，不把订阅交给第三方转换。

![控制台概览](docs/screenshots/overview.png)

[![CI](https://github.com/vongzh/startrails/actions/workflows/ci.yml/badge.svg)](https://github.com/vongzh/startrails/actions/workflows/ci.yml)
[![Docker](https://github.com/vongzh/startrails/actions/workflows/docker.yml/badge.svg)](https://github.com/vongzh/startrails/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4f.svg)](LICENSE)

## 它做什么

```
订阅源 ──解析──▶ 强类型 IR ──能力矩阵──▶ 交付层 ──▶ 19 个客户端的订阅地址
```

- **不会悄悄降级**。客户端表达不了的能力分三档：`support` 写出、`unverified` 不写、`reject` 剔除。reality / obfs / plugin 这类「缺了就永远连不上」的特性整条剔除，不拼一份看着对的配置。
- **改动有回归**。`IR × 客户端` 由 19 份 golden 快照逐字锁死，改错立刻变红。
- **数据在自己手里**。源正文在 SQLite 里字段级加密，备份就是一个文件。

## 快速开始

需要 Docker（镜像方式）或 Node ≥ 22.18（源码方式）。

```bash
# 可选：预先生成加密密钥。不生成也行，首次打开 Web UI 时会要求设置。
openssl rand -hex 32
```

```bash
docker run -d --name startrails \
  -p 127.0.0.1:8787:8787 \
  -v startrails-data:/app/data \
  --restart unless-stopped \
  ghcr.io/vongzh/startrails:latest
```

打开 `http://127.0.0.1:8787`，首次进入会要求设定管理令牌与数据加密密钥。想用环境变量预置密钥，在 `docker run` 里加一行 `-e STARTRAILS_TOKEN_SECRET=<上一步的值>`；不预置则密钥落盘到 `data/secret.key`。源码方式：

```bash
npm ci && npm run build:ui
node src/server/index.ts
```

三条要知道的：

1. **`STARTRAILS_TOKEN_SECRET` 可选但长期不变**。它加密源正文；优先级为环境变量 > `STARTRAILS_SECRET_FILE` 指向的文件（默认 `<data>/secret.key`）> 首次进入 UI 设置。已有数据的实例换密钥后旧正文解不开，必须继续用原密钥。
2. **管理令牌两种来源**：环境变量 `STARTRAILS_ADMIN_TOKEN`（优先级高、界面不可改）或首次访问时在界面设定。库里只存 hash。
3. **默认只监听 `127.0.0.1`**。对外请配反向代理；镜像里已默认 `STARTRAILS_HOST=0.0.0.0`，安全边界交给「宿主机发布成哪个地址」。

## 镜像发布

镜像由 GitHub Actions 发布，本地不需要 Docker 环境，配置见 [`.github/workflows/docker.yml`](.github/workflows/docker.yml)。

| 触发 | 结果 |
| --- | --- |
| `git tag v0.1.1 && git push origin v0.1.1` | 先跑完整 verify，再交叉构建 `linux/amd64` + `linux/arm64`，推 `ghcr.io/vongzh/startrails` 的 `0.1.1`、`latest`、`sha-xxxxxxx` |
| Actions → Docker → Run workflow | 同上但不移动 `latest`；勾选 `push` 才真的推送 |

- tag 与 `package.json` 版本不一致直接失败，不会产出半成品镜像。
- 仓库是公开的，GHCR 包默认就是 public，`docker pull` 免登录（实测匿名 token 可列 tags）。只有仓库改成私有、又想让别人能拉时，才需要去 Packages → Package settings 手动改可见性。
- 想同时推 Docker Hub：配 `DOCKERHUB_USERNAME`（Variable）与 `DOCKERHUB_TOKEN`（Secret，Read & write 的 PAT），工作流会自动追加 `docker.io/<账号>/startrails`。
- 用 podman 本地构建要加 `--format docker`：默认 OCI 格式会**静默丢弃 `HEALTHCHECK`**，镜像看着正常但没有健康检查。CI 侧同理，所以工作流显式写了 `oci-mediatypes=false`。

## 部署

两种入口，按需选一个：

```bash
# 用已发布镜像部署（不需要源码与构建环境）
docker compose -f docker-compose.release.yml up -d
```

```bash
# 从本地源码构建
cp .env.example .env      # 可选：预填密钥 / 管理令牌；留空则首次进入 UI 设置
docker compose up -d
```

`docker-compose.release.yml` 里 `TZ` 写的是 `CST-8` 而不是 `Asia/Shanghai`：alpine 基础镜像没有 zoneinfo，写时区名会静默退回 UTC。

反代的关键是这两句；走 TLS 时**必须设** `STARTRAILS_PUBLIC_BASE_URL=https://sub.example.com`，否则二维码与规则集改写里的地址会按请求 Host 拼，容易出错。

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 16m;    # 上传订阅文件
}
```

备份与恢复（本机快照、WebDAV 远端、换机迁移）见 [`docs/BACKUP.md`](docs/BACKUP.md)。服务不自带定时备份，要定时请交给 cron / systemd timer。

<details>
<summary>裸机 systemd</summary>

```bash
sudo useradd -r -s /usr/sbin/nologin startrails
sudo install -d -o startrails -g startrails /opt/startrails /var/lib/startrails
sudo -u startrails git clone https://github.com/vongzh/startrails.git /opt/startrails
cd /opt/startrails && sudo -u startrails npm ci && sudo -u startrails npm run build:ui
sudo -u startrails npm prune --omit=dev    # vite 在 devDependencies 里，构建完再裁
```

```ini
# /etc/systemd/system/startrails.service
[Unit]
Description=Startrails
After=network-online.target

[Service]
User=startrails
WorkingDirectory=/opt/startrails
EnvironmentFile=/etc/startrails.env
ExecStart=/usr/bin/node src/server/index.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/startrails

[Install]
WantedBy=multi-user.target
```

`/etc/startrails.env` 写 `STARTRAILS_DATA_DIR=/var/lib/startrails`、`STARTRAILS_ADMIN_TOKEN=`，权限 `600`；`STARTRAILS_TOKEN_SECRET` 可留空（首次在 UI 设置并落盘到 `<data>/secret.key`），也可在这里预置。

</details>

## 三个概念

```
订阅源（采集）→ 组合订阅（合并 / 过滤 / 去重）→ Profile（发布作用域）
```

- **订阅源**：一个 URL、一个文件或一段粘贴文本，可单独停用。远端源可配刷新策略、拉取代理（解决机场按出口 IP 限区）与 User-Agent（拿对格式）。
- **组合订阅**：多个源合并成可复用单元，成员可配前缀 / 改名模板 / 保留 / 排除 / 上限，或改用**加工链**；去重按 `nodeKey` / `name` / `none`。
- **Profile**：有序引用若干源与组合，顺序即合并顺序，顶栏可切换，每个 Profile 有自己的一组订阅地址。

**加工链**是一串有序算子（`filter` / `rename` / `prefix` / `sort` / `dedupe` / `limit`），顺序即语义——「先改名再去重」和「先去重再改名」是两件事。匹配写法按字面自动判定：`/re/flags` 正则、含 `*` `?` 是 glob、其余按子串；`filter` 的 `useless` 会把「剩余流量 / 到期时间」这类广告伪节点剔掉。删源或删组合时，指向它的引用在**同一个请求**里清理干净；加源时若目标 Profile 构成是空的会自动挂进去，非空只提示「N 个源还没加入构成」并给一键补挂。

## 客户端支持

19 个客户端、7 种方言。新增客户端只需在 `src/core/targets.ts` 加一行，再到 `src/core/capabilities/verified.ts` 登记能力差异与官方依据。

| 方言 | 客户端 | 输出 |
| --- | --- | --- |
| `surge-ini` | Surge、Surge Mac | INI 完整配置 |
| `clash-yaml` | mihomo/Clash、Stash、Clash Verge、ClashMac、FlClash、Clash Party、Clash Mi、Karing | YAML 完整配置 |
| `sing-box-json` | sing-box、Hiddify | JSON outbounds 片段 |
| `loon-ini` | Loon | INI `[Proxy]` 片段 |
| `quanx-ini` | Quantumult X | INI 完整配置 |
| `egern-yaml` | Egern | YAML 单节点片段 |
| `uri-list` | Shadowrocket、V2Box、Anywhere | 节点分享 URI 列表 |

协议覆盖 `vless` / `vmess` / `trojan` / `shadowsocks` / `hysteria2` / `tuic` / `anytls` / `snell`，传输含 `ws` / `grpc` / `h2` / `http`，并建模 TLS、VLESS Reality、SS SIP003 插件、Hysteria2 obfs 与端口跳跃。

判定依据只取**客户端官方文档**，逐条记在「能力」页里可查；没有依据的一律 `unverified` 不写，而不是套用别的客户端的模板。所以 Loon 只输出 `[Proxy]` 片段、Surge 的 VLESS 直接剔除。

同一个订阅有四种拿法：托管地址 `GET /s/<token>[/<profile>/<target>]`（按 UA 自适应，支持 ETag / 304）、二维码 `/qr.svg`、附件下载 `?download=1`、参数化 `/s/<token>?include=HK&exclude=过期&limit=20`。每个响应带 `X-Startrails-Summary: nodes=42 skipped=3 sources=2 stale=1`；`stale=1` 表示这次真的回退了旧快照——上游挂了但客户端照常可用。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `STARTRAILS_TOKEN_SECRET` | 空 | 加密源正文的密钥；环境变量优先，未设置时用 `<data>/secret.key`，都没有则首次 UI 设置。换了密钥后旧数据解不开 |
| `STARTRAILS_SECRET_FILE` | `<data>/secret.key` | UI 设置的密钥落盘位置 |
| `STARTRAILS_ADMIN_TOKEN` | 空 | 管理令牌；留空则首次访问在界面设定并存库 |
| `STARTRAILS_DATA_DIR` | `./data` | 数据目录（库文件 + 规则集缓存 + 可选 `secret.key`） |
| `STARTRAILS_DB_PATH` | `<data>/startrails.db` | 库文件位置 |
| `STARTRAILS_HOST` / `STARTRAILS_PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `STARTRAILS_PUBLIC_BASE_URL` | 空 | 对外基地址，TLS 反代时必设 |
| `STARTRAILS_WEBDAV_URL` / `_USER` / `_PASS` | 空 | 远端备份目标（建议私有目录） |
| `STARTRAILS_TG_BOT_TOKEN` / `_CHAT_ID`、`STARTRAILS_BARK_URL` | 空 | 运维通知渠道 |
| `STARTRAILS_ALLOW_PRIVATE` | `0` | **危险**：放行内网订阅地址，仅本机测试 |
| `STARTRAILS_ALLOW_STATELESS` | `0` | **危险**：开放无状态转换 `GET /sub?url=` |

完整模板见 [`.env.example`](.env.example)。

## 开发

```bash
npm run serve         # 构建前端 + 起服务（http://127.0.0.1:8787）
npm run dev:ui        # 只跑前端 dev server（后端另开 dev:server）
npm test              # 164 个用例
npm run verify        # 提交前跑这个：版本一致 → tsc → 绑定检查 → 构建 → 用例 → 备份演练
```

- `src/core` 零 IO、零 `node:` 依赖，可同构跑在浏览器里；Plan 只做决策、Emit 只做表达、IR 全程只读。
- 能力差异是**数据**（`src/core/capabilities/verified.ts`），不是 `if (target === …)`。
- 每个 `IR × Target` 由 `tests/golden.test.ts` 逐字比对，新增 Target 必须补 golden。
- 界面文案中文，失败态用带 `reason` 的诊断而不是裸报错。

目录：`src/core`（IR / 解析 / 能力 / 交付）、`src/server`（HTTP / 调度 / 备份）、`src/store`（SQLite）、`web/`（Vue 3 控制台）、`tests/`。

## 常见问题

**节点数是 0？** 先看源是否加进了当前 Profile 构成（构成卡会提示「N 个源还没加入构成」），再看源是否被停用，最后看诊断页的 `reason`（`profile-empty` / `source-payload-empty` / `source-unavailable`）。

**客户端拉不到新配置？** 服务端支持 ETag / 304，缓存生效时不会有下载动作。先在发布页点「重新构建」看预览是否变化，再用 `curl -I <订阅地址>` 看 `ETag` 与 `X-Startrails-Summary`。

**某个客户端少节点？** 这是判定结果，不是 bug。去「能力」页看该客户端对这条特性是 `unverified` 还是 `reject`。

**容器起来了但界面打不开？** 多半是卷的属主不是 uid 1000，或 `data/secret.key` 不可写。密钥没设置不会导致启动失败：首次进入 UI 设置即可。

**能多副本吗？** 不能。SQLite WAL 要求所有进程在同一主机。

**忘了管理令牌？** 设环境变量 `STARTRAILS_ADMIN_TOKEN` 覆盖（优先级高于库里的），或从备份恢复。

## 合规与免责

本项目只做格式转换与配置生成，不提供、不代理、不分发任何网络接入服务。请遵守所在地法律法规与所订阅服务的条款。字段映射依据只取各客户端官方文档与公开格式规范。

## 许可证

[MIT](LICENSE) © 2026 vongzh
