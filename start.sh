#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
ENV_FILE="$ROOT_DIR/.env"
mkdir -p "$LOG_DIR"

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; PURPLE='\033[0;35m'; BOLD='\033[1m'
DIM='\033[2m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
ask()  { echo -en "  ${CYAN}?${NC} $1"; }
info() { echo -e "  ${DIM}$1${NC}"; }

echo ""
echo -e "${PURPLE}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║          🎙️  MayaClone v1.0              ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ─── Dependency checks ───────────────────────────────────────────────────────

check_command() {
  if ! command -v "$1" &>/dev/null; then
    fail "$1 is not installed. $2"
    exit 1
  fi
}

check_command "node" "Install Node.js 18+ from https://nodejs.org"
check_command "npm"  "npm should come with Node.js — reinstall Node.js from https://nodejs.org"
check_command "curl" "Install curl: apt install curl  (or your package manager)"

# Verify Node.js version >= 18
NODE_VERSION="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
if [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" -lt 18 ] 2>/dev/null; then
  fail "Node.js 18+ required (found v${NODE_VERSION}). Update from https://nodejs.org"
  exit 1
fi
ok "Node.js $(node -v)"

# ─── Helper: read/write .env ─────────────────────────────────────────────────
env_get() {
  [ -f "$ENV_FILE" ] && grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

env_set() {
  local key="$1" val="$2"
  # Escape sed-special characters in the value to prevent injection
  local escaped_val
  escaped_val="$(printf '%s\n' "$val" | sed 's/[&/\]/\\&/g')"
  if [ -f "$ENV_FILE" ] && grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${escaped_val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

print_deepgram_help() {
  echo -e "  ${DIM}Official docs:${NC} ${CYAN}https://developers.deepgram.com/docs/create-additional-api-keys${NC}"
  echo -e "  ${DIM}Quick path:${NC}"
  info "1. Sign in to the Deepgram Console."
  info "2. Pick your Project from the top-left project selector."
  info "3. Open Settings -> API Keys."
  info "4. Click Create a New API Key."
  info "5. Copy the secret now. Deepgram only shows it once."
}

print_openrouter_help() {
  echo -e "  ${DIM}Official docs:${NC} ${CYAN}https://openrouter.ai/docs/api-keys${NC}"
  info "1. Sign in to OpenRouter."
  info "2. Create an API key and optionally set a credit limit."
  info "3. Use base URL https://openrouter.ai/api/v1."
  info "4. Pick any OpenAI-compatible chat model you want to use."
}

print_groq_help() {
  echo -e "  ${DIM}Official docs:${NC} ${CYAN}https://console.groq.com/docs/openai${NC}"
  echo -e "  ${DIM}Key page:${NC} ${CYAN}https://console.groq.com/keys${NC}"
  info "1. Sign in to GroqCloud."
  info "2. Open the API Keys page and create a key."
  info "3. Use base URL https://api.groq.com/openai/v1."
  info "4. Groq is OpenAI-compatible, so MayaClone can call it directly."
}

print_openai_help() {
  echo -e "  ${DIM}Official quickstart:${NC} ${CYAN}https://platform.openai.com/docs/quickstart${NC}"
  info "1. Sign in to the OpenAI Platform dashboard."
  info "2. Open the API keys page in the dashboard."
  info "3. Create a project key and copy it now."
  info "4. Use base URL https://api.openai.com/v1."
}

print_gemini_help() {
  echo -e "  ${DIM}Official OpenAI-compat docs:${NC} ${CYAN}https://ai.google.dev/gemini-api/docs/openai${NC}"
  echo -e "  ${DIM}API key page:${NC} ${CYAN}https://aistudio.google.com/app/apikey${NC}"
  info "1. Open Google AI Studio and create a Gemini API key."
  info "2. Use base URL https://generativelanguage.googleapis.com/v1beta/openai."
  info "3. Gemini works with MayaClone through Google's OpenAI-compatible endpoint."
  info "4. Good starting model: gemini-2.5-flash or your preferred Gemini OpenAI-compatible model."
}

print_tts_docker_help() {
  local current_tts_endpoint="${1:-http://localhost:8002}"
  local is_local_tts="0"
  case "$current_tts_endpoint" in
    http://localhost:8002|http://127.0.0.1:8002|https://localhost:8002|https://127.0.0.1:8002)
      is_local_tts="1"
      ;;
  esac

  echo -e "  ${BOLD}  Docker TTS Setup${NC}"
  info "MayaClone expects the Vox voice server at TTS_ENDPOINT."
  info "Current TTS endpoint: ${current_tts_endpoint}"
  info "Recommended public image: quant359/voxmaya-v1:latest"
  echo -e "  ${DIM}Requirements:${NC} Docker + NVIDIA Container Toolkit + NVIDIA GPU"
  echo ""

  if [ "$is_local_tts" = "1" ]; then
    info "Pull the image:"
    echo "    docker pull quant359/voxmaya-v1:latest"
    echo ""
    info "Run the container:"
    echo "    docker run -d \\"
    echo "      --name voxmaya-v1 \\"
    echo "      --restart unless-stopped \\"
    echo "      --gpus all \\"
    echo "      -p 8002:8002 \\"
    echo "      -v voxmaya_outputs:/data/outputs \\"
    echo "      quant359/voxmaya-v1:latest"
    echo ""
  else
    info "You selected a remote Vox server, so MayaClone will not use localhost."
    info "Make sure that host is reachable from this machine and that port 8002 is open."
    echo ""
  fi

  info "Health check:"
  echo "    curl ${current_tts_endpoint}/health"
  echo ""
  info "If your TTS server exposes /v1/health instead, check that path instead."
}

detect_llm_provider() {
  local base_url="$1"
  case "$base_url" in
    "https://openrouter.ai/api/v1") echo "1" ;;
    "https://api.groq.com/openai/v1") echo "2" ;;
    "https://api.openai.com/v1") echo "3" ;;
    "https://generativelanguage.googleapis.com/v1beta/openai") echo "4" ;;
    *) echo "5" ;;
  esac
}

provider_name() {
  case "$1" in
    1) echo "OpenRouter" ;;
    2) echo "Groq" ;;
    3) echo "OpenAI" ;;
    4) echo "Gemini" ;;
    5) echo "Custom" ;;
    *) echo "Unknown" ;;
  esac
}

# ─── Create .env if missing ───────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  ok "Created .env from template"
fi

# ─── Check if already fully configured ───────────────────────────────────────
DG_KEY="$(env_get DEEPGRAM_API_KEY)"
LLM_KEY="$(env_get LLM_API_KEY)"
CONFIGURED=1
RECONFIGURE=0
if [ -z "$DG_KEY" ] || [ "$DG_KEY" = "your_deepgram_api_key" ]; then CONFIGURED=0; fi
if [ -z "$LLM_KEY" ] || [ "$LLM_KEY" = "your_llm_api_key" ]; then CONFIGURED=0; fi

if [ "$CONFIGURED" -eq 1 ]; then
  echo -e "${BOLD}  Existing configuration detected.${NC}"
  ask "Do you want to change any setup answers before startup? [y/N]: "
  read -r CHANGE_SETUP
  if [[ "$CHANGE_SETUP" =~ ^[Yy] ]]; then
    RECONFIGURE=1
    echo ""
  else
    ok "Keeping existing configuration"
    echo ""
  fi
fi

# ─── Setup wizard (only when not configured) ──────────────────────────────────
if [ "$CONFIGURED" -eq 0 ] || [ "$RECONFIGURE" -eq 1 ]; then
  if [ "$RECONFIGURE" -eq 1 ]; then
    echo -e "${YELLOW}  Updating existing MayaClone configuration.${NC}"
  else
    echo -e "${YELLOW}  First-time setup — let's configure MayaClone.${NC}"
  fi
  echo ""

  # Deepgram
  echo -e "${BOLD}  Deepgram API Key (Speech-to-Text)${NC}"
  print_deepgram_help
  if [ "$RECONFIGURE" -eq 1 ]; then
    ask "Deepgram key [Enter to keep current]: "
  else
    ask "Deepgram key: "
  fi
  read -r DG_INPUT
  if [ -n "$DG_INPUT" ]; then
    env_set "DEEPGRAM_API_KEY" "$DG_INPUT"
    ok "Saved"
  elif [ "$RECONFIGURE" -eq 1 ]; then
    ok "Keeping current Deepgram key"
  fi

  echo ""

  # LLM
  echo -e "${BOLD}  LLM Provider${NC}"
  echo -e "  ${CYAN}1)${NC} OpenRouter ${DIM}(easy starting point, many models)${NC}"
  echo -e "  ${CYAN}2)${NC} Groq       ${DIM}(optional alternative)${NC}"
  echo -e "  ${CYAN}3)${NC} OpenAI     ${DIM}(direct OpenAI API)${NC}"
  echo -e "  ${CYAN}4)${NC} Gemini     ${DIM}(Google OpenAI-compatible endpoint)${NC}"
  echo -e "  ${CYAN}5)${NC} Custom     ${DIM}(Ollama, vLLM, etc.)${NC}"
  CURRENT_LLM_BASE_URL="$(env_get LLM_BASE_URL)"
  CURRENT_LLM_MODEL="$(env_get LLM_MODEL)"
  CURRENT_PROVIDER="$(detect_llm_provider "$CURRENT_LLM_BASE_URL")"
  CURRENT_PROVIDER_NAME="$(provider_name "$CURRENT_PROVIDER")"
  info "Current provider: ${CURRENT_PROVIDER_NAME}${CURRENT_LLM_MODEL:+ (${CURRENT_LLM_MODEL})}"
  ask "Provider [1-5, Enter to keep current]: "
  read -r PROV
  PROV="${PROV:-$CURRENT_PROVIDER}"

  # Validate provider selection
  if ! [[ "$PROV" =~ ^[1-5]$ ]]; then
    warn "Invalid selection '${PROV}' — keeping current provider (${CURRENT_PROVIDER_NAME})"
    PROV="$CURRENT_PROVIDER"
  fi

  case "$PROV" in
    1)
      env_set "LLM_BASE_URL" "https://openrouter.ai/api/v1"
      print_openrouter_help
      ask "OpenRouter key [Enter to keep current]: "; read -r K; [ -n "$K" ] && env_set "LLM_API_KEY" "$K"
      ask "Model [default=${CURRENT_LLM_MODEL:-openai/gpt-4o-mini}]: "; read -r M
      M="${M:-${CURRENT_LLM_MODEL:-openai/gpt-4o-mini}}"; env_set "LLM_MODEL" "$M"
      ok "OpenRouter configured";;
    2)
      env_set "LLM_BASE_URL" "https://api.groq.com/openai/v1"
      print_groq_help
      ask "Groq key [Enter to keep current]: "; read -r K; [ -n "$K" ] && env_set "LLM_API_KEY" "$K"
      ask "Model [default=${CURRENT_LLM_MODEL:-llama-3.3-70b-versatile}]: "; read -r M
      M="${M:-${CURRENT_LLM_MODEL:-llama-3.3-70b-versatile}}"; env_set "LLM_MODEL" "$M"
      ok "Groq configured";;
    3)
      env_set "LLM_BASE_URL" "https://api.openai.com/v1"
      print_openai_help
      ask "OpenAI key [Enter to keep current]: "; read -r K; [ -n "$K" ] && env_set "LLM_API_KEY" "$K"
      ask "Model [default=${CURRENT_LLM_MODEL:-gpt-4o-mini}]: "; read -r M
      M="${M:-${CURRENT_LLM_MODEL:-gpt-4o-mini}}"; env_set "LLM_MODEL" "$M"
      ok "OpenAI configured";;
    4)
      env_set "LLM_BASE_URL" "https://generativelanguage.googleapis.com/v1beta/openai"
      print_gemini_help
      ask "Gemini key [Enter to keep current]: "; read -r K; [ -n "$K" ] && env_set "LLM_API_KEY" "$K"
      ask "Model [default=${CURRENT_LLM_MODEL:-gemini-2.5-flash}]: "; read -r M
      M="${M:-${CURRENT_LLM_MODEL:-gemini-2.5-flash}}"; env_set "LLM_MODEL" "$M"
      ok "Gemini configured";;
    5)
      ask "Base URL [default=${CURRENT_LLM_BASE_URL:-http://localhost:11434/v1}]: "; read -r U
      U="${U:-${CURRENT_LLM_BASE_URL:-http://localhost:11434/v1}}"
      [ -n "$U" ] && env_set "LLM_BASE_URL" "$U"
      ask "API key [Enter to keep current, type 'none' to clear]: "; read -r K
      if [ "$K" = "none" ]; then
        env_set "LLM_API_KEY" ""
        ok "API key cleared"
      elif [ -n "$K" ]; then
        env_set "LLM_API_KEY" "$K"
      fi
      ask "Model name [default=${CURRENT_LLM_MODEL:-}]: "; read -r M
      M="${M:-${CURRENT_LLM_MODEL:-}}"; [ -n "$M" ] && env_set "LLM_MODEL" "$M"
      ok "Custom provider configured";;
  esac

  echo ""

  # TTS endpoint
  CURRENT_TTS_ENDPOINT="$(env_get TTS_ENDPOINT)"
  CURRENT_TTS_ENDPOINT="${CURRENT_TTS_ENDPOINT:-http://localhost:8002}"
  env_set "TTS_BACKEND" "vox"
  echo -e "${BOLD}  TTS Endpoint${NC}"
  info "This MayaClone build uses Vox only."
  info "Current Vox endpoint: ${CURRENT_TTS_ENDPOINT}"
  info "Local default: http://localhost:8002"
  info "Remote example: http://your-server-ip:8002"
  ask "Change TTS endpoint? [y/N]: "
  read -r CHANGE_TTS_ENDPOINT
  if [[ "$CHANGE_TTS_ENDPOINT" =~ ^[Yy] ]]; then
    ask "TTS endpoint [default=${CURRENT_TTS_ENDPOINT}]: "
    read -r TTS_INPUT
    TTS_INPUT="${TTS_INPUT:-$CURRENT_TTS_ENDPOINT}"
    TTS_INPUT="$(printf '%s' "$TTS_INPUT" | sed 's:/*$::')"
    if [ -z "$TTS_INPUT" ]; then
      TTS_INPUT="http://localhost:8002"
    fi
    env_set "TTS_ENDPOINT" "$TTS_INPUT"
    ok "Saved TTS endpoint: $TTS_INPUT"
    echo ""
  fi

  echo ""

  # HTTPS
  echo -e "${BOLD}  HTTPS (for remote access)${NC}"
  echo -e "  ${DIM}Required if accessing from another device. Localhost is fine without it.${NC}"
  ask "Generate self-signed SSL certs? [y/N]: "; read -r SSL
  if [[ "$SSL" =~ ^[Yy] ]]; then
    if ! command -v openssl &>/dev/null; then
      warn "openssl is not installed — skipping cert generation"
      info "Install openssl: apt install openssl  (or your package manager)"
    else
      mkdir -p "$ROOT_DIR/certs"
      openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$ROOT_DIR/certs/key.pem" -out "$ROOT_DIR/certs/cert.pem" \
        -days 365 -subj "/CN=localhost" 2>/dev/null
      ok "SSL certs generated in certs/"
      echo -e "  ${DIM}Browser will warn about self-signed cert — click Advanced → Proceed.${NC}"
    fi
  fi

  echo ""
else
  ok "Config found — skipping setup wizard"
fi

# ─── Load environment ─────────────────────────────────────────────────────────
# Source .env line-by-line to handle values with special characters safely.
while IFS='=' read -r key value; do
  # Skip comments and blank lines
  [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
  # Trim leading/trailing whitespace from key
  key="$(printf '%s' "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -z "$key" ] && continue
  export "$key=$value"
done < "$ENV_FILE"

# ─── Install Node deps ────────────────────────────────────────────────────────
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo -e "  ${DIM}Installing Node.js dependencies...${NC}"
  if npm install --prefix "$ROOT_DIR" 2>&1 | tail -5; then
    ok "Node.js dependencies installed"
  else
    fail "npm install failed — check the output above"
    exit 1
  fi
fi

# ─── TTS check ────────────────────────────────────────────────────────────────
TTS_EP="${TTS_ENDPOINT:-http://localhost:8002}"
if curl -sf --max-time 5 "${TTS_EP}/health" &>/dev/null || curl -sf --max-time 5 "${TTS_EP}/v1/health" &>/dev/null; then
  ok "Vox server reachable at ${TTS_EP}"
else
  warn "Vox server not reachable at ${TTS_EP} — speech output will fail until it is running"
  echo ""
  print_tts_docker_help "$TTS_EP"
  echo ""
fi

# ─── Validate required keys ───────────────────────────────────────────────────
MISSING=0
DG="$(env_get DEEPGRAM_API_KEY)"; LK="$(env_get LLM_API_KEY)"
if [ -z "$DG" ] || [ "$DG" = "your_deepgram_api_key" ]; then fail "DEEPGRAM_API_KEY not set in .env"; MISSING=1; fi
if [ -z "$LK" ] || [ "$LK" = "your_llm_api_key" ]; then fail "LLM_API_KEY not set in .env"; MISSING=1; fi
if [ "$MISSING" -eq 1 ]; then
  echo ""
  warn "Edit .env with the missing keys and run again."
  exit 1
fi

ok "All checks passed"
echo ""
echo -e "${GREEN}${BOLD}  🚀  Starting MayaClone on port ${PORT:-3000}...${NC}"
echo ""
cd "$ROOT_DIR" && node server.js
