require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Reuse models across requests
const embeddingModel = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });
const chatModel = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL });

router.post('/', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'No question provided' });

    const t0 = Date.now();

    // 1) Embed the question
    const embedResult = await embeddingModel.embedContent(question);
    const embedding = embedResult.embedding.values;
    const t1 = Date.now();

    // 2) Find similar chunks (reduced match_count for speed)
    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 3
    });
    if (error) throw error;
    const t2 = Date.now();

    const context = data.map(d => d.content).join('\n\n');

    // 3) Answer using Gemini with a token limit
    const prompt = `You are a helpful assistant. Answer the question using only the context below. If the answer isn't in the context, say "I don't have that information."

Context:
${context}

Question: ${question}`;

    const response = await chatModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0.3,
      },
    });
    const answer = response.response.text();
    const t3 = Date.now();

    console.log('RAG TIMING (ms):', {
      embed: t1 - t0,
      search: t2 - t1,
      llm: t3 - t2,
      total: t3 - t0,
    });

    res.json({ answer, sources: data.map(d => d.metadata) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;