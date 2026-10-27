# NestJS playbook

Follow `generic.md`; these are the NestJS specifics.

- **Module**: `ServexaIntegrationModule` with `ServexaClientService`, `ServexaSettingsService`, `ServexaWebhookController` (optional), `ServexaAdminController`. Import `HttpModule` or use global `fetch`; do not add a second HTTP library if the project has one.
- **Settings**: a TypeORM/Prisma entity for the single settings row; encrypt secrets with the project's existing crypto service. `ConfigService` supplies only the fallback `SERVEXA_BASE_URL`.
- **Authorisation**: reuse the project's role guard (`@Roles('SUPER_ADMIN')` or its permission decorator) on the admin controller; never expose the key in a response DTO (use `@Exclude()` / a view DTO).
- **Webhook**: enable `rawBody: true` in `NestFactory.create` and read `req.rawBody`; verify in a guard; de-duplicate `eventId` in the database.
- **DTOs**: mirror the contract's request rules (`class-validator` decorators) for any body your application accepts that it then forwards; for Servexa's own request bodies use the OpenAPI-generated types.
- **Tests**: Jest + `@nestjs/testing`; override the HTTP layer with a fake Servexa; one e2e for the admin guard.
