# Slake Design RAG Engine

A production-grade Retrieval-Augmented Generation (RAG) API that ingests technical documentation and returns executive-level architecture briefs via a streaming AI query engine.

**Live Demo:** [slakedesign.com/demo.html](https://slakedesign.com/demo.html)

---

## What It Does

Ask it a technical question about your SaaS stack and it returns a structured, implementation-ready brief in under 8 seconds — streamed in real time — including executive strategy, a technical roadmap, key API endpoints, and a Jira-ready ticket.

---

## Performance

| Stage | Time |
|---|---|
| Vector Embedding | ~350ms |
| Supabase Vector Search | ~560ms |
| LLM Stream Open | ~480ms |
| **Full Response** | **~7.5s** |

Optimized from an initial 45s response time down to 7.5s through model selection, context trimming, prompt engineering, and retry logic.

---

## Stack

- **Runtime:** Node.js / Express
- **Vector Database:** Supabase pgvector
- **Embeddings:** Google Gemini Embedding Model
- **LLM:** Google Gemini 2.5 Flash Lite
- **Streaming:** Server-Sent Events (SSE)

---

## Architecture
```
User Query
    ↓
Gemini Embedding Model → Query Vector
    ↓
Supabase pgvector → Top 4 Matching Chunks
    ↓
Gemini 2.5 Flash Lite → Streamed Response
    ↓
Client (SSE)
```

---

## Key Engineering Decisions

- **match_count reduced 8→4** — cuts context size by 50%, meaningfully reduces TTFT
- **Context capped at 1200 chars** — eliminates padding the LLM has to reason through before token 1
- **Retry logic on 429** — silently retries up to 3x with exponential backoff before surfacing an error
- **flushHeaders() on connection** — client sees response immediately, improves perceived speed
- **Rate limited to 5 req/hr per IP** — protects API cost on public deployment

---

## API

### POST /query
```json
{
  "question": "Your technical question here"
}
```

**Response:** Server-Sent Events stream
```json
{ "text": "streamed chunk..." }
{ "sources": [{ "source": "https://..." }] }
```

---

## Setup
```bash
npm install
```

Create a `.env` file:
```dotenv
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_service_key
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_EMBEDDING_MODEL=your_embedding_model
PORT=3001
```
```bash
node index.js
```

---

## Author

Built by AJ — AI/Backend Engineer specializing in RAG pipelines and production AI integration.

[Upwork Profile](https://www.upwork.com/freelancers/~01ac8014d7d14d5aaf) · [slakedesign.com](https://slakedesign.com)