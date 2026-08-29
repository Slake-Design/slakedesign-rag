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
    // Gibberish - the easy case. Included as a floor, not as the interesting one.
    'zxqv plorbnat weffle grimsby',
    'asdkjh asdkjh asdkjh',
    'qqqq wwww eeee rrrr tttt',

    // Fluent, well-formed English about unrelated subjects. This is the case an
    // embedding model is most likely to score misleadingly high, so it is the
    // case the threshold actually has to survive.
    'What is the airspeed velocity of an unladen swallow?',
    'What is the distance to the moon?',
    'Who won the NBA finals in 1998?',
    'Recipe for sourdough starter',
    'How do I change the oil in a 2015 Honda Civic?',
    'What are the health benefits of intermittent fasting?',
    'Explain the causes of the French Revolution',
    'How do I train a puppy to stop barking?',
    'What is the best fertiliser for tomato plants?',

    // Adjacent-but-out-of-corpus: technical, sometimes financial, but nothing a
    // Stripe documentation corpus should claim to answer. These are the ones
    // most likely to sit just under the in-domain band.
    'How do I configure a Kubernetes horizontal pod autoscaler?',
    'What is the difference between TCP and UDP?',
    'How do I write a recursive CTE in PostgreSQL?',
    'What is the current price of Bitcoin?',
    'How do I file a personal tax return in the UK?',
    'What is double-entry bookkeeping?',
    'How does the SWIFT network route interbank messages?',
    'What is a good asset allocation for a retirement portfolio?',
];

/**
 * Supplementary in-domain questions, used for CALIBRATION ONLY.
 *
 * `evaluation/stripe_questions.json` is deliberately not extended with these.
 * That file drives the retrieval hit-rate measurement, and its value depends on
 * staying comparable across runs - changing its membership silently changes the
 * headline number it produces.
 *
 * Calibration has the opposite need. The threshold is bounded from above by the
 * WEAKEST in-domain score, so a small in-domain sample is the side most likely
 * to under-estimate the risk of refusing a real question. Eight was not enough
 * to set a threshold against twenty noise queries.
 */
const EXTRA_IN_DOMAIN = [
    'How do I handle a failed subscription payment and retry it?',
    'What is the difference between a charge and a payment intent?',
    'How do I test webhooks locally before going live?',
    'How do I add a trial period to a subscription?',
    'What does the requires_action status mean on a PaymentIntent?',
    'How do I attach a payment method to a customer for later use?',
    'How do I handle 3D Secure authentication in a payment flow?',
    'What is an idempotency key and how does Stripe use it?',
    'How do I split a payment between multiple connected accounts?',
    'How do I issue a partial refund and track the remaining balance?',
    'What events does Stripe send when an invoice is paid?',
    'How do I migrate card details from another payment processor?',
];

const round = (n) => Number(n.toFixed(3));

async function topSimilarity(question) {
    const embed = await embeddingModel.embedContent(question);
    // Threshold 0 so the raw score is observed rather than filtered by the very
    // value being calibrated.
    const matches = await documentRepository.matchDocuments(embed.embedding.values, 0, 1);
    return matches.length > 0 ? matches[0].similarity : 0;
}

/**
 * Measures a population, and reports how many measurements were LOST.
 *
 * A transient API error used to be logged and skipped, which silently shrank
 * the sample - and then `--write` recorded the reduced count as though it were
 * the intended sample size. A calibration file claiming n=19 when 20 were asked
 * for is the same class of defect as a README claiming a guarantee the code
 * does not enforce: the number looks deliberate and is not.
 *
 * Failures are now counted and surfaced, and `--write` refuses to record a
 * partial run.
 */
async function measure(label, questions) {
    const scores = [];
    const failures = [];
    for (const q of questions) {
        try {
            scores.push(await topSimilarity(q));
        } catch (err) {
            failures.push({ q, reason: err.message });
            console.error(`  [FAILED] ${label}: ${q.slice(0, 44)} -> ${err.message}`);
        }
    }
    return { scores: scores.map(round).sort((a, b) => a - b), failures, asked: questions.length };
}

async function main() {
    const questionsPath = path.join(__dirname, 'stripe_questions.json');
    const inDomainQuestions = [
        ...JSON.parse(fs.readFileSync(questionsPath, 'utf8')).map((q) => q.question),
        ...EXTRA_IN_DOMAIN,
    ];

    console.log(`Calibrating against ${inDomainQuestions.length} in-domain and ${NOISE_QUERIES.length} noise queries...\n`);

    const inDomainResult = await measure('in-domain', inDomainQuestions);
    const noiseResult = await measure('noise', NOISE_QUERIES);

    const inDomain = inDomainResult.scores;
    const noise = noiseResult.scores;
    const lost = inDomainResult.failures.length + noiseResult.failures.length;

    if (inDomain.length === 0 || noise.length === 0) {
        console.error('Calibration failed: one population produced no measurements.');
        process.exit(1);
    }

    if (lost > 0) {
        console.error('');
        console.error(`WARNING: ${lost} of ${inDomainResult.asked + noiseResult.asked} measurements failed.`);
        console.error('The distribution below is incomplete and must not be recorded as a calibration.');
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

    if (process.argv.includes('--write') && lost > 0) {
        console.error('');
        console.error('Refusing to --write a partial run. Re-run when the API is healthy.');
        process.exit(3);
    }

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
