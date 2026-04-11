require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ====================== CONFIG ======================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const chatModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp',
    generationConfig: {
        temperature: 0.0,        // Very deterministic
        topP: 0.95,
        maxOutputTokens: 12000,
    },
});

const embeddingModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004',
});

const MATCH_THRESHOLD = 0.48;
const MATCH_COUNT = 6;
const MAX_CONTEXT_CHARS = 8000;

// ====================== UTILS ======================
const withTimeout = (promise, ms, label) =>
    Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms))
    ]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function generateWithRetry(prompt, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await withTimeout(
                chatModel.generateContentStream(prompt),
                14000,
                `LLM attempt ${attempt}`
            );
        } catch (err) {
            if ((err.message?.includes('429') || err.status === 429) && attempt < maxRetries) {
                await sleep(attempt * 2400);
                continue;
            }
            throw err;
        }
    }
}

// ====================== ROUTES ======================
router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.post('/', async (req, res) => {
    const start = Date.now();
    let streamOpened = false;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => {
        if (!res.writableEnded) {
            streamOpened = true;
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    try {
        const { question } = req.body;
        if (!question?.trim()) {
            send({ error: 'Question is required' });
            return res.end();
        }

        // 1. Embedding
        const embedRes = await withTimeout(
            embeddingModel.embedContent(question.trim()),
            6000,
            'Embedding'
        );

        // 2. Vector Search
        const { data: matches, error } = await withTimeout(
            supabase.rpc('match_documents', {
                query_embedding: embedRes.embedding.values,
                match_threshold: MATCH_THRESHOLD,
                match_count: MATCH_COUNT,
            }),
            7500,
            'Vector search'
        );

        if (error) throw error;

        const safeMatches = (matches || [])
            .filter(m => m.similarity >= MATCH_THRESHOLD)
            .sort((a, b) => b.similarity - a.similarity);

        const context = safeMatches
            .map((m, i) => `[${i + 1}] ${m.content}`)
            .join('\n\n---\n\n')
            .slice(0, MAX_CONTEXT_CHARS);

        // ====================== ENFORCED STRUCTURED PROMPT ======================
        const prompt = `
You are a Principal Solutions Architect at Slake Design — expert in Stripe, payments infrastructure, fintech, and payment systems engineering.

<domain_classifier>
Classify silently as IN-DOMAIN or OUT-OF-DOMAIN.
- IN-DOMAIN: Stripe, payments, payouts, Connect, Billing, webhooks, subscriptions, Radar, Treasury, PCI compliance, idempotency, reconciliation, payment architecture, etc.
- OUT-OF-DOMAIN: Everything else (sports, NBA, medicine, politics, general trivia, etc.)
</domain_classifier>

<rules>
- If OUT-OF-DOMAIN: Output EXACTLY this and nothing more:
  "I’m specialized in Stripe, payments, and payment engineering. I don’t have information on that topic."

- If IN-DOMAIN: You MUST respond using the exact 4-section structure below. Do not add extra sections or deviate from the format.
</rules>

<required_output_structure>
## 1. Executive Strategy & Business Impact
(How this prevents revenue leakage, reduces churn, improves operational efficiency, scalability, or compliance.)

## 2. Technical Implementation Roadmap
(8+ detailed steps for a Lead Engineer. Always include Idempotency, Async Workers, Webhook Signature Verification, Error Handling, and Monitoring where relevant.)

## 3. Key Webhook Events & API Endpoints
(Use format: **Event**: [Action Required] — be precise and complete.)

## 4. Ready-to-Sprint: Jira Ticket
**Title**: [Clear, actionable title]
**Acceptance Criteria**:
- [Technical requirement 1]
- [Technical requirement 2]
- [Technical requirement 3]
- [Technical requirement 4]
- [Technical requirement 5]

**Risk Mitigation**: [One strong sentence.]
</required_output_structure>

Context:
${context || '[No relevant documents found]'}

Question: ${question}

Answer:
`;

        // 4. Generate
        const result = await generateWithRetry(prompt);

        let fullResponse = '';
        let isRefusal = false;

        for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) {
                fullResponse += text;
                send({ text });

                if (fullResponse.includes('I’m specialized in Stripe') &&
                    fullResponse.includes('don’t have information on that topic')) {
                    isRefusal = true;
                }
            }
        }

        // Send sources ONLY for IN-DOMAIN responses
        if (!isRefusal && safeMatches.length > 0) {
            const sources = safeMatches.map(m => ({
                id: m.id,
                similarity: Number(m.similarity.toFixed(4)),
                metadata: m.metadata || {}
            }));
            send({ sources });
        }

        send({ done: true });

        console.log(`[RAG] Completed in ${Date.now() - start}ms | Matches: ${safeMatches.length} | Refusal: ${isRefusal}`);

    } catch (err) {
        console.error('[RAG Error]', err);
        const msg = err.message?.includes('429')
            ? 'Rate limit reached. Please retry shortly.'
            : 'Request timeout. Please try again.';

        if (!streamOpened) res.writeHead(200);
        send({ error: msg });
    } finally {
        if (!res.writableEnded) res.end();
    }
});

module.exports = router;