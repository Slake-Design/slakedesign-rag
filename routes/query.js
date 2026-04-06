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

router.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

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
      match_count: 5
    });
    if (error) throw error;
    const t2 = Date.now();

    // Trim context so Gemini can finish the answer
    const trimmed = (data || [])
      .slice(0, 3)                       // top 3 chunks
      .map(d => (d.content || '').slice(0, 2000)); // max ~2k chars each
    const context = trimmed.join('\n\n');

    // 3) Answer using Gemini with more tokens and safer extraction
    const prompt = `You are a Stripe API expert. Answer the question using only the context below.
Give a clear, step-by-step explanation where helpful.
If the answer isn't in the context, say "I don't have that information."

Context:
${context}

Question: ${question}`;

    const result = await chatModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 512,
        temperature: 0.3,
      },
    });

    const candidate = result.response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const answer = parts.map(p => p.text || '').join('').trim();
    const t3 = Date.now();

    console.log('RAG TIMING (ms):', {
      embed: t1 - t0,
      search: t2 - t1,
      llm: t3 - t2,
      total: t3 - t0,
    });

    res.json({ answer, sources: (data || []).map(d => d.metadata) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;