import { prisma } from "../../lib/prisma";

export interface KnowledgeHit {
  id: string;
  title: string;
  excerpt: string;
  score: number;
}

/**
 * Postgres full-text search (English stemming) with a trigram-free ILIKE fallback.
 * The GIN index in migrations keeps this fast for large knowledge bases.
 */
export async function searchKnowledge(tenantId: string, query: string, limit = 4): Promise<KnowledgeHit[]> {
  const rows = await prisma.$queryRaw<{ id: string; title: string; content: string; score: number }[]>`
    SELECT id, title, content,
           ts_rank(to_tsvector('english', title || ' ' || content), websearch_to_tsquery('english', ${query}))::float AS score
    FROM "KnowledgeArticle"
    WHERE "tenantId" = ${tenantId} AND published = true
      AND to_tsvector('english', title || ' ' || content) @@ websearch_to_tsquery('english', ${query})
    ORDER BY score DESC
    LIMIT ${limit}`;
  let hits = rows;
  if (!hits.length) {
    // OR-of-keywords fallback for short / unusual queries
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2).slice(0, 8);
    if (!terms.length) return [];
    const candidates = await prisma.knowledgeArticle.findMany({
      where: { tenantId, published: true, OR: terms.flatMap((t) => [{ title: { contains: t, mode: "insensitive" as const } }, { content: { contains: t, mode: "insensitive" as const } }]) },
      take: 25,
    });
    hits = candidates
      .map((a) => {
        const text = `${a.title} ${a.content}`.toLowerCase();
        return { ...a, score: terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0) / terms.length };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  return hits.map((h) => ({ id: h.id, title: h.title, excerpt: h.content.slice(0, 1500), score: Number(h.score) }));
}
