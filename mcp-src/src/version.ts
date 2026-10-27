/** Version of this MCP server (and of the plugin that ships it: one plugin version = one server version). Raise both together. */
export const PLUGIN_VERSION = '0.1.0';

/** Highest `schemaVersion` of the contract answer this server understands. */
export const SUPPORTED_CONTRACT_SCHEMA = 1;

/** `a < b` for dotted numeric versions (`0.1.0`, `1.10`); missing parts count as 0. A non-numeric part makes the comparison false. */
export function versionLessThan(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x < y;
  }
  return false;
}
