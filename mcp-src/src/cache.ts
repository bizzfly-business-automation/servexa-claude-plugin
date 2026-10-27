import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CacheEntry {
  etag: string | null;
  fetchedAt: string;
  body: string;
}

/**
 * A tiny on-disk cache keyed by name inside one directory per Servexa base URL. It holds Servexa's public, non-secret contract text
 * and ETags only - never a credential - and is only ever a fallback (staleness is reported) or the other half of an If-None-Match.
 * Every failure to read or write it is swallowed: no cache must never mean no answer.
 */
export class DiskCache {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async read(name: string): Promise<CacheEntry | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, `${name}.json`), 'utf8')) as Partial<CacheEntry>;
      if (typeof parsed.body !== 'string' || typeof parsed.fetchedAt !== 'string') return null;
      return { etag: typeof parsed.etag === 'string' ? parsed.etag : null, fetchedAt: parsed.fetchedAt, body: parsed.body };
    } catch {
      return null;
    }
  }

  async write(name: string, entry: CacheEntry): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const target = join(this.dir, `${name}.json`);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
      await rename(temporary, target);
    } catch {
      /* a cache that cannot be written is simply not used */
    }
  }
}

export const ageSeconds = (fetchedAt: string, now: Date = new Date()): number => Math.max(0, Math.round((now.getTime() - new Date(fetchedAt).getTime()) / 1000));
