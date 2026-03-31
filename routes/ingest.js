require('dotenv').config();
const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const upload = multer({ storage: multer.memoryStorage() });

function chunkText(text, size = 500) {
  const words = text.split(' ');
  const chunks = [];
  let current = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= size) {
      chunks.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let text = '';
    if (req.file.mimetype === 'application/pdf') {
      const parsed = await pdfParse(req.file.buffer);
      text = parsed.text;
    } else {
      text = req.file.buffer.toString('utf-8');
    }

    const chunks = chunkText(text);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });

    let inserted = 0;
    for (const chunk of chunks) {
      const result = await model.embedContent(chunk);
      const embedding = result.embedding.values;
      await supabase.from('documents').insert({
        content: chunk,
        embedding,
        metadata: { filename: req.file.originalname }
      });
      inserted++;
    }

    res.json({ success: true, chunks: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
