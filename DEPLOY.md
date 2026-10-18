# 部署

后端 = 一个 Node 24 进程,无构建步骤。下面覆盖三件事:**容器跑起来**、**环境变量怎么配**、
**上线前必须自己决定的几件事**(TLS、密钥、暴露面)。

```
docker compose up -d --build
docker compose exec app node -e "fetch('http://127.0.0.1:8788/healthz').then(r=>console.log(r.status))"
```

## 一、这套东西由哪几块组成

| 块 | 是不是这个镜像 | 说明 |
|---|---|---|
| `apps/server` | **是** | API + WebSocket,本镜像的唯一进程 |
| `packages/contract` | **是** | 契约包,服务端的运行时依赖(`@cup/contract` → `src/index.ts`) |
| Postgres | 不是,compose 里的 `db` | 可选。不配 `CUP_PG_URL` 也能跑(退内存/文件) |
| `apps/web` | **不是** | 纯静态站点,`vite build` 产物自己托管;后端**不**托管它 |
| `firmware/` | **不是** | 需 ESP-IDF 工具链,是另一条线 |

**为什么后端镜像里没有构建阶段**:Node ≥24 默认开类型剥离,`.ts` 直接执行。这正是仓库
「strip-only」纪律(不用 `enum` / 参数属性 / `namespace`)的用途。所以镜像里没有 `tsc` 产物,
也没有 `typescript` 依赖。

## 二、compose 里三个服务各管什么

- **`db`** —— `postgres:16`。数据在 `pgdata` 卷。**默认不发布端口**(app 走 compose 内网连它);
  要从宿主机 `psql` 进去,取消 `docker-compose.yml` 里 `ports` 那几行注释。
- **`migrate`** —— 一次性容器,`--migrate` 跑完即退。放在这里而不是让 app 自己迁,是为了让
  表结构与服务进程解耦:app 重启不重跑迁移,将来扩多副本也不会互相打架。
  `app` 用 `service_completed_successfully` 等它退出成功才启动。
- **`app`** —— 后端本体。

三个卷:
- `pgdata` —— 数据库
- `appdata` → 容器内 `/app/.data` —— `claim-pepper`、`llm-enc-key`、`social.json` 等**非 PG 状态**
- `applogs` → 容器内 `/app/logs` —— JSONL 服务日志,给宿主机上的 filebeat/fluentd 直接 tail

> **`appdata` 必须持久化**。里面两个文件是密钥:`claim-pepper` 参与已绑定杯子的码哈希,
> `llm-enc-key` 是用户模型 key 的加密主钥。**卷丢了 = 已绑定的杯子全部要重绑、已存的模型
> key 全部解不开。** 想脱离卷管理就走下面的 `CUP_CLAIM_PEPPER` / `CUP_LLM_ENC_KEY`。

## 三、环境变量

### 必看(不配会出事或功能不全)

| 变量 | 默认 | 说明 |
|---|---|---|
| `CUP_HOST` | `127.0.0.1` | **容器内镜像已设为 `0.0.0.0`**。直接 `node` 跑时默认只听回环。 |
| `CUP_PORT` | `8788` | 监听端口,镜像里也设了。 |
| `CUP_PG_URL` | 不设 | `postgres://user:pass@host:5432/db`。**不设就走内存/文件**,重启丢数据(除 `.data` 里的)。 |
| `CUP_API_KEY` | 启动时随机生成 | 写端点(`PUT /goal`、`POST /config`、`POST /ask`、`POST /ingest`)的 `x-api-key`。不设则随机,只能从启动横幅/`docker compose logs app` 里捞。**生产显式给定。** |
| `CUP_ADMIN_EMAIL` | 空 | 该邮箱注册即得 `admin`。不设则没有管理员。 |
| `CUP_OPS_EMAILS` | 空 | 逗号分隔。`ops` 能读日志 + 触发保留清理。 |
| `CUP_REVIEWER_EMAILS` | 空 | 逗号分隔。`reviewer` 日志只读。 |
| `CUP_CORS_ORIGINS` | 不设 = `*` | 前端与 API **不同域**时必须列出来源(逗号分隔),否则配置类请求会被浏览器拦。 |

### 密钥(可落盘,也可显式给)

| 变量 | 落盘位置 | 说明 |
|---|---|---|
| `CUP_CLAIM_PEPPER` | `.data/claim-pepper` | 绑定码哈希的 pepper(base64)。 |
| `CUP_LLM_ENC_KEY` | `.data/llm-enc-key` | 用户模型 key 的加密主钥(base64 32B)。 |

不设就从 `.data` 读/首次生成 —— 单机 + 持久卷完全够用。**多副本、或不想依赖卷**时显式给同一份。

### 网络 / TLS

| 变量 | 说明 |
|---|---|
| `CUP_TLS_CERT` / `CUP_TLS_KEY` | 两个都给才启用 https,并自动加 HSTS。只给一个启动即 fatal。 |
| `CUP_TRUST_PROXY` | `1` 才信 `x-forwarded-for` 首跳。**只在反向代理后面开**;直连时开 = 客户端 IP 可伪造(限流会被绕过)。 |
| `CUP_TZ` | IANA 时区,如 `Asia/Shanghai`。影响日界与日志时间戳。不设 = 容器 UTC。 |

### 日志 / 保留

| 变量 | 默认 | 说明 |
|---|---|---|
| `CUP_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `CUP_LOG_FORMAT` | `text` | `json`(落库/落文件时内部强制 json,这里管控制台) |
| `CUP_LOG_DIR` | 镜像内 `/app/logs` | JSONL 出口目录 |
| `CUP_TELEMETRY_RETAIN_DAYS` | `90` | 遥测保留天数 |
| `CUP_EVENTS_RETAIN_DAYS` | `395` | 事件保留天数(约 13 个月) |
| `CUP_SERVER_LOGS_RETAIN_DAYS` | `90` | 服务日志保留天数 |
| `CUP_RETENTION` | 不设 | `1` = 启动时顺带清一次过期分区 |

保留策略按**整月分区**删,不逐行删;cutoff 所在月保留,当前月永不删。**不可逆**,所以只在
`--retain` 或显式 `CUP_RETENTION=1` 时执行,绝不隐式跑。

### 行为开关

| 变量 | 默认 | 说明 |
|---|---|---|
| `CUP_REQUIRE_CLAIM` | **开** | 绑定杯子须出示设备一次性 claim code。仅 `0`/`false` 关(生产勿关)。 |
| `CUP_MARKET_OPEN` | **关** | `1`/`true` 开人格市场(货架可读、可投稿)。关时货架空、投稿 503。 |
| `CUP_LLM_URL` / `CUP_LLM_KEY` / `CUP_LLM_MODEL` | 不设 | 战报语气润色。不配则恒用模板(数字仍真实)。 |
| `CUP_CHAT_KEY` / `CUP_CHAT_MODEL` / `CUP_CHAT_URL` | 不设 | 对话模型(Claude Messages API)。不配则回退确定性模板句。 |
| `CUP_MQTT_URL` / `CUP_MQTT_CLIENT_ID` | 不设 | 真机 MQTT ingest。**多实例时 `CLIENT_ID` 必须各不相同**。 |

## 四、TLS:两条路,选一条

1. **反代终止(常规做法)** —— nginx/Caddy/云 LB 管证书,容器内保持明文:
   ```yaml
   environment:
     CUP_TRUST_PROXY: "1"
     CUP_CORS_ORIGINS: https://cup.example.com
   ```
   此时**不要**设 `CUP_TLS_*`,否则 app 也会起 https,反代到它还得再信任一次自签。
2. **进程自己起 https** —— 挂证书进容器,设 `CUP_TLS_CERT` / `CUP_TLS_KEY`(容器内路径)。
   会自动加 `Strict-Transport-Security`。注意证书续期后要重启容器。

明文下发 HSTS 会锁死用户浏览器,所以 HSTS **只在真 TLS 时发**;这一点有测试守着
(`apps/server/test/security-headers.test.ts`)。

## 五、暴露面 / 安全默认

- **安全响应头**每个响应都带(含 404/401/429/预检):`nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`、`CORP: same-site`、`CSP: default-src 'none' …`。
- **限流默认开**:认证口 20/分、写口 300/分、其余 1200/分,超限 `429` + `Retry-After`。
  这是应用层最后一道;反代/WAF 是第一道,不冲突。要按实际流量调,见
  `apps/server/src/api/rate-limit.ts` 的 `DEFAULT_RULES`。
- **健康检查**用 `GET /healthz` —— 不触库、不打鉴权、日志降到 debug(不刷屏)。
- **非 root 运行**:镜像内以 `node` 用户跑;`/app/.data` 与 `/app/logs` 已 chown 给它。

## 六、前端怎么部署

后端不托管前端。前端是独立静态站点:

```bash
npm --workspace @cup/web run build     # → apps/web/dist/
```

把 `dist/` 丢给 nginx/CDN 即可。前端指向后端的办法是 URL 参数:

- `?cloud=<api 地址>` —— 如 `?cloud=https://api.example.com`
- `?cloud=1` —— 用默认 `http://localhost:8788`
- `?cloud=1&key=<CUP_API_KEY>` —— 云模式下写请求带 `x-api-key`

所以**前后端同域**最省事(反代把 `/` 给静态站、`/api` 之类的路径给后端,再配
`CUP_CORS_ORIGINS`);不同域就必须配白名单。

## 七、定时任务

| 想做的事 | 命令 |
|---|---|
| 每天清过期分区 | `docker compose run --rm app node apps/server/src/cli.ts --retain`(放宿主机 cron/systemd timer) |
| 只跑迁移(手工) | `docker compose run --rm app node apps/server/src/cli.ts --migrate` |
| 看日志 | `docker compose logs -f app`;结构化行在卷 `applogs` 里 |

`--migrate` / `--retain` 都是「跑完即退」,不会留下常驻进程。

## 八、常见问题

**容器起来但外面连不上** —— `CUP_HOST` 还是 `127.0.0.1`。镜像已设 `0.0.0.0`;自己写 Dockerfile
或 `--env` 覆盖时要记得。

**启动横幅里有一串随机 key** —— 那是没设 `CUP_API_KEY` 时生成的。要么用它,要么显式给定后重启。

**登录后看不到日志 tab / 403** —— 日志读端点要 `admin`/`ops`/`reviewer` 角色。角色在**注册那一刻**
按 `CUP_ADMIN_EMAIL` / `CUP_OPS_EMAILS` / `CUP_REVIEWER_EMAILS` 定一次并写进账号;事后改名单
**不会**改动已注册的账号(`core/social/auth.ts` 的 `resolveRole` 只在 `register` 里调用)。
要么用名单内的邮箱重新注册,要么直接改库里 `users.role`。

**重建容器后杯子要重绑** —— `appdata` 卷没挂上(或 `CUP_CLAIM_PEPPER` 变了)。幂等的前提是
pepper 一致。

**`503 市场暂未开放`** —— `CUP_MARKET_OPEN` 没设。这是有意默认关的灰度开关。
