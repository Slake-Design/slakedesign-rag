require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });

const GUIDES = [
    'https://docs.stripe.com/billing/subscriptions/webhooks',   // subs + webhooks [web:113]
    'https://docs.stripe.com/webhooks/quickstart',              // webhook quickstart [web:139]
    'https://docs.stripe.com/webhooks'                          // webhooks overview [web:84]
];

function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const Chunker = require('./src/ingestion/chunker');

async function main() {
    for (const url of GUIDES) {
        console.log('Fetching', url);
        const res = await fetch(url);
        const html = await res.text();
        const text = stripHtml(html);
        const chunks = Chunker.splitText(text, { chunkSize: 400, chunkOverlap: 50 });
        console.log(`Got ${chunks.length} chunks from ${url}`);

        for (const c of chunks) {
            try {
                const emb = await embeddingModel.embedContent(c);
                const embedding = emb.embedding.values;

                const { error } = await supabase.from('documents').insert({
                    content: c,
                    embedding,
                    doc_type: 'guide',
                    url,
                    metadata: { source: url, kind: 'stripe-narrative' }
                });

                if (error) {
                    console.error('Insert error', error.message);
                } else {
                    console.log('Inserted guide chunk for', url);
                }

                // small delay to avoid any burst on Gemini or Supabase
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                console.error('Embed error', e.message);
            }
        }
    }
    console.log('Done ingesting Stripe guides.');
}

main().catch(console.error);