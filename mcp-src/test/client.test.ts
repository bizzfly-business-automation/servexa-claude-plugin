import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { ServexaClient } from '../src/client.ts';
import { parseBaseUrl } from '../src/config.ts';
import { servexaRequest } from '../src/http.ts';
import { redact, registerSecrets } from '../src/redact.ts';
import { GUIDE_MD, TOKEN, contractHandler, json, makeAnswer, startFake, testConfig } from './support.ts';
import type { Fake } from './support.ts';

const noSleep = async () => undefined;
let fake: Fake | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('base URL rules', () => {
  it('accepts https and local http, normalises the trailing slash', () => {
    assert.equal(parseBaseUrl('https://servexa.example/api/v1/').baseUrl, 'https://servexa.example/api/v1');
    assert.equal(parseBaseUrl('http://localhost:3001/api/v1').host, 'localhost:3001');
  });
  it('refuses plain http to a remote host, credentials, query strings and junk', () => {
    for (const bad of ['http://servexa.example/api/v1', 'https://user:pw@servexa.example/', 'https://servexa.example/?x=1', 'not a url', 'ftp://servexa.example']) {
      assert.throws(() => parseBaseUrl(bad), { code: 'NOT_CONFIGURED' }, bad);
    }
  });
});

describe('contract fetching', () => {
  it('fetches, sends the bearer token, caches, and revalidates with If-None-Match (304 reuses the saved answer)', async () => {
    let answer = makeAnswer();
    fake = await startFake(contractHandler(() => answer));
    const config = await testConfig(fake.url);
    const first = await new ServexaClient(config, { sleep: noSleep }).contract();
    assert.equal(first.value.revision, 18);
    assert.equal(first.stale, false);
    assert.equal(fake.seen[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(fake.seen[0].ifNoneMatch, undefined);

    const second = await new ServexaClient(config, { sleep: noSleep }).contract(); // new client: reads the disk cache
    assert.equal(second.value.revision, 18);
    assert.ok(fake.seen[1].ifNoneMatch, 'sent the saved ETag');
    assert.equal(fake.seen.length, 2);

    answer = makeAnswer({ revision: 19 });
    const third = await new ServexaClient(config, { sleep: noSleep }).contract();
    assert.equal(third.value.revision, 19);
  });

  it('serves the saved copy, marked stale, when Servexa cannot be reached', async () => {
    fake = await startFake(contractHandler(() => makeAnswer()));
    const config = await testConfig(fake.url);
    await new ServexaClient(config, { sleep: noSleep }).contract();
    await fake.close();
    const offline = await new ServexaClient({ ...config, timeoutMs: 500 }, { sleep: noSleep }).contract();
    assert.equal(offline.stale, true);
    assert.equal(offline.value.revision, 18);
    assert.ok(offline.ageSeconds !== null);
    fake = undefined;
  });

  it('serves the saved copy on a 5xx, but reports an unreachable server with no copy', async () => {
    fake = await startFake((_req, res) => json(res, 503, { code: 'INTEGRATION_GUIDE_UNAVAILABLE' }));
    await assert.rejects(new ServexaClient(await testConfig(fake.url), { sleep: noSleep }).contract(), { code: 'UNAVAILABLE' });
  });

  it('reports a rejected credential as UNAUTHORIZED without falling back to the cache', async () => {
    let allow = true;
    fake = await startFake((req, res, seen) => (allow ? contractHandler(() => makeAnswer())(req, res, seen) : json(res, 401, { message: 'Invalid integration API key' })));
    const config = await testConfig(fake.url);
    await new ServexaClient(config, { sleep: noSleep }).contract();
    allow = false;
    await assert.rejects(new ServexaClient(config, { sleep: noSleep }).contract(), (error: { code: string; hint?: string }) => error.code === 'UNAUTHORIZED' && /docs token/i.test(error.hint ?? ''));
  });

  it('says NOT_SUPPORTED for a Servexa that predates the contract endpoint', async () => {
    fake = await startFake((_req, res) => json(res, 404, { message: 'Cannot GET' }));
    await assert.rejects(new ServexaClient(await testConfig(fake.url), { sleep: noSleep }).contract(), { code: 'NOT_SUPPORTED' });
  });

  it('refuses an answer that needs a newer plugin or a newer answer format', async () => {
    fake = await startFake(contractHandler(() => makeAnswer({ minPluginVersion: '9.0.0' })));
    await assert.rejects(new ServexaClient(await testConfig(fake.url), { sleep: noSleep }).contract(), { code: 'INCOMPATIBLE_PLUGIN' });
    await fake.close();
    fake = await startFake(contractHandler(() => makeAnswer({ schemaVersion: 2 })));
    await assert.rejects(new ServexaClient(await testConfig(fake.url), { sleep: noSleep }).contract(), { code: 'INCOMPATIBLE_PLUGIN' });
  });

  it('refuses something that is not a contract', async () => {
    fake = await startFake((_req, res) => json(res, 200, { hello: 'world' }));
    await assert.rejects(new ServexaClient(await testConfig(fake.url), { sleep: noSleep }).contract(), { code: 'BAD_RESPONSE' });
  });
});

describe('older servers: guide sections from the guide download', () => {
  it('lists and returns sections and the changelog by parsing GET /integrations/guide', async () => {
    fake = await startFake((req, res) => {
      const url = (req.url ?? '').replace('/api/v1', '');
      if (url === '/integrations/guide') {
        res.writeHead(200, { 'content-type': 'text/markdown' });
        return res.end(GUIDE_MD);
      }
      json(res, 404, { message: 'nope' });
    });
    const client = new ServexaClient(await testConfig(fake.url), { sleep: noSleep });
    const index = await client.sectionIndex();
    assert.equal(index.source, 'local-guide');
    assert.equal(index.revision, 18);
    assert.ok(index.sections.some((s) => s.id === 'A9'));
    const section = await client.section('a9', false);
    assert.match(section.text, /Nine\./);
    await assert.rejects(client.section('A404', false), { code: 'NOT_FOUND' });
    assert.deepEqual((await client.changesFallback(17)).entries.map((e) => e.revision), [18]);
  });
});

describe('transport safety', () => {
  it('does not follow redirects', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(302, { location: 'https://evil.example/steal' });
      res.end();
    });
    await assert.rejects(servexaRequest(await testConfig(fake.url), '/integrations/contract', { sleep: noSleep }), { code: 'BAD_RESPONSE' });
    assert.equal(fake.seen.length, 1);
  });

  it('retries 503 with Retry-After a bounded number of times, then gives the last answer', async () => {
    let calls = 0;
    fake = await startFake((_req, res) => {
      calls += 1;
      json(res, 503, { message: 'busy' }, { 'retry-after': '1' });
    });
    const waits: number[] = [];
    const result = await servexaRequest(await testConfig(fake.url), '/integrations/contract', { sleep: async (ms) => void waits.push(ms) });
    assert.equal(result.status, 503);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 1000]);
  });

  it('refuses a response larger than the cap', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(5000));
    });
    await assert.rejects(servexaRequest(await testConfig(fake.url, { maxResponseBytes: 1000 }), '/integrations/contract', { sleep: noSleep }), { code: 'BAD_RESPONSE' });
  });

  it('times out as UNREACHABLE and refuses an unsafe path', async () => {
    fake = await startFake(() => undefined); // never answers
    await assert.rejects(servexaRequest(await testConfig(fake.url, { timeoutMs: 150 }), '/integrations/contract', { sleep: noSleep }), { code: 'UNREACHABLE' });
    await assert.rejects(servexaRequest(await testConfig(fake.url), '/../etc/passwd'), { code: 'INVALID_INPUT' });
  });

  it('never puts a credential in an error or a redacted string', async () => {
    registerSecrets(TOKEN);
    assert.equal(redact(`failed with Bearer ${TOKEN} and sk_live_abcdefghijklmnop`), 'failed with Bearer [redacted-token] and [redacted-token]');
    fake = await startFake(() => undefined);
    const config = await testConfig(fake.url, { timeoutMs: 100 });
    await assert.rejects(servexaRequest(config, '/integrations/contract', { sleep: noSleep }), (error: Error) => !error.message.includes(TOKEN));
  });
});
