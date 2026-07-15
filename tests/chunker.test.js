import { describe, it, expect } from 'vitest';
const Chunker = require('../src/ingestion/chunker');

describe('Chunker Utility', () => {
    it('should split text into chunks based on word limit', () => {
        const text = 'word '.repeat(900); // 900 words
        const chunks = Chunker.splitText(text, { chunkSize: 300, chunkOverlap: 50 });

        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            const count = Chunker.countWords(chunk);
            expect(count).toBeLessThanOrEqual(350);
        }
    });

    it('should respect paragraph boundaries when splitting (with 0 overlap)', () => {
        const p1 = 'First paragraph block containing several words to check the behavior of the splitter.';
        const p2 = 'Second paragraph block which is separated by double newlines from the first one.';
        const text = `${p1}\n\n${p2}`;

        // Set chunkSize small enough to separate them, but large enough to fit each, with 0 overlap
        const chunks = Chunker.splitText(text, { chunkSize: 20, chunkOverlap: 0 });
        expect(chunks).toContain(p1);
        expect(chunks).toContain(p2);
        expect(chunks.length).toBe(2);
    });

    it('should maintain word overlap between consecutive chunks', () => {
        const parts = [
            'paragraph one content here.',
            'paragraph two content here.',
            'paragraph three content here.'
        ];
        const text = parts.join('\n\n');

        // Split with size that forces splitting (chunkSize 7 words, overlap 2 words)
        const chunks = Chunker.splitText(text, { chunkSize: 7, chunkOverlap: 2 });
        
        expect(chunks.length).toBe(3);
        // Chunk 1 contains part 1
        expect(chunks[0]).toContain('paragraph one');
        // Chunk 2 starts with overlap from chunk 1 ('content here.')
        expect(chunks[1]).toContain('content here.');
        expect(chunks[1]).toContain('paragraph two');
    });

    it('should handle edge cases like empty string or tiny string gracefully', () => {
        expect(Chunker.splitText('')).toEqual([]);
        expect(Chunker.splitText('   ')).toEqual([]);

        const tiny = 'Hello world';
        const chunks = Chunker.splitText(tiny, { chunkSize: 100, chunkOverlap: 10 });
        expect(chunks).toEqual([tiny]);
    });

    it('should throw error for invalid configurations', () => {
        expect(() => {
            Chunker.splitText('some text', { chunkSize: 50, chunkOverlap: 50 });
        }).toThrow();
        expect(() => {
            Chunker.splitText('some text', { chunkSize: 50, chunkOverlap: 60 });
        }).toThrow();
    });
});
