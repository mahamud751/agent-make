process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/agentdesk_test";
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-0123";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.INLINE_JOBS = "true";
