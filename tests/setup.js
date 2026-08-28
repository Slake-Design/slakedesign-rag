/**
 * Vitest setup, run before each test file's imports are evaluated.
 *
 * This has to be a setup file rather than statements at the top of a test.
 * `src/config/gemini.ts` throws at module scope when GEMINI_API_KEY is unset -
 * deliberately, so a misconfigured deploy fails fast rather than serving broken
 * retrieval. Before the TypeScript port the tests satisfied that by assigning
 * process.env and then calling require(), which runs in source order.
 *
 * The port replaced those require() calls with ESM imports, and imports are
 * HOISTED: they now execute before any statement in the file body, so the
 * assignment came too late and the config threw at import time.
 *
 * Local runs did not catch it because a real .env was present and the key was
 * also exported in the shell. CI has neither, which is exactly what CI is for.
 */
require('dotenv').config();

// A placeholder, never a real credential. No test makes a live API call; the
// Gemini client is dependency-injected as a mock everywhere it is exercised.
if (!process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = 'mock-gemini-key';
}
