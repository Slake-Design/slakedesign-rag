const { supabase } = require('../config/supabase');

/**
 * Document Repository
 * Isolates all database operations on the `documents` table from routes and services.
 */
class DocumentRepository {
    /**
     * Finds documents using similarity search via postgres RPC
     * @param {number[]} queryEmbedding - The embedding vector of the query
     * @param {number} matchThreshold - Cosine similarity threshold
     * @param {number} matchCount - Maximum number of matches to return
     * @returns {Promise<object[]>} The array of matching documents
     */
    async matchDocuments(queryEmbedding, matchThreshold, matchCount) {
        const { data, error } = await supabase.rpc('match_documents', {
            query_embedding: queryEmbedding,
            match_threshold: matchThreshold,
            match_count: matchCount,
        });

        if (error) {
            throw error;
        }

        return data || [];
    }

    /**
     * Inserts a single document chunk
     * @param {object} doc - Document object containing { content, embedding, metadata, doc_type, url }
     * @returns {Promise<object>} The inserted document data
     */
    async insertDocument(doc) {
        const { data, error } = await supabase
            .from('documents')
            .insert({
                content: doc.content,
                embedding: doc.embedding,
                metadata: doc.metadata || {},
                doc_type: doc.doc_type || null,
                url: doc.url || null
            })
            .select();

        if (error) {
            throw error;
        }

        return data;
    }

    /**
     * Inserts a batch of document chunks
     * @param {object[]} docs - Array of document objects
     * @returns {Promise<object[]>} The inserted documents data
     */
    async insertDocumentsBatch(docs) {
        const payload = docs.map(doc => ({
            content: doc.content,
            embedding: doc.embedding,
            metadata: doc.metadata || {},
            doc_type: doc.doc_type || null,
            url: doc.url || null
        }));

        const { data, error } = await supabase
            .from('documents')
            .insert(payload)
            .select();

        if (error) {
            throw error;
        }

        return data;
    }
}

module.exports = new DocumentRepository();
