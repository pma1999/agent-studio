# Agent Studio

A self-hosted workspace for building and running AI agents. Create agents with your own system prompts, chat with them over streaming, let them run **real tools** — shell commands on your own machine, cloud sandboxes, web browsing, file operations — connect MCP servers, define reusable **skills**, and have several models deliberate on the same question at once (**Model Council**).

Not tied to a single provider: talk to 300+ models through **OpenRouter**, to **DeepSeek** directly, to the models in your own **ChatGPT (Codex)** plan, or to **local llama.cpp** models running on your machine.

> 🇪🇸 [**README completo en español**](README.es.md) — full documentation, architecture notes and deployment guide.

---

## Why this exists

Most agent UIs give you a chat box and a model picker. The hard parts are everywhere else: what happens when the client disconnects mid-generation, how a tool call gets approved before it touches your filesystem, what a second opinion from another model actually costs, and how you keep credentials out of reach while still letting an agent do useful work. Agent Studio is where I worked through those problems end to end.

## Highlights

**Chat that survives reality**
Real-time streaming with collapsible reasoning per message and effort control (`minimal → max`). A **message tree**: edit and re-run any user message as a sibling variant, page between variants, retry, and stop with true server-side cancellation. Generation **survives client disconnect** — the draft is persisted and recovered by polling `active_turn_id`, so closing the tab cancels nothing. PDF attachments (5 x 20 MB) with a selectable engine: auto, text extraction, Mistral OCR, or provider-native.

**Four providers, one interface**
OpenRouter (300+ models, endpoint pinning with live price/uptime, OAuth PKCE or manual key) - DeepSeek direct with live balance - ChatGPT/Codex via device-code login, using your plan rather than an API key - local llama.cpp, where the app spawns and supervises a `llama-server` on your PC with FAST/BALANCED/DEEP presets and idle unloading.

**Model Council**
Several models answer the same prompt in parallel; the results are compared for agreement, disagreement and unique findings; a synthesizer model writes the final answer. Runs are persisted and inspectable.

**Your computer as the backend**
Pair your PC with a one-time code (10 min, single use) and the local agent exposes real command execution, full file operations, file transfer, and locally hosted MCP stdio + llama.cpp. Cloud alternative: **E2B** sandboxed execution.

**Extensibility**
**MCP** servers over URL (StreamableHTTP/SSE), `stdio` (off by default), or `relay` through your paired PC — with connection testing, encrypted credentials and **per-call human approval**. Claude-style **skills** (`SKILL.md`) with paste-to-create, pre-validation, ZIP import, and executable scripts.

**Also** — public share links with frozen snapshots and revocable single-view tokens, JSON export/import of agents/tools/MCP servers, per-message token and cost accounting, optional multi-user auth or local no-login mode, and a fully responsive dark UI ("Obsidian Atelier").

## Architecture

Split deployment: static frontend on Vercel, API on Railway — or entirely local in development. The backend is **API-only** and serves no static files.

```text
┌──────────────────────────┐         ┌───────────────────────────────┐
│ Frontend (Vercel/local)  │  /api   │      Backend API (Express)     │
│ React 18 · Vite · Zustand│◄───────►│  :3001 (dev) / PORT (Railway)  │
│ http://localhost:5173    │   SSE   │  better-sqlite3 (WAL)          │
└──────────────────────────┘         └───────────┬───────────────────┘
                                                 │
                    ┌────────────────────────────┼──────────────────────────┐
                    ▼                            ▼                          ▼
        ┌────────────────────────┐   ┌─────────────────────┐   ┌──────────────────────────┐
        │ LLM providers          │   │ Local agent (WS)    │   │ External services         │
        │ OpenRouter · DeepSeek  │   │ Your paired PC:     │   │ E2B · Jina Reader ·       │
        │ Codex · llama.cpp      │   │ commands, files,    │   │ Exa/Brave/Tavily ·        │
        │                        │   │ llama-server, MCP   │   │ Wayback · OpenRouter      │
        └────────────────────────┘   └─────────────────────┘   └──────────────────────────┘
```

Streaming is **hand-rolled SSE over `fetch`** — no EventSource, no client WebSocket. The server's WebSocket (`/api/agent/connect`) exists solely for the paired local agent. Stream state is kept per conversation, so you can switch conversations while another keeps generating. Storage is a single SQLite file (WAL) with idempotent migrations at boot.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite 6, Zustand 5, Framer Motion 11 |
| Backend | Node.js >= 20.19, Express 4, TypeScript (`tsx` dev / `tsc` prod) |
| Database | SQLite via better-sqlite3 (WAL) |
| Realtime | SSE for chat - WebSocket for the local agent |
| Security | bcrypt, JWT HS256, AES-256-GCM, express-rate-limit |
| AI / tools | `@modelcontextprotocol` client+sdk+server, `@openai/codex`, `e2b`, jsdom + Readability |
| Styling | Hand-written CSS — "Obsidian Atelier" design system (dark only) |

## Security model

Two auth modes. Without `JWT_SECRET` the app runs **local mode**: no login, a single `local@localhost` user, share links disabled. With `JWT_SECRET` set it becomes **multi-user**: bcrypt passwords, HS256 JWT in an httpOnly cookie, and genuine multi-tenancy — every table carries `user_id`, every query is scoped to its owner, and another user's resource returns a uniform 404.

On top of that:

- **Encryption at rest** (AES-256-GCM) for provider credentials, via `ENCRYPTION_KEY`. Reads are masked. MCP servers cannot be created at all without it.
- **Fail-closed MCP approvals** — every tool call is approved by a human before it runs.
- **Tiered command safety** with console confirmation; tier 1 has no override.
- **SSRF containment** — the relay's HTTP proxy only reaches an explicit `host:port` allowlist; localhost is barred from custom HTTP tools; `web_fetch` validates URLs with zod.
- **Local-agent tokens** are 32 random bytes, shown once, stored only as SHA-256, revocable from the UI.
- **Per-IP rate limiting** — 300 req/15 min on `/api`, 60 on `/api/chat`, 20 on the council endpoint.

Full detail in [README.es.md](README.es.md).

## Quick start

```bash
npm install
cp .env.example .env      # every variable is optional; the file documents each one
npm run dev               # backend :3001 + frontend :5173
```

Open http://localhost:5173. With no `JWT_SECRET` set you are in local mode — no signup, and no keys required until you pick a provider. Add an OpenRouter key (or connect via OAuth) in Settings and you can chat immediately.

Node >= 20.19 is required. See [README.es.md](README.es.md) for local-agent, llama.cpp and E2B setup, and [DEPLOY.md](DEPLOY.md) for the Vercel + Railway deployment.

## Tests

```bash
npm test                  # server + local-agent unit tests
```

## License

MIT — see [LICENSE](LICENSE).
