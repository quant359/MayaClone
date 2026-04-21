#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Fill in DEEPGRAM_API_KEY and LLM_API_KEY if they are not exported already."
fi

TTS_ENDPOINT_VALUE="$(
  awk -F= '/^TTS_ENDPOINT=/{print $2}' .env 2>/dev/null | tail -1
)"
TTS_ENDPOINT_VALUE="${TTS_ENDPOINT_VALUE:-http://localhost:8002}"
TTS_ENDPOINT_VALUE="${TTS_ENDPOINT_VALUE%/}"

if ! curl -sf --max-time 5 "$TTS_ENDPOINT_VALUE/health" >/dev/null; then
  echo "Vox API is not reachable at $TTS_ENDPOINT_VALUE"
  echo "Start it first:"
  echo "  docker run -d \\"
  echo "    --name voxmaya-v1 \\"
  echo "    --restart unless-stopped \\"
  echo "    --gpus all \\"
  echo "    -p 8002:8002 \\"
  echo "    -v voxmaya_outputs:/data/outputs \\"
  echo "    quant359/voxmaya-v1:latest"
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

exec npm start
