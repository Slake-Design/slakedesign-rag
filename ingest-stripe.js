require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const spec = require('./stripe-spec.json');

const MAX_CHUNKS = 800;
let totalChunks = 0;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function embedWithBackoff(model, text, attempt = 0) {
    try {
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (err) {
        const is429 = err.message && (err.message.includes('429') || err.message.includes('quota'));
        if (is429 && attempt < 5) {
            const delay = 15000 * Math.pow(2, attempt);
            console.warn(`429 — waiting ${delay / 1000}s (attempt ${attempt + 1}/5)`);
            await sleep(delay);
            return embedWithBackoff(model, text, attempt + 1);
        }
        throw err;
    }
}

async function main() {
    console.log('Starting Stripe OpenAPI ingestion...');
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });

    for (const path of Object.keys(spec.paths)) {
        const pathObj = spec.paths[path];
        for (const method of Object.keys(pathObj)) {
            if (totalChunks >= MAX_CHUNKS) {
                console.log(`\nReached ${MAX_CHUNKS} chunks. Done for today.`);
                process.exit(0);
            }

            const op = pathObj[method];
            const text = [
                `${method.toUpperCase()} ${path}`,
                op.summary || '',
                op.description || '',
                op.parameters ? 'Parameters: ' + op.parameters.map(p => `${p.name}: ${p.description || ''}`).join(', ') : '',
            ].filter(Boolean).join('\n');

            if (text.length < 50) continue;

            try {
                const embedding = await embedWithBackoff(model, text);
                const { error } = await supabase.from('documents').insert({
                    content: text,
                    embedding,
                    metadata: {
                        source: `stripe-api`,
                        path,
                        method: method.toUpperCase()
                    }
                });
                if (!error) {
                    totalChunks++;
                    console.log(`✓ [${totalChunks}/${MAX_CHUNKS}] ${method.toUpperCase()} ${path}`);
                } else {
                    console.error('Insert error:', error.message);
                }
                await sleep(800);
            } catch (err) {
                console.error(`Failed ${method} ${path}: ${err.message}`);
            }
        }
    }
    console.log(`\nDone. Total chunks inserted: ${totalChunks}`);
}

main();