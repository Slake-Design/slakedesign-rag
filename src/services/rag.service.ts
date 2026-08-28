import defaultRepository from '../repositories/document.repository.js';
import type { IDocumentRepository, RetrievedChunk } from '../repositories/document.repository.js';
import * as defaultGemini from '../config/gemini.js';
import { logger } from '../logging/logger.js';

const { REFUSAL_TEXT, NO_CONTEXT_TEXT } = defaultGemini;

/** A citation returned to the client alongside a grounded answer. */
export interface Source {
    id: string | number;
    similarity: number;
    metadata: Record<string, unknown>;
}

/** Streaming callbacks supplied by the transport layer. */
export interface RagCallbacks {
    onChunk?: (chunk: { text: string }) => void;
    onSources?: (sources: Source[]) => void;
    signal?: AbortSignal;
}

/** The subset of the Gemini SDK this service actually uses. */
export interface GeminiModels {
    chatModel: {
        generateContentStream(prompt: string, opts?: { signal?: AbortSignal }): Promise<{
            stream: AsyncIterable<{ text(): string }>;
        }>;
        countTokens(text: string, opts?: { signal?: AbortSignal }): Promise<{ totalTokens: number }>;
    };
    embeddingModel: {
        embedContent(text: string, opts?: { signal?: AbortSignal }): Promise<{
            embedding: { values: number[] };
        }>;
    };
}

// Retrieval thresholds live in config/limits.ts so the service, the repository
// default and the evaluation harness cannot drift apart. See that file for the
// calibration measurement behind MATCH_THRESHOLD.
import { MATCH_THRESHOLD, MATCH_COUNT } from '../config/limits.js';
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS ?? '', 10) || 3000;

// ====================== REFUSAL DETECTION ======================
/**
 * Normalises only what this check needs: case, apostrophe style, and whitespace.
 */
const normaliseForRefusal = (text: unknown): string => String(text ?? '')
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
const trimEdgePunctuation = (value: string): string => value.replace(/^[.,;:]+|[.,;:]+$/g, '');
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
export function isDomainRefusal(text: unknown): boolean {
    const normalised = normaliseForRefusal(text);
    if (!normalised) return false;
    return REFUSAL_FRAGMENTS.every((fragment) => normalised.includes(fragment));
}

// ====================== UTILS ======================
// The timer is cleared on both settle paths so a completed call leaves no
// pending handle behind.
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
        })
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
};

// Resolves early if the signal aborts, so a cancelled request does not sit out
// the remainder of a retry backoff.
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
    }, { once: true });
});

async function generateWithRetry(
    chatModel: GeminiModels['chatModel'],
    prompt: string,
    signal?: AbortSignal,
    maxRetries = 4
): Promise<{ stream: AsyncIterable<{ text(): string }> }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await withTimeout(
                chatModel.generateContentStream(prompt, { signal }),
                14000,
                `LLM attempt ${attempt}`
            );
        } catch (err) {
            if (signal?.aborted) throw err;
            const e = err as { message?: string; status?: number };
            const is429 = e.message?.includes('429') || e.status === 429;
            if (is429 && attempt < maxRetries) {
                await sleep(attempt * 2400, signal);
                // The wait ended because the caller aborted; start no new attempt.
                if (signal?.aborted) throw err;
                continue;
            }
            throw err;
        }
    }
    // Unreachable: the loop either returns or throws on the final attempt.
    throw new Error('generateWithRetry exhausted every attempt without settling');
}

/**
 * RAG Orchestrator Service
 * Handles query embedding, similarity search retrieval, token-aware context budgeting,
 * prompt formatting, and LLM text generation/streaming.
 * 
 * Supports Dependency Injection (DI) for clean mock testing without cache hacking.
 */
export class RagService {
    private readonly documentRepository: IDocumentRepository;
    private readonly chatModel: GeminiModels['chatModel'];
    private readonly embeddingModel: GeminiModels['embeddingModel'];

    /**
     * Initializes RagService with repositories and model configurations.
     * @param {object} [documentRepository] - DB query interface.
     * @param {object} [geminiModels] - Initialized Gemini chat and embedding models.
     */
    constructor(
        documentRepository: IDocumentRepository = defaultRepository,
        geminiModels: GeminiModels = defaultGemini as unknown as GeminiModels
    ) {
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
    async generateAnswer(question: string, callbacks: RagCallbacks = {}): Promise<void> {
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

        const safeMatches: RetrievedChunk[] = (matches || [])
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
            logger.warn({ errMessage: e instanceof Error ? e.message : String(e), fallbackTokens: baseTokens }, 'Failed to count base prompt tokens; using fallback estimate');
        }

        const remainingBudget = Math.max(0, MAX_CONTEXT_TOKENS - baseTokens);

        // Map and format chunks with explicit source and category details
        const chunkTexts: string[] = safeMatches.map((m, i) => {
            // `m.url` used to be the third fallback here. The repository never
            // sets a `url` field on a match - it returns id, content, metadata
            // and similarity - so that branch was dead and the chain silently
            // fell through to the generic label. The type checker found it
            // during the TypeScript port; this is exactly the class of
            // shape-guessing bug a typed retrieval contract prevents.
            const source = m.metadata?.source || m.metadata?.path || 'Stripe Documentation Reference';
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
                } catch {
                    return Math.ceil(txt.length / 4); // Fallback estimation
                }
            })
        );

        // Filter and fit chunks into context budget
        const includedChunks: RetrievedChunk[] = [];
        let accumulatedContextTokens = 0;
        let formattedContext = '';

        // Iterating entries rather than an index keeps the element types
        // non-optional under noUncheckedIndexedAccess, instead of scattering
        // non-null assertions that would suppress a real out-of-bounds bug.
        for (const [i, match] of safeMatches.entries()) {
            const tokens = chunkTokens[i] ?? 0;
            const text = chunkTexts[i] ?? '';
            if (accumulatedContextTokens + tokens <= remainingBudget) {
                includedChunks.push(match);
                accumulatedContextTokens += tokens;
                formattedContext += text;
            } else {
                logger.debug(
                    { chunkIndex: i + 1, chunkTokens: tokens, remainingBudget: remainingBudget - accumulatedContextTokens },
                    'Chunk pruned: exceeds remaining context budget'
                );
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
            logger.info(
                {
                    outcome: 'refused_ungrounded',
                    durationMs: Date.now() - start,
                    retrievedChunks: safeMatches.length,
                    includedChunks: 0,
                    threshold: MATCH_THRESHOLD,
                    cause: safeMatches.length === 0
                        ? 'nothing_above_threshold'
                        : 'all_matches_pruned_by_token_budget',
                },
                'Refused ungrounded answer; model was not called'
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

        logger.info(
            {
                outcome: isRefusal ? 'out_of_domain_refusal' : 'answered',
                durationMs: Date.now() - start,
                retrievedChunks: safeMatches.length,
                includedChunks: includedChunks.length,
                estimatedPromptTokens: totalEstimatedPromptTokens,
                sourcesEmitted: !isRefusal && includedChunks.length > 0,
            },
            'RAG request completed'
        );
    }
}

// Singleton export for production API routing
export const ragServiceInstance = new RagService();


