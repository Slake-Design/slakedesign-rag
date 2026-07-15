-- Migration 001: Create HNSW Vector Index on Documents Table
-- Objective: Optimize vector similarity searches by avoiding full table sequential scans (KNN).
-- Dimensions: 768 (as configured for models/gemini-embedding-001)

-- Ensure vector extension is loaded
CREATE EXTENSION IF NOT EXISTS vector;

-- Create an HNSW index using cosine similarity operator
CREATE INDEX IF NOT EXISTS documents_embedding_hnsw_idx 
ON documents USING hnsw (embedding vector_cosine_ops);
