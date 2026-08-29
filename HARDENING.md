# Hardening Log

This repository was audited, found to have a real correctness defect, and
remediated. This file records what was wrong and what changed, because for a
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

That placeholder was not a safeguard. The system prompt instructs the model
that for any IN-DOMAIN question it **MUST** emit the full four-section
structure. So a Stripe question that retrieved nothing did not produce a
hedge; it produced a confident Executive Strategy, Technical Implementation
Roadmap, Webhook Events section and Jira ticket, assembled entirely from model
priors.

And because sources are only emitted when `includedChunks` is non-empty, that
answer arrived **with no citations**; the one signal a reader had that nothing
was retrieved.

Meanwhile `README.md` claimed, under "RAG Capabilities Demonstrated":

> **Grounded Responses**: Restricts generation strictly to the retrieved facts.

**Fixed by** a grounding gate that returns before the model is reached
whenever `includedChunks` is empty. It covers both causes: nothing above
threshold, and everything above threshold pruned by the token budget; a pruned
answer is exactly as ungrounded as an unretrieved one. The refusal string is
emitted by the service, not the model, so it cannot be paraphrased or
restructured.

**Proof:** the three gate tests were run against the pre-fix service and fail.
They assert that `generateContentStream` is **never called**, not merely that
the output text is right; asserting on the response alone would still pass if
the model were called and its output discarded, burning quota and latency on
every unanswerable question.

**Sequencing note:** the false README claim was removed in a *separate, earlier*
commit than the code fix, and the gap was recorded under Known Limitations in
the interim. The guarantee was only restated once the code enforced it. `main`
therefore never carried a claim its tests could not back, at any commit.

**Trade-off, stated rather than hidden:** an in-domain question whose best
match scores just under `0.48` is now refused rather than answered. That is
the correct posture (a confidently wrong answer costs more than a decline),
but it makes retrieval precision and corpus coverage the binding constraint on
usefulness, rather than the model. This is documented in the README's
limitations section, not buried.

---

## The gate was correct and almost never fired

Found while verifying the demo before pushing, not during the original audit.

The grounding gate only helps when retrieval actually returns nothing. It
turned out almost nothing was rejected: `MATCH_THRESHOLD` was `0.48`, and
measurement showed the noise band reaching **0.555**. Five of six noise
queries cleared it, including `"zxqv plorbnat weffle grimsby"` at 0.544. Every
query retrieved the full six chunks.

The system *was* behaving correctly in live testing (out-of-domain questions
were refused), but by the **system prompt's domain classifier**, not by the
code. Exactly the pattern the gate was built to replace: a prompt is not a
guardrail. The gate was real, tested, and decorative.

## Then the calibration that fixed it turned out to be too small

The first fix raised the threshold to `0.62`, justified by a measured separation
gap of 0.151 between in-domain (n=8) and noise (n=6). That number did not
survive a bigger sample.

Widening both populations to **20 each** (and deliberately including the hard
cases, fluent English about unrelated subjects and adjacent
technical/financial questions rather than only gibberish) produced:

| Population | n=8 / n=6 (first pass) | **n=20 / n=20** |
|---|---|---|
| In-domain range | 0.706 to 0.816 | **0.628**  to  0.816 |
| Noise range | 0.473 to 0.555 | 0.452  to  **0.593** |
| Separation gap | 0.151 | **0.035** |

The weakest in-domain score fell by 0.078 and the noise ceiling rose by 0.038.
At `0.62` the headroom above had shrunk to **0.008**, one ordinary payments
question away from being refused.

**The correct adjustment was down, not up.** The obvious reading of the first
calibration was that the threshold could safely rise toward 0.65; the wider
sample shows that would have refused three of the twenty in-domain queries
outright. It is now **0.61**, just under the midpoint of 0.611, biasing the
remaining margin toward retaining real questions. Verified: 0/20 noise
admitted, 0/20 in-domain refused.

**The real finding is that the margin is thin.** A 0.035 gap between two
20-sample populations is not a comfortable separation, and a single scalar
cosine threshold is a weak instrument at that margin. A robust system would
add a second signal: a reranker, a keyword check, or a model-side relevance
judgement over the retrieved chunks. That is not implemented, and the README
says so rather than implying the threshold settles the question.

**Two pieces of tooling honesty came out of the same pass:**

- `tests/threshold.calibration.test.js` originally asserted an absolute margin
of >0.03 on each side. Inside a 0.035 gap that is arithmetically impossible,
so the assertion was not detecting a bad threshold; it was encoding a sample
size that no longer existed. It is now proportional (each side must hold a
quarter of whatever gap exists), plus a tripwire that fails outright if the
gap collapses below 0.02, at which point the honest answer stops being
"retune" and becomes "one signal is not enough". The replacement is
deliberately not a smaller absolute number picked to make the old value pass.
- `npm run calibrate` used to log and skip a query that errored, silently
shrinking the sample, and `--write` then recorded the reduced count as though
it were intended. It caught a real 503 from the embedding API during this work
and wrote `n: 19`. It now counts failures, warns, and refuses to write a
partial run. A calibration file claiming a sample size it did not measure is
the same defect class as a README claiming a guarantee the code does not
enforce.

---

## TypeScript, and the two bugs the port found

The request path (config, repositories, services, routes, logging, entry
point) is now TypeScript under `strict` with `noUncheckedIndexedAccess`, and
the HTTP boundary is validated with Zod. The retrieval contract
(`RetrievedChunk`, `Source`, `GeminiModels`) is declared rather than inferred
from whatever the SDK happened to return.

The port was not cosmetic. It surfaced two defects that had been invisible:

1. **A dead fallback branch.** The source-label chain read
`m.metadata?.source || m.metadata?.path || m.url`. The repository never sets a
`url` field on a match (it returns `id`, `content`, `metadata`, `similarity`),
so that branch was unreachable and the chain silently fell through to the
generic "Stripe Documentation Reference" label. Exactly the class of
shape-guessing defect a typed retrieval contract prevents.

2. **A path that broke the compiled build.** The corpus was resolved from
`__dirname`, which is `src/repositories` under `tsx` but
`dist/src/repositories` once compiled, so the built service looked in
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

The service logged via `console.log`/`console.error`, no levels, no structure,
and no way to tell one request's lines from another's.

That last point is not cosmetic here. A single RAG request emits retrieval logs,
a refusal-or-generate decision, token-budget pruning lines and a completion
line, streamed over SSE and **interleaved with other concurrent streams**.
Without a shared identifier those lines cannot be reassembled into the request
that produced them.

`x-correlation-id` is accepted and sanitised at intake, generated when absent,
echoed on the response, and attached to every log line by a Pino `mixin()`.
The tests assert that concurrent scopes stay isolated; the failure mode being
guarded against is one stream's logs tagged with another's ID, which is worse
than no tagging at all because it produces confident, wrong traces.

The two most valuable log lines are now queryable rather than greppable:

```
outcome=refused_ungrounded cause=nothing_above_threshold retrievedChunks=0
outcome=answered includedChunks=3 estimatedPromptTokens=1840 sourcesEmitted=true
```

`outcome` distinguishes the three terminal states that used to be flattened
into free text (answered, out-of-domain refusal, and the ungrounded refusal
above), so the rate of each can be **measured** rather than guessed. That is
what turns the grounding gate from a claim into something observable in
production.

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
gates enforce, so a model swap that changes width fails loudly, while a
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

1. `Cannot find module '/opt/render/project/src/index.js'`, the P5 port
   replaced `index.js` with `dist/index.js`, but Render's start command was
   still `node index.js` and its build command was `npm install`, which never
   ran `tsc`. This repo had never needed a build step before.
2. `Missing: @emnapi/runtime@1.11.3 from lock file`, `npm ci` under Render's
   default npm rejects an optional transitive of `@napi-rs/wasm-runtime`. The
   fix was the same npm pin `.github/workflows/test.yml` already applied, which
   should have been carried into the deploy config at the same time.

Neither reached users. Render kept the previous version live through both, and
the service never served a broken build. That is the failure mode working as
intended, but the deploy configuration was part of the blast radius of the
TypeScript port and was not enumerated with it. **A change to `main` and
`start` is a change to the deploy contract, and the hosting configuration
belongs in the blast-radius count alongside the call sites.**

**The defect was live until this deploy.** Before the swap, production
answered `"zxqv plorbnat weffle grimsby"` with a full four-section briefing on
webhook signature verification, confident, structured, and built from model
priors. That is what the threshold recalibration fixed, and it was
reproducible against the live service right up to the moment it shipped.

**One rollout trap worth recording:** the deploy reported `live` while the old
instance was still draining, so the first smoke test passed against the *old*
code and appeared to show the deploy had done nothing. Render runs both
briefly. Verify with a signal only the new build emits (`x-correlation-id`
here) rather than trusting the deploy status.

**Post-deploy verification:** six queries against the live service. Both
README showcase questions and both realistic payments questions answered with
sources (2 to 4 each); two noise queries hit the code-level gate. Production
logs confirm it:

```json
{"correlationId":"f5008f4a-…","outcome":"refused_ungrounded","durationMs":295,
 "retrievedChunks":0,"includedChunks":0,"threshold":0.62,
 "cause":"nothing_above_threshold","msg":"Refused ungrounded answer; model was not called"}
```

That line is quoted verbatim from the 2026-08-28 rollout, so it shows
`threshold: 0.62`; the value live at the time. The configured value is now
`0.61`; see the calibration section above for why it moved.

**What to monitor.** The ratio of `outcome=refused_ungrounded` to
`outcome=answered` is the number that matters. It was ~0 before this deploy
because the gate never fired. A sustained rise means the threshold is now too
high for real traffic, or corpus coverage has a gap, either way it is a
retrieval problem, not a model problem, and `npm run calibrate` is the first
thing to run. `outcome=out_of_domain_refusal` should stay rare now that the
code gate catches noise before the classifier sees it.

---

## Method

The grounding gate was written as a failing test first, run against the
unfixed service, and watched to fail. The compiled build was executed and its
`/health` endpoint queried rather than assumed to work, which is the only
reason the corpus-path bug was caught before deployment rather than after.
