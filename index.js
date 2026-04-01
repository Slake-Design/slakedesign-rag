require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
    origin: '*'
}));
app.use(express.json());

// Main RAG endpoints
app.use('/ingest', require('./routes/ingest'));

// Primary Production Route (now using the v2 "Assembler" logic)
app.use('/query', require('./routes/query-v2'));

// Legacy/Comparison Route
app.use('/query-v1', require('./routes/query'));
app.use('/query-v2', require('./routes/query-v2'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`--- SLAKE DESIGN RAG ENGINE ---`);
    console.log(`Status: Operational`);
    console.log(`Port: ${PORT}`);
    console.log(`Primary Query Endpoint: http://localhost:${PORT}/query`);
});