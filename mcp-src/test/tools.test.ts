import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCheck } from '../src/check.ts';
import { ServexaClient } from '../src/client.ts';
import { compareToLock, readLock, resolveInside } from '../src/lock.ts';
import { exampleFor, validatePayload } from '../src/schema.ts';
import { TOOLS, areaOf, filterOpenApi, toolByName } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { API_KEY, TOKEN, contractHandler, json, makeAnswer, startFake, tempDir, testConfig } from './support.ts';
import type { Fake } from './support.ts';

const noSleep = async () => undefined;
let fake: Fake;
let workspace: string;
let answer = makeAnswer();
let diffBody: unknown;

async function ctx(extra: Partial<Parameters<typeof testConfig>[1]> = {}): Promise<ToolContext> {
  const config = await testConfig(fake.url, extra);
  return { env: {}, config, client: new ServexaClient(config, { sleep: noSleep }), workspace };
}
const call = async (name: string, args: Record<string, unknown>, context: ToolContext): Promise<any> => toolByName(name)!.handler(args, context);

beforeEach(async () => {
  answer = makeAnswer();
  diffBody = undefined;
  workspace = await tempDir('servexa-ws-');
  fake = await startFake((req, res, seen) => {
    const url = (req.url ?? '').replace('/api/v1', '');
    if (url === '/integrations/connection') {
      if (seen.authorization !== `Bearer ${API_KEY}`) return json(res, 401, { message: 'Invalid integration API key' });
      return json(res, 200, { success: true, data: { connected: true, status: 'ACTIVE', project: { id: 'PROJECT-UUID', name: 'Dizola', code: 'DZ', prefix: 'DZ', integrationStatus: 'ACTIVE' } } });
    }
    if (url === '/integrations/capabilities') return json(res, 200, { kind: 'servexa-integration-capabilities', publicIssueCode: 'pic_abc' });
    if (url.startsWith('/integrations/contract/changes')) return json(res, 200, { currentRevision: 18, since: 17, entries: [{ revision: 18, date: '2026-10-27', body: 'eighteen' }] });
    if (url === '/integrations/contract/diff') {
      diffBody = JSON.parse(seen.body);
      return json(res, 201, { currentRevision: 18, contractHash: 'sha256:contract18', changed: true, counts: { breaking: 1, behavioural: 0, additive: 0 }, changes: [{ severity: 'breaking', kind: 'route-removed', route: 'GET /integrations/old', text: 'route removed' }] });
    }
    contractHandler(() => answer)(req, res, seen);
  });
});
afterEach(async () => fake.close());

describe('tool list', () => {
  it('has the documented tools, each with an object schema and a description', () => {
    assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
      'servexa_check_managed_files', 'servexa_example_request', 'servexa_get_capabilities', 'servexa_get_changes', 'servexa_get_contract', 'servexa_get_guide_section', 'servexa_get_openapi',
      'servexa_list_guide_sections', 'servexa_record_integration', 'servexa_status', 'servexa_validate_payload', 'servexa_verify_connection',
    ]);
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 40);
    }
    assert.deepEqual(TOOLS.filter((t) => !t.readOnly).map((t) => t.name), ['servexa_record_integration']);
  });
});

describe('contract tools', () => {
  it('summarises routes by area, and adds request bodies in full format', async () => {
    const c = await ctx();
    const summary = await call('servexa_get_contract', { area: 'tickets' }, c);
    assert.deepEqual(summary.routes.map((r: { key: string }) => r.key), ['POST /integrations/tickets']);
    assert.equal(summary.dtos, undefined);
    const full = await call('servexa_get_contract', { area: 'tickets', format: 'full' }, c);
    assert.deepEqual(full.dtos.map((d: { name: string }) => d.name).sort(), ['CreateTicketDto', 'InnerDto']);
    await assert.rejects(call('servexa_get_contract', { area: 'bogus' }, c), { code: 'INVALID_INPUT' });
  });

  it('classifies routes into areas', () => {
    assert.equal(areaOf({ path: '/external-chat/conversations/:id' }), 'chat');
    assert.equal(areaOf({ path: '/public/pre-login-issues/capabilities' }), 'pre-login');
    assert.equal(areaOf({ path: '/integrations/contract/diff' }), 'tooling');
  });

  it('narrows the OpenAPI document to an area and keeps only the schemas and schemes it uses', async () => {
    const doc = filterOpenApi(answer.openapi, 'tickets');
    assert.deepEqual(Object.keys(doc.paths), ['/integrations/tickets']);
    assert.deepEqual(Object.keys(doc.components.schemas).sort(), ['CreateTicketDto', 'InnerDto']);
    assert.deepEqual(Object.keys(doc.components.securitySchemes), ['integrationKey']);
  });

  it('validates a request body and reports every problem with its path', async () => {
    const c = await ctx();
    const bad = await call('servexa_validate_payload', { route: 'post /integrations/tickets', payload: { title: 'hi', type: 'NOPE', extra: 1, externalUserEmail: 'x' } }, c);
    assert.equal(bad.valid, false);
    const messages = bad.problems.map((p: { path: string; message: string }) => `${p.path} ${p.message}`);
    assert.ok(messages.some((m: string) => m.startsWith('$.externalReferenceId is required')));
    assert.ok(messages.some((m: string) => m.startsWith('$.title must be at least 3')));
    assert.ok(messages.some((m: string) => m.startsWith('$.type must be one of')));
    assert.ok(messages.some((m: string) => m.startsWith('$.extra is not an accepted field')));
    assert.ok(messages.some((m: string) => m.startsWith('$.externalUserEmail must be a valid email')));
    const good = await call('servexa_validate_payload', { route: 'POST /integrations/tickets', payload: { externalReferenceId: 'abc', title: 'A title', type: 'BUG' } }, c);
    assert.deepEqual(good, { route: 'POST /integrations/tickets', dto: 'CreateTicketDto', valid: true, problems: [] });
    await assert.rejects(call('servexa_validate_payload', { route: 'POST /nope', payload: {} }, c), { code: 'NOT_FOUND' });
  });

  it('builds an example that its own validator accepts, with a placeholder instead of a credential', async () => {
    const c = await ctx();
    const example = await call('servexa_example_request', { route: 'POST /integrations/tickets', includeOptional: true }, c);
    assert.equal(example.successStatus, 201);
    assert.match(example.headers.Authorization, /never hard-code/);
    assert.ok(!JSON.stringify(example).includes(TOKEN));
    assert.deepEqual(validatePayload(example.body, { $ref: '#/components/schemas/CreateTicketDto' }, answer.openapi.components.schemas), []);
  });
});

describe('status, changes and connection', () => {
  it('reports the server, the credential kind (never the credential) and the repository state', async () => {
    const c = await ctx();
    const status = await call('servexa_status', {}, c);
    assert.equal(status.configured, true);
    assert.equal(status.server.revision, 18);
    assert.equal(status.repository.state, 'unrecorded');
    assert.ok(!JSON.stringify(status).includes(TOKEN));
  });

  it('answers a missing configuration with a hint instead of failing', async () => {
    const status = await call('servexa_status', {}, { env: {}, workspace } as ToolContext);
    assert.equal(status.configured, false);
    assert.match(status.hint, /Base URL/);
  });

  it('returns the changelog and, with a snapshot in the repository, the classified diff', async () => {
    const c = await ctx();
    const without = await call('servexa_get_changes', { since: 17 }, c);
    assert.equal(without.diff, null);
    assert.match(without.diffNote, /No contract snapshot/);
    assert.equal(without.changelog[0].revision, 18);

    await mkdir(join(workspace, '.servexa'));
    await writeFile(join(workspace, '.servexa', 'contract.snapshot.json'), JSON.stringify({ contract: makeAnswer({ revision: 17 }).contract }));
    const withDiff = await call('servexa_get_changes', { since: 17 }, c);
    assert.equal(withDiff.diff.counts.breaking, 1);
    assert.equal((diffBody as { previous: { routes: unknown[] } }).previous.routes.length, 3, 'the snapshot was sent as the previous contract');
  });

  it('verifies the connection with the integration key and returns status only', async () => {
    const result = await call('servexa_verify_connection', {}, await ctx({ apiKey: API_KEY }));
    assert.deepEqual(result, { connected: true, status: 'ACTIVE', applicationName: 'Dizola', integrationStatus: 'ACTIVE' });
    assert.ok(!JSON.stringify(result).includes('PROJECT-UUID'));
    await assert.rejects(call('servexa_verify_connection', {}, await ctx()), { code: 'NOT_CONFIGURED' });
  });
});

describe('recording an integration', () => {
  it('writes the lock and the snapshot, hashes the managed files, and later tells hand edits apart', async () => {
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'servexa.ts'), 'export const a = 1;\r\n');
    const c = await ctx();
    const recorded = await call('servexa_record_integration', { managedFiles: ['src/servexa.ts', 'src/missing.ts'], decisions: { stack: 'express' } }, c);
    assert.equal(recorded.integratedRevision, 18);
    assert.deepEqual(recorded.missingFiles, ['src/missing.ts']);
    const lock = await readLock(workspace);
    assert.equal(lock?.managedFiles.length, 1);
    assert.equal(lock?.decisions.stack, 'express');
    assert.ok(!JSON.stringify(lock).includes(TOKEN));
    assert.equal(JSON.parse(await readFile(join(workspace, '.servexa', 'contract.snapshot.json'), 'utf8')).contract.routes.length, 3);

    // CRLF vs LF does not count as an edit; a real change does.
    await writeFile(join(workspace, 'src', 'servexa.ts'), 'export const a = 1;\n');
    assert.deepEqual((await call('servexa_check_managed_files', {}, c)).files, [{ path: 'src/servexa.ts', state: 'unchanged' }]);
    await writeFile(join(workspace, 'src', 'servexa.ts'), 'export const a = 2;\n');
    assert.deepEqual((await call('servexa_check_managed_files', {}, c)).files, [{ path: 'src/servexa.ts', state: 'edited' }]);
  });

  it('refuses paths that leave the repository', async () => {
    const c = await ctx();
    for (const bad of ['../outside.txt', '/etc/passwd', 'a/../../b', 'C:\\Windows\\win.ini', '']) {
      await assert.rejects(call('servexa_record_integration', { managedFiles: [bad] }, c), { code: 'INVALID_INPUT' }, bad);
    }
    await assert.rejects(resolveInside(workspace, 'ok/../../x'), { code: 'INVALID_INPUT' });
  });

  it('refuses a managed file that is a link leading out of the repository', async (t) => {
    const outside = await tempDir('servexa-outside-');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(outside, join(workspace, 'linked'), 'junction');
    } catch {
      t.skip('this machine cannot create links');
      return;
    }
    await assert.rejects(call('servexa_record_integration', { managedFiles: ['linked/secret.txt'] }, await ctx()), { code: 'INVALID_INPUT' });
  });

  it('does not record while Servexa cannot be reached (a stale revision would be a false record)', async () => {
    const c = await ctx();
    await call('servexa_get_contract', {}, c); // fills the cache
    await fake.close();
    const offline = await testConfig(fake.url, { timeoutMs: 300 });
    const offlineCtx: ToolContext = { env: {}, config: offline, client: new ServexaClient({ ...offline, cacheDir: (c.config as { cacheDir: string }).cacheDir }, { sleep: noSleep }), workspace };
    await assert.rejects(call('servexa_record_integration', { managedFiles: [] }, offlineCtx), { code: 'UNREACHABLE' });
    fake = await startFake(() => undefined);
  });
});

describe('lock comparison and --check', () => {
  const lockFor = (revision: number, hash: string) => ({ schema: 1 as const, baseUrlHost: 'h', integratedRevision: revision, contractHash: hash, pluginVersion: '0.1.0', integratedAt: 'x', managedFiles: [], decisions: {} });

  it('is current, behind or unrecorded', () => {
    assert.equal(compareToLock(null, answer).state, 'unrecorded');
    assert.equal(compareToLock(lockFor(18, 'sha256:contract18'), answer).state, 'current');
    const behind = compareToLock(lockFor(16, 'sha256:contract18'), answer);
    assert.deepEqual([behind.state, behind.behindBy, behind.contractChanged], ['behind', 2, false]);
    assert.equal(compareToLock(lockFor(18, 'sha256:other'), answer).state, 'behind');
  });

  it('exits 0 current, 10 behind, 20 when nothing was recorded or Servexa cannot be asked', async () => {
    const env = { SERVEXA_BASE_URL: fake.url, SERVEXA_GUIDE_TOKEN: TOKEN, SERVEXA_PROJECT_DIR: workspace, SERVEXA_MCP_CACHE_DIR: await tempDir('servexa-cache-') };
    assert.equal((await runCheck(env)).code, 20);
    await mkdir(join(workspace, '.servexa'));
    await writeFile(join(workspace, '.servexa', 'integration.json'), JSON.stringify(lockFor(18, 'sha256:contract18')));
    assert.equal((await runCheck(env)).code, 0);
    await writeFile(join(workspace, '.servexa', 'integration.json'), JSON.stringify(lockFor(15, 'sha256:contract18')));
    const behind = await runCheck(env);
    assert.equal(behind.code, 10);
    assert.equal(behind.report.behindBy, 3);
    assert.equal((await runCheck({ ...env, SERVEXA_GUIDE_TOKEN: '' })).code, 20);
  });
});

describe('schema helpers', () => {
  const schemas = { A: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 5 }, list: { type: 'array', items: { type: 'string' }, maxItems: 2 }, code: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,64}$' } }, required: ['n'], additionalProperties: false } };
  it('checks numbers, arrays and patterns', () => {
    assert.deepEqual(validatePayload({ n: 3, list: ['a'], code: 'abcdefgh' }, { $ref: '#/components/schemas/A' }, schemas), []);
    assert.equal(validatePayload({ n: 9, list: ['a', 'b', 'c'], code: 'no' }, { $ref: '#/components/schemas/A' }, schemas).length, 3);
    assert.equal(validatePayload({ n: 1.5 }, { $ref: '#/components/schemas/A' }, schemas)[0].message, 'expected integer, got number');
  });
  it('builds examples that satisfy the schema', () => {
    const example = exampleFor({ $ref: '#/components/schemas/A' }, schemas, true);
    assert.deepEqual(validatePayload(example, { $ref: '#/components/schemas/A' }, schemas), []);
  });
});
