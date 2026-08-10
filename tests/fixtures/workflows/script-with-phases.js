export const meta = {
  name: 'workflows-monitoring-research',
  description: 'Research how to add workflows monitoring to agent-monitor',
  phases: [
    { title: 'Explore', detail: 'codebase map, docs research, on-disk artifacts' },
  ],
}

phase('Explore')

const CODEBASE_SCHEMA = {
  type: 'object',
  properties: {
    architecture: { type: 'string', description: 'How agent-monitor is structured: server, web UI, data ingestion, storage' },
    dataSources: { type: 'array', items: { type: 'string' }, description: 'Where it reads data from (files, dirs, APIs) with exact paths' },
    existingPages: { type: 'array', items: { type: 'string' }, description: 'UI pages/views that exist and what they show' },
    sessionTracking: { type: 'string', description: 'How sessions/agents/tasks are currently discovered and tracked, including polling/watching mechanism' },
    integrationSeams: { type: 'array', items: { type: 'string' }, description: 'Concrete places where workflow monitoring could plug in (files, modules, patterns to follow)' },
    keyFiles: { type: 'array', items: { type: 'string' }, description: 'Most important file paths with one-line description each' },
  },
  required: ['architecture', 'dataSources', 'existingPages', 'sessionTracking', 'integrationSeams', 'keyFiles'],
}

const DOCS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What Claude Code workflows are and how runs are tracked' },
    onDiskArtifacts: { type: 'string', description: 'What files/dirs a workflow run produces (journal, scripts, transcripts) per the docs' },
    observability: { type: 'string', description: 'Any documented ways to observe workflow runs: /workflows command, task notifications, run IDs, resume' },
    relevantUrls: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'string', description: 'What the docs do NOT cover that we would need to reverse-engineer' },
  },
  required: ['summary', 'onDiskArtifacts', 'observability', 'relevantUrls', 'gaps'],
}

const ARTIFACTS_SCHEMA = {
  type: 'object',
  properties: {
    foundRuns: { type: 'array', items: { type: 'string' }, description: 'Paths of actual workflow run directories/files found on this machine' },
    journalSchema: { type: 'string', description: 'Observed schema of journal.jsonl entries with example lines (truncated)' },
    scriptStorage: { type: 'string', description: 'Where workflow scripts are persisted and their naming convention' },
    agentTranscripts: { type: 'string', description: 'How per-agent transcripts are stored (agent-<id>.jsonl etc.) and their structure' },
    liveVsCompleted: { type: 'string', description: 'How to tell a running workflow from a completed one from disk state alone' },
    notes: { type: 'string' },
  },
  required: ['foundRuns', 'journalSchema', 'scriptStorage', 'agentTranscripts', 'liveVsCompleted', 'notes'],
}

const [codebase, docs, artifacts] = await parallel([
  () => agent(
    `Map the agent-monitor codebase at /home/lunatic/projects/work/agent-monitor. This is a tool that monitors Claude Code agent sessions. I need to understand its architecture well enough to design a new "workflows monitoring" feature (monitoring Claude Code Workflow-tool orchestration runs). Read the README, package.json files, server code, and web UI structure. Focus on: how data is ingested (file watching? polling? MCP?), how sessions/tasks are modeled and stored, what UI pages exist, and where a new data source + page would plug in. Be concrete with file paths.`,
    { label: 'map-codebase', schema: CODEBASE_SCHEMA, model: 'sonnet' }
  ),
  () => agent(
    `Research official Claude Code documentation about the Workflow tool / workflows feature (multi-agent orchestration: the Workflow tool, /workflows command, workflow runs, run IDs like wf_*, journal.jsonl, resume). Use WebSearch and WebFetch against docs.claude.com / docs.anthropic.com and Anthropic engineering blog. Also run 'claude --help' or check locally installed Claude Code docs if useful. I'm designing a monitoring feature that observes workflow runs from outside the session, so I care about: what a workflow run writes to disk, how progress is exposed, and any documented observability hooks. Report what the docs cover and what they don't.`,
    { label: 'research-docs', schema: DOCS_SCHEMA, model: 'sonnet' }
  ),
  () => agent(
    `Find REAL Claude Code workflow-run artifacts on this machine and reverse-engineer their schema. Search under ~/.claude/projects (session directories), ~/.config/claude, and any claude state dirs for: workflow scripts persisted by the Workflow tool, journal.jsonl files, agent-<id>.jsonl transcript files, and anything with run IDs matching wf_*. Use rg/find/ls. For each artifact type found, read a sample and describe its JSON schema with short example lines (redact nothing needed, but truncate long values). Crucially: figure out how one could tell from disk state alone whether a workflow is still running vs completed, and how agents map to a parent workflow run. If you find nothing, say exactly which paths you searched.`,
    { label: 'inspect-artifacts', schema: ARTIFACTS_SCHEMA, model: 'sonnet' }
  ),
])

return { codebase, docs, artifacts }