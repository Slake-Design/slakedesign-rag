/** Upper bound on a submitted question, enforced at the route boundary. */
export const MAX_QUESTION_CHARS = 2000;

/**
 * Minimum cosine similarity for a retrieved chunk to be considered grounding.
 *
 * SINGLE SOURCE OF TRUTH. The service, the repository default and the
 * evaluation harness all read this. They previously carried three different
 * literals - 0.48 in the service, 0.48 duplicated in evaluate.js, and 0.45 as
 * the repository's parameter default - which meant the eval harness could
 * report retrieval quality for a threshold production did not use.
 *
 * CALIBRATION (measured 2026-08-28 against gemini-embedding-001, 3072-d,
 * over the committed 650-document corpus). Top-1 cosine similarity:
 *
 *   in-domain  (evaluation/stripe_questions.json, n=8):  0.706 - 0.816
 *   noise      (gibberish + off-topic, n=6):             0.473 - 0.555
 *   separation gap:                                      0.151
 *
 * The exact midpoint is 0.631. 0.62 is used instead: it biases the margin
 * toward retaining real questions (0.086 above the threshold to the nearest
 * in-domain score, 0.065 below it to the nearest noise score) rather than
 * splitting the gap evenly. For a demo, wrongly refusing a genuine payments
 * question is a worse failure than admitting a borderline one, and the
 * out-of-domain classifier in the system prompt remains as a second line.
 *
 * Verified by `npm run calibrate`: 0/6 noise admitted, 0/8 in-domain refused.
 *
 * The previous value of 0.48 sat BELOW the noise band: 5 of 6 noise queries
 * cleared it, including the string "zxqv plorbnat weffle grimsby" at 0.544.
 * The grounding gate in rag.service.ts was therefore correct but almost never
 * reached, and the system prompt's domain classifier was doing the real work -
 * which is precisely the prompt-as-guardrail pattern the gate exists to avoid.
 *
 * MEASURED, NOT PROVEN. n=8 and n=6 are small. Re-run `npm run calibrate` after
 * any corpus or embedding-model change, and widen
 * evaluation/stripe_questions.json before treating this number as settled.
 */
export const MATCH_THRESHOLD = 0.62;

/** Maximum chunks retrieved per query. */
export const MATCH_COUNT = 6;
