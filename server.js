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
const fetch = require("node-fetch");
const { encode } = require("gpt-tokenizer");

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const TTS_ENDPOINT = String(process.env.TTS_ENDPOINT || "http://localhost:8002").replace(/\/+$/, "");
const TTS_VOICE = process.env.TTS_VOICE || "mayalong9";
const LLM_BASE_URL = String(process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "moonshotai/kimi-k2-instruct-0905";
const LLM_CHAT_COMPLETIONS_URL = new URL("chat/completions", `${LLM_BASE_URL}/`).toString();


const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || 300;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const RAW_DEEPGRAM_MODEL = (process.env.DEEPGRAM_MODEL || "nova-3").trim();
const DEEPGRAM_MODEL = RAW_DEEPGRAM_MODEL.toLowerCase() === "flux"
    ? "flux-general-en"
    : (RAW_DEEPGRAM_MODEL || "nova-3");
const DEEPGRAM_IS_FLUX = /^flux($|-)/i.test(DEEPGRAM_MODEL);
const FLUX_EAGER_EOT_THRESHOLD = (process.env.FLUX_EAGER_EOT_THRESHOLD || "").trim();
const FLUX_EOT_THRESHOLD = (process.env.FLUX_EOT_THRESHOLD || "").trim();
const FLUX_EOT_TIMEOUT_MS = (process.env.FLUX_EOT_TIMEOUT_MS || "").trim();

// Load Maya system prompt
const SYSTEM_PROMPT = (() => {
    const promptPath = path.join(__dirname, "prompts", "maya.md");
    try {
        return fs.readFileSync(promptPath, "utf-8").trim();
    } catch (err) {
        console.warn("[WARN] Could not load prompts/maya.md:", err.message);
        return "You are Maya, a friendly and charismatic young woman. Be natural and conversational.";
    }
})();

// Load silence triggers
const SILENCE_CONFIG = (() => {
    const cfgPath = path.join(__dirname, "config", "silence-triggers.json");
    try {
        return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    } catch (err) {
        return { enabled: false, triggers: [], openingMessages: {} };
    }
})();

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
const TTS_TOKEN_TARGETS = parseChunkSchedule(process.env.TTS_TOKEN_TARGETS, [15, 40, 50, 50, 50, 50, 60, 60, 61]);
const TTS_CHUNK_FLEX = Math.max(1, Number(process.env.TTS_CHUNK_FLEX) || 1.0);
const TTS_CFG_SCALE_TEXT = Number(process.env.TTS_CFG_SCALE_TEXT) || 2.5;
const TTS_CFG_SCALE_SPEAKER = Number(process.env.TTS_CFG_SCALE_SPEAKER) || 5.0;
const TTS_TRUNCATION_FACTOR = Number(process.env.TTS_TRUNCATION_FACTOR) || 0.9;
const TTS_SPEAKER_KV_SCALE = Number(process.env.TTS_SPEAKER_KV_SCALE) || 1.0;
const TTS_SEED = Number(process.env.TTS_SEED) || 0;
const DEBUG_TTS = process.env.DEBUG_TTS === "1";
const LOG_LLM_RESPONSE_MAX_CHARS = Number(process.env.LOG_LLM_RESPONSE_MAX_CHARS) || 2500;

function truncateForLog(value, maxChars) {
    const s = String(value || "");
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + `…[+${s.length - maxChars} chars]`;
}

// ─── HTTP / HTTPS + Socket.IO ────────────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ status: "ok" }));

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

function normalizeChunkText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
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

function parseChunkSchedule(value, fallback) {
    const parsed = parseNumberList(value, fallback)
        .map((item) => Math.max(1, Math.round(item)))
        .filter((item) => Number.isFinite(item) && item > 0);
    return parsed.length ? parsed : [...fallback];
}

const TTS_ALLOWED_TAGS = ["whispering", "laughing", "laughs", "laugh", "chuckling", "singing", "sighs"];
const TTS_LAUGHTER_TAGS = process.env.TTS_LAUGHTER_TAGS !== "0";
const TTS_SOFTEN_EXCLAMATIONS = process.env.TTS_SOFTEN_EXCLAMATIONS !== "0";
const TTS_EXCLAMATION_KEEP_RATE = Math.min(
    1,
    Math.max(0, Number(process.env.TTS_EXCLAMATION_KEEP_RATE) || 0.1)
);

function sanitizeForSpeech(text, { isFirstChunk = false, seed = "" } = {}) {
    if (!text) return "";
    let clean = String(text);

    clean = clean
        .replace(/\*\*|__/g, "")
        .replace(/\*|_/g, "")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, " ")
        .trim();

    if (TTS_LAUGHTER_TAGS) {
        clean = clean.replace(/\b(?:ha){2,}\b/gi, (match) => (match.length >= 6 ? "(laughing)" : "(laugh)"));
        clean = clean.replace(/\bhah+\b/gi, "(laugh)");
        clean = clean.replace(/\bha\b/gi, "(laugh)");
    }

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

    if (isFirstChunk) {
        clean = clean.replace(/^\s*(\(([^)]*)\)|\[([^\]]*)\])\s*/g, (match, _whole, parenContent, bracketContent) => {
            const content = parenContent ?? bracketContent ?? "";
            return isAllowedTag(content) ? "" : "";
        });
    }

    clean = clean
        .replace(/\s+([,.;!?])/g, "$1")
        .replace(/([.?!]){3,}/g, "$1..")
        .replace(/\s+/g, " ")
        .trim();

    return clean;
}

/** Call EchoTTS API and stream PCM audio chunks */
async function synthesizeSpeech(text, signal, { isFirstChunk = false, onChunk } = {}) {
    const url = `${TTS_ENDPOINT}/v1/audio/speech`;
    const startedAt = Date.now();
    const textLen = String(text || "").length;
    if (DEBUG_TTS) console.log(`[TTS] Request url=${url} voice=${TTS_VOICE} chars=${textLen}`);
    const blockSizes = isFirstChunk ? TTS_FIRST_CHUNK_BLOCK_SIZES : TTS_BLOCK_SIZES;
    const numSteps = isFirstChunk ? TTS_FIRST_CHUNK_NUM_STEPS : TTS_NUM_STEPS;
    const requestBody = {
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

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
    });

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
        console.log(`[TTS] ok voice=${TTS_VOICE} chars=${textLen} bytes=${safe.length} ms=${ms} mode=fallback`);
        return { sampleRate, totalBytes: safe.length, streamChunks: safe.length ? 1 : 0 };
    }

    let streamSubIndex = 0;
    let totalBytes = 0;
    let pcmAccumulator = [];
    let pcmAccumulatorSize = 0;
    const MIN_CHUNK_SIZE_FIRST = 4096;
    const MIN_CHUNK_SIZE_STREAM = 8192;

    const emitChunk = (chunkBuffer, isFinalStreamChunk) => {
        if (!chunkBuffer || chunkBuffer.length === 0) return;
        let safeBuffer = chunkBuffer;
        if (safeBuffer.length % 2 !== 0) {
            safeBuffer = safeBuffer.subarray(0, safeBuffer.length - 1);
        }
        if (!safeBuffer.length) return;
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
    console.log(`[TTS] ok voice=${TTS_VOICE} chars=${textLen} bytes=${totalBytes} ms=${ms} subchunks=${streamSubIndex}`);
    return { sampleRate, totalBytes, streamChunks: streamSubIndex };
}

/** Stream LLM completion (OpenAI-compatible) */
async function* streamLLM(messages, signal) {
    const body = {
        model: LLM_MODEL,
        messages,
        max_tokens: LLM_MAX_TOKENS,
        stream: true,
        temperature: 0.85,
        top_p: 0.9,
    };

    const headers = {
        "Content-Type": "application/json",
    };
    if (LLM_API_KEY) {
        headers.Authorization = `Bearer ${LLM_API_KEY}`;
        // Gemini's OpenAI-compatible endpoint accepts Bearer keys in practice, but API keys
        // also commonly work as `x-goog-api-key`. Adding it only for Google avoids breaking others.
        if (/^https:\/\/generativelanguage\.googleapis\.com\//i.test(LLM_BASE_URL)) {
            headers["x-goog-api-key"] = LLM_API_KEY;
        }
    }

    const res = await fetch(LLM_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        // Do not log secrets; include URL + a short body excerpt for debugging.
        throw new Error(
            `LLM ${res.status}: ${truncateForLog(errText, 500)} (url=${LLM_CHAT_COMPLETIONS_URL})`
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

    ws.on("open", () => {
        console.log(
            `[STT] Deepgram connected for ${chatId} model=${DEEPGRAM_MODEL} api=${DEEPGRAM_IS_FLUX ? "v2" : "v1"}`
        );
        if (RAW_DEEPGRAM_MODEL.toLowerCase() === "flux") {
            console.log("[STT] DEEPGRAM_MODEL=flux normalized to flux-general-en");
        }
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
        this.history = Array.isArray(history) ? history : [];
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

    async processUserMessage(userText) {
        const requestId = generateId();
        this.currentRequestId = requestId;
        this.isSpeaking = true;
        this.clearSilenceTimer();

        this.socket.emit("server:status", { chatId: this.chatId, state: "thinking" });
        this.socket.emit("server:assistant_message_started", {
            chatId: this.chatId,
            messageId: requestId,
        });

        // Build messages
        const systemWithName = this.userName
            ? `${SYSTEM_PROMPT}\n\nThe user's name is ${this.userName}.`
            : SYSTEM_PROMPT;
        const messages = [
            { role: "system", content: systemWithName },
            ...this.history.slice(-20), // Keep last 20 messages for context
            { role: "user", content: userText },
        ];

        const abortController = new AbortController();
        this.abortController = abortController;

        let fullResponse = "";
        let sentenceBuffer = "";
        let ttsChunkIndex = 0;
        let pendingTtsSentences = [];
        let pendingTtsTokens = 0;
        const chunkTargets = TTS_TOKEN_TARGETS;
        const defaultChunkTarget = chunkTargets[chunkTargets.length - 1] || 61;
        const chunkTargetFor = (index) => chunkTargets[index] ?? defaultChunkTarget;
        const chunkSoftLimitFor = (index) => Math.max(chunkTargetFor(index), Math.ceil(chunkTargetFor(index) * TTS_CHUNK_FLEX));
        const flushPendingTtsChunk = async () => {
            if (!pendingTtsSentences.length || abortController.signal.aborted) return;
            const text = pendingTtsSentences.join(" ").replace(/\s+/g, " ").trim();
            pendingTtsSentences = [];
            pendingTtsTokens = 0;
            if (!text) return;
            await this.synthesizeAndSend(text, requestId, abortController.signal, {
                isFirstChunk: ttsChunkIndex === 0,
                chunkIndex: ttsChunkIndex,
            });
            ttsChunkIndex += 1;
        };
        const queueTtsSentence = async (sentence) => {
            const trimmedSentence = normalizeChunkText(sentence);
            if (!trimmedSentence || abortController.signal.aborted) return;

            const tokenLen = estimateTokenCount(trimmedSentence);
            const chunkSoftLimit = chunkSoftLimitFor(ttsChunkIndex);
            const chunkTarget = chunkTargetFor(ttsChunkIndex);
            const forceSingleSentenceChunk = tokenLen > chunkSoftLimit && pendingTtsSentences.length === 0;

            if (pendingTtsSentences.length > 0 && pendingTtsTokens + tokenLen > chunkSoftLimit) {
                await flushPendingTtsChunk();
            }

            pendingTtsSentences.push(trimmedSentence);
            pendingTtsTokens += tokenLen;

            if (forceSingleSentenceChunk || pendingTtsTokens >= chunkTarget * 0.9) {
                await flushPendingTtsChunk();
            }
        };

        try {
            const requestStartedAt = Date.now();

            // Stream LLM tokens
            for await (const token of streamLLM(messages, abortController.signal)) {
                if (abortController.signal.aborted) break;

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
                    if (abortController.signal.aborted) break;
                    await queueTtsSentence(sentence);
                }
            }

            // Synthesize remaining text
            if (sentenceBuffer.trim() && !abortController.signal.aborted) {
                await queueTtsSentence(sentenceBuffer.trim());
            }

            await flushPendingTtsChunk();

            const latencyMs = Date.now() - requestStartedAt;
            console.log(`[LLM] chat=${this.chatId} model=${LLM_MODEL} latency=${latencyMs}ms chars=${fullResponse.length}`);
            console.log(`[LLM] chat=${this.chatId} response=${JSON.stringify(truncateForLog(fullResponse, LOG_LLM_RESPONSE_MAX_CHARS))}`);

            // Update history
            this.history.push({ role: "user", content: userText });
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

    async synthesizeAndSend(text, requestId, signal, { isFirstChunk = false, chunkIndex = 0 } = {}) {
        try {
            const ttsText = sanitizeForSpeech(text, {
                isFirstChunk,
                seed: `${requestId}:${chunkIndex}:${this.chatId}`,
            });
            if (!ttsText) return;
            if (ttsText !== text) {
                console.log(
                    `[TTS] sanitized chat=${this.chatId} request=${requestId} chunk=${chunkIndex} from=${JSON.stringify(truncateForLog(text, 220))} to=${JSON.stringify(truncateForLog(ttsText, 220))}`
                );
            }

            const streamMeta = await synthesizeSpeech(ttsText, signal, {
                isFirstChunk,
                onChunk: ({ pcmBuffer, sampleRate, streamSubIndex, isFinalStreamChunk }) => {
                    if (signal.aborted || !pcmBuffer || !pcmBuffer.length) return;
                    const durationMs = Math.max(0, Math.round((pcmBuffer.length / (2 * sampleRate)) * 1000));
                    const startsAt = Math.max(Date.now(), this.assistantAudioEndsAt || 0);
                    this.assistantAudioEndsAt = startsAt + durationMs;
                    this.socket.emit("server:sentence_audio", {
                        chatId: this.chatId,
                        messageId: requestId,
                        audio: pcmBuffer,
                        text: streamSubIndex === 0 ? ttsText : "",
                        sampleRate,
                        channels: 1,
                        bitDepth: 16,
                        chunkIndex,
                        streamSubIndex,
                        isStreamingChunk: true,
                        isFinalStreamChunk,
                    });
                },
            });
            if (signal.aborted) return;
            if (DEBUG_TTS) {
                console.log(
                    `[TTS] Response chat=${this.chatId} request=${requestId} bytes=${streamMeta.totalBytes} subchunks=${streamMeta.streamChunks}`
                );
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
            this.processUserMessage(injected);
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
            this.processUserMessage(msg);
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

    socket.on("client:cancel_generation", () => {
        if (session) {
            session.cancelCurrentGeneration();
            socket.emit("server:assistant_message_cancelled", {
                chatId: session.chatId,
            });
            socket.emit("server:status", { chatId: session.chatId, state: "listening" });
        }
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
    console.log(`
╔══════════════════════════════════════════╗
║         🎙️  MayaClone v1.0              ║
║         Voice Chat Server               ║
╠══════════════════════════════════════════╣
║  URL:    ${localUrl.slice(0, 30).padEnd(30)}  ║
║  LAN:    ${(lanUrl || "not detected").slice(0, 30).padEnd(30)}  ║
║  LLM:    ${LLM_MODEL.slice(0, 30).padEnd(30)}  ║
║  TTS:    ${TTS_ENDPOINT.slice(0, 30).padEnd(30)}  ║
║  SSL:    ${protocol === "https" ? "enabled " : "disabled"} ${" ".repeat(22)}║
╚══════════════════════════════════════════╝
  `);
});
