/**
 * The served integration guide as addressable sections, so a client (the Claude plugin's MCP server) can fetch "A9" or "N26.4" instead of
 * a 4,000-line file. Pure: Markdown in, sections out. Headings inside fenced code blocks (shell comments, YAML) are not headings.
 *
 * Ids are what the guide itself calls its parts: `A9`, `A6a.1`, `N26.4`, `S6`, plus `step-0` / `step-2a` / `step-m1` (Part B's "Step −1") for Part B
 * and `part-a` / `part-b` for the two parts; any other heading gets `h-<slug>`. A duplicate id gets a numeric suffix so ids stay unique.
 */

export interface GuideSection {
  id: string;
  /** 1-3: the Markdown heading level (`#`, `##`, `###`). Deeper headings stay inside their parent's body. */
  level: 1 | 2 | 3;
  /** The heading text without the leading hashes. */
  title: string;
  /** The status tag from the heading, e.g. `CONFIRMED CURRENT BEHAVIOR`, `REQUIRED EXTERNAL INTEGRATION BEHAVIOR`; null when it has none. */
  status: string | null;
  /** `A`, `B` (Part B: instructions for the repository), or `front` for the front matter / opening before Part A. */
  part: 'front' | 'A' | 'B';
  parentId: string | null;
  /** Ids of the sections directly below this one. */
  childIds: string[];
  /** The section's own text, up to the next heading of level 1-3. */
  body: string;
}

const HEADING = /^(#{1,3})\s+(.+?)\s*$/;
const FENCE = /^\s*(```+|~~~+)/;
const STATUS = /`([A-Z][A-Z ,\-()]{5,})`/;
const SECTION_ID = /^([ANS])(\d+[a-z]?(?:\.\d+)*)\.?(?:\s|$)/;
const STEP_ID = /^Step\s+([−-]?\d+[a-z]?)\b/;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function idOf(title: string, level: number): string {
  const step = STEP_ID.exec(title);
  if (step) return stepId(step[1]);
  const section = SECTION_ID.exec(title);
  if (section) return `${section[1]}${section[2]}`;
  const part = /^PART\s+([AB])\b/.exec(title);
  if (part && level === 1) return `part-${part[1].toLowerCase()}`;
  return `h-${slug(title) || 'section'}`;
}

/** `−1` → `step-m1` (Part B's "Step −1" is minus one, not Step 1), `0` → `step-0`, `2a` → `step-2a`. */
function stepId(raw: string): string {
  return /^[−-]/.test(raw) ? `step-m${raw.slice(1)}` : `step-${raw}`;
}

/** Accepts what a person or model writes (`a9`, `Step −1`, `step 2a`, `Part B`) and returns the section id. */
export function normaliseSectionId(raw: string): string {
  const trimmed = raw.trim();
  // The canonical ids: `step-1` is Step 1, `step-m1` is Step −1.
  if (/^step-m?\d+[a-z]?$/i.test(trimmed)) return trimmed.toLowerCase();
  // As people write it: "Step −1" and "Step -1" (a space before the minus) are minus one; "Step 1" and "step 2a" are positive.
  const negative = /^step\s*[−–-]\s*(\d+[a-z]?)$/i.exec(trimmed);
  if (negative) return stepId(`-${negative[1].toLowerCase()}`);
  const positive = /^step\s+(\d+[a-z]?)$/i.exec(trimmed);
  if (positive) return stepId(positive[1].toLowerCase());
  if (/^part[-\s]?[ab]$/i.test(trimmed)) return `part-${trimmed.slice(-1).toLowerCase()}`;
  return /^[ans]\d/i.test(trimmed) ? `${trimmed[0].toUpperCase()}${trimmed.slice(1).toLowerCase()}` : trimmed.toLowerCase();
}

export function parseGuideSections(markdown: string): GuideSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: GuideSection[] = [];
  const used = new Map<string, number>();
  let current: { section: GuideSection; lines: string[] } | null = null;
  let fence: string | null = null;
  let part: GuideSection['part'] = 'front';
  const stack: GuideSection[] = [];

  const close = (): void => {
    if (current) current.section.body = current.lines.join('\n').replace(/^\n+|\n+$/g, '');
  };
  // The text before the first heading (front matter and introduction) is its own section.
  const opening: GuideSection = { id: 'front-matter', level: 1, title: 'Front matter', status: null, part: 'front', parentId: null, childIds: [], body: '' };
  sections.push(opening);
  current = { section: opening, lines: [] };

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    }
    const heading = fence === null ? HEADING.exec(line) : null;
    if (!heading) {
      current?.lines.push(line);
      continue;
    }
    close();
    const level = heading[1].length as 1 | 2 | 3;
    const title = heading[2];
    let id = idOf(title, level);
    const seen = used.get(id) ?? 0;
    used.set(id, seen + 1);
    if (seen > 0) id = `${id}-${seen + 1}`;
    if (level === 1) {
      if (id === 'part-a') part = 'A';
      else if (id === 'part-b') part = 'B';
    }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const section: GuideSection = { id, level, title, status: STATUS.exec(title)?.[1] ?? null, part, parentId: parent?.id ?? null, childIds: [], body: '' };
    parent?.childIds.push(id);
    stack.push(section);
    sections.push(section);
    current = { section, lines: [] };
  }
  close();
  return sections;
}

/** A section's text; with `withChildren`, the text of its whole subtree in document order. */
export function sectionText(sections: GuideSection[], id: string, withChildren = false): string | null {
  const start = sections.findIndex((section) => section.id === id);
  if (start < 0) return null;
  const root = sections[start];
  const render = (section: GuideSection): string => `${'#'.repeat(section.level)} ${section.title}\n\n${section.body}`.trimEnd();
  if (!withChildren) return render(root);
  const parts = [render(root)];
  const inside = new Set([root.id]);
  for (const section of sections.slice(start + 1)) {
    if (!section.parentId || !inside.has(section.parentId)) break;
    inside.add(section.id);
    parts.push(render(section));
  }
  return parts.join('\n\n');
}

export interface ChangelogEntry {
  revision: number;
  date: string | null;
  /** The entry's text as written (Markdown). */
  body: string;
}

/** The `### Revision n — date` entries of the guide's changelog with n greater than `since` (all of them when null), newest first. */
export function changelogEntriesSince(sections: GuideSection[], since: number | null): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const section of sections) {
    const match = /^Revision\s+(\d+)\b\s*(?:[—–-]\s*(\d{4}-\d{2}-\d{2}))?/.exec(section.title);
    if (!match || section.level !== 3) continue;
    const revision = Number(match[1]);
    if (since !== null && revision <= since) continue;
    entries.push({ revision, date: match[2] ?? null, body: section.body });
  }
  return entries.sort((a, b) => b.revision - a.revision);
}
