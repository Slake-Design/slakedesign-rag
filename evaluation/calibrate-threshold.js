/**
 * Retrieval threshold calibration.
 *
 * Measures top-1 cosine similarity for two populations against the committed
 * corpus - the in-domain evaluation questions, and a set of noise queries that
 * SHOULD retrieve nothing - and reports the separation between them.
 *
 * Run this after any corpus change or embedding-model change:
 *
 *     npm run calibrate            # print the report
 *     npm run calibrate -- --write # also update threshold-calibration.json
 *
 * It is deliberately NOT part of `npm test`: it needs a funded API key, costs
 * money per run, and fails on network flake. tests/threshold.calibration.test.js
 * asserts the committed numbers still justify MATCH_THRESHOLD, which is the part
 * that belongs in CI.
 *
 * Read-only with respect to the corpus. It never writes embeddings.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { embeddingModel } = require('../src/config/gemini');
// Named export, not the module object. document.repository.ts has both a
// default and named exports, so a CommonJS require() yields the module
// namespace - `require(...).matchDocuments` is undefined, silently, at the
// first call rather than at import.
const { documentRepository } = require('../src/repositories/document.repository');
const { MATCH_THRESHOLD } = require('../src/config/limits');

/**
 * Queries that must retrieve nothing: two gibberish strings and four questions
 * that are coherent but have no business matching a Stripe corpus. Gibberish
 * alone would be too easy - the interesting case is fluent, well-formed English
 * about an unrelated subject, which is what an embedding model is most likely
 * to score misleadingly high.
 */
const NOISE_QUERIES = [
    'zxqv plorbnat weffle grimsby',
    'asdkjh asdkjh asdkjh',
    'What is the airspeed velocity of an unladen swallow?',
    'What is the distance to the moon?',
    'Who won the NBA finals in 1998?',
    'Recipe for sourdough starter',
];

const round = (n) => Number(n.toFixed(3));

async function topSimilarity(question) {
    const embed = await embeddingModel.embedContent(question);
    // Threshold 0 so the raw score is observed rather than filtered by the very
    // value being calibrated.
    const matches = await documentRepository.matchDocuments(embed.embedding.values, 0, 1);
    return matches.length > 0 ? matches[0].similarity : 0;
}

async function measure(label, questions) {
    const scores = [];
    for (const q of questions) {
        try {
            scores.push(await topSimilarity(q));
        } catch (err) {
            console.error(`  [skip] ${label}: ${q.slice(0, 40)} -> ${err.message}`);
        }
    }
    return scores.map(round).sort((a, b) => a - b);
}

async function main() {
    const questionsPath = path.join(__dirname, 'stripe_questions.json');
    const inDomainQuestions = JSON.parse(fs.readFileSync(questionsPath, 'utf8')).map((q) => q.question);

    console.log(`Calibrating against ${inDomainQuestions.length} in-domain and ${NOISE_QUERIES.length} noise queries...\n`);

    const inDomain = await measure('in-domain', inDomainQuestions);
    const noise = await measure('noise', NOISE_QUERIES);

    if (inDomain.length === 0 || noise.length === 0) {
        console.error('Calibration failed: one population produced no measurements.');
        process.exit(1);
    }

    const worstInDomain = Math.min(...inDomain);
    const bestNoise = Math.max(...noise);
    const gap = round(worstInDomain - bestNoise);
    const midpoint = round((worstInDomain + bestNoise) / 2);

    console.log(`in-domain (n=${inDomain.length}): ${inDomain[0]} - ${inDomain[inDomain.length - 1]}`);
    console.log(`  ${inDomain.join(' ')}`);
    console.log(`noise     (n=${noise.length}): ${noise[0]} - ${noise[noise.length - 1]}`);
    console.log(`  ${noise.join(' ')}`);
    console.log('');
    console.log(`separation gap : ${gap} ${gap > 0 ? '(separable)' : '(OVERLAPPING - no threshold can separate these)'}`);
    console.log(`suggested      : ${midpoint}  (midpoint of the gap)`);
    console.log(`configured     : ${MATCH_THRESHOLD}`);

    const admitted = noise.filter((s) => s >= MATCH_THRESHOLD).length;
    const refused = inDomain.filter((s) => s < MATCH_THRESHOLD).length;
    console.log('');
    console.log(`at the configured threshold: ${admitted}/${noise.length} noise admitted, ${refused}/${inDomain.length} in-domain refused`);

    if (process.argv.includes('--write')) {
        const out = {
            measuredAt: new Date().toISOString().slice(0, 10),
            embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'models/gemini-embedding-001',
            dimensions: documentRepository.dimensions,
            corpusDocumentCount: documentRepository.documents ? documentRepository.documents.length : null,
            metric: 'top-1 cosine similarity against the committed corpus',
            note: 'Regenerate with `npm run calibrate -- --write`.',
            inDomain: { source: 'evaluation/stripe_questions.json', n: inDomain.length, topSimilarity: inDomain },
            noise: { n: noise.length, queries: NOISE_QUERIES, topSimilarity: noise },
        };
        const target = path.join(__dirname, 'threshold-calibration.json');
        fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
        console.log(`\nWrote ${target}`);
    }

    if (admitted > 0 || refused > 0) process.exit(2);
}

main().catch((err) => {
    console.error('Calibration failed:', err.message);
    process.exit(1);
});
