// Security audit pass: verified no hardcoded secrets in version control
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

// Numeric hop count, never `true`: express-rate-limit rejects `true` outright
// because it lets any caller forge X-Forwarded-For and bypass the limit. Only a
// non-negative integer is honoured; anything else falls back to the calibrated
// default, so a typo cannot silently widen or invalidate the trust setting.
//
// Measured 2026-08-21 against the deployed service: five plain requests to /health,
// sending no X-Forwarded-For of their own, each reported a 2-entry chain (Cloudflare
// then the Render load balancer). A control confirmed the mechanism -- forging one
// entry produced 3, forging two produced 4 -- so the infrastructure contributes
// exactly 2 and client-supplied entries only extend the untrusted left-hand end.
// Express counts from the right, so req.ip lands on the real client at hop 2 and a
// forged header cannot move it.
//
// The committed default is the measured value rather than 0 so an unset environment
// variable yields correct keying instead of one shared bucket. The cost of that
// choice: if the deployment topology ever changes, this number over-trusts the chain
// until it is re-measured. Re-measure before assuming it still holds.
const CALIBRATED_TRUST_PROXY_HOPS = 2;
// An empty or blank variable counts as unset. Number('') is 0, which is a valid
// non-negative integer, so without this an operator who sets TRUST_PROXY_HOPS= in the
// dashboard would silently reinstate the shared-bucket bug this calibration removed.
const rawTrustProxyHops = String(process.env.TRUST_PROXY_HOPS ?? '').trim();
const parsedTrustProxyHops = rawTrustProxyHops === '' ? NaN : Number(rawTrustProxyHops);
const TRUST_PROXY_HOPS = Number.isInteger(parsedTrustProxyHops) && parsedTrustProxyHops >= 0
    ? parsedTrustProxyHops
    : CALIBRATED_TRUST_PROXY_HOPS;
app.set('trust proxy', TRUST_PROXY_HOPS);

app.use(cors({
    origin: '*'
}));
app.use(express.json());

// PUBLIC PORTFOLIO DEMO RATE LIMIT:
// This is a public demo backend. To protect against paid Gemini API credit abuse and potential DoS
// cost spikes, the limit is 10 requests per hour per IP. This balances recruiter usability
// (allowing comfortable testing of RAG & domain controls) with API budget protection.
//
// Per-IP is real as of the 2026-08-21 calibration above: the key is req.ip, which now resolves
// through 2 trusted proxy hops to the client rather than to the load balancer. Before that it
// resolved to the proxy, so every visitor shared one bucket.
const RATE_LIMIT_MESSAGE = Object.freeze({
    error: 'Rate limit exceeded. To protect API budgets, this demo allows up to 10 questions per hour.'
});

const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: RATE_LIMIT_MESSAGE,
    // /query/health is an operational probe, not a demo query, but it sits inside this
    // mount -- so every health check was spending a visitor's quota. Exempted rather
    // than deleted: Render's configured Health Check Path is not in version control, so
    // removing the route could fail deploys. req.path is mount-relative here, meaning
    // '/health' for /query/health and '/' for the query endpoint itself.
    skip: (req) => req.path === '/health'
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

// Only bind when run directly, so tests can require the configured app.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`--- SLAKE DESIGN RAG ENGINE ---`);
        console.log(`Status: Operational`);
        console.log(`Port: ${PORT}`);
        console.log(`Primary Query Endpoint: http://localhost:${PORT}/query`);
    });
}

module.exports = app;
module.exports.RATE_LIMIT_MESSAGE = RATE_LIMIT_MESSAGE;