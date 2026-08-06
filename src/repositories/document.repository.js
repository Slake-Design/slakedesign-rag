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
class DocumentRepository {
    constructor() {
        this.documents = null;
        this.loadDocuments();
    }

    loadDocuments() {
        if (this.documents) return;
        try {
            const dataPath = path.join(__dirname, '../data/documents.json');
            if (fs.existsSync(dataPath)) {
                const raw = fs.readFileSync(dataPath, 'utf8');
                const parsed = JSON.parse(raw);
                this.documents = parsed.map(doc => ({
                    id: doc.id,
                    content: doc.content,
                    metadata: doc.metadata || {},
                    embedding: typeof doc.embedding === 'string' ? JSON.parse(doc.embedding) : doc.embedding
                }));
                console.log(`[DocumentRepository] Loaded ${this.documents.length} in-memory documents for zero-downtime vector search.`);
            } else {
                console.warn('[DocumentRepository] documents.json not found, fallback to empty set.');
                this.documents = [];
            }
        } catch (err) {
            console.error('[DocumentRepository Error] Failed to load documents.json:', err);
            this.documents = [];
        }
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
