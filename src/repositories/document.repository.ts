import path from 'path';
import fs from 'fs';
import { logger } from '../logging/logger.js';
import { MATCH_THRESHOLD, MATCH_COUNT } from '../config/limits.js';

/** A corpus document with its precomputed embedding vector. */
export interface CorpusDocument {
    id: string | number;
    content: string;
    metadata: Record<string, unknown>;
    embedding: number[];
}

/** A retrieval hit: a corpus document plus its cosine score for this query. */
export interface RetrievedChunk {
    id: string | number;
    content: string;
    metadata: Record<string, unknown>;
    similarity: number;
}

/** The retrieval contract the RAG service depends on. */
export interface IDocumentRepository {
    matchDocuments(
        queryEmbedding: number[],
        matchThreshold?: number,
        matchCount?: number
    ): Promise<RetrievedChunk[]>;
}

/**
 * Calculates cosine similarity between two 1D vectors
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(vecA.length, vecB.length);
    for (let i = 0; i < len; i++) {
        // noUncheckedIndexedAccess: both indices are bounded by len above, so
        // the ?? 0 is unreachable at runtime and exists to satisfy the checker
        // without widening the element type to number | undefined.
        const a = vecA[i] ?? 0;
        const b = vecB[i] ?? 0;
        dotProduct += a * b;
        normA += a * a;
        normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Document Repository
 * Performs zero-downtime, in-memory vector similarity search over local document embeddings.
 * Eliminates external database dependencies and 7-day auto-pausing.
 */
/**
 * Corpus location.
 *
 * Resolved from the working directory, NOT from __dirname. Under tsx __dirname
 * is src/repositories; in the compiled build it is dist/src/repositories, and a
 * __dirname-relative path therefore pointed at dist/src/data, which does not
 * exist. The compiled service refused to boot - correctly, because the
 * fail-closed check below caught it, but it would have been a broken deploy.
 *
 * Copying the 25 MB corpus into dist on every build was the alternative and is
 * worse: it duplicates the largest thing in the repository to work around a
 * path. Every entry point (npm start, dev, test, ingest, evaluate) runs from
 * the package root, and CORPUS_PATH overrides it for anything that does not.
 */
const DEFAULT_DATA_PATH = process.env.CORPUS_PATH
    ? path.resolve(process.env.CORPUS_PATH)
    : path.resolve(process.cwd(), 'src', 'data', 'documents.json');

export class DocumentRepository implements IDocumentRepository {
    private readonly dataPath: string;
    private documents: CorpusDocument[] | null;
    private dimensions = 0;

    /**
     * @param {string} [dataPath] - Corpus location. Overridable so the failure paths are testable.
     */
    constructor(dataPath: string = DEFAULT_DATA_PATH) {
        this.dataPath = dataPath;
        this.documents = null;
        this.loadDocuments();
    }

    /**
     * Loads the corpus, or throws.
     *
     * A missing or unreadable corpus used to fall back to an empty array. The service
     * then booted healthy, /health returned ok, and every query retrieved nothing --
     * a total loss of function reported as success. Failing here instead kills the
     * process before app.listen, which turns a bad corpus into a failed deploy.
     */
    loadDocuments(): void {
        if (this.documents) return;

        if (!fs.existsSync(this.dataPath)) {
            throw new Error(`[DocumentRepository] Corpus not found at ${this.dataPath}. Refusing to start.`);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
        } catch (err) {
            throw new Error(
                `[DocumentRepository] Corpus at ${this.dataPath} is not readable JSON: ` +
                (err instanceof Error ? err.message : String(err))
            );
        }

        if (!Array.isArray(parsed)) {
            throw new Error(`[DocumentRepository] Corpus at ${this.dataPath} must be a JSON array.`);
        }

        const documents: CorpusDocument[] = (parsed as CorpusDocument[]).map((doc) => ({
            id: doc.id,
            content: doc.content,
            metadata: doc.metadata || {},
            embedding: typeof doc.embedding === 'string' ? JSON.parse(doc.embedding) : doc.embedding
        }));

        if (documents.length === 0) {
            throw new Error(`[DocumentRepository] Corpus at ${this.dataPath} is empty. Refusing to start: every query would retrieve nothing.`);
        }

        this.dimensions = this.loadDimensions(documents);
        this.documents = documents;
        logger.info(
            { documentCount: this.documents.length, dimensions: this.dimensions },
            'Corpus loaded for in-memory vector search'
        );
    }

    /**
     * Reconciles the recorded corpus dimension with the corpus itself.
     *
     * Document vectors are frozen in the committed corpus while query vectors come from
     * whatever GEMINI_EMBEDDING_MODEL currently names. Nothing recorded which model built
     * the corpus, and cosineSimilarity truncates to the shorter vector, so a model swap
     * degraded every score silently. Dimension is the value that can actually be checked,
     * and a model swap almost always changes it.
     */
    private loadDimensions(documents: CorpusDocument[]): number {
        const metaPath = path.join(path.dirname(this.dataPath), 'corpus.meta.json');
        if (!fs.existsSync(metaPath)) {
            throw new Error(`[DocumentRepository] Corpus metadata not found at ${metaPath}. Refusing to start: the corpus dimension would be unverifiable.`);
        }

        let meta: { dimensions?: unknown };
        try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch (err) {
            throw new Error(
                `[DocumentRepository] Corpus metadata at ${metaPath} is not readable JSON: ` +
                (err instanceof Error ? err.message : String(err))
            );
        }

        // Narrowed once, here, rather than asserted at the return: the metadata
        // is untrusted JSON from disk and this is the only place its shape is
        // established.
        const declaredDimensions = meta.dimensions;
        if (typeof declaredDimensions !== 'number' || !Number.isInteger(declaredDimensions) || declaredDimensions <= 0) {
            throw new Error(`[DocumentRepository] Corpus metadata at ${metaPath} must declare a positive integer "dimensions".`);
        }

        const sample = documents.find(doc => Array.isArray(doc.embedding));
        if (!sample) {
            throw new Error(`[DocumentRepository] Corpus at ${this.dataPath} contains no usable embedding vector.`);
        }

        if (sample.embedding.length !== declaredDimensions) {
            throw new Error(
                `[DocumentRepository] Corpus dimension mismatch: metadata declares ${declaredDimensions}, ` +
                `corpus vectors are ${sample.embedding.length}-d. The corpus and its metadata disagree.`
            );
        }

        return declaredDimensions;
    }

    /**
     * Finds documents using cosine similarity search over in-memory vectors
     * @param {number[]} queryEmbedding - The embedding vector of the query
     * @param {number} matchThreshold - Cosine similarity threshold
     * @param {number} matchCount - Maximum number of matches to return
     * @returns {Promise<object[]>} Array of matching document objects
     */
    async matchDocuments(
        queryEmbedding: number[],
        matchThreshold = MATCH_THRESHOLD,
        matchCount = MATCH_COUNT
    ): Promise<RetrievedChunk[]> {
        this.loadDocuments();

        // The drift check that matters: a query vector of a different width means the
        // query model no longer matches the corpus model. cosineSimilarity would
        // truncate to the shorter vector and return plausible-looking nonsense.
        if (!Array.isArray(queryEmbedding) || queryEmbedding.length !== this.dimensions) {
            throw new Error(
                `[DocumentRepository] Query embedding is ${Array.isArray(queryEmbedding) ? queryEmbedding.length : 'not a vector'}, ` +
                `corpus is ${this.dimensions}-d. The query embedding model does not match the corpus.`
            );
        }

        if (!this.documents || this.documents.length === 0) {
            return [];
        }

        const results: RetrievedChunk[] = [];
        for (const doc of this.documents) {
            if (!doc.embedding || !Array.isArray(doc.embedding)) continue;
            const similarity = cosineSimilarity(queryEmbedding, doc.embedding);
            if (similarity >= matchThreshold) {
                results.push({
                    id: doc.id,
                    content: doc.content,
                    metadata: doc.metadata,
                    similarity: similarity
                });
            }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, matchCount);
    }
}

/** Singleton used by the running service; the class is exported for tests. */
export const documentRepository = new DocumentRepository();
export default documentRepository;
