import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
    parseArgs,
    specToTexts,
    dedupe,
    buildRecord,
    nextId,
    loadCorpus,
    saveCorpus,
    saveMeta,
    STRIPE_DOC_URLS,
} = require('../scripts/ingest');

describe('ingest: argument parsing', () => {
    it('refuses to run with no source selected', () => {
        expect(() => parseArgs([])).toThrow(/Nothing to do/);
    });

    it('rejects unknown arguments rather than silently ignoring them', () => {
        expect(() => parseArgs(['--wipe'])).toThrow(/Unknown argument/);
    });

    it('defaults --urls to the built-in Stripe doc list', () => {
        expect(parseArgs(['--urls']).urls).toEqual(STRIPE_DOC_URLS);
    });

    it('accepts an explicit comma-separated url list', () => {
        expect(parseArgs(['--urls', 'https://a.test,https://b.test']).urls)
            .toEqual(['https://a.test', 'https://b.test']);
    });

    it('rejects a non-positive --limit', () => {
        expect(() => parseArgs(['--spec', '--limit', '0'])).toThrow(/positive number/);
    });
});

describe('ingest: dedupe', () => {
    const corpus = [{ id: 1, content: 'already stored' }];

    it('drops candidates already present in the corpus', () => {
        const fresh = dedupe(corpus, [{ content: 'already stored' }, { content: 'brand new' }]);
        expect(fresh).toHaveLength(1);
        expect(fresh[0].content).toBe('brand new');
    });

    it('collapses duplicates within a single run', () => {
        const fresh = dedupe(corpus, [{ content: 'dup' }, { content: 'dup' }]);
        expect(fresh).toHaveLength(1);
    });

    it('is idempotent: re-running the same source adds nothing', () => {
        const candidates = [{ content: 'a' }, { content: 'b' }];
        const firstPass = dedupe(corpus, candidates);
        const stored = corpus.concat(firstPass.map((c, i) => ({ id: i + 2, content: c.content })));
        expect(dedupe(stored, candidates)).toHaveLength(0);
    });
});

describe('ingest: record construction', () => {
    it('continues ids from the existing corpus high-water mark', () => {
        expect(nextId([{ id: 1 }, { id: 650 }, { id: 4 }])).toBe(651);
    });

    it('starts at 1 for an empty corpus', () => {
        expect(nextId([])).toBe(1);
    });

    it('stores the embedding as a JSON string, matching existing records', () => {
        const rec = buildRecord(7, { content: 'x', metadata: { source: 'stripe-api' } }, [0.1, 0.2]);
        expect(typeof rec.embedding).toBe('string');
        expect(JSON.parse(rec.embedding)).toEqual([0.1, 0.2]);
    });

    it('preserves the metadata shape citations depend on', () => {
        const rec = buildRecord(1, {
            content: 'x',
            metadata: { source: 'stripe-api', path: '/v1/charges', method: 'GET' },
        }, [0]);
        expect(rec.metadata).toEqual({ source: 'stripe-api', path: '/v1/charges', method: 'GET' });
    });

    it('sets url only for http sources', () => {
        expect(buildRecord(1, { content: 'x', metadata: { source: 'https://d.test' } }, [0]).url)
            .toBe('https://d.test');
        expect(buildRecord(2, { content: 'y', metadata: { source: 'stripe-api' } }, [0]).url)
            .toBeNull();
    });
});

describe('ingest: spec flattening', () => {
    it('skips operations too short to be useful', () => {
        const texts = specToTexts({ paths: { '/a': { get: { summary: 'hi' } } } });
        expect(texts).toHaveLength(0);
    });

    it('emits one record per operation with method and path metadata', () => {
        const texts = specToTexts({
            paths: {
                '/v1/charges': {
                    get: { summary: 'List charges', description: 'x'.repeat(60) },
                },
            },
        });
        expect(texts).toHaveLength(1);
        expect(texts[0].metadata).toEqual({
            source: 'stripe-api', path: '/v1/charges', method: 'GET',
        });
        expect(texts[0].content).toContain('GET /v1/charges');
    });
});

describe('ingest: corpus persistence', () => {
    let dir;
    let file;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
        file = path.join(dir, 'documents.json');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('round-trips a corpus through save and load', () => {
        const docs = [{ id: 1, content: 'a', embedding: '[0.1]', metadata: {} }];
        saveCorpus(docs, file);
        expect(loadCorpus(file)).toEqual(docs);
    });

    it('returns an empty corpus when the file does not exist', () => {
        expect(loadCorpus(path.join(dir, 'missing.json'))).toEqual([]);
    });

    it('refuses to load a file that is not a JSON array', () => {
        fs.writeFileSync(file, JSON.stringify({ not: 'an array' }));
        expect(() => loadCorpus(file)).toThrow(/not a JSON array/);
    });

    it('records the embedding model and dimension alongside the corpus', () => {
        const docs = [{ id: 1, content: 'a', embedding: '[0.1,0.2,0.3]', metadata: {} }];
        saveCorpus(docs, file);
        const meta = saveMeta(docs, 'models/test-embedding-9', file);

        const written = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.meta.json'), 'utf8'));
        expect(written.dimensions).toBe(3);
        expect(written.documentCount).toBe(1);
        expect(written.embeddingModel).toBe('models/test-embedding-9');
        expect(written.embeddingModelVerified).toBe(true);
        expect(meta.dimensions).toBe(3);
    });

    it('refuses to record metadata for a corpus with no usable vector', () => {
        expect(() => saveMeta([{ id: 1, content: 'a', metadata: {} }], 'm', file))
            .toThrow(/no usable embedding vector/);
    });

    it('leaves no temp file behind after an atomic write', () => {
        saveCorpus([{ id: 1, content: 'a' }], file);
        expect(fs.existsSync(`${file}.tmp`)).toBe(false);
        expect(fs.readdirSync(dir)).toEqual(['documents.json']);
    });

    // The failure this whole design guards against: an append that drops or rewrites
    // existing records would silently destroy a corpus that cannot be regenerated.
    it('append preserves every existing record byte-for-byte', () => {
        const existing = [
            { id: 1, content: 'keep me', embedding: '[0.1]', metadata: { source: 'stripe-api' } },
            { id: 2, content: 'keep me too', embedding: '[0.2]', metadata: { source: 'https://d.test' } },
        ];
        saveCorpus(existing, file);

        const corpus = loadCorpus(file);
        const fresh = dedupe(corpus, [{ content: 'keep me' }, { content: 'new one' }]);
        const added = fresh.map((c, i) => buildRecord(nextId(corpus) + i, { ...c, metadata: {} }, [0.9]));
        saveCorpus(corpus.concat(added), file);

        const result = loadCorpus(file);
        expect(result).toHaveLength(3);
        expect(result.slice(0, 2)).toEqual(existing);
        expect(result[2].id).toBe(3);
        expect(result[2].content).toBe('new one');
    });
});
