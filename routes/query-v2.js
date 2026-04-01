// routes/query-v2.js
require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Senior Architect Persona
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL,
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ]
});

const embeddingModel = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });

router.post('/', async (req, res) => {
    req.setTimeout(120000); // Massive timeout for parallel generation

    try {
        const { question } = req.body;
        if (!question) return res.status(400).json({ error: 'No question provided' });

        // 1) Context Retrieval
        const embedRes = await embeddingModel.embedContent(question);
        const { data: matches, error } = await supabase.rpc('match_documents', {
            query_embedding: embedRes.embedding.values,
            match_threshold: 0.25,
            match_count: 8
        });
        if (error) throw error;

        const context = (matches || []).map(d => d.content).join('\n\n');

        // 2) PLAN Z: Parallel Execution
        // We split the "Report" into two separate "Brain" tasks to bypass the 1024 token cutoff.
        const [task1, task2] = await Promise.all([
            // Task 1: The Strategic Executive Summary
            model.generateContent(`You are a Solutions Architect. Based on the Stripe context, write a 3-paragraph EXECUTIVE STRATEGY for a SaaS CEO. Do not list technical steps. Context: ${context}. Question: ${question}`),

            // Task 2: The Technical Implementation roadmap
            model.generateContent(`You are a Lead Engineer. Based on the Stripe context, provide a detailed 8-step IMPLEMENTATION ROADMAP and a list of WEBHOOK EVENTS. Be technical. Context: ${context}. Question: ${question}`)
        ]);

        const strategy = task1.response.text();
        const technical = task2.response.text();

        // 3) Assembler: Stitching the "Billion Dollar" Deliverable
        const fullAnswer = `## Executive Strategy\n${strategy}\n\n---\n\n## Technical Implementation Roadmap\n${technical}`;

        console.log('[PLAN Z] Success: Bypassed Free Tier truncation via Parallel Assembly.');

        res.json({
            answer: fullAnswer,
            sources: (matches || []).map(m => m.metadata)
        });

    } catch (err) {
        console.error('Plan Z Failure:', err);
        res.status(500).json({ error: "Architecture engine overflow. Please simplify the query." });
    }
});

module.exports = router;