/**
 * AgentObs CLI.
 *
 * Command bodies live in ./commands/*; this file only wires up the grammar so
 * `--help` stays the single readable map of what the tool does.
 */
import { Command } from 'commander';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('agentobs')
    .description('Observability and control for AI coding agents')
    .version(pkg.version);

  program
    .command('init')
    .description('Create ~/.agentobs, the database, and print the Claude Code hook config')
    .option('--force', 'overwrite an existing pricing.json / policy.json', false)
    .action(async (opts) => {
      const { init } = await import('./commands/init.js');
      await init(opts);
    });

  program
    .command('dashboard')
    .description('Serve the local dashboard')
    .option('-p, --port <number>', 'port to listen on', '4300')
    .option('--host <address>', 'address to bind (non-loopback requires a token)', '127.0.0.1')
    .option('--token <value>', 'shared token required when binding a non-loopback address')
    .option('--no-open', 'do not open a browser window')
    .action(async (opts) => {
      const { dashboard } = await import('./commands/dashboard.js');
      await dashboard(opts);
    });

  program
    .command('stats')
    .description('Print usage totals')
    .option('--today', 'today only')
    .option('--since <range>', 'one of: today, 7d, 30d, all', '7d')
    .option('--session <id>', 'restrict to one session')
    .option('--json', 'emit JSON instead of a table', false)
    .action(async (opts) => {
      const { stats } = await import('./commands/stats.js');
      await stats(opts);
    });

  program
    .command('watch')
    .argument('<file>', 'JSONL file to tail')
    .description('Ingest a newline-delimited JSON agent log')
    .option('--agent <name>', 'agent name to record', 'generic')
    .option('--no-follow', 'process existing lines then exit')
    .action(async (file, opts) => {
      const { watch } = await import('./commands/watch.js');
      await watch(file, opts);
    });

  program
    .command('run')
    .description('Run a command under observation (coarse: duration and exit code)')
    .argument('<command...>', 'command to run, after --')
    .option('--agent <name>', 'agent name to record')
    .allowUnknownOption()
    .action(async (command: string[], opts) => {
      const { run } = await import('./commands/run.js');
      await run(command, opts);
    });

  program
    .command('export')
    .description('Export recorded data')
    .requiredOption('--format <format>', 'csv or json')
    .option('--out <path>', 'output file (defaults to stdout)')
    .option('--table <name>', 'sessions, tool-calls, or policy-decisions', 'tool-calls')
    .option('--since <range>', 'today, 7d, 30d, all', 'all')
    .action(async (opts) => {
      const { exportData } = await import('./commands/export.js');
      await exportData(opts);
    });

  const policy = program.command('policy').description('Guardrail policy management');

  policy
    .command('init')
    .description('Write a starter ~/.agentobs/policy.json')
    .action(async () => {
      const { policyInit } = await import('./commands/policy.js');
      await policyInit();
    });

  policy
    .command('check')
    .description('Validate the policy file and list active rules')
    .action(async () => {
      const { policyCheck } = await import('./commands/policy.js');
      await policyCheck();
    });

  policy
    .command('test')
    .description('Dry-run a hypothetical tool call against the policy')
    .argument('<tool>', 'tool name, e.g. Bash')
    .argument('<input...>', 'the command or path to test')
    .action(async (tool: string, input: string[]) => {
      const { policyTest } = await import('./commands/policy.js');
      await policyTest(tool, input.join(' '));
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
