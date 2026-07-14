import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Define the mock functions that we will control in our tests
const mockRpc = vi.fn();
const mockEmbedContent = vi.fn();
const mockGenerateContentStream = vi.fn();

// Overwrite the exports in the Node.js require cache BEFORE requiring the router
const supabaseJS = require('@supabase/supabase-js');
supabaseJS.createClient = vi.fn(() => ({
    rpc: mockRpc,
}));

const googleGenerativeAI = require('@google/generative-ai');
googleGenerativeAI.GoogleGenerativeAI = class {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    getGenerativeModel(config) {
        if (config && config.model && config.model.includes('embedding')) {
            return { embedContent: mockEmbedContent };
        }
        return { generateContentStream: mockGenerateContentStream };
    }
};

// Now require the router which will load the mutated cached modules
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

describe('POST /query route RAG pipeline', () => {
    beforeEach(() => {
        mockRpc.mockReset();
        mockEmbedContent.mockReset();
        mockGenerateContentStream.mockReset();
    });

    it('should validate missing or empty question parameters', async () => {
        const res = await request(app)
            .post('/query')
            .send({});

        expect(res.status).toBe(200);
        expect(res.text).toContain('"error":"Question is required"');
    });

    it('should filter similarity matches correctly (only keeping >= 0.48 sorted descending)', async () => {
        // Mock embedding resolution
        mockEmbedContent.mockResolvedValue({
            embedding: { values: [0.1, 0.2] }
        });

        // Mock database matches
        const mockMatches = [
            { id: 1, content: 'High match content', similarity: 0.85, metadata: { source: 'docs-high' } },
            { id: 2, content: 'Low match content', similarity: 0.35, metadata: { source: 'docs-low' } },
            { id: 3, content: 'Mid match content', similarity: 0.60, metadata: { source: 'docs-mid' } },
        ];
        mockRpc.mockResolvedValue({ data: mockMatches, error: null });

        // Mock LLM generation stream
        mockGenerateContentStream.mockResolvedValue({
            stream: createMockStream(['Mocked RAG response content'])
        });

        const res = await request(app)
            .post('/query')
            .send({ question: 'How do I accept a payment?' });

        expect(res.status).toBe(200);
        expect(res.text).toContain('Mocked RAG response content');

        // Verify the sources data sent at the end of the SSE stream
        expect(res.text).toContain('"sources"');
        const lines = res.text.split('\n').filter(line => line.startsWith('data: '));
        const sourcesLine = lines.find(line => line.includes('"sources"'));
        expect(sourcesLine).toBeDefined();

        const jsonStr = sourcesLine.replace('data: ', '').trim();
        const data = JSON.parse(jsonStr);
        expect(data.sources).toHaveLength(2);
        expect(data.sources[0].id).toBe(1);
        expect(data.sources[0].similarity).toBe(0.85);
        expect(data.sources[1].id).toBe(3);
        expect(data.sources[1].similarity).toBe(0.60);
    });

    it('should retry on Gemini API 429 Rate Limit error and succeed', async () => {
        mockEmbedContent.mockResolvedValue({
            embedding: { values: [0.1, 0.2] }
        });

        mockRpc.mockResolvedValue({
            data: [{ id: 1, content: 'Match content', similarity: 0.85, metadata: { source: 'docs' } }],
            error: null
        });

        // Mock generateContentStream to fail with 429 on first try, then succeed
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

        // Using real timers: this will take ~2.4 seconds to execute backoff sleep
        const res = await request(app)
            .post('/query')
            .send({ question: 'How to handle 429?' });

        expect(res.status).toBe(200);
        expect(res.text).toContain('Success after retry');
        expect(callCount).toBe(2);
    }, 10000); // Set timeout to 10 seconds to allow for 2.4s backoff sleep
});
