import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { TOOLS } from '../src/tools.ts';
import { PLUGIN_VERSION } from '../src/version.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const pluginRoot = join(repo, 'plugins', 'servexa');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const markdown = walk(pluginRoot).filter((file) => file.endsWith('.md'));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const frontMatter = (text: string): Record<string, string> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(match, 'front matter');
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]));
};

describe('the plugin package', () => {
  it('has consistent manifests, one version everywhere, and the bundle the MCP config runs', () => {
    const plugin = readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
    const marketplace = readJson(join(repo, '.claude-plugin', 'marketplace.json'));
    const release = readJson(join(pluginRoot, 'mcp', 'RELEASE.json'));
    assert.equal(plugin.name, 'servexa');
    assert.equal(plugin.version, PLUGIN_VERSION);
    assert.equal(marketplace.plugins[0].version, PLUGIN_VERSION);
    assert.equal(marketplace.plugins[0].source, './plugins/servexa');
    assert.equal(release.pluginVersion, PLUGIN_VERSION);
    const server = readJson(join(pluginRoot, '.mcp.json')).mcpServers.servexa;
    assert.equal(server.command, 'node');
    assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/mcp/servexa-mcp.mjs']);
    assert.ok(existsSync(join(pluginRoot, 'mcp', 'servexa-mcp.mjs')));
    // Every variable has a default, so an unset one does not stop Claude Code from loading the server.
    for (const value of Object.values(server.env as Record<string, string>)) assert.match(value, /^\$\{[A-Z_]+:-\}$/);
  });

  it('gives every command, skill and agent a front matter with its description', () => {
    for (const file of walk(pluginRoot).filter((f) => /[\\/](commands|agents)[\\/].+\.md$|SKILL\.md$/.test(f))) {
      assert.ok(frontMatter(readFileSync(file, 'utf8')).description, relative(pluginRoot, file));
    }
    for (const command of ['setup', 'update', 'status']) assert.ok(existsSync(join(pluginRoot, 'commands', `${command}.md`)), command);
    assert.equal(frontMatter(readFileSync(join(pluginRoot, 'skills', 'servexa-integration', 'SKILL.md'), 'utf8')).name, 'servexa-integration');
  });

  it('mentions only MCP tools that exist', () => {
    const known = new Set(TOOLS.map((tool) => tool.name));
    const mentioned = new Set<string>();
    for (const file of markdown) for (const match of readFileSync(file, 'utf8').matchAll(/\bservexa_[a-z_]+\b/g)) mentioned.add(match[0]);
    for (const name of mentioned) assert.ok(known.has(name), `${name} is not a tool`);
    // ...and the commands use the tools they depend on.
    const setup = readFileSync(join(pluginRoot, 'commands', 'setup.md'), 'utf8');
    for (const name of ['servexa_status', 'servexa_get_capabilities', 'servexa_get_contract', 'servexa_record_integration']) assert.ok(setup.includes(name), name);
    const update = readFileSync(join(pluginRoot, 'commands', 'update.md'), 'utf8');
    for (const name of ['servexa_get_changes', 'servexa_check_managed_files', 'servexa_record_integration']) assert.ok(update.includes(name), name);
  });

  it('cites guide sections that exist in the served guide', () => {
    // test/fixtures/guide-section-ids.json is a snapshot of the section ids the Servexa guide serves. Refresh it when the
    // plugin starts citing a section that a newer Servexa revision added.
    const ids = new Set(readJson(join(here, 'fixtures', 'guide-section-ids.json')) as unknown as string[]);
    const cited = new Set<string>();
    for (const file of markdown) for (const match of readFileSync(file, 'utf8').matchAll(/\b([AN]\d+[a-z]?(?:\.\d+)*)\b/g)) cited.add(match[1]);
    assert.ok(cited.size > 8, 'the plugin should cite guide sections');
    for (const id of cited) {
      // "A9.2" names a paragraph inside A9, not a heading: its section is the part before the first dot.
      assert.ok(ids.has(id) || ids.has(id.split('.')[0]), `${id} is not a section of the guide`);
    }
  });

  it('contains no credential-shaped strings', () => {
    for (const file of walk(pluginRoot).filter((f) => !f.endsWith('.mjs'))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\b(?:sgt|scs)_[0-9a-f]{16,}\b|\bsk_(?:live|test)_[A-Za-z0-9]{8,}/, relative(pluginRoot, file));
    }
  });
});
