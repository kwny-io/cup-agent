# 后端镜像 —— 只跑 apps/server(前端静态站点由自己的 web 服务器托管,见 DEPLOY.md)。
#
# 为什么没有构建阶段:Node ≥24 默认开**类型剥离**,`.ts` 可直接执行(本仓的
# "strip-only" 纪律就是为此:不用 enum / 参数属性 / namespace)。故不需要 tsc 产物,
# 也不需要把 typescript 装进镜像。
#
# 镜像里只装 dependencies(--omit=dev):pg / ws / mqtt / zod 是运行时真依赖,
# typescript 与 @types/* 只服务于本地门禁。

FROM node:24-slim

# 时区数据:日界(CUP_TZ)与日志时间戳要按 IANA 时区算,而 slim 镜像不带 tzdata。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷清单 —— 依赖没变时这一层可复用缓存(改源码不触发重装)。
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY apps/server/package.json apps/server/
COPY apps/simulator/package.json apps/simulator/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --ignore-scripts

# 源码。契约包是服务端的运行时依赖(@cup/contract → packages/contract/src),必须带上。
COPY packages/contract packages/contract
COPY apps/server apps/server

# 非 root 运行。两个落盘目录都必须在镜像里就建好并交给 node 用户,否则首次写入因权限失败:
#   /app/.data  claim-pepper / llm-enc-key / social.json —— **丢了绑定码与密文 key 就解不开**
#   /app/logs   JSONL 服务日志(server-YYYY-MM-DD.log),供外部采集器 tail
RUN mkdir -p /app/.data /app/logs && chown -R node:node /app/.data /app/logs
USER node

# 容器内必须监听 0.0.0.0,否则只通容器自己(cli 的默认是 127.0.0.1,那是主机上的安全默认)。
ENV NODE_ENV=production \
    CUP_HOST=0.0.0.0 \
    CUP_PORT=8788 \
    CUP_DATA_DIR=/app/.data \
    CUP_LOG_DIR=/app/logs

EXPOSE 8788

# 健康检查用 /healthz —— 它不触库、不打鉴权,是给探针用的最小面。
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CUP_PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/cli.ts"]
