#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="flowchart-app"
CONTAINER_NAME="flowchart-app"

OCR_LANGS_VALUE="${OCR_LANGS:-en}"
OCR_CPU_VALUE="${OCR_CPU:-1}"
OLLAMA_PROXY_URL_VALUE="${OLLAMA_PROXY_URL:-http://host.docker.internal:11434}"
VLLM_PROXY_URL_VALUE="${VLLM_PROXY_URL:-http://host.docker.internal:8002}"
DOCKER_BUILD_NETWORK_VALUE="${DOCKER_BUILD_NETWORK:-host}"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

docker build --network "${DOCKER_BUILD_NETWORK_VALUE}" -t "${IMAGE_NAME}" .

docker run -d \
  --name "${CONTAINER_NAME}" \
  --add-host=host.docker.internal:host-gateway \
  -p 8000:8000 \
  -p 8001:8001 \
  -e OCR_LANGS="${OCR_LANGS_VALUE}" \
  -e OCR_CPU="${OCR_CPU_VALUE}" \
  -e OLLAMA_PROXY_URL="${OLLAMA_PROXY_URL_VALUE}" \
  -e VLLM_PROXY_URL="${VLLM_PROXY_URL_VALUE}" \
  "${IMAGE_NAME}"

echo "FlowSketch is running at http://localhost:8000"
