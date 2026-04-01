require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Supabase & Gemini
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Optimization: Using Gemini 2.5 Flash for the best balance of speed and complex reasoning
const chatModel = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL });
const embeddingModel = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });

router.post('/', async (req, res) => {
    // CRITICAL: Set SSE Headers for Streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const { question } = req.body;
        if (!question) {
            res.write(`data: ${JSON.stringify({ error: 'Question is required' })}\n\n`);
            return res.end();
        }

        // 1. Vector Search for Documentation Context
        const embedRes = await embeddingModel.embedContent(question);
        const { data: matches, error: matchError } = await supabase.rpc('match_documents', {
            query_embedding: embedRes.embedding.values,
            match_threshold: 0.25,
            match_count: 8
        });

        if (matchError) throw matchError;
        const context = (matches || []).map(d => d.content).join('\n\n---\n\n');

        // 2. The Strategic Architect Prompt
        const prompt = `You are a Principal Solutions Architect at Slake Design. 
Using the provided Stripe context, generate an authoritative, implementation-ready brief.

### TONE: 
Decisive, professional, and business-focused. No conversational filler.

### STRUCTURE:
## 1. Executive Strategy & Business Impact
(Analyze the requirement. Specifically mention how this implementation prevents revenue leakage, reduces churn, or improves operational efficiency for leadership.)

---

## 2. Technical Implementation Roadmap
(Provide 8+ high-density steps for a Lead Engineer. Include patterns like Idempotency, Asynchronous Workers, and Signature Verification based on the context.)

---

## 3. Key Webhook Events & API Endpoints
(List the precise events and endpoints found in the context. Format as: **Event Name**: [Action Required])

---

## 4. Ready-to-Sprint: Jira Ticket Summary
**Title**: [Strategic Title]
**Acceptance Criteria**: (List 3-5 technical requirements based on the documentation.)
**Risk Mitigation**: (One sentence on how this architecture prevents common integration failures.)

Context: ${context}
Question: ${question}`;

        // 3. Execute Stream
        const result = await chatModel.generateContentStream(prompt);

        // Pipe chunks to the client as they are generated
        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
        }

        // 4. Final Metadata Payload (Sources)
        const sources = (matches || []).map(m => m.metadata);
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);

        res.end();

    } catch (err) {
        console.error('Architecture Engine Error:', err);
        res.write(`data: ${JSON.stringify({ error: "The architecture engine timed out. Please refresh and try again." })}\n\n`);
        res.end();
    }
});

module.exports = router;