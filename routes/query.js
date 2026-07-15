const express = require('express');
const router = express.Router();
const { ragServiceInstance } = require('../src/services/rag.service');

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.post('/', async (req, res) => {
    let streamOpened = false;

    // Set up Server-Sent Events (SSE) stream headers
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

        // Delegate query embedding, vector matching, token budgeting, and generation to RagService
        await ragServiceInstance.generateAnswer(question, {
            onChunk: (chunk) => send(chunk),
            onSources: (sources) => send({ sources })
        });

        send({ done: true });

    } catch (err) {
        console.error('[Query Route Error]', err);
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