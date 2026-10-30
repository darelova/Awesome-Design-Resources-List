/**
 * A top-level README section
 */
export interface Section {
  readonly key: string;
  readonly heading: string;
}

/**
 * One list line: - [Name](url) - description
 */
export interface Entry {
  readonly line: number;
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly ai: boolean;
  readonly section: Section;
  readonly subsection?: string;
}

export const ENTRY_PATTERN = /^- (🤖 )?\[([^\]]+)\]\(([^)]+)\)\s*-?\s*(.*)$/;

export function stripEmoji(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

export function sectionKey(heading: string): string {
  return stripEmoji(heading)
    .replace(/\(.*\)/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Reads the README into its top-level sections and the entries under each one
 */
export function parseReadme(content: string): { sections: Section[]; entries: Entry[] } {
  const sections: Section[] = [];
  const entries: Entry[] = [];
  let current: Section | undefined;
  let subsection: string | undefined;

  content.split('\n').forEach((raw, index) => {
    const text = raw.trim();
    if (text.startsWith('## ')) {
      const heading = stripEmoji(text.slice(3));
      current = { key: sectionKey(heading), heading };
      sections.push(current);
      subsection = undefined;
      return;
    }
    if (text.startsWith('### ')) {
      subsection = stripEmoji(text.slice(4));
      return;
    }
    const match = ENTRY_PATTERN.exec(text);
    if (match && current) {
      entries.push({
        line: index + 1,
        ai: Boolean(match[1]),
        name: match[2].trim(),
        url: match[3].trim(),
        description: match[4].trim(),
        section: current,
        subsection,
      });
    }
  });

  return { sections, entries };
}
