import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ServexaError } from './errors.ts';

export interface Config {
  /** The Servexa API base including its prefix, no trailing slash, e.g. `https://servexa.example/api/v1`. */
  baseUrl: string;
  host: string;
  /** Read-only docs token (`sgt_...`) or, as a fallback with a warning, an integration key. */
  docsCredential: string;
  credentialKind: 'guide-token' | 'integration-key';
  /** An integration key for `servexa_verify_connection` only (never used for documentation calls when a guide token exists). */
  apiKey: string | undefined;
  cacheDir: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https only; plain http only for a Servexa running on this machine. No credentials in the URL, no query, no fragment. */
export function parseBaseUrl(raw: string): { baseUrl: string; host: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ServexaError('NOT_CONFIGURED', 'SERVEXA_BASE_URL is not a valid URL.', { hint: 'Use the Servexa API address including its prefix, e.g. https://servexa.example/api/v1.' });
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ServexaError('NOT_CONFIGURED', 'SERVEXA_BASE_URL must use https (plain http is accepted only for localhost).');
  }
  if (url.username || url.password) throw new ServexaError('NOT_CONFIGURED', 'SERVEXA_BASE_URL must not contain credentials.');
  if (url.search || url.hash) throw new ServexaError('NOT_CONFIGURED', 'SERVEXA_BASE_URL must not contain a query string or fragment.');
  return { baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), host: url.host };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawBase = env.SERVEXA_BASE_URL?.trim();
  if (!rawBase) {
    throw new ServexaError('NOT_CONFIGURED', 'SERVEXA_BASE_URL is not set.', {
      hint: 'In Servexa open Applications > your application > Integration, copy the Base URL, and set it in the plugin settings or as SERVEXA_BASE_URL.',
    });
  }
  const { baseUrl, host } = parseBaseUrl(rawBase);
  const guideToken = env.SERVEXA_GUIDE_TOKEN?.trim();
  const apiKey = env.SERVEXA_API_KEY?.trim() || undefined;
  if (!guideToken && !apiKey) {
    throw new ServexaError('NOT_CONFIGURED', 'No Servexa credential is set.', {
      hint: 'Create a docs token in Servexa (Applications > your application > Integration > Docs token) and set it as SERVEXA_GUIDE_TOKEN.',
    });
  }
  if (guideToken && !guideToken.startsWith('sgt_')) {
    throw new ServexaError('NOT_CONFIGURED', 'SERVEXA_GUIDE_TOKEN does not look like a docs token (it starts with sgt_).');
  }
  const cacheRoot = env.SERVEXA_MCP_CACHE_DIR?.trim() || join(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'servexa-mcp');
  return {
    baseUrl,
    host,
    docsCredential: (guideToken ?? apiKey)!,
    credentialKind: guideToken ? 'guide-token' : 'integration-key',
    apiKey,
    cacheDir: join(cacheRoot, createHash('sha256').update(baseUrl).digest('hex').slice(0, 12)),
    timeoutMs: 20_000,
    maxResponseBytes: 8 * 1024 * 1024,
  };
}
