const pino = require('pino');
const { getCorrelationId } = require('./context');

/**
 * Strips credentials out of anything resembling a connection URL, plus bare
 * key/token parameters. A last line of defence before an arbitrary error
 * message reaches the log pipeline.
 *
 * `key=` is included alongside the usual names because that is the parameter
 * the Google Generative AI SDK puts the API key in: a failed request URL
 * carries `...?key=<GEMINI_API_KEY>`, and that string reaches error messages.
 */
function redactSecrets(input) {
    return String(input)
        .replace(/(rediss?|https?|postgres(?:ql)?):\/\/[^:/@\s]*:[^@\s]*@/gi, '$1://[REDACTED]@')
        .replace(/\b(password|token|apikey|api_key|secret|key)=([^&\s]+)/gi, '$1=[REDACTED]');
}

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'slakedesign-rag' },
    // Tags every line with the active correlation ID without any call site
    // passing it, so an SSE stream's retrieval, pruning and completion lines
    // can be reassembled even when concurrent streams interleave.
    mixin() {
        const correlationId = getCorrelationId();
        return correlationId ? { correlationId } : {};
    },
    redact: {
        paths: [
            'GEMINI_API_KEY',
            '*.GEMINI_API_KEY',
            'apiKey',
            '*.apiKey',
            'authorization',
            '*.authorization',
            'req.headers.authorization',
            'req.headers.cookie',
            // The question is user input and may contain anything the user typed.
            // Logged deliberately nowhere; censored here in case an object
            // carrying it is ever logged wholesale.
            'question',
            '*.question',
        ],
        censor: '[REDACTED]',
    },
    formatters: {
        log(object) {
            for (const key of ['errMessage', 'msg', 'reason']) {
                if (typeof object[key] === 'string') {
                    object[key] = redactSecrets(object[key]);
                }
            }
            return object;
        },
    },
});

module.exports = { logger, redactSecrets };
