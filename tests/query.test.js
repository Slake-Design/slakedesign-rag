import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Set dummy environment variables to prevent initialization checks from throwing during testing
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'mock-gemini-key';

// Load local environment variables if present
require('dotenv').config();

// Import target service and router
const { RagService, ragServiceInstance } = require('../src/services/rag.service');
const { MAX_QUESTION_CHARS } = require('../src/config/limits');
const { REFUSAL_TEXT } = require('../src/config/gemini');
const app = express();
app.use(express.json());
const queryRouter = require('../routes/query');
app.use('/query', queryRouter);

// Helper function to create mock generative streams
async function* createMockStream(texts) {
    for (const text of texts) {
        yield {
            text: () => text,
        };
    }
}

describe('POST /query route (HTTP Transport)', () => {
    it('should validate missing or empty question parameters', async () => {
        const res = await request(app)
            .post('/query')
            .send({});

        expect(res.status).toBe(200);
        expect(res.text).toContain('"error":"Question is required"');
    });

    it('should establish SSE streaming connection and stream tokens', async () => {
        // Spy and mock the singleton ragServiceInstance directly
        const generateAnswerSpy = vi.spyOn(ragServiceInstance, 'generateAnswer');
        generateAnswerSpy.mockImplementation(async (question, callbacks) => {
            callbacks.onChunk({ text: 'Hello from mock stream' });
            callbacks.onSources([{ id: 1, similarity: 0.88, metadata: { source: 'test' } }]);
        });

        const res = await request(app)
            .post('/query')
            .send({ question: 'Test endpoint validation' });

        expect(res.status).toBe(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('Hello from mock stream');
        expect(res.text).toContain('"sources"');
        expect(res.text).toContain('"done":true');
        
        generateAnswerSpy.mockRestore();
    });

    it('rejects a non-string question without running the pipeline', async () => {
        const spy = vi.spyOn(ragServiceInstance, 'generateAnswer');

        const res = await request(app)
            .post('/query')
            .send({ question: 5 });

        expect(res.status).toBe(200);
        expect(res.text).toContain('"error":"Question must be text."');
        expect(spy).not.toHaveBeenCalled();

        spy.mockRestore();
    });

    it('rejects a question over the limit without running the pipeline', async () => {
        const spy = vi.spyOn(ragServiceInstance, 'generateAnswer');

        const res = await request(app)
            .post('/query')
            .send({ question: 'a'.repeat(MAX_QUESTION_CHARS + 1) });

        expect(res.status).toBe(200);
        expect(res.text).toContain(`Question must be ${MAX_QUESTION_CHARS} characters or fewer.`);
        expect(spy).not.toHaveBeenCalled();

        spy.mockRestore();
    });

    it('accepts a question of exactly the maximum length', async () => {
        const spy = vi.spyOn(ragServiceInstance, 'generateAnswer');
        spy.mockImplementation(async () => {});

        const res = await request(app)
            .post('/query')
            .send({ question: 'a'.repeat(MAX_QUESTION_CHARS) });

        expect(res.status).toBe(200);
        expect(res.text).not.toContain('"error"');
        expect(spy).toHaveBeenCalledTimes(1);

        spy.mockRestore();
    });

    it('does not report an unclassified failure as a timeout', async () => {
        const spy = vi.spyOn(ragServiceInstance, 'generateAnswer');
        spy.mockRejectedValue(new Error('boom'));

        const res = await request(app)
            .post('/query')
            .send({ question: 'anything' });

        expect(res.status).toBe(200);
        // The error event must arrive at all: writeHead() after flushHeaders()
        // threw here, which dropped it entirely.
        expect(res.text).toContain('"error":"The request could not be completed. Please try again."');
        expect(res.text).not.toMatch(/timeout/i);

        spy.mockRestore();
    });

    it('maps a Timeout: error to the timeout message', async () => {
        const spy = vi.spyOn(ragServiceInstance, 'generateAnswer');
        spy.mockRejectedValue(new Error('Timeout: Embedding'));

        const res = await request(app)
            .post('/query')
            .send({ question: 'anything' });

        expect(res.text).toContain('"error":"The retrieval service timed out. Please try again."');

        spy.mockRestore();
    });

    it('maps a 429 error to the rate limit message', async () => {
        const spy = vi.spyOn(ragServiceInstance, 'generateAnswer');
        spy.mockRejectedValue(new Error('Resource exhausted (429)'));

        const res = await request(app)
            .post('/query')
            .send({ question: 'anything' });

        expect(res.text).toContain('"error":"Rate limit reached. Please retry shortly."');

        spy.mockRestore();
    });
});

describe('RagService (Orchestrator Logic via Dependency Injection)', () => {
    const mockMatchDocuments = vi.fn();
    const mockEmbedContent = vi.fn();
    const mockGenerateContentStream = vi.fn();
    const mockCountTokens = vi.fn();

    // Plain mock objects passed to constructor
    const mockRepo = {
        matchDocuments: mockMatchDocuments
    };

    const mockGemini = {
        embeddingModel: {
            embedContent: mockEmbedContent
        },
        chatModel: {
            generateContentStream: mockGenerateContentStream,
            countTokens: mockCountTokens
        }
    };

    // Instantiate service using dependency injection (DI)
    const testService = new RagService(mockRepo, mockGemini);

    beforeEach(() => {
        mockMatchDocuments.mockReset();
        mockEmbedContent.mockReset();
        mockGenerateContentStream.mockReset();
        mockCountTokens.mockReset();
    });

    it('should orchestrate retrieval, budgeting, and LLM generation successfully', async () => {
        mockEmbedContent.mockResolvedValue({
            embedding: { values: [0.1, 0.2] }
        });

        const mockMatches = [
            { id: 1, content: 'High similarity chunk', similarity: 0.90, metadata: { source: 'docs-high' } },
            { id: 2, content: 'Filtered out similarity chunk', similarity: 0.35, metadata: { source: 'docs-low' } },
            { id: 3, content: 'Mid similarity chunk', similarity: 0.70, metadata: { source: 'docs-mid' } },
        ];
        mockMatchDocuments.mockResolvedValue(mockMatches);
        
        // Mock token counts (base tokens = 100, chunk 1 = 50, chunk 3 = 50)
        mockCountTokens.mockResolvedValue({ totalTokens: 50 });
        mockGenerateContentStream.mockResolvedValue({
            stream: createMockStream(['Mocked generated RAG response'])
        });

        const chunks = [];
        let returnedSources = null;

        await testService.generateAnswer('How to make payments?', {
            onChunk: (chunk) => chunks.push(chunk.text || chunk),
            onSources: (sources) => { returnedSources = sources; }
        });

        // Verify embedding and retrieval were called
        expect(mockEmbedContent).toHaveBeenCalledWith('How to make payments?', { signal: undefined });
        expect(mockMatchDocuments).toHaveBeenCalledWith([0.1, 0.2], 0.48, 6);

        // Verify outputs
        expect(chunks.join('')).toBe('Mocked generated RAG response');
        expect(returnedSources).toHaveLength(2); // Only matches above 0.48 similarity are kept
        expect(returnedSources[0].id).toBe(1);
        expect(returnedSources[1].id).toBe(3);
    });

    it('should retry on Gemini API 429 Rate Limit error and succeed', async () => {
        mockEmbedContent.mockResolvedValue({
            embedding: { values: [0.1, 0.2] }
        });

        mockMatchDocuments.mockResolvedValue([
            { id: 1, content: 'Mock content', similarity: 0.85 }
        ]);

        mockCountTokens.mockResolvedValue({ totalTokens: 10 });

        // Fail on first attempt with 429, then succeed on second attempt
        let callCount = 0;
        mockGenerateContentStream.mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                const err = new Error('Resource exhausted (429)');
                err.status = 429;
                throw err;
            }
            return Promise.resolve({
                stream: createMockStream(['Success after retry'])
            });
        });

        const chunks = [];
        await testService.generateAnswer('Test 429 retry logic', {
            onChunk: (chunk) => chunks.push(chunk.text || chunk)
        });

        expect(callCount).toBe(2);
        expect(chunks.join('')).toBe('Success after retry');
    }, 10000); // 10s timeout to allow for exponential sleep backoff

    it('stops streaming and emits no sources once the caller aborts', async () => {
        mockEmbedContent.mockResolvedValue({ embedding: { values: [0.1, 0.2] } });
        mockMatchDocuments.mockResolvedValue([
            { id: 1, content: 'Mock content', similarity: 0.85, metadata: { source: 'docs' } }
        ]);
        mockCountTokens.mockResolvedValue({ totalTokens: 10 });
        mockGenerateContentStream.mockResolvedValue({
            stream: createMockStream(['first', 'second', 'third'])
        });

        const controller = new AbortController();
        const chunks = [];
        let returnedSources = null;

        await testService.generateAnswer('Abort after the first chunk', {
            onChunk: (chunk) => {
                chunks.push(chunk.text);
                controller.abort();
            },
            onSources: (sources) => { returnedSources = sources; },
            signal: controller.signal
        });

        expect(chunks).toEqual(['first']);
        expect(returnedSources).toBeNull();
    });

    it('ends a retry backoff immediately on abort and starts no further attempt', async () => {
        mockEmbedContent.mockResolvedValue({ embedding: { values: [0.1, 0.2] } });
        mockMatchDocuments.mockResolvedValue([
            { id: 1, content: 'Mock content', similarity: 0.85, metadata: {} }
        ]);
        mockCountTokens.mockResolvedValue({ totalTokens: 10 });

        const controller = new AbortController();
        let attempts = 0;
        mockGenerateContentStream.mockImplementation(() => {
            attempts++;
            // Abort while the 2400ms backoff for this attempt is still pending.
            setTimeout(() => controller.abort(), 10);
            const err = new Error('Resource exhausted (429)');
            err.status = 429;
            throw err;
        });

        const startedAt = Date.now();
        await expect(
            testService.generateAnswer('Abort during backoff', { signal: controller.signal })
        ).rejects.toThrow(/429/);
        const elapsed = Date.now() - startedAt;

        expect(attempts).toBe(1);
        // A backoff served in full would take at least 2400ms.
        expect(elapsed).toBeLessThan(2400);
    });

    it('emits no sources when the model returns the shared refusal text', async () => {
        mockEmbedContent.mockResolvedValue({ embedding: { values: [0.1, 0.2] } });
        mockMatchDocuments.mockResolvedValue([
            { id: 1, content: 'Mock content', similarity: 0.85, metadata: { source: 'docs' } }
        ]);
        mockCountTokens.mockResolvedValue({ totalTokens: 10 });
        mockGenerateContentStream.mockResolvedValue({
            stream: createMockStream([REFUSAL_TEXT])
        });

        const chunks = [];
        let returnedSources = null;

        await testService.generateAnswer('Who won the NBA finals?', {
            onChunk: (chunk) => chunks.push(chunk.text),
            onSources: (sources) => { returnedSources = sources; }
        });

        expect(chunks.join('')).toBe(REFUSAL_TEXT);
        expect(returnedSources).toBeNull();
    });

    it('emits no sources when the refusal varies in apostrophe, casing and whitespace', async () => {
        mockEmbedContent.mockResolvedValue({ embedding: { values: [0.1, 0.2] } });
        mockMatchDocuments.mockResolvedValue([
            { id: 1, content: 'Mock content', similarity: 0.85, metadata: { source: 'docs' } }
        ]);
        mockCountTokens.mockResolvedValue({ totalTokens: 10 });

        // Same sentence, straight apostrophes, upper case, and newline/tab runs.
        const variant = "I'M SPECIALIZED IN STRIPE, PAYMENTS,\n\nAND PAYMENT ENGINEERING."
            + "\tI DON'T HAVE   INFORMATION ON THAT TOPIC.";
        mockGenerateContentStream.mockResolvedValue({ stream: createMockStream([variant]) });

        const chunks = [];
        let returnedSources = null;

        await testService.generateAnswer('Who won the NBA finals?', {
            onChunk: (chunk) => chunks.push(chunk.text),
            onSources: (sources) => { returnedSources = sources; }
        });

        // Text output is untouched; only source emission is suppressed.
        expect(chunks.join('')).toBe(variant);
        expect(returnedSources).toBeNull();
    });

    it('still emits sources for a grounded answer that merely mentions Stripe', async () => {
        mockEmbedContent.mockResolvedValue({ embedding: { values: [0.1, 0.2] } });
        mockMatchDocuments.mockResolvedValue([
            { id: 7, content: 'Mock content', similarity: 0.85, metadata: { source: 'docs' } }
        ]);
        mockCountTokens.mockResolvedValue({ totalTokens: 10 });
        mockGenerateContentStream.mockResolvedValue({
            stream: createMockStream([
                'To verify a Stripe webhook signature, use the endpoint secret. Stripe signs every event.'
            ])
        });

        let returnedSources = null;

        await testService.generateAnswer('How do I verify webhook signatures?', {
            onChunk: () => {},
            onSources: (sources) => { returnedSources = sources; }
        });

        expect(returnedSources).toHaveLength(1);
        expect(returnedSources[0].id).toBe(7);
    });
});

describe('isDomainRefusal', () => {
    const { isDomainRefusal } = require('../src/services/rag.service');

    it('returns false for empty and missing input', () => {
        expect(isDomainRefusal('')).toBe(false);
        expect(isDomainRefusal(undefined)).toBe(false);
        expect(isDomainRefusal(null)).toBe(false);
    });
});


describe('app configuration', () => {
    const loadApp = () => {
        delete require.cache[require.resolve('../index.js')];
        return require('../index.js');
    };

    afterEach(() => {
        delete process.env.TRUST_PROXY_HOPS;
    });

    // 2, measured 2026-08-21 against the deployment: Cloudflare then the Render load
    // balancer. An unset variable must yield this rather than 0, because 0 keyed every
    // visitor into one shared rate-limit bucket.
    const CALIBRATED_HOPS = 2;

    it('defaults trust proxy to the calibrated hop count when TRUST_PROXY_HOPS is unset', () => {
        delete process.env.TRUST_PROXY_HOPS;
        expect(loadApp().get('trust proxy')).toBe(CALIBRATED_HOPS);
    });

    it('reflects an explicitly configured TRUST_PROXY_HOPS value', () => {
        process.env.TRUST_PROXY_HOPS = '3';
        expect(loadApp().get('trust proxy')).toBe(3);
    });

    it.each(['abc', '-1', '1.5', '', '   '])(
        'falls back to the calibrated hop count for the invalid value %j',
        (value) => {
            process.env.TRUST_PROXY_HOPS = value;
            expect(loadApp().get('trust proxy')).toBe(CALIBRATED_HOPS);
        }
    );

    // The point of the calibration: req.ip must be the visitor, not the proxy, or the
    // rate limiter counts everyone into one bucket.
    it('resolves req.ip to the real client through the calibrated hop count', async () => {
        delete process.env.TRUST_PROXY_HOPS;
        const configured = loadApp();
        configured.get('/__probe_client', (req, res) => res.json({ ip: req.ip }));

        // The chain the deployment produces: client, then Cloudflare. The socket peer
        // stands in for the Render load balancer.
        const res = await request(configured)
            .get('/__probe_client')
            .set('X-Forwarded-For', '203.0.113.7, 198.51.100.1');

        expect(res.body.ip).toBe('203.0.113.7');
    });

    it('ignores X-Forwarded-For entries a client prepends to forge an identity', async () => {
        delete process.env.TRUST_PROXY_HOPS;
        const configured = loadApp();
        configured.get('/__probe_forged', (req, res) => res.json({ ip: req.ip }));

        // Express counts from the trusted right-hand end, so a forged left-hand entry
        // cannot shift which address is selected.
        const res = await request(configured)
            .get('/__probe_forged')
            .set('X-Forwarded-For', '9.9.9.9, 203.0.113.7, 198.51.100.1');

        expect(res.body.ip).toBe('203.0.113.7');
    });

    it('serves /health with no calibration field left on it', async () => {
        delete process.env.TRUST_PROXY_HOPS;
        const res = await request(loadApp()).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });
    });

    // /query/health sits inside the rate-limited /query mount, so without the skip
    // predicate an operational probe spent a visitor's 10/hour quota. Exercised against
    // the real app and its real limiter, not a copy: well past the limit of 10.
    it('does not charge /query/health against the query rate limit', async () => {
        delete process.env.TRUST_PROXY_HOPS;
        const configured = loadApp();

        const statuses = [];
        for (let i = 0; i < 12; i++) {
            statuses.push((await request(configured).get('/query/health')).status);
        }

        expect(statuses).toEqual(Array(12).fill(200));
    });
});

describe('rate limiter response', () => {
    it('returns the documented JSON body once the limit is exceeded', async () => {
        const rateLimit = require('express-rate-limit');
        // The same frozen constant the production limiter is configured with.
        const RATE_LIMIT_MESSAGE = require('../index.js').RATE_LIMIT_MESSAGE;

        // A fresh limiter with its own store, so this never touches the
        // production 1-hour window or shares state with another test.
        const limitedApp = express();
        limitedApp.use(express.json());
        limitedApp.use('/query', rateLimit({
            windowMs: 60 * 1000,
            max: 2,
            message: RATE_LIMIT_MESSAGE
        }));
        limitedApp.post('/query', (req, res) => res.json({ ok: true }));

        expect((await request(limitedApp).post('/query').send({})).status).toBe(200);
        expect((await request(limitedApp).post('/query').send({})).status).toBe(200);

        const blocked = await request(limitedApp).post('/query').send({});

        expect(blocked.status).toBe(429);
        expect(blocked.body).toEqual(RATE_LIMIT_MESSAGE);
    });
});
