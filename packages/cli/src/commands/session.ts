import chalk from "chalk";
import type { Command } from "commander";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  getSessionsDir,
  loadConfig,
  SessionNotRestorableError,
  WorkspaceMissingError,
} from "@composio/ao-core";
import { git, getTmuxActivity } from "../lib/shell.js";
import { formatAge } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";

interface BranchPruneResult {
  deleted: string[];
  skipped: Array<{ branch: string; reason: string }>;
  errors: Array<{ branch: string; error: string }>;
}

async function getMergedSessionBranches(
  repoPath: string,
  defaultBranch: string,
): Promise<Set<string>> {
  const fromOrigin = await git(
    ["branch", "--format=%(refname:short)", "--merged", `origin/${defaultBranch}`],
    repoPath,
  );
  const output =
    fromOrigin ??
    (await git(["branch", "--format=%(refname:short)", "--merged", defaultBranch], repoPath));
  if (!output) return new Set<string>();
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("session/")),
  );
}

async function getAttachedWorktreeBranches(repoPath: string): Promise<Set<string>> {
  const output = await git(["worktree", "list", "--porcelain"], repoPath);
  if (!output) return new Set<string>();
  const branches = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("branch ")) continue;
    const ref = line.slice("branch ".length).trim();
    if (!ref.startsWith("refs/heads/")) continue;
    const name = ref.slice("refs/heads/".length);
    if (name.startsWith("session/")) branches.add(name);
  }
  return branches;
}

function getArchivedSessionIds(configPath: string, projectPath: string): Set<string> {
  const sessionsDir = getSessionsDir(configPath, projectPath);
  const archiveDir = join(sessionsDir, "archive");
  if (!existsSync(archiveDir)) return new Set<string>();
  const ids = new Set<string>();
  for (const file of readdirSync(archiveDir)) {
    const match = file.match(/^([a-zA-Z0-9_-]+)_\d/);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

async function pruneSessionBranches(
  projectId: string | undefined,
  dryRun: boolean | undefined,
): Promise<BranchPruneResult> {
  const config = loadConfig();
  const sm = await getSessionManager(config);
  const result: BranchPruneResult = { deleted: [], skipped: [], errors: [] };

  const entries = Object.entries(config.projects).filter(([id]) => !projectId || id === projectId);

  for (const [id, project] of entries) {
    const repoPath = project.path;
    const active = await sm.list(id);
    const activeIds = new Set(active.map((session) => session.id));
    const archivedIds = getArchivedSessionIds(config.configPath, project.path);

    const allSessionBranchesOut = await git(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/session"],
      repoPath,
    );
    if (!allSessionBranchesOut) continue;
    const allSessionBranches = allSessionBranchesOut
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("session/"));

    const mergedBranches = await getMergedSessionBranches(repoPath, project.defaultBranch);
    const attachedBranches = await getAttachedWorktreeBranches(repoPath);
    const sessionPrefix = project.sessionPrefix;

    for (const branch of allSessionBranches) {
      const sessionId = branch.slice("session/".length);
      if (!sessionId.startsWith(`${sessionPrefix}-`)) {
        result.skipped.push({ branch, reason: `not ${id} session prefix` });
        continue;
      }
      if (activeIds.has(sessionId)) {
        result.skipped.push({ branch, reason: "active session" });
        continue;
      }
      if (!archivedIds.has(sessionId)) {
        result.skipped.push({ branch, reason: "no archived metadata" });
        continue;
      }
      if (attachedBranches.has(branch)) {
        result.skipped.push({ branch, reason: "worktree still attached" });
        continue;
      }
      if (!mergedBranches.has(branch)) {
        result.skipped.push({ branch, reason: `not merged into ${project.defaultBranch}` });
        continue;
      }

      if (dryRun) {
        result.deleted.push(branch);
        continue;
      }

      const deleted = await git(["branch", "-d", branch], repoPath);
      if (deleted === null) {
        result.errors.push({ branch, error: "git branch delete failed" });
      } else {
        result.deleted.push(branch);
      }
    }
  }

  return result;
}

export function registerSession(program: Command): void {
  const session = program.command("session").description("Session management (ls, kill, cleanup)");

  session
    .command("ls")
    .description("List all sessions")
    .option("-p, --project <id>", "Filter by project ID")
    .action(async (opts: { project?: string }) => {
      const config = loadConfig();
      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const sessions = await sm.list(opts.project);

      // Group sessions by project
      const byProject = new Map<string, typeof sessions>();
      for (const s of sessions) {
        const list = byProject.get(s.projectId) ?? [];
        list.push(s);
        byProject.set(s.projectId, list);
      }

      // Iterate over all configured projects (not just ones with sessions)
      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);

      for (const projectId of projectIds) {
        const project = config.projects[projectId];
        if (!project) continue;
        console.log(chalk.bold(`\n${project.name || projectId}:`));

        const projectSessions = (byProject.get(projectId) ?? []).sort((a, b) =>
          a.id.localeCompare(b.id),
        );

        if (projectSessions.length === 0) {
          console.log(chalk.dim("  (no active sessions)"));
          continue;
        }

        for (const s of projectSessions) {
          // Get live branch from worktree if available
          let branchStr = s.branch || "";
          if (s.workspacePath) {
            const liveBranch = await git(["branch", "--show-current"], s.workspacePath);
            if (liveBranch) branchStr = liveBranch;
          }

          // Get tmux activity age
          const tmuxTarget = s.runtimeHandle?.id ?? s.id;
          const activityTs = await getTmuxActivity(tmuxTarget);
          const age = activityTs ? formatAge(activityTs) : "-";

          const parts = [chalk.green(s.id), chalk.dim(`(${age})`)];
          if (branchStr) parts.push(chalk.cyan(branchStr));
          if (s.status) parts.push(chalk.dim(`[${s.status}]`));
          const prUrl = s.metadata["pr"];
          if (prUrl) parts.push(chalk.blue(prUrl));

          console.log(`  ${parts.join("  ")}`);
        }
      }
      console.log();
    });

  session
    .command("kill")
    .description("Kill a session and remove its worktree")
    .argument("<session>", "Session name to kill")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        await sm.kill(sessionName);
        console.log(chalk.green(`\nSession ${sessionName} killed.`));
      } catch (err) {
        console.error(chalk.red(`Failed to kill session ${sessionName}: ${err}`));
        process.exit(1);
      }
    });

  session
    .command("cleanup")
    .description("Kill sessions where PR is merged or issue is closed")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--dry-run", "Show what would be cleaned up without doing it")
    .option(
      "--prune-branches",
      "Also prune safe archived session branches (or set cleanup.pruneBranches in config)",
    )
    .action(async (opts: { project?: string; dryRun?: boolean; pruneBranches?: boolean }) => {
      const config = loadConfig();
      const shouldPruneBranches = opts.pruneBranches ?? config.cleanup?.pruneBranches ?? false;
      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      console.log(chalk.bold("Checking for completed sessions...\n"));

      const sm = await getSessionManager(config);

      if (opts.dryRun) {
        // Dry-run delegates to sm.cleanup() with dryRun flag so it uses the
        // same live checks (PR state, runtime alive, tracker) as actual cleanup.
        const result = await sm.cleanup(opts.project, { dryRun: true });

        if (result.errors.length > 0) {
          for (const { sessionId, error } of result.errors) {
            console.error(chalk.red(`  Error checking ${sessionId}: ${error}`));
          }
        }

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          for (const id of result.killed) {
            console.log(chalk.yellow(`  Would kill ${id}`));
          }
          if (result.killed.length > 0) {
            console.log(
              chalk.dim(
                `\nDry run complete. ${result.killed.length} session${result.killed.length !== 1 ? "s" : ""} would be cleaned.`,
              ),
            );
          }
        }

        if (shouldPruneBranches) {
          const prune = await pruneSessionBranches(opts.project, true);
          if (prune.deleted.length === 0 && prune.errors.length === 0) {
            console.log(chalk.dim("  No session branches would be pruned."));
          } else {
            for (const branch of prune.deleted) {
              console.log(chalk.yellow(`  Would prune branch ${branch}`));
            }
            for (const { branch, error } of prune.errors) {
              console.error(chalk.red(`  Error checking branch ${branch}: ${error}`));
            }
          }
        }
      } else {
        const result = await sm.cleanup(opts.project);

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          if (result.killed.length > 0) {
            for (const id of result.killed) {
              console.log(chalk.green(`  Cleaned: ${id}`));
            }
          }
          if (result.errors.length > 0) {
            for (const { sessionId, error } of result.errors) {
              console.error(chalk.red(`  Error cleaning ${sessionId}: ${error}`));
            }
          }
          console.log(chalk.green(`\nCleanup complete. ${result.killed.length} sessions cleaned.`));
        }

        if (shouldPruneBranches) {
          const prune = await pruneSessionBranches(opts.project, false);
          if (prune.deleted.length > 0) {
            for (const branch of prune.deleted) {
              console.log(chalk.green(`  Pruned branch: ${branch}`));
            }
          }
          if (prune.errors.length > 0) {
            for (const { branch, error } of prune.errors) {
              console.error(chalk.red(`  Error pruning branch ${branch}: ${error}`));
            }
          }
          if (prune.deleted.length === 0 && prune.errors.length === 0) {
            console.log(chalk.dim("  No session branches to prune."));
          }
        }
      }
    });

  session
    .command("restore")
    .description("Restore a terminated/crashed session in-place")
    .argument("<session>", "Session name to restore")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        const restored = await sm.restore(sessionName);
        console.log(chalk.green(`\nSession ${sessionName} restored.`));
        if (restored.workspacePath) {
          console.log(chalk.dim(`  Worktree: ${restored.workspacePath}`));
        }
        if (restored.branch) {
          console.log(chalk.dim(`  Branch:   ${restored.branch}`));
        }
        const tmuxTarget = restored.runtimeHandle?.id ?? sessionName;
        console.log(chalk.dim(`  Attach:   tmux attach -t ${tmuxTarget}`));
      } catch (err) {
        if (err instanceof SessionNotRestorableError) {
          console.error(chalk.red(`Cannot restore: ${err.reason}`));
        } else if (err instanceof WorkspaceMissingError) {
          console.error(chalk.red(`Workspace missing: ${err.message}`));
        } else {
          console.error(chalk.red(`Failed to restore session ${sessionName}: ${err}`));
        }
        process.exit(1);
      }
    });
}
