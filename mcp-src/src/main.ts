import { runCheck } from './check.ts';
import { redact, registerSecrets } from './redact.ts';
import { McpServer, serve } from './server.ts';
import { PLUGIN_VERSION } from './version.ts';

/**
 * Entry point of the bundled server (`servexa-mcp.mjs`).
 *   (no arguments)   MCP over stdio, started by the Claude plugin
 *   --check          one JSON line; exit 0 current / 10 behind / 20 error (for CI)
 *   --version        prints the version
 */
async function main(): Promise<void> {
  registerSecrets(process.env.SERVEXA_GUIDE_TOKEN, process.env.SERVEXA_API_KEY);
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write(`${PLUGIN_VERSION}\n`);
    return;
  }
  if (args.includes('--check')) {
    const { code, report } = await runCheck();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = code;
    return;
  }
  const log = (line: string): void => void process.stderr.write(`servexa-mcp: ${redact(line)}\n`);
  await serve(new McpServer({ env: process.env }), process.stdin, process.stdout, log);
}

main().catch((error: unknown) => {
  process.stderr.write(`servexa-mcp: ${redact(error instanceof Error ? error.message : 'fatal error')}\n`);
  process.exitCode = 1;
});
