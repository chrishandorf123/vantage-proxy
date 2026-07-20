# VANTAGE AI Proxy

The only place your Anthropic API key lives. The app sends AI requests here; this service adds the key, picks the right model per feature, caches the stable prompt prefix, enforces budgets, and logs a meter line per call.

## Deploy on Render (5 minutes)
1. Render dashboard, New +, Web Service, upload this folder (or the zip).
2. Environment tab: add ONE key. OPENAI_API_KEY (from platform.openai.com) or ANTHROPIC_API_KEY (from console.anthropic.com). The proxy detects the provider automatically. Never put a key anywhere else.
3. Create the service. Copy its URL (like https://vantage-proxy.onrender.com).
4. In the VANTAGE app: FORGE, paste that URL into AI PROXY URL, SAVE, then TEST (expect CONNECTED).

## Environment variables
- OPENAI_API_KEY or ANTHROPIC_API_KEY (one required; provider auto-detected). AI_PROVIDER can force it.
- ALLOWED_ORIGIN: set to your app URL (like https://vantage.onrender.com) once live. Default * is fine for setup, tighten it after.
- DAILY_CALL_CAP (default 400) and DAILY_TOKEN_CAP (default 250000): per-user daily budget. The app degrades gracefully at the cap; deterministic features are never affected.

## Model routing
Live features (copilot, SPAR turns) run the fast tier: Haiku 4.5 on Anthropic, gpt-5.4-mini on OpenAI. Judgment features (SPAR grading, RECON, briefs, drafts) run the strong tier: Sonnet 4.6 or gpt-5.4. One note for OpenAI: RECON's live web search is an Anthropic-side tool, so on OpenAI the app automatically falls back to model-knowledge mode for account briefs, clearly labeled. Everything else is identical. Edit the MODELS map in server.js to retune; no app redeploy needed.

## Reading the meter
Each call logs one JSON line in the Render logs: feature, model, input/output tokens, cache write and read tokens, latency, and that user's running daily totals. This is your cost telemetry; pricing decisions come from these lines.

## Notes
- Free Render instances sleep when idle; the first call after a quiet stretch takes 30 to 60 seconds. Move to the paid instance before reps dial live.
- Budgets are in-memory (reset on restart). Good enough pre-accounts; they move to the database in Phase 2.


## Optional: Deepgram speech ear
Set `DEEPGRAM_API_KEY` (create the key in the Deepgram console with **Member** permissions) and the proxy exposes `/api/stt-token`, which mints 30-second streaming tokens for the app's DEEPGRAM ear. Without it, the app's browser speech engine keeps working as before.
