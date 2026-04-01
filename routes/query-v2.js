require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use the 2.5 Flash model for the best speed/density ratio
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL });
const embeddingModel = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });

router.post('/', async (req, res) => {
    // ESSENTIAL: Set headers for Server-Sent Events (Streaming)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const { question } = req.body;
        if (!question) {
            res.write(`data: ${JSON.stringify({ error: 'No question provided' })}\n\n`);
            return res.end();
        }

        // 1. Vector Retrieval
        const embedRes = await embeddingModel.embedContent(question);
        const { data: matches, error } = await supabase.rpc('match_documents', {
            query_embedding: embedRes.embedding.values,
            match_threshold: 0.25,
            match_count: 8
        });

        if (error) throw error;
        const context = (matches || []).map(d => d.content).join('\n\n---\n\n');

        // 2. The Prompt (Forced structure for the "Executive" look)
        const prompt = `You are a Senior Solutions Architect at Slake Design. 
        Provide a comprehensive STRATEGY and TECHNICAL ROADMAP based on the context.
        
        STRUCTURE:
        ## Executive Strategy (2-3 paragraphs for leadership)
        ---
        ## Technical Implementation Roadmap (8+ detailed steps)
        ---
        ## Key Webhook Events & API Endpoints
        
        Context: ${context}
        Question: ${question}`;

        // 3. GENERATE STREAM
        const result = await model.generateContentStream(prompt);

        // Iterate through chunks and flush them to the browser immediately
        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
        }

        // 4. Send Metadata (Sources) at the very end
        const sources = (matches || []).map(m => m.metadata);
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);

        res.end();

    } catch (err) {
        console.error('Streaming Error:', err);
        res.write(`data: ${JSON.stringify({ error: "Architecture engine timeout. Please retry." })}\n\n`);
        res.end();
    }
});

module.exports = router;