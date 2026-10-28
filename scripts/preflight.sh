#!/usr/bin/env bash
# preflight.sh — 交付前自检：在**陌生环境**里证明这个项目能跑起来。
#
# 用法:
#   bash preflight.sh              # 在项目根目录跑
#   bash preflight.sh /path/to/repo
#   bash preflight.sh --keep       # 保留临时克隆目录，便于手工排查
#   bash preflight.sh --quick      # 只查文件形状，不做干净克隆(快)
#
# 设计原则:
#   1. 绝不在原仓库里验证 —— 复制一份到临时目录，模拟"别人拿到手"。
#   2. 只报告可执行的事实，不打分、不夸奖。
#   3. 任何一项 FAIL 都让退出码非 0。
set -u

# ─── 参数 ────────────────────────────────────────────────────────────
QUICK=0; KEEP=0; REPO=""
for a in "$@"; do
  case "$a" in
    --quick) QUICK=1 ;;
    --keep)  KEEP=1 ;;
    -*)      echo "未知参数: $a"; exit 2 ;;
    *)       REPO="$a" ;;
  esac
done
[ -n "$REPO" ] || REPO="$(pwd)"
REPO="$(cd "$REPO" 2>/dev/null && pwd)" || { echo "目录不存在"; exit 2; }

PASS=0; FAIL=0; WARN=0
FAILED_NAMES=""

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES="$FAILED_NAMES\n    · $1"; printf '  \033[31m✗ %s\033[0m\n' "$1"; [ $# -gt 1 ] && printf '      \033[33m→ %s\033[0m\n' "$2"; return 0; }
warn() { WARN=$((WARN+1)); printf '  \033[33m!\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      → %s\n' "$2"; return 0; }
sec()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ─── 平台探测 ────────────────────────────────────────────────────────
cd "$REPO" || exit 2
HAS_PKG=0;   [ -f package.json ]      && HAS_PKG=1
HAS_PY=0;    { [ -f pyproject.toml ] || [ -f requirements.txt ] || [ -f setup.py ]; } && HAS_PY=1
HAS_RUST=0;  [ -f Cargo.toml ]        && HAS_RUST=1
HAS_GO=0;    [ -f go.mod ]            && HAS_GO=1
IS_GIT=0;    [ -d .git ]              && IS_GIT=1

printf '\033[1mpreflight · %s\033[0m\n' "$REPO"
KIND="?"
[ $HAS_PKG -eq 1 ]  && KIND="node"
[ $HAS_PY -eq 1 ]   && KIND="${KIND/node/node+python}"
[ $HAS_RUST -eq 1 ] && KIND="${KIND}rust"
[ $HAS_GO -eq 1 ]   && KIND="${KIND}go"
[ "$KIND" = "?" ] && KIND="未知(未找到常见依赖清单)"
echo "  项目类型: $KIND"

# ─── A. 形状层：文件在不在、属性成不成立 ──────────────────────────────
sec "A. 交付形状（文件与属性）"

# A1 版本控制
if [ $IS_GIT -eq 1 ]; then
  ok "是 git 仓库"
else
  bad "不是 git 仓库" "没有版本控制就无法交接、无法回滚。先 git init"
fi

# A2 .gitignore 与 .env 泄漏
if [ $IS_GIT -eq 1 ]; then
  if [ -f .gitignore ]; then
    ok ".gitignore 存在"
    # 关键：.gitignore 里有 .env 这一行，还是真的把 .env 挡住了？
    if git ls-files --error-unmatch .env >/dev/null 2>&1; then
      bad ".env 已被提交进仓库" "密钥已泄漏到历史里。换掉密钥，再 git rm --cached .env"
    else
      ok ".env 未被提交"
    fi
    # 跟踪文件里的可疑产物
    SUSPECT=$(git ls-files | grep -iE '(^|/)(node_modules|dist|build|__pycache__|\.venv|venv)/' | head -3)
    [ -n "$SUSPECT" ] && bad "构建产物/依赖目录被提交" "例:$(echo "$SUSPECT" | head -1)"
  else
    bad ".gitignore 不存在" "本机状态、密钥、缓存会一起进仓"
  fi
fi

# A3 锁文件（依赖是否可复现）
if [ $HAS_PKG -eq 1 ]; then
  LOCK=""
  for f in package-lock.json pnpm-lock.yaml yarn.lock bun.lockb; do [ -f "$f" ] && LOCK="$f" && break; done
  if [ -n "$LOCK" ]; then
    if [ $IS_GIT -eq 1 ] && ! git ls-files --error-unmatch "$LOCK" >/dev/null 2>&1; then
      bad "$LOCK 存在但未入库" "别人 npm ci 会失败/装到别的版本"
    else
      ok "Node 锁文件: $LOCK"
    fi
  else
    bad "无 Node 锁文件" "依赖不可复现。产生并提交 package-lock.json"
  fi
elif [ $HAS_PY -eq 1 ]; then
  LOCK=""
  for f in uv.lock poetry.lock Pipfile.lock requirements.lock; do [ -f "$f" ] && LOCK="$f" && break; done
  if [ -n "$LOCK" ]; then
    ok "Python 锁文件: $LOCK"
  else
    N_UNPIN=$(grep -vcE '^\s*(#|$)' requirements.txt 2>/dev/null || echo 0)
    N_PINNED=$(grep -cE '==' requirements.txt 2>/dev/null || echo 0)
    if [ -f requirements.txt ] && [ "$N_PINNED" -eq 0 ] && [ "$N_UNPIN" -gt 0 ]; then
      bad "无锁文件，且 requirements.txt 里 $N_UNPIN 条没有一条用 == 锁死" "换成 == 或用 uv/pip-tools 生成锁文件"
    else
      bad "无 Python 锁文件" "uv.lock / poetry.lock / pip freeze > requirements.lock"
    fi
  fi
elif [ $HAS_RUST -eq 1 ]; then
  [ -f Cargo.lock ] && ok "Cargo.lock 存在" || warn "无 Cargo.lock" "库可以不要，可执行程序必须提交"
elif [ $HAS_GO -eq 1 ]; then
  [ -f go.sum ] && ok "go.sum 存在" || bad "无 go.sum" "依赖不可复现"
fi

# A4 运行时版本：写了吗？会拦吗？
if [ $HAS_PKG -eq 1 ]; then
  ENG=$(grep -A2 '"engines"' package.json 2>/dev/null | grep -o '"node"[^,}]*' | head -1)
  if [ -n "$ENG" ]; then
    ok "package.json 声明了 $ENG"
    if [ -f .npmrc ] && grep -q 'engine-strict\s*=\s*true' .npmrc; then
      ok ".npmrc 已开 engine-strict（版本不对会当场拒绝安装）"
    else
      bad "engines 是装饰品：没有 engine-strict" "npm 默认只警告。在 .npmrc 加 engine-strict=true"
    fi
  else
    bad "package.json 没有 engines" "别人用 Node 18/20 也能装，跑到一半才炸"
  fi
  VF=""
  for f in .nvmrc .node-version; do [ -f "$f" ] && VF="$f" && break; done
  [ -n "$VF" ] && ok "版本钉文件: $VF" || warn "无 .nvmrc / .node-version" "建议写入主版本号，如 24"
elif [ $HAS_PY -eq 1 ]; then
  REQUIRES=$(grep -E '^\s*requires-python' pyproject.toml 2>/dev/null | head -1)
  [ -n "$REQUIRES" ] && ok "声明了 $REQUIRES" || warn "pyproject 没有 requires-python" "别人用 3.9 装，语法错到看不懂"
  VF=""
  for f in .python-version .tool-versions; do [ -f "$f" ] && VF="$f" && break; done
  [ -n "$VF" ] && ok "版本钉文件: $VF" || warn "无 .python-version" "建议写入具体版本"
fi

# A5 配置样例
if [ $IS_GIT -eq 1 ]; then
  SAMPLE=""
  for f in .env.example .env.sample .env.template env.example; do [ -f "$f" ] && SAMPLE="$f" && break; done
  if [ -n "$SAMPLE" ]; then
    if git ls-files --error-unmatch "$SAMPLE" >/dev/null 2>&1; then
      ok "配置样例已入库: $SAMPLE"
    else
      bad "$SAMPLE 存在但未入库" "别人不知道要配哪些变量"
    fi
  else
    warn "无 .env.example" "若项目读环境变量，缺这个等于让别人猜"
  fi
fi

# A6 LICENSE
if [ -f LICENSE ] || [ -f LICENSE.md ] || [ -f LICENSE.txt ]; then
  ok "LICENSE 存在"
else
  warn "无 LICENSE" "公开仓库没有 LICENSE = 别人法律上无权使用"
fi

# A7 CI
CI=""
for f in .github/workflows/*.yml .github/workflows/*.yaml .gitlab-ci.yml .circleci/config.yml; do
  [ -f "$f" ] && CI="$f" && break
done
[ -n "$CI" ] && ok "CI 配置: $CI" || bad "无 CI" "唯一能在别人机器上自动跑的验收手段"

# A8 README
if [ -f README.md ] || [ -f README.rst ] || [ -f readme.md ]; then
  RM="README.md"; [ -f "$RM" ] || RM="README.rst"; [ -f "$RM" ] || RM="readme.md"
  # 前 40 行里有没有可执行的东西（代码块 / 命令）
  if head -40 "$RM" | grep -qE '^\s*(```|\$ |npm |pip |python |node |cargo |go )'; then
    ok "README 第一屏有可执行步骤"
  else
    warn "README 前 40 行没有可执行命令" "新人第一屏看不到「怎么跑」"
  fi
else
  bad "无 README" "其余一切都无从下手"
fi

# ─── B. 文档层：README 里的命令能不能用 ──────────────────────────────
sec "B. 文档可执行性（README 代码块）"

if [ -f README.md ]; then
  # 抽出 ```bash / ```sh 代码块里的命令行
  CMDS=$(awk '
    /^```(bash|sh|shell|console)/{inb=1;next}
    /^```/{inb=0;next}
    inb && NF {print}
  ' README.md | sed -e 's/^\s*\$ *//' | grep -vE '^\s*#' | grep -vE '^\s*$')

  N_CMD=$(echo "$CMDS" | grep -c . || true)
  if [ "$N_CMD" -eq 0 ]; then
    warn "README 里没有 bash/sh 代码块"
  else
    echo "  抽到 $N_CMD 条命令。长驻进程类（会占住终端）单独标出："
    LONG=$(echo "$CMDS" | grep -nE '\b(run dev|dev\b|serve|start|watch|docker compose up|--ws)\b' | head -6)
    if [ -n "$LONG" ]; then
      echo "$LONG" | sed 's/^/      [长驻] /'
    fi
    SHORT=$(echo "$CMDS" | grep -vE '\b(run dev|dev\b|serve|start|watch|docker compose up|--ws)\b')
    N_SHORT=$(echo "$SHORT" | grep -c . || true)
    echo "      $N_SHORT 条可一次跑完（安装/测试/校验类）。"
    echo
    printf '  \033[33m以上命令必须逐条手工执行并核对输出。\033[0m\n'
    echo "  这一步不用机器判定 —— 要看的是「输出是否和文档承诺的一致」，"
    echo "  例如文档说返回 200 而实际是 401。"
    echo
    echo "$SHORT" | sed 's/^/      $ /'
  fi
else
  warn "跳过（无 README.md）"
fi

# ─── C. 行为层：干净克隆里真的装得上、跑得通 ─────────────────────────
if [ $QUICK -eq 1 ]; then
  sec "C. 干净环境（--quick 已跳过）"
  warn "未执行干净克隆" "这是最重要的一步，交付前必须去掉 --quick 跑一次"
else
  sec "C. 干净环境（模拟「别人拿到手」）"
  if [ $IS_GIT -ne 1 ]; then
    bad "无法干净克隆" "不是 git 仓库 —— 这正是「只有你能跑」的根因"
  else
    TMPD=$(mktemp -d 2>/dev/null || mktemp -d -t preflight)
    CLEAN="$TMPD/clean"

    # 只取已提交的内容：未提交的改动不算数，因为别人拿不到
    if git clone --quiet --depth 1 "file://$REPO" "$CLEAN" 2>/dev/null || \
       git clone --quiet "$REPO" "$CLEAN" 2>/dev/null; then
      ok "干净克隆成功（$(cd "$CLEAN" && git ls-files | wc -l | tr -d ' ') 个文件）"
    else
      bad "干净克隆失败" "仓库本身有问题"
      CLEAN=""
    fi

    DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    [ "$DIRTY" -gt 0 ] && warn "有 $DIRTY 个未提交改动" "干净克隆里没有它们 —— 别人拿到的就是这个状态"

    if [ -n "$CLEAN" ]; then
      cd "$CLEAN" || true

      # 未入库但代码引用的文件
      if [ $HAS_PKG -eq 1 ]; then
        if [ -f package-lock.json ]; then
          if npm ci --silent >/tmp/pf_npm.log 2>&1; then
            ok "npm ci 成功"
            TESTFAIL=0
            if grep -q '"typecheck"' package.json; then
              npm run typecheck --silent >>/tmp/pf_npm.log 2>&1 && ok "npm run typecheck 通过" || { bad "npm run typecheck 失败" "见 /tmp/pf_npm.log"; TESTFAIL=1; }
            fi
            if grep -q '"test"' package.json; then
              npm test --silent >>/tmp/pf_npm.log 2>&1 && ok "npm test 通过" || { bad "npm test 失败" "见 /tmp/pf_npm.log"; TESTFAIL=1; }
            else
              warn "package.json 没有 test 脚本"
            fi
            [ $TESTFAIL -eq 0 ] && ok "（在无 node_modules、无 .data 的环境里通过）"
          else
            bad "npm ci 失败" "见 /tmp/pf_npm.log"
          fi
        else
          bad "跳过安装验证" "无 package-lock.json，npm ci 无法执行"
        fi

      elif [ $HAS_PY -eq 1 ]; then
        PY=""
        for c in python3 python; do command -v $c >/dev/null 2>&1 && PY=$c && break; done
        if [ -n "$PY" ]; then
          VENV="$TMPD/venv"
          if $PY -m venv "$VENV" >/dev/null 2>&1; then
            if [ -f requirements.txt ]; then
              if "$VENV/bin/pip" install -q -r requirements.txt >/tmp/pf_py.log 2>&1 || \
                 "$VENV/Scripts/pip.exe" install -q -r requirements.txt >>/tmp/pf_py.log 2>&1; then
                ok "pip install -r requirements.txt 成功"
                PIPT="$VENV/bin/pytest"; [ -x "$PIPT" ] || PIPT="$VENV/Scripts/pytest.exe"
                if [ -x "$PIPT" ]; then
                  "$PIPT" -q >/tmp/pf_py.log 2>&1 && ok "pytest 通过" || bad "pytest 失败" "见 /tmp/pf_py.log"
                else
                  warn "装了依赖但没有 pytest" "无法验证代码正确性"
                fi
              else
                bad "pip install 失败" "见 /tmp/pf_py.log —— 常见原因：缺少系统级依赖"
              fi
            fi
          else
            warn "无法创建 venv"
          fi
        else
          warn "本机没有 python"
        fi

      elif [ $HAS_RUST -eq 1 ] && command -v cargo >/dev/null 2>&1; then
        cargo build -q >/tmp/pf_rs.log 2>&1 && ok "cargo build 通过" || bad "cargo build 失败" "见 /tmp/pf_rs.log"
        cargo test -q >/tmp/pf_rs.log 2>&1 && ok "cargo test 通过" || bad "cargo test 失败" "见 /tmp/pf_rs.log"

      elif [ $HAS_GO -eq 1 ] && command -v go >/dev/null 2>&1; then
        go build ./... >/tmp/pf_go.log 2>&1 && ok "go build 通过" || bad "go build 失败" "见 /tmp/pf_go.log"
        go test ./... >/tmp/pf_go.log 2>&1 && ok "go test 通过" || bad "go test 失败" "见 /tmp/pf_go.log"
      fi

      cd "$REPO" || true
    fi

    if [ $KEEP -eq 1 ]; then
      echo "  临时克隆保留在: $CLEAN"
    else
      rm -rf "$TMPD"
    fi
  fi
fi

# ─── 结果 ────────────────────────────────────────────────────────────
sec "结果"
printf '  通过 %d · 失败 %d · 提醒 %d\n' "$PASS" "$FAIL" "$WARN"
if [ $FAIL -gt 0 ]; then
  printf '\n\033[31m阻塞项（必须修完才算可交付）:\033[0m'
  printf "$FAILED_NAMES\n"
  echo
  exit 1
fi
echo
echo "  形状层无阻塞项。仍须手工执行 B 段列出的命令并核对输出。"
exit 0
