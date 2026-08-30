/**
 * `agentobs agents` - which agents are on this machine, and import from them.
 *
 * Reports honestly: a source whose format was never checked against a real
 * file is labelled unverified, and one that yields no usage data says so
 * rather than reporting a confident zero.
 */
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { agentobsHome } from '../core/paths.js';
import { allSources, discover, type AgentSource } from '../adapters/agent-sources.js';
import { importGenericLog } from '../adapters/generic-import.js';

export interface AgentsOptions {
  /** Import from every detected source, not just list them. */
  import?: boolean;
  /** Restrict to one agent id. */
  agent?: string;
  days?: string;
  json?: boolean;
}

const sourcesFile = (): string => join(agentobsHome(), 'sources.json');
const money = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(4)}`);

export async function agents(opts: AgentsOptions = {}): Promise<void> {
  const sources = allSources(sourcesFile()).filter(
    (s) => !opts.agent || s.id === opts.agent,
  );

  const detected: Array<{ source: AgentSource; files: number; newest: number }> = [];
  for (const source of sources) {
    const files = discover(source);
    if (files.length > 0) {
      detected.push({ source, files: files.length, newest: files[0].modifiedAt });
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          detected: detected.map((d) => ({ id: d.source.id, files: d.files, status: d.source.status })),
          known: sources.map((s) => ({ id: s.id, label: s.label, status: s.status })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!opts.import) {
    console.log('\n  Agents found on this machine:\n');
    if (detected.length === 0) {
      console.log('    none\n');
    } else {
      for (const d of detected) {
        const age = Math.round((Date.now() - d.newest) / 36e5);
        const flag = d.source.status === 'unverified' ? '  [unverified format]' : '';
        console.log(
          `    ${d.source.label.padEnd(22)} ${String(d.files).padStart(4)} log(s), newest ${age}h ago${flag}`,
        );
      }
      console.log('');
    }

    const missing = sources.filter((s) => !detected.some((d) => d.source.id === s.id));
    if (missing.length > 0) {
      console.log('  Known but not found here: ' + missing.map((s) => s.label).join(', ') + '\n');
    }

    console.log(`  agentobs agents --import        read everything found
  agentobs agents --agent copilot-cli --import

  Add an agent AgentObs does not know about by writing a source
  definition into ${sourcesFile()} - see CONTRIBUTING.md.
`);
    return;
  }

  if (detected.length === 0) {
    console.log('\n  No agent logs found to import.\n');
    return;
  }

  const db = openDb();
  const days = Number(opts.days ?? 30);
  const cutoff = Date.now() - days * 864e5;

  console.log('');
  for (const { source } of detected) {
    const files = discover(source).filter((f) => f.modifiedAt >= cutoff);
    if (files.length === 0) continue;

    let calls = 0;
    let tokens = 0;
    let cost: number | null = null;
    let unreadable = 0;

    for (const file of files) {
      try {
        const r = await importGenericLog(db, file);
        calls += r.toolCalls;
        tokens += r.tokensIn + r.tokensOut;
        if (r.cost !== null) cost = (cost ?? 0) + r.cost;
        // Every line parsed but nothing matched: the field map is wrong for
        // this agent's real format.
        if (r.linesRead > 0 && r.tokensIn === 0 && r.tokensOut === 0 && r.toolCalls === 0) {
          unreadable += 1;
        }
      } catch {
        unreadable += 1;
      }
    }

    console.log(
      `  ${source.label.padEnd(22)} ${String(files.length).padStart(4)} file(s)  ` +
        `${String(calls).padStart(6)} calls  ${String(tokens).padStart(12)} tokens  ${money(cost).padStart(10)}`,
    );

    if (unreadable === files.length && source.status === 'unverified') {
      console.log(
        `    No usage data recognised in these files. The field map for\n` +
          `    ${source.id} is unverified - it was written from documentation.\n` +
          `    Fix it in ${sourcesFile()} and it will take effect immediately.`,
      );
    }
  }
  console.log('\n  Run "agentobs stats --since all" or open the dashboard.\n');
}
