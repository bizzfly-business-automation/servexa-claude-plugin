# Node + Express playbook

Follow `generic.md`; these are the Express specifics.

- **Client**: a `servexaClient.ts` using the built-in `fetch` (Node 18+) with `AbortSignal.timeout`, or the project's existing HTTP client if it has one. `baseUrl = settings.baseUrl ?? process.env.SERVEXA_BASE_URL`; strip a trailing slash; join paths with a helper so `/api/v1` is never doubled.
- **Settings**: a table/collection `integration_settings` (single row). Encrypt the key and webhook secret with the project's existing encryption helper or Node `crypto` AES-256-GCM using a key from the deployment secrets; if the project has no secret store, ask the user where the master key should live before writing code.
- **Authorisation**: an `requireSuperAdmin` middleware on `GET/PUT /admin/servexa-integration`; the GET returns `{ keySet: boolean, ... }` never the key.
- **Webhook**: mount `express.raw({ type: 'application/json' })` on the webhook route **before** any `express.json()` so the signature is checked over the exact bytes; `crypto.timingSafeEqual` for the comparison; keep a small table of processed `eventId`s.
- **Pre-login**: a plain `fetch` from the browser form is allowed (no secret involved) or a relay route if the project prefers; add the CORS origin to nothing on this side - the call goes to Servexa.
- **Tests**: `supertest` for the admin routes and the webhook; a local fake Servexa (`http.createServer`) for the client.
