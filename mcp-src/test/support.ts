import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContractAnswer } from '../src/client.ts';
import type { Config } from '../src/config.ts';

export const TOKEN = 'sgt_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const API_KEY = 'stripe_test_key_placeholder_do_not_use';

/** A small but realistic contract answer (what GET /integrations/contract returns). */
export function makeAnswer(overrides: Partial<ContractAnswer> = {}): ContractAnswer {
  const ticketBody = { type: 'object', properties: { externalReferenceId: { type: 'string', minLength: 1, maxLength: 200 }, title: { type: 'string', minLength: 3, maxLength: 200 }, type: { type: 'string', enum: ['BUG', 'SUPPORT'] }, externalUserEmail: { type: 'string', format: 'email', maxLength: 254 }, nested: { $ref: '#/components/schemas/InnerDto' } }, required: ['externalReferenceId', 'title', 'type'], additionalProperties: false };
  const answer: ContractAnswer = {
    kind: 'servexa-integration-contract',
    schemaVersion: 1,
    minPluginVersion: '0.1.0',
    revision: 18,
    guideVersion: 'sha256:guide18',
    guideSource: 'active',
    contractHash: 'sha256:contract18',
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Servexa integration API', version: '18' },
      servers: [{ url: 'http://127.0.0.1/api/v1' }],
      paths: {
        '/integrations/tickets': { post: { security: [{ integrationKey: [] }], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateTicketDto' } } } } } },
        '/integrations/connection': { get: { security: [{ integrationKey: [] }] } },
        '/public/pre-login-issues': { post: { security: [{ publicIssueCode: [] }], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateTicketDto' } } } } } },
      },
      components: { schemas: { CreateTicketDto: ticketBody, InnerDto: { type: 'object', properties: { a: { type: 'string' } } } }, securitySchemes: { integrationKey: { type: 'http', scheme: 'bearer' }, publicIssueCode: { type: 'apiKey' } } },
    },
    contract: {
      routes: [
        { key: 'POST /integrations/tickets', method: 'POST', path: '/integrations/tickets', public: true, credential: ['integration key (Authorization: Bearer sk_...)'], flag: null, rateLimit: { limit: 60, windowSeconds: 60 }, status: 201, consumes: [], body: 'CreateTicketDto', query: null },
        { key: 'GET /integrations/connection', method: 'GET', path: '/integrations/connection', public: true, credential: ['integration key (Authorization: Bearer sk_...)'], flag: null, rateLimit: { limit: 60, windowSeconds: 60 }, status: 200, consumes: [], body: null, query: null },
        { key: 'POST /public/pre-login-issues', method: 'POST', path: '/public/pre-login-issues', public: true, credential: ['Public Issue Code (projectPublicIssueCode in the JSON body)'], flag: null, rateLimit: { limit: 5, windowSeconds: 60 }, status: 201, consumes: [], body: 'CreateTicketDto', query: null },
      ],
      dtos: [
        { name: 'CreateTicketDto', fields: [{ name: 'externalReferenceId', type: 'String', optional: false, rules: ['isString'], nested: null }, { name: 'nested', type: 'InnerDto', optional: true, rules: ['validateNested'], nested: 'InnerDto' }] },
        { name: 'InnerDto', fields: [{ name: 'a', type: 'String', optional: true, rules: ['isString'], nested: null }] },
      ],
      responses: [],
      widgetUrlRules: null,
    },
    ...overrides,
  };
  return answer;
}

export const GUIDE_MD = ['---', 'servexa-guide-revision: 18', '---', '# PART A — Servexa Integration Spec (authoritative reference)', '## A9. Authentication — `CONFIRMED`', 'Nine.', '## Guide changelog', '### Revision 18 — 2026-10-27', 'eighteen', '### Revision 17 — 2026-10-26', 'seventeen'].join('\n');

export interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  ifNoneMatch: string | undefined;
  body: string;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

export interface Fake {
  server: Server;
  url: string;
  seen: Seen[];
  handler: Handler;
  close: () => Promise<void>;
}

export async function startFake(initial: Handler): Promise<Fake> {
  const fake = { seen: [] as Seen[], handler: initial } as Fake;
  fake.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const seen: Seen = { method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, ifNoneMatch: req.headers['if-none-match'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') };
      fake.seen.push(seen);
      fake.handler(req, res, seen);
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/api/v1`;
  fake.close = () => new Promise<void>((resolve) => { fake.server.closeAllConnections?.(); fake.server.close(() => resolve()); });
  return fake;
}

export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** A Servexa that serves the contract with a strong ETag and answers 304 for a matching If-None-Match. */
export function contractHandler(getAnswer: () => ContractAnswer): Handler {
  return (req, res, seen) => {
    const url = (req.url ?? '').replace('/api/v1', '');
    if (seen.authorization !== `Bearer ${TOKEN}` && url !== '/integrations/connection') return json(res, 401, { message: 'Invalid integration API key' });
    if (url === '/integrations/contract') {
      const body = JSON.stringify(getAnswer());
      const etag = `"sha256-${body.length}-${getAnswer().revision}"`;
      if (seen.ifNoneMatch === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json', etag });
      return res.end(body);
    }
    json(res, 404, { message: 'not found' });
  };
}

export async function tempDir(prefix = 'servexa-mcp-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function testConfig(baseUrl: string, overrides: Partial<Config> = {}): Promise<Config> {
  return { baseUrl, host: new URL(baseUrl).host, docsCredential: TOKEN, credentialKind: 'guide-token', apiKey: undefined, cacheDir: await tempDir('servexa-cache-'), timeoutMs: 3000, maxResponseBytes: 8 * 1024 * 1024, ...overrides };
}

