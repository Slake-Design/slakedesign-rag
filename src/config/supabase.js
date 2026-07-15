const { createClient } = require('@supabase/supabase-js');

/**
 * DATABASE CONFIGURATION & SECURITY STATEMENT
 * 
 * Security Context:
 * - This is a server-side Node.js/Express API. All database calls are executed backend-to-backend.
 * - The SUPABASE_SERVICE_KEY is kept strictly server-side and is never exposed to the frontend/browser client.
 * - The service role key is required here because:
 *   1. It is used for both background document ingestion (writing/updating vectors) and queries.
 *   2. It runs inside a secure, trusted execution environment.
 * - To minimize vulnerability vectors, the database client is isolated from route handlers
 *   and accessed only through a dedicated Repository pattern (document.repository.js).
 */

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Database Initialization Failed: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        persistSession: false,
    }
});

module.exports = { supabase };
