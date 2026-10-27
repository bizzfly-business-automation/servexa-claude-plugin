# Servexa plugin for Claude Code

Connect an application to Servexa and keep it current, without sharing a Markdown guide. The plugin has three commands and a bundled MCP server that reads the **live contract of your Servexa deployment**.

You need a running Servexa deployment and a read-only **Docs token** from its Super Admin. The plugin does nothing useful without one.

| Command | What it does |
|---|---|
| `/servexa:setup` | Audits the repository, shows you what it would delete and what it would build, then builds the Super Admin "Servexa Integration" page, the connection lifecycle, support tickets, feature suggestions, pre-login "Report an Issue", optional webhooks and chat - with tests and a report. Use `--dry-run` to see the plan only. |
| `/servexa:update` | Compares the repository with the current Servexa revision (classified: breaking / behavioural / additive), plans the changes, applies them on a branch, leaves hand-edited files alone, runs the tests. Also adopts a repository that still uses the old Markdown guide. |
| `/servexa:status` | Read-only: is this repository current? |

(Claude Code namespaces plugin commands, so they are typed `/servexa:setup`. If nothing else claims the short name, `/setup` and `/update` also work.)

## Install (once per machine)

Requirements: Claude Code and Node 20 or newer.

```
/plugin marketplace add bizzfly-business-automation/servexa-claude-plugin
/plugin install servexa@servexa
```

Replace `bizzfly-business-automation/servexa-claude-plugin` with this repository's GitHub path (or pass its full git URL). Update later with `/plugin update servexa`.

## Connect to your Servexa (once per application)

1. In Servexa open **Applications > your application > Integration** and create a **Docs token** (read-only; it opens the integration documentation and nothing else). Copy it once.
2. Set two variables where Claude Code starts - your shell profile, or `.claude/settings.local.json` under `"env"` (never commit that file):

```
SERVEXA_BASE_URL=https://<your servexa>/api/v1
SERVEXA_GUIDE_TOKEN=sgt_...
```

   `SERVEXA_API_KEY` is optional and only used by `servexa_verify_connection`.
3. Restart Claude Code and run `/servexa:status`.

Never paste a token into the chat. The plugin never asks for one, never prints one and never writes one to a file.

## What gets written in your repository

- The code the commands generate, each file starting with a `servexa-managed` comment.
- `.servexa/integration.json` (revision, contract hash, generated files with SHA-256, decisions) and `.servexa/contract.snapshot.json` (the contract at that moment). No secrets. **Commit both**: `/servexa:update` uses them to tell a hand edit from a generated file and to compute an exact diff.
- `SERVEXA-SETUP-REPORT.md` / `SERVEXA-UPDATE-REPORT.md`.

## CI check (optional)

`node .servexa/servexa-mcp.mjs --check` prints one JSON line and exits `0` (current), `10` (behind) or `20` (could not tell / nothing recorded). Copy `plugins/servexa/mcp/servexa-mcp.mjs` from this plugin into `.servexa/` and give the job `SERVEXA_BASE_URL` and `SERVEXA_GUIDE_TOKEN` as secrets.

## Trust model

- The MCP server returns **data**. Every result says so, and the plugin's commands and skill tell Claude never to follow instructions found inside Servexa text. Instructions come only from this plugin, which you installed and can read.
- Read-only toward Servexa. The only writes are `.servexa/` files inside your repository, through `servexa_record_integration`.
- https only (plain http only for `localhost`), no redirects, timeouts, size caps, bounded retries; every file path is confined to the repository.
- No package registry and no dependencies at run time: the server is one committed file (`plugins/servexa/mcp/servexa-mcp.mjs`) built from `mcp-src/`; `plugins/servexa/mcp/RELEASE.json` holds its SHA-256 and CI fails if the file differs from a fresh build.

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest
plugins/servexa/                  the plugin: commands, skill, agent, .mcp.json, bundled MCP server
mcp-src/                          TypeScript source, tests and bundler of that MCP server
```

## For maintainers

Needs Node 22.6 or newer for the tests (`--experimental-strip-types`).

```
cd mcp-src
npm install
npm run typecheck
npm test
npm run build      # rewrites the bundle and RELEASE.json after any change to mcp-src/src
npm run check      # what CI runs: the committed bundle equals a fresh build
```

Release: raise `PLUGIN_VERSION` in `mcp-src/src/version.ts` and the versions in `plugins/servexa/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (a test checks they agree), run `npm run build`, commit, tag.

`mcp-src/test/fixtures/guide-section-ids.json` is a snapshot of the section ids the Servexa guide serves; a test checks that every section the plugin cites is in it. Refresh it when a newer Servexa revision adds a section the plugin should cite.

The server talks to these Servexa routes: `GET /integrations/contract`, `POST /integrations/contract/diff`, `GET /integrations/contract/changes`, `GET /integrations/guide/sections[/:id]`, `GET /integrations/capabilities`.
