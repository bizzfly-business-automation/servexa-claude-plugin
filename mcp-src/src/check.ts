import { ServexaClient } from './client.ts';
import { loadConfig } from './config.ts';
import { ServexaError } from './errors.ts';
import { compareToLock, readLock, workspaceDir } from './lock.ts';
import { PLUGIN_VERSION } from './version.ts';

/** Exit codes of `--check`, for CI. */
export const EXIT_CURRENT = 0;
export const EXIT_BEHIND = 10;
export const EXIT_ERROR = 20;

export interface CheckOutcome {
  code: number;
  report: Record<string, unknown>;
}

/**
 * `node servexa-mcp.mjs --check`: is the repository's recorded integration current with the Servexa it talks to? Prints one JSON line
 * and exits 0 (current), 10 (behind: a newer revision or a changed contract) or 20 (could not tell: no credential, unreachable, no
 * record). A repository with no .servexa/integration.json is an error, not "current": nothing was ever recorded.
 */
export async function runCheck(env: NodeJS.ProcessEnv = process.env, client?: ServexaClient): Promise<CheckOutcome> {
  try {
    const config = loadConfig(env);
    const fresh = await (client ?? new ServexaClient(config)).contract();
    const lock = await readLock(workspaceDir(env));
    const comparison = compareToLock(lock, fresh.value);
    if (comparison.state === 'unrecorded') return { code: EXIT_ERROR, report: { result: 'error', code: 'NOT_RECORDED', message: 'No .servexa/integration.json: run /servexa:setup (or /servexa:update to adopt an older integration).' } };
    if (fresh.stale) return { code: EXIT_ERROR, report: { result: 'error', code: 'UNREACHABLE', message: 'Servexa could not be reached; the saved copy cannot show whether this repository is current.', plugin: PLUGIN_VERSION } };
    return { code: comparison.state === 'current' ? EXIT_CURRENT : EXIT_BEHIND, report: { result: comparison.state, ...comparison, plugin: PLUGIN_VERSION } };
  } catch (error) {
    if (error instanceof ServexaError) return { code: EXIT_ERROR, report: { result: 'error', code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } };
    return { code: EXIT_ERROR, report: { result: 'error', code: 'INTERNAL', message: 'Unexpected failure while checking.' } };
  }
}
