# Slake Design RAG Engine

[![Node.js CI](https://github.com/Slake-Design/slakedesign-rag/actions/workflows/test.yml/badge.svg)](https://github.com/Slake-Design/slakedesign-rag/actions/workflows/test.yml)

A portfolio-grade, production-style Retrieval-Augmented Generation (RAG) backend API designed to serve grounded, payment-systems integration documentation. The system provides real-time, streamed response chunks to developer questions by performing semantic similarity searches over Stripe API specifications and developer guides.

---

## Key Engineering Highlights

Designed for recruiters and engineering managers reviewing in 3-5 minutes:

* **Hybrid RAG Pipeline**: Combines an in-memory vector index (650 pre-embedded chunks in `src/data/documents.json`, cosine similarity) with Google Gemini (`gemini-2.5-flash-lite`) to generate grounded, context-aware answers. The corpus ships with the deploy, so the service has no external database dependency and no cold-start pause.
* **Token-Aware Context Budgeting**: Integrates Gemini's native `model.countTokens()` API to dynamically fit complete matching chunks into a 3,000-token context window, preventing document truncation mid-sentence or mid-code-block.
* **Objective Retrieval Evaluation**: Replaces subjective "vibe-testing" with a read-only evaluation framework (`evaluation/`) that measures retrieval hit rates and query latency against a pre-defined test dataset.
* **Decoupled Service Architecture**: Separates Express HTTP/SSE transport controllers (`routes/`) from the core AI workflow (`src/services/rag.service.js`) and database operations (`src/repositories/`).
* **Dependency-Injected Test Design**: Utilizes constructor-based injection in `RagService` to mock external database and LLM APIs cleanly, ensuring automated tests (`npm test`) run isolated and cost-free.
* **Production-Style Safety Controls**: Implements IP-based rate limiting to prevent API budget drain and sanitised error outputs.

---

## 1. Project Overview & Problem Solved

Integrating complex payment systems like Stripe requires developers to consult massive, fragmented documentation sets (narrative guides, OpenAPI endpoints, and webhook specifications). Generic LLMs suffer from hallucinations, outdated parameters, and structure failures when answering payment questions.

This RAG engine resolves these issues by anchoring Gemini responses in verified local documentation snippets retrieved via cosine similarity. By moving context processing to the database layer and streaming generated response chunks incrementally via Server-Sent Events (SSE), the application balances latency, cost, and factual correctness.

---

## 2. Deployed Demo

* **Live Demo**: [slakedesign.com/demo/rag](https://slakedesign.com/demo/rag)
* **What to Test**:
  - *Grounded Queries*: Ask about PaymentIntent creation or webhook verification to see structured implementation steps and citations.
  - *Domain Filtering*: Ask an off-topic question (e.g. *"What is the distance to the moon?"*) to verify the built-in domain-classifier rejection handler.
* **Example Questions**:
  - *"How do I implement subscription webhook signatures in Node.js?"*
  - *"What endpoint and parameters are used to create a PaymentIntent?"*
* **RAG Capabilities Demonstrated**:
  - **Semantic Retrieval**: Fetches relevant context matching the question's intent.
  - **Grounded Responses**: Restricts generation strictly to the retrieved facts.
  - **Incremental Streaming**: Renders response chunks as they generate using SSE.
  - **Verifiable Citations**: Returns database IDs, URLs, and similarity scores.

---

## 3. Decoupled Architecture

The codebase enforces strict separation of concerns, treating evaluation as a first-class engineering component.

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
                 └── [src/repositories/document.repository.js] (In-memory vector search)
                       └── [src/data/documents.json] (650 pre-embedded chunks)

                             ▲
                             │ (Runs read-only similarity tests)
               [evaluation/evaluate.js] (Retrieval Metrics / Quality Measurement)
                 └── [evaluation/stripe_questions.json] (Evaluation Dataset)
```

### Component Breakdown:
* **`routes/`**: [query.js](routes/query.js) acts strictly as a transport layer handling Express validation, SSE headers, and write buffers.
* **`src/config/`**: Centralizes client setups. [gemini.js](src/config/gemini.js) manages generative model parameters and prompt configurations.
* **`src/services/`**: [rag.service.js](src/services/rag.service.js) orchestrates embedding generation, vector matching, token budgeting, prompt construction, and LLM streaming.
* **`src/repositories/`**: [document.repository.js](src/repositories/document.repository.js) loads the pre-embedded corpus into memory once and performs cosine-similarity lookups, keeping retrieval away from the service layer.
* **`evaluation/`**: Compiles retrieval metrics and quality measurements against the in-memory corpus.
* **`tests/`**: [query.test.js](tests/query.test.js) and [chunker.test.js](tests/chunker.test.js) run unit/integration tests with mocked APIs.

---

## 4. RAG Pipeline Flow

When a developer submits a question, the following sequential pipeline resolves the answer:

```
User Question
    │
    ▼
Generate Query Embedding (models/gemini-embedding-001)
    │
    ▼
In-Memory Vector Search (cosine similarity over documents.json)
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

## 5. Retrieval Evaluation Framework

To measure search quality, the project includes an evaluation suite under `evaluation/` to calculate objective metrics:
* **Dataset** ([stripe_questions.json](evaluation/stripe_questions.json)): A dataset of 8 realistic Stripe API questions mapped to their expected documentation sources.
* **Evaluation Runner** ([evaluate.js](evaluation/evaluate.js)): Embeds test queries, retrieves matches from the in-memory index, and calculates performance metrics.

### Baseline Performance Metrics
Evaluation on the included eight-question Stripe corpus: 75.00% retrieval hit
rate (6/8), 6.00 average chunks fetched, and 2,766.75 average context tokens.
Embedding latency is environment-dependent because evaluation makes live Gemini
embedding requests; reproduce results with `node evaluation/evaluate.js`.

### Future Ingestion Strategy
> [!NOTE]
> The recursive chunker (`src/ingestion/chunker.js`) is implemented as a future ingestion strategy. It is designed to improve chunk boundary preservation and retrieval quality, but production adoption requires re-indexing the document corpus and evaluating retrieval performance against the existing baseline.

---

## 6. Known Limitations & Future Improvements

To demonstrate software engineering maturity, the project documents its trade-offs and future scaling considerations:
* **Evaluation Scope**: The retrieval evaluation dataset is currently small (8 questions). Production deployment would require expanding the dataset to 100+ multi-turn scenarios to verify retrieval quality at scale.
* **Retrieval Experiments**: Retrieval accuracy (currently 75%) could be optimized in the future by running comparative evaluation runs with the new recursive chunker (`src/ingestion/chunker.js`) or adding a BM25 keyword search layer.
* **In-Memory Rate Limiting**: The IP-based rate limiting is held in Node.js process memory. While appropriate for a single-instance portfolio demo, a production environment with multiple auto-scaling containers would require a distributed key store like Redis.
* **Production Observability**: An enterprise deployment would require integrating transaction tracing, request tracking, and detailed token usage logging.

---

## 7. Setup & Configuration

### Environment Variables
Configure the following variables in your `.env` file (never commit actual values to version control):
```dotenv
PORT=3001
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_EMBEDDING_MODEL=models/gemini-embedding-001
MAX_CONTEXT_TOKENS=3000
```

### Installation & Run
```bash
npm install
npm start
```

### Running Tests & Evaluation
```bash
# Run automated mocked tests
npm test

# Run read-only retrieval evaluation against the in-memory index
node evaluation/evaluate.js
```

### Updating the Corpus
Retrieval reads `src/data/documents.json`, which is committed and deployed with the code.
Ingestion is therefore an offline step, not a runtime endpoint: the service loads the corpus
into memory once at boot and never writes back, and the host filesystem is ephemeral, so an
HTTP upload would be lost on the next deploy.

```bash
# Preview what would be ingested — makes no Gemini calls and writes nothing
npm run ingest:dry -- --spec
npm run ingest:dry -- --urls

# Ingest for real (appends only; existing records are never modified)
npm run ingest -- --spec
npm run ingest -- --urls https://docs.stripe.com/webhooks
npm run ingest -- --spec --limit 50
```

Runs are append-only and de-duplicated on exact chunk content, so re-running is safe and
idempotent. The corpus file is written atomically. After a real run, commit
`src/data/documents.json` to deploy the updated index.

### Local Endpoint Verification
```bash
curl -N -X POST http://localhost:3001/query \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I create a Stripe PaymentIntent?"}'
```