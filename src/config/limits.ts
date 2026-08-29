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
 * CALIBRATION (re-measured 2026-08-29 against gemini-embedding-001, 3072-d,
 * over the committed 650-document corpus). Top-1 cosine similarity:
 *
 *   in-domain (n=20):  0.628 - 0.816
 *   noise     (n=20):  0.452 - 0.593
 *   separation gap:    0.035
 *
 * 0.61 sits just below the midpoint (0.611), biasing the small remaining margin
 * toward retaining real questions: 0.017 above the noise ceiling, 0.018 below
 * the weakest in-domain score. Verified by `npm run calibrate`: 0/20 noise
 * admitted, 0/20 in-domain refused.
 *
 * WHY THIS MOVED DOWN, NOT UP. An earlier calibration used n=8 in-domain and
 * n=6 noise and reported a 0.151 gap, which suggested the threshold could
 * safely rise toward 0.65. That gap was an artifact of a small, easy sample.
 * Widening both populations to 20 dropped the weakest in-domain score from
 * 0.706 to 0.628 and raised the noise ceiling from 0.555 to 0.593. At 0.62 the
 * headroom above was 0.008 - one ordinary payments question away from being
 * refused. Raising to 0.63-0.65 would have refused three of the twenty
 * in-domain queries outright.
 *
 * THE MARGIN IS THIN AND THAT IS THE REAL FINDING. A 0.035 gap between two
 * 20-sample populations is not a comfortable separation. The two bands are
 * close enough that a single scalar threshold is a weak instrument here, and a
 * genuinely robust system would add a second signal - a reranker, a keyword
 * check, or a model-side relevance judgement on the retrieved chunks. That is
 * recorded as a limitation rather than papered over, because the numbers do not
 * support claiming more.
 *
 * MEASURED, NOT PROVEN. Re-run `npm run calibrate` after any corpus or
 * embedding-model change. Both samples are hand-written and n=20; they bound
 * the problem, they do not settle it.
 */
export const MATCH_THRESHOLD = 0.61;

/** Maximum chunks retrieved per query. */
export const MATCH_COUNT = 6;
