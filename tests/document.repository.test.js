import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { DocumentRepository } = require('../src/repositories/document.repository');

/**
 * The corpus load used to fall back to an empty array on any failure. The service
 * then booted healthy and every query retrieved nothing -- a total loss of function
 * reported as success. These assert the failure is now loud and happens at construction,
 * which is what kills the process before app.listen.
 */
describe('DocumentRepository corpus loading', () => {
    let dir;
    let file;

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
        fs.writeFileSync(file, JSON.stringify([]));
        expect(() => new DocumentRepository(file)).toThrow(/is empty/);
    });

    it('loads a valid corpus and parses string-encoded embeddings', () => {
        fs.writeFileSync(file, JSON.stringify([
            { id: 1, content: 'a', embedding: '[0.1,0.2]', metadata: { source: 'docs' } }
        ]));

        const repo = new DocumentRepository(file);

        expect(repo.documents).toHaveLength(1);
        expect(repo.documents[0].embedding).toEqual([0.1, 0.2]);
    });
});
