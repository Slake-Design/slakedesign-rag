# Slake Design RAG Engine

A portfolio-grade, production-style Retrieval-Augmented Generation (RAG) backend API designed for serving payment-systems integration documentation. The system provides real-time, streamed responses to developer questions by performing semantic similarity searches over Stripe API specifications and developer guides.

---

## 1. Project Overview

This service is a production-style RAG backend built to serve Stripe payment documentation queries. The stack includes:
* **Core**: Node.js & Express API transport layer.
* **Vector Storage**: Supabase PostgreSQL database using the `pgvector` extension for vector similarity matching.
* **AI & Embeddings**: Google Gemini API (`models/gemini-embedding-001` for embedding generation, and `gemini-2.5-flash-lite` for generation).
* **Streaming Protocol**: Streams generated response chunks incrementally via Server-Sent Events (SSE).
* **Data Sources**: Official Stripe API OpenAPI specifications and narrative billing/integration developer guides.

---

## 2. Decoupled Architecture

The codebase separates transport protocols, database operations, and generative AI orchestration, while treating evaluation as a first-class engineering component.

```
                     [Client App / Browser]
                             │
                             ▼ (HTTP POST /query)
                     [routes/query.js] (Thin HTTP/SSE controller)
                             │
                             ▼ (Streams response back)
               [src/services/rag.service.js] (RAG Orchestrator)
                 ├── Dependency Injection Constructor
                 │
                 ├── [src/config/gemini.js] (Centralized Gemini API configuration)
                 │
                 └── [src/repositories/document.repository.js] (DB queries & RPCs)
                       └── [src/config/supabase.js] (Centralized DB client)

                             ▲
                             │ (Runs read-only similarity tests)
               [evaluation/evaluate.js] (Retrieval Metrics / Quality Measurement)
                 └── [evaluation/stripe_questions.json] (Evaluation Dataset)
```

### Component Breakdown:
* **`routes/`**: Thin HTTP controllers. [query.js](file:///Users/aj/slakedesign-rag/routes/query.js) handles Express-level request validation, CORS, SSE headers, and stream delivery. [ingest.js](file:///Users/aj/slakedesign-rag/routes/ingest.js) maps file uploads.
* **`src/config/`**: Centralized clients. [gemini.js](file:///Users/aj/slakedesign-rag/src/config/gemini.js) manages generative model parameters and system prompt settings. [supabase.js](file:///Users/aj/slakedesign-rag/src/config/supabase.js) isolates client initialization.
* **`src/services/`**: Core RAG orchestration. [rag.service.js](file:///Users/aj/slakedesign-rag/src/services/rag.service.js) embeds queries, retrieves document vectors, handles token-aware context selection, constructs prompts, and processes the Gemini stream.
* **`src/repositories/`**: Database abstraction. [document.repository.js](file:///Users/aj/slakedesign-rag/src/repositories/document.repository.js) isolates SQL and cosine-similarity RPC lookups from application logic.
* **`src/ingestion/`**: Contains the [chunker.js](file:///Users/aj/slakedesign-rag/src/ingestion/chunker.js) recursive separator-based text splitter.
* **`evaluation/`**: Runs retrieval metrics and quality measurements against the active dataset. Includes the [stripe_questions.json](file:///Users/aj/slakedesign-rag/evaluation/stripe_questions.json) test dataset and [evaluate.js](file:///Users/aj/slakedesign-rag/evaluation/evaluate.js) performance compiler.
* **`tests/`**: Contains Vitest automated unit and integration tests ([query.test.js](file:///Users/aj/slakedesign-rag/tests/query.test.js) and [chunker.test.js](file:///Users/aj/slakedesign-rag/tests/chunker.test.js)) utilizing mocks for external API calls.

---

## 3. RAG Pipeline Flow

When a developer submits a question, the following sequential pipeline resolves the answer:

```
User Question
    │
    ▼
Generate Query Embedding (models/gemini-embedding-001)
    │
    ▼
Supabase Vector Search (pgvector RPC match_documents)
    │
    ▼
Retrieve Top 6 Matches (Similarity Filter >= 0.48)
    │
    ▼
Token-Aware Context Selection (Prunes chunks dynamically using countTokens)
    │
    ▼
Prompt Construction (Inserts formatted context with source headers into template)
    │
    ▼
Gemini Generation (gemini-2.5-flash-lite with systemInstruction)
    │
    ▼
SSE Streaming Response (Streams response chunks incrementally via SSE)
    │
    ▼
Source Metadata Return (Pushes array of cited document IDs and URLs)
    │
    ▼
Stream Done Event (data: {"done": true})
```

---

## 4. Engineering Decisions & Rationale

* **Vector Search Selection**: Cosine similarity via Supabase `pgvector` was selected to efficiently retrieve grounded documentation sections while avoiding unnecessary LLM context expansion. This balances latency and context constraints by locating relevant snippets in the database layer.
* **Token-Aware Context Management**: Rather than slicing text by arbitrary character counts (which chops JSON blocks or splits words in half), we count tokens using Gemini's `model.countTokens()` API. Complete matching chunks are included; if a chunk exceeds the remaining context window budget, it is pruned cleanly to control API cost and prevent model confusion.
* **Service Separation**: RAG orchestration logic was extracted from Express route controllers into `rag.service.js`. This separates transport details (HTTP status, SSE write buffers) from AI logic, allowing the engine to run on CLI scripts, background workers, or Slack bots.
* **Dependency Injection for Testing**: The `RagService` constructor accepts optional repository and Gemini models. In tests, we inject simple mock objects. This eliminates Vitest mock-hoisting conflicts and require-cache hacking, resulting in robust tests.
* **Mocked Test Suite vs. Live Smoke Testing**:
  - **Mocked Unit Tests** (`npm test`) verify prompt logic, retry limits, and token budgets deterministically without internet latency or consuming paid API credits.
  - **Local Smoke Testing** (`npm start` + `curl`) runs real database vector matching and queries the live Gemini API, confirming network configuration, database indexes, and SSE buffer flushing.
* **Production Safety Controls**: Configured Multer upload constraints (10MB limits) to prevent memory-exhaustion crashes and implemented IP rate limiting to protect API credits while keeping the application robust.

---

## 5. Retrieval Evaluation Framework

To measure search quality, the project includes an evaluation suite under `evaluation/` to calculate objective metrics:
* **Dataset** ([stripe_questions.json](file:///Users/aj/slakedesign-rag/evaluation/stripe_questions.json)): A dataset of 8 realistic Stripe API questions mapped to their expected documentation sources.
* **Evaluation Runner** ([evaluate.js](file:///Users/aj/slakedesign-rag/evaluation/evaluate.js)): Embeds test queries, retrieves matches via Supabase, and calculates performance metrics.

### Baseline Performance Metrics
Running `node evaluation/evaluate.js` on the current populated database reports the following baseline:
* **Retrieval Hit Rate**: **75.00%** (6/8 queries retrieved the correct target context).
* **Average Similarity Latency**: **513.63 ms**.
* **Average Chunks Returned**: **6.00**.
* **Average Context Token Size**: **2766.75 tokens**.

### Future Ingestion Strategy
> [!NOTE]
> The recursive chunker (`src/ingestion/chunker.js`) is implemented as a future ingestion strategy. It is designed to improve chunk boundary preservation and retrieval quality, but production adoption requires re-indexing the document corpus and evaluating retrieval performance against the existing baseline.

---

## 6. Setup & Configuration

### Environment Variables
Configure the following variables in your `.env` file (never commit actual values to version control):
```dotenv
PORT=3001
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_EMBEDDING_MODEL=models/gemini-embedding-001
MAX_CONTEXT_TOKENS=3000
```

### Installation
```bash
npm install
```

### Run the Application
```bash
npm start
```
The server will bind to the configured port and listen for queries:
`--- SLAKE DESIGN RAG ENGINE --- Status: Operational Port: 3001`

---

## 7. Testing & Verification

### Run Automated Tests
```bash
npm test
```

### Run Retrieval Evaluation Suite
```bash
node evaluation/evaluate.js
```

### Local Endpoint Verification
To verify the RAG endpoint and stream SSE chunks locally, run:
```bash
curl -N -X POST http://localhost:3001/query \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I create a Stripe PaymentIntent?"}'
```

To verify input validation:
```bash
curl -i -X POST http://localhost:3001/query \
  -H "Content-Type: application/json" \
  -d '{}'
```
*(Confirms clean `{"error":"Question is required"}` event response without stack traces).*

---

## Demo

*[Placeholder for screenshot or GIF demonstrating the live streaming RAG UI experience, showing incremental token output and metadata citations in real-time]*