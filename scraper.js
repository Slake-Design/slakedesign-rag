require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MAX_CHUNKS = 900;
let totalChunks = 0;

const STRIPE_URLS = [
  'https://docs.stripe.com/payments/accept-a-payment',
  'https://docs.stripe.com/payments/payment-intents',
  'https://docs.stripe.com/payments/checkout',
  'https://docs.stripe.com/billing/subscriptions/overview',
  'https://docs.stripe.com/invoicing/overview',
  'https://docs.stripe.com/webhooks',
  'https://docs.stripe.com/refunds',
  'https://docs.stripe.com/disputes',
  'https://docs.stripe.com/payouts',
  'https://docs.stripe.com/connect/overview',
  'https://docs.stripe.com/tax/overview',
  'https://docs.stripe.com/radar/overview',
  'https://docs.stripe.com/payments/3d-secure',
  'https://docs.stripe.com/payments/bank-transfers',
  'https://docs.stripe.com/payments/link',
  'https://docs.stripe.com/billing/customer',
  'https://docs.stripe.com/billing/invoices/overview',
  'https://docs.stripe.com/billing/taxes/tax-rates',
  'https://docs.stripe.com/connect/charges',
  'https://docs.stripe.com/connect/payouts-bank-accounts'
];

function chunkText(text, size = 300) {
  const words = text.split(' ');
  const chunks = [];
  let current = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= size) {
      chunks.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function embedWithBackoff(model, chunk, attempt = 0) {
  try {
    const result = await model.embedContent(chunk);
    return result.embedding.values;
  } catch (err) {
    const is429 = err.message && (err.message.includes('429') || err.message.includes('quota'));
    if (is429 && attempt < 5) {
      const delay = 10000 * Math.pow(2, attempt);
      console.warn(`429 hit — waiting ${delay / 1000}s before retry (attempt ${attempt + 1}/5)`);
      await sleep(delay);
      return embedWithBackoff(model, chunk, attempt + 1);
    }
    throw err;
  }
}

async function scrapeAndIngest(url) {
  try {
    console.log(`\nScraping: ${url}`);
    const { data: html } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000
    });
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header').remove();
    const text = $('main, article, .content, body').text()
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || text.length < 100) {
      console.log(`Skipping — no content`);
      return 0;
    }

    const chunks = chunkText(text);
    console.log(`Found ${chunks.length} chunks`);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_EMBEDDING_MODEL });

    let inserted = 0;
    for (const chunk of chunks) {
      if (totalChunks >= MAX_CHUNKS) {
        console.log('\nReached daily limit of 900 chunks. Run again tomorrow.');
        process.exit(0);
      }
      try {
        const embedding = await embedWithBackoff(model, chunk);
        const { error } = await supabase.from('documents').insert({
          content: chunk,
          embedding,
          metadata: { source: url }
        });
        if (!error) {
          inserted++;
          totalChunks++;
          console.log(`Chunk ${totalChunks}/900 inserted`);
        } else {
          console.error('Insert error:', error.message);
        }
        await sleep(2000);
      } catch (err) {
        console.error(`Chunk failed: ${err.message}`);
      }
    }
    console.log(`✓ ${url} — ${inserted} chunks inserted`);
    return inserted;
  } catch (err) {
    console.error(`Failed to scrape ${url}: ${err.message}`);
    return 0;
  }
}

async function main() {
  console.log('Starting Stripe docs ingestion (rate-limited)...');
  let total = 0;
  for (const url of STRIPE_URLS) {
    const count = await scrapeAndIngest(url);
    total += count;
    await sleep(3000);
  }
  console.log(`\nDone. Total chunks inserted: ${total}`);
}

main();