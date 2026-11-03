#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import {
  ENTRY_PATTERN,
  parseReadme,
  type Entry,
  type Section,
} from './lib/readme';
import { argValue, chunk, percent, requireApiKey, runPool } from './lib/util';

/**
 * Uses TypeSafe's Jev model to check which README section
 * each resource belongs in.
 *
 *   npm run categorize                     audit every entry in README.md
 *   npm run categorize -- --limit 20       audit the first 20 entries only
 *   npm run categorize -- --json out.json  also write every answer to a file
 *   npm run categorize -- --suggest "- [Name](https://url) - description"
 *
 * Needs TYPESAFE_API_KEY, from the environment or from .env in the repo root.
 */

// All question wording and thresholds live here.
const MODEL = 'jev-1.14.0';
const LIST_CONTEXT = {
  title: 'Awesome Design Resources List',
  about:
    'A curated list of links for designers: ' +
    'tools, resources, articles, and inspiration.',
  placement_rule:
    'Sections overlap. Each resource goes in the section that matches ' +
    'its main use, even if it could fit elsewhere.',
};
const SECTION_QUESTION =
  'Which section of the list is the best home for this resource?';

// An entry is misplaced when its current section scores below this.
const MOVE_THRESHOLD = 0.2;
const ENTRIES_PER_REQUEST = 25;
const CONCURRENT_REQUESTS = 4;
const SUGGESTIONS_SHOWN = 3;

const VERDICT_TITLES = {
  move: '🚚 Likely in the wrong section',
  borderline: '🤔 Fits its section, but another fits better',
};

/** The parts of an entry that Jev sees */
type Listing = Pick<Entry, 'name' | 'url' | 'description' | 'ai'>;

/** Section key to the probability that it is the best home */
type Probabilities = Readonly<Record<string, number>>;

type Verdict = 'ok' | 'borderline' | 'move';

interface Placement {
  readonly suggested: string;
  readonly probabilities: Probabilities;
}

interface Result extends Placement {
  readonly entry: Entry;
  readonly verdict: Verdict;
}

interface Context {
  readonly client: TypeSafeClient;
  readonly sections: readonly Section[];
  readonly headingOf: ReadonlyMap<string, string>;
}

function sectionPrompt(listing: Listing) {
  return {
    question: SECTION_QUESTION,
    resource: {
      name: listing.name,
      url: listing.url,
      description: listing.description || '(no description)',
      ...(listing.ai ? { ai_powered: true } : {}),
    },
  };
}

/**
 * Asks Jev for the best section of each listing, in a single request
 */
async function placeListings(
  { client, sections }: Context,
  listings: readonly Listing[],
): Promise<Placement[]> {
  const criteria = Object.fromEntries(sections.map((s) => [s.key, s.heading]));
  const ask = (listing: Listing) => choice(sectionPrompt(listing), criteria);
  const questions = Object.fromEntries(
    listings.map((listing, i) => [`e${i}`, ask(listing)]),
  );

  const { answers } = await client.systemOne({
    model: MODEL,
    state: { list: LIST_CONTEXT },
    questions,
  });

  return listings.map((_, i) => {
    const answer = answers[`e${i}`];
    return { suggested: answer.choice, probabilities: answer.probabilities };
  });
}

function verdictFor(entry: Entry, placement: Placement): Verdict {
  if (placement.suggested === entry.section.key) return 'ok';
  const current = placement.probabilities[entry.section.key] ?? 0;
  return current < MOVE_THRESHOLD ? 'move' : 'borderline';
}

/**
 * Places every entry in batches and compares Jev's pick with its section
 */
async function audit(
  context: Context,
  entries: readonly Entry[],
): Promise<Result[]> {
  const batches = chunk(entries, ENTRIES_PER_REQUEST);
  const placed = await runPool(batches, CONCURRENT_REQUESTS, (batch) =>
    placeListings(context, batch),
  );

  return placed.flat().map((placement, i) => ({
    entry: entries[i],
    ...placement,
    verdict: verdictFor(entries[i], placement),
  }));
}

function printAudit(results: readonly Result[], context: Context): void {
  for (const [verdict, title] of Object.entries(VERDICT_TITLES)) {
    const rows = results.filter((r) => r.verdict === verdict);
    console.log(`\n${title} (${rows.length})\n`);
    rows.forEach((row) => printRow(row, context));
  }

  const ok = results.filter((r) => r.verdict === 'ok').length;
  const total = results.length;
  console.log(`\n✅ ${ok} of ${total} entries are in the section Jev picked.\n`);
}

function printRow(result: Result, { headingOf }: Context): void {
  const { entry, suggested, probabilities } = result;
  const share = (key: string) => percent(probabilities[key]);
  const where = [entry.section.heading, entry.subsection]
    .filter(Boolean)
    .join(' › ');
  const target = headingOf.get(suggested);

  console.log(`  L${entry.line}  ${entry.name}  ${entry.url}`);
  console.log(`        now:     ${where} (${share(entry.section.key)})`);
  console.log(`        suggest: ${target} (${share(suggested)})`);
}

function parseListing(line: string): Listing {
  const match = ENTRY_PATTERN.exec(line.trim());
  if (!match) {
    throw new Error(
      'Expected a list line like: - [Name](https://url) - description',
    );
  }

  const [, ai, name, url, description] = match;
  return { ai: Boolean(ai), name, url, description };
}

/**
 * Prints the best sections for one new list line
 */
async function suggest(context: Context, line: string): Promise<void> {
  const listing = parseListing(line);
  const [{ probabilities }] = await placeListings(context, [listing]);
  const ranked = Object.entries(probabilities)
    .sort(([, a], [, b]) => b - a)
    .slice(0, SUGGESTIONS_SHOWN);

  console.log(`\n${listing.name}`);
  for (const [key, probability] of ranked) {
    const share = percent(probability).padStart(4);
    console.log(`  ${share}  ${context.headingOf.get(key)}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const root = process.cwd();
  requireApiKey(root);

  const args = process.argv.slice(2);
  const readme = readFileSync(join(root, 'README.md'), 'utf-8');
  const { sections, entries } = parseReadme(readme);
  const context: Context = {
    client: new TypeSafeClient(),
    sections,
    headingOf: new Map(sections.map((s) => [s.key, s.heading])),
  };

  const line = argValue(args, '--suggest');
  if (line) {
    await suggest(context, line);
    return;
  }

  const limit = Number(argValue(args, '--limit') ?? entries.length);
  const selected = entries.slice(0, limit);
  const scope = `${selected.length} entries across ${sections.length} sections`;

  console.log(`🔍 Checking ${scope} with ${MODEL}...`);
  const results = await audit(context, selected);
  printAudit(results, context);

  const jsonPath = argValue(args, '--json');
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`📝 Wrote every answer to ${jsonPath}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`💥 ${message}`);
  process.exit(1);
});
