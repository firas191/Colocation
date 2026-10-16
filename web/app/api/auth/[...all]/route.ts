// Better Auth's own endpoints (sign-in, sign-up, e-mail check links, password reset links).
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/server/auth";

export const { GET, POST } = toNextJsHandler(auth);
