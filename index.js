require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

app.use(cors({
    origin: '*'
}));
app.use(express.json());

const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many requests, please try again later.' }
});

app.use('/query', limiter);
app.use('/query-v2', limiter);

app.use('/ingest', require('./routes/ingest'));
app.use('/query', require('./routes/query-v2'));
app.use('/query-v1', require('./routes/query'));
app.use('/query-v2', require('./routes/query-v2'));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`--- SLAKE DESIGN RAG ENGINE ---`);
    console.log(`Status: Operational`);
    console.log(`Port: ${PORT}`);
    console.log(`Primary Query Endpoint: http://localhost:${PORT}/query`);
});