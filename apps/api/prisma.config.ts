import { defineConfig } from "prisma/config";

// The CLI (generate, migrate) reads DATABASE_URL. The running API builds its own pg pool.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://fp:fp@localhost:54329/flexipay" },
});
