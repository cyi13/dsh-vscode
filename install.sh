#!/usr/bin/env bash
#
# dsh-vscode 一键安装脚本
#
# 作用：构建并安装两个 DSH 插件（deeplink / vscode-bridge）到 dsh web profile，
#       重启 dsh web，然后构建并安装 VS Code 扩展。
#
# 用法：
#   ./install.sh                  # 全部安装（含重启 dsh web）
#   ./install.sh --no-restart-web # 安装但不重启 dsh web（需手动重启）
#   ./install.sh --skip-extension # 只装 DSH 插件，不装 VS Code 扩展
#   ./install.sh --help
#
# 要求：node / npm / dsh / code 已在 PATH 中。
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[install]${NC} $*"; }
warn() { echo -e "${YELLOW}[install]${NC} $*"; }
err()  { echo -e "${RED}[install]${NC} $*" >&2; exit 1; }

# 仓库根目录（脚本所在目录）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RESTART_WEB=1
SKIP_EXTENSION=0
DSH_WEB_PORT="${DSH_WEB_PORT:-3080}"

for arg in "$@"; do
  case "$arg" in
    --no-restart-web) RESTART_WEB=0 ;;
    --skip-extension) SKIP_EXTENSION=1 ;;
    --help|-h)
      echo "用法: ./install.sh [--no-restart-web] [--skip-extension]"
      exit 0 ;;
    *) warn "忽略未知参数: $arg" ;;
  esac
done

# ── 1. 检查依赖 ──────────────────────────────────────────────────────────────
info "检查依赖..."
for cmd in node npm dsh code; do
  command -v "$cmd" >/dev/null 2>&1 || err "缺少依赖: $cmd（请先安装并加入 PATH）"
done
info "依赖 OK (node $(node -v), dsh $(dsh --version 2>/dev/null | head -1))"

# ── 2. 构建并安装 DSH 插件 ───────────────────────────────────────────────────
install_dsh_plugin() {
  local name="$1"
  local dir="$ROOT/plugins/$name"
  info "构建插件 $name ..."
  ( cd "$dir" && npm install --silent && npm run build )
  rm -f "$dir"/*.tgz
  local tgz
  tgz="$(cd "$dir" && npm pack --silent | tail -1)"
  [ -n "$tgz" ] || err "$name: npm pack 失败"
  info "安装 $tgz 到 web profile ..."
  # 先 remove 再 add，避免 pnpm 缓存旧 tarball（"Already up to date" 问题）
  dsh plugin --profile web remove "$name" >/dev/null 2>&1 || true
  dsh plugin --profile web add "$dir/$tgz"
  info "$name 已安装"
}

install_dsh_plugin dsh-deeplink
install_dsh_plugin dsh-vscode-bridge

# ── 3. 重启 dsh web ──────────────────────────────────────────────────────────
restart_dsh_web() {
  local pid
  pid="$(lsof -ti tcp:"$DSH_WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    info "停止旧 dsh web (PID $pid) ..."
    kill -TERM "$pid" 2>/dev/null || true
    # 等待优雅退出（最多 30s）
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && warn "旧进程未退出（$pid），继续尝试启动新实例"
  fi

  # 等待端口释放
  for _ in $(seq 1 10); do
    lsof -ti tcp:"$DSH_WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done

  info "启动 dsh web（后台，日志 ~/.dsh/dsh-web.log）..."
  mkdir -p "$HOME/.dsh"
  nohup dsh web >"$HOME/.dsh/dsh-web.log" 2>&1 &
  disown || true

  # 等待服务就绪（最多 40s）
  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "http://127.0.0.1:$DSH_WEB_PORT/"; then
      info "dsh web 已就绪 (http://127.0.0.1:$DSH_WEB_PORT)"
      return 0
    fi
    sleep 1
  done
  warn "dsh web 等待超时，请查看日志: tail -f ~/.dsh/dsh-web.log"
}

if [ "$RESTART_WEB" = "1" ]; then
  restart_dsh_web
else
  warn "已跳过重启 dsh web —— 请手动重启：kill -TERM <pid> 后重新运行 dsh web"
fi

# ── 4. 构建并安装 VS Code 扩展 ───────────────────────────────────────────────
install_extension() {
  info "构建 VS Code 扩展 ..."
  ( cd "$ROOT" && npm install --silent && npm run package )
  local vsix
  vsix="$(ls -t "$ROOT"/dsh-sessions-*.vsix 2>/dev/null | head -1)"
  [ -n "$vsix" ] || err "VSIX 构建失败"
  info "安装扩展 $(basename "$vsix") ..."
  code --install-extension "$vsix" --force
  info "VS Code 扩展已安装"
}

if [ "$SKIP_EXTENSION" = "1" ]; then
  info "已跳过 VS Code 扩展安装（--skip-extension）"
else
  install_extension
fi

# ── 完成 ─────────────────────────────────────────────────────────────────────
info "全部完成！"
if [ "$RESTART_WEB" = "1" ]; then
  info "  - dsh web 运行中（新实例）"
else
  info "  - 记得手动重启 dsh web"
fi
info "  - 请重载 VS Code 窗口：Cmd+Shift+P → Developer: Reload Window"
