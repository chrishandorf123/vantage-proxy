/* VANTAGE AI Proxy — multi-provider edition.
   Give it ONE key (OpenAI or Anthropic); it detects the provider, routes each
   feature to the right model, translates request/response shapes so the app
   never cares which brain is behind it, enforces budgets, and meters every call. */
const express = require("express");
const cors = require("cors");

const ANT_KEY = process.env.ANTHROPIC_API_KEY || "";
const OAI_KEY = process.env.OPENAI_API_KEY || "";
const GEN_KEY = process.env.AI_API_KEY || "";
let PROVIDER = (process.env.AI_PROVIDER || "").toLowerCase();
let KEY = "";
if (!PROVIDER) {
  if (OAI_KEY) PROVIDER = "openai";
  else if (ANT_KEY) PROVIDER = "anthropic";
  else if (GEN_KEY) PROVIDER = GEN_KEY.startsWith("sk-ant-") ? "anthropic" : "openai";
}
KEY = PROVIDER === "anthropic" ? (ANT_KEY || GEN_KEY) : (OAI_KEY || GEN_KEY);
if (!KEY || !PROVIDER) { console.error("FATAL: set OPENAI_API_KEY or ANTHROPIC_API_KEY (or AI_API_KEY) in the environment."); process.exit(1); }

const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const DAILY_CALL_CAP  = +(process.env.DAILY_CALL_CAP  || 400);
const DAILY_TOKEN_CAP = +(process.env.DAILY_TOKEN_CAP || 250000);
const PORT = process.env.PORT || 10000;

/* Feature -> model, per provider. Live features ride the fast tier; judgment features ride the strong tier. */
const MODELS = {
  anthropic: { copilot: "claude-haiku-4-5-20251001", spar: "claude-haiku-4-5-20251001",
               spar_grade: "claude-sonnet-4-6", recon: "claude-sonnet-4-6", brief: "claude-sonnet-4-6",
               draft: "claude-sonnet-4-6", default: "claude-haiku-4-5-20251001" },
  openai:    { copilot: "gpt-5.4-mini", spar: "gpt-5.4-mini",
               spar_grade: "gpt-5.4", recon: "gpt-5.4", brief: "gpt-5.4",
               draft: "gpt-5.4", default: "gpt-5.4-mini" }
};

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: "300kb" }));

const day = () => new Date().toISOString().slice(0, 10);
const meters = new Map(), recent = new Map(), lastCopilot = new Map();
const meter = ip => { const k = ip + "|" + day(); if (!meters.has(k)) meters.set(k, { calls: 0, toks: 0 }); return meters.get(k); };

app.get("/api/health", (_req, res) => res.json({ ok: true, provider: PROVIDER, models: MODELS[PROVIDER] }));

app.post("/api/ai", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").toString().split(",")[0].trim();
  const t0 = Date.now();
  try {
    const now = Date.now();
    const win = (recent.get(ip) || []).filter(t => now - t < 60000);
    if (win.length >= 20) return res.status(429).json({ type: "cap", message: "Rate limit: 20 calls per minute." });
    win.push(now); recent.set(ip, win);

    const { feature = "default", system, messages, max_tokens, tools } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "messages required" });

    if (feature === "copilot") {
      if (now - (lastCopilot.get(ip) || 0) < 4000) return res.status(429).json({ type: "cap", message: "Copilot cooldown." });
      lastCopilot.set(ip, now);
    }
    const m = meter(ip);
    if (m.calls >= DAILY_CALL_CAP || m.toks >= DAILY_TOKEN_CAP)
      return res.status(429).json({ type: "cap", message: "Daily AI budget reached. Resets at midnight UTC." });

    const model = MODELS[PROVIDER][feature] || MODELS[PROVIDER].default;
    const maxOut = Math.min(+max_tokens || 1200, 1500);
    let url, headers, body;

    if (PROVIDER === "anthropic") {
      url = "https://api.anthropic.com/v1/messages";
      headers = { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" };
      body = { model, max_tokens: maxOut, messages };
      if (system) body.system = [{ type: "text", text: String(system).slice(0, 20000), cache_control: { type: "ephemeral" } }];
      if (tools) body.tools = tools;
    } else {
      if (tools && tools.some(t => String(t.type || "").startsWith("web_search")))
        return res.status(400).json({ error: { message: "web_search tool is not supported on this provider; retry without tools." } });
      url = "https://api.openai.com/v1/chat/completions";
      headers = { "Content-Type": "application/json", "Authorization": "Bearer " + KEY };
      body = { model, max_completion_tokens: maxOut,
               messages: [ ...(system ? [{ role: "system", content: String(system).slice(0, 20000) }] : []), ...messages ] };
    }

    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch (_) {
      console.log(JSON.stringify({ t: new Date().toISOString(), ip: ip.slice(-6), provider: PROVIDER, feature, err: r.status, nonjson: true }));
      return res.status(r.ok ? 502 : r.status).type("text/plain").send(String(raw).slice(0, 500));
    }
    let usage = null;

    if (r.ok) {
      if (PROVIDER === "openai") {
        const u = data.usage || {};
        usage = { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0,
                  cache_read_input_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 };
        data = { content: [{ type: "text", text: ((data.choices || [])[0] || {}).message?.content || "" }], usage };
      } else usage = data.usage;
    }

    if (r.ok && usage) {
      const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      m.calls += 1; m.toks += inTok + (usage.output_tokens || 0);
      console.log(JSON.stringify({ t: new Date().toISOString(), ip: ip.slice(-6), provider: PROVIDER, feature, model,
        in: usage.input_tokens || 0, cache_read: usage.cache_read_input_tokens || 0, cache_write: usage.cache_creation_input_tokens || 0,
        out: usage.output_tokens || 0, ms: Date.now() - t0, day_calls: m.calls, day_toks: m.toks }));
    } else if (!r.ok) {
      console.log(JSON.stringify({ t: new Date().toISOString(), ip: ip.slice(-6), provider: PROVIDER, feature, err: r.status, ms: Date.now() - t0 }));
    }
    res.status(r.status).json(data);
  } catch (e) {
    console.log(JSON.stringify({ t: new Date().toISOString(), ip: ip.slice(-6), err: String(e.message).slice(0, 120) }));
    res.status(502).json({ error: "upstream", message: "Could not reach the model API." });
  }
});

app.listen(PORT, () => console.log("VANTAGE proxy up on :" + PORT + " · provider " + PROVIDER + " · caps " + DAILY_CALL_CAP + " calls / " + DAILY_TOKEN_CAP + " tokens per user-day"));
