/**
 * `agentobs policy` - guardrail management.
 *
 * `policy test` matters more than it looks: a user has to be able to predict
 * what a rule will do before letting it block their agent mid-task. Without a
 * dry run, the only way to learn a rule is wrong is to have it fire at the
 * worst moment.
 */
import { existsSync } from 'node:fs';
import { paths } from '../core/paths.js';
import {
  contextFromToolInput,
  evaluate,
  loadPolicy,
  writeDefaultPolicy,
} from '../core/policy-engine.js';

export async function policyInit(): Promise<void> {
  const file = paths.policy();
  const existed = existsSync(file);
  writeDefaultPolicy();

  if (existed) {
    console.log(`Policy file already exists, left unchanged: ${file}`);
  } else {
    console.log(`Wrote starter policy: ${file}

It blocks rm -rf and curl-pipe-to-shell, and asks for approval on .env edits
and force-pushes. Edit it, then check your work:

  agentobs policy check
  agentobs policy test Bash "rm -rf ./build"`);
  }
}

export async function policyCheck(): Promise<void> {
  const { policy, errors, source } = loadPolicy();

  if (source === 'none') {
    console.log(`No policy file at ${paths.policy()}.
Every tool call is allowed. Run "agentobs policy init" to add guardrails.`);
    return;
  }

  if (errors.length > 0) {
    console.log(`Problems in ${paths.policy()}:\n`);
    for (const err of errors) console.log(`  ! ${err}`);
    console.log(`
Rules with problems are skipped. AgentObs deliberately fails open - a broken
policy never blocks your agent - so fix these or those rules will not apply.\n`);
  }

  console.log(`Active rules (${policy.rules.length}), first match wins:\n`);
  for (const [i, rule] of policy.rules.entries()) {
    const criteria = [
      rule.match.tool && rule.match.tool !== '*' ? `tool=${rule.match.tool}` : null,
      rule.match.command_pattern ? `command~"${rule.match.command_pattern}"` : null,
      rule.match.path_pattern ? `path~"${rule.match.path_pattern}"` : null,
    ]
      .filter(Boolean)
      .join('  ');
    console.log(`  ${String(i + 1).padStart(2)}. ${rule.decision.toUpperCase().padEnd(15)} ${rule.name}`);
    console.log(`      ${criteria}`);
  }
  console.log(`\n  default: ${policy.default_decision}\n`);
}

export async function policyTest(tool: string, input: string): Promise<void> {
  const { policy, errors } = loadPolicy();
  for (const err of errors) console.log(`  ! ${err}`);

  // Probe both interpretations: the user types a bare string, and we cannot
  // know whether they mean a command or a path. Testing it as both is more
  // useful than making them guess which field name to supply.
  const asCommand = evaluate(policy, contextFromToolInput(tool, { command: input }));
  const asPath = evaluate(policy, contextFromToolInput(tool, { file_path: input }));

  const chosen = asCommand.rule ? asCommand : asPath.rule ? asPath : asCommand;
  const interpretation = asCommand.rule ? 'command' : asPath.rule ? 'file path' : 'command';

  console.log(`
  Tool       ${tool}
  Input      ${input}
  Read as    ${interpretation}
  Decision   ${chosen.decision.toUpperCase()}
  Rule       ${chosen.rule?.name ?? '(none — default_decision applied)'}`);
  if (chosen.message) console.log(`  Message    ${chosen.message}`);

  if (chosen.decision === 'allow') {
    console.log('\n  This call would be allowed to run.\n');
  } else {
    console.log('\n  This call would be BLOCKED before running.\n');
  }
}
