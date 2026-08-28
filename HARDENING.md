# Hardening Log

This repository was audited, found to have a real correctness defect, and
remediated. This file records what was wrong and what changed — because for a
retrieval-grounded system, grounding *is* the product claim, and a claim that
the code does not enforce is the most damaging thing a RAG project can ship.

---

## The defect that mattered: the model was answering without retrieval

**Severity:** ungrounded output rendered indistinguishable from grounded output.

`generateAnswer()` called the model unconditionally. When no chunk cleared the
similarity threshold, the prompt fell back to a placeholder:

```js
`${promptHeader}${context || '[No relevant documents found]'}${promptFooter}`
```

That placeholder was not a safeguard. The system prompt instructs the model that
for any IN-DOMAIN question it **MUST** emit the full four-section structure. So a
Stripe question that retrieved nothing did not produce a hedge — it produced a
confident Executive Strategy, Technical Implementation Roadmap, Webhook Events
section and Jira ticket, assembled entirely from model priors.

And because sources are only emitted when `includedChunks` is non-empty, that
answer arrived **with no citations** — the one signal a reader had that nothing
was retrieved.

Meanwhile `README.md` claimed, under "RAG Capabilities Demonstrated":

> **Grounded Responses**: Restricts generation strictly to the retrieved facts.

**Fixed by** a grounding gate that returns before the model is reached whenever
`includedChunks` is empty. It covers both causes: nothing above threshold, and
everything above threshold pruned by the token budget — a pruned answer is
exactly as ungrounded as an unretrieved one. The refusal string is emitted by
the service, not the model, so it cannot be paraphrased or restructured.

**Proof:** the three gate tests were run against the pre-fix service and fail.
They assert that `generateContentStream` is **never called**, not merely that
the output text is right — asserting on the response alone would still pass if
the model were called and its output discarded, burning quota and latency on
every unanswerable question.

**Sequencing note:** the false README claim was removed in a *separate, earlier*
commit than the code fix, and the gap was recorded under Known Limitations in
the interim. The guarantee was only restated once the code enforced it. `main`
therefore never carried a claim its tests could not back, at any commit.

**Trade-off, stated rather than hidden:** an in-domain question whose best match
scores just under `0.48` is now refused rather than answered. That is the
correct posture — a confidently wrong answer costs more than a decline — but it
makes retrieval precision and corpus coverage the binding constraint on
usefulness, rather than the model. This is documented in the README's
limitations section, not buried.

---

## The gate was correct and almost never fired

Found while verifying the demo before pushing, not during the original audit.

The grounding gate above only helps when retrieval actually returns nothing. It
turned out that almost nothing was rejected: `MATCH_THRESHOLD` was `0.48`, and
measurement showed the noise band reaching **0.555**.

| Population | n | Top-1 cosine similarity |
|---|---|---|
| In-domain (`evaluation/stripe_questions.json`) | 8 | 0.706 – 0.816 |
| Noise (gibberish + off-topic) | 6 | 0.473 – 0.555 |

Five of six noise queries cleared `0.48` — including `"zxqv plorbnat weffle
grimsby"` at 0.544 and a Monty Python question at 0.506. Every query retrieved
the full six chunks.

So the system *was* behaving correctly in live testing — out-of-domain questions
were refused — but by the **system prompt's domain classifier**, not by the
code. Which is exactly the pattern the gate was built to replace: a prompt is
not a guardrail. The gate was real, tested, and decorative.

The two bands are cleanly separated (gap 0.151), so this was fixable rather than
merely reportable. The threshold is now **0.62**, slightly below the exact
midpoint of 0.631 to bias margin toward retaining real questions. Verified live:
all six realistic payments questions still answer with sources; all three noise
queries now hit the code-level gate, logging
`outcome=refused_ungrounded cause=nothing_above_threshold retrievedChunks=0`
with the model never called.

**Three related defects fell out of the same change:**

- The threshold existed as **three different literals** — `0.48` in the service,
  `0.48` duplicated in `evaluation/evaluate.js`, and `0.45` as the repository's
  parameter default. The evaluation harness could therefore report retrieval
  quality for a threshold production did not use. It is now a single exported
  constant.
- `evaluate.js` and the new calibration script both did
  `require('../src/repositories/document.repository')` and called
  `.matchDocuments` on the result. After the TypeScript port that module has
  both a default and named exports, so the require returns the namespace and the
  method is `undefined` — failing at first call rather than at import. The
  evaluation harness was broken and it had not shown up, because the earlier
  test run failed on an invalid API key before reaching that line.
- A test asserted the literal `0.48` was passed to retrieval. It now reads the
  constant, so a threshold change is a deliberate calibration decision rather
  than a test quietly disagreeing with production.

**Honest limits.** n=8 and n=6 are small samples. The bands are well separated
and the result is stable, but this is *measured, not proven*. `npm run
calibrate` reproduces it, and the README records that the eval set should be
widened before the number is treated as settled.

---

## TypeScript, and the two bugs the port found

The request path — config, repositories, services, routes, logging, entry
point — is now TypeScript under `strict` with `noUncheckedIndexedAccess`, and
the HTTP boundary is validated with Zod. The retrieval contract
(`RetrievedChunk`, `Source`, `GeminiModels`) is declared rather than inferred
from whatever the SDK happened to return.

The port was not cosmetic. It surfaced two defects that had been invisible:

1. **A dead fallback branch.** The source-label chain read
   `m.metadata?.source || m.metadata?.path || m.url`. The repository never sets
   a `url` field on a match — it returns `id`, `content`, `metadata`,
   `similarity` — so that branch was unreachable and the chain silently fell
   through to the generic "Stripe Documentation Reference" label. Exactly the
   class of shape-guessing defect a typed retrieval contract prevents.

2. **A path that broke the compiled build.** The corpus was resolved from
   `__dirname`, which is `src/repositories` under `tsx` but
   `dist/src/repositories` once compiled — so the built service looked in
   `dist/src/data`, found nothing, and refused to boot. Found by *running* the
   build rather than trusting it.

   Worth noting: that failure was caught loudly by the fail-closed corpus check,
   which exists precisely so a missing corpus becomes a failed deploy rather
   than a service that boots healthy and retrieves nothing. The design worked.

**Not ported, deliberately:** `scripts/ingest.js`, `evaluation/evaluate.js` and
`src/ingestion/chunker.js`. They are offline batch tooling whose failure mode is
a visible non-zero exit at a keyboard, not a silent wrong answer served to a
user. The typing effort went where a type error becomes a production defect.
Both scripts import TypeScript modules and run under `tsx`.

**Build target is CommonJS**, unlike the sibling ESM repos. Converting the
module system at the same time as the language would have made a
behaviour-preserving port impossible to *verify* as behaviour-preserving. The
Zod error messages are preserved verbatim from the hand-rolled validation
because the tests assert on them.

---

## Observability

The service logged via `console.log`/`console.error` — no levels, no structure,
and no way to tell one request's lines from another's.

That last point is not cosmetic here. A single RAG request emits retrieval logs,
a refusal-or-generate decision, token-budget pruning lines and a completion
line, streamed over SSE and **interleaved with other concurrent streams**.
Without a shared identifier those lines cannot be reassembled into the request
that produced them.

`x-correlation-id` is accepted and sanitised at intake, generated when absent,
echoed on the response, and attached to every log line by a Pino `mixin()`. The
tests assert that concurrent scopes stay isolated — the failure mode being
guarded against is one stream's logs tagged with another's ID, which is worse
than no tagging at all because it produces confident, wrong traces.

The two most valuable log lines are now queryable rather than greppable:

```
outcome=refused_ungrounded cause=nothing_above_threshold retrievedChunks=0
outcome=answered includedChunks=3 estimatedPromptTokens=1840 sourcesEmitted=true
```

`outcome` distinguishes the three terminal states that used to be flattened into
free text — answered, out-of-domain refusal, and the ungrounded refusal above —
so the rate of each can be **measured** rather than guessed. That is what turns
the grounding gate from a claim into something observable in production.

**Secret redaction** includes a bare `key=` parameter, which the sibling repos
do not need. That is specific: the Google Generative AI SDK passes the API key
in the query string, so a failed request URL carries `?key=<GEMINI_API_KEY>`
straight into error messages and then into logs. There is a test asserting a
realistic leaked URL is scrubbed.

---

## What is still demo-grade, deliberately

- **In-memory vector store.** 650 documents, 3072-dimension vectors, an O(n)
  cosine scan per query. This is a deliberate choice, not an oversight: the
  corpus ships with the deploy, so there is no external database dependency and
  no cold-start pause. It does not scale, and the README says so. Knowing when
  *not* to add infrastructure is part of the point.
- **Corpus provenance is incomplete.** `corpus.meta.json` records
  `embeddingModel: null` because the model that produced the vectors was not
  captured at ingest time and cannot be recovered. It is recorded as `null`
  rather than guessed. Dimension *is* measured, and is what the boot and query
  gates enforce — so a model swap that changes width fails loudly, while a
  same-width swap would not be caught.
- **In-process rate limiting**, so a single instance is assumed.
- **The recursive chunker is not wired in.** Adopting it requires re-indexing
  the corpus and re-running the evaluation against the existing baseline.
- **The evaluation dataset is 8 questions.** Enough to catch a regression, not
  enough to claim a retrieval quality figure with confidence.

---

## Production rollout

Deployed 2026-08-28. See [DEPLOYMENT.md](DEPLOYMENT.md) for the runbook.

**What shipped:** the grounding gate (P1), the TypeScript port with Zod (P5),
structured logging with correlation IDs (P4), and the threshold recalibration
(P7).

**Two deploys failed before one succeeded**, and both were caused by this work:

1. `Cannot find module '/opt/render/project/src/index.js'` — the P5 port
   replaced `index.js` with `dist/index.js`, but Render's start command was
   still `node index.js` and its build command was `npm install`, which never
   ran `tsc`. This repo had never needed a build step before.
2. `Missing: @emnapi/runtime@1.11.3 from lock file` — `npm ci` under Render's
   default npm rejects an optional transitive of `@napi-rs/wasm-runtime`. The
   fix was the same npm pin `.github/workflows/test.yml` already applied, which
   should have been carried into the deploy config at the same time.

Neither reached users. Render kept the previous version live through both, and
the service never served a broken build. That is the failure mode working as
intended, but the deploy configuration was part of the blast radius of the
TypeScript port and was not enumerated with it. **A change to `main` and
`start` is a change to the deploy contract, and the hosting configuration
belongs in the blast-radius count alongside the call sites.**

**The defect was live until this deploy.** Before the swap, production answered
`"zxqv plorbnat weffle grimsby"` with a full four-section briefing on webhook
signature verification — confident, structured, and built from model priors.
That is what the threshold recalibration fixed, and it was reproducible against
the live service right up to the moment it shipped.

**One rollout trap worth recording:** the deploy reported `live` while the old
instance was still draining, so the first smoke test passed against the *old*
code and appeared to show the deploy had done nothing. Render runs both briefly.
Verify with a signal only the new build emits — `x-correlation-id` here — rather
than trusting the deploy status.

**Post-deploy verification:** six queries against the live service. Both README
showcase questions and both realistic payments questions answered with sources
(2–4 each); two noise queries hit the code-level gate. Production logs confirm
it:

```json
{"correlationId":"f5008f4a-…","outcome":"refused_ungrounded","durationMs":295,
 "retrievedChunks":0,"includedChunks":0,"threshold":0.62,
 "cause":"nothing_above_threshold","msg":"Refused ungrounded answer; model was not called"}
```

**What to monitor.** The ratio of `outcome=refused_ungrounded` to
`outcome=answered` is the number that matters. It was ~0 before this deploy
because the gate never fired. A sustained rise means the threshold is now too
high for real traffic, or corpus coverage has a gap — either way it is a
retrieval problem, not a model problem, and `npm run calibrate` is the first
thing to run. `outcome=out_of_domain_refusal` should stay rare now that the code
gate catches noise before the classifier sees it.

---

## Method

The grounding gate was written as a failing test first, run against the unfixed
service, and watched to fail. The compiled build was executed and its `/health`
endpoint queried rather than assumed to work — which is the only reason the
corpus-path bug was caught before deployment rather than after.
