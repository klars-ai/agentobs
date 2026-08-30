/**
 * Plain-English descriptions of agent tools.
 *
 * A dashboard row reading "Bash 11,266 calls" tells a reader nothing unless
 * they already know what Bash does in an agent context - and the person most
 * likely to open this dashboard is the one asking "what is my agent actually
 * doing", which is exactly the question a bare tool name refuses to answer.
 *
 * Two constraints shaped this:
 *
 *  1. Descriptions say what the tool does *and why the agent reaches for it*,
 *     because "runs a shell command" is only half an answer to "why 11,266
 *     times".
 *  2. An unknown tool gets no description rather than a guessed one. MCP
 *     servers contribute arbitrary tool names, and inventing a plausible
 *     sentence about one would be exactly the fabrication this project refuses
 *     everywhere else.
 */

export interface ToolInfo {
  /** One sentence, shown on hover. */
  description: string;
  /** Rough grouping, used for a colour hint in the UI. */
  category: 'shell' | 'files' | 'search' | 'web' | 'agent' | 'planning' | 'other';
}

/**
 * Known Claude Code tools.
 *
 * Names are matched case-insensitively and exactly. A tool that renames itself
 * simply falls through to "no description", which is the correct outcome.
 */
export const TOOL_INFO: Record<string, ToolInfo> = {
  bash: {
    description:
      'Runs a shell command. The agent uses this for almost everything with no dedicated tool - builds, tests, git, package managers - which is why it is usually the busiest row here.',
    category: 'shell',
  },
  powershell: {
    description: 'Runs a PowerShell command. The Windows counterpart to Bash.',
    category: 'shell',
  },
  read: {
    description:
      'Reads a file into the conversation. Every read stays in context for the rest of the session, so large or repeated reads are a common source of token growth.',
    category: 'files',
  },
  write: {
    description: 'Creates a file, or replaces one entirely. Existing files must be read first.',
    category: 'files',
  },
  edit: {
    description:
      'Changes part of a file by matching exact text. Cheaper than rewriting the whole file, and the usual reason an agent reads a file before changing it.',
    category: 'files',
  },
  notebookedit: {
    description: 'Edits a cell in a Jupyter notebook.',
    category: 'files',
  },
  glob: {
    description:
      'Finds files by name pattern, like **/*.ts. Used to locate files without reading any of them.',
    category: 'search',
  },
  grep: {
    description:
      'Searches file contents by regular expression. The cheap way to find code - it returns matching lines rather than whole files.',
    category: 'search',
  },
  toolsearch: {
    description:
      'Looks up the definition of a tool that is available but not yet loaded, so its schema can be used.',
    category: 'search',
  },
  webfetch: {
    description:
      'Fetches a URL and answers a question about it. The page is summarised by a smaller model, so the full text never enters the main conversation.',
    category: 'web',
  },
  websearch: {
    description: 'Searches the web and returns result titles and URLs.',
    category: 'web',
  },
  agent: {
    description:
      'Delegates work to a subagent with its own context window. Keeps verbose exploration out of the main conversation, but each subagent costs tokens of its own.',
    category: 'agent',
  },
  task: {
    description: 'Delegates work to a subagent with its own context window.',
    category: 'agent',
  },
  workflow: {
    description:
      'Runs a scripted multi-agent workflow. Can spawn many subagents, so it is worth checking against cost.',
    category: 'agent',
  },
  sendmessage: {
    description: 'Sends a message to another agent or session.',
    category: 'agent',
  },
  taskoutput: {
    description: 'Reads the output of a background task that is still running.',
    category: 'agent',
  },
  taskstop: {
    description: 'Stops a running background task.',
    category: 'agent',
  },
  monitor: {
    description:
      'Watches a command or condition until it changes. Duration here reflects waiting, not work.',
    category: 'agent',
  },
  schedulewakeup: {
    description: 'Schedules the agent to resume later. The wait itself costs nothing.',
    category: 'agent',
  },
  todowrite: {
    description:
      'Updates the agent’s task list. Cheap, and a rough proxy for how the agent broke the work up.',
    category: 'planning',
  },
  askuserquestion: {
    description:
      'Asks you a question and waits for an answer. Long durations here are your thinking time, not the agent working.',
    category: 'planning',
  },
  enterplanmode: {
    description: 'Switches to planning, where the agent explores before changing anything.',
    category: 'planning',
  },
  exitplanmode: {
    description: 'Presents a plan for approval before acting on it.',
    category: 'planning',
  },
  skill: {
    description:
      'Loads a packaged set of instructions for a particular kind of task, in place of the default approach.',
    category: 'other',
  },
  artifact: {
    description: 'Publishes an HTML page to a shareable URL.',
    category: 'other',
  },
  senduserfile: {
    description:
      'Sends a local file to you, for when the result is a file rather than something to read in the terminal.',
    category: 'other',
  },
  reportfindings: {
    description: 'Reports code-review findings as structured data.',
    category: 'other',
  },
};

/**
 * Description for a tool name, or null when we genuinely do not know it.
 *
 * MCP servers namespace their tools as `mcp__server__tool`, which is worth
 * saying something honest about: we do not know what that specific tool does,
 * but we do know where it came from, and naming the server is more useful than
 * silence.
 */
export function describeTool(name: string): ToolInfo | null {
  const known = TOOL_INFO[name.toLowerCase()];
  if (known) return known;

  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) {
    return {
      description: `Provided by the "${mcp[1]}" MCP server. AgentObs does not know what this tool does - only the server does.`,
      category: 'other',
    };
  }

  // A name we have never seen. Saying nothing is correct: a plausible-sounding
  // guess about an unknown tool is worse than an absent tooltip.
  return null;
}
