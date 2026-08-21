import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { DocumentRepository } = require('../src/repositories/document.repository');

/**
 * Two failure modes that used to be silent:
 *
 * 1. A missing or unreadable corpus fell back to an empty array, so the service booted
 *    healthy and every query retrieved nothing.
 * 2. Nothing recorded which embedding model built the corpus, and cosineSimilarity
 *    truncates to the shorter vector, so a model swap degraded every score invisibly.
 *
 * Both are now loud: the first at construction, the second at construction or on the
 * first query with a mismatched vector.
 */
describe('DocumentRepository corpus loading', () => {
    let dir;
    let file;

    const writeCorpus = (docs) => fs.writeFileSync(file, JSON.stringify(docs));
    const writeMeta = (meta) =>
        fs.writeFileSync(path.join(dir, 'corpus.meta.json'), JSON.stringify(meta));

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));
        file = path.join(dir, 'documents.json');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('throws when the corpus file is missing', () => {
        expect(() => new DocumentRepository(file)).toThrow(/Corpus not found/);
    });

    it('throws when the corpus is not readable JSON', () => {
        fs.writeFileSync(file, '{ this is not json');
        expect(() => new DocumentRepository(file)).toThrow(/not readable JSON/);
    });

    it('throws when the corpus is not a JSON array', () => {
        fs.writeFileSync(file, JSON.stringify({ documents: [] }));
        expect(() => new DocumentRepository(file)).toThrow(/must be a JSON array/);
    });

    it('throws when the corpus is empty rather than serving nothing', () => {
        writeCorpus([]);
        expect(() => new DocumentRepository(file)).toThrow(/is empty/);
    });

    it('throws when the corpus metadata is missing', () => {
        writeCorpus([{ id: 1, content: 'a', embedding: '[0.1,0.2]', metadata: {} }]);
        expect(() => new DocumentRepository(file)).toThrow(/metadata not found/);
    });

    it('throws when metadata declares a dimension the corpus does not have', () => {
        writeCorpus([{ id: 1, content: 'a', embedding: '[0.1,0.2]', metadata: {} }]);
        writeMeta({ dimensions: 3072 });
        expect(() => new DocumentRepository(file)).toThrow(/dimension mismatch/);
    });

    it('throws when metadata declares no usable dimension', () => {
        writeCorpus([{ id: 1, content: 'a', embedding: '[0.1,0.2]', metadata: {} }]);
        writeMeta({ dimensions: 'wide' });
        expect(() => new DocumentRepository(file)).toThrow(/positive integer "dimensions"/);
    });

    it('loads a valid corpus, parses string embeddings, and records the dimension', () => {
        writeCorpus([{ id: 1, content: 'a', embedding: '[0.1,0.2]', metadata: { source: 'docs' } }]);
        writeMeta({ dimensions: 2 });

        const repo = new DocumentRepository(file);

        expect(repo.documents).toHaveLength(1);
        expect(repo.documents[0].embedding).toEqual([0.1, 0.2]);
        expect(repo.dimensions).toBe(2);
    });
});

describe('DocumentRepository embedding-model drift', () => {
    let dir;
    let repo;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-drift-'));
        const file = path.join(dir, 'documents.json');
        fs.writeFileSync(file, JSON.stringify([
            { id: 1, content: 'a', embedding: '[1,0,0]', metadata: {} }
        ]));
        fs.writeFileSync(path.join(dir, 'corpus.meta.json'), JSON.stringify({ dimensions: 3 }));
        repo = new DocumentRepository(file);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a query vector whose width does not match the corpus', async () => {
        // A different embedding model produces a different width. Previously this
        // truncated to the shorter vector and returned a plausible-looking score.
        await expect(repo.matchDocuments([1, 0], 0.1, 6))
            .rejects.toThrow(/does not match the corpus/);
    });

    it('rejects a query that is not a vector at all', async () => {
        await expect(repo.matchDocuments(null, 0.1, 6))
            .rejects.toThrow(/not a vector/);
    });

    it('still searches normally when the widths agree', async () => {
        const results = await repo.matchDocuments([1, 0, 0], 0.5, 6);

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe(1);
        expect(results[0].similarity).toBeCloseTo(1, 5);
    });
});
