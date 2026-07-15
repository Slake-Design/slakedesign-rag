/**
 * Chunker Utility
 * Implements a recursive, semantic-aware character/word text splitter.
 * Recursively splits text using structural separators (paragraphs, newlines, spaces)
 * to keep context chunks under the target size while preserving boundary integrity.
 */
class Chunker {
    /**
     * Recursively splits document text into semantic chunks based on word count.
     * @param {string} text - Raw input text.
     * @param {object} options
     * @param {number} [options.chunkSize=350] - Maximum target chunk size in words.
     * @param {number} [options.chunkOverlap=50] - Word overlap count between consecutive chunks.
     * @returns {string[]} Array of text chunks.
     */
    static splitText(text, options = {}) {
        const chunkSize = options.chunkSize !== undefined ? options.chunkSize : 350;
        const chunkOverlap = options.chunkOverlap !== undefined ? options.chunkOverlap : 50;

        if (chunkOverlap >= chunkSize) {
            throw new Error('Invalid Configuration: chunkOverlap must be less than chunkSize.');
        }

        if (!text || !text.trim()) {
            return [];
        }

        // Ordered separators: Paragraphs -> Newlines -> Words -> Empty string
        const separators = ['\n\n', '\n', ' ', ''];

        const splitRecursive = (txt, sepIndex) => {
            const separator = separators[sepIndex];
            const wordCount = Chunker.countWords(txt);

            // Base case: text fits within size or we are at the character level
            if (wordCount <= chunkSize || sepIndex >= separators.length - 1) {
                return [txt];
            }

            const parts = txt.split(separator).filter(p => p !== '');
            const chunks = [];
            let currentChunk = '';

            for (const part of parts) {
                const potentialChunk = currentChunk
                    ? currentChunk + separator + part
                    : part;
                const potentialWordCount = Chunker.countWords(potentialChunk);

                if (potentialWordCount <= chunkSize) {
                    currentChunk = potentialChunk;
                } else {
                    if (currentChunk) {
                        chunks.push(currentChunk);

                        // Extract overlapping words from the end of the current chunk
                        const words = currentChunk.split(/\s+/);
                        const overlapWords = chunkOverlap > 0 ? words.slice(-chunkOverlap).join(' ') : '';

                        // Start next chunk with the overlap and the new part
                        currentChunk = overlapWords ? overlapWords + separator + part : part;
                    } else {
                        // If a single part exceeds chunk size, split it recursively
                        chunks.push(...splitRecursive(part, sepIndex + 1));
                    }
                }
            }

            if (currentChunk) {
                chunks.push(currentChunk);
            }

            return chunks;
        };

        return splitRecursive(text, 0);
    }

    /**
     * Counts words in a string by whitespace splitting.
     * @param {string} str - Input text.
     * @returns {number} The word count.
     */
    static countWords(str) {
        if (!str || !str.trim()) {
            return 0;
        }
        return str.trim().split(/\s+/).length;
    }
}

module.exports = Chunker;
