import { execSync } from "node:child_process";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/agentdesk_test";
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
