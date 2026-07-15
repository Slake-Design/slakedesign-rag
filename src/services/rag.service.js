const defaultRepository = require('../repositories/document.repository');
const defaultGemini = require('../config/gemini');

// Configuration constants
const MATCH_THRESHOLD = 0.48;
const MATCH_COUNT = 6;
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS) || 3000;

// ====================== UTILS ======================
const withTimeout = (promise, ms, label) =>
    Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms))
    ]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function generateWithRetry(chatModel, prompt, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await withTimeout(
                chatModel.generateContentStream(prompt),
                14000,
                `LLM attempt ${attempt}`
            );
        } catch (err) {
            const is429 = err.message?.includes('429') || err.status === 429;
            if (is429 && attempt < maxRetries) {
                await sleep(attempt * 2400);
                continue;
            }
            throw err;
        }
    }
}

/**
 * RAG Orchestrator Service
 * Handles query embedding, similarity search retrieval, token-aware context budgeting,
 * prompt formatting, and LLM text generation/streaming.
 * 
 * Supports Dependency Injection (DI) for clean mock testing without cache hacking.
 */
class RagService {
    /**
     * Initializes RagService with repositories and model configurations.
     * @param {object} [documentRepository] - DB query interface.
     * @param {object} [geminiModels] - Initialized Gemini chat and embedding models.
     */
    constructor(documentRepository = defaultRepository, geminiModels = defaultGemini) {
        this.documentRepository = documentRepository;
        this.chatModel = geminiModels.chatModel;
        this.embeddingModel = geminiModels.embeddingModel;
    }

    /**
     * Executes the full RAG pipeline: retrieves matches, manages budget, prompts LLM, and streams response.
     * @param {string} question - Natural language developer query.
     * @param {object} callbacks - Callback listeners.
     * @param {function} callbacks.onChunk - Triggers when new text tokens stream back: ({ text }) => {}
     * @param {function} callbacks.onSources - Triggers at completion with cited sources: (sources) => {}
     * @returns {Promise<void>}
     */
    async generateAnswer(question, callbacks = {}) {
        const { onChunk, onSources } = callbacks;
        const start = Date.now();

        // 1. Embedding creation
        const embedRes = await withTimeout(
            this.embeddingModel.embedContent(question.trim()),
            6000,
            'Embedding'
        );

        // 2. Vector Search Retrieval
        const matches = await withTimeout(
            this.documentRepository.matchDocuments(
                embedRes.embedding.values,
                MATCH_THRESHOLD,
                MATCH_COUNT
            ),
            7500,
            'Vector search'
        );

        const safeMatches = (matches || [])
            .filter(m => m.similarity >= MATCH_THRESHOLD)
            .sort((a, b) => b.similarity - a.similarity);

        // 3. Token-Aware Context Management
        const promptHeader = `Use the following retrieved context documents to answer the developer question.

Retrieved Context:
`;

        const promptFooter = `
Developer Question: ${question}

Answer:
`;

        // Estimate base prompt tokens
        let baseTokens = 150;
        try {
            const baseCount = await this.chatModel.countTokens(promptHeader + promptFooter);
            baseTokens = baseCount.totalTokens;
        } catch (e) {
            console.warn('[RAG] Failed to count base prompt tokens, using fallback:', e.message);
        }

        const remainingBudget = Math.max(0, MAX_CONTEXT_TOKENS - baseTokens);

        // Map and format chunks with explicit source and category details
        const chunkTexts = safeMatches.map((m, i) => {
            const source = m.metadata?.source || m.metadata?.path || m.url || 'Stripe Documentation Reference';
            const category = m.metadata?.source === 'stripe-api' ? 'API Reference Endpoint' : 'Developer Guide';
            const details = m.metadata?.method && m.metadata?.path ? ` (${m.metadata.method} ${m.metadata.path})` : '';
            return `[Document ${i + 1}] Source: ${source}${details} | Category: ${category}\nContent:\n${m.content}\n\n---\n\n`;
        });

        // Parallel token counts
        const chunkTokens = await Promise.all(
            chunkTexts.map(async (txt) => {
                try {
                    const count = await this.chatModel.countTokens(txt);
                    return count.totalTokens;
                } catch (e) {
                    return Math.ceil(txt.length / 4); // Fallback estimation
                }
            })
        );

        // Filter and fit chunks into context budget
        let includedChunks = [];
        let accumulatedContextTokens = 0;
        let formattedContext = '';

        for (let i = 0; i < safeMatches.length; i++) {
            const tokens = chunkTokens[i];
            if (accumulatedContextTokens + tokens <= remainingBudget) {
                includedChunks.push(safeMatches[i]);
                accumulatedContextTokens += tokens;
                formattedContext += chunkTexts[i];
            } else {
                console.log(`[RAG Context Pruning] Chunk ${i + 1} pruned. Chunk size (${tokens} tokens) exceeds remaining budget (${remainingBudget - accumulatedContextTokens} tokens).`);
            }
        }

        const context = formattedContext.trim();
        const totalEstimatedPromptTokens = baseTokens + accumulatedContextTokens;
        const prompt = `${promptHeader}${context || '[No relevant documents found]'}${promptFooter}`;

        // 4. Gemini Stream Generation
        const result = await generateWithRetry(this.chatModel, prompt);

        let fullResponse = '';
        let isRefusal = false;

        for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) {
                fullResponse += text;
                if (onChunk) onChunk({ text });

                if (fullResponse.includes('I’m specialized in Stripe') &&
                    fullResponse.includes('don’t have information on that topic')) {
                    isRefusal = true;
                }
            }
        }

        // Send sources ONLY for IN-DOMAIN responses
        if (!isRefusal && includedChunks.length > 0) {
            const sources = includedChunks.map(m => ({
                id: m.id,
                similarity: Number(m.similarity.toFixed(4)),
                metadata: m.metadata || {}
            }));
            if (onSources) onSources(sources);
        }

        console.log(`[RAG] Completed in ${Date.now() - start}ms | Retrieved Chunks: ${safeMatches.length} | Included Chunks: ${includedChunks.length} | Estimated Prompt Tokens: ${totalEstimatedPromptTokens} | Refusal: ${isRefusal}`);
    }
}

// Singleton export for production API routing
const ragServiceInstance = new RagService();

module.exports = {
    RagService,
    ragServiceInstance
};
