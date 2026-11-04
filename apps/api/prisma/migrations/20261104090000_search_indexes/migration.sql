-- Full-text search index for the agent's knowledge base lookups
CREATE INDEX IF NOT EXISTS "KnowledgeArticle_fts_idx"
  ON "KnowledgeArticle" USING GIN (to_tsvector('english', title || ' ' || content));
