# Knowledge Graph Tool

A local-first exploratory knowledge graph app. Paste text, ask a local Ollama model for candidate concepts and relationships, then refine the graph as a lightweight hypothesis.

## Requirements

- Node.js 24+
- npm 11+
- Ollama running at `http://127.0.0.1:11434`

Optional environment variables:

```powershell
$env:OLLAMA_MEDIA_TITLE_MODEL="gemma4:e4b"
$env:OLLAMA_GENERATE_TIMEOUT_SEC="180"
```

## Scripts

```powershell
npm install
npm run dev
npm run build
```

The client runs on Vite's default port and proxies `/api` to the Express server on port `5174`.
