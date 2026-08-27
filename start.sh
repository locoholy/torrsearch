#!/usr/bin/env bash
# Запускает локальный поиск торрентов и открывает его в браузере.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8777}"

# Если сервер уже поднят — просто открываем вкладку, второй копии не надо.
if ! curl -sf "http://127.0.0.1:$PORT/api/sources" >/dev/null 2>&1; then
	nohup node server.mjs >/tmp/torrsearch.log 2>&1 &
	for _ in $(seq 30); do
		curl -sf "http://127.0.0.1:$PORT/api/sources" >/dev/null 2>&1 && break
		sleep 0.2
	done
fi

xdg-open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || true
