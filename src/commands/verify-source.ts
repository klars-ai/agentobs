/**
 * `agentobs agents verify` - check a field map against real log files.
 *
 * Adding an adapter is easy; knowing whether it *works* is the hard part, and
 * until now the only way to find out was to run an import and see whether the
 * numbers looked plausible. That is a bad test for three reasons: it writes to
 * the user's database before it is trusted, it reports a single aggregate that
 * hides which field is wrong, and a wrong field map produces zero rather than
 * an error - so it looks exactly like a quiet week.
 *
 * This command answers the question directly and without side effects: for
 * each declared field, which dot-path resolved, on how many lines, and to what
 * kind of value. A field map that is 90% right shows as one missing row rather
 * than a confusing total.
 *
 * It is deliberately read-only. Verification you are afraid to run is
 * verification nobody runs.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { allSources, discover, pick, type AgentSource, type FieldMap } from '../adapters/agent-sources.js';
import { paths } from '../core/paths.js';
import { join } from 'node:path';

/** How many lines to sample per file. Enough to be representative, bounded so a huge log stays fast. */
const SAMPLE_LINES = 2_000;

interface FieldReport {
  field: string;
  /** True when this field is optional and its absence is not a failure. */
  optional: boolean;
  /** The first declared path that resolved, if any. */
  resolvedPath: string | null;
  /** How many sampled lines produced a value. */
  hits: number;
  /** An example value, truncated - so a human can see it is the right thing. */
  sample: string | null;
  /** Set when a value resolved but is not the type the importer expects. */
  warning: string | null;
}

export interface VerifyReport {
  source: AgentSource;
  filesFound: number;
  filesSampled: number;
  linesParsed: number;
  linesUnparseable: number;
  fields: FieldReport[];
  /** True when the required token fields both resolved on at least one line. */
  usable: boolean;
}

/** Fields the importer needs to record anything at all. */
const REQUIRED: (keyof FieldMap)[] = ['inputTokens', 'outputTokens', 'timestamp'];

const OPTIONAL: (keyof FieldMap)[] = [
  'cacheReadTokens',
  'cacheWriteTokens',
  'model',
  'toolName',
  'toolInput',
  'sessionId',
];

/** Truncates a value for display without hiding its shape. */
function preview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 48 ? `"${value.slice(0, 45)}..."` : `"${value}"`;
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 48 ? `${json.slice(0, 45)}...` : json;
  }
  return String(value);
}

/**
 * Flags a value that resolved but is the wrong shape.
 *
 * This catches the subtle failure: a path that points at an object when the
 * importer wants a number reads as "working" in a hit count, then silently
 * contributes zero tokens.
 */
function checkType(field: keyof FieldMap, value: unknown): string | null {
  const numeric = field === 'inputTokens' || field === 'outputTokens' ||
    field === 'cacheReadTokens' || field === 'cacheWriteTokens';

  if (numeric) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return `expected a number, got ${typeof value}`;
    }
    return null;
  }
  if (field === 'timestamp') {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      return `expected a parseable date string, got ${preview(value)}`;
    }
    return null;
  }
  if ((field === 'model' || field === 'toolName' || field === 'sessionId') && typeof value !== 'string') {
    return `expected a string, got ${typeof value}`;
  }
  return null;
}

/** Samples a source's real files and reports what each declared field resolves to. */
export async function verifySource(source: AgentSource, maxFiles = 5): Promise<VerifyReport> {
  const files = discover(source);
  const sampled = files.slice(0, maxFiles);

  const fieldNames = [...REQUIRED, ...OPTIONAL];
  const state = new Map<
    string,
    { path: string | null; hits: number; sample: string | null; warning: string | null }
  >(fieldNames.map((f) => [f, { path: null, hits: 0, sample: null, warning: null }]));

  let linesParsed = 0;
  let linesUnparseable = 0;

  for (const file of sampled) {
    if (!existsSync(file.path)) continue;
    const rl = createInterface({
      input: createReadStream(file.path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let seen = 0;
    for await (const line of rl) {
      if (seen >= SAMPLE_LINES) break;
      if (!line.trim()) continue;
      seen += 1;

      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        linesUnparseable += 1;
        continue;
      }
      linesParsed += 1;

      for (const field of fieldNames) {
        const declared = source.fields[field] as string[] | undefined;
        if (!declared) continue;
        const value = pick(row, declared);
        if (value === undefined || value === null) continue;

        const entry = state.get(field)!;
        entry.hits += 1;
        if (entry.path === null) {
          // Record which of the declared paths actually won, so a maintainer
          // can drop the ones that never fire.
          entry.path =
            declared.find((p) => pick(row, [p]) !== undefined && pick(row, [p]) !== null) ?? null;
          entry.sample = preview(value);
          entry.warning = checkType(field, value);
        }
      }
    }
    rl.close();
  }

  const fields: FieldReport[] = fieldNames
    .filter((f) => source.fields[f] !== undefined)
    .map((f) => {
      const e = state.get(f)!;
      return {
        field: f,
        optional: !REQUIRED.includes(f),
        resolvedPath: e.path,
        hits: e.hits,
        sample: e.sample,
        warning: e.warning,
      };
    });

  // Both token fields must resolve. `some` here would call a map that reads
  // input but never output "working", which is the silent under-reporting this
  // command exists to catch.
  const tokenFields = fields.filter(
    (f) => f.field === 'inputTokens' || f.field === 'outputTokens',
  );
  const tokensResolve =
    tokenFields.length === 2 && tokenFields.every((f) => f.hits > 0 && !f.warning);

  return {
    source,
    filesFound: files.length,
    filesSampled: sampled.length,
    linesParsed,
    linesUnparseable,
    fields,
    usable: tokensResolve && linesParsed > 0,
  };
}

export interface VerifyOptions {
  agent?: string;
  json?: boolean;
  files?: string;
}

export async function agentsVerify(opts: VerifyOptions = {}): Promise<void> {
  const sourcesFile = join(paths.home(), 'sources.json');
  const all = allSources(sourcesFile);
  const wanted = opts.agent ? all.filter((s) => s.id === opts.agent) : all;

  if (wanted.length === 0) {
    console.error(`No source with id "${opts.agent}". Known: ${all.map((s) => s.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const maxFiles = Math.max(1, Number(opts.files ?? 5) || 5);
  const reports: VerifyReport[] = [];
  for (const source of wanted) {
    reports.push(await verifySource(source, maxFiles));
  }

  if (opts.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  let anyChecked = false;

  for (const r of reports) {
    const status = r.source.status === 'verified' ? 'verified' : 'unverified';
    console.log(`\n${r.source.label}  [${r.source.id}] (${status})`);

    if (r.filesFound === 0) {
      // Not a failure: most machines have only one or two agents installed.
      console.log(`  Not installed here - no files under ${r.source.roots.join(', ')}`);
      continue;
    }
    anyChecked = true;

    console.log(
      `  ${r.filesFound} file(s) found, sampled ${r.filesSampled}; ` +
        `${r.linesParsed} JSON line(s)` +
        (r.linesUnparseable > 0 ? `, ${r.linesUnparseable} unparseable` : ''),
    );

    if (r.linesParsed === 0) {
      console.log(`  Nothing parsed as JSON. This agent's logs are probably not JSONL.`);
      continue;
    }

    console.log('');
    for (const f of r.fields) {
      const mark = f.hits > 0 ? (f.warning ? '!' : 'ok') : f.optional ? '-' : 'MISSING';
      const label = `${mark.padEnd(8)}${f.field.padEnd(17)}`;

      if (f.hits === 0) {
        console.log(`  ${label}no declared path resolved`);
        continue;
      }
      console.log(`  ${label}${f.hits} hit(s) via ${f.resolvedPath}  ->  ${f.sample}`);
      if (f.warning) console.log(`  ${' '.repeat(25)}${f.warning}`);
    }

    console.log('');
    if (r.usable) {
      console.log(`  Token fields resolve. This field map works against real files here.`);
      if (r.source.status === 'unverified') {
        console.log(
          `  It is still marked unverified. If this looks right, that is worth\n` +
            `  reporting: https://github.com/klars-ai/agentobs/issues`,
        );
      }
    } else {
      // Naming the failing fields is the whole value here: "did not resolve"
      // sends someone back to re-read every path, one broken name does not.
      const broken = r.fields
        .filter((f) => !f.optional && (f.hits === 0 || f.warning))
        .map((f) => f.field);
      console.log(
        `  Not usable yet: ${broken.join(', ')} did not resolve.\n` +
          `  An import would under-report, or record nothing at all.\n\n` +
          `  Fix those paths in ~/.agentobs/sources.json and run this again -\n` +
          `  a definition with an existing id replaces the built-in one.`,
      );
    }
  }

  if (!anyChecked) {
    console.log(`\nNone of these agents are installed here, so nothing could be checked.`);
    console.log(`Verification needs real files - that is the whole point of it.`);
  }
  console.log('');
}
