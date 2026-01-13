#!/usr/bin/env bash
set -euo pipefail

WEB_PORT="${WEB_PORT:-8000}"
OCR_PORT="${OCR_PORT:-8001}"
OCR_LANGS="${OCR_LANGS:-en}"
OCR_CPU="${OCR_CPU:-1}"
OLLAMA_PROXY_URL="${OLLAMA_PROXY_URL:-http://host.docker.internal:11434}"
FLOWCHART_LOG_FILE="${FLOWCHART_LOG_FILE:-/app/logs/container.log}"
VLLM_PROXY_URL="${VLLM_PROXY_URL:-http://host.docker.internal:8002}"

ocr_args=(--host 0.0.0.0 --port "${OCR_PORT}" --lang "${OCR_LANGS}")
if [[ "${OCR_CPU}" != "0" ]]; then
  ocr_args+=(--cpu)
fi

export OLLAMA_PROXY_URL
export FLOWCHART_LOG_FILE
export VLLM_PROXY_URL
mkdir -p "$(dirname "${FLOWCHART_LOG_FILE}")"
touch "${FLOWCHART_LOG_FILE}"

bash -c "python3 /app/ocr_server.py ${ocr_args[*]} 2>&1 | tee -a \"${FLOWCHART_LOG_FILE}\"" &
OCR_PID=$!

bash -c "python3 -m http.server ${WEB_PORT} --directory /app 2>&1 | tee -a \"${FLOWCHART_LOG_FILE}\"" &
WEB_PID=$!

trap 'kill -TERM "${OCR_PID}" "${WEB_PID}" 2>/dev/null' TERM INT

wait -n "${OCR_PID}" "${WEB_PID}"
kill -TERM "${OCR_PID}" "${WEB_PID}" 2>/dev/null || true
wait
