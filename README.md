# Text2KG - Knowledge Graph Understanding Assistant

Text2KG helps users understand what Knowledge Graph structure they need to represent information from long English text.

The system takes an article or business document as input and suggests a structured knowledge representation composed of:

- Nodes
- Edges
- Labels
- Properties
- Triples
- Evidence
- Confidence scores

The goal is not only to extract facts. Text2KG helps users think structurally about the knowledge contained in the text.

## Core Goal

Text2KG answers this question:

> What Knowledge Graph structure is needed to represent this information?

The product presents graph components as suggestions that users can review, validate, edit, and export.

## Phase 1 Scope

Phase 1 focuses on the core understanding workflow:

```text
Text -> Triples -> Evidence -> Confidence -> Review -> Export
```

This phase prioritizes accuracy, transparency, and user trust over advanced visualization or automation.

Included in Phase 1:

- English text input
- Triple extraction
- Node identification
- Edge identification
- Evidence for each triple
- Confidence scores
- Results table
- Basic approve, reject, edit, and delete actions
- GraphML export
- Local LLM execution through Ollama
- Optional Azure OpenAI execution through a selectable UI model provider

Out of scope for Phase 1:

- Full visual graph editor
- Advanced schema inference
- Multilingual support
- PDF ingestion
- Entity merging
- External ontology integration
- Complex graph editing

## Model Configuration

Phase 1 can use either a local Ollama model or Azure OpenAI for Knowledge Graph extraction. Select the provider in the Source Text panel before clicking Analyze.

### Ollama

The system expects Ollama to be running locally at:

```text
http://127.0.0.1:11434
```

Recommended PowerShell environment variables:

```powershell
$env:OLLAMA_KG_MODEL="gemma4:e4b"
$env:OLLAMA_GENERATE_TIMEOUT_SEC="180"
$env:OLLAMA_BASE_URL="http://127.0.0.1:11434"
```

The server also supports the older model variable:

```powershell
$env:OLLAMA_MEDIA_TITLE_MODEL="gemma4:e4b"
```

Equivalent `.env` format:

```text
OLLAMA_KG_MODEL=gemma4:e4b
OLLAMA_GENERATE_TIMEOUT_SEC=180
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

### Azure OpenAI

The Azure OpenAI option expects these values in `.env` or the server process environment:

```text
OPENAI_AZURE_API_KEY=your-api-key
OPENAI_AZURE_API_ENDPOINT=https://your-resource.openai.azure.com
OPENAI_AZURE_GPT52_MODEL=your-gpt-5.2-deployment
OPENAI_AZURE_GPT52_MODEL_VERSION=2025-03-01-preview
```

`OPENAI_AZURE_GPT52_MODEL` defaults to `gpt-5`. `OPENAI_AZURE_GPT52_MODEL_VERSION` is used as the Azure API version and defaults to `2025-03-01-preview`. The older `OPENAI_AZURE_DEPLOYMENT` and `OPENAI_AZURE_API_VERSION` names are also supported.

## Supported Input

Phase 1 supports:

- Long English text
- Articles
- Business documents

Not supported in Phase 1:

- Hebrew
- PDF files
- URLs
- Images
- Multilingual documents

## Main Output

The system produces suggested triples:

```text
Subject -> Predicate -> Object
```

Each triple includes:

- Subject
- Predicate
- Object
- Subject type
- Object type
- Evidence from the text
- Confidence score
- Review status

Example input:

```text
OpenAI developed ChatGPT, a conversational AI product.
```

Suggested triple:

```text
OpenAI -> developed -> ChatGPT
```

Suggested types:

```text
OpenAI: Organization
ChatGPT: Product
```

Evidence:

```text
OpenAI developed ChatGPT
```

Confidence:

```text
0.92
```

## Review Statuses

Each component can use one of these statuses:

- `pending` - a new suggestion that has not yet been reviewed
- `approved` - approved by the user
- `rejected` - rejected by the user
- `edited` - changed by the user
- `needs_review` - low confidence, ambiguity, or weak evidence

## GraphML Export

The reviewed graph can be exported as GraphML.

By default, export includes all non-rejected triples. The UI also supports exporting approved triples only.

## Design Principles

- Explainability first: every important suggestion should be supported by evidence.
- Precision over recall: fewer accurate triples are better than many noisy triples.
- Human-in-the-loop: the user remains in control.
- Graph thinking: the product helps users understand structure, not only extract facts.
- Local first by default: Phase 1 uses Ollama unless Azure OpenAI is selected.

## Requirements

- Node.js 24+
- npm 11+
- Ollama running at `http://127.0.0.1:11434`

## Scripts

Install dependencies:

```powershell
npm install
```

Run the development app:

```powershell
npm run dev
```

Run type checks:

```powershell
npm run check
```

Build production assets:

```powershell
npm run build
```

The client runs on Vite's default port and proxies `/api` to the Express server on port `5174`.

## Future Phases

Phase 2 - Graph Visualization:

Add an interactive graph view with zoom, pan, node selection, edge selection, filtering, and visual editing.

Phase 3 - Schema Generalization:

Add a generalization assistant that suggests reusable Knowledge Graph schemas from specific extracted facts.
