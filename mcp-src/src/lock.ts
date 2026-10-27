import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ContractAnswer, PublicContract } from './client.ts';
import { ServexaError } from './errors.ts';
import { PLUGIN_VERSION } from './version.ts';

/**
 * `.servexa/integration.json` is the record of what a repository integrated: the revision and contract hash it was built against, the
 * files the plugin generated (with their SHA-256, so a later update can tell a hand edit from an untouched file) and the decisions taken.
 * `.servexa/contract.snapshot.json` is the public contract at that moment, which lets `/update` compute an exact, classified diff later.
 * Neither holds a credential; both are meant to be committed.
 *
 * Every path this module touches is resolved INSIDE the workspace (the directory the server was started in) after symlinks are resolved:
 * a relative path with `..`, an absolute path, or a link that leaves the workspace is refused.
 */

export const LOCK_DIR = '.servexa';
export const LOCK_FILE = `${LOCK_DIR}/integration.json`;
export const SNAPSHOT_FILE = `${LOCK_DIR}/contract.snapshot.json`;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MANAGED_FILES = 500;

export interface ManagedFile {
  path: string;
  sha256: string;
}

export interface IntegrationLock {
  schema: 1;
  baseUrlHost: string;
  integratedRevision: number | null;
  contractHash: string;
  pluginVersion: string;
  integratedAt: string;
  managedFiles: ManagedFile[];
  decisions: Record<string, unknown>;
}

export function workspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SERVEXA_PROJECT_DIR?.trim() || process.cwd());
}

/** The absolute path of `rel` inside `root`, or an error. Nothing outside the workspace is ever read or written. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 400 || rel.includes('\0')) throw new ServexaError('INVALID_INPUT', 'That is not a usable file path.');
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new ServexaError('INVALID_INPUT', `"${rel}" must be a relative path inside the repository.`);
  const realRoot = await realpath(root);
  const target = resolve(realRoot, rel);
  // Resolve links on the deepest part that exists, so a symlinked directory cannot lead out.
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      const back = relative(realRoot, join(real, relative(probe, target)));
      if (back.startsWith('..') || isAbsolute(back)) throw new ServexaError('INVALID_INPUT', `"${rel}" leaves the repository.`);
      return target;
    } catch (error) {
      if (error instanceof ServexaError) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw new ServexaError('INVALID_INPUT', `"${rel}" is not inside the repository.`);
      probe = parent;
    }
  }
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

async function hashFile(root: string, rel: string): Promise<string | null> {
  const full = await resolveInside(root, rel);
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new ServexaError('INVALID_INPUT', `"${rel}" is not a file.`);
    if (info.size > MAX_FILE_BYTES) throw new ServexaError('INVALID_INPUT', `"${rel}" is larger than ${MAX_FILE_BYTES} bytes.`);
    // Line endings are normalised so a Windows and a Linux checkout of the same file hash alike.
    return sha256((await readFile(full)).toString('utf8').replace(/\r\n/g, '\n'));
  } catch (error) {
    if (error instanceof ServexaError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonInside(root: string, rel: string, value: unknown): Promise<void> {
  const full = await resolveInside(root, rel);
  const dir = dirname(full);
  await mkdir(dir, { recursive: true });
  const link = await lstat(dir).catch(() => null);
  if (link?.isSymbolicLink()) throw new ServexaError('INVALID_INPUT', `${LOCK_DIR} must be a real directory.`);
  const temporary = `${full}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, full);
}

export async function readLock(root: string): Promise<IntegrationLock | null> {
  try {
    const parsed = JSON.parse(await readFile(await resolveInside(root, LOCK_FILE), 'utf8')) as Partial<IntegrationLock>;
    if (parsed.schema !== 1 || typeof parsed.contractHash !== 'string' || !Array.isArray(parsed.managedFiles)) {
      throw new ServexaError('INVALID_INPUT', `${LOCK_FILE} is not a Servexa integration record this plugin understands.`);
    }
    return parsed as IntegrationLock;
  } catch (error) {
    if (error instanceof ServexaError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ServexaError('INVALID_INPUT', `${LOCK_FILE} could not be read as JSON.`);
  }
}

export async function readSnapshot(root: string, rel: string = SNAPSHOT_FILE): Promise<PublicContract | null> {
  try {
    const full = await resolveInside(root, rel);
    const info = await stat(full);
    if (info.size > 2 * 1024 * 1024) throw new ServexaError('INVALID_INPUT', `${rel} is too large to be a contract snapshot.`);
    const parsed = JSON.parse(await readFile(full, 'utf8')) as { contract?: PublicContract } & Partial<PublicContract>;
    const contract = parsed.contract ?? (parsed as PublicContract);
    if (!Array.isArray(contract.routes) || !Array.isArray(contract.dtos)) throw new ServexaError('INVALID_INPUT', `${rel} is not a contract snapshot.`);
    return { routes: contract.routes, dtos: contract.dtos, responses: Array.isArray(contract.responses) ? contract.responses : [], widgetUrlRules: contract.widgetUrlRules ?? null };
  } catch (error) {
    if (error instanceof ServexaError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ServexaError('INVALID_INPUT', `${rel} could not be read as JSON.`);
  }
}

/** Writes the integration record and the contract snapshot for what the repository now implements. */
export async function recordIntegration(
  root: string,
  input: { answer: ContractAnswer; host: string; managedPaths: string[]; decisions?: Record<string, unknown>; now?: Date },
): Promise<{ lock: IntegrationLock; missing: string[] }> {
  if (input.managedPaths.length > MAX_MANAGED_FILES) throw new ServexaError('INVALID_INPUT', `At most ${MAX_MANAGED_FILES} managed files can be recorded.`);
  const managedFiles: ManagedFile[] = [];
  const missing: string[] = [];
  for (const path of [...new Set(input.managedPaths.map((p) => p.replace(/\\/g, '/')))].sort()) {
    const hash = await hashFile(root, path);
    if (hash === null) missing.push(path);
    else managedFiles.push({ path, sha256: hash });
  }
  const lock: IntegrationLock = {
    schema: 1,
    baseUrlHost: input.host,
    integratedRevision: input.answer.revision,
    contractHash: input.answer.contractHash,
    pluginVersion: PLUGIN_VERSION,
    integratedAt: (input.now ?? new Date()).toISOString(),
    managedFiles,
    decisions: input.decisions ?? {},
  };
  await writeJsonInside(root, SNAPSHOT_FILE, { revision: input.answer.revision, contractHash: input.answer.contractHash, savedAt: lock.integratedAt, contract: input.answer.contract });
  await writeJsonInside(root, LOCK_FILE, lock);
  return { lock, missing };
}

export interface ManagedFileState {
  path: string;
  state: 'unchanged' | 'edited' | 'missing';
}

/** Which recorded files still hold exactly what the plugin wrote (`unchanged`), were changed by hand (`edited`) or are gone. */
export async function checkManagedFiles(root: string, lock: IntegrationLock): Promise<ManagedFileState[]> {
  const out: ManagedFileState[] = [];
  for (const file of lock.managedFiles) {
    const hash = await hashFile(root, file.path);
    out.push({ path: file.path, state: hash === null ? 'missing' : hash === file.sha256 ? 'unchanged' : 'edited' });
  }
  return out;
}

export interface LockComparison {
  recorded: boolean;
  integratedRevision: number | null;
  serverRevision: number | null;
  /** Revisions the server is ahead by (null when either side has no revision). */
  behindBy: number | null;
  contractChanged: boolean;
  /** `current`: same revision and same contract. `behind`: the server moved. `unrecorded`: nothing integrated here yet. */
  state: 'current' | 'behind' | 'unrecorded';
}

export function compareToLock(lock: IntegrationLock | null, answer: ContractAnswer): LockComparison {
  if (!lock) return { recorded: false, integratedRevision: null, serverRevision: answer.revision, behindBy: null, contractChanged: false, state: 'unrecorded' };
  const contractChanged = lock.contractHash !== answer.contractHash;
  const behindBy = lock.integratedRevision !== null && answer.revision !== null ? Math.max(0, answer.revision - lock.integratedRevision) : null;
  const behind = contractChanged || (behindBy ?? 0) > 0;
  return { recorded: true, integratedRevision: lock.integratedRevision, serverRevision: answer.revision, behindBy, contractChanged, state: behind ? 'behind' : 'current' };
}

