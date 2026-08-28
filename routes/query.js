const express = require('express');
const router = express.Router();
const { ragServiceInstance } = require('../src/services/rag.service');
const { MAX_QUESTION_CHARS } = require('../src/config/limits');
const { logger } = require('../src/logging/logger');

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.post('/', async (req, res) => {
    const ac = new AbortController();

    // res.end() in `finally` sets writableEnded before 'close' fires on a normal
    // completion, so only an early close reaches abort().
    res.on('close', () => {
        if (!res.writableEnded) ac.abort();
    });

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
            onSources: (sources) => send({ sources }),
            signal: ac.signal
        });

        send({ done: true });

    } catch (err) {
        // The caller disconnected: there is no one to receive an error event,
        // and this is not a failure of the service.
        if (ac.signal.aborted) {
            logger.info('Client disconnected; generation aborted');
        } else {
            logger.error({ errMessage: err && err.message }, 'Query pipeline failed');

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

            // No writeHead here: flushHeaders() above already sent them, so it
            // threw ERR_HTTP_HEADERS_SENT and this error event never ran.
            send({ error: msg });
        }
    } finally {
        if (!res.writableEnded) res.end();
    }
});

module.exports = router;
