import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Runs before each test file's imports are evaluated, which is the only
        // place environment setup can live now that the test files use ESM
        // imports. See tests/setup.js.
        setupFiles: ['./tests/setup.js'],
    },
});
