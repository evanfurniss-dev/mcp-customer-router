export type ClientId = 't3' | 'claude-cli' | 'claude-app' | 'codex-app' | 'codex-cli' | 'conductor'

export type ClientSetup = {
  id: ClientId
  name: string
  summary: string
  steps: string[]
  note?: string
  docs: { label: string; url: string }[]
  command?: string
}

export const CLIENT_SETUPS: ClientSetup[] = [
  {
    id: 't3',
    name: 'T3 Code',
    summary: 'Use the customer folder with Claude Code or Codex in T3.',
    steps: [
      'In this router, connect the customer, choose the project folder, then select Preview config and Apply config.',
      'In T3, use the local environment on this Mac and add or select that same project folder.',
      'Choose a signed-in Claude Code or Codex provider and start a new session. Accept any project or tool approval.',
      'Ask the agent to list projects through customer-glide and confirm the customer’s organization.',
    ],
    note: 'If T3 creates a new worktree, apply the router setup to that folder too. The saved Glide sign-in is reused. Other T3 providers need their own MCP setup.',
    docs: [
      { label: 'T3 Claude setup', url: 'https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md' },
      { label: 'T3 Codex setup', url: 'https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md' },
    ],
  },
  {
    id: 'claude-cli',
    name: 'Claude Code CLI',
    summary: 'Start Claude from the folder linked to the customer.',
    steps: [
      'In this router, connect the customer, choose the project folder, then select Preview config and Apply config.',
      'Open a terminal in that folder and run claude. Sign in to Claude if needed.',
      'Accept the project trust prompt and approve customer-glide. Use /mcp to check its connection.',
      'Ask Claude to list projects through customer-glide and confirm the customer’s organization.',
    ],
    note: 'The router adds customer-glide to .mcp.json. After changing its setup, start a new Claude session. Apply setup again for a new worktree.',
    command: 'claude',
    docs: [{ label: 'Claude Code MCP setup', url: 'https://code.claude.com/docs/en/mcp' }],
  },
  {
    id: 'claude-app',
    name: 'Claude app',
    summary: 'Use the Code tab with a local project on this Mac.',
    steps: [
      'In this router, connect the customer, choose the project folder, then select Preview config and Apply config.',
      'Open Claude’s Code tab. Choose a local session and select that same folder.',
      'Start a new session and accept any project or tool approval. If Claude creates a worktree, apply router setup to that worktree and restart the session.',
      'Ask Claude to list projects through customer-glide and confirm the customer’s organization.',
    ],
    note: 'This setup covers the local Code tab. Claude chat and Cowork need separate integration. A customer-glide entry in Claude’s desktop or user settings can override the folder’s entry.',
    docs: [{ label: 'Claude desktop configuration', url: 'https://code.claude.com/docs/en/desktop#shared-configuration' }],
  },
  {
    id: 'codex-app',
    name: 'Codex app',
    summary: 'Use the customer’s local folder in the Codex app.',
    steps: [
      'In this router, connect the customer, choose the project folder, then select Preview config and Apply config.',
      'Add or open that folder as a project in Codex. Use a local session on this Mac.',
      'Trust the project when asked, then start a new session so Codex loads its .codex/config.toml.',
      'Ask Codex to list projects through customer-glide and confirm the customer’s organization.',
    ],
    note: 'Codex loads project settings only for trusted projects. Apply router setup to each new worktree. Cloud tasks do not have this Mac’s router or saved sign-in.',
    docs: [{ label: 'Codex MCP setup', url: 'https://learn.chatgpt.com/docs/extend/mcp#connect-codex-to-an-mcp-server' }],
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    summary: 'Run Codex in the customer’s linked folder.',
    steps: [
      'In this router, connect the customer, choose the project folder, then select Preview config and Apply config.',
      'Open a terminal in that folder and run codex. Sign in to Codex if needed.',
      'Trust the project when asked. Use /mcp to check that customer-glide is available.',
      'Ask Codex to list projects through customer-glide and confirm the customer’s organization.',
    ],
    note: 'The router adds customer-glide to .codex/config.toml. Start a new session after setup changes. A new worktree needs its own router setup and project trust.',
    command: 'codex',
    docs: [{ label: 'Codex MCP setup', url: 'https://learn.chatgpt.com/docs/extend/mcp#connect-codex-to-an-mcp-server' }],
  },
  {
    id: 'conductor',
    name: 'Conductor',
    summary: 'Link the local workspace that Conductor creates.',
    steps: [
      'Create a local workspace in Conductor. Open its terminal and run pwd to find the workspace folder.',
      'In this router, open the connected customer and choose that workspace folder. Select Preview config and Apply config.',
      'Start a new Claude Code or Codex session in that workspace and accept any project or tool approval.',
      'Refresh MCP status in Conductor. Ask the agent to list projects through customer-glide and confirm the customer’s organization.',
    ],
    note: 'Each new Conductor workspace needs its own folder link. The saved Glide sign-in is reused. Conductor cloud workspaces cannot run this Mac’s local router.',
    command: 'pwd',
    docs: [
      { label: 'Conductor MCP setup', url: 'https://www.conductor.build/docs/reference/mcp' },
      { label: 'Conductor worktrees', url: 'https://www.conductor.build/docs/concepts/git-worktrees' },
    ],
  },
]
