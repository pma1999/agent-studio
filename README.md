# Agent Studio

A personal AI agent workspace powered by OpenRouter. Create custom agents with system prompts, chat with them in real-time with streaming responses, and manage your conversation history — all through a refined dark interface. Use any model available on OpenRouter (OpenAI, Anthropic, Google, Meta, and more).

## Quick Start

```bash
# Install dependencies
npm install

# Start both frontend and backend
npm run dev
```

The app will be available at **http://localhost:5173**

## First Time Setup

1. Start the app with `npm run dev`
2. Click the **Settings** gear icon in the sidebar
3. Enter your OpenRouter API key (get one from [OpenRouter](https://openrouter.ai/settings/keys))
4. Save and close settings
5. Create your first agent or use the default one
6. Start chatting!

## Features

- **Agent Management** — Create agents with custom names, avatars, system prompts, and model configurations
- **Streaming Chat** — Real-time streamed responses with markdown rendering and syntax highlighting
- **OpenRouter** — Access 300+ models (OpenAI, Anthropic, Google, Meta, etc.) through a single API
- **Conversation History** — All chats are persisted locally in SQLite
- **Per-Agent Model Config** — Each agent can use a different model, temperature, and max tokens

## Architecture

| Layer | Tech |
|-------|------|
| Frontend | React 18, TypeScript, Vite, Zustand, Framer Motion |
| Backend | Express, TypeScript (tsx) |
| Database | SQLite (better-sqlite3) |
| Styling | Handcrafted CSS — "Obsidian Atelier" design system |

## Default Configuration

- **Endpoint**: `https://openrouter.ai/api/v1`
- **Model**: `openrouter/auto`
- **Temperature**: `0.7`
- **Max Tokens**: `4096`

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start both frontend and backend in development mode |
| `npm run dev:client` | Start only the Vite frontend |
| `npm run dev:server` | Start only the Express backend |
| `npm run build` | Build for production |

## Project Structure

```
├── server/          Express backend (API proxy + SQLite persistence)
│   ├── index.ts     Server entry point
│   ├── db.ts        Database setup and migrations
│   └── routes/      API route handlers
├── src/             React frontend
│   ├── components/  UI components
│   ├── stores/      Zustand state management
│   ├── api/         API client functions
│   ├── hooks/       Custom React hooks
│   └── types/       TypeScript types
└── public/          Static assets
```
