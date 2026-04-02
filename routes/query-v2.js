require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const chatModel = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL });
const embeddingModel = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
        )
    ]);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateWithRetry(prompt, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await withTimeout(
                chatModel.generateContentStream(prompt),
                12000,
                'LLM stream initiation'
            );
            return result;
        } catch (err) {
            const is429 = err.message?.includes('429');
            const isLast = attempt === maxRetries;

            if (is429 && !isLast) {
                const wait = attempt * 2000; // 2s, 4s, 6s
                console.log(`[retry] 429 on attempt ${attempt}, waiting ${wait}ms`);
                await sleep(wait);
                continue;
            }
            throw err;
        }
    }
}

router.post('/', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
        const { question } = req.body;
        if (!question) {
            res.write(`data: ${JSON.stringify({ error: 'Question is required' })}\n\n`);
            return res.end();
        }

        const embedStart = Date.now();
        const embedRes = await withTimeout(
            embeddingModel.embedContent(question),
            5000,
            'embedding'
        );
        console.log(`embed: ${Date.now() - embedStart}ms`);

        const supabaseStart = Date.now();
        const { data: matches, error: matchError } = await withTimeout(
            supabase.rpc('match_documents', {
                query_embedding: embedRes.embedding.values,
                match_threshold: 0.3,
                match_count: 4
            }),
            6000,
            'supabase vector search'
        );
        console.log(`supabase: ${Date.now() - supabaseStart}ms`);

        if (matchError) throw matchError;

        const context = (matches || [])
            .map(d => d.content)
            .join('\n---\n')
            .slice(0, 1200);

        const prompt = `You are a Principal Solutions Architect at Slake Design. Be decisive and implementation-ready.

## 1. Executive Strategy & Business Impact
(How this prevents revenue leakage, reduces churn, improves operational efficiency.)

## 2. Technical Implementation Roadmap
(8+ steps for a Lead Engineer. Include Idempotency, Async Workers, Signature Verification.)

## 3. Key Webhook Events & API Endpoints
(Precise events and endpoints. Format: **Event**: [Action Required])

## 4. Ready-to-Sprint: Jira Ticket
**Title**: [Title]
**Acceptance Criteria**: (3-5 technical requirements.)
**Risk Mitigation**: (One sentence.)

Context:
${context}

Question: ${question}`;

        const llmStart = Date.now();
        const result = await generateWithRetry(prompt);
        console.log(`llm stream open: ${Date.now() - llmStart}ms`);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
                res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
            }
        }

        const sources = (matches || []).map(m => m.metadata);
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);
        res.end();

    } catch (err) {
        const isTimeout = err.message?.includes('Timeout');
        const is429 = err.message?.includes('429');

        let clientMsg = 'Architecture engine reset. Please retry.';
        if (isTimeout) clientMsg = 'Engine reset. Refresh and retry.';
        if (is429) clientMsg = 'Engine is warming up. Please retry in a moment.';

        console.error('[query-v2 error]', err.message);
        res.write(`data: ${JSON.stringify({ error: clientMsg })}\n\n`);
        res.end();
    }
});

module.exports = router;