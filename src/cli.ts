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
    .description('Set up everything: database, hooks, starter policy, and import your history')
    .option('--force', 'overwrite existing config, and add hooks alongside foreign ones', false)
    .option('--print-hooks', 'print the hook config instead of installing it', false)
    .option('--no-hooks', 'do not touch ~/.claude/settings.json')
    .option('--no-import', 'do not import existing Claude Code history')
    .option('--project <dir>', "install into a project's .claude/ instead of your home")
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
    .option('--since <range>', 'today, 7d, 30d, all, or a YYYY-MM-DD date', '7d')
    .option('--until <date>', 'end of an explicit date window (YYYY-MM-DD)')
    .option('--breakdown', 'add a per-model cost breakdown', false)
    .option('--session <id>', 'restrict to one session')
    .option('--json', 'emit JSON instead of a table', false)
    .action(async (opts) => {
      const { stats } = await import('./commands/stats.js');
      await stats(opts);
    });

  program
    .command('watch')
    .argument('[file]', 'JSONL file to tail')
    .description('Ingest a newline-delimited JSON agent log')
    .addHelpText(
      'after',
      `
Example:
  agentobs watch ./agent-log.jsonl --agent my-agent

The file should contain one JSON object per line with a "type" field
(session_start, tool_call_start, tool_call_end, session_end).`,
    )
    .option('--agent <name>', 'agent name to record', 'generic')
    .option('--no-follow', 'process existing lines then exit')
    .action(async (file: string | undefined, opts) => {
      const { watch } = await import('./commands/watch.js');
      await watch(file, opts);
    });

  program
    .command('run')
    .description('Run a command under observation (coarse: duration and exit code)')
    .addHelpText(
      'after',
      `
Examples:
  agentobs run -- npm test
  agentobs run -- claude
  agentobs run -- git status

Note the "--": everything after it is the command to observe.
On Windows, cmd.exe builtins (dir, echo, type) need: agentobs run -- cmd /c dir`,
    )
    .argument('[command...]', 'command to run, after --')
    .option('--agent <name>', 'agent name to record')
    .allowUnknownOption()
    .action(async (command: string[] | undefined, opts) => {
      const { run } = await import('./commands/run.js');
      await run(command ?? [], opts);
    });

  program
    .command('agents')
    .description('Which coding agents are on this machine, and import from them')
    .option('--import', 'import from every detected agent', false)
    .option('--agent <id>', 'restrict to one agent id')
    .option('--days <n>', 'only logs modified in the last n days', '30')
    .option('--json', 'emit JSON', false)
    .addHelpText(
      'after',
      `
Claude Code's format is verified against real transcripts. The others are
declared from published paths and marked [unverified] until someone
confirms them - a tool that claims support and silently records nothing
is worse than one that admits what it cannot read.

Add an agent by writing a source definition into ~/.agentobs/sources.json;
a definition with an existing id replaces the built-in one.`,
    )
    .action(async (opts) => {
      const { agents } = await import('./commands/agents.js');
      await agents(opts);
    });

  program
    .command('agents:verify')
    .alias('verify-agent')
    .description('Check a field map against real log files, without importing')
    .option('--agent <id>', 'restrict to one agent id')
    .option('--files <n>', 'how many files to sample per agent', '5')
    .option('--json', 'emit JSON', false)
    .addHelpText(
      'after',
      `
Reports, field by field, which declared dot-path resolved against your real
logs and what it resolved to. Read-only: nothing is written to the database,
so it is safe to run against an adapter you do not trust yet.

A field map that is mostly right shows as one MISSING row rather than a
confusing zero total.`,
    )
    .action(async (opts: { agent?: string; json?: boolean; files?: string }) => {
      const { agentsVerify } = await import('./commands/verify-source.js');
      await agentsVerify(opts);
    });

  program
    .command('import')
    .description("Import Claude Code's own transcripts (no hook setup needed)")
    .option('--days <n>', 'only sessions modified in the last n days', '7')
    .option('--all', 'import every transcript found, however old', false)
    .option('--dry-run', 'list what would be imported, write nothing', false)
    .option('--session <id>', 'import one specific session id')
    .option('--watch', 'keep importing as sessions run (live, no hooks)', false)
    .addHelpText(
      'after',
      `
Claude Code writes a JSONL transcript per session under
~/.claude/projects/. This reads them directly, so it works even when
hooks are not firing - and it backfills everything you have already done.

Examples:
  agentobs import                 last 7 days
  agentobs import --all           everything
  agentobs import --dry-run       show what would be imported

Historical data cannot be blocked retroactively; guardrails still need
the PreToolUse hook.`,
    )
    .action(async (opts) => {
      const { importCommand } = await import('./commands/import.js');
      await importCommand(opts);
    });

  program
    .command('prune')
    .description('Delete old data and reclaim disk space')
    .option('--older-than <days>', 'delete data older than this many days', '90')
    .option('--sessions', 'remove whole sessions too, not just their tool calls', false)
    .option('--dry-run', 'report what would go, delete nothing', false)
    .option('--yes', 'skip the confirmation', false)
    .addHelpText(
      'after',
      `
By default only per-call detail and policy decisions are removed, so your
cost history survives. --sessions drops the sessions as well.

Deleting is irreversible, so it asks for --yes unless you pass --dry-run.`,
    )
    .action(async (opts) => {
      const { prune } = await import('./commands/prune.js');
      await prune(opts);
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

  program
    .command('digest')
    .description('A readable period summary: spend, top tools, projects, budgets')
    .option('--since <range>', 'today, 7d, 30d, all', '7d')
    .option('--json', 'emit JSON instead of prose', false)
    .action(async (opts) => {
      const { digest } = await import('./commands/digest.js');
      await digest(opts);
    });

  program
    .command('projects')
    .description('Spend and activity grouped by working directory')
    .option('--since <range>', 'today, 7d, 30d, all', '7d')
    .option('--json', 'emit JSON', false)
    .action(async (opts) => {
      const { projects } = await import('./commands/projects.js');
      await projects(opts);
    });

  program
    .command('approvals')
    .description('Tool calls held for your approval')
    .option('--all', 'include already-decided requests', false)
    .action(async (opts) => {
      const { approvals } = await import('./commands/approve.js');
      await approvals(opts);
    });

  program
    .command('approve')
    .description('Allow a held tool call')
    .argument('[id]', 'request id or prefix')
    .option('--all', 'approve everything pending', false)
    .action(async (id: string | undefined, opts) => {
      const { approve } = await import('./commands/approve.js');
      await approve(id, opts);
    });

  program
    .command('deny')
    .description('Refuse a held tool call')
    .argument('<id>', 'request id or prefix')
    .action(async (id: string) => {
      const { deny } = await import('./commands/approve.js');
      await deny(id);
    });

  program
    .command('daemon')
    .description('Keep a warm process so the statusline and hooks skip Node startup')
    .option('--idle <minutes>', 'exit after this long with no requests (0 = never)', '60')
    .option('--quiet', 'no startup banner', false)
    .addHelpText(
      'after',
      `
Node takes ~40ms to start on Linux/macOS and can exceed a second on
Windows with antivirus scanning - while AgentObs's own work for a
statusline render is 0.10ms. The daemon holds the database open so hot
paths become a socket round trip instead of a process launch.

Optional: everything works without it, just slower.`,
    )
    .action(async (opts) => {
      const { daemon } = await import('./commands/daemon.js');
      await daemon(opts);
    });

  program
    .command('mcp')
    .description('Run as an MCP server so the agent can query its own usage')
    .addHelpText(
      'after',
      `
Lets you ask Claude "how much have I spent today?" or "am I close to my
limit?" and have it answer from real local data. Add with:

  claude mcp add agentobs -- agentobs mcp

Exposes: get_usage, get_budget_status, get_projects, get_top_tools.
All read-only, all local.`,
    )
    .action(async () => {
      const { mcp } = await import('./commands/mcp.js');
      await mcp();
    });

  program
    .command('statusline')
    .description("Compact status line for Claude Code's status bar (reads JSON on stdin)")
    .option('--show <segments>', 'comma-separated: limit,budget,cost,context', 'limit,budget,cost,context')
    .addHelpText(
      'after',
      `
Add to ~/.claude/settings.json:

  "statusLine": { "type": "command", "command": "agentobs statusline" }

Shows your 5-hour rate limit, the budget closest to its limit, session
cost and context use. The budget segment is the part no other status
line can show - it needs a limit you set, not usage alone.`,
    )
    .action(async (opts) => {
      const { statusline } = await import('./commands/statusline.js');
      await statusline(opts);
    });

  program
    .command('forecast')
    .description('When will you hit your limit at the current burn rate?')
    .option('--watch', 'refresh live instead of printing once', false)
    .option('--json', 'emit JSON', false)
    .addHelpText(
      'after',
      `
Needs at least one budget - a forecast requires the limit as well as the
usage, which is why a read-only usage tool cannot tell you this.

  agentobs budget set --block5h 200000 --tokens
  agentobs forecast --watch`,
    )
    .action(async (opts) => {
      const { forecast } = await import('./commands/forecast.js');
      await forecast(opts);
    });

  program
    .command('uninstall-hooks')
    .description("Remove AgentObs's hooks from your Claude Code settings")
    .option('--project <dir>', "remove from a project's .claude/ instead of your home")
    .action(async (opts) => {
      const { uninstallHooks } = await import('./commands/install-hooks.js');
      const r = uninstallHooks({ projectDir: opts.project });
      if (r.installed.length === 0) {
        console.log('No AgentObs hooks were configured.');
        return;
      }
      console.log(`Removed AgentObs hooks from ${r.settingsPath}`);
      console.log(`  events : ${r.installed.join(', ')}`);
      if (r.backupPath) console.log(`  backup : ${r.backupPath}`);
      console.log('');
      console.log('Restart Claude Code for the change to take effect.');
    });

  const budget = program
    .command('budget')
    .description('Spend limits - warn or block when an agent passes a threshold')
    .action(async () => {
      const { budgetStatus } = await import('./commands/budget.js');
      await budgetStatus();
    });

  budget
    .command('set')
    .description('Set a spend limit')
    .option('--daily <usd>', 'daily limit in USD')
    .option('--weekly <usd>', 'weekly limit in USD')
    .option('--monthly <usd>', 'monthly limit in USD')
    .option('--block5h <amount>', "limit for Claude's rolling 5-hour window")
    .option('--tokens', 'treat the limits as token counts, not dollars', false)
    .option('--block', 'refuse tool calls past the limit (default: warn only)', false)
    .option('--scope <path>', 'apply only to sessions under this directory')
    .action(async (opts) => {
      const { budgetSet } = await import('./commands/budget.js');
      await budgetSet(opts);
    });

  budget
    .command('remove')
    .description('Remove a budget')
    .argument('<id>', 'budget id, id prefix, or period name')
    .action(async (id: string) => {
      const { budgetRemove } = await import('./commands/budget.js');
      await budgetRemove(id);
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

  const notify = program
    .command('notify')
    .description('Send budget and approval alerts to Slack, Discord, or your own endpoint');

  notify
    .command('set')
    .description('Add or update an alert destination')
    .argument('<url>', 'https webhook URL (Slack and Discord both work as-is)')
    .option('--format <format>', 'slack (default) or json for your own receiver')
    .option('--events <list>', 'comma-separated: budget_exceeded,call_blocked,approval_requested')
    .action(async (url: string, opts: { format?: string; events?: string }) => {
      const { notifySet } = await import('./commands/notify.js');
      await notifySet(url, opts);
    });

  notify
    .command('list')
    .description('Show configured destinations')
    .action(async () => {
      const { notifyList } = await import('./commands/notify.js');
      await notifyList();
    });

  notify
    .command('remove')
    .description('Remove an alert destination')
    .argument('<url>', 'the URL to remove')
    .action(async (url: string) => {
      const { notifyRemove } = await import('./commands/notify.js');
      await notifyRemove(url);
    });

  notify
    .command('test')
    .description('Send a real test alert and report what came back')
    .action(async () => {
      const { notifyTest } = await import('./commands/notify.js');
      await notifyTest();
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
