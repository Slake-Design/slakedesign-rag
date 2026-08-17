#!/usr/bin/env node
/**
 * Offline corpus ingestion.
 *
 * Replaces the three Supabase-era scripts (`scraper.js`, `ingest-stripe.js`,
 * `ingest-stripe-guides.js`) and the one-off `export-documents.js`. Those wrote to a
 * Postgres/pgvector table that no longer exists; this writes straight to
 * `src/data/documents.json`, which is what the running service actually reads.
 *
 * Why this is a script and not an HTTP endpoint: `DocumentRepository` loads the corpus
 * into memory once at boot and never writes back, and the host filesystem is ephemeral.
 * A write served over HTTP would be lost on the next deploy and would diverge across
 * instances. Ingestion belongs in version control, committed alongside the code.
 *
 * Usage:
 *   node scripts/ingest.js --spec                 # Stripe OpenAPI spec (stripe-spec.json)
 *   node scripts/ingest.js --urls                 # built-in Stripe docs URL list
 *   node scripts/ingest.js --urls https://a,https://b
 *   node scripts/ingest.js --spec --limit 50
 *   node scripts/ingest.js --spec --dry-run       # plan only; makes NO Gemini calls
 *
 * Behaviour:
 *   - APPEND-ONLY. Existing records are never modified or dropped.
 *   - Skips chunks whose exact content is already in the corpus.
 *   - Writes atomically (temp file + rename) so an interrupted run cannot corrupt
 *     the 25MB corpus.
 *   - `--dry-run` performs fetching/chunking/dedupe but no embedding, so it costs
 *     nothing and is the safe way to preview a run.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const Chunker = require('../src/ingestion/chunker');

const DOCS_PATH = path.join(__dirname, '..', 'src', 'data', 'documents.json');

// Preserved verbatim from the retired scraper.js so a re-run reproduces the same corpus.
const STRIPE_DOC_URLS = [
    'https://docs.stripe.com/payments/accept-a-payment',
    'https://docs.stripe.com/payments/payment-intents',
    'https://docs.stripe.com/payments/checkout',
    'https://docs.stripe.com/billing/subscriptions/overview',
    'https://docs.stripe.com/invoicing/overview',
    'https://docs.stripe.com/webhooks',
    'https://docs.stripe.com/refunds',
    'https://docs.stripe.com/disputes',
    'https://docs.stripe.com/payouts',
    'https://docs.stripe.com/connect/overview',
    'https://docs.stripe.com/tax/overview',
    'https://docs.stripe.com/radar/overview',
    'https://docs.stripe.com/payments/3d-secure',
    'https://docs.stripe.com/payments/bank-transfers',
    'https://docs.stripe.com/payments/link',
    'https://docs.stripe.com/billing/customer',
    'https://docs.stripe.com/billing/invoices/overview',
    'https://docs.stripe.com/billing/taxes/tax-rates',
    'https://docs.stripe.com/connect/charges',
    'https://docs.stripe.com/connect/payouts-bank-accounts',
];

const CHUNK_OPTIONS = { chunkSize: 300, chunkOverlap: 50 };
const EMBED_DELAY_MS = 2000;
const MAX_BACKOFF_ATTEMPTS = 5;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
    const args = {
        spec: false,
        urls: null,
        limit: Infinity,
        dryRun: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--spec') {
            args.spec = true;
        } else if (arg === '--urls') {
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                args.urls = next.split(',').map(u => u.trim()).filter(Boolean);
                i++;
            } else {
                args.urls = STRIPE_DOC_URLS;
            }
        } else if (arg === '--limit') {
            const next = Number(argv[++i]);
            if (!Number.isFinite(next) || next <= 0) {
                throw new Error('--limit requires a positive number');
            }
            args.limit = next;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!args.spec && !args.urls) {
        throw new Error('Nothing to do. Pass --spec and/or --urls (see header for usage).');
    }

    return args;
}

function loadCorpus(docsPath = DOCS_PATH) {
    if (!fs.existsSync(docsPath)) {
        return [];
    }
    const parsed = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
    if (!Array.isArray(parsed)) {
        throw new Error(`${docsPath} is not a JSON array — refusing to touch it.`);
    }
    return parsed;
}

/**
 * Atomic write. The corpus is ~25MB; a partial write from an interrupted run would
 * leave the service unable to boot, so the new file is staged and renamed into place.
 */
function saveCorpus(docs, docsPath = DOCS_PATH) {
    const tmpPath = `${docsPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(docs, null, 2));
    fs.renameSync(tmpPath, docsPath);
}

/**
 * Drops candidates whose exact content is already stored, so re-running a source is
 * idempotent rather than duplicating the corpus.
 */
function dedupe(corpus, candidates) {
    const seen = new Set(corpus.map(d => d.content));
    const fresh = [];
    for (const candidate of candidates) {
        if (seen.has(candidate.content)) continue;
        seen.add(candidate.content);
        fresh.push(candidate);
    }
    return fresh;
}

/** Builds the stored record for one embedded chunk. */
function buildRecord(id, candidate, embedding) {
    const source = candidate.metadata && candidate.metadata.source;
    return {
        id,
        content: candidate.content,
        // Stored as a JSON string to match the 650 records exported from pgvector.
        // DocumentRepository parses either form, but a homogeneous file is easier to reason about.
        embedding: JSON.stringify(embedding),
        metadata: candidate.metadata,
        doc_type: null,
        url: typeof source === 'string' && source.startsWith('http') ? source : null,
    };
}

function nextId(docs) {
    return docs.reduce((max, d) => (typeof d.id === 'number' && d.id > max ? d.id : max), 0) + 1;
}

/** Extract readable text from an HTML page. Mirrors the retired scraper's selectors. */
function extractText(html) {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header').remove();
    return $('main, article, .content, body').text().replace(/\s+/g, ' ').trim();
}

/** Flatten the Stripe OpenAPI spec into one text block per operation. */
function specToTexts(spec) {
    const texts = [];
    for (const [routePath, pathObj] of Object.entries(spec.paths || {})) {
        for (const method of Object.keys(pathObj)) {
            const op = pathObj[method];
            if (!op || typeof op !== 'object') continue;

            const text = [
                `${method.toUpperCase()} ${routePath}`,
                op.summary || '',
                op.description || '',
                op.parameters
                    ? 'Parameters: ' + op.parameters.map(p => `${p.name}: ${p.description || ''}`).join(', ')
                    : '',
            ].filter(Boolean).join('\n');

            // Matches the retired script: skip stubs with no useful description.
            if (text.length < 50) continue;

            texts.push({
                content: text,
                metadata: { source: 'stripe-api', path: routePath, method: method.toUpperCase() },
            });
        }
    }
    return texts;
}

async function collectCandidates(args) {
    const candidates = [];

    if (args.spec) {
        const specPath = path.join(__dirname, '..', 'stripe-spec.json');
        if (!fs.existsSync(specPath)) {
            throw new Error(`Stripe spec not found at ${specPath}`);
        }
        const fromSpec = specToTexts(JSON.parse(fs.readFileSync(specPath, 'utf8')));
        console.log(`[spec]  ${fromSpec.length} operations`);
        candidates.push(...fromSpec);
    }

    for (const url of args.urls || []) {
        try {
            const { data: html } = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 15000,
            });
            const text = extractText(html);
            if (!text || text.length < 100) {
                console.warn(`[skip]  ${url} — no extractable content`);
                continue;
            }
            const chunks = Chunker.splitText(text, CHUNK_OPTIONS);
            console.log(`[url]   ${url} — ${chunks.length} chunks`);
            chunks.forEach(chunk => candidates.push({ content: chunk, metadata: { source: url } }));
        } catch (err) {
            console.error(`[error] ${url} — ${err.message}`);
        }
    }

    return candidates;
}

async function embedWithBackoff(model, text, attempt = 0) {
    try {
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (err) {
        const isRateLimited = err.message && (err.message.includes('429') || err.message.includes('quota'));
        if (isRateLimited && attempt < MAX_BACKOFF_ATTEMPTS) {
            const delay = 10000 * Math.pow(2, attempt);
            console.warn(`[429]   backing off ${delay / 1000}s (attempt ${attempt + 1}/${MAX_BACKOFF_ATTEMPTS})`);
            await sleep(delay);
            return embedWithBackoff(model, text, attempt + 1);
        }
        throw err;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const corpus = loadCorpus();
    console.log(`Corpus: ${corpus.length} existing documents`);

    const candidates = await collectCandidates(args);

    const fresh = dedupe(corpus, candidates);
    const selected = fresh.slice(0, args.limit);
    console.log(
        `Candidates: ${candidates.length} | new after dedupe: ${fresh.length} | selected: ${selected.length}`
    );

    if (args.dryRun) {
        console.log('\n--dry-run: no embeddings requested, no files written.');
        return;
    }

    if (selected.length === 0) {
        console.log('Nothing new to ingest.');
        return;
    }

    // Required only for a real run, so --dry-run works without an API key configured.
    const { embeddingModel } = require('../src/config/gemini');

    let id = nextId(corpus);
    const added = [];

    for (const [index, candidate] of selected.entries()) {
        const embedding = await embedWithBackoff(embeddingModel, candidate.content);
        added.push(buildRecord(id++, candidate, embedding));
        console.log(`[embed] ${index + 1}/${selected.length}`);
        await sleep(EMBED_DELAY_MS);
    }

    saveCorpus(corpus.concat(added));
    console.log(`\nAdded ${added.length} documents. Corpus is now ${corpus.length + added.length}.`);
    console.log('Commit src/data/documents.json to deploy the updated corpus.');
}

// Only run when invoked directly, so the helpers above can be unit tested.
if (require.main === module) {
    main().catch(err => {
        console.error(`\nIngestion failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    specToTexts,
    extractText,
    dedupe,
    buildRecord,
    nextId,
    loadCorpus,
    saveCorpus,
    STRIPE_DOC_URLS,
};
