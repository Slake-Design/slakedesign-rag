require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { embeddingModel } = require('../src/config/gemini');
const documentRepository = require('../src/repositories/document.repository');

// Load dataset
const datasetPath = path.join(__dirname, 'stripe_questions.json');
if (!fs.existsSync(datasetPath)) {
    console.error(`Error: Questions file not found at ${datasetPath}`);
    process.exit(1);
}
const questions = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

async function evaluate() {
    console.log(`Starting RAG Retrieval Evaluation on ${questions.length} test queries...`);
    console.log('='.repeat(80));

    let hits = 0;
    let totalLatency = 0;
    let totalRetrievedChunks = 0;
    let totalEstimatedTokens = 0;

    const results = [];

    for (let idx = 0; idx < questions.length; idx++) {
        const item = questions[idx];
        const { question, expected_source } = item;
        const t0 = Date.now();

        try {
            // 1. Embed query
            const embedRes = await embeddingModel.embedContent(question);
            const embedding = embedRes.embedding.values;

            // 2. Perform Cosine Similarity RPC
            const matches = await documentRepository.matchDocuments(
                embedding,
                0.48, // Default threshold
                6     // Top-K = 6
            );

            const latency = Date.now() - t0;
            totalLatency += latency;
            totalRetrievedChunks += matches.length;

            // 3. Evaluate if expected_source matches
            let isHit = false;
            let matchedDoc = null;
            
            for (const match of matches) {
                const sourceField = match.metadata?.source || '';
                const pathField = match.metadata?.path || '';
                const urlField = match.url || '';
                const contentField = match.content || '';

                if (
                    sourceField.toLowerCase().includes(expected_source.toLowerCase()) ||
                    pathField.toLowerCase().includes(expected_source.toLowerCase()) ||
                    urlField.toLowerCase().includes(expected_source.toLowerCase()) ||
                    contentField.toLowerCase().includes(expected_source.toLowerCase())
                ) {
                    isHit = true;
                    matchedDoc = match;
                    break;
                }
            }

            if (isHit) hits++;

            // Calculate estimated token size (1 word ≈ 1.3 tokens or 4 chars ≈ 1 token)
            const chunkTokens = matches.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);
            totalEstimatedTokens += chunkTokens;

            console.log(`[Q ${idx + 1}/${questions.length}] "${question.substring(0, 45)}..."`);
            console.log(`     Latency: ${latency}ms | Retrieved: ${matches.length} | Hit: ${isHit ? '✓ YES' : '✗ NO'}`);
            if (isHit && matchedDoc) {
                const sourceInfo = matchedDoc.metadata?.source || matchedDoc.metadata?.path || matchedDoc.url || 'Database Content';
                console.log(`     Matched Source: ${sourceInfo}`);
            }
            console.log('-'.repeat(60));

            results.push({
                question,
                expected_source,
                latency,
                retrievedCount: matches.length,
                isHit,
                estimatedTokens: chunkTokens
            });

        } catch (err) {
            console.error(`[Q ${idx + 1} Failed] ${err.message}`);
            results.push({
                question,
                expected_source,
                error: err.message,
                isHit: false
            });
        }
    }

    const hitRate = (hits / questions.length) * 100;
    const avgLatency = totalLatency / questions.length;
    const avgRetrieved = totalRetrievedChunks / questions.length;
    const avgTokens = totalEstimatedTokens / questions.length;

    console.log('='.repeat(80));
    console.log('                   RETRIEVAL EVALUATION RESULTS');
    console.log('='.repeat(80));
    console.log(`  Total Queries Evaluated: ${questions.length}`);
    console.log(`  Retrieval Hit Rate:     ${hitRate.toFixed(2)}%`);
    console.log(`  Average Latency:        ${avgLatency.toFixed(2)} ms`);
    console.log(`  Average Chunks Fetched: ${avgRetrieved.toFixed(2)}`);
    console.log(`  Average Context Size:   ${avgTokens.toFixed(2)} estimated tokens`);
    console.log('='.repeat(80));
}

evaluate().catch(console.error);
