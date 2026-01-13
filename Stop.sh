#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="flowchart-app"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  docker stop "${CONTAINER_NAME}" >/dev/null
  docker rm "${CONTAINER_NAME}" >/dev/null
fi
