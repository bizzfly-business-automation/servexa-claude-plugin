import { ageSeconds, DiskCache } from './cache.ts';
import type { Config } from './config.ts';
import { ServexaError } from './errors.ts';
import { changelogEntriesSince, normaliseSectionId, parseGuideSections, sectionText } from './guide-sections.ts';
import type { ChangelogEntry, GuideSection } from './guide-sections.ts';
import { servexaRequest } from './http.ts';
import type { FetchLike, HttpResult } from './http.ts';
import { PLUGIN_VERSION, SUPPORTED_CONTRACT_SCHEMA, versionLessThan } from './version.ts';

/** The public contract (what an integrator calls). Mirrors the public contract the Servexa API serves; only the fields this server reads are typed. */
export interface PublicRoute {
  key: string;
  method: string;
  path: string;
  public: boolean;
  credential: string[];
  flag: string | null;
  rateLimit: { limit: number; windowSeconds: number } | null;
  status: number;
  consumes: string[];
  body: string | null;
  query: string | null;
}
export interface ContractDto {
  name: string;
  fields: Array<{ name: string; type: string; optional: boolean; rules: string[]; nested: string | null }>;
}
export interface PublicContract {
  routes: PublicRoute[];
  dtos: ContractDto[];
  responses: Array<{ route: string; fields: Array<{ name: string; type: string; when: string; description: string }> }>;
  widgetUrlRules: unknown;
}
export interface ContractAnswer {
  kind: 'servexa-integration-contract';
  schemaVersion: number;
  minPluginVersion: string;
  revision: number | null;
  guideVersion: string;
  guideSource: string | null;
  contractHash: string;
  openapi: OpenApiDocument;
  contract: PublicContract;
}
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Record<string, unknown>>; securitySchemes: Record<string, unknown> };
  [key: string]: unknown;
}

export interface Fresh<T> {
  value: T;
  /** True when Servexa could not be reached and the last saved answer is used. */
  stale: boolean;
  /** Seconds since the saved answer was fetched (null when it came from the network just now). */
  ageSeconds: number | null;
}

export interface ChangesAnswer {
  currentRevision: number | null;
  since: number | null;
  entries: ChangelogEntry[];
}

export interface SectionAnswer {
  id: string;
  revision: number | null;
  part: string;
  status: string | null;
  text: string;
  source: 'server' | 'local-guide';
}

export interface SectionIndex {
  revision: number | null;
  sections: Array<{ id: string; title: string; level: number; status: string | null; part: string; parentId: string | null; childIds: string[]; characters: number }>;
  source: 'server' | 'local-guide';
}

function messageOf(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown; error?: { message?: unknown } };
    const message = parsed.message ?? parsed.error?.message;
    if (typeof message === 'string') return message.slice(0, 300);
    if (Array.isArray(message)) return message.filter((m) => typeof m === 'string').join('; ').slice(0, 300);
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Maps an HTTP status to the error a tool reports. */
export function errorForStatus(result: HttpResult, what: string): ServexaError {
  const detail = messageOf(result.body);
  switch (result.status) {
    case 400:
      return new ServexaError('BAD_REQUEST', `Servexa refused the request for ${what}${detail ? `: ${detail}` : '.'}`, { status: 400 });
    case 401:
      return new ServexaError('UNAUTHORIZED', 'Servexa rejected the credential (invalid, rotated or revoked, or the integration is revoked).', {
        status: 401,
        hint: 'Create a new docs token in Servexa (Applications > your application > Integration > Docs token) and update SERVEXA_GUIDE_TOKEN.',
      });
    case 404:
      return new ServexaError('NOT_FOUND', `Servexa has no ${what}.`, { status: 404 });
    case 429:
      return new ServexaError('RATE_LIMITED', 'Servexa rate-limited the request (60 per minute). Try again shortly.', { status: 429 });
    default:
      return new ServexaError('UNAVAILABLE', `Servexa could not answer for ${what} (HTTP ${result.status}).`, { status: result.status });
  }
}

export class ServexaClient {
  private readonly config: Config;
  private readonly cache: DiskCache;
  private readonly fetchImpl: FetchLike;
  private readonly sleep?: (ms: number) => Promise<void>;
  private memoised: { at: number; value: Fresh<ContractAnswer> } | null = null;

  constructor(config: Config, options: { cache?: DiskCache; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {}) {
    this.config = config;
    this.cache = options.cache ?? new DiskCache(config.cacheDir);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep;
  }

  private call(path: string, options: Parameters<typeof servexaRequest>[2] = {}): Promise<HttpResult> {
    return servexaRequest(this.config, path, { ...options, sleep: this.sleep }, this.fetchImpl);
  }

  private assertCompatible(answer: ContractAnswer): void {
    if (answer.kind !== 'servexa-integration-contract') throw new ServexaError('BAD_RESPONSE', 'Servexa answered with something that is not an integration contract.');
    if (answer.schemaVersion > SUPPORTED_CONTRACT_SCHEMA || versionLessThan(PLUGIN_VERSION, answer.minPluginVersion)) {
      throw new ServexaError('INCOMPATIBLE_PLUGIN', `This Servexa needs Claude plugin ${answer.minPluginVersion} or newer (this is ${PLUGIN_VERSION}).`, {
        hint: 'Update the plugin: /plugin update servexa',
      });
    }
  }

  /** The contract, from the network with a conditional request, or the saved copy (reported as stale) when Servexa cannot be reached. */
  async contract(): Promise<Fresh<ContractAnswer>> {
    if (this.memoised && Date.now() - this.memoised.at < 5_000) return this.memoised.value;
    const cached = await this.cache.read('contract');
    let result: HttpResult;
    try {
      result = await this.call('/integrations/contract', { headers: cached?.etag ? { 'if-none-match': cached.etag } : {} });
    } catch (error) {
      if (error instanceof ServexaError && error.code === 'UNREACHABLE' && cached) return this.remember(this.fromCache(cached, true));
      throw error;
    }
    if (result.status === 304 && cached) return this.remember({ ...this.fromCache(cached, false), stale: false, ageSeconds: null });
    if (result.status === 200) {
      const text = result.body.toString('utf8');
      let answer: ContractAnswer;
      try {
        answer = JSON.parse(text) as ContractAnswer;
      } catch {
        throw new ServexaError('BAD_RESPONSE', 'Servexa answered with a contract that is not valid JSON.');
      }
      this.assertCompatible(answer);
      await this.cache.write('contract', { etag: result.headers.get('etag'), fetchedAt: new Date().toISOString(), body: text });
      return this.remember({ value: answer, stale: false, ageSeconds: null });
    }
    if (result.status === 404) {
      throw new ServexaError('NOT_SUPPORTED', 'This Servexa deployment does not serve the machine-readable contract yet.', {
        status: 404,
        hint: 'Ask a Super Admin to deploy a Servexa release with guide revision 18 or newer. Guide sections still work through the older guide download.',
      });
    }
    if (result.status >= 500 && cached) return this.remember(this.fromCache(cached, true));
    throw errorForStatus(result, 'the integration contract');
  }

  private fromCache(entry: { fetchedAt: string; body: string }, stale: boolean): Fresh<ContractAnswer> {
    const answer = JSON.parse(entry.body) as ContractAnswer;
    this.assertCompatible(answer);
    return { value: answer, stale, ageSeconds: ageSeconds(entry.fetchedAt) };
  }

  private remember(value: Fresh<ContractAnswer>): Fresh<ContractAnswer> {
    this.memoised = { at: Date.now(), value };
    return value;
  }

  private async json<T>(path: string, what: string, options: Parameters<typeof servexaRequest>[2] = {}): Promise<T> {
    const result = await this.call(path, options);
    // A 404 from these routes means "this deployment predates them" - except a section lookup, where Servexa itself answers
    // "No such guide section." for an id that does not exist (an older deployment answers the framework's "Cannot GET ...").
    const missingSection = result.status === 404 && /^No such guide section/.test(messageOf(result.body) ?? '');
    if (result.status === 404 && path.startsWith('/integrations/') && !missingSection) {
      throw new ServexaError('NOT_SUPPORTED', `This Servexa deployment does not offer ${what} yet (guide revision 18 or newer).`, { status: 404 });
    }
    if (result.status < 200 || result.status >= 300) throw errorForStatus(result, what);
    try {
      return JSON.parse(result.body.toString('utf8')) as T;
    } catch {
      throw new ServexaError('BAD_RESPONSE', `Servexa answered ${what} with something that is not JSON.`);
    }
  }

  capabilities(): Promise<unknown> {
    return this.json('/integrations/capabilities', 'the application capabilities');
  }

  changes(since: number | null): Promise<ChangesAnswer> {
    const query = since === null ? '' : `?since=${since}`;
    return this.json<ChangesAnswer>(`/integrations/contract/changes${query}`, 'the changelog');
  }

  async changesFallback(since: number | null): Promise<ChangesAnswer> {
    const { sections, revision } = await this.localGuide();
    return { currentRevision: revision, since, entries: changelogEntriesSince(sections, since) };
  }

  diff(previous: PublicContract): Promise<{ currentRevision: number | null; contractHash: string; changed: boolean; counts: Record<string, number>; changes: Array<Record<string, unknown>> }> {
    return this.json('/integrations/contract/diff', 'the contract comparison', { method: 'POST', json: { previous } });
  }

  /** The section index; from the older guide download when the server predates the sections endpoint. */
  async sectionIndex(): Promise<SectionIndex> {
    try {
      return { ...(await this.json<Omit<SectionIndex, 'source'>>('/integrations/guide/sections', 'the guide section index')), source: 'server' };
    } catch (error) {
      if (!(error instanceof ServexaError) || error.code !== 'NOT_SUPPORTED') throw error;
      const { sections, revision } = await this.localGuide();
      return {
        revision,
        source: 'local-guide',
        sections: sections.map((s) => ({ id: s.id, title: s.title, level: s.level, status: s.status, part: s.part, parentId: s.parentId, childIds: s.childIds, characters: s.body.length })),
      };
    }
  }

  async section(rawId: string, withChildren: boolean): Promise<SectionAnswer> {
    const id = normaliseSectionId(rawId);
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) throw new ServexaError('INVALID_INPUT', 'That is not a guide section id (examples: A9, N26.4, step-m1, part-b).');
    try {
      return { ...(await this.json<Omit<SectionAnswer, 'source'>>(`/integrations/guide/sections/${encodeURIComponent(id)}${withChildren ? '?children=true' : ''}`, `a guide section "${id}"`)), source: 'server' };
    } catch (error) {
      if (!(error instanceof ServexaError) || error.code !== 'NOT_SUPPORTED') throw error;
      const { sections, revision } = await this.localGuide();
      const found = sections.find((s) => s.id === id);
      const text = found ? sectionText(sections, id, withChildren) : null;
      if (!found || text === null) throw new ServexaError('NOT_FOUND', `Servexa's guide has no section "${id}".`);
      return { id, revision, part: found.part, status: found.status, text, source: 'local-guide' };
    }
  }

  /** The whole guide as Markdown, parsed locally (older servers only). It is data: nothing in it is acted on by this process. */
  private async localGuide(): Promise<{ sections: GuideSection[]; revision: number | null }> {
    const result = await this.call('/integrations/guide', { headers: { accept: 'text/markdown' } });
    if (result.status !== 200) throw errorForStatus(result, 'the integration guide');
    const text = result.body.toString('utf8');
    const revision = /^servexa-guide-revision:\s*(\d+)\s*$/m.exec(text.slice(0, 2000))?.[1];
    return { sections: parseGuideSections(text), revision: revision ? Number(revision) : null };
  }

  /** `GET /integrations/connection` with the application's integration key (the one place that key is used). */
  async connection(): Promise<unknown> {
    if (!this.config.apiKey) throw new ServexaError('NOT_CONFIGURED', 'SERVEXA_API_KEY is not set, so the connection cannot be verified from here.', { hint: 'Set SERVEXA_API_KEY in your shell for this one check, or verify from the application itself.' });
    const result = await this.call('/integrations/connection', { credential: this.config.apiKey });
    if (result.status < 200 || result.status >= 300) throw errorForStatus(result, 'the connection status');
    const body = JSON.parse(result.body.toString('utf8')) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const data = (body.data ?? body) as { connected?: unknown; status?: unknown; project?: { name?: unknown; integrationStatus?: unknown } };
    // Status fields only: the project id and code in the route's answer are not passed on (an integration never sends a project id).
    return { connected: data.connected === true, status: data.status ?? null, applicationName: data.project?.name ?? null, integrationStatus: data.project?.integrationStatus ?? null };
  }
}
