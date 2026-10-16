// Accounts (PLATFORM_SPEC 6.3): Better Auth inside the website server, e-mail and password, its own database
// ("auth", AUTH_DATABASE_URL). It knows who is logged in; everything else about the user is the platform's
// (POST /v1/users/sync, GET /v1/me). Roles come from the platform, never from here.
import "server-only";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import { sendMail } from "./mail";

const pool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL, max: 5 });

export const auth = betterAuth({
  appName: "Coloc",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: pool,
  telemetry: { enabled: false },
  user: {
    additionalFields: {
      // The platform user id (app.users.id), stored after the first POST /v1/users/sync. Not settable by users.
      platformUserId: { type: "string", required: false, input: false },
      // Language of the e-mails; chosen on the sign-up page.
      locale: { type: "string", required: false, defaultValue: "fr", input: true },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendMail("reset", user.email, (user as { locale?: string }).locale, url);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail("verify", user.email, (user as { locale?: string }).locale, url);
    },
  },
  session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  rateLimit: { enabled: true, window: 60, max: 30 },
  plugins: [nextCookies()],
});

export type AuthUser = typeof auth.$Infer.Session.user;
