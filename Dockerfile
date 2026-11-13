# 两阶段构建：UI 在阶段一编译，运行镜像只装 3 个运行时依赖（better-sqlite3 / yaml / zod）。
# vite、vue、naive-ui、echarts、lucide 只在阶段一存在，不进运行镜像。

# ---------- 阶段一：构建 Web UI ----------
# 钉在构建机上（BUILDPLATFORM）跑：web/dist 与架构无关，多架构构建时
# 没必要在 QEMU 里跑一遍 vite —— 那是 arm64 构建里最慢的一段。
FROM --platform=$BUILDPLATFORM node:22-alpine AS ui
WORKDIR /app
# 先只拷清单，依赖层可命中缓存
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY web ./web
RUN npm run build:ui

# ---------- 阶段二：运行时 ----------
FROM node:22-alpine
ENV NODE_ENV=production
# 容器内必须监听 0.0.0.0，否则 -p 映射不到（进程默认绑 127.0.0.1 是给裸机用的）。
# 安全边界在「宿主机发布成哪个地址」：README 里发布成 127.0.0.1:8787，公网仍需反代。
ENV STARTRAILS_HOST=0.0.0.0

WORKDIR /app
# better-sqlite3 v13 无 install 脚本，二进制取自包内 prebuilds/（含 linuxmusl-x64），
# 因此 --ignore-scripts 安全，也不需要 python / build-base。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY --from=ui /app/web/dist ./web/dist

# 以非 root 运行。SQLite 只需 /app/data 可写（库文件 + data/cache 规则集镜像）。
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# 单实例：SQLite WAL 要求所有进程在同一主机，不能挂跨主机网络卷。
VOLUME ["/app/data"]
EXPOSE 8787

# 存活探测走静态首页：不需要令牌，也不触碰数据库。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STARTRAILS_PORT||8787)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/index.ts"]
