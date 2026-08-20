const express = require('express');
const router = express.Router();
const { ragServiceInstance } = require('../src/services/rag.service');
const { MAX_QUESTION_CHARS } = require('../src/config/limits');

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.post('/', async (req, res) => {
    // Set up Server-Sent Events (SSE) stream headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    try {
        const { question } = req.body;

        // Absence keeps its existing message; a present-but-wrong type does not.
        if (question === undefined || question === null) {
            send({ error: 'Question is required' });
            return res.end();
        }

        // Type before the checks below, which call string methods.
        if (typeof question !== 'string') {
            send({ error: 'Question must be text.' });
            return res.end();
        }

        const trimmed = question.trim();
        if (!trimmed) {
            send({ error: 'Question is required' });
            return res.end();
        }

        if (trimmed.length > MAX_QUESTION_CHARS) {
            send({ error: `Question must be ${MAX_QUESTION_CHARS} characters or fewer.` });
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

        // `Timeout:` is the prefix withTimeout produces. Anything else is
        // unclassified and must not be given an invented cause.
        const message = err.message ?? '';
        let msg;
        if (message.includes('429')) {
            msg = 'Rate limit reached. Please retry shortly.';
        } else if (message.startsWith('Timeout:')) {
            msg = 'The retrieval service timed out. Please try again.';
        } else {
            msg = 'The request could not be completed. Please try again.';
        }

        // No writeHead here: flushHeaders() above already sent them, so it threw
        // ERR_HTTP_HEADERS_SENT and this error event never ran.
        send({ error: msg });
    } finally {
        if (!res.writableEnded) res.end();
    }
});

module.exports = router;
