// Creates or updates the auth database tables when the server starts (instrumentation.ts). Uses the same options
// as the running auth, so the schema cannot drift from it.
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth";

export async function migrateAuth() {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
  if (toBeCreated.length || toBeAdded.length) {
    await runMigrations();
    console.log(`auth database: created [${toBeCreated.map((t) => t.table).join(", ")}], columns added to [${toBeAdded.map((t) => t.table).join(", ")}]`);
  } else {
    console.log("auth database: up to date");
  }
}
