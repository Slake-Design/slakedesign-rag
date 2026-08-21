const path = require('path');
const fs = require('fs');

/**
 * Calculates cosine similarity between two 1D vectors
 */
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(vecA.length, vecB.length);
    for (let i = 0; i < len; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Document Repository
 * Performs zero-downtime, in-memory vector similarity search over local document embeddings.
 * Eliminates external database dependencies and 7-day auto-pausing.
 */
const DEFAULT_DATA_PATH = path.join(__dirname, '../data/documents.json');

class DocumentRepository {
    /**
     * @param {string} [dataPath] - Corpus location. Overridable so the failure paths are testable.
     */
    constructor(dataPath = DEFAULT_DATA_PATH) {
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
    loadDocuments() {
        if (this.documents) return;

        if (!fs.existsSync(this.dataPath)) {
            throw new Error(`[DocumentRepository] Corpus not found at ${this.dataPath}. Refusing to start.`);
        }

        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
        } catch (err) {
            throw new Error(`[DocumentRepository] Corpus at ${this.dataPath} is not readable JSON: ${err.message}`);
        }

        if (!Array.isArray(parsed)) {
            throw new Error(`[DocumentRepository] Corpus at ${this.dataPath} must be a JSON array.`);
        }

        const documents = parsed.map(doc => ({
            id: doc.id,
            content: doc.content,
            metadata: doc.metadata || {},
            embedding: typeof doc.embedding === 'string' ? JSON.parse(doc.embedding) : doc.embedding
        }));

        if (documents.length === 0) {
            throw new Error(`[DocumentRepository] Corpus at ${this.dataPath} is empty. Refusing to start: every query would retrieve nothing.`);
        }

        this.documents = documents;
        console.log(`[DocumentRepository] Loaded ${this.documents.length} in-memory documents for zero-downtime vector search.`);
    }

    /**
     * Finds documents using cosine similarity search over in-memory vectors
     * @param {number[]} queryEmbedding - The embedding vector of the query
     * @param {number} matchThreshold - Cosine similarity threshold
     * @param {number} matchCount - Maximum number of matches to return
     * @returns {Promise<object[]>} Array of matching document objects
     */
    async matchDocuments(queryEmbedding, matchThreshold = 0.45, matchCount = 6) {
        this.loadDocuments();
        
        if (!this.documents || this.documents.length === 0) {
            return [];
        }

        const results = [];
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

module.exports = new DocumentRepository();
module.exports.DocumentRepository = DocumentRepository;
