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
* **Typed End-to-End**: The request path (config, repositories, services, routes, entry point) is TypeScript under `strict` with `noUncheckedIndexedAccess`, and the HTTP boundary is validated with Zod. The retrieval contract (`RetrievedChunk`, `Source`, `GeminiModels`) is declared rather than inferred from whatever the SDK happened to return.
* **Correlated Structured Logging**: Pino with an `AsyncLocalStorage` mixin, so every line of a request (retrieval, budget pruning, refusal-or-answer, completion) carries one `x-correlation-id`. SSE streams interleave, so this is what makes a single request's logs reassemblable.

### Public access policy

`POST /query` is intentionally open to any origin
(`Access-Control-Allow-Origin: *`). The endpoint is read-only: it performs
retrieval and generation, stores nothing, mutates nothing, and holds no user
data. It is called directly from the browser by the demo at slakedesign.com
and by Netlify deploy previews, whose subdomains change per pull request, so
an origin allowlist would break previews without reducing risk; CORS does not
restrict server-side callers. The real control on abuse is the rate limit:
**10 requests per hour per IP**, enforced by `express-rate-limit` in
`index.js`.

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
  - **Grounded Responses**: The model is never called without retrieved context. If no chunk clears the similarity threshold (or everything retrieved is pruned by the token budget) the service returns a refusal and stops, rather than letting the model answer from its own priors. Enforced in `src/services/rag.service.js` (grounding gate) and covered by `tests/query.test.js`.
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
measured rather than guessed. Re-measured 2026-08-29 against
`gemini-embedding-001` (3072-d) over the committed 650-document corpus, top-1
cosine similarity:

| Population | n | Range |
|---|---|---|
| In-domain (8 from `evaluation/stripe_questions.json` + 12 calibration-only) | 20 | 0.628 to 0.816 |
| Noise (3 gibberish, 9 unrelated-but-fluent, 8 adjacent-technical/financial) | 20 | 0.452 to 0.593 |

Separation gap: **0.035**. Configured value: **0.61**, just below the midpoint
of 0.611, biasing the margin toward retaining real questions. Verified:
**0/20 noise admitted, 0/20 in-domain refused**.

**The gap is thin, and that is the honest headline.** An earlier calibration
used n=8 in-domain and n=6 noise and reported a gap of 0.151, which suggested
the threshold could safely rise toward 0.65. That was an artifact of a small,
easy sample. Widening both populations to 20 dropped the weakest in-domain
score from 0.706 to 0.628 and raised the noise ceiling from 0.555 to 0.593, so
the direction of the correct adjustment was **down, not up**. Raising to 0.63
to 0.65 would have refused three of the twenty in-domain queries outright.

**What this means for the design.** A 0.035 gap between two 20-sample
populations is not a comfortable separation. A single scalar cosine threshold
is a weak instrument at this margin, and a genuinely robust system would add a
second signal: a reranker, a keyword check, or a model-side relevance
judgement over the retrieved chunks. That is recorded here rather than papered
over, because the numbers do not support claiming more.
`tests/threshold.calibration.test.js` fails deliberately if the gap collapses
below 0.02, so the point at which retuning stops being the right answer is
visible rather than a surprise.

Reproduce with:

```bash
npm run calibrate            # report only
npm run calibrate -- --write # also update evaluation/threshold-calibration.json
```

It needs an API key and is deliberately not part of `npm test`. It refuses to
write a partial run: a transient API failure used to shrink the sample
silently and record the reduced count as if it were intended. The committed
measurement lives in `evaluation/threshold-calibration.json`, and
`tests/threshold.calibration.test.js` asserts the configured threshold still
separates those bands, so a change that reintroduces overlap fails in CI
without needing a key.

**Measured, not proven.** Both samples are hand-written at n=20. They bound the
problem; they do not settle it. Re-run after any corpus or embedding-model
change.

---

## 5c. Design & Reliability Notes

**Production-shaped.** The model is never called without retrieved context; a
question that retrieves nothing above threshold is refused, not answered from
priors, and that is enforced in code and covered by tests verified to fail
against the pre-fix service. TypeScript under `strict` with Zod at the HTTP
boundary. Structured logging with correlation IDs that survive an SSE stream,
and API-key redaction specific to how the Gemini SDK leaks credentials into
error messages. Fail-closed corpus loading: a missing, malformed, empty or
dimension-mismatched corpus kills the process at boot rather than producing a
service that reports healthy and retrieves nothing.

**Demo-only, and why.** The vector store is an in-memory O(n) cosine scan over
650 documents, deliberate, because the corpus ships with the deploy and needs
no external database or cold start. It does not scale, and that is the trade
being made. Rate limiting is in-process. The evaluation set is 8 questions:
enough to catch a regression, not enough to claim a quality figure.

**What was fixed, and what it taught me.** See [HARDENING.md](HARDENING.md).
The defect was that a Stripe question retrieving nothing still got a
confident, fully-structured answer built from model priors (with citations
suppressed, so it looked identical to a grounded one. The lesson that
generalised: the system prompt said the model MUST produce the full structure
for in-domain questions, and that instruction quietly overrode a `[No relevant
documents found]` placeholder that looked like a safeguard. A prompt is not a
guardrail. If a property must hold, it has to be enforced in code and tested),
which is why the regression tests assert the model is never *called*, not
merely that the output looks right.

---

## 6. Architectural Trade-offs & Future Work

Two categories, kept separate on purpose. The first are choices made knowingly,
with a reason and a path forward. The second are gaps: things that are simply
not done. Presenting the second group as though it were the first would be the
same dishonesty this project spent its hardening pass removing.

### Deliberate trade-offs

* **In-memory vector store.** The 650-document corpus ships with the deploy and
  is scanned linearly per query. Chosen so the service has no external database
  dependency and no cold-start pause, which is what lets a portfolio demo answer
  a recruiter's first question in a few seconds rather than waking a suspended
  instance.

  Measured on the deployment's own hardware profile, 25 queries per size, real
  vector copies rather than aliased references:

  | Documents | p50 | p95 | Heap used |
  |---:|---:|---:|---:|
  | 650 (current) | 2.1 ms | 2.4 ms | 61 MB |
  | 2,600 | 9.0 ms | 10.3 ms | 101 MB |
  | 6,500 | 22.2 ms | 23.8 ms | 193 MB |
  | 13,000 | 43.5 ms | 80.7 ms | 346 MB |

  Scan cost is linear, about 3.3 microseconds per document per query, exactly as
  an O(n) scan should behave.

  **Latency is not the ceiling, and it is worth being precise about why.** Even
  at 13,000 documents the p95 scan is 80.7 ms against a generation call of
  several seconds, so search is roughly 1.6% of the response a user waits for.
  There is no corpus size this design would plausibly hold at which a latency
  budget becomes the binding constraint. **Memory is the ceiling**: heap reaches
  346 MB at 13,000 documents, and this runs on a Render starter instance capped
  at 512 MB. The migration trigger is therefore corpus size against instance
  memory, somewhere near 13,000 documents on the current plan, not a
  query-latency threshold.

  `pgvector` or Qdrant is the next step, and the reason is worth stating
  precisely, because the obvious phrasing is wrong. The benefit is **not** an
  ANN index such as HNSW: HNSW attacks query cost, reducing an O(n) scan to
  roughly O(log n), and query cost is the thing measured above as negligible.
  HNSW would in fact *increase* memory, since the navigable graph sits on top of
  the vectors it indexes. The benefit is that a vector database holds the
  vectors in its own storage rather than in this process's heap, which is the
  constraint that actually binds. An index would become worthwhile later, at a
  corpus size this design would never reach in-process anyway.

  The repository sits behind an `IDocumentRepository` interface, so that swap
  does not reach the service layer.

* **Refusing rather than guessing.** A question whose best match falls under
  `MATCH_THRESHOLD` is refused, not answered. A wrong-but-confident answer costs
  more than a decline, so this is the intended posture. The consequence is that
  retrieval precision and corpus coverage, not the model, are the limiting
  factor on usefulness.

* **In-process rate limiting.** Held in Node memory, which is correct for a
  single instance and wrong the moment there are two. A distributed store such
  as Redis is the fix, and is not needed until this scales horizontally.

* **Simulated nothing.** Every number this service reports is measured. Where a
  capability is absent it is listed below rather than approximated.

### Known gaps

* **The score bands nearly touch.** At n=20 each the separation is 0.035
  (in-domain 0.628 to 0.816, noise 0.452 to 0.593). `MATCH_THRESHOLD = 0.61`
  classifies all 40 correctly, but with roughly 0.017 of margin either side.
  This is not a trade-off anyone chose; it is what measurement returned. A
  single cosine threshold is a weak instrument at that margin, and the real fix
  is a second signal: a reranker, a keyword layer, or a model-side relevance
  judgement over the retrieved chunks. It is not implemented.
  `tests/threshold.calibration.test.js` fails deliberately if the gap falls
  below 0.02, so the point at which retuning stops being the right answer is
  visible rather than a surprise.

* **The evaluation set is 8 questions**, with a 75% retrieval hit rate. That is
  enough to catch a regression and not enough to claim a quality figure.
  Calibration uses a wider sample (20 in-domain, 20 noise) but both are
  hand-written, so they bound the problem rather than settling it.

* **Corpus provenance is incomplete.** `corpus.meta.json` records
  `embeddingModel: null` because the model that produced the committed vectors
  was not captured at ingest time and cannot be recovered. Dimension *is*
  measured and is what the boot and query gates enforce, so a model swap that
  changes width fails loudly; a same-width swap would not be caught. This is a
  past mistake preserved honestly, not a design decision.

* **The recursive chunker is not wired in.** Adopting it requires re-indexing
  the corpus and re-running the evaluation against the existing baseline.

* **Observability stops at this service.** Structured logging and correlation
  IDs are in place (`src/logging/`), and every request's outcome is a queryable
  field (`answered`, `out_of_domain_refusal`, `refused_ungrounded`). Distributed
  tracing across service boundaries and per-request token-cost accounting are
  not implemented, and a single-service demo cannot honestly demonstrate them.

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
# Preview what would be ingested: makes no Gemini calls and writes nothing
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