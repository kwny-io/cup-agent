# 交付自检（写给 agent 读）

> 本文件面向**所有**代码 agent：Claude Code、Cursor、Codex、Copilot、Gemini CLI 或任何人。
> 不依赖任何特定工具的特性（不用 hooks、不用 MCP、不用专有指令）。
>
> 本仓库里的两份配套文件：
> - `scripts/preflight.sh` —— 一条命令跑完本页大部分检查（`bash scripts/preflight.sh`）
> - `.env.example` —— 全部环境变量的清单（`cp .env.example .env`）
>
> **人类读者可以跳过本页。** 它约束的是 agent 的行为，不是人的。

---

## 0. 为什么需要这一页

这个项目的负责人反复遇到同一个问题：

> **「我自己这边跑能跑通，给别人就跑不通。」**

原因不是代码水平，是验收方式。**agent 唯一的检验工具是「当前这台机器」，而这台机器对每个问题都回答「是」**——`node_modules` 在、`.data` 在、Postgres 在、系统级依赖在、Node 版本恰好对。于是测试全绿，而缺陷一个也没被看见。

本文件把「请保证完整性」这类形容词，换成**必须 exit 0 的命令**。

---

## 1. 五条硬要求

以下每一条都是**可执行断言**，不是建议。做不到要说出来，不要说「已完成」。

### 1.1 运行时版本必须被强制，不能只是声明

- **Node**：`package.json` 的 `engines` + `.npmrc` 里的 `engine-strict=true`。
  - 只有 `engines` 没用。npm 默认**只警告、照样装完**，然后在运行时炸。
- **Python**：`pyproject.toml` 的 `requires-python` + `.python-version` 钉文件。
- **任何语言**：仓库里要有钉版本的文件的（`.nvmrc` / `.node-version` / `.python-version` / `rust-toolchain.toml`）。

### 1.2 依赖必须锁定

- 锁文件**必须在仓库里**（`package-lock.json` / `pnpm-lock.yaml` / `uv.lock` / `poetry.lock` / `Cargo.lock` / `go.sum`）。
- `>=1.30.0` **不是锁定**。它的含义是「任何一天安装都可能是不同的软件」。
- Python 项目没有锁文件时，`requirements.txt` 里应当用 `==`。

### 1.3 密钥与本地状态不得入库

- `.env` **不入库**；`.env.example` **入库**（列出所有变量，值留空或写示例）。
- `.gitignore` 必须真的挡住：`.env*`、密钥、本地数据库、`node_modules`、`dist`、缓存、日志。
- **判断标准不是「.gitignore 里有没有那一行」，而是 `git ls-files` 里有没有那个文件。**

### 1.4 文档里的命令必须被执行过

- README 里每一行代码块，**原样复制到终端执行一遍**，把**真实输出**贴进交付报告。
- 「我检查了一遍文档」不算。要看的是**输出与文档承诺是否一致**。
- 典型失败：文档写 `curl .../today` 返回今日概览，实际返回 `401 unauthorized`。

### 1.5 必须在「陌生环境」里验证，不能在原目录

- 原目录里有你（或前一个 agent）留下的 `node_modules`、`.data`、venv、数据库、环境变量。
- 必须 `git clone` 到临时目录，**只用仓库里的内容**跑一遍。
- 这一条是唯一能自动发现 1.1–1.3 所有漏洞的手段。

---

## 2. 收尾时必须执行的验收流程

交付前，**逐条执行并把输出贴出来**。不要总结成「已通过」。

```bash
# ① 干净克隆（模拟别人拿到手；不带任何本地状态）
TMPD=$(mktemp -d); git clone . "$TMPD/clean"; cd "$TMPD/clean"

# ② 只装仓库里声明的依赖
npm ci            # 或 uv sync / pip install -r requirements.txt / cargo build

# ③ 跑门禁
npm run typecheck
npm test

# ④ 执行 README 里的命令（一条一条，贴真实输出）

# ⑤ 收尾
cd -; rm -rf "$TMPD"
```

**报告格式要求**：每条命令单独一行，附上真实输出的关键行。任何一条失败，**必须说明失败原因**，不得跳过、不得写「已知问题，不影响交付」而不解释为什么。

---

## 3. 常见失败模式（agent 请对照自查）

这些不是假设，是在本仓库实测发现的：

| 症状 | 真相 | 检查方法 |
|---|---|---|
| 「测试全绿」 | 测试跑在有本地状态的目录里 | 干净克隆里再跑一次 |
| 「README 写好了」 | 写文档时行为还是旧的，后来改了代码没改文档 | 执行文档里的命令 |
| 「engines 声明了」 | 没配 `engine-strict`，等于装饰品 | 看 `.npmrc` |
| 「有锁文件」 | 有但没提交，`git ls-files` 里没有 | `git ls-files \| grep lock` |
| 「.gitignore 有 .env」 | 文件早就被提交了，加规则不会自动移除 | `git ls-files .env` |
| 「本机能跑」 | 缺系统级依赖（C 编译器、ffmpeg、libpq、MuJoCo…） | 干净环境里装一遍 |
| 「CI 会兜底」 | CI 用的版本和本机不一样 | 对比 CI 的 `node-version` 与本机 |

**特别提醒**：`requirements.txt` 里只有 `>=`、README 里写着「约 270MB 离线资源需下载」、源码里有 `D:\.venv-xxx\...` 这类绝对路径——**这些在原作者机器上全部无害，在别人机器上全部致命**。

---

## 4. 本项目的具体门禁

交付前这四条**必须全跑过**（与 CI 一致，见 `.github/workflows/ci.yml`）：

```bash
npm run typecheck                          # 根 tsc + apps/web 的 tsc，是两条
npm test                                   # 契约 + 模拟器 + 后端
npm --workspace @cup/web test              # 前端
bash firmware/lid/host_test/run_all.sh     # 固件宿主单测（纯 C）
```

固件那一闸需要 C 编译器。本机通常没有 `cc`，用 mingw：

```bash
CC=/c/mingw64/mingw64/bin/gcc.exe bash firmware/lid/host_test/run_all.sh
```

没有编译器时**明确说出来**，不要说「已通过」。CI 是这一层的兜底。

## 5. 不要为了「完整」做的事

过度工程同样是缺陷。以下**不要**在这个仓库里做：

- **不要新增依赖**去实现本页要求的检查（`scripts/preflight.sh` 已经是纯 shell + git）。
- **不要碰冻结区**：`packages/contract` 是四方共享的数据契约，任何字段改动须先达成共识。
- **不要**把这份文档里的要求复制成别处的第二份 —— 改就改这一份。
- **不要**把临时验证产物（克隆目录、日志、截图）留在仓库里。
- **不要**写桌面私有文档的路径进任何仓库文件（那些文档是私人档案，只读不写回）。

---

## 5. 一句话总结

> **不要告诉我它在你机器上能跑。用一条命令证明它在空目录里能跑。**

如果某一条做不到，直接说「1.2 依赖锁定未做到，因为 X」，比说「已完成，请注意依赖版本」有用得多。
