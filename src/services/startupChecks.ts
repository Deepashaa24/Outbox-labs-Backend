import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/prisma.js";

const migrationsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../prisma/migrations"
);

interface MigrationRecord {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

interface MigrationTableResult {
  present: boolean;
}

export async function assertDatabaseReady(): Promise<void> {
  const migrationTable = await prisma.$queryRaw<MigrationTableResult[]>`
    SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS present
  `;
  if (!migrationTable[0]?.present) {
    throw new Error("Prisma migrations have not been applied.");
  }

  const migrationDirectories = await readdir(migrationsPath, { withFileTypes: true });
  const expectedMigrations = migrationDirectories
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const appliedMigrations = await prisma.$queryRaw<MigrationRecord[]>`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `;
  const appliedNames = new Set(appliedMigrations.map((migration) => migration.migration_name));
  const pendingMigrations = expectedMigrations.filter((name) => !appliedNames.has(name));
  const failedMigrations = await prisma.$queryRaw<MigrationRecord[]>`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    WHERE finished_at IS NULL AND rolled_back_at IS NULL
  `;
  const userColumns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'User'
      AND column_name IN ('googleId', 'avatarUrl')
  `;
  const foundColumns = new Set(userColumns.map((column) => column.column_name));
  const missingColumns = ["googleId", "avatarUrl"].filter((column) => !foundColumns.has(column));

  if (pendingMigrations.length > 0 || failedMigrations.length > 0 || missingColumns.length > 0) {
    const reasons = [
      pendingMigrations.length > 0 ? `pending migrations: ${pendingMigrations.join(", ")}` : "",
      failedMigrations.length > 0
        ? `unfinished migrations: ${failedMigrations.map((migration) => migration.migration_name).join(", ")}`
        : "",
      missingColumns.length > 0 ? `missing User columns: ${missingColumns.join(", ")}` : ""
    ].filter(Boolean);
    throw new Error(`Database schema is not up to date (${reasons.join("; ")}).`);
  }
}
