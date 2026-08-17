// Security audit pass: verified no hardcoded secrets in version control
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

app.use(cors({
    origin: '*'
}));
app.use(express.json());

// PUBLIC PORTFOLIO DEMO RATE LIMIT:
// This is a public demo backend. To protect against paid Gemini API credit abuse and potential DoS
// cost spikes, the rate limit is set to 10 requests per hour per IP. This balances recruiter usability
// (allowing comfortable testing of RAG & domain controls) with API budget protection.
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: { error: 'Rate limit exceeded. To protect API budgets, this demo allows up to 10 questions per hour.' }
});

app.use('/query', limiter);

app.use('/query', require('./routes/query'));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Global error handling middleware to sanitize responses.
// The four-parameter signature is load-bearing: Express identifies error-handling
// middleware by arity, so dropping the unused `next` would silently demote this to
// ordinary middleware and stop it catching anything.
app.use((err, req, res, next) => {
    console.error('[Global Error]', err);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`--- SLAKE DESIGN RAG ENGINE ---`);
    console.log(`Status: Operational`);
    console.log(`Port: ${PORT}`);
    console.log(`Primary Query Endpoint: http://localhost:${PORT}/query`);
});