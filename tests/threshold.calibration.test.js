import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MATCH_THRESHOLD } from '../src/config/limits.js';

/**
 * Retrieval threshold calibration guard.
 *
 * WHY THIS IS A FIXTURE TEST AND NOT A LIVE ONE.
 *
 * The obvious test runs the eval questions and the noise queries through the
 * real embedding API and asserts the outcomes. That test would be better
 * evidence and is a worse test to put in a suite: it needs a funded API key,
 * costs money on every CI run, takes ~30 seconds, and fails on network flake -
 * so it would be skipped in CI, and a skipped test guards nothing.
 *
 * Instead the live measurement is a separate opt-in script (`npm run
 * calibrate`) whose output is committed to evaluation/threshold-calibration.json,
 * and this test asserts the threshold still separates the measured bands. It is
 * deterministic, free, and fails in CI the moment someone moves MATCH_THRESHOLD
 * into the overlap or edits the calibration data to fit a threshold.
 *
 * What it CANNOT observe: whether the recorded numbers are still true. Corpus
 * or embedding-model changes invalidate them, which is why the corpus dimension
 * gate exists separately and why the calibration file records what produced it.
 */

const calibration = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'evaluation', 'threshold-calibration.json'), 'utf8')
);

const inDomain = calibration.inDomain.topSimilarity;
const noise = calibration.noise.topSimilarity;

describe('retrieval threshold calibration', () => {
    it('retains every measured in-domain question', () => {
        const refused = inDomain.filter((s) => s < MATCH_THRESHOLD);
        expect(refused).toEqual([]);
    });

    it('refuses every measured noise query', () => {
        // This is the assertion that failed at the previous threshold of 0.48,
        // where 5 of these 6 cleared the bar - including literal gibberish.
        const admitted = noise.filter((s) => s >= MATCH_THRESHOLD);
        expect(admitted).toEqual([]);
    });

    it('sits strictly inside the measured separation gap', () => {
        const worstInDomain = Math.min(...inDomain);
        const bestNoise = Math.max(...noise);

        expect(bestNoise).toBeLessThan(MATCH_THRESHOLD);
        expect(MATCH_THRESHOLD).toBeLessThan(worstInDomain);
    });

    it('keeps a proportional margin on both sides rather than hugging one band', () => {
        // ORIGINAL ASSERTION, AND WHY IT CHANGED.
        //
        // This test first required an absolute margin of >0.03 on each side.
        // That was written against a calibration of n=8 in-domain and n=6
        // noise, which reported a 0.151 separation gap and made 0.03 look
        // generous.
        //
        // Widening both populations to 20 collapsed the measured gap to 0.035.
        // An absolute 0.03 on BOTH sides is arithmetically impossible inside a
        // 0.035 gap, so the original assertion could not be satisfied by any
        // threshold - it was not detecting a bad threshold, it was encoding a
        // sample size that no longer exists.
        //
        // The replacement is proportional: each side must hold at least a
        // quarter of whatever gap actually exists. That keeps the real
        // property - the threshold must not hug either band - while staying
        // meaningful as the gap changes. It is deliberately NOT a lower
        // absolute number chosen to make the previous value pass.
        const worstInDomain = Math.min(...inDomain);
        const bestNoise = Math.max(...noise);
        const gap = worstInDomain - bestNoise;

        const marginBelow = MATCH_THRESHOLD - bestNoise;
        const marginAbove = worstInDomain - MATCH_THRESHOLD;

        expect(marginBelow).toBeGreaterThan(gap * 0.25);
        expect(marginAbove).toBeGreaterThan(gap * 0.25);
    });

    it('surfaces how thin the separation actually is', () => {
        // Not a pass/fail on quality - a tripwire on the story. The gap is the
        // number that decides whether a single scalar threshold is a defensible
        // instrument at all. If it collapses further, the honest answer stops
        // being "retune the threshold" and becomes "one signal is not enough",
        // and this test is where that becomes visible rather than a surprise.
        const gap = Math.min(...inDomain) - Math.max(...noise);

        expect(gap).toBeGreaterThan(0);
        if (gap < 0.02) {
            throw new Error(
                `Separation gap has collapsed to ${gap.toFixed(3)}. A single ` +
                `cosine threshold can no longer separate these populations ` +
                `reliably; add a second signal (reranker, keyword check, or a ` +
                `model-side relevance judgement) rather than retuning.`
            );
        }
    });

    it('records the provenance needed to know when it goes stale', () => {
        // A calibration number without the model that produced it is the same
        // failure as the corpus that recorded embeddingModel: null.
        expect(calibration.embeddingModel).toBeTruthy();
        expect(calibration.dimensions).toBe(3072);
        expect(calibration.corpusDocumentCount).toBeGreaterThan(0);
        expect(calibration.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('reports honest sample sizes', () => {
        // n=8 and n=6 are small. Asserting the declared n matches the data
        // stops the file drifting into claiming more evidence than it holds.
        expect(inDomain).toHaveLength(calibration.inDomain.n);
        expect(noise).toHaveLength(calibration.noise.n);
        expect(calibration.noise.queries).toHaveLength(calibration.noise.n);
    });
});
