import type { Config } from './config.ts';
import { ServexaError } from './errors.ts';
import { redact } from './redact.ts';

export interface HttpResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: 'GET' | 'POST';
  /** JSON body for POST. */
  json?: unknown;
  headers?: Record<string, string>;
  /** Overrides the documentation credential (only `servexa_verify_connection` uses this, with the integration key). */
  credential?: string;
  /** Test hook: do not wait between retries. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after');
  const seconds = header && /^\d{1,4}$/.test(header) ? Number(header) : NaN;
  const wanted = Number.isFinite(seconds) ? seconds * 1000 : 500 * 2 ** attempt;
  return Math.min(wanted, MAX_RETRY_WAIT_MS);
}

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) throw new ServexaError('BAD_RESPONSE', `Servexa answered with more than ${limit} bytes; refusing to read it.`);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ServexaError('BAD_RESPONSE', `Servexa answered with more than ${limit} bytes; refusing to read it.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * One call to the configured Servexa host: the path is joined to the base URL by this function only (so the host cannot change), no
 * redirect is followed, a timeout and a size cap apply, and 429/502/503/504 and network errors are retried a bounded number of times
 * honouring Retry-After. The credential is sent as a Bearer header and never appears in a thrown error.
 */
export async function servexaRequest(config: Config, path: string, options: RequestOptions = {}, fetchImpl: FetchLike = fetch): Promise<HttpResult> {
  if (!path.startsWith('/') || path.includes('..') || path.includes('//')) throw new ServexaError('INVALID_INPUT', 'Internal error: unsafe request path.');
  const url = `${config.baseUrl}${path}`;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response: Response | null = null;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'servexa-mcp',
          authorization: `Bearer ${options.credential ?? config.docsCredential}`,
          ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
      });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        throw new ServexaError('BAD_RESPONSE', `Servexa answered with a redirect (${response.status}); redirects are not followed. Check SERVEXA_BASE_URL.`, { status: response.status });
      }
      if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(retryDelay(response, attempt));
        continue;
      }
      return { status: response.status, headers: response.headers, body: await readCapped(response, config.maxResponseBytes) };
    } catch (error) {
      if (error instanceof ServexaError) throw error;
      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(retryDelay(null, attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const reason = lastError instanceof Error ? (lastError.name === 'AbortError' ? 'timed out' : redact(lastError.message)) : 'unknown error';
  throw new ServexaError('UNREACHABLE', `Could not reach Servexa at ${config.host}: ${reason}.`, { hint: 'Check SERVEXA_BASE_URL and your network. Cached answers are used where available.' });
}
