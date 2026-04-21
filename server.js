#!/usr/bin/env node
/**
 * MayaClone — Open-source voice chat server
 *
 * Voice pipeline: Mic → Deepgram STT → LLM (OpenAI-compatible) → EchoTTS → Speaker
 */

// Always load MayaClone's own .env (not whatever the current working directory happens to be).
// dotenv will not override already-exported environment variables by default.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const http = require("http");
const express = require("express");
const { Server: SocketIO } = require("socket.io");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { encode } = require("gpt-tokenizer");

// Mirror console output into a persistent app log. Keep this before most startup work
// so setup failures are captured too.
const LOG_DIR = process.env.MAYACLONE_LOG_DIR || path.join(__dirname, "logs");
const LOG_FILE = process.env.MAYACLONE_LOG_FILE || path.join(LOG_DIR, "mayaclone-app.log");
try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
    console.error("[logger] Could not create log dir:", err.message);
}
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
const redactSecrets = (value) => String(value).replace(/(gsk_|sk-|dg_)[A-Za-z0-9_-]{12,}/g, "$1[redacted]");
const formatLogPart = (part) => {
    if (part instanceof Error) return part.stack || part.message;
    if (typeof part === "string") return part;
    try {
        return JSON.stringify(part);
    } catch {
        return String(part);
    }
};
for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        const line = redactSecrets(args.map(formatLogPart).join(" "));
        logStream.write(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${line}\n`);
        original(...args);
    };
}
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (err) => {
    console.error("[unhandledRejection]", err);
});

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const TTS_ENDPOINT = String(process.env.TTS_ENDPOINT || "http://192.168.2.206:8002").replace(/\/+$/, "");
const TTS_BACKEND = String(process.env.TTS_BACKEND || "vox").trim().toLowerCase();
const IS_VOX_TTS = TTS_BACKEND === "vox" || /:\d+\/?$/.test(TTS_ENDPOINT) && TTS_ENDPOINT.includes("8002");
const TTS_VOICE = process.env.TTS_VOICE || (IS_VOX_TTS ? "loaded_model" : "mayalong9");
const CONFIG_DIR = path.join(__dirname, "config");
const LLM_BASE_URL = String(process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "moonshotai/kimi-k2-instruct-0905";
const LLM_CHAT_COMPLETIONS_URL = new URL("chat/completions", `${LLM_BASE_URL}/`).toString();
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || 300;
const LLM_MAX_CONTEXT_TOKENS = Number(process.env.LLM_MAX_CONTEXT_TOKENS) || 128000;
const LLM_BOOTSTRAP_TEMPERATURE = Number.isFinite(Number(process.env.LLM_TEMPERATURE)) ? Number(process.env.LLM_TEMPERATURE) : 0.78;
const LLM_BOOTSTRAP_TOP_P = Number.isFinite(Number(process.env.LLM_TOP_P)) ? Number(process.env.LLM_TOP_P) : 0.92;
const LLM_SETTINGS_FILE = path.join(CONFIG_DIR, "llm-provider-settings.json");
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const RAW_DEEPGRAM_MODEL = (process.env.DEEPGRAM_MODEL || "nova-3").trim();
const DEEPGRAM_MODEL = RAW_DEEPGRAM_MODEL.toLowerCase() === "flux"
    ? "flux-general-en"
    : (RAW_DEEPGRAM_MODEL || "nova-3");
const DEEPGRAM_IS_FLUX = /^flux($|-)/i.test(DEEPGRAM_MODEL);
const FLUX_EAGER_EOT_THRESHOLD = (process.env.FLUX_EAGER_EOT_THRESHOLD || "").trim();
const FLUX_EOT_THRESHOLD = (process.env.FLUX_EOT_THRESHOLD || "").trim();
const FLUX_EOT_TIMEOUT_MS = (process.env.FLUX_EOT_TIMEOUT_MS || "").trim();
const DEEPGRAM_KEEPALIVE_MS = Math.max(10000, Number(process.env.DEEPGRAM_KEEPALIVE_MS) || 20000);

// Load Maya system prompt — first check for a user-customized override, then fall back to the default.
const SYSTEM_PROMPT_FILE = path.join(CONFIG_DIR, "system-prompt.md");
const DEFAULT_PROMPT_FILE = path.join(__dirname, "prompts", "maya.md");
const DEFAULT_PROMPT_FALLBACK = "You are Maya, a friendly and charismatic young woman. Be natural and conversational.";

function loadSystemPrompt() {
    // Prefer user-saved custom prompt
    if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
        try {
            return fs.readFileSync(SYSTEM_PROMPT_FILE, "utf-8").trim();
        } catch (err) {
            console.warn("[WARN] Could not read custom system prompt:", err.message);
        }
    }
    // Fall back to default
    try {
        return fs.readFileSync(DEFAULT_PROMPT_FILE, "utf-8").trim();
    } catch (err) {
        console.warn("[WARN] Could not load prompts/maya.md:", err.message);
        return DEFAULT_PROMPT_FALLBACK;
    }
}

let SYSTEM_PROMPT = loadSystemPrompt();

// Load silence triggers
const SILENCE_CONFIG = (() => {
    const cfgPath = path.join(CONFIG_DIR, "silence-triggers.json");
    try {
        return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    } catch (err) {
        return { enabled: false, triggers: [], openingMessages: {} };
    }
})();

function saveSilenceConfig() {
    const cfgPath = path.join(CONFIG_DIR, "silence-triggers.json");
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(SILENCE_CONFIG, null, 2));
}

const BUILTIN_LLM_PROFILE_PRESETS = {
    groq_kimi_k2: {
        id: "groq_kimi_k2",
        profile_name: "Groq (Kimi K2)",
        provider_kind: "openai_compatible",
        base_url: "https://api.groq.com/openai/v1",
        api_key: "",
        model: "moonshotai/kimi-k2-instruct-0905",
        max_output_tokens: 1000,
        max_context_tokens: 128000,
        temperature: LLM_BOOTSTRAP_TEMPERATURE,
        repetition_penalty: 0,
        top_p: LLM_BOOTSTRAP_TOP_P,
        top_k: 0,
        min_p: 0,
        presence_penalty: 0.15,
        frequency_penalty: 0.28,
        disable_thinking: false,
    },
    cloudflare_gemma_4_26b: {
        id: "cloudflare_gemma_4_26b",
        profile_name: "Cloudflare (Gemma 4 26B)",
        provider_kind: "openai_compatible",
        base_url: "https://api.cloudflare.com/client/v4/accounts/3228f46b15312a719ac37de24addc488/ai/v1",
        api_key: "",
        model: "@cf/google/gemma-4-26b-a4b-it",
        max_output_tokens: 1000,
        max_context_tokens: 128000,
        temperature: 0.78,
        repetition_penalty: 0,
        top_p: 0.92,
        top_k: 0,
        min_p: 0,
        presence_penalty: 0.15,
        frequency_penalty: 0.28,
        disable_thinking: false,
    },
    deepinfra_gemma_4_31b: {
        id: "deepinfra_gemma_4_31b",
        profile_name: "DeepInfra (Gemma 4 31B)",
        provider_kind: "openai_compatible",
        base_url: "https://api.deepinfra.com/v1/openai",
        api_key: "",
        model: "google/gemma-4-31B-it",
        max_output_tokens: 1000,
        max_context_tokens: 128000,
        temperature: 0.78,
        repetition_penalty: 0,
        top_p: 0.92,
        top_k: 0,
        min_p: 0,
        presence_penalty: 0.15,
        frequency_penalty: 0.28,
        disable_thinking: false,
    },
};

function sanitizeUrl(value, fallback) {
    const raw = String(value ?? "").trim();
    return (raw || fallback || "").replace(/\/+$/, "");
}

function sanitizeOptionalNumber(value, fallback = 0) {
    if (value === "" || value == null) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizePositiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function slugifyProfileId(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 64) || "profile";
}

function normalizeLlmSettings(raw = {}) {
    const bootstrapVoxCfg = Number(process.env.VOX_CFG) || 2.0;
    const bootstrapVoxCfg1 = Number.isFinite(Number(process.env.VOX_CFG_1_WORD)) ? Number(process.env.VOX_CFG_1_WORD) : bootstrapVoxCfg;
    const bootstrapVoxCfg2 = Number.isFinite(Number(process.env.VOX_CFG_2_WORDS)) ? Number(process.env.VOX_CFG_2_WORDS) : bootstrapVoxCfg;
    const bootstrapVoxCfg3 = Number.isFinite(Number(process.env.VOX_CFG_3_WORDS)) ? Number(process.env.VOX_CFG_3_WORDS) : bootstrapVoxCfg;
    const bootstrapVoxCfg4 = Number.isFinite(Number(process.env.VOX_CFG_4_WORDS)) ? Number(process.env.VOX_CFG_4_WORDS) : bootstrapVoxCfg;
    const bootstrapVoxTemp1 = Number.isFinite(Number(process.env.VOX_TEMP_1_WORD)) ? Number(process.env.VOX_TEMP_1_WORD) : 1.6;
    const bootstrapVoxTemp2 = Number.isFinite(Number(process.env.VOX_TEMP_2_WORDS)) ? Number(process.env.VOX_TEMP_2_WORDS) : 1.4;
    const bootstrapVoxTemp3 = Number.isFinite(Number(process.env.VOX_TEMP_3_WORDS)) ? Number(process.env.VOX_TEMP_3_WORDS) : 1.3;
    const bootstrapVoxTemp4 = Number.isFinite(Number(process.env.VOX_TEMP_4_WORDS)) ? Number(process.env.VOX_TEMP_4_WORDS) : 1.2;
    return {
        profile_name: String(raw.profile_name || raw.name || "Custom Profile").trim() || "Custom Profile",
        provider_kind: "openai_compatible",
        base_url: sanitizeUrl(raw.base_url, LLM_BASE_URL),
        api_key: typeof raw.api_key === "string" ? raw.api_key : LLM_API_KEY,
        model: String(raw.model || LLM_MODEL).trim() || LLM_MODEL,
        max_output_tokens: sanitizePositiveInt(raw.max_output_tokens, LLM_MAX_TOKENS),
        max_context_tokens: sanitizePositiveInt(raw.max_context_tokens, LLM_MAX_CONTEXT_TOKENS),
        temperature: sanitizeOptionalNumber(raw.temperature, 0.78),
        repetition_penalty: sanitizeOptionalNumber(raw.repetition_penalty, 0),
        top_p: sanitizeOptionalNumber(raw.top_p, 0.92),
        top_k: sanitizeOptionalNumber(raw.top_k, 0),
        min_p: sanitizeOptionalNumber(raw.min_p, 0),
        presence_penalty: sanitizeOptionalNumber(raw.presence_penalty, 0.15),
        frequency_penalty: sanitizeOptionalNumber(raw.frequency_penalty, 0.28),
        disable_thinking: Boolean(raw.disable_thinking),
    };
}

function normalizeVoxTtsSettings(raw = {}) {
    const bootstrapTtsEndpoint = sanitizeUrl(raw.vox_tts_endpoint, TTS_ENDPOINT);
    const bootstrapContinuationCache = process.env.VOX_CONTINUATION_CACHE ? process.env.VOX_CONTINUATION_CACHE !== "0" : true;
    const bootstrapVoxCfg = Number(process.env.VOX_CFG) || 2.0;
    const bootstrapVoxCfg1 = Number.isFinite(Number(process.env.VOX_CFG_1_WORD)) ? Number(process.env.VOX_CFG_1_WORD) : bootstrapVoxCfg;
    const bootstrapVoxCfg2 = Number.isFinite(Number(process.env.VOX_CFG_2_WORDS)) ? Number(process.env.VOX_CFG_2_WORDS) : bootstrapVoxCfg;
    const bootstrapVoxCfg3 = Number.isFinite(Number(process.env.VOX_CFG_3_WORDS)) ? Number(process.env.VOX_CFG_3_WORDS) : bootstrapVoxCfg;
    const bootstrapVoxCfg4 = Number.isFinite(Number(process.env.VOX_CFG_4_WORDS)) ? Number(process.env.VOX_CFG_4_WORDS) : bootstrapVoxCfg;
    const bootstrapVoxTemp1 = Number.isFinite(Number(process.env.VOX_TEMP_1_WORD)) ? Number(process.env.VOX_TEMP_1_WORD) : 1.6;
    const bootstrapVoxTemp2 = Number.isFinite(Number(process.env.VOX_TEMP_2_WORDS)) ? Number(process.env.VOX_TEMP_2_WORDS) : 1.4;
    const bootstrapVoxTemp3 = Number.isFinite(Number(process.env.VOX_TEMP_3_WORDS)) ? Number(process.env.VOX_TEMP_3_WORDS) : 1.3;
    const bootstrapVoxTemp4 = Number.isFinite(Number(process.env.VOX_TEMP_4_WORDS)) ? Number(process.env.VOX_TEMP_4_WORDS) : 1.2;
    const bootstrapVoxSeamMs = Number.isFinite(Number(process.env.VOX_SEAM_MS)) ? Number(process.env.VOX_SEAM_MS) : 45;
    const bootstrapChunkTargets = parseChunkSchedule(
        process.env.TTS_TOKEN_TARGETS,
        IS_VOX_TTS ? [10, 28, 42, 50, 55, 55, 60, 60] : [15, 40, 50, 50, 50, 50, 60, 60, 61]
    );
    return {
        vox_tts_endpoint: bootstrapTtsEndpoint,
        vox_continuation_cache_enabled: typeof raw.vox_continuation_cache_enabled === "boolean"
            ? raw.vox_continuation_cache_enabled
            : bootstrapContinuationCache,
        vox_cfg: sanitizeOptionalNumber(raw.vox_cfg, bootstrapVoxCfg),
        vox_cfg_1_word: sanitizeOptionalNumber(raw.vox_cfg_1_word, bootstrapVoxCfg1),
        vox_cfg_2_words: sanitizeOptionalNumber(raw.vox_cfg_2_words, bootstrapVoxCfg2),
        vox_cfg_3_words: sanitizeOptionalNumber(raw.vox_cfg_3_words, bootstrapVoxCfg3),
        vox_cfg_4_words: sanitizeOptionalNumber(raw.vox_cfg_4_words, bootstrapVoxCfg4),
        vox_temperature_default: sanitizeOptionalNumber(raw.vox_temperature_default, 0),
        vox_temp_1_word: sanitizeOptionalNumber(raw.vox_temp_1_word, bootstrapVoxTemp1),
        vox_temp_2_words: sanitizeOptionalNumber(raw.vox_temp_2_words, bootstrapVoxTemp2),
        vox_temp_3_words: sanitizeOptionalNumber(raw.vox_temp_3_words, bootstrapVoxTemp3),
        vox_temp_4_words: sanitizeOptionalNumber(raw.vox_temp_4_words, bootstrapVoxTemp4),
        vox_seam_ms: Math.max(0, Math.round(sanitizeOptionalNumber(raw.vox_seam_ms, bootstrapVoxSeamMs))),
        vox_chunk_length_1: Math.max(1, Math.round(sanitizeOptionalNumber(raw.vox_chunk_length_1, bootstrapChunkTargets[0] ?? 10))),
        vox_chunk_length_2: Math.max(1, Math.round(sanitizeOptionalNumber(raw.vox_chunk_length_2, bootstrapChunkTargets[1] ?? bootstrapChunkTargets[0] ?? 28))),
        vox_chunk_length_3: Math.max(1, Math.round(sanitizeOptionalNumber(raw.vox_chunk_length_3, bootstrapChunkTargets[2] ?? bootstrapChunkTargets[1] ?? 42))),
    };
}

function createInitialLlmSettingsState() {
    const basePreset = normalizeLlmSettings({
        ...BUILTIN_LLM_PROFILE_PRESETS.groq_kimi_k2,
        base_url: LLM_BASE_URL || BUILTIN_LLM_PROFILE_PRESETS.groq_kimi_k2.base_url,
        api_key: LLM_API_KEY || BUILTIN_LLM_PROFILE_PRESETS.groq_kimi_k2.api_key,
        model: LLM_MODEL || BUILTIN_LLM_PROFILE_PRESETS.groq_kimi_k2.model,
        max_output_tokens: LLM_MAX_TOKENS || BUILTIN_LLM_PROFILE_PRESETS.groq_kimi_k2.max_output_tokens,
        max_context_tokens: LLM_MAX_CONTEXT_TOKENS || BUILTIN_LLM_PROFILE_PRESETS.groq_kimi_k2.max_context_tokens,
    });
    return {
        active_profile_id: "groq_kimi_k2",
        active_settings: basePreset,
        vox_tts_settings: normalizeVoxTtsSettings({}),
        profiles: {
            groq_kimi_k2: {
                id: "groq_kimi_k2",
                ...basePreset,
                profile_name: "Groq (Kimi K2)",
            },
        },
    };
}

function saveLlmSettingsState(state) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(LLM_SETTINGS_FILE, JSON.stringify(state, null, 2));
}

function loadLlmSettingsState() {
    const initialState = createInitialLlmSettingsState();
    try {
        if (!fs.existsSync(LLM_SETTINGS_FILE)) {
            saveLlmSettingsState(initialState);
            return initialState;
        }
        const raw = JSON.parse(fs.readFileSync(LLM_SETTINGS_FILE, "utf-8"));
        const profiles = {};
        for (const [id, profile] of Object.entries(raw?.profiles || {})) {
            profiles[id] = { id, ...normalizeLlmSettings(profile), profile_name: String(profile?.profile_name || profile?.name || id).trim() || id };
        }
        if (!profiles.groq_kimi_k2) {
            profiles.groq_kimi_k2 = { id: "groq_kimi_k2", ...normalizeLlmSettings(BUILTIN_LLM_PROFILE_PRESETS.groq_kimi_k2), profile_name: "Groq (Kimi K2)" };
        }
        if (!profiles.cloudflare_gemma_4_26b) {
            profiles.cloudflare_gemma_4_26b = {
                id: "cloudflare_gemma_4_26b",
                ...normalizeLlmSettings(BUILTIN_LLM_PROFILE_PRESETS.cloudflare_gemma_4_26b),
                profile_name: "Cloudflare (Gemma 4 26B)",
            };
        }
        if (!profiles.deepinfra_gemma_4_31b) {
            profiles.deepinfra_gemma_4_31b = {
                id: "deepinfra_gemma_4_31b",
                ...normalizeLlmSettings(BUILTIN_LLM_PROFILE_PRESETS.deepinfra_gemma_4_31b),
                profile_name: "DeepInfra (Gemma 4 31B)",
            };
        }
        const activeProfileId = raw?.active_profile_id && profiles[raw.active_profile_id] ? raw.active_profile_id : "groq_kimi_k2";
        const activeSettings = normalizeLlmSettings(raw?.active_settings || profiles[activeProfileId] || initialState.active_settings);
        const voxTtsSettings = normalizeVoxTtsSettings(
            raw?.vox_tts_settings
            || raw?.active_settings
            || profiles[activeProfileId]
            || initialState.vox_tts_settings
        );
        const normalized = { active_profile_id: activeProfileId, active_settings: activeSettings, vox_tts_settings: voxTtsSettings, profiles };
        saveLlmSettingsState(normalized);
        return normalized;
    } catch (err) {
        console.warn("[LLM] Could not load provider settings file, using bootstrap defaults:", err.message);
        saveLlmSettingsState(initialState);
        return initialState;
    }
}

let llmSettingsState = loadLlmSettingsState();

function getActiveLlmSettings() {
    return normalizeLlmSettings(llmSettingsState.active_settings || {});
}

function getVoxTtsSettings() {
    return normalizeVoxTtsSettings(llmSettingsState.vox_tts_settings || {});
}

function getTtsTokenTargets() {
    const vox = getVoxTtsSettings();
    if (!IS_VOX_TTS) return [...TTS_TOKEN_TARGETS];
    const defaults = [...TTS_TOKEN_TARGETS];
    defaults[0] = Math.max(1, Number(vox.vox_chunk_length_1) || defaults[0] || 10);
    defaults[1] = Math.max(1, Number(vox.vox_chunk_length_2) || defaults[1] || defaults[0] || 28);
    defaults[2] = Math.max(1, Number(vox.vox_chunk_length_3) || defaults[2] || defaults[1] || 42);
    return defaults;
}

function getLlmSettingsPayload() {
    return {
        active_profile_id: llmSettingsState.active_profile_id || "",
        active_settings: getActiveLlmSettings(),
        vox_tts_settings: getVoxTtsSettings(),
        silence_triggers_enabled: Boolean(SILENCE_CONFIG.enabled),
        disable_opening_message: Boolean(SILENCE_CONFIG.disableOpeningMessage),
        profiles: Object.values(llmSettingsState.profiles || {}).sort((a, b) => a.profile_name.localeCompare(b.profile_name)),
        provider_options: [
            { id: "openai_compatible", label: "OpenAI-Compatible" },
        ],
    };
}

function saveActiveLlmSettings(input) {
    const nextSettings = normalizeLlmSettings(input);
    const nextVoxTtsSettings = normalizeVoxTtsSettings(input);
    const nextProfileId = typeof input?.active_profile_id === "string" ? input.active_profile_id.trim() : "";
    if (nextProfileId && llmSettingsState.profiles[nextProfileId]) {
        const existingProfile = llmSettingsState.profiles[nextProfileId];
        llmSettingsState.profiles[nextProfileId] = {
            ...existingProfile,
            ...nextSettings,
            id: nextProfileId,
            profile_name: String(input?.profile_name || existingProfile.profile_name || nextSettings.profile_name).trim() || existingProfile.profile_name || "Custom Profile",
        };
        llmSettingsState.active_profile_id = nextProfileId;
        llmSettingsState.active_settings = {
            ...nextSettings,
            profile_name: llmSettingsState.profiles[nextProfileId].profile_name,
        };
    } else {
        llmSettingsState.active_profile_id = "";
        llmSettingsState.active_settings = nextSettings;
    }
    llmSettingsState.vox_tts_settings = nextVoxTtsSettings;
    saveLlmSettingsState(llmSettingsState);
    return getLlmSettingsPayload();
}

function saveNamedLlmProfile(profileName, settings) {
    const normalizedName = String(profileName || "").trim();
    if (!normalizedName) {
        throw new Error("Profile name is required");
    }
    let profileId = slugifyProfileId(normalizedName);
    if (llmSettingsState.profiles[profileId] && llmSettingsState.profiles[profileId].profile_name !== normalizedName) {
        let suffix = 2;
        while (llmSettingsState.profiles[`${profileId}_${suffix}`]) suffix += 1;
        profileId = `${profileId}_${suffix}`;
    }
    llmSettingsState.profiles[profileId] = {
        id: profileId,
        ...normalizeLlmSettings(settings),
        profile_name: normalizedName,
    };
    saveLlmSettingsState(llmSettingsState);
    return { profile_id: profileId, state: getLlmSettingsPayload() };
}

function parseNumberList(value, fallback) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return [...fallback];
    const parsed = raw
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item));
    return parsed.length ? parsed : [...fallback];
}

// TTS preset
const TTS_BLOCK_SIZES = parseNumberList(process.env.TTS_BLOCK_SIZES, [212, 212, 212]);
const TTS_NUM_STEPS = parseNumberList(process.env.TTS_NUM_STEPS, [25, 25, 25]);
const TTS_FIRST_CHUNK_BLOCK_SIZES = parseNumberList(process.env.TTS_FIRST_CHUNK_BLOCK_SIZES, [32, 128, 480]);
const TTS_FIRST_CHUNK_NUM_STEPS = parseNumberList(process.env.TTS_FIRST_CHUNK_NUM_STEPS, [6, 12, 20]);
const TTS_TOKEN_TARGETS = parseChunkSchedule(
    process.env.TTS_TOKEN_TARGETS,
    IS_VOX_TTS ? [10, 28, 42, 50, 55, 55, 60, 60] : [15, 40, 50, 50, 50, 50, 60, 60, 61]
);
const TTS_CHUNK_FLEX = Math.max(1, Number(process.env.TTS_CHUNK_FLEX) || 1.0);
const TTS_CFG_SCALE_TEXT = Number(process.env.TTS_CFG_SCALE_TEXT) || 2.5;
const TTS_CFG_SCALE_SPEAKER = Number(process.env.TTS_CFG_SCALE_SPEAKER) || 5.0;
const TTS_TRUNCATION_FACTOR = Number(process.env.TTS_TRUNCATION_FACTOR) || 0.9;
const TTS_SPEAKER_KV_SCALE = Number(process.env.TTS_SPEAKER_KV_SCALE) || 1.0;
const TTS_SEED = Number(process.env.TTS_SEED) || 0;
const VOX_CFG = Number(process.env.VOX_CFG) || 2.0;
const VOX_MAX_LEN = Math.max(64, Number(process.env.VOX_MAX_LEN) || 384);
const VOX_SEAM_MS = Number.isFinite(Number(process.env.VOX_SEAM_MS)) ? Number(process.env.VOX_SEAM_MS) : 45;
const VOX_SPLIT_STEERS = process.env.VOX_SPLIT_STEERS !== "0";
const VOX_DIT_STEPS = process.env.VOX_DIT_STEPS ? Number(process.env.VOX_DIT_STEPS) : null;
const VOX_CONTINUATION_CACHE = process.env.VOX_CONTINUATION_CACHE ? process.env.VOX_CONTINUATION_CACHE !== "0" : true;
const VOX_EARLY_SPLIT = process.env.VOX_EARLY_SPLIT ? process.env.VOX_EARLY_SPLIT !== "0" : false;
const VOX_MAX_CHUNK_TOKENS = Math.max(16, Number(process.env.VOX_MAX_CHUNK_TOKENS) || 30);
const VOX_MAX_CHUNK_CHARS = Math.max(80, Number(process.env.VOX_MAX_CHUNK_CHARS) || 140);
const VOX_SHORT_WORD_TEMPERATURES = {
    1: Number.isFinite(Number(process.env.VOX_TEMP_1_WORD)) ? Number(process.env.VOX_TEMP_1_WORD) : 1.6,
    2: Number.isFinite(Number(process.env.VOX_TEMP_2_WORDS)) ? Number(process.env.VOX_TEMP_2_WORDS) : 1.4,
    3: Number.isFinite(Number(process.env.VOX_TEMP_3_WORDS)) ? Number(process.env.VOX_TEMP_3_WORDS) : 1.3,
    4: Number.isFinite(Number(process.env.VOX_TEMP_4_WORDS)) ? Number(process.env.VOX_TEMP_4_WORDS) : 1.2,
};
const VOX_POST_FIRST_CHUNK_TOKEN_SLACK = Math.max(0, Number(process.env.VOX_POST_FIRST_CHUNK_TOKEN_SLACK) || 8);
const VOX_POST_FIRST_CHUNK_CHAR_SLACK = Math.max(0, Number(process.env.VOX_POST_FIRST_CHUNK_CHAR_SLACK) || 48);
const TTS_MIN_CHUNK_SIZE_FIRST = Math.max(
    1024,
    Number(process.env.TTS_MIN_CHUNK_SIZE_FIRST) || (IS_VOX_TTS ? 2048 : 4096)
);
const TTS_MIN_CHUNK_SIZE_STREAM = Math.max(
    1024,
    Number(process.env.TTS_MIN_CHUNK_SIZE_STREAM) || (IS_VOX_TTS ? 4096 : 8192)
);
const DEBUG_TTS = process.env.DEBUG_TTS === "1";
const LOG_LLM_RESPONSE_MAX_CHARS = Number(process.env.LOG_LLM_RESPONSE_MAX_CHARS) || 2500;
const LOG_LLM_RESPONSE_TEXT = process.env.LOG_LLM_RESPONSE_TEXT === "1";
const LOG_TTS_VERBOSE = process.env.LOG_TTS_VERBOSE === "1";

function truncateForLog(value, maxChars) {
    const s = String(value || "");
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + `…[+${s.length - maxChars} chars]`;
}

function textForLog(value, maxChars = 0) {
    const s = String(value || "");
    if (!maxChars || s.length <= maxChars) return s;
    return {
        text: s,
        chars: s.length,
        truncated_preview: truncateForLog(s, maxChars),
        extra_chars: s.length - maxChars,
    };
}

function formatMs(ms) {
    if (!Number.isFinite(ms)) return "n/a";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "n/a";
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`;
}

function formatRtfx(elapsedMs, audioMs) {
    if (!Number.isFinite(elapsedMs) || !Number.isFinite(audioMs) || elapsedMs <= 0 || audioMs <= 0) return "n/a";
    return `${(audioMs / elapsedMs).toFixed(2)}x`;
}

function getHostFromBaseUrl(baseUrl) {
    try {
        return new URL(`${String(baseUrl || "").replace(/\/+$/, "")}/`).host.toLowerCase();
    } catch {
        return "";
    }
}

function isCloudflareWorkersAi(llm) {
    return getHostFromBaseUrl(llm?.base_url) === "api.cloudflare.com";
}

function isDeepInfraOpenAi(llm) {
    return getHostFromBaseUrl(llm?.base_url) === "api.deepinfra.com";
}

function isCloudflareGemmaDisableThinkingModel(llm) {
    return isCloudflareWorkersAi(llm) && String(llm?.model || "").trim() === "@cf/google/gemma-4-26b-a4b-it";
}

function sha1Hex(value) {
    return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex");
}

function buildDeepInfraPromptCacheKey(messages, llm, chatId) {
    const stableMessages = Array.isArray(messages) ? messages.slice(0, -1) : [];
    const stablePrefix = stableMessages.map((msg) => `${msg?.role || ""}:${msg?.content || ""}`).join("\n");
    const prefixHash = sha1Hex(stablePrefix).slice(0, 12);
    const modelTag = String(llm?.model || "").trim() || "model";
    const chatTag = String(chatId || "session").trim() || "session";
    return `mayaclone:${chatTag}:${modelTag}:${prefixHash}`;
}

function shortId(value, keep = 8) {
    const s = String(value || "");
    if (!s) return "";
    if (s.length <= keep) return s;
    if (s.startsWith("maya-")) return s.slice(5, 5 + keep);
    return s.slice(0, keep);
}

function logEvent(scope, event, fields = {}) {
    const aliases = {
        chat: "chat_id",
        request: "request_id",
        call: "call_id",
        chunk: "chunk_index",
        chars: "chars",
        tokens: "tokens",
        first_chunk: "is_first_chunk",
        leading_steer: "has_leading_steer",
        repeated_steer: "has_repeated_steer",
        continuation_cache: "continuation_cache",
        user_chars: "user_chars",
        user_tokens: "user_tokens",
        history: "history_count",
        preview: "text",
        latency: "latency",
        elapsed: "elapsed",
        headers: "headers",
        audio: "audio",
        chunks: "pcm_chunks",
        sample_rate: "sample_rate",
        tts_chunks: "tts_chunks",
        tts_subchunks: "tts_subchunks",
        llm_first: "llm_first",
        tts_first: "tts_first",
        tts_ttfs: "tts_ttfs",
        limit_tokens: "limit_tokens",
    };
    const payload = {
        event: `${scope}.${String(event).toUpperCase()}`,
    };
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const outKey = aliases[key] || key;
        payload[outKey] = value;
    }
    console.log(JSON.stringify(payload, null, 2));
}

// ─── HTTP / HTTPS + Socket.IO ────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => {
    const llm = getActiveLlmSettings();
    const vox = getVoxTtsSettings();
    res.json({
        status: "ok",
        llm_model: llm.model,
        llm_base_url: llm.base_url,
        llm_profile: llmSettingsState.active_profile_id || null,
        vox_tts_endpoint: vox.vox_tts_endpoint,
    });
});
app.get("/api/llm-settings", (_, res) => {
    const payload = getLlmSettingsPayload();
    payload.system_prompt = SYSTEM_PROMPT;
    res.json(payload);
});
app.post("/api/llm-settings", (req, res) => {
    try {
        if (typeof req.body?.silence_triggers_enabled === "boolean") {
            SILENCE_CONFIG.enabled = req.body.silence_triggers_enabled;
            saveSilenceConfig();
        }
        if (typeof req.body?.disable_opening_message === "boolean") {
            SILENCE_CONFIG.disableOpeningMessage = req.body.disable_opening_message;
            saveSilenceConfig();
        }
        if (req.body?.reset_system_prompt === true) {
            try {
                if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
                    fs.unlinkSync(SYSTEM_PROMPT_FILE);
                }
                SYSTEM_PROMPT = loadSystemPrompt();
                logEvent("LLM", "system_prompt_reset", { source: DEFAULT_PROMPT_FILE });
            } catch (err) {
                console.error("[ERROR] Could not reset system prompt:", err.message);
            }
        }
        // Save system prompt if provided
        if (typeof req.body?.system_prompt === "string" && req.body.system_prompt.trim()) {
            const newPrompt = req.body.system_prompt.trim();
            try {
                fs.writeFileSync(SYSTEM_PROMPT_FILE, newPrompt, "utf-8");
                SYSTEM_PROMPT = newPrompt;
                logEvent("LLM", "system_prompt_updated", { source: SYSTEM_PROMPT_FILE });
            } catch (err) {
                console.error("[ERROR] Could not save system prompt:", err.message);
            }
        }
        const payload = saveActiveLlmSettings(req.body || {});
        logEvent("LLM", "settings_saved", {
            profile: payload.active_profile_id || "custom",
            model: payload.active_settings.model,
            base_url: payload.active_settings.base_url,
            max_output_tokens: payload.active_settings.max_output_tokens,
            max_context_tokens: payload.active_settings.max_context_tokens,
            silence_triggers_enabled: payload.silence_triggers_enabled,
        });
        payload.system_prompt = SYSTEM_PROMPT;
        res.json(payload);
    } catch (err) {
        res.status(400).json({ error: err.message || "Could not save LLM settings" });
    }
});
app.post("/api/llm-profiles", (req, res) => {
    try {
        const result = saveNamedLlmProfile(req.body?.profile_name, req.body?.settings || {});
        logEvent("LLM", "profile_saved", {
            profile: result.profile_id,
            name: req.body?.profile_name,
        });
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message || "Could not save LLM profile" });
    }
});

// HTTPS: use certs from env or auto-generated self-signed
const SSL_CERT = process.env.SSL_CERT || path.join(__dirname, "certs", "cert.pem");
const SSL_KEY = process.env.SSL_KEY || path.join(__dirname, "certs", "key.pem");
let server;
let protocol = "http";

if (fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
    const https = require("https");
    server = https.createServer(
        { cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) },
        app
    );
    protocol = "https";
} else {
    server = http.createServer(app);
}

const io = new SocketIO(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 4 * 1024 * 1024,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getLanUrl() {
    const interfaces = os.networkInterfaces();
    for (const addresses of Object.values(interfaces)) {
        for (const entry of addresses || []) {
            if (entry && entry.family === "IPv4" && !entry.internal) {
                return `${protocol}://${entry.address}:${PORT}`;
            }
        }
    }
    return null;
}

/** Split text into speakable sentences */
function chunkSentences(text) {
    const sentenceEnders = /([.!?]+[\s]|[.!?]+$)/g;
    const sentences = [];
    let remainder = text;
    let match;
    let lastIndex = 0;

    sentenceEnders.lastIndex = 0;
    while ((match = sentenceEnders.exec(text)) !== null) {
        const end = match.index + match[0].length;
        const sentence = text.slice(lastIndex, end).trim();
        if (sentence) sentences.push(sentence);
        lastIndex = end;
    }
    remainder = text.slice(lastIndex);
    return { sentences, remainder };
}

function estimateMessageTokenCount(messages) {
    return (messages || []).reduce((total, message) => {
        const roleTokens = encode(String(message?.role || "")).length;
        const contentTokens = encode(String(message?.content || "")).length;
        return total + roleTokens + contentTokens + 8;
    }, 4);
}

function isSyntheticHistoryMessage(message) {
    const role = String(message?.role || "");
    const content = String(message?.content || "").trim();
    if (!content) return false;
    if (message?.synthetic === true) return true;
    if (role === "user" && /^\[[^\]]{1,160}\]$/.test(content)) return true;
    return false;
}

function buildContextMessages(history = []) {
    const filtered = (history || [])
        .filter((message) => message && (message.role === "user" || message.role === "assistant"))
        .filter((message) => !isSyntheticHistoryMessage(message))
        .map((message) => ({ role: message.role, content: String(message.content || "") }))
        .filter((message) => message.content.trim());

    const turns = [];
    let pendingUser = null;
    for (const message of filtered) {
        if (message.role === "user") {
            pendingUser = message;
            continue;
        }
        if (message.role === "assistant" && pendingUser) {
            turns.push([pendingUser, message]);
            pendingUser = null;
        }
    }
    return turns.flat();
}

function trimMessagesToContext(messages, maxContextTokens, maxOutputTokens) {
    const contextLimit = sanitizePositiveInt(maxContextTokens, LLM_MAX_CONTEXT_TOKENS);
    const outputLimit = sanitizePositiveInt(maxOutputTokens, LLM_MAX_TOKENS);
    const inputBudget = Math.max(1024, contextLimit - outputLimit - 512);
    if (estimateMessageTokenCount(messages) <= inputBudget) {
        return messages;
    }

    const systemMessages = [];
    const conversationalMessages = [];
    for (const message of messages || []) {
        if (message?.role === "system") systemMessages.push(message);
        else conversationalMessages.push(message);
    }

    const turns = [];
    let pendingUser = null;
    for (const message of conversationalMessages) {
        if (message?.role === "user") {
            pendingUser = message;
            continue;
        }
        if (message?.role === "assistant" && pendingUser) {
            turns.push([pendingUser, message]);
            pendingUser = null;
        }
    }

    const kept = [];
    let runningTotal = estimateMessageTokenCount(systemMessages);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const candidateTurn = turns[index];
        const nextCost = estimateMessageTokenCount(candidateTurn);
        if (kept.length > 0 && runningTotal + nextCost > inputBudget) break;
        kept.unshift(...candidateTurn);
        runningTotal += nextCost;
    }

    return [...systemMessages, ...kept];
}

function splitEarlySpeakableUnit(text, minTokens = 8) {
    if (IS_VOX_TTS && !VOX_EARLY_SPLIT) {
        return { unit: "", remainder: text || "" };
    }
    const normalized = normalizeChunkText(text);
    if (!normalized || estimateTokenCount(normalized) < minTokens) {
        return { unit: "", remainder: text || "" };
    }

    const boundaryRe = /[,;:]\s+|[—–-]\s+/g;
    let bestEnd = -1;
    let match;
    while ((match = boundaryRe.exec(normalized)) !== null) {
        const end = match.index + match[0].length;
        const candidate = normalized.slice(0, end).trim();
        if (candidate.length >= 28 && estimateTokenCount(candidate) >= minTokens) {
            bestEnd = end;
        }
    }

    if (bestEnd < 0 && normalized.length >= 92 && estimateTokenCount(normalized) >= Math.ceil(minTokens * 1.6)) {
        const limit = Math.min(normalized.length, 110);
        bestEnd = normalized.lastIndexOf(" ", limit);
        if (bestEnd < 55) bestEnd = -1;
    }

    if (bestEnd < 0) {
        return { unit: "", remainder: text || "" };
    }

    return {
        unit: normalized.slice(0, bestEnd).trim(),
        remainder: normalized.slice(bestEnd).trimStart(),
    };
}

function normalizeChunkText(text) {
    return repairMalformedLeadingSteer(String(text || "").replace(/\s+/g, " ").trim());
}

function repairMalformedLeadingSteer(text) {
    const normalized = String(text || "").trim();
    if (!normalized.startsWith("(")) return normalized;
    if (normalized.includes(")")) return normalized;

    const colonMatch = normalized.match(/^\(([^()\n]{3,180}?):\s*(.+)$/);
    if (colonMatch && colonMatch[1].includes(" ")) {
        return `(${colonMatch[1].trim()}) ${colonMatch[2].trim()}`;
    }

    const quoteMatch = normalized.match(/^\(([^()\n]{3,180}?)["“]\s*(.+)$/);
    if (quoteMatch && quoteMatch[1].includes(" ")) {
        return `(${quoteMatch[1].trim()}) "${quoteMatch[2].trim()}`;
    }

    return normalized;
}

function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function estimateTokenCount(text) {
    const normalized = normalizeChunkText(text);
    if (!normalized) return 0;
    try {
        return encode(normalized).length;
    } catch (error) {
        console.warn("[tokenizer] Falling back to heuristic token count", error?.message || error);
        return Math.max(1, Math.ceil(normalized.length / 4));
    }
}

function extractLeadingSteer(text) {
    const normalized = normalizeChunkText(text);
    const match = normalized.match(/^\(([^()\n]{2,180})\)\s*(.*)$/);
    if (!match || !match[1].includes(" ")) return null;
    return { steer: match[1].trim(), body: match[2].trim() };
}

function withSteer(text, steer) {
    const normalized = normalizeChunkText(text);
    if (!IS_VOX_TTS || !steer || !normalized || extractLeadingSteer(normalized)) return normalized;
    return `(${steer}) ${normalized}`;
}

function canonicalizeVoxSteerPlacement(text) {
    const normalized = normalizeChunkText(text);
    if (!IS_VOX_TTS || !normalized) return normalized;
    const leading = extractLeadingSteer(normalized);
    const steerLikeMatches = [...normalized.matchAll(/\(([^()\n]{2,180})\)/g)]
        .map((match) => String(match[1] || "").trim())
        .filter((content) => content.includes(" "));
    const steer = leading?.steer || steerLikeMatches[0] || "";
    if (!steer) return normalized;
    const bodySource = leading ? leading.body : normalized;
    const body = bodySource
        .replace(/\s*\(([^()\n]{2,180})\)\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return body ? `(${steer}) ${body}` : `(${steer})`;
}

function shouldUseVoxContinuationCache(text, { previousSteer = "", allowRepeatedSteer = true } = {}) {
    if (!getVoxTtsSettings().vox_continuation_cache_enabled) return false;
    const leading = extractLeadingSteer(canonicalizeVoxSteerPlacement(text));
    if (!leading) return true;
    if (!allowRepeatedSteer) return false;
    return Boolean(previousSteer) && leading.steer === previousSteer;
}

const VOX_WEAK_ENDING_WORDS = new Set([
    "a", "an", "the", "my", "your", "his", "her", "its", "our", "their",
    "this", "that", "these", "those",
    "and", "or", "but", "so", "because", "if", "then", "than",
    "to", "of", "for", "with", "from", "into", "onto", "over", "under", "through",
    "at", "by", "in", "on", "off", "up", "out", "about",
]);
const VOX_COMMON_ADJECTIVE_ENDINGS = ["ed", "ing", "y", "ful", "ous", "ive", "less", "ish", "able", "ible", "al"];

function wordBoundaryPenalty(prefix, suffix) {
    const prefixWords = normalizeChunkText(prefix).split(/\s+/).filter(Boolean);
    const suffixWords = normalizeChunkText(suffix).split(/\s+/).filter(Boolean);
    if (!prefixWords.length || !suffixWords.length) return 0;
    const last = prefixWords[prefixWords.length - 1].replace(/^[^A-Za-z]+|[^A-Za-z-]+$/g, "").toLowerCase();
    const next = suffixWords[0].replace(/^[^A-Za-z]+|[^A-Za-z-]+$/g, "").toLowerCase();
    if (!last || !next) return 0;

    let penalty = 0;
    if (VOX_WEAK_ENDING_WORDS.has(last)) penalty += 6;
    if (/^[a-z]+-[a-z]+$/.test(last)) penalty += 4;
    if (VOX_COMMON_ADJECTIVE_ENDINGS.some((ending) => last.endsWith(ending)) && next.length > 2) penalty += 4;
    if (last.length <= 2 && next.length > 2) penalty += 3;
    if (/^[a-z]+ly$/.test(last)) penalty += 2;
    if (/^[A-Za-z]+$/.test(last) && /^[A-Za-z]+$/.test(next) && /^[a-z]/.test(next) && last.length >= 4 && next.length >= 3) {
        penalty += 1;
    }
    return penalty;
}

function countChunkWords(text) {
    return normalizeChunkText(text).split(/\s+/).filter(Boolean).length;
}

function findPreferredVoxSplit(text, hardLimitTokens, hardLimitChars) {
    const normalized = normalizeChunkText(text);
    if (!normalized) return null;
    const candidates = [];
    const pushCandidate = (index, strength) => {
        if (!Number.isFinite(index) || index <= 0 || index >= normalized.length) return;
        const prefix = normalized.slice(0, index).trim();
        const suffix = normalized.slice(index).trim();
        if (!prefix || !suffix) return;
        const suffixWords = countChunkWords(suffix);
        if (suffixWords > 0 && suffixWords < 3) return;
        const prefixTokens = estimateTokenCount(prefix);
        if (prefixTokens > hardLimitTokens || prefix.length > hardLimitChars) return;
        if (prefixTokens < Math.max(6, Math.floor(hardLimitTokens * 0.35))) return;
        const penalty = wordBoundaryPenalty(prefix, suffix);
        candidates.push({ index, prefix, suffix, strength, penalty, distance: normalized.length - index });
    };

    const patterns = [
        { regex: /—\s+|–\s+|-\s+/g, strength: 5 },
        { regex: /[,;:]\s+/g, strength: 4 },
        { regex: /[.!?]\s+/g, strength: 3 },
        { regex: /…\s+/g, strength: 3 },
    ];
    for (const { regex, strength } of patterns) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(normalized)) !== null) {
            pushCandidate(match.index + match[0].length, strength);
        }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => {
        if (a.penalty !== b.penalty) return a.penalty - b.penalty;
        if (b.strength !== a.strength) return b.strength - a.strength;
        return a.distance - b.distance;
    });
    return candidates[0];
}

function hasStrongTrailingBoundary(text) {
    const normalized = normalizeChunkText(text);
    if (!normalized) return false;
    return /[.!?…]$|[—–-]$|[,;:]\s*$/.test(normalized);
}

function hasWeakTrailingPhrase(text) {
    const normalized = normalizeChunkText(text);
    if (!normalized) return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    const last = words[words.length - 1].replace(/^[^A-Za-z]+|[^A-Za-z-]+$/g, "").toLowerCase();
    if (!last) return false;
    if (VOX_WEAK_ENDING_WORDS.has(last)) return true;
    if (/^[a-z]+-[a-z]+$/.test(last)) return true;
    if (VOX_COMMON_ADJECTIVE_ENDINGS.some((ending) => last.endsWith(ending))) return true;
    return false;
}

function splitVoxLongChunk(text, softLimitTokens) {
    const normalized = canonicalizeVoxSteerPlacement(text);
    const hardLimitTokens = IS_VOX_TTS ? Math.min(softLimitTokens, VOX_MAX_CHUNK_TOKENS) : softLimitTokens;
    const tailMergeTokenSlack = 8;
    const tailMergeCharSlack = 56;
    const tinyTailMergeTokenSlack = 16;
    const tinyTailMergeCharSlack = 104;
    const smallTailTokens = 8;
    const smallTailChars = 28;
    const minTailWords = 3;
    if (
        !IS_VOX_TTS ||
        !normalized ||
        (estimateTokenCount(normalized) <= hardLimitTokens && normalized.length <= VOX_MAX_CHUNK_CHARS)
    ) {
        return [normalized].filter(Boolean);
    }

    const leading = extractLeadingSteer(normalized);
    const steer = leading?.steer || "";
    let body = leading ? leading.body : normalized;
    if (steer) {
        const repeatedSameSteer = new RegExp(`\\s*\\(${escapeRegExp(steer)}\\)\\s*`, "gi");
        body = body.replace(repeatedSameSteer, " ").trim();
    }
    const pieces = [];
    let start = 0;
    const boundary = /[.!?]\s+|[,;:]\s+|[—–-]\s+|…\s+|\s+(?=\([^()\n]{2,180}\)\s+)/g;
    let match;
    while ((match = boundary.exec(body)) !== null) {
        const end = match.index + match[0].length;
        const piece = body.slice(start, end).trim();
        if (piece) pieces.push(piece);
        start = end;
    }
    const tail = body.slice(start).trim();
    if (tail) pieces.push(tail);
    const rawPieces = pieces.length ? pieces : [body];

    const out = [];
    let current = "";
    const flushCurrent = () => {
        const chunk = normalizeChunkText(current);
        if (chunk) out.push(steer ? `(${steer}) ${chunk}` : chunk);
        current = "";
    };

    for (const piece of rawPieces) {
        const candidate = current ? `${current} ${piece}` : piece;
        if (current && (estimateTokenCount(candidate) > hardLimitTokens || candidate.length > VOX_MAX_CHUNK_CHARS)) {
            flushCurrent();
            current = piece;
        } else {
            current = candidate;
        }

        while (
            (estimateTokenCount(current) > hardLimitTokens || current.length > VOX_MAX_CHUNK_CHARS) &&
            current.includes(" ")
        ) {
            const preferred = findPreferredVoxSplit(current, hardLimitTokens, VOX_MAX_CHUNK_CHARS);
            if (preferred) {
                out.push(steer ? `(${steer}) ${preferred.prefix}` : preferred.prefix);
                current = preferred.suffix;
                continue;
            }
            const words = current.split(/\s+/);
            let prefix = "";
            let consumed = 0;
            for (const word of words) {
                const candidatePrefix = prefix ? `${prefix} ${word}` : word;
                if (prefix && (estimateTokenCount(candidatePrefix) > hardLimitTokens || candidatePrefix.length > VOX_MAX_CHUNK_CHARS)) break;
                prefix = candidatePrefix;
                consumed += 1;
            }
            while (consumed > 1 && (words.length - consumed) < minTailWords) {
                const candidatePrefix = words.slice(0, consumed - 1).join(" ");
                if (estimateTokenCount(candidatePrefix) < Math.max(6, Math.floor(hardLimitTokens * 0.35))) break;
                consumed -= 1;
                prefix = candidatePrefix;
            }
            if (!prefix || consumed <= 0 || consumed >= words.length) break;
            out.push(steer ? `(${steer}) ${prefix}` : prefix);
            current = words.slice(consumed).join(" ");
        }
    }
    flushCurrent();
    if (out.length >= 2) {
        const last = out[out.length - 1];
        const prev = out[out.length - 2];
        const lastBody = extractLeadingSteer(last)?.body || last;
        const prevBody = extractLeadingSteer(prev)?.body || prev;
        const mergedBody = normalizeChunkText(`${prevBody} ${lastBody}`);
        const mergedTokens = estimateTokenCount(mergedBody);
        const mergedChars = mergedBody.length;
        const lastTokens = estimateTokenCount(lastBody);
        const lastChars = lastBody.length;
        const lastWords = countChunkWords(lastBody);
        if (
            (lastTokens <= smallTailTokens || lastChars <= smallTailChars || lastWords < minTailWords) &&
            mergedTokens <= Math.min(VOX_MAX_CHUNK_TOKENS, hardLimitTokens + tailMergeTokenSlack) &&
            mergedChars <= VOX_MAX_CHUNK_CHARS + tailMergeCharSlack
        ) {
            out.splice(out.length - 2, 2, steer ? `(${steer}) ${mergedBody}` : mergedBody);
        } else if (
            lastWords <= 2 &&
            mergedTokens <= Math.min(VOX_MAX_CHUNK_TOKENS + tinyTailMergeTokenSlack, hardLimitTokens + tinyTailMergeTokenSlack) &&
            mergedChars <= VOX_MAX_CHUNK_CHARS + tinyTailMergeCharSlack
        ) {
            out.splice(out.length - 2, 2, steer ? `(${steer}) ${mergedBody}` : mergedBody);
        }
    }
    return out.length ? out : [normalized];
}

function looksLikeStructuredGarbage(text) {
    const normalized = normalizeChunkText(text);
    if (!normalized) return false;
    const lower = normalized.toLowerCase();
    const markers = [
        "\"value\":",
        "\"name\":",
        "\"connected_entity\":",
        "\"connectedentity\":",
        "\"okta",
        "{ \"",
        "\" }",
        "}, {",
        "],",
        "\":[",
        "\": \"",
    ];
    const markerHits = markers.reduce((count, marker) => count + (lower.includes(marker) ? 1 : 0), 0);
    const punctuationHits = (normalized.match(/[{}[\]"]/g) || []).length;
    const alphaHits = (normalized.match(/[A-Za-z]/g) || []).length;
    const nonAlphaRatio = normalized.length ? (normalized.length - alphaHits) / normalized.length : 0;
    return markerHits >= 2 || punctuationHits >= 8 || (normalized.length >= 40 && nonAlphaRatio > 0.45);
}

function looksLikeLexicalGibberish(text) {
    const normalized = normalizeChunkText(text);
    if (!normalized || normalized.length < 36) return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length < 8) return false;

    const COMMON_ENGLISH_WORDS = new Set([
        "i","you","he","she","it","we","they","me","him","her","them","my","your","his","our","their",
        "a","an","the","and","or","but","if","so","as","of","to","in","on","at","for","from","with","by",
        "is","are","was","were","be","been","being","do","did","does","have","has","had","can","could","would","should",
        "that","this","these","those","what","which","who","when","where","why","how",
        "wait","yeah","yes","no","sorry","right","really","just","like","kind","kinda","totally","finally",
        "think","thought","decided","starting","nothing","else","say","caught","wrong","came","again"
    ]);

    const shortWords = words.filter((word) => word.length <= 3).length;
    const weirdCaseWords = words.filter((word) => /[A-Z].*[a-z]|[a-z].*[A-Z]/.test(word)).length;
    const mixedScriptWords = words.filter((word) => /[A-Za-z]/.test(word) && /[^\x00-\x7F]/.test(word)).length;
    const commonEnglishWords = words.filter((word) => {
        const ascii = word.replace(/[^A-Za-z']/g, "").toLowerCase();
        return ascii && COMMON_ENGLISH_WORDS.has(ascii);
    }).length;
    const lowVowelWords = words.filter((word) => {
        const ascii = word.replace(/[^A-Za-z]/g, "");
        if (ascii.length < 3) return false;
        const vowels = (ascii.match(/[aeiouy]/gi) || []).length;
        return vowels / ascii.length < 0.22;
    }).length;
    const repeatedTokenCount = (() => {
        const counts = new Map();
        for (const word of words) {
            const token = word.toLowerCase();
            counts.set(token, (counts.get(token) || 0) + 1);
        }
        let repeated = 0;
        for (const count of counts.values()) {
            if (count >= 2) repeated += count;
        }
        return repeated;
    })();

    const sentencePunctuation = (normalized.match(/[.?!]/g) || []).length;
    const commonWordRatio = commonEnglishWords / words.length;
    const weirdCaseRatio = weirdCaseWords / words.length;
    const lowVowelRatio = lowVowelWords / words.length;
    const repeatedRatio = repeatedTokenCount / words.length;

    if (mixedScriptWords === 0 && weirdCaseWords === 0) {
        if (commonWordRatio >= 0.35) return false;
        if (sentencePunctuation >= 1 && repeatedRatio < 0.35 && lowVowelRatio < 0.7) return false;
    }

    return (
        shortWords / words.length > 0.7 &&
        (
            lowVowelRatio > 0.7 ||
            weirdCaseRatio > 0.25 ||
            mixedScriptWords >= 1 ||
            repeatedRatio > 0.45
        )
    );
}

function looksLikeBadLlmOutput(text) {
    return looksLikeStructuredGarbage(text) || looksLikeLexicalGibberish(text);
}

function parseChunkSchedule(value, fallback) {
    const parsed = parseNumberList(value, fallback)
        .map((item) => Math.max(1, Math.round(item)))
        .filter((item) => Number.isFinite(item) && item > 0);
    return parsed.length ? parsed : [...fallback];
}

const TTS_ALLOWED_TAGS = ["whispering", "laughing", "laughs", "laugh", "chuckling", "singing", "sighs"];
const TTS_SOFTEN_EXCLAMATIONS = process.env.TTS_SOFTEN_EXCLAMATIONS
    ? process.env.TTS_SOFTEN_EXCLAMATIONS !== "0"
    : !IS_VOX_TTS;
const TTS_EXCLAMATION_KEEP_RATE = Math.min(
    1,
    Math.max(0, Number(process.env.TTS_EXCLAMATION_KEEP_RATE) || (IS_VOX_TTS ? 1.0 : 0.1))
);
const TTS_PRESERVE_STEERS = process.env.TTS_PRESERVE_STEERS
    ? process.env.TTS_PRESERVE_STEERS !== "0"
    : IS_VOX_TTS;

function sanitizeForSpeech(text, { isFirstChunk = false, seed = "" } = {}) {
    if (!text) return "";
    let clean = canonicalizeVoxSteerPlacement(text);

    clean = clean
        .replace(/\*\*|__/g, "")
        .replace(/\*|_/g, "")
        .replace(/\\"/g, '"')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\bpfft\b/gi, "oh")
        .replace(/\s+/g, " ")
        .trim();

    clean = clean
        .replace(/\b(?:ha){4,}\b/gi, "hahaha")
        .replace(/\bhah{2,}\b/gi, "haha");

    if (TTS_SOFTEN_EXCLAMATIONS && TTS_EXCLAMATION_KEEP_RATE < 1) {
        let hash = 0;
        const hashSeed = String(seed || clean);
        for (let index = 0; index < hashSeed.length; index += 1) {
            hash = (hash * 31 + hashSeed.charCodeAt(index)) >>> 0;
        }
        const keepThreshold = Math.floor(TTS_EXCLAMATION_KEEP_RATE * 100);
        const keepExclamations = (hash % 100) < keepThreshold;
        if (!keepExclamations) {
            clean = clean.replace(/!+/g, ".");
        }
    }

    const normalizeTag = (value) => String(value || "").toLowerCase().replace(/[^a-z]/g, "");
    const isAllowedTag = (content) => {
        const normalized = normalizeTag(content);
        return TTS_ALLOWED_TAGS.some((tag) => normalized === tag || normalized.startsWith(tag));
    };

    clean = clean.replace(/(\(|\[)(.*?)(\)|\])/g, (match, open, content, close) => {
        const textInside = String(content || "").trim();
        if (!textInside) return "";
        if (TTS_PRESERVE_STEERS && open === "(" && close === ")" && textInside.includes(" ")) {
            return `(${textInside})`;
        }

        const firstWord = textInside
            .split(/[\s,]+/)[0]
            .replace(/[.,!?;:]+$/g, "")
            .toLowerCase();

        if (TTS_ALLOWED_TAGS.includes(firstWord)) {
            const normalizedTag = isAllowedTag(textInside) ? firstWord : textInside;
            return `${open}${normalizedTag}${close}`;
        }

        if (textInside === textInside.toUpperCase() && textInside.length > 1 && !textInside.includes(" ")) {
            return match;
        }

        if (!textInside.includes(" ")) {
            return "";
        }

        return "";
    });

    if (isFirstChunk && !TTS_PRESERVE_STEERS) {
        clean = clean.replace(/^\s*(\(([^)]*)\)|\[([^\]]*)\])\s*/g, (match, _whole, parenContent, bracketContent) => {
            const content = parenContent ?? bracketContent ?? "";
            return isAllowedTag(content) ? "" : "";
        });
    }

    const leadingSteer = extractLeadingSteer(clean);
    if (leadingSteer) {
        clean = `(${leadingSteer.steer}) ${leadingSteer.body.replace(/\s*\(([^()\n]{2,180})\)\s*/g, " ").replace(/\s+/g, " ").trim()}`;
    }

    clean = clean
        .replace(/(^|[\s—–-])"([A-Za-z][^"]{0,40})"(?=$|[\s,.;!?—–-])/g, "$1$2")
        .replace(/(^|[\s—–-])"([A-Za-z][^",.;!?—–-]{0,40})(?=$|[\s,.;!?—–-])/g, "$1$2")
        .replace(/(^|[\s—–-])([A-Za-z][^",.;!?—–-]{0,40})"(?=$|[\s,.;!?—–-])/g, "$1$2")
        .replace(/\s+([,.;!?])/g, "$1")
        .replace(/"\s*([,.;!?—–-])/g, "$1")
        .replace(/([—–-])\s+"/g, "$1 ")
        .replace(/"\s+/g, " ")
        .replace(/([.?!]){3,}/g, "$1..")
        .replace(/\s+/g, " ")
        .trim();

    return clean;
}

function computeVoxMaxLen(text) {
    const normalized = normalizeChunkText(text);
    const leading = extractLeadingSteer(normalized);
    const body = normalizeChunkText(leading?.body || normalized);
    const tokens = estimateTokenCount(body);
    const chars = body.length;
    if (tokens <= 3 || chars <= 16) return Math.min(VOX_MAX_LEN, 96);
    if (tokens <= 6 || chars <= 28) return Math.min(VOX_MAX_LEN, 128);
    if (tokens <= 10 || chars <= 44) return Math.min(VOX_MAX_LEN, 160);
    if (tokens <= 16 || chars <= 72) return Math.min(VOX_MAX_LEN, 224);
    if (tokens <= 24 || chars <= 120) return Math.min(VOX_MAX_LEN, 320);
    return VOX_MAX_LEN;
}

function countVoxSpokenWords(text) {
    const normalized = canonicalizeVoxSteerPlacement(text);
    const leading = extractLeadingSteer(normalized);
    const body = normalizeChunkText(leading?.body || normalized)
        .replace(/[“”"‘’']/g, "")
        .replace(/[—–-]/g, " ")
        .replace(/[^A-Za-z0-9.\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!body) return 0;
    return body.split(" ").filter(Boolean).length;
}

function voxTemperatureForText(text) {
    const spokenWords = countVoxSpokenWords(text);
    const active = getVoxTtsSettings();
    const ladder = {
        1: active.vox_temp_1_word,
        2: active.vox_temp_2_words,
        3: active.vox_temp_3_words,
        4: active.vox_temp_4_words,
    };
    const specific = ladder[spokenWords];
    if (Number.isFinite(specific) && specific > 0) return specific;
    if (Number.isFinite(active.vox_temperature_default) && active.vox_temperature_default > 0) return active.vox_temperature_default;
    return null;
}

function voxCfgForText(text) {
    const spokenWords = countVoxSpokenWords(text);
    const active = getVoxTtsSettings();
    const ladder = {
        1: active.vox_cfg_1_word,
        2: active.vox_cfg_2_words,
        3: active.vox_cfg_3_words,
        4: active.vox_cfg_4_words,
    };
    const specific = ladder[spokenWords];
    if (Number.isFinite(specific) && specific > 0) return specific;
    if (Number.isFinite(active.vox_cfg) && active.vox_cfg > 0) return active.vox_cfg;
    return VOX_CFG;
}

function isTooShortStandaloneVoxChunk(text) {
    const normalized = normalizeChunkText(text);
    const leading = extractLeadingSteer(normalized);
    const body = normalizeChunkText(leading?.body || normalized);
    const tokens = estimateTokenCount(body);
    const chars = body.length;
    return tokens <= 3 || chars <= 18;
}

function buildTtsRequestBody(text, { isFirstChunk = false, continuationCacheOverride, maxLenOverride } = {}) {
    const blockSizes = isFirstChunk ? TTS_FIRST_CHUNK_BLOCK_SIZES : TTS_BLOCK_SIZES;
    const numSteps = isFirstChunk ? TTS_FIRST_CHUNK_NUM_STEPS : TTS_NUM_STEPS;
    const vox = getVoxTtsSettings();

    if (IS_VOX_TTS) {
        const continuationCache = continuationCacheOverride ?? shouldUseVoxContinuationCache(text);
        const maxLen = maxLenOverride ?? computeVoxMaxLen(text);
        const shortWordTemperature = voxTemperatureForText(text);
        const body = {
            input: `[S1] ${text}`,
            stream: true,
            response_format: "pcm_s16le",
            cfg: voxCfgForText(text),
            max_len: maxLen,
            split_steers: VOX_SPLIT_STEERS,
            continuation_cache: continuationCache,
            seam_ms: Math.max(0, Math.round(Number(vox.vox_seam_ms) || VOX_SEAM_MS)),
            include_default_steer: false,
        };
        if (shortWordTemperature !== null) body.temperature = shortWordTemperature;
        if (VOX_DIT_STEPS) body.dit_steps = VOX_DIT_STEPS;
        return body;
    }

    return {
        input: `[S1] ${text}`,
        voice: TTS_VOICE,
        stream: true,
        response_format: "pcm",
        speed: 1.0,
        block_sizes: blockSizes,
        num_steps: numSteps,
        cfg_scale_text: TTS_CFG_SCALE_TEXT,
        cfg_scale_speaker: TTS_CFG_SCALE_SPEAKER,
        truncation_factor: TTS_TRUNCATION_FACTOR,
        speaker_kv_scale: TTS_SPEAKER_KV_SCALE,
        seed: TTS_SEED,
    };
}

/** Call the configured TTS API and stream PCM audio chunks */
async function synthesizeSpeech(text, signal, { isFirstChunk = false, onChunk, logMeta = {}, continuationCacheOverride, maxLenOverride } = {}) {
    const vox = getVoxTtsSettings();
    const endpoint = sanitizeUrl(vox.vox_tts_endpoint, TTS_ENDPOINT);
    const url = `${endpoint}/v1/audio/speech`;
    const startedAt = Date.now();
    const textLen = String(text || "").length;
    const tokenLen = estimateTokenCount(text);
    const requestBody = buildTtsRequestBody(text, { isFirstChunk, continuationCacheOverride, maxLenOverride });
    const leadingSteer = Boolean(extractLeadingSteer(text));
    if (DEBUG_TTS || LOG_TTS_VERBOSE) {
        logEvent("TTS", "request", {
            chat: logMeta.chatId,
            request: logMeta.requestId,
            chunk: logMeta.chunkIndex,
            backend: TTS_BACKEND,
            endpoint,
            voice: IS_VOX_TTS ? "loaded_model" : TTS_VOICE,
            chars: textLen,
            tokens: tokenLen,
            first_chunk: isFirstChunk,
            leading_steer: leadingSteer,
            continuation_cache: requestBody.continuation_cache,
            cfg: requestBody.cfg,
            temperature: requestBody.temperature ?? null,
            max_len: requestBody.max_len,
            seam_ms: requestBody.seam_ms,
            preview: truncateForLog(text, 140),
        });
    }

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
    });
    const headersMs = Date.now() - startedAt;

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`TTS ${res.status}: ${errText.slice(0, 200)}`);
    }

    const sampleRate = Number.parseInt(res.headers.get("X-Audio-Sample-Rate") || "44100", 10) || 44100;
    const responseBody = res.body;
    if (!responseBody || typeof responseBody[Symbol.asyncIterator] !== "function") {
        const buf = Buffer.from(await res.arrayBuffer());
        const safe = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
        if (safe.length && typeof onChunk === "function") {
            onChunk({ pcmBuffer: safe, sampleRate, streamSubIndex: 0, isFinalStreamChunk: true });
        }
        const ms = Date.now() - startedAt;
        const audioMs = sampleRate ? Math.round((safe.length / (2 * sampleRate)) * 1000) : 0;
        logEvent("TTS", "done", {
            chat: logMeta.chatId,
            request: logMeta.requestId,
            chunk: logMeta.chunkIndex,
            headers: formatMs(headersMs),
            ttfs: "n/a",
            elapsed: formatMs(ms),
            audio: formatMs(audioMs),
            rtfx: formatRtfx(ms, audioMs),
            bytes: formatBytes(safe.length),
            chunks: safe.length ? 1 : 0,
            sample_rate: sampleRate,
            mode: "fallback",
        });
        return { sampleRate, totalBytes: safe.length, streamChunks: safe.length ? 1 : 0, audioMs, elapsedMs: ms, headersMs };
    }

    let streamSubIndex = 0;
    let totalBytes = 0;
    let pcmAccumulator = [];
    let pcmAccumulatorSize = 0;
    const MIN_CHUNK_SIZE_FIRST = TTS_MIN_CHUNK_SIZE_FIRST;
    const MIN_CHUNK_SIZE_STREAM = TTS_MIN_CHUNK_SIZE_STREAM;

    let firstChunkAt = null;
    const emitChunk = (chunkBuffer, isFinalStreamChunk) => {
        if (!chunkBuffer || chunkBuffer.length === 0) return;
        let safeBuffer = chunkBuffer;
        if (safeBuffer.length % 2 !== 0) {
            safeBuffer = safeBuffer.subarray(0, safeBuffer.length - 1);
        }
        if (!safeBuffer.length) return;
        if (firstChunkAt === null) firstChunkAt = Date.now();
        totalBytes += safeBuffer.length;
        if (typeof onChunk === "function") {
            onChunk({ pcmBuffer: safeBuffer, sampleRate, streamSubIndex, isFinalStreamChunk });
        }
        streamSubIndex += 1;
    };

    for await (const chunk of responseBody) {
        if (signal?.aborted) break;
        const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pcmAccumulator.push(chunkBuf);
        pcmAccumulatorSize += chunkBuf.length;

        const minChunkSize = streamSubIndex === 0 ? MIN_CHUNK_SIZE_FIRST : MIN_CHUNK_SIZE_STREAM;
        if (pcmAccumulatorSize >= minChunkSize) {
            const combined = Buffer.concat(pcmAccumulator);
            let splitIndex = combined.length;
            if (splitIndex % 2 !== 0) splitIndex -= 1;
            const toEmit = combined.subarray(0, splitIndex);
            const remainder = combined.subarray(splitIndex);
            pcmAccumulator = [];
            if (remainder.length > 0) pcmAccumulator.push(remainder);
            pcmAccumulatorSize = remainder.length;
            emitChunk(toEmit, false);
        }
    }

    if (pcmAccumulator.length > 0) {
        emitChunk(Buffer.concat(pcmAccumulator), true);
    }

    const ms = Date.now() - startedAt;
    const audioMs = sampleRate ? Math.round((totalBytes / (2 * sampleRate)) * 1000) : 0;
    const firstMs = firstChunkAt === null ? null : firstChunkAt - startedAt;
    logEvent("TTS", "done", {
        chat: logMeta.chatId,
        request: logMeta.requestId,
        chunk: logMeta.chunkIndex,
        headers: formatMs(headersMs),
        ttfs: formatMs(firstMs),
        elapsed: formatMs(ms),
        audio: formatMs(audioMs),
        rtfx: formatRtfx(ms, audioMs),
        bytes: formatBytes(totalBytes),
        chunks: streamSubIndex,
        sample_rate: sampleRate,
    });
    return { sampleRate, totalBytes, streamChunks: streamSubIndex, firstMs, elapsedMs: ms, audioMs, headersMs };
}

/** Stream LLM completion (OpenAI-compatible) */
async function* streamLLM(messages, signal, { chatId = "" } = {}) {
    const llm = getActiveLlmSettings();
    const chatCompletionsUrl = new URL("chat/completions", `${llm.base_url}/`).toString();
    const trimmedMessages = trimMessagesToContext(messages, llm.max_context_tokens, llm.max_output_tokens);
    const body = {
        model: llm.model,
        messages: trimmedMessages,
        max_tokens: llm.max_output_tokens,
        stream: true,
    };
    if (llm.temperature > 0) body.temperature = llm.temperature;
    if (llm.repetition_penalty > 0) body.repetition_penalty = llm.repetition_penalty;
    if (llm.top_p > 0) body.top_p = llm.top_p;
    if (llm.top_k > 0) body.top_k = llm.top_k;
    if (llm.min_p > 0) body.min_p = llm.min_p;
    if (llm.presence_penalty !== 0) body.presence_penalty = llm.presence_penalty;
    if (llm.frequency_penalty !== 0) body.frequency_penalty = llm.frequency_penalty;
    const cloudflareGemmaDisableThinking = isCloudflareGemmaDisableThinkingModel(llm) && llm.disable_thinking === true;
    if (cloudflareGemmaDisableThinking) {
        body.chat_template_kwargs = {
            enable_thinking: false,
        };
    }
    const deepInfraPromptCacheKey = isDeepInfraOpenAi(llm)
        ? buildDeepInfraPromptCacheKey(trimmedMessages, llm, chatId)
        : "";
    if (deepInfraPromptCacheKey) {
        body.prompt_cache_key = deepInfraPromptCacheKey;
    }

    const headers = {
        "Content-Type": "application/json",
    };
    if (llm.api_key) {
        headers.Authorization = `Bearer ${llm.api_key}`;
        // Gemini's OpenAI-compatible endpoint accepts Bearer keys in practice, but API keys
        // also commonly work as `x-goog-api-key`. Adding it only for Google avoids breaking others.
        if (/^https:\/\/generativelanguage\.googleapis\.com\//i.test(llm.base_url)) {
            headers["x-goog-api-key"] = llm.api_key;
        }
    }
    if (isCloudflareWorkersAi(llm)) {
        const affinity = `echostream:${chatId || "session"}:${llm.model}`;
        headers["x-session-affinity"] = affinity;
        logEvent("LLM", "request_meta", {
            host: getHostFromBaseUrl(llm.base_url),
            model: llm.model,
            session_affinity: affinity,
            disable_thinking_sent: cloudflareGemmaDisableThinking,
        });
    }
    if (deepInfraPromptCacheKey) {
        logEvent("LLM", "request_meta", {
            host: getHostFromBaseUrl(llm.base_url),
            model: llm.model,
            prompt_cache_key: deepInfraPromptCacheKey,
            prompt_cache_enabled: true,
        });
    }

    const res = await fetch(chatCompletionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        // Do not log secrets; include URL + a short body excerpt for debugging.
        throw new Error(
            `LLM ${res.status}: ${truncateForLog(errText, 500)} (url=${chatCompletionsUrl})`
        );
    }

    let buffer = "";
    for await (const chunk of res.body) {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const json = trimmed.replace(/^data:\s*/, "");
            if (json === "[DONE]") return;
            try {
                const parsed = JSON.parse(json);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) yield delta;
            } catch { }
        }
    }
}

// ─── Deepgram STT via WebSocket ──────────────────────────────────────────────

const WebSocket = require("ws");

function createDeepgramStream(
    chatId,
    onTranscript,
    onUtteranceEnd,
    onSpeechStart = null,
    onSpeechEnd = null,
    onReady = null,
    onClose = null,
) {
    const url = new URL(`wss://api.deepgram.com/${DEEPGRAM_IS_FLUX ? "v2" : "v1"}/listen`);
    url.searchParams.set("model", DEEPGRAM_MODEL);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");
    if (DEEPGRAM_IS_FLUX) {
        // Flux `/v2/listen` only supports a reduced query set.
        if (FLUX_EAGER_EOT_THRESHOLD) {
            url.searchParams.set("eager_eot_threshold", FLUX_EAGER_EOT_THRESHOLD);
        }
        if (FLUX_EOT_THRESHOLD) {
            url.searchParams.set("eot_threshold", FLUX_EOT_THRESHOLD);
        }
        if (FLUX_EOT_TIMEOUT_MS) {
            url.searchParams.set("eot_timeout_ms", FLUX_EOT_TIMEOUT_MS);
        }
    } else {
        // Nova (and other v1 models) endpointing controls.
        url.searchParams.set("channels", "1");
        url.searchParams.set("punctuate", "true");
        url.searchParams.set("interim_results", "true");
        url.searchParams.set("utterance_end_ms", "1200");
        url.searchParams.set("vad_events", "true");
        url.searchParams.set("endpointing", "400");
    }

    const ws = new WebSocket(url.toString(), {
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });
    let keepAliveTimer = null;

    const clearKeepAlive = () => {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
    };

    const startKeepAlive = () => {
        clearKeepAlive();
        keepAliveTimer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            try {
                ws.ping();
            } catch { }
        }, DEEPGRAM_KEEPALIVE_MS);
    };

    ws.on("open", () => {
        console.log(
            `[STT] Deepgram connected for ${chatId} model=${DEEPGRAM_MODEL} api=${DEEPGRAM_IS_FLUX ? "v2" : "v1"}`
        );
        if (RAW_DEEPGRAM_MODEL.toLowerCase() === "flux") {
            console.log("[STT] DEEPGRAM_MODEL=flux normalized to flux-general-en");
        }
        startKeepAlive();
        try { onReady?.(); } catch { }
    });

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data);
            if (DEEPGRAM_IS_FLUX) {
                // Flux emits turn-aware `TurnInfo` events instead of v1 `Results`.
                if (msg.type === "TurnInfo" || msg.type === "request_response") {
                    const event = msg.event;
                    const transcript = typeof msg.transcript === "string" ? msg.transcript.trim() : "";
                    if (event === "StartOfTurn") {
                        try { onSpeechStart?.(); } catch { }
                    }
                    if (transcript) {
                        onTranscript(transcript, event === "EndOfTurn", false);
                    }
                    if (event === "EndOfTurn") {
                        try { onSpeechEnd?.(); } catch { }
                        onUtteranceEnd();
                    }
                } else if (msg.type === "Error" || msg.type === "FatalError") {
                    const details = msg.message || msg.description || "Unknown error";
                    console.error(`[STT] Deepgram Flux error for ${chatId}: ${details}`);
                }
                return;
            }

            if (msg.type === "SpeechStarted") {
                try { onSpeechStart?.(); } catch { }
            }
            if (msg.type === "Results") {
                const transcript = msg.channel?.alternatives?.[0]?.transcript || "";
                const isFinal = msg.is_final;
                const speechFinal = msg.speech_final;
                if (transcript) {
                    onTranscript(transcript, isFinal, speechFinal);
                }
            } else if (msg.type === "UtteranceEnd") {
                try { onSpeechEnd?.(); } catch { }
                onUtteranceEnd();
            } else if (msg.type === "Error" || msg.type === "FatalError") {
                const details = msg.message || msg.description || "Unknown error";
                console.error(`[STT] Deepgram v1 error for ${chatId}: ${details}`);
            }
        } catch { }
    });

    ws.on("error", (err) => {
        console.error(`[STT] Deepgram error for ${chatId}:`, err.message);
    });

    ws.on("close", (code, reason) => {
        clearKeepAlive();
        const reasonText = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
        console.log(`[STT] Deepgram closed for ${chatId} code=${code} reason=${reasonText}`);
        try { onClose?.({ code, reason: reasonText }); } catch { }
    });

    return ws;
}

// ─── Voice Session ───────────────────────────────────────────────────────────

class VoiceSession {
    constructor(socket, chatId, { userName = "", history = [] } = {}) {
        this.socket = socket;
        this.chatId = chatId;
        this.userName = String(userName || "").trim();
        this.history = Array.isArray(history) ? history.map((item) => ({
            role: item?.role === "assistant" ? "assistant" : "user",
            content: String(item?.content || ""),
        })) : [];
        this.deepgramWs = null;
        this.abortController = null;
        this.isSpeaking = false;
        this.silenceTimer = null;
        this.openingTimer = null;
        this.silenceTriggerIndex = 0;
        // Silence triggers are armed once per user-silence period (re-armed when the user speaks).
        this.silenceHasFired = false;
        // Latest estimated end-time of assistant audio playback on the client (best-effort).
        // We use this to avoid counting "silence" while Maya is talking.
        this.assistantAudioEndsAt = 0;
        this.lastUserSpeechAt = 0;
        this.currentRequestId = null;
        this.partialTranscript = "";
        this.finalizedTranscript = "";
        this.stopped = false;
        this.streamReady = false;
        this.streamEnded = false;
        this.callId = generateId();
        // TTS queue tracked at session level so text barge-in can wait for pending audio to drain
        // (voice barge-in gets a natural gap because the user keeps speaking after cancellation).
        this._ttsQueue = Promise.resolve();
        // Track whether the Deepgram WS was intentionally paused (close should not tear down).
        this._deepgramPaused = false;
        // Increment whenever memory is cleared so stale in-flight turns cannot write history back.
        this.contextVersion = 0;
    }

    start() {
        this.stopped = false;
        this.streamReady = false;
        this.streamEnded = false;
        this.callId = generateId();
        this.lastUserSpeechAt = Date.now();
        this.silenceTriggerIndex = 0;
        this.silenceHasFired = false;
        this.assistantAudioEndsAt = 0;
        this.deepgramWs = createDeepgramStream(
            this.chatId,
            (transcript, isFinal, speechFinal) => this.onTranscript(transcript, isFinal, speechFinal),
            () => this.onUtteranceEnd(),
            () => this.onSpeechStart(),
            () => this.onSpeechEnd(),
            () => this.onStreamReady(),
            (meta) => this.onStreamClosed(meta),
        );
    }

    stop(reason = "stopped", code = 1000) {
        if (this.stopped && this.streamEnded) return;
        this.stopped = true;
        this.cancelCurrentGeneration();
        this.clearSilenceTimer();
        if (this.openingTimer) {
            clearTimeout(this.openingTimer);
            this.openingTimer = null;
        }
        if (this.deepgramWs?.readyState === WebSocket.OPEN) {
            if (DEEPGRAM_IS_FLUX) {
                try {
                    this.deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
                } catch { }
            }
            this.deepgramWs.close();
        }
        this.deepgramWs = null;
        this.emitStreamEnded({ code, reason });
    }

    clearContext() {
        this.cancelCurrentGeneration();
        this.contextVersion += 1;
        this.history = [];
        this.partialTranscript = "";
        this.finalizedTranscript = "";
        this.silenceTriggerIndex = 0;
        this.silenceHasFired = false;
        this.assistantAudioEndsAt = 0;
        this.clearSilenceTimer();
        this.resetSilenceTimer();
        this.socket.emit("server:context_cleared", { chatId: this.chatId });
        this.socket.emit("server:status", { chatId: this.chatId, state: "listening" });
    }

    sendAudio(pcmData) {
        if (this.deepgramWs?.readyState === WebSocket.OPEN) {
            this.deepgramWs.send(pcmData);
        }
    }

    pauseDeepgram() {
        if (!this.deepgramWs) return;
        this._deepgramPaused = true;
        console.log(`[STT] Deepgram paused for ${this.chatId}`);
    }

    resumeDeepgram() {
        if (this.stopped) return;
        this._deepgramPaused = false;
        if (this.deepgramWs?.readyState === WebSocket.OPEN) return;
        this.deepgramWs = createDeepgramStream(
            this.chatId,
            (transcript, isFinal, speechFinal) => this.onTranscript(transcript, isFinal, speechFinal),
            () => this.onUtteranceEnd(),
            () => this.onSpeechStart(),
            () => this.onSpeechEnd(),
            () => this.onStreamReady(),
            (meta) => this.onStreamClosed(meta),
        );
        console.log(`[STT] Deepgram resumed for ${this.chatId}`);
    }

    onStreamReady() {
        if (this.stopped || this.streamReady) return;
        this.streamReady = true;
        this.socket.emit("server:voice_stream_ready", { chatId: this.chatId, callId: this.callId });
        this.socket.emit("server:status", { chatId: this.chatId, state: "listening" });
        this.resetSilenceTimer();
        this.sendOpeningMessage();
    }

    onStreamClosed({ code = null, reason = "" } = {}) {
        this.deepgramWs = null;
        // While muted/paused, STT close should not tear down the whole call.
        // Keep the session alive and allow resumeDeepgram() to recreate the WS.
        if (this._deepgramPaused) {
            return;
        }
        if (this.streamEnded) return;
        this.stopped = true;
        this.cancelCurrentGeneration();
        this.clearSilenceTimer();
        if (this.openingTimer) {
            clearTimeout(this.openingTimer);
            this.openingTimer = null;
        }
        this.emitStreamEnded({ code, reason: reason || "stream_closed" });
    }

    emitStreamEnded({ code = null, reason = "ended" } = {}) {
        if (this.streamEnded) return;
        this.streamEnded = true;
        this.socket.emit("server:voice_stream_ended", {
            chatId: this.chatId,
            callId: this.callId,
            code,
            reason,
        });
    }

    // ── STT callbacks ──

    onSpeechStart() {
        if (this.stopped) return;
        this.lastUserSpeechAt = Date.now();
        this.silenceTriggerIndex = 0;
        this.silenceHasFired = false;
        // Client should flush playback on barge-in; stop "assistant speaking" window immediately.
        this.assistantAudioEndsAt = Date.now();
        this.resetSilenceTimer();

        this.socket.emit("server:vad_speech_start", { chatId: this.chatId });
    }

    onSpeechEnd() {
        if (this.stopped) return;
        this.socket.emit("server:vad_speech_end", { chatId: this.chatId });
    }

    onTranscript(transcript, isFinal, speechFinal) {
        if (this.stopped) return;
        this.lastUserSpeechAt = Date.now();
        this.silenceTriggerIndex = 0;
        this.silenceHasFired = false;
        this.resetSilenceTimer();

        // Barge-in: only cancel on meaningful interim speech (VAD can false-trigger on noise/echo).
        const clean = String(transcript || "").trim();
        if (this.isSpeaking && clean.length >= 3) {
            const cancelledRequestId = this.cancelCurrentGeneration();
            // Barge-in should flush playback; don't count assistant audio as ongoing.
            this.assistantAudioEndsAt = Date.now();
            this.socket.emit("server:assistant_message_cancelled", {
                chatId: this.chatId,
                messageId: cancelledRequestId,
            });
            this.socket.emit("server:status", { chatId: this.chatId, state: "listening" });
        }

        if (isFinal) {
            this.finalizedTranscript += (this.finalizedTranscript ? " " : "") + transcript;
            this.partialTranscript = "";
        } else {
            this.partialTranscript = transcript;
        }

        // Show partial to client
        this.socket.emit("server:user_voice_message", {
            chatId: this.chatId,
            text: (this.finalizedTranscript + " " + this.partialTranscript).trim(),
            isFinal: false,
        });

        if (speechFinal) {
            this.onUtteranceEnd();
        }
    }

    onUtteranceEnd() {
        if (this.stopped) return;
        // Flux may emit end-of-turn before a separate "final" transcript frame.
        const text = (this.finalizedTranscript || this.partialTranscript).trim();
        if (!text) return;

        // Emit final transcript
        this.socket.emit("server:user_voice_message", {
            chatId: this.chatId,
            text,
            isFinal: true,
        });

        this.finalizedTranscript = "";
        this.partialTranscript = "";
        this.processUserMessage(text);
    }

    // ── LLM + TTS pipeline ──

    async processUserMessage(userText, { syntheticUser = false } = {}) {
        const requestId = generateId();
        const contextVersionAtStart = this.contextVersion;
        this.currentRequestId = requestId;
        this.isSpeaking = true;
        this.clearSilenceTimer();
        const turnStartedAt = Date.now();
        const turnStats = {
            ttsChunksQueued: 0,
            ttsChunksSent: 0,
            ttsStreamSubchunks: 0,
            ttsBytes: 0,
            ttsAudioMs: 0,
            ttsFirstAudioAt: null,
            ttsFirstTtfsMs: null,
            ttsTotalElapsedMs: 0,
            llmFirstTokenAt: null,
        };

        this.socket.emit("server:status", { chatId: this.chatId, state: "thinking" });
        this.socket.emit("server:assistant_message_started", {
            chatId: this.chatId,
            messageId: requestId,
        });
        logEvent("TURN", "start", {
            chat: this.chatId,
            request: requestId,
            call: this.callId,
            user_chars: userText.length,
            user_tokens: estimateTokenCount(userText),
            history: this.history.length,
            preview: userText,
        });

        // Build messages
        const systemWithName = this.userName
            ? `${SYSTEM_PROMPT}\n\nThe user's name is ${this.userName}.`
            : SYSTEM_PROMPT;
        const messages = [
            { role: "system", content: systemWithName },
            ...buildContextMessages(this.history).slice(-20),
            { role: "user", content: userText },
        ];

        // Debug: log the first few history messages to diagnose garbage input
        if (this.history.length > 0) {
            const recentSlice = this.history.slice(-5);
            logEvent("LLM", "history", {
                chat: this.chatId,
                history_total: this.history.length,
                history_sending: Math.min(20, this.history.length),
                messages: recentSlice.map((m, index) => ({
                    index,
                    role: m.role,
                    chars: String(m.content || "").length,
                    text: String(m.content || ""),
                })),
            });
        }

        const abortController = new AbortController();
        this.abortController = abortController;

        let fullResponse = "";
        let sentenceBuffer = "";
        let ttsChunkIndex = 0;
        let pendingTtsSentences = [];
        let pendingTtsTokens = 0;
        let ttsQueue = Promise.resolve();
        let activeVoxSteer = "";
        let lastQueuedVoxSteer = "";
        const isRequestStillCurrent = () => (
            !abortController.signal.aborted &&
            !this.stopped &&
            this.currentRequestId === requestId &&
            this.contextVersion === contextVersionAtStart
        );
        const chunkTargets = getTtsTokenTargets();
        const defaultChunkTarget = chunkTargets[chunkTargets.length - 1] || 61;
        const chunkTargetFor = (index) => chunkTargets[index] ?? defaultChunkTarget;
        const chunkSoftLimitFor = (index) => Math.max(chunkTargetFor(index), Math.ceil(chunkTargetFor(index) * TTS_CHUNK_FLEX));
        const voxChunkLimitFor = (index) => IS_VOX_TTS ? Math.min(chunkSoftLimitFor(index), VOX_MAX_CHUNK_TOKENS) : chunkSoftLimitFor(index);
        const enqueueTtsChunk = (text) => {
            if (!text || abortController.signal.aborted) return ttsQueue;
            const chunkIndex = ttsChunkIndex;
            ttsChunkIndex += 1;
            const isFirstChunk = chunkIndex === 0;
            const queuedAt = Date.now();
            const leadingSteerMatch = extractLeadingSteer(text);
            const leadingSteer = Boolean(leadingSteerMatch);
            const repeatedSteer = Boolean(
                IS_VOX_TTS &&
                chunkIndex > 0 &&
                leadingSteerMatch &&
                lastQueuedVoxSteer &&
                leadingSteerMatch.steer === lastQueuedVoxSteer
            );
            const textToSend = repeatedSteer ? normalizeChunkText(leadingSteerMatch.body) : text;
            const maxLen = IS_VOX_TTS ? computeVoxMaxLen(textToSend) : undefined;
            const continuationCache = IS_VOX_TTS
                ? shouldUseVoxContinuationCache(textToSend, {
                    previousSteer: lastQueuedVoxSteer,
                    allowRepeatedSteer: chunkIndex > 0,
                })
                : undefined;
            if (IS_VOX_TTS) {
                lastQueuedVoxSteer = leadingSteerMatch?.steer || lastQueuedVoxSteer;
            }
            turnStats.ttsChunksQueued += 1;
            logEvent("TTS", "queue", {
                chat: this.chatId,
                request: requestId,
                chunk: chunkIndex,
                chars: textToSend.length,
                tokens: estimateTokenCount(textToSend),
                first_chunk: isFirstChunk,
                leading_steer: leadingSteer,
                repeated_steer: repeatedSteer,
                continuation_cache: continuationCache,
                max_len: maxLen,
                preview: textToSend,
            });
            ttsQueue = ttsQueue
                .then(async () => {
                    if (abortController.signal.aborted) return;
                    const waitMs = Date.now() - queuedAt;
                    if (waitMs >= 50 || DEBUG_TTS || LOG_TTS_VERBOSE) {
                        logEvent("TTS", "dequeue", {
                            chat: this.chatId,
                            request: requestId,
                            chunk: chunkIndex,
                            wait: formatMs(waitMs),
                            chars: textToSend.length,
                        });
                    }
                    await this.synthesizeAndSend(textToSend, requestId, abortController.signal, {
                        isFirstChunk,
                        chunkIndex,
                        turnStats,
                        continuationCacheOverride: continuationCache,
                    });
                })
                .catch((err) => {
                    if (!abortController.signal.aborted) console.error(`[TTS] Queue error:`, err.message || err);
                });
            // Track on session so flushTtsQueue() can await the chain
            this._ttsQueue = ttsQueue;
            return ttsQueue;
        };
        const flushPendingTtsChunk = ({ force = false } = {}) => {
            if (!pendingTtsSentences.length || abortController.signal.aborted) return;
            const text = pendingTtsSentences.join(" ").replace(/\s+/g, " ").trim();
            if (IS_VOX_TTS && !force && isTooShortStandaloneVoxChunk(text)) {
                return;
            }
            pendingTtsSentences = [];
            pendingTtsTokens = 0;
            if (!text) return;
            enqueueTtsChunk(text);
        };
        const queueTtsSentence = (sentence) => {
            let trimmedSentence = normalizeChunkText(sentence);
            if (!trimmedSentence || abortController.signal.aborted) return;

            const leadingSteer = extractLeadingSteer(trimmedSentence);
            if (IS_VOX_TTS && leadingSteer) {
                activeVoxSteer = leadingSteer.steer;
            } else if (IS_VOX_TTS && activeVoxSteer) {
                trimmedSentence = withSteer(trimmedSentence, activeVoxSteer);
            }

            const chunkSoftLimit = voxChunkLimitFor(ttsChunkIndex);
            const sentencePieces = splitVoxLongChunk(trimmedSentence, chunkSoftLimit);
            if (IS_VOX_TTS && sentencePieces.length > 1) {
                if (pendingTtsSentences.length > 0) {
                    const pendingText = pendingTtsSentences.join(" ").replace(/\s+/g, " ").trim();
                    if (!(IS_VOX_TTS && isTooShortStandaloneVoxChunk(pendingText))) {
                        flushPendingTtsChunk({ force: true });
                    }
                }
                logEvent("TTS", "split", {
                    chat: this.chatId,
                    request: requestId,
                    pieces: sentencePieces.length,
                    limit_tokens: chunkSoftLimit,
                    chars: trimmedSentence.length,
                    leading_steer: Boolean(leadingSteer),
                    preview: trimmedSentence,
                });
            }

            for (const piece of sentencePieces) {
                const tokenLen = estimateTokenCount(piece);
                const chunkTarget = IS_VOX_TTS ? Math.min(chunkTargetFor(ttsChunkIndex), VOX_MAX_CHUNK_TOKENS) : chunkTargetFor(ttsChunkIndex);
                const forceSingleSentenceChunk = tokenLen > chunkSoftLimit && pendingTtsSentences.length === 0;
                const isPostFirstChunk = IS_VOX_TTS && ttsChunkIndex > 0;
                const combinedPendingText = pendingTtsSentences.length
                    ? pendingTtsSentences.concat([piece]).join(" ").replace(/\s+/g, " ").trim()
                    : piece;
                const combinedPendingTokens = estimateTokenCount(combinedPendingText);
                const combinedPendingChars = combinedPendingText.length;
                const postFirstExpandedTokenLimit = Math.min(
                    VOX_MAX_CHUNK_TOKENS,
                    chunkSoftLimit + VOX_POST_FIRST_CHUNK_TOKEN_SLACK
                );
                const postFirstExpandedCharLimit = VOX_MAX_CHUNK_CHARS + VOX_POST_FIRST_CHUNK_CHAR_SLACK;

                if (pendingTtsSentences.length > 0 && pendingTtsTokens + tokenLen > chunkSoftLimit) {
                    const pendingText = pendingTtsSentences.join(" ").replace(/\s+/g, " ").trim();
                    const canWaitForBetterBoundary = isPostFirstChunk
                        && combinedPendingTokens <= postFirstExpandedTokenLimit
                        && combinedPendingChars <= postFirstExpandedCharLimit;
                    if (!(IS_VOX_TTS && isTooShortStandaloneVoxChunk(pendingText)) && !canWaitForBetterBoundary) {
                        flushPendingTtsChunk({ force: true });
                    }
                }

                pendingTtsSentences.push(piece);
                pendingTtsTokens += tokenLen;

                const pendingText = pendingTtsSentences.join(" ").replace(/\s+/g, " ").trim();
                const shouldAutoFlush = forceSingleSentenceChunk
                    || (
                        pendingTtsTokens >= chunkTarget * 0.9 &&
                        (!isPostFirstChunk || (hasStrongTrailingBoundary(pendingText) && !hasWeakTrailingPhrase(pendingText)))
                    );
                if (shouldAutoFlush) {
                    flushPendingTtsChunk({ force: forceSingleSentenceChunk });
                }
            }
        };

        try {
            const requestStartedAt = Date.now();

            // Stream LLM tokens
            for await (const token of streamLLM(messages, abortController.signal, { chatId: this.chatId })) {
                if (!isRequestStillCurrent()) break;
                if (turnStats.llmFirstTokenAt === null) {
                    turnStats.llmFirstTokenAt = Date.now();
                    logEvent("LLM", "first_token", {
                        chat: this.chatId,
                        request: requestId,
                        latency: formatMs(turnStats.llmFirstTokenAt - requestStartedAt),
                    });
                }

                fullResponse += token;
                sentenceBuffer += token;

                // Emit token to client for display
                this.socket.emit("server:token", {
                    chatId: this.chatId,
                    messageId: requestId,
                    token,
                });

                // Check for complete sentences to synthesize
                const { sentences, remainder } = chunkSentences(sentenceBuffer);
                sentenceBuffer = remainder;

                for (const sentence of sentences) {
                    if (!isRequestStillCurrent()) break;
                    queueTtsSentence(sentence);
                }

                if (IS_VOX_TTS && ttsChunkIndex === 0 && pendingTtsSentences.length === 0) {
                    const early = splitEarlySpeakableUnit(sentenceBuffer, Math.max(6, Math.floor(chunkTargetFor(0) * 0.8)));
                    if (early.unit) {
                        queueTtsSentence(early.unit);
                        sentenceBuffer = early.remainder;
                        flushPendingTtsChunk();
                    }
                }
            }

            // Synthesize remaining text
            if (sentenceBuffer.trim() && isRequestStillCurrent()) {
                queueTtsSentence(sentenceBuffer.trim());
            }

            flushPendingTtsChunk({ force: true });
            await ttsQueue;

            if (!isRequestStillCurrent()) {
                return;
            }

            const latencyMs = Date.now() - requestStartedAt;
            const activeLlm = getActiveLlmSettings();
            logEvent("LLM", "done", {
                chat: this.chatId,
                request: requestId,
                model: activeLlm.model,
                first_token: formatMs(turnStats.llmFirstTokenAt === null ? null : turnStats.llmFirstTokenAt - requestStartedAt),
                elapsed: formatMs(latencyMs),
                chars: fullResponse.length,
                tokens: estimateTokenCount(fullResponse),
            });
            if (LOG_LLM_RESPONSE_TEXT) {
                logEvent("LLM", "response", {
                    chat: this.chatId,
                    request: requestId,
                    text: textForLog(fullResponse, LOG_LLM_RESPONSE_MAX_CHARS),
                });
            }

            // Update history
            if (!syntheticUser) {
                this.history.push({ role: "user", content: userText });
            }
            this.history.push({ role: "assistant", content: fullResponse });
        } catch (err) {
            if (!abortController.signal.aborted) {
                console.error(`[Pipeline] Error:`, err.message);
                this.socket.emit("server:error", {
                    chatId: this.chatId,
                    message: err.message,
                });
            }
        } finally {
            if (this.currentRequestId === requestId) {
                logEvent("TURN", "done", {
                    chat: this.chatId,
                    request: requestId,
                    elapsed: formatMs(Date.now() - turnStartedAt),
                    llm_first: formatMs(turnStats.llmFirstTokenAt === null ? null : turnStats.llmFirstTokenAt - turnStartedAt),
                    tts_first: formatMs(turnStats.ttsFirstAudioAt === null ? null : turnStats.ttsFirstAudioAt - turnStartedAt),
                    tts_ttfs: formatMs(turnStats.ttsFirstTtfsMs),
                    tts_chunks: turnStats.ttsChunksSent,
                    tts_subchunks: turnStats.ttsStreamSubchunks,
                    audio: formatMs(turnStats.ttsAudioMs),
                    rtfx: formatRtfx(turnStats.ttsTotalElapsedMs, turnStats.ttsAudioMs),
                    bytes: formatBytes(turnStats.ttsBytes),
                });
                this.isSpeaking = false;
                this.socket.emit("server:assistant_message_finished", {
                    chatId: this.chatId,
                    messageId: requestId,
                });
                this.socket.emit("server:status", { chatId: this.chatId, state: "listening" });
                this.resetSilenceTimer();
            }
        }
    }

    async synthesizeAndSend(text, requestId, signal, { isFirstChunk = false, chunkIndex = 0, turnStats = null, continuationCacheOverride } = {}) {
        try {
            const ttsText = sanitizeForSpeech(text, {
                isFirstChunk,
                seed: `${requestId}:${chunkIndex}:${this.chatId}`,
            });
            if (!ttsText) return;
            const maxLenOverride = computeVoxMaxLen(ttsText);
            if (ttsText !== text) {
                logEvent("TTS", "sanitized", {
                    chat: this.chatId,
                    request: requestId,
                    chunk: chunkIndex,
                    from: text,
                    to: ttsText,
                });
            }
            logEvent("TTS", "request", {
                chat: this.chatId,
                request: requestId,
                chunk: chunkIndex,
                raw_text: text,
                tts_text: ttsText,
                is_first_chunk: isFirstChunk,
                continuation_cache: continuationCacheOverride,
                max_len: maxLenOverride,
                cfg: voxCfgForText(ttsText),
                temperature: voxTemperatureForText(ttsText),
                seam_ms: VOX_SEAM_MS,
                split_steers: VOX_SPLIT_STEERS,
                dit_steps: VOX_DIT_STEPS,
            });

            let startupPcmBuffers = [];
            let startupBytes = 0;
            let startupDurationMs = 0;
            let startupReleased = false;
            let startupStreamSubIndex = 0;
            let startupIsFinal = false;
            const STARTUP_TARGET_MS = 140;
            const STARTUP_MAX_SUBCHUNKS = 2;
            const emitSentenceAudio = ({ pcmBuffer, sampleRate, streamSubIndex, isFinalStreamChunk, textOverride }) => {
                if (signal.aborted || !pcmBuffer || !pcmBuffer.length) return;
                const durationMs = Math.max(0, Math.round((pcmBuffer.length / (2 * sampleRate)) * 1000));
                const startsAt = Math.max(Date.now(), this.assistantAudioEndsAt || 0);
                this.assistantAudioEndsAt = startsAt + durationMs;
                if (turnStats && turnStats.ttsFirstAudioAt === null) {
                    turnStats.ttsFirstAudioAt = Date.now();
                }
                this.socket.emit("server:sentence_audio", {
                    chatId: this.chatId,
                    messageId: requestId,
                    audio: pcmBuffer,
                    text: textOverride ?? (streamSubIndex === 0 ? ttsText : ""),
                    sampleRate,
                    channels: 1,
                    bitDepth: 16,
                    chunkIndex,
                    streamSubIndex,
                    isStreamingChunk: true,
                    isFinalStreamChunk,
                });
            };
            const flushStartupAudio = (sampleRate) => {
                if (startupReleased || !startupPcmBuffers.length) return;
                startupReleased = true;
                emitSentenceAudio({
                    pcmBuffer: Buffer.concat(startupPcmBuffers),
                    sampleRate,
                    streamSubIndex: 0,
                    isFinalStreamChunk: startupIsFinal,
                    textOverride: ttsText,
                });
                startupPcmBuffers = [];
                startupBytes = 0;
                startupDurationMs = 0;
            };
            const streamMeta = await synthesizeSpeech(ttsText, signal, {
                isFirstChunk,
                logMeta: {
                    chatId: this.chatId,
                    requestId,
                    chunkIndex,
                },
                continuationCacheOverride,
                maxLenOverride,
                onChunk: ({ pcmBuffer, sampleRate, streamSubIndex, isFinalStreamChunk }) => {
                    if (signal.aborted || !pcmBuffer || !pcmBuffer.length) return;
                    if (!startupReleased) {
                        startupPcmBuffers.push(pcmBuffer);
                        startupBytes += pcmBuffer.length;
                        startupDurationMs += Math.max(0, Math.round((pcmBuffer.length / (2 * sampleRate)) * 1000));
                        startupStreamSubIndex = streamSubIndex;
                        startupIsFinal = Boolean(isFinalStreamChunk);
                        const startupSubchunkCount = streamSubIndex + 1;
                        if (
                            startupIsFinal
                            || startupDurationMs >= STARTUP_TARGET_MS
                            || startupSubchunkCount >= STARTUP_MAX_SUBCHUNKS
                        ) {
                            flushStartupAudio(sampleRate);
                        }
                        return;
                    }
                    emitSentenceAudio({ pcmBuffer, sampleRate, streamSubIndex, isFinalStreamChunk });
                },
            });
            if (!startupReleased && startupPcmBuffers.length > 0 && Number.isFinite(streamMeta?.sampleRate)) {
                flushStartupAudio(streamMeta.sampleRate);
            }
            if (signal.aborted) return;
            if (turnStats) {
                turnStats.ttsChunksSent += 1;
                turnStats.ttsStreamSubchunks += Number(streamMeta.streamChunks || 0);
                turnStats.ttsBytes += Number(streamMeta.totalBytes || 0);
                turnStats.ttsAudioMs += Number(streamMeta.audioMs || 0);
                turnStats.ttsTotalElapsedMs += Number(streamMeta.elapsedMs || 0);
                if (turnStats.ttsFirstTtfsMs === null && Number.isFinite(streamMeta.firstMs)) {
                    turnStats.ttsFirstTtfsMs = streamMeta.firstMs;
                }
            }
            if (DEBUG_TTS || LOG_TTS_VERBOSE) {
                logEvent("TTS", "sent", {
                    chat: this.chatId,
                    request: requestId,
                    chunk: chunkIndex,
                    chars: ttsText.length,
                    bytes: formatBytes(streamMeta.totalBytes),
                    audio: formatMs(streamMeta.audioMs),
                    ttfs: formatMs(streamMeta.firstMs),
                    elapsed: formatMs(streamMeta.elapsedMs),
                    rtfx: formatRtfx(streamMeta.elapsedMs, streamMeta.audioMs),
                    subchunks: streamMeta.streamChunks,
                });
            }
        } catch (err) {
            if (!signal.aborted) {
                console.error(`[TTS] Error:`, err.message);
            }
        }
    }

    cancelCurrentGeneration() {
        const cancelledRequestId = this.currentRequestId;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isSpeaking = false;
        this.currentRequestId = null;
        return cancelledRequestId;
    }

    /**
     * Cancel the current LLM generation and wait for all pending TTS audio to drain.
     * This gives text-mode barge-in the same natural gap that voice barge-in gets
     * from the user continuing to speak after the LLM is cancelled.
     */
    async flushTtsQueue() {
        this.cancelCurrentGeneration();
        // Wait for the TTS promise chain to settle (aborted tasks resolve quickly).
        try {
            await this._ttsQueue;
        } catch { /* abort errors are expected */ }
    }

    // ── Silence triggers ──

    resetSilenceTimer() {
        this.clearSilenceTimer();
        if (this.stopped) return;
        if (!SILENCE_CONFIG.enabled) return;
        if (this.silenceHasFired) return;

        const triggers = SILENCE_CONFIG.triggers || [];
        if (!triggers.length) return;

        // Fire only once per silence period: use the first trigger's delay/messages.
        const trigger = triggers[0];

        // Don't count silence while Maya is talking: start the timer after the later of
        // the last user speech OR the estimated end of assistant audio playback.
        const baseAt = Math.max(this.lastUserSpeechAt || 0, this.assistantAudioEndsAt || 0) || Date.now();
        const dueAt = baseAt + (Number(trigger.delaySeconds || 10) * 1000);

        const delayMs = Math.max(0, dueAt - Date.now());

        this.silenceTimer = setTimeout(() => {
            if (this.stopped) return;
            // If Maya is currently speaking/processing, retry shortly instead of dropping the trigger.
            if (this.isSpeaking) {
                this.silenceTimer = setTimeout(() => this.resetSilenceTimer(), 500);
                return;
            }

            const msgs = Array.isArray(trigger.messages) ? trigger.messages.filter(Boolean) : [];
            const raw = msgs.length ? msgs[Math.floor(Math.random() * msgs.length)] : "...";
            const injected = String(raw)
                .replaceAll("{userName}", this.userName || "there")
                .trim();

            console.log(`[Silence] Triggering for ${this.chatId} delay=${trigger.delaySeconds}s`);
            this.silenceHasFired = true;
            this.processUserMessage(injected, { syntheticUser: true });
        }, delayMs);
    }

    clearSilenceTimer() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }

    // ── Opening message ──

    sendOpeningMessage() {
        // Check if opening messages are disabled
        if (SILENCE_CONFIG.disableOpeningMessage) return;
        const openingMessages = SILENCE_CONFIG.openingMessages;
        if (!openingMessages) return;

        const hasMemory = this.history.length > 0;
        const hasName = Boolean(this.userName);

        let pool;
        if (hasMemory && hasName) {
            pool = openingMessages.hasMemoryAndName;
        } else if (hasMemory && !hasName) {
            pool = openingMessages.hasMemoryNoName;
        } else if (!hasMemory && hasName) {
            pool = openingMessages.noMemoryHasName;
        } else {
            pool = openingMessages.noMemoryNoName;
        }
        pool = Array.isArray(pool) ? pool.filter(Boolean) : [];
        if (!pool.length) return;

        let msg = pool[Math.floor(Math.random() * pool.length)];
        msg = String(msg).replaceAll("{userName}", this.userName || "there");
        // Fire opening message after a short delay
        this.openingTimer = setTimeout(() => {
            this.openingTimer = null;
            if (this.stopped) return;
            if (this.isSpeaking) return;
            this.processUserMessage(msg, { syntheticUser: true });
        }, 500);
    }
}

// ─── Socket.IO Connection Handler ────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);
    let session = null;
    let sawAudio = false;

    socket.on("client:voice_stream_start", (payload) => {
        const chatId = payload?.chatId || `chat-${generateId()}`;
        const userName = payload?.userName || "";
        const rawHistory = payload?.history;
        const history = Array.isArray(rawHistory)
            ? rawHistory
                .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
                .map((m) => ({ role: m.role, content: String(m.content) }))
                .slice(-100)
            : [];
        console.log(`[Voice] Stream start: ${chatId}`);

        // Clean up previous session
        if (session) session.stop("replaced", 1000);

        session = new VoiceSession(socket, chatId, { userName, history });
        session.start();
    });

    socket.on("client:voice_audio_chunk", (payload) => {
        if (!session) return;
        const audioData = payload?.audio;
        if (audioData) {
            if (!sawAudio) {
                sawAudio = true;
                const kind = Buffer.isBuffer(audioData)
                    ? "Buffer"
                    : (audioData instanceof Uint8Array ? "Uint8Array" : (audioData instanceof ArrayBuffer ? "ArrayBuffer" : typeof audioData));
                const len = Buffer.isBuffer(audioData)
                    ? audioData.length
                    : (audioData?.byteLength || audioData?.length || 0);
                console.log(`[Audio] First chunk chat=${session.chatId} kind=${kind} bytes=${len}`);
            }

            // Preferred: client sends linear16 bytes (Uint8Array/Buffer) already.
            if (Buffer.isBuffer(audioData)) {
                session.sendAudio(audioData);
                return;
            }
            if (audioData instanceof Uint8Array) {
                session.sendAudio(Buffer.from(audioData));
                return;
            }

            // Back-compat: client sends Float32 PCM ArrayBuffer.
            let arrayBuffer = null;
            if (audioData instanceof ArrayBuffer) {
                arrayBuffer = audioData;
            } else if (audioData?.buffer instanceof ArrayBuffer) {
                // e.g. TypedArray views
                arrayBuffer = audioData.buffer.slice(
                    audioData.byteOffset || 0,
                    (audioData.byteOffset || 0) + (audioData.byteLength || audioData.length || 0)
                );
            }
            if (!arrayBuffer) return;

            const float32 = new Float32Array(arrayBuffer);
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
            }
            session.sendAudio(Buffer.from(int16.buffer));
        }
    });

    socket.on("client:voice_stream_stop", () => {
        console.log(`[Voice] Stream stop`);
        if (session) {
            session.stop("client_stop", 1000);
            session = null;
        }
    });

    socket.on("client:mic_toggle", (payload) => {
        if (!session) return;
        const muted = payload?.muted === true;
        if (muted) {
            console.log(`[Mic] Muted for ${session.chatId}`);
            session.pauseDeepgram();
        } else {
            console.log(`[Mic] Unmuted for ${session.chatId}`);
            session.resumeDeepgram();
        }
    });

    socket.on("client:cancel_generation", () => {
        if (session) {
            session.cancelCurrentGeneration();
            socket.emit("server:assistant_message_cancelled", {
                chatId: session.chatId,
            });
            socket.emit("server:status", { chatId: session.chatId, state: "listening" });
        }
    });

    socket.on("client:text_message", async (payload) => {
        if (!session) return;
        const text = String(payload?.text || "").trim();
        if (!text) return;
        const hasAssistantAudioInFlight = (session.assistantAudioEndsAt || 0) > Date.now();

        // Barge-in: if Maya is speaking, cancel and wait for pending TTS to drain
        // before processing the new message — same natural gap that voice barge-in
        // gets from the user continuing to speak after the LLM is cancelled.
        if (session.isSpeaking || hasAssistantAudioInFlight) {
            const cancelledRequestId = session.cancelCurrentGeneration();
            session.assistantAudioEndsAt = Date.now();
            socket.emit("server:assistant_message_cancelled", {
                chatId: session.chatId,
                messageId: cancelledRequestId,
            });
            socket.emit("server:status", { chatId: session.chatId, state: "listening" });
            await session.flushTtsQueue();
        }

        socket.emit("server:user_voice_message", {
            chatId: session.chatId,
            text,
            isFinal: true,
        });
        session.processUserMessage(text);
    });

    socket.on("client:clear_context", () => {
        if (!session) return;
        console.log(`[Voice] Clear context: ${session.chatId}`);
        session.clearContext();
    });

    socket.on("client:update_user_name", (payload) => {
        if (!session) return;
        const next = String(payload?.userName || "").trim();
        session.userName = next;
        console.log(`[Voice] Name updated chat=${session.chatId} name=${JSON.stringify(next)}`);
    });

    socket.on("disconnect", () => {
        console.log(`[Socket] Disconnected: ${socket.id}`);
        if (session) {
            session.stop("client_disconnect", 1001);
            session = null;
        }
    });
});

// ─── Start Server ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    const localUrl = `${protocol}://localhost:${PORT}`;
    const lanUrl = getLanUrl();
    const activeLlm = getActiveLlmSettings();
    console.log(`
╔══════════════════════════════════════════╗
║         🎙️  MayaClone v1.0              ║
║         Voice Chat Server               ║
╠══════════════════════════════════════════╣
║  URL:    ${localUrl.slice(0, 30).padEnd(30)}  ║
║  LAN:    ${(lanUrl || "not detected").slice(0, 30).padEnd(30)}  ║
║  LLM:    ${activeLlm.model.slice(0, 30).padEnd(30)}  ║
║  TTS:    ${TTS_ENDPOINT.slice(0, 30).padEnd(30)}  ║
║  Voice:  ${`${TTS_BACKEND}:${IS_VOX_TTS ? "loaded_model" : TTS_VOICE}`.slice(0, 30).padEnd(30)}  ║
║  SSL:    ${protocol === "https" ? "enabled " : "disabled"} ${" ".repeat(22)}║
╚══════════════════════════════════════════╝
  `);
});
