const defaultRepository = require('../repositories/document.repository');
const defaultGemini = require('../config/gemini');
const { REFUSAL_TEXT, NO_CONTEXT_TEXT } = defaultGemini;

// Configuration constants
const MATCH_THRESHOLD = 0.48;
const MATCH_COUNT = 6;
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS) || 3000;

// ====================== REFUSAL DETECTION ======================
/**
 * Normalises only what this check needs: case, apostrophe style, and whitespace.
 */
const normaliseForRefusal = (text) => String(text ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Two distinctive fragments derived from the canonical wording, so the check
 * stays in step with REFUSAL_TEXT instead of repeating it. Boundary punctuation
 * is trimmed from each fragment, which only widens what matches.
 */
const REFUSAL_WORDS = normaliseForRefusal(REFUSAL_TEXT).split(' ');
const trimEdgePunctuation = (value) => value.replace(/^[.,;:]+|[.,;:]+$/g, '');
const REFUSAL_FRAGMENTS = [
    trimEdgePunctuation(REFUSAL_WORDS.slice(0, 4).join(' ')),
    trimEdgePunctuation(REFUSAL_WORDS.slice(-5).join(' '))
];

/**
 * Detects the out-of-domain refusal defined in the system prompt.
 *
 * An exact match on REFUSAL_TEXT failed as soon as the model emitted a straight
 * apostrophe. That is not cosmetic: sources are attached only when the answer is
 * NOT a refusal, so a missed refusal ships citations beside "I don't have
 * information on that topic". Both fragments are required, so an answer that
 * merely mentions Stripe is not classified as a refusal.
 */
function isDomainRefusal(text) {
    const normalised = normaliseForRefusal(text);
    if (!normalised) return false;
    return REFUSAL_FRAGMENTS.every((fragment) => normalised.includes(fragment));
}

// ====================== UTILS ======================
// The timer is cleared on both settle paths so a completed call leaves no
// pending handle behind.
const withTimeout = (promise, ms, label) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
        })
    ]).finally(() => clearTimeout(timer));
};

// Resolves early if the signal aborts, so a cancelled request does not sit out
// the remainder of a retry backoff.
const sleep = (ms, signal) => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
    }, { once: true });
});

async function generateWithRetry(chatModel, prompt, signal, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await withTimeout(
                chatModel.generateContentStream(prompt, { signal }),
                14000,
                `LLM attempt ${attempt}`
            );
        } catch (err) {
            if (signal?.aborted) throw err;
            const is429 = err.message?.includes('429') || err.status === 429;
            if (is429 && attempt < maxRetries) {
                await sleep(attempt * 2400, signal);
                // The wait ended because the caller aborted; start no new attempt.
                if (signal?.aborted) throw err;
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
        const { onChunk, onSources, signal } = callbacks;
        const start = Date.now();

        // 1. Embedding creation
        const embedRes = await withTimeout(
            this.embeddingModel.embedContent(question.trim(), { signal }),
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
            const baseCount = await this.chatModel.countTokens(promptHeader + promptFooter, { signal });
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
                    const count = await this.chatModel.countTokens(txt, { signal });
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

        // ================= GROUNDING GATE =================
        // Nothing survived retrieval, or everything retrieved was pruned by the
        // token budget. Either way there is no grounding, and the model must not
        // be called.
        //
        // This path used to fall through to the model with a
        // "[No relevant documents found]" placeholder in the prompt. That was a
        // correctness bug, not a cosmetic one: the system prompt instructs the
        // model that it MUST emit the full four-section structure for any
        // in-domain question, so a payments question with zero retrieval
        // produced a confident, fully-structured answer built entirely from
        // model priors. Sources are suppressed when includedChunks is empty, so
        // that answer also carried no citations - leaving an ungrounded answer
        // visually identical to a grounded one.
        //
        // Returning here is what makes the README's grounding claim true.
        if (includedChunks.length === 0) {
            if (!signal?.aborted && onChunk) onChunk({ text: NO_CONTEXT_TEXT });
            console.log(
                `[RAG] Refused ungrounded answer in ${Date.now() - start}ms | ` +
                `Retrieved Chunks: ${safeMatches.length} | Included Chunks: 0 | ` +
                `Threshold: ${MATCH_THRESHOLD} | ` +
                `Cause: ${safeMatches.length === 0 ? 'nothing above threshold' : 'all matches pruned by token budget'}`
            );
            return;
        }

        const prompt = `${promptHeader}${context}${promptFooter}`;

        // 4. Gemini Stream Generation
        const result = await generateWithRetry(this.chatModel, prompt, signal);

        let fullResponse = '';
        let isRefusal = false;

        for await (const chunk of result.stream) {
            if (signal?.aborted) break;
            const text = chunk.text();
            if (text) {
                fullResponse += text;
                if (onChunk) onChunk({ text });

                if (isDomainRefusal(fullResponse)) {
                    isRefusal = true;
                }
            }
        }

        // The caller is gone: emit no sources and claim no completion.
        if (signal?.aborted) return;

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
    ragServiceInstance,
    isDomainRefusal
};
