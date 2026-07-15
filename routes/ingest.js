require('dotenv').config();
const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const documentRepository = require('../src/repositories/document.repository');
const { embeddingModel } = require('../src/config/gemini');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const Chunker = require('../src/ingestion/chunker');

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

    const chunks = Chunker.splitText(text, { chunkSize: 500, chunkOverlap: 50 });
    // Using centralized embeddingModel

    let inserted = 0;
    const t0 = Date.now();

    // Sequential insert (safe for rate limits; can batch later if needed)
    for (const chunk of chunks) {
      const result = await embeddingModel.embedContent(chunk);
      const embedding = result.embedding.values;
      await documentRepository.insertDocument({
        content: chunk,
        embedding,
        metadata: { filename: req.file.originalname }
      });
      inserted++;
    }

    const t1 = Date.now();
    console.log('UPLOAD TIMING (ms):', {
      chunks: inserted,
      total: t1 - t0,
      perChunk: inserted ? (t1 - t0) / inserted : 0,
    });

    res.json({ success: true, chunks: inserted });
  } catch (err) {
    console.error('[Ingest Error]', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size exceeds the 10MB limit.' });
    }
    res.status(500).json({ error: 'An error occurred during file ingestion.' });
  }
});

module.exports = router;