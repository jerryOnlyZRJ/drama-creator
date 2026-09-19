#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PROCESS="drama-creator-tauri"
APP_BINARY="$ROOT_DIR/src-tauri/target/release/$APP_PROCESS"
APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/Drama Creator.app"
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/$APP_PROCESS"
APP_LOG="${TMPDIR:-/tmp}/drama-creator-tauri.log"

stop_existing() {
  pkill -x "$APP_PROCESS" >/dev/null 2>&1 || true

  # 仅停止 cwd 指向本项目的 5173 Node server，避免误杀用户机器上的其他本地服务。
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
    if [[ "$cwd" == "$ROOT_DIR" || "$cwd" == *"Drama Creator.app/Contents/Resources/_up_"* ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done < <(lsof -tiTCP:5173 -sTCP:LISTEN 2>/dev/null || true)
}

build_app() {
  (cd "$ROOT_DIR" && npm run build:tauri -- --bundles app)
}

launch_app() {
  # 通过 .app 启动，才能验证 packaged resources 与普通桌面应用启动路径一致。
  /usr/bin/open -n "$APP_BUNDLE"
}

launch_app_direct() {
  # LaunchServices 在自动化环境里偶发只返回成功但没有留下进程；直接后台运行包内二进制作为兜底。
  nohup "$APP_EXECUTABLE" >"$APP_LOG" 2>&1 &
}

wait_for_app() {
  for _ in {1..20}; do
    if pgrep -x "$APP_PROCESS" >/dev/null && lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

launch_app_with_fallback() {
  launch_app
  if ! wait_for_app; then
    launch_app_direct
    wait_for_app
  fi
}

case "$MODE" in
  run)
    stop_existing
    build_app
    launch_app_with_fallback
    ;;
  --debug|debug)
    stop_existing
    build_app
    cd "$ROOT_DIR/src-tauri"
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    launch_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_PROCESS\""
    ;;
  --verify|verify)
    stop_existing
    build_app
    launch_app_with_fallback
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--verify]" >&2
    exit 2
    ;;
esac
