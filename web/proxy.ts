// Next.js 16 "proxy" (formerly middleware): only the language prefix. Who may see a page is decided on the server
// by each page (lib/server/viewer.ts), never here.
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
