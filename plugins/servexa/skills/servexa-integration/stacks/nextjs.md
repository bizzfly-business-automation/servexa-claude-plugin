# Next.js playbook

Follow `generic.md`; these are the Next.js specifics.

- **Server only**: every Servexa call lives in server code (route handlers under `app/api/**`, server actions, or `lib/servexa/*.server.ts` marked `import 'server-only'`). The key must never reach a client component or `NEXT_PUBLIC_*`.
- **Settings**: use the project's database (Prisma/Drizzle/etc.) for the single settings row; encrypt secrets; the admin page is a server component or a client form posting to a protected route handler.
- **Authorisation**: check the Super Admin role on the server in every handler and server action (middleware alone is not enough); the settings GET returns `keySet: boolean`, never the key.
- **Webhook**: in a route handler read `await req.text()` (raw body) before parsing; verify the HMAC; de-duplicate `eventId`.
- **Pre-login form**: a client component that posts directly to the pre-login route with the Public Issue Code, or to your own route handler; it must render for signed-out users (`/login`, `/register`, `/forgot-password`, activation and OTP pages).
- **Chat**: a server route that looks up the integration config (cache with `unstable_cache`/`revalidate` of a minute), and a client component that loads only the returned widget URL after the user is signed in.
- **Tests**: the project's runner (Vitest/Jest) for the client and handlers; Playwright only if the repository already uses it.
