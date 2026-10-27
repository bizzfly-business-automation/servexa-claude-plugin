# Generic playbook (any stack)

Use this when no stack-specific playbook fits, and as the checklist the others refine.

## Layout to create (names follow the repository's own conventions)

| Part | Responsibility |
|---|---|
| `servexa` client module | One place that talks to Servexa: reads base URL + key from the settings store at call time, adds `Authorization: Bearer`, timeouts, retries (429/5xx), error taxonomy, envelope unwrap. Nothing else calls Servexa directly. |
| Settings store | Encrypted-at-rest (or the project's best equivalent) storage for the key and webhook secret; plain storage for Base URL and Public Issue Code. Write-only for secrets: the UI never reads a secret back, only "set / not set". |
| Super Admin page | "Servexa Integration": key (masked), Base URL, Public Issue Code, webhook secret (if used), Save & Connect, live status, Request / Retry Connection. Server-side authorisation by role, not just a hidden menu item. |
| Support + Feature flows | Two separate modules. Map the application's record id to `externalReferenceId`; the signed-in user to `externalUserId`/name/email. |
| Webhook endpoint (optional) | Raw-body capture, HMAC check, timestamp tolerance, `eventId` de-duplication, 2xx fast, work queued. |
| Pre-login form | Public route/component, no auth, Public Issue Code, honeypot field if the contract has one. |
| Chat (optional) | Server route that looks up the public integration config (cached, validated, fail closed) and a session route that exchanges the signed-in user for a chat session token. |

## Types

Generate request/response types from `servexa_get_openapi` for the areas in use (`tickets`, `features`, `pre-login`, `auth`, `chat`). If the stack has no OpenAPI generator, write the types by hand from `servexa_get_contract` with `format: "full"` and check every body with `servexa_validate_payload`.

## Tests to add

- Client: sends the Bearer header, never a project id, retries 503 then succeeds, does not retry 400, surfaces a 401 as a "reconnect" state, never logs the key.
- Idempotency: the same record submitted twice yields one Servexa ticket.
- Panel: a non-Super-Admin cannot read or write the settings; a secret is never returned by the settings API.
- Webhook (if built): good signature accepted; wrong secret, tampered body, missing header, stale timestamp rejected; replayed `eventId` ignored.
- Pre-login: works with no session or cookie.
