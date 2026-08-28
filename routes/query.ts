import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { ragServiceInstance } from '../src/services/rag.service.js';
import { MAX_QUESTION_CHARS } from '../src/config/limits.js';
import { logger } from '../src/logging/logger.js';

const router = express.Router();

/**
 * Request schema for the query endpoint.
 *
 * Replaces four hand-rolled checks. The messages are preserved verbatim from
 * the manual implementation because tests/query.test.js asserts on them, and
 * keeping them identical is what proves this port was behaviour-preserving
 * rather than merely equivalent-looking.
 *
 * `.strict()` matches the posture of the sibling task-queue-system schemas: an
 * undeclared field is rejected rather than silently stripped, so a client
 * cannot believe it passed an option the service ignored.
 */
export const QueryRequestSchema = z
    .object({
        question: z.unknown(),
    })
    .strict();

/** Validates `question` in the original order, so error text is unchanged. */
export function validateQuestion(body: unknown): { ok: true; question: string } | { ok: false; error: string } {
    const parsed = QueryRequestSchema.safeParse(body);
    if (!parsed.success) {
        return { ok: false, error: 'Question is required' };
    }

    const question = parsed.data.question;

    // Absence keeps its existing message; a present-but-wrong type does not.
    if (question === undefined || question === null) {
        return { ok: false, error: 'Question is required' };
    }

    // Type before the checks below, which call string methods.
    if (typeof question !== 'string') {
        return { ok: false, error: 'Question must be text.' };
    }

    const trimmed = question.trim();
    if (!trimmed) {
        return { ok: false, error: 'Question is required' };
    }

    if (trimmed.length > MAX_QUESTION_CHARS) {
        return { ok: false, error: `Question must be ${MAX_QUESTION_CHARS} characters or fewer.` };
    }

    return { ok: true, question };
}

router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
});

router.post('/', async (req: Request, res: Response) => {
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

    const send = (data: unknown): void => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    try {
        const validated = validateQuestion(req.body);
        if (!validated.ok) {
            send({ error: validated.error });
            res.end();
            return;
        }

        // Delegate query embedding, vector matching, token budgeting, and generation to RagService
        await ragServiceInstance.generateAnswer(validated.question, {
            onChunk: (chunk) => send(chunk),
            onSources: (sources) => send({ sources }),
            signal: ac.signal,
        });

        send({ done: true });
    } catch (err) {
        // The caller disconnected: there is no one to receive an error event,
        // and this is not a failure of the service.
        if (ac.signal.aborted) {
            logger.info('Client disconnected; generation aborted');
        } else {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ errMessage: message }, 'Query pipeline failed');

            // `Timeout:` is the prefix withTimeout produces. Anything else is
            // unclassified and must not be given an invented cause.
            let msg: string;
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

export default router;
