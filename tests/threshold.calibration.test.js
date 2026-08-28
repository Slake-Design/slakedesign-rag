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

    it('keeps a usable margin on both sides rather than hugging one band', () => {
        // A threshold technically inside the gap but 0.001 from the nearest
        // in-domain score would pass the tests above while being one corpus
        // edit away from refusing real questions.
        const marginBelow = MATCH_THRESHOLD - Math.max(...noise);
        const marginAbove = Math.min(...inDomain) - MATCH_THRESHOLD;

        expect(marginBelow).toBeGreaterThan(0.03);
        expect(marginAbove).toBeGreaterThan(0.03);
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
