import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { ServexaClient } from '../src/client.ts';
import { McpServer, serve } from '../src/server.ts';
import { TOKEN, contractHandler, makeAnswer, startFake, tempDir, testConfig } from './support.ts';
import type { Fake } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));
let fake: Fake | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function session(messages: unknown[]): Promise<Array<Record<string, any>>> {
  fake = await startFake(contractHandler(() => makeAnswer()));
  const config = await testConfig(fake.url);
  const server = new McpServer({ env: {}, config, client: new ServexaClient(config, { sleep: async () => undefined }), workspace: await tempDir() });
  const input = new PassThrough();
  const written: string[] = [];
  const done = serve(server, input, { write: (chunk: string) => written.push(chunk) });
  for (const message of messages) input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  input.end();
  await done;
  return written.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('MCP protocol', () => {
  it('initializes, lists tools and calls one, answering each request by id and ignoring notifications', async () => {
    const out = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'servexa_get_contract', arguments: { area: 'tickets' } } },
      { jsonrpc: '2.0', id: 4, method: 'ping' },
    ]);
    const byId = Object.fromEntries(out.map((m) => [m.id, m]));
    assert.equal(out.length, 4, 'the notification got no answer');
    assert.equal(byId[1].result.protocolVersion, '2025-06-18');
    assert.equal(byId[1].result.serverInfo.name, 'servexa');
    assert.ok(byId[2].result.tools.some((t: { name: string; annotations: { readOnlyHint: boolean } }) => t.name === 'servexa_status' && t.annotations.readOnlyHint === true));
    const body = JSON.parse(byId[3].result.content[0].text);
    assert.match(body.notice, /not instructions/);
    assert.equal(body.routes[0].key, 'POST /integrations/tickets');
    assert.deepEqual(byId[4].result, {});
  });

  it('reports a tool failure as a result with isError and a stable code, not as a protocol error', async () => {
    const out = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'servexa_get_guide_section', arguments: {} } }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } }]);
    for (const response of out) {
      assert.equal(response.result.isError, true);
      assert.ok(['INVALID_INPUT', 'NOT_FOUND'].includes(JSON.parse(response.result.content[0].text).error.code));
    }
  });

  it('answers unknown methods and malformed input with JSON-RPC errors and keeps going', async () => {
    const out = await session(['not json', { jsonrpc: '2.0', id: 7, method: 'bogus/method' }, '[1,2]', { jsonrpc: '2.0', id: 8, method: 'ping' }]);
    assert.equal(out[0].error.code, -32700);
    assert.ok(out.some((m) => m.id === 7 && m.error.code === -32601));
    assert.ok(out.some((m) => m.error?.code === -32600));
    assert.ok(out.some((m) => m.id === 8 && m.result));
  });

  it('serves resources, including a guide section template', async () => {
    const out = await session([{ jsonrpc: '2.0', id: 1, method: 'resources/list' }, { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'servexa://contract' } }, { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'servexa://nope' } }]);
    const byId = Object.fromEntries(out.map((m) => [m.id, m])); // answers are written as each finishes, not in request order
    assert.ok(byId[1].result.resources.some((r: { uri: string }) => r.uri === 'servexa://openapi'));
    assert.equal(JSON.parse(byId[2].result.contents[0].text).revision, 18);
    assert.ok(byId[3].error);
  });
});

describe('the real process over stdio', () => {
  it('starts, handshakes and calls a tool against a Servexa, never printing the token', async () => {
    fake = await startFake(contractHandler(() => makeAnswer()));
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(here, '..', 'src', 'main.ts')], {
      env: { ...process.env, SERVEXA_BASE_URL: fake.url, SERVEXA_GUIDE_TOKEN: TOKEN, SERVEXA_MCP_CACHE_DIR: await tempDir('servexa-cache-'), SERVEXA_PROJECT_DIR: await tempDir() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'servexa_status', arguments: {} } })}\n`);
    child.stdin.end();
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    const lines = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines[0].result.protocolVersion, '2024-11-05');
    const status = JSON.parse(lines[1].result.content[0].text);
    assert.equal(status.server.revision, 18);
    assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN));
  });

  it('--check prints one JSON line and exits 20 when nothing was recorded; --version prints the version', async () => {
    fake = await startFake(contractHandler(() => makeAnswer()));
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(here, '..', 'src', 'main.ts'), ...args], {
          env: { ...process.env, SERVEXA_BASE_URL: fake!.url, SERVEXA_GUIDE_TOKEN: TOKEN, SERVEXA_PROJECT_DIR: process.env.TEMP ?? '.', SERVEXA_MCP_CACHE_DIR: join(process.env.TEMP ?? '.', 'servexa-check-cache') },
        });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk));
        child.on('close', (code) => resolve({ code, out }));
      });
    const check = await run(['--check']);
    assert.equal(check.code, 20);
    assert.equal(JSON.parse(check.out).code, 'NOT_RECORDED');
    assert.equal((await run(['--version'])).out.trim(), '0.1.0');
  });
});

describe('the committed bundle (what the plugin actually runs)', () => {
  it('starts with plain node and talks the protocol', async () => {
    fake = await startFake(contractHandler(() => makeAnswer()));
    const bundle = join(here, '..', '..', 'plugins', 'servexa', 'mcp', 'servexa-mcp.mjs');
    const child = spawn(process.execPath, [bundle], { env: { ...process.env, SERVEXA_BASE_URL: fake.url, SERVEXA_GUIDE_TOKEN: TOKEN, SERVEXA_MCP_CACHE_DIR: await tempDir('servexa-cache-'), SERVEXA_PROJECT_DIR: await tempDir() } });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'servexa_get_contract', arguments: { area: 'tickets' } } })}\n`);
    child.stdin.end();
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    assert.equal(JSON.parse(JSON.parse(stdout.trim()).result.content[0].text).routes[0].key, 'POST /integrations/tickets');
    const release = JSON.parse(readFileSync(join(bundle, '..', 'RELEASE.json'), 'utf8'));
    const { createHash } = await import('node:crypto');
    assert.equal(release.sha256, createHash('sha256').update(readFileSync(bundle, 'utf8').replace(/\r\n/g, '\n')).digest('hex'));
  });
});
