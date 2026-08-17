#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../config.js";
import { createDatabasePool } from "../db/client.js";
import { getMigrationStatus, rollbackMigration, runMigrations } from "../db/migrations.js";

async function main() {
  const command = process.argv[2] ?? "up";
  const config = loadConfig();
  const pool = createDatabasePool(config.database);

  console.log(
    `[Migrate] Running migration command '${command}' against ${config.database.database}...`,
  );

  try {
    if (command === "up") {
      const result = await runMigrations(pool);
      console.log(
        `[Migrate] Successfully applied ${result.appliedCount} migration(s). Current version: ${result.currentVersion}`,
      );
    } else if (command === "down") {
      const targetVersion = process.argv[3] ? Number(process.argv[3]) : 0;
      const result = await rollbackMigration(pool, { targetVersion });
      console.log(
        `[Migrate] Successfully rolled back ${result.rolledBackCount} migration(s). Current version: ${result.currentVersion}`,
      );
    } else if (command === "status") {
      const statuses = await getMigrationStatus(pool);
      console.log("[Migrate] Migration status:");
      for (const s of statuses) {
        console.log(
          `  - Version ${s.version}: ${s.name} [${s.applied ? "APPLIED" : "PENDING"}] (applied at: ${s.appliedAt ?? "N/A"})`,
        );
      }
    } else {
      console.error(`[Migrate] Unknown command '${command}'. Supported: up, down, status`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`[Migrate] Failed to execute migrations:`, error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate.js") || process.argv[1]?.endsWith("migrate.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
