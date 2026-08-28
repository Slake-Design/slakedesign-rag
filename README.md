# Slake Design RAG Engine

[![Node.js CI](https://github.com/Slake-Design/slakedesign-rag/actions/workflows/test.yml/badge.svg)](https://github.com/Slake-Design/slakedesign-rag/actions/workflows/test.yml)

A **TypeScript** Retrieval-Augmented Generation (RAG) backend API that serves grounded, payment-systems integration documentation. The system provides streamed response chunks to developer questions by performing semantic similarity searches over Stripe API specifications and developer guides.

---

## Key Engineering Highlights

Designed for recruiters and engineering managers reviewing in 3-5 minutes:

* **Hybrid RAG Pipeline**: Combines an in-memory vector index (650 pre-embedded chunks in `src/data/documents.json`, cosine similarity) with Google Gemini (`gemini-2.5-flash-lite`) to generate grounded, context-aware answers. The corpus ships with the deploy, so the service has no external database dependency and no cold-start pause.
* **Token-Aware Context Budgeting**: Integrates Gemini's native `model.countTokens()` API to dynamically fit complete matching chunks into a 3,000-token context window, preventing document truncation mid-sentence or mid-code-block.
* **Objective Retrieval Evaluation**: Replaces subjective "vibe-testing" with a read-only evaluation framework (`evaluation/`) that measures retrieval hit rates and query latency against a pre-defined test dataset.
* **Decoupled Service Architecture**: Separates Express HTTP/SSE transport controllers (`routes/`) from the core AI workflow (`src/services/rag.service.js`) and database operations (`src/repositories/`).
* **Dependency-Injected Test Design**: Utilizes constructor-based injection in `RagService` to mock external database and LLM APIs cleanly, ensuring automated tests (`npm test`) run isolated and cost-free.
* **Production-Style Safety Controls**: Implements IP-based rate limiting to prevent API budget drain and sanitised error outputs.
* **Typed End-to-End**: The request path — config, repositories, services, routes, entry point — is TypeScript under `strict` with `noUncheckedIndexedAccess`, and the HTTP boundary is validated with Zod. The retrieval contract (`RetrievedChunk`, `Source`, `GeminiModels`) is declared rather than inferred from whatever the SDK happened to return.
* **Correlated Structured Logging**: Pino with an `AsyncLocalStorage` mixin, so every line of a request — retrieval, budget pruning, refusal-or-answer, completion — carries one `x-correlation-id`. SSE streams interleave, so this is what makes a single request's logs reassemblable.

### Public access policy

`POST /query` is intentionally open to any origin (`Access-Control-Allow-Origin: *`). The
endpoint is read-only: it performs retrieval and generation, stores nothing, mutates
nothing, and holds no user data. It is called directly from the browser by the demo at
slakedesign.com and by Netlify deploy previews, whose subdomains change per pull request,
so an origin allowlist would break previews without reducing risk — CORS does not
restrict server-side callers. The real control on abuse is the rate limit: **10 requests
per hour per IP**, enforced by `express-rate-limit` in `index.js`.

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
  - **Grounded Responses**: The model is never called without retrieved context. If no chunk clears the similarity threshold — or everything retrieved is pruned by the token budget — the service returns a refusal and stops, rather than letting the model answer from its own priors. Enforced in `src/services/rag.service.js` (grounding gate) and covered by `tests/query.test.js`.
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

## 5b. Language & Layout

The request path is TypeScript. Three files are deliberately **not**:

| File | Why it stays JavaScript |
|---|---|
| `scripts/ingest.js` | Offline corpus-building tool. Run by hand, never on the request path, and covered by `tests/ingest.test.js`. |
| `evaluation/evaluate.js` | Offline retrieval-evaluation harness. Same reasoning. |
| `src/ingestion/chunker.js` | Standalone, dependency-free, and documented above as a future ingestion strategy not yet wired into the pipeline. |

Both scripts import TypeScript modules and so run under `tsx` (`npm run ingest`,
`npm run evaluate`) rather than bare `node`. Porting them was possible but not
useful: they are batch tooling whose failure mode is a visible non-zero exit at
a keyboard, not a silent wrong answer served to a user. The typing effort went
where a type error becomes a production defect.

The build emits CommonJS. That is a deliberate difference from the sibling
`task-queue-system` and `mcp-sqlite-bridge` repos, which are ESM: this repo's
tooling and tests already used `require()` throughout, and converting the module
system at the same time as the language would have made a behaviour-preserving
port impossible to verify as behaviour-preserving.

**Corpus path**: resolved from the working directory, not `__dirname`, because
the compiled output lives in `dist/` while the 25 MB corpus does not. Override
with `CORPUS_PATH`.

---

## 5b-ii. Retrieval Threshold Calibration

`MATCH_THRESHOLD` decides whether a question is answered or refused, so it is
measured rather than guessed. Measured 2026-08-28 against
`gemini-embedding-001` (3072-d) over the committed 650-document corpus, top-1
cosine similarity:

| Population | n | Range |
|---|---|---|
| In-domain (`evaluation/stripe_questions.json`) | 8 | 0.706 – 0.816 |
| Noise (gibberish + off-topic) | 6 | 0.473 – 0.555 |

Separation gap: **0.151**. The configured value is **0.62** — slightly below the
exact midpoint of 0.631, biasing margin toward retaining real questions, since
wrongly refusing a genuine payments question is a worse demo failure than
admitting a borderline one. Verified: **0/6 noise admitted, 0/8 in-domain
refused**.

**Why this mattered.** The previous value was `0.48`, which sat *below* the
noise band: 5 of 6 noise queries cleared it, including the literal string
`"zxqv plorbnat weffle grimsby"` at 0.544. The grounding gate was therefore
correct but almost never reached — the system prompt's domain classifier was
doing the real work. That is the prompt-as-guardrail pattern the gate exists to
replace. At 0.62 the code-level gate fires first and the classifier is the
second line, which is the intended order.

Reproduce with `npm run calibrate` (needs an API key; deliberately not part of
`npm test`). The committed measurement lives in
`evaluation/threshold-calibration.json`, and `tests/threshold.calibration.test.js`
asserts the threshold still separates those bands — so a change that reintroduces
overlap fails in CI without needing a key.

---

## 5c. Design & Reliability Notes

**Production-shaped.** The model is never called without retrieved context — a
question that retrieves nothing above threshold is refused, not answered from
priors, and that is enforced in code and covered by tests verified to fail
against the pre-fix service. TypeScript under `strict` with Zod at the HTTP
boundary. Structured logging with correlation IDs that survive an SSE stream,
and API-key redaction specific to how the Gemini SDK leaks credentials into
error messages. Fail-closed corpus loading: a missing, malformed, empty or
dimension-mismatched corpus kills the process at boot rather than producing a
service that reports healthy and retrieves nothing.

**Demo-only, and why.** The vector store is an in-memory O(n) cosine scan over
650 documents — deliberate, because the corpus ships with the deploy and needs
no external database or cold start. It does not scale, and that is the trade
being made. Rate limiting is in-process. The evaluation set is 8 questions:
enough to catch a regression, not enough to claim a quality figure.

**What was fixed, and what it taught me.** See [HARDENING.md](HARDENING.md).
The defect was that a Stripe question retrieving nothing still got a confident,
fully-structured answer built from model priors — with citations suppressed, so
it looked identical to a grounded one. The lesson that generalised: the system
prompt said the model MUST produce the full structure for in-domain questions,
and that instruction quietly overrode a `[No relevant documents found]`
placeholder that looked like a safeguard. A prompt is not a guardrail. If a
property must hold, it has to be enforced in code and tested — which is why the
regression tests assert the model is never *called*, not merely that the output
looks right.

---

## 6. Known Limitations & Future Improvements

To demonstrate software engineering maturity, the project documents its trade-offs and future scaling considerations:
* **Evaluation Scope**: The retrieval evaluation dataset is currently small (8 questions). Production deployment would require expanding the dataset to 100+ multi-turn scenarios to verify retrieval quality at scale.
* **Retrieval Experiments**: Retrieval accuracy (currently 75%) could be optimized in the future by running comparative evaluation runs with the new recursive chunker (`src/ingestion/chunker.js`) or adding a BM25 keyword search layer.
* **Threshold calibration rests on a small sample**: `MATCH_THRESHOLD = 0.62` was chosen from a measured separation between in-domain scores (0.706–0.816, n=8) and noise scores (0.473–0.555, n=6). The bands are cleanly separated, but n=8 and n=6 are small. Re-run `npm run calibrate` after any corpus or embedding-model change, and widen `evaluation/stripe_questions.json` before treating the number as settled.
* **In-Memory Rate Limiting**: The IP-based rate limiting is held in Node.js process memory. While appropriate for a single-instance portfolio demo, a production environment with multiple auto-scaling containers would require a distributed key store like Redis.
* **Observability Depth**: Structured logging and correlation IDs are in place (`src/logging/`), and every request's outcome is logged as a queryable field (`answered`, `out_of_domain_refusal`, `refused_ungrounded`). A full deployment would add distributed tracing across service boundaries and per-request token-cost accounting, neither of which a single-service demo can demonstrate honestly.
* **Retrieval precision is the binding constraint**: because the model is never called without grounding, an in-domain question whose best match falls under `MATCH_THRESHOLD` is refused rather than answered. That is the intended trade-off — a wrong-but-confident answer costs more than a decline — but it makes threshold tuning and corpus coverage the limiting factor on usefulness, rather than the model.

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