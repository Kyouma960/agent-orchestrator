/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Three layers:
 *   1. BASE_AGENT_PROMPT — constant instructions about session lifecycle, git workflow, PR handling
 *   2. Config-derived context — project name, repo, default branch, tracker info, reaction rules
 *   3. User rules — inline agentRules and/or agentRulesFile content
 *
 * buildPrompt() always returns the AO base guidance and project context so
 * bare launches still know about AO-specific commands such as PR claiming.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig, Issue, TrackerProject, ParallelProjectResult } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

export const BASE_AGENT_PROMPT = `You are an AI coding agent managed by the Agent Orchestrator (ao).

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- When you finish your work, create a PR and push it. The orchestrator will handle CI monitoring and review routing.
- If you're told to take over or continue work on an existing PR, run \`ao session claim-pr <pr-number-or-url>\` from inside this session before making changes.
- If CI fails, the orchestrator will send you the failures — fix them and push again.
- If reviewers request changes, the orchestrator will forward their comments — address each one, push fixes, and reply to the comments.

## Git Workflow
- Always create a feature branch from the default branch (never commit directly to it).
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR when the implementation is ready.
- Keep PRs focused — one issue per PR.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.`;

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);
  lines.push(`- Repository: ${project.repo}`);
  lines.push(`- Default branch: ${project.defaultBranch}`);

  if (project.tracker) {
    lines.push(`- Tracker: ${project.tracker.plugin}`);
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    lines.push(
      `Create a branch named so that it auto-links to the issue tracker (e.g. feat/${issueId}).`,
    );
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: auto-handled (you'll receive instructions)`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: USER RULES
// =============================================================================

function readUserRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  if (project.agentRulesFile) {
    const filePath = resolve(project.path, project.agentRulesFile);
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(content);
      }
    } catch {
      // File not found or unreadable — skip silently (don't crash the spawn)
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 *
 * Always returns the AO base guidance plus project context, then layers on
 * issue context, user rules, and explicit instructions when available.
 */
export function buildPrompt(config: PromptBuildConfig): string {
  const userRules = readUserRules(config.project);
  const sections: string[] = [];

  // Layer 1: Base prompt is always included for every managed session.
  sections.push(BASE_AGENT_PROMPT);

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Explicit user prompt (appended last, highest priority)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  return sections.join("\n\n");
}

// =============================================================================
// PROJECT MODE PROMPT
// =============================================================================

export interface ProjectPromptBuildConfig {
  project: ProjectConfig;
  projectId: string;
  trackerProject?: TrackerProject;
  issues: Issue[];
}

const PRIORITY_NAMES: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

/**
 * Compose a prompt for project-mode sessions where multiple tickets
 * are worked on sequentially, one commit per ticket.
 */
export function buildProjectPrompt(config: ProjectPromptBuildConfig): string {
  const { project, projectId, trackerProject, issues } = config;
  const userRules = readUserRules(project);
  const sections: string[] = [];

  // Layer 1: Base prompt
  sections.push(BASE_AGENT_PROMPT);

  // Layer 2: Project context
  const contextLines: string[] = [];
  contextLines.push("## Project Context");
  contextLines.push(`- Project: ${project.name ?? projectId}`);
  contextLines.push(`- Repository: ${project.repo}`);
  contextLines.push(`- Default branch: ${project.defaultBranch}`);
  if (trackerProject) {
    contextLines.push(`- Tracker project: ${trackerProject.name} (${trackerProject.url})`);
  }
  sections.push(contextLines.join("\n"));

  // Project-mode instructions
  sections.push(`## Project Mode — Multi-Ticket Session

You have been assigned **${issues.length} tickets** to work through in this session.
Work them **sequentially** in the order listed below. For each ticket:

1. Implement the changes described in the ticket
2. Commit with: \`feat(scope): TICKET-ID — short description\`
3. Move to the next ticket

After completing all tickets:
- Push the branch
- Create a single PR covering all the work

If a ticket is blocked (missing context, depends on unmerged work, etc.):
- Skip it and note the blocker in a comment at the end of your session
- Continue with the next ticket`);

  // Ticket list
  const ticketLines: string[] = [];
  ticketLines.push("## Tickets (in priority order)\n");

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const priority = issue.priority !== undefined ? PRIORITY_NAMES[issue.priority] ?? `P${issue.priority}` : "";
    ticketLines.push(`### ${i + 1}. ${issue.id}: ${issue.title}`);
    ticketLines.push(`- URL: ${issue.url}`);
    if (priority) ticketLines.push(`- Priority: ${priority}`);
    if (issue.labels.length > 0) ticketLines.push(`- Labels: ${issue.labels.join(", ")}`);
    if (issue.description) {
      ticketLines.push("");
      ticketLines.push(issue.description);
    }
    ticketLines.push("");
  }

  sections.push(ticketLines.join("\n"));

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  return sections.join("\n\n");
}

// =============================================================================
// PARALLEL PROJECT MODE PROMPT (per-agent)
// =============================================================================

export interface ParallelAgentPromptConfig {
  project: ProjectConfig;
  projectId: string;
  issue: Issue;
  projectBranch: string;
  totalIssues: number;
}

/**
 * Compose a prompt for a single agent in parallel project mode.
 * Key difference from normal spawn: agent must NOT create a PR.
 * The orchestrator will combine all branches and create one PR.
 */
export function buildParallelAgentPrompt(config: ParallelAgentPromptConfig): string {
  const { project, projectId, issue, projectBranch, totalIssues } = config;
  const userRules = readUserRules(project);
  const sections: string[] = [];

  // Modified base prompt — no PR creation, no pushing
  sections.push(`You are an AI coding agent managed by the Agent Orchestrator (ao).

## Session Lifecycle
- You are running inside a managed session. Focus on your assigned ticket.
- **IMPORTANT: Do NOT create a Pull Request and do NOT push to origin.** This is a parallel project session — ${totalIssues} agents are working on related tickets simultaneously. The orchestrator will merge all branches and push the combined result.
- When you finish your work: commit your changes locally. Then stop. Do NOT run git push.
- If CI fails, the orchestrator will send you the failures — fix them and commit again.

## Git Workflow
- You are on a feature branch created for your ticket. Work on it directly.
- Use conventional commit messages: \`feat(scope): ${issue.id} — description\`
- Include the ticket ID in every commit message.
- Commit locally when the implementation is ready. Do NOT push. Do NOT open a PR.

## Parallel Coordination — Shared File Rules
${totalIssues} agents are editing the codebase simultaneously. Their branches will be merged later. To avoid merge conflicts:

1. **Minimize changes to shared files** — barrel exports (index.ts), type unions, registries, and config files are edited by ALL agents. Make only the minimal additions needed for your ticket.
2. **Use additive-only changes** — When adding to union types, arrays, or object literals, append your entries at the END. Never reorder existing entries.
3. **Don't refactor shared code** — Only touch code directly related to your ticket. Don't rename, restructure, or "improve" existing code that other agents depend on.
4. **Consistent naming** — Use the exact type/variable/export names described in your ticket. Don't invent alternatives that other agents won't expect.
5. **Self-contained modules** — Put your implementation in its own directory/files. Only touch shared files to register/export your new code.`);

  // Project context
  const contextLines: string[] = [];
  contextLines.push("## Project Context");
  contextLines.push(`- Project: ${project.name ?? projectId}`);
  contextLines.push(`- Repository: ${project.repo}`);
  contextLines.push(`- Default branch: ${project.defaultBranch}`);
  contextLines.push(`- Combined PR branch: ${projectBranch} (managed by orchestrator)`);
  contextLines.push(`- This is ticket ${issue.id} — one of ${totalIssues} being worked in parallel`);
  sections.push(contextLines.join("\n"));

  // Ticket details
  const ticketLines: string[] = [];
  ticketLines.push("## Your Ticket\n");
  ticketLines.push(`**${issue.id}: ${issue.title}**`);
  ticketLines.push(`- URL: ${issue.url}`);
  const priority = issue.priority !== undefined ? PRIORITY_NAMES[issue.priority] ?? `P${issue.priority}` : "";
  if (priority) ticketLines.push(`- Priority: ${priority}`);
  if (issue.labels.length > 0) ticketLines.push(`- Labels: ${issue.labels.join(", ")}`);
  if (issue.description) {
    ticketLines.push("");
    ticketLines.push(issue.description);
  }
  sections.push(ticketLines.join("\n"));

  // User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  return sections.join("\n\n");
}
