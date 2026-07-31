import path from "path";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// One adapter for both environments: locally the libSQL client opens the
// same SQLite file as before; in production it speaks to Turso over
// libsql:// with the auth token.
function createClient() {
  const adapter = new PrismaLibSql({
    url:
      process.env.TURSO_DATABASE_URL ??
      `file:${path.join(process.cwd(), "dev.db")}`,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
