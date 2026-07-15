import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Set dummy environment variables to prevent initialization checks from throwing during testing
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock-supabase-url.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'mock-supabase-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'mock-gemini-key';

// Load local environment variables if present
require('dotenv').config();

// Import target service and router
const { RagService, ragServiceInstance } = require('../src/services/rag.service');
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
});

describe('RagService (Orchestrator Logic via Dependency Injection)', () => {
    const mockMatchDocuments = vi.fn();
    const mockInsertDocument = vi.fn();
    const mockEmbedContent = vi.fn();
    const mockGenerateContentStream = vi.fn();
    const mockCountTokens = vi.fn();

    // Plain mock objects passed to constructor
    const mockRepo = {
        matchDocuments: mockMatchDocuments,
        insertDocument: mockInsertDocument
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
        expect(mockEmbedContent).toHaveBeenCalledWith('How to make payments?');
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
});
