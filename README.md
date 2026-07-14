# Slake Design RAG Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A production-grade Retrieval-Augmented Generation (RAG) API designed for ingesting technical documentation and serving structured, streamed responses via a high-performance Express server and the Google Gemini API.

---

## Architecture Overview

The Slake Design RAG Engine implements a fast, deterministic, and cost-efficient pipeline to answer technical queries using semantic search over localized context.

```
                  ┌────────────────┐
                  │   User Query   │
                  └───────┬────────┘
                          │
                          ▼
            ┌────────────────────────────┐
            │  Gemini Embedding Model    │
            │     (text-embedding-004)   │
            └─────────────┬──────────────┘
                          │ (Query Vector)
                          ▼
            ┌────────────────────────────┐
            │   Supabase Vector Database │
            │      (match_documents)     │
            └─────────────┬──────────────┘
                          │ (Top Context Chunks)
                          ▼
            ┌────────────────────────────┐
            │  Gemini Generative Model   │
            │  (gemini-2.5-flash-lite)   │
            └─────────────┬──────────────┘
                          │ (Streamed SSE)
                          ▼
                  ┌────────────────┐
                  │  Client Stream │
                  └────────────────┘
```

### Key Engineering Decisions

- **Streaming Responses**: Uses Server-Sent Events (SSE) via Express to stream tokens back to the client in real-time, reducing perceived latency.
- **Context Filtering**: Restricts matches using a similarity threshold (minimum `0.48`) and caps context to prevent prompt injection and keep model responses focused.
- **Robust Ingestion**: Features modular scripts for crawling web documentation, reading local OpenAPI specifications, and processing uploaded documents (PDFs and text).
- **Error Mitigation & Rate Limiting**: Built-in exponential backoff retry logic for Gemini API `429` errors and IP-based rate limiting to prevent abuse.

---

## File Structure

- `/routes`
  - `query.js` — Core query route executing embedding, vector search, prompt styling, and SSE stream generation.
  - `ingest.js` — API endpoint supporting manual file uploads (text/PDF) and automatic database ingestion.
- `index.js` — Express application entry point configuring middleware, CORS, rate limits, and server routes.
- `scraper.js` — Utility script to scrape narrative documentation pages, chunk contents, embed, and store in database.
- `ingest-stripe.js` — Utility script to parse OpenAPI definitions (such as `stripe-spec.json`), generate route/parameter summaries, and insert vector embeddings.
- `ingest-stripe-guides.js` — Utility script for downloading, cleaning, and ingesting web guides.

---

## Setup & Configuration

### Prerequisites

- Node.js (v18+)
- Supabase database instance with `pgvector` enabled and `match_documents` RPC function defined.

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```dotenv
PORT=3001
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.0-flash-exp
GEMINI_EMBEDDING_MODEL=text-embedding-004
```

### 3. Run Ingestion (Optional)

To populate the database using the provided utility scripts, ensure your `.env` contains the required keys, and run:

- **Web Documentation Ingest**:
  ```bash
  node scraper.js
  ```
- **OpenAPI Ingest**:
  *(Note: Requires placeholded spec files, such as `stripe-spec.json`, in the root directory)*
  ```bash
  node ingest-stripe.js
  ```
- **Guides Ingest**:
  ```bash
  node ingest-stripe-guides.js
  ```

### 4. Start the Server

```bash
node index.js
```

The server will spin up and listen on the configured `PORT` (default `3001`).

---

## API Documentation

### POST `/query`

Generates streamed, structured solutions to technical questions based on the ingested documentation.

**Request Header:**
`Content-Type: application/json`

**Request Body:**
```json
{
  "question": "How do I implement subscription webhook signatures?"
}
```

**Response Format (text/event-stream):**
```json
data: {"text": "## 1. Executive Strategy..."}
data: {"text": "..."}
data: {"sources": [{"id": 12, "similarity": 0.89, "metadata": {"source": "https://docs.stripe.com/webhooks"}}]}
data: {"done": true}
```

---

## Performance & Architecture Decisions

This RAG pipeline is built around several deliberate latency-reducing design choices:

1. **Lightweight Model Selection** — Uses `gemini-2.5-flash-lite`, chosen for fast, cost-efficient inference suited to context-grounded RAG tasks.
2. **Server-Sent Events (SSE) Streaming** — Streams generated tokens to the client as they're produced rather than waiting for the full response, reducing perceived latency (time to first token).
3. **Supabase pgvector Similarity Search** — Vector similarity search runs inside the database via the `match_documents` RPC function, avoiding in-memory document loading.
4. **Context Capping & Filtering** — A similarity threshold of 0.48 and a context cap of 8000 characters limit what's passed to the model, reducing token load and processing time.