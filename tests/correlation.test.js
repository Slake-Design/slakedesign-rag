import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';

const {
    correlationMiddleware,
    normaliseCorrelationId,
    runWithCorrelationId,
    getCorrelationId,
    CORRELATION_HEADER,
} = require('../src/logging/context');
const { redactSecrets } = require('../src/logging/logger');

/**
 * Correlation IDs on the RAG service.
 *
 * A single logical request here produces retrieval logs, a refusal-or-generate
 * decision, token-budget pruning lines and a completion line, streamed over SSE
 * and interleaved with other concurrent streams. Without a shared ID those
 * lines cannot be reassembled into the request that produced them.
 */

function appWithCorrelation() {
    const app = express();
    app.use(correlationMiddleware);
    app.get('/probe', (req, res) => res.json({ seen: getCorrelationId() }));
    app.get('/stream', (req, res) => {
        // Mirrors the SSE shape of the real query route: headers flushed early,
        // body written in chunks. The ID must be on the response before the
        // first chunk, since a client that disconnects mid-stream still needs
        // it to report the failure.
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ id: getCorrelationId() })}\n\n`);
        res.end();
    });
    return app;
}

describe('normaliseCorrelationId', () => {
    it('accepts a well-formed inbound id', () => {
        expect(normaliseCorrelationId('trace-abc_1')).toBe('trace-abc_1');
    });

    it('caps length so an unbounded header cannot bloat every log line', () => {
        expect(normaliseCorrelationId('a'.repeat(300))).toHaveLength(64);
    });

    it('strips characters that would allow log injection', () => {
        // A forged id containing a newline could fabricate an entire fake log
        // record in a line-delimited JSON stream.
        expect(normaliseCorrelationId('ok\n{"level":50,"msg":"fake"}')).toBe('oklevel50msgfake');
    });

    it('discards an id that sanitises to nothing rather than repairing it', () => {
        expect(normaliseCorrelationId('!!! ###')).toBeUndefined();
        expect(normaliseCorrelationId('')).toBeUndefined();
        expect(normaliseCorrelationId(undefined)).toBeUndefined();
    });
});

describe('correlation scope', () => {
    it('generates and echoes an id when the caller sends none', async () => {
        const res = await request(appWithCorrelation()).get('/probe');
        expect(res.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.body.seen).toBe(res.headers[CORRELATION_HEADER]);
    });

    it('honours a caller-supplied id so traces stitch across services', async () => {
        const res = await request(appWithCorrelation())
            .get('/probe')
            .set(CORRELATION_HEADER, 'from-upstream-1');
        expect(res.headers[CORRELATION_HEADER]).toBe('from-upstream-1');
        expect(res.body.seen).toBe('from-upstream-1');
    });

    it('sanitises a hostile inbound id before echoing it', async () => {
        const res = await request(appWithCorrelation())
            .get('/probe')
            .set(CORRELATION_HEADER, 'evil id;{"level":50}');
        expect(res.headers[CORRELATION_HEADER]).toBe('evilidlevel50');
    });

    it('is available on the SSE path before the first chunk is written', async () => {
        const res = await request(appWithCorrelation())
            .get('/stream')
            .set(CORRELATION_HEADER, 'sse-trace-7');

        expect(res.headers[CORRELATION_HEADER]).toBe('sse-trace-7');
        expect(res.text).toContain('sse-trace-7');
    });

    it('issues a distinct id per request', async () => {
        const app = appWithCorrelation();
        const [a, b] = await Promise.all([request(app).get('/probe'), request(app).get('/probe')]);
        expect(a.body.seen).not.toBe(b.body.seen);
    });

    it('keeps concurrent scopes isolated from each other', async () => {
        // AsyncLocalStorage must not leak between interleaved async requests -
        // the failure mode would be one stream's logs tagged with another's id.
        const results = await Promise.all([
            runWithCorrelationId('a-1', async () => {
                await new Promise((r) => setTimeout(r, 10));
                return getCorrelationId();
            }),
            runWithCorrelationId('b-2', async () => {
                await new Promise((r) => setTimeout(r, 5));
                return getCorrelationId();
            }),
        ]);
        expect(results).toEqual(['a-1', 'b-2']);
    });

    it('leaves no ambient scope behind', () => {
        expect(getCorrelationId()).toBeUndefined();
    });
});

describe('redactSecrets', () => {
    it('redacts the Gemini API key from a request URL', () => {
        // This is the concrete leak: the Google SDK puts the key in the query
        // string, so a failed request URL carries it into error messages.
        const leaked =
            'GoogleGenerativeAI Error: fetch failed for ' +
            'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSyREALKEY123';
        const safe = redactSecrets(leaked);
        expect(safe).not.toContain('AIzaSyREALKEY123');
        expect(safe).toContain('key=[REDACTED]');
    });

    it('strips credentials from connection URLs', () => {
        expect(redactSecrets('https://user:pw@example.com/x')).toBe('https://[REDACTED]@example.com/x');
    });

    it('leaves ordinary text alone', () => {
        expect(redactSecrets('Retrieved 6 chunks above threshold')).toBe(
            'Retrieved 6 chunks above threshold'
        );
    });
});
