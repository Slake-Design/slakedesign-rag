require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post('/', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'No question provided' });

    // Embed the question
    const embeddingModel = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });
    const result = await embeddingModel.embedContent(question);
    const embedding = result.embedding.values;

    // Find similar chunks
    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 5
    });

    if (error) throw error;

    const context = data.map(d => d.content).join('\n\n');

    // Answer using Gemini
    const chatModel = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL });
    const prompt = `You are a helpful assistant. Answer the question using only the context below. If the answer isn't in the context, say "I don't have that information."

Context:
${context}

Question: ${question}`;

    const response = await chatModel.generateContent(prompt);
    const answer = response.response.text();

    res.json({ answer, sources: data.map(d => d.metadata) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
