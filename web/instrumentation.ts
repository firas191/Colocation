// Runs once when the server starts (Next.js instrumentation). Prepares the auth database.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.AUTH_DATABASE_URL) {
    const { migrateAuth } = await import("./lib/server/auth-migrate");
    await migrateAuth();
  }
}
