#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';

/**
 * Uses TypeSafe's Jev model to check which README section each resource belongs in.
 *
 *   npm run categorize                     audit every entry in README.md
 *   npm run categorize -- --limit 20       audit the first 20 entries only
 *   npm run categorize -- --json out.json  also write every answer to a file
 *   npm run categorize -- --suggest "- [Name](https://url) - description"
 *
 * Needs TYPESAFE_API_KEY, read from the environment or from .env in the repo root.
 */

// All question wording and thresholds live here.
const MODEL = 'jev-1.14.0';
const LIST_CONTEXT = {
  title: 'Awesome Design Resources List',
  about: 'A curated list of links for designers: tools, resources, articles, and inspiration.',
  placement_rule:
    'Sections overlap. Each resource goes in the section that matches its main use, even if it could fit elsewhere.',
};
const SECTION_QUESTION = 'Which section of the list is the best home for this resource?';
// Below this probability for its current section, an entry is reported as misplaced.
const MOVE_THRESHOLD = 0.2;
const ENTRIES_PER_REQUEST = 25;
const CONCURRENT_REQUESTS = 4;

interface Section {
  readonly key: string;
  readonly heading: string;
}

interface Entry {
  readonly line: number;
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly ai: boolean;
  readonly section: Section;
  readonly subsection?: string;
}

type Verdict = 'ok' | 'borderline' | 'move';

interface Result {
  readonly entry: Entry;
  readonly suggested: string;
  readonly probabilities: Record<string, number>;
  readonly verdict: Verdict;
}

const ENTRY_PATTERN = /^- (🤖 )?\[([^\]]+)\]\(([^)]+)\)\s*-?\s*(.*)$/;

function stripEmoji(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function sectionKey(heading: string): string {
  return stripEmoji(heading)
    .replace(/\(.*\)/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Reads the README into its top-level sections and the entries under each one
 */
function parseReadme(content: string): { sections: Section[]; entries: Entry[] } {
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

function sectionQuestion(sections: readonly Section[], entry: Pick<Entry, 'name' | 'url' | 'description' | 'ai'>) {
  const criteria = Object.fromEntries(sections.map((s) => [s.key, s.heading]));
  return choice(
    {
      question: SECTION_QUESTION,
      resource: {
        name: entry.name,
        url: entry.url,
        description: entry.description || '(no description)',
        ...(entry.ai ? { ai_powered: true } : {}),
      },
    },
    criteria,
  );
}

function verdictFor(entry: Entry, suggested: string, probabilities: Record<string, number>): Verdict {
  if (suggested === entry.section.key) return 'ok';
  return (probabilities[entry.section.key] ?? 0) < MOVE_THRESHOLD ? 'move' : 'borderline';
}

async function classify(client: TypeSafeClient, sections: readonly Section[], batch: readonly Entry[]): Promise<Result[]> {
  const questions = Object.fromEntries(batch.map((entry, i) => [`e${i}`, sectionQuestion(sections, entry)]));
  const response = await client.systemOne({ model: MODEL, state: { list: LIST_CONTEXT }, questions });

  return batch.map((entry, i) => {
    const answer = response.answers[`e${i}`];
    const probabilities = answer.probabilities as Record<string, number>;
    return { entry, suggested: answer.choice, probabilities, verdict: verdictFor(entry, answer.choice, probabilities) };
  });
}

async function runPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function percent(value: number | undefined): string {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function printResults(results: readonly Result[], sections: readonly Section[]): void {
  const headingOf = new Map(sections.map((s) => [s.key, s.heading]));
  const show = (verdict: Verdict, title: string) => {
    const rows = results.filter((r) => r.verdict === verdict);
    console.log(`\n${title} (${rows.length})\n`);
    for (const { entry, suggested, probabilities } of rows) {
      const where = entry.subsection ? `${entry.section.heading} › ${entry.subsection}` : entry.section.heading;
      console.log(`  L${entry.line}  ${entry.name}  ${entry.url}`);
      console.log(`        now:     ${where} (${percent(probabilities[entry.section.key])})`);
      console.log(`        suggest: ${headingOf.get(suggested)} (${percent(probabilities[suggested])})`);
    }
  };

  show('move', '🚚 Likely in the wrong section');
  show('borderline', '🤔 Fits its section, but another fits better');
  const ok = results.filter((r) => r.verdict === 'ok').length;
  console.log(`\n✅ ${ok} of ${results.length} entries are in the section Jev picked.\n`);
}

async function suggest(client: TypeSafeClient, sections: readonly Section[], line: string): Promise<void> {
  const match = ENTRY_PATTERN.exec(line.trim());
  if (!match) {
    throw new Error('Expected a list line like: - [Name](https://url) - description');
  }
  const entry = { ai: Boolean(match[1]), name: match[2], url: match[3], description: match[4] };
  const response = await client.systemOne({
    model: MODEL,
    state: { list: LIST_CONTEXT },
    questions: { section: sectionQuestion(sections, entry) },
  });
  const ranked = Object.entries(response.answers.section.probabilities as Record<string, number>)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  const headingOf = new Map(sections.map((s) => [s.key, s.heading]));
  console.log(`\n${entry.name}`);
  for (const [key, probability] of ranked) {
    console.log(`  ${percent(probability).padStart(4)}  ${headingOf.get(key)}`);
  }
  console.log();
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const root = process.cwd();
  const envPath = join(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error('TYPESAFE_API_KEY is not set. Add it to .env in the repo root.');
  }

  const args = process.argv.slice(2);
  const { sections, entries } = parseReadme(readFileSync(join(root, 'README.md'), 'utf-8'));
  const client = new TypeSafeClient();

  const line = argValue(args, '--suggest');
  if (line) {
    await suggest(client, sections, line);
    return;
  }

  const limit = Number(argValue(args, '--limit') ?? entries.length);
  const selected = entries.slice(0, limit);
  const batches: Entry[][] = [];
  for (let i = 0; i < selected.length; i += ENTRIES_PER_REQUEST) {
    batches.push(selected.slice(i, i + ENTRIES_PER_REQUEST));
  }

  console.log(`🔍 Checking ${selected.length} entries across ${sections.length} sections with ${MODEL}...`);
  const results = (await runPool(batches, CONCURRENT_REQUESTS, (batch) => classify(client, sections, batch))).flat();
  printResults(results, sections);

  const jsonPath = argValue(args, '--json');
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`📝 Wrote every answer to ${jsonPath}`);
  }
}

main().catch((error: unknown) => {
  console.error(`💥 ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
