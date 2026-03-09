import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, type OrchestratorConfig, type ParallelProjectResult, type MergeProjectResult } from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";

interface SpawnClaimOptions {
  claimPr?: string;
  assignOnGithub?: boolean;
  takeover?: boolean;
}

/**
 * Run pre-flight checks for a project once, before any sessions are spawned.
 * Validates runtime and tracker prerequisites so failures surface immediately
 * rather than repeating per-session in a batch.
 */
async function runSpawnPreflight(
  config: OrchestratorConfig,
  projectId: string,
  options?: SpawnClaimOptions,
): Promise<void> {
  const project = config.projects[projectId];
  const runtime = project?.runtime ?? config.defaults.runtime;
  if (runtime === "tmux") {
    await preflight.checkTmux();
  }
  const needsGitHubAuth =
    project?.tracker?.plugin === "github" ||
    (options?.claimPr && project?.scm?.plugin === "github");
  if (needsGitHubAuth) {
    await preflight.checkGhAuth();
  }
}

async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  issueId?: string,
  openTab?: boolean,
  agent?: string,
  claimOptions?: SpawnClaimOptions,
): Promise<string> {
  const spinner = ora("Creating session").start();

  try {
    const sm = await getSessionManager(config);
    spinner.text = "Spawning session via core";

    const session = await sm.spawn({
      projectId,
      issueId,
      agent,
    });

    let branchStr = session.branch ?? "";
    let claimedPrUrl: string | null = null;

    if (claimOptions?.claimPr) {
      spinner.text = `Claiming PR ${claimOptions.claimPr}`;
      try {
        const claimResult = await sm.claimPR(session.id, claimOptions.claimPr, {
          assignOnGithub: claimOptions.assignOnGithub,
          takeover: claimOptions.takeover,
        });
        branchStr = claimResult.pr.branch;
        claimedPrUrl = claimResult.pr.url;
      } catch (err) {
        throw new Error(
          `Session ${session.id} was created, but failed to claim PR ${claimOptions.claimPr}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    spinner.succeed(
      claimedPrUrl
        ? `Session ${chalk.green(session.id)} created and claimed PR`
        : `Session ${chalk.green(session.id)} created`,
    );

    console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
    if (branchStr) console.log(`  Branch:   ${chalk.dim(branchStr)}`);
    if (claimedPrUrl) console.log(`  PR:       ${chalk.dim(claimedPrUrl)}`);

    // Show the tmux name for attaching (stored in metadata or runtimeHandle)
    const tmuxTarget = session.runtimeHandle?.id ?? session.id;
    console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
    console.log();

    // Open terminal tab if requested
    if (openTab) {
      try {
        await exec("open-iterm-tab", [tmuxTarget]);
      } catch {
        // Terminal plugin not available
      }
    }

    // Output for scripting
    console.log(`SESSION=${session.id}`);
    return session.id;
  } catch (err) {
    spinner.fail("Failed to create or initialize session");
    throw err;
  }
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("Spawn a single agent session")
    .argument("<project>", "Project ID from config")
    .argument("[issue]", "Issue identifier (e.g. INT-1234, #42) - must exist in tracker")
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option("--claim-pr <pr>", "Immediately claim an existing PR for the spawned session")
    .option("--assign-on-github", "Assign the claimed PR to the authenticated GitHub user")
    .option("--takeover", "Transfer PR ownership from another AO session if needed")
    .action(
      async (
        projectId: string,
        issueId: string | undefined,
        opts: {
          open?: boolean;
          agent?: string;
          claimPr?: string;
          assignOnGithub?: boolean;
          takeover?: boolean;
        },
      ) => {
        const config = loadConfig();
        if (!config.projects[projectId]) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        if (!opts.claimPr && (opts.assignOnGithub || opts.takeover)) {
          console.error(
            chalk.red("--assign-on-github and --takeover require --claim-pr on `ao spawn`."),
          );
          process.exit(1);
        }

        try {
          await runSpawnPreflight(config, projectId, { claimPr: opts.claimPr });
          await ensureLifecycleWorker(config, projectId);
          await spawnSession(config, projectId, issueId, opts.open, opts.agent, {
            claimPr: opts.claimPr,
            assignOnGithub: opts.assignOnGithub,
            takeover: opts.takeover,
          });
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );
}

export function registerSpawnProject(program: Command): void {
  program
    .command("spawn-project")
    .description("Spawn a project-mode session (one branch, multiple tickets as commits)")
    .argument("<project>", "Project ID from config")
    .argument("[tracker-project]", "Tracker project ID, URL, or slug (fetches all open issues)")
    .option("--issues <ids...>", "Ad-hoc list of issue IDs to work on together")
    .option("--parallel", "Parallel mode: one agent per issue, combine into one PR later")
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option("--branch <name>", "Override the branch name")
    .action(
      async (
        projectId: string,
        trackerProjectId: string | undefined,
        opts: {
          issues?: string[];
          parallel?: boolean;
          open?: boolean;
          agent?: string;
          branch?: string;
        },
      ) => {
        const config = loadConfig();
        if (!config.projects[projectId]) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        if (!trackerProjectId && (!opts.issues || opts.issues.length === 0)) {
          console.error(
            chalk.red(
              "Either provide a tracker project ID or use --issues to specify issue IDs.\n" +
                "Usage:\n" +
                "  ao spawn-project <project> <tracker-project>\n" +
                "  ao spawn-project <project> --issues SIL-1 SIL-2 SIL-3",
            ),
          );
          process.exit(1);
        }

        const spinner = ora("Creating project session").start();

        try {
          await runSpawnPreflight(config, projectId);
          await ensureLifecycleWorker(config, projectId);

          const sm = await getSessionManager(config);

          if (opts.parallel) {
            spinner.text = "Spawning parallel project sessions";

            const result = await sm.spawnProject({
              projectId,
              trackerProjectId,
              issueIds: opts.issues,
              agent: opts.agent,
              branch: opts.branch,
              parallel: true,
            }) as ParallelProjectResult;

            if (result.failedIssues?.length) {
              spinner.warn(
                `Parallel project: ${chalk.green(result.sessions.length)} spawned, ${chalk.red(`${result.failedIssues.length} failed`)}`,
              );
            } else {
              spinner.succeed(
                `Parallel project: ${chalk.green(result.sessions.length)} agents spawned`,
              );
            }

            console.log(`  Project branch: ${chalk.dim(result.projectBranch)}`);
            console.log(`  Group ID:       ${chalk.dim(result.groupId)}`);
            console.log();
            for (const session of result.sessions) {
              const tmuxTarget = session.runtimeHandle?.id ?? session.id;
              console.log(
                `  ${chalk.green(session.id)} → ${session.issueId} (${chalk.dim(session.branch ?? "")})`,
              );
              if (opts.open) {
                try {
                  await exec("open-iterm-tab", [tmuxTarget]);
                } catch {
                  // best effort
                }
              }
            }
            if (result.failedIssues?.length) {
              console.log();
              console.log(chalk.red("Failed to spawn:"));
              for (const f of result.failedIssues) {
                console.log(`  ${chalk.red(f.issueId)}: ${f.error}`);
              }
            }
            console.log();
            console.log(
              `When agents finish: ${chalk.cyan(`ao merge-project ${result.groupId}`)}`,
            );
            console.log();

            // Output for scripting
            console.log(`GROUP=${result.groupId}`);
          } else {
            spinner.text = "Spawning project session via core";

            const session = await sm.spawnProject({
              projectId,
              trackerProjectId,
              issueIds: opts.issues,
              agent: opts.agent,
              branch: opts.branch,
            }) as import("@composio/ao-core").Session;

            spinner.succeed(`Session ${chalk.green(session.id)} created`);

            console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
            if (session.branch) console.log(`  Branch:   ${chalk.dim(session.branch)}`);

            const tmuxTarget = session.runtimeHandle?.id ?? session.id;
            console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
            console.log();

            // Output for scripting
            console.log(`SESSION=${session.id}`);

            if (opts.open) {
              try {
                await exec("open-iterm-tab", [tmuxTarget]);
              } catch {
                // Terminal plugin not available
              }
            }
          }
        } catch (err) {
          spinner.fail("Failed to create project session");
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );
}

export function registerMergeProject(program: Command): void {
  program
    .command("merge-project")
    .description("Merge parallel project branches into one PR")
    .argument("<group-id>", "Parallel group ID (from spawn-project --parallel output)")
    .action(async (groupId: string) => {
      const config = loadConfig();
      const spinner = ora("Merging parallel project").start();

      try {
        const sm = await getSessionManager(config);
        spinner.text = "Finding sessions and merging branches";

        const result = await sm.mergeProject(groupId) as MergeProjectResult;

        if (result.merged.length === 0 && result.conflicts.length === 0) {
          spinner.info("No sessions are ready to merge yet");
          if (result.notReady.length > 0) {
            console.log();
            console.log(chalk.yellow("Still working:"));
            for (const nr of result.notReady) {
              console.log(`  ${nr.sessionId} (${nr.issueId}) — ${nr.status}`);
            }
          }
          return;
        }

        if (result.conflicts.length > 0) {
          spinner.warn(
            `Merged ${result.merged.length}, ${chalk.red(`${result.conflicts.length} conflicts`)}`,
          );
          console.log();
          console.log(chalk.yellow("Conflicting branches (resolve manually):"));
          for (const c of result.conflicts) {
            console.log(`  ${c.issueId}: git merge origin/${c.branch}`);
          }
          console.log();
          console.log(`Project branch: ${chalk.dim(result.projectBranch)}`);
          console.log("After resolving:");
          console.log(`  git checkout ${result.projectBranch}`);
          for (const c of result.conflicts) {
            console.log(`  git merge origin/${c.branch}`);
          }
          console.log(`  git push origin ${result.projectBranch}`);
        } else {
          spinner.succeed(
            `Merged ${chalk.green(String(result.merged.length))} branches into ${chalk.cyan(result.projectBranch)}`,
          );
        }

        if (result.prUrl) {
          console.log();
          console.log(`  PR: ${chalk.green(result.prUrl)}`);
        }

        if (result.closedPRs.length > 0) {
          console.log(`  Closed ${result.closedPRs.length} individual PRs: ${result.closedPRs.map((n) => `#${n}`).join(", ")}`);
        }

        if (result.notReady.length > 0) {
          console.log();
          console.log(chalk.yellow(`${result.notReady.length} session(s) still working — run merge-project again later`));
        }

        console.log();
      } catch (err) {
        spinner.fail("Failed to merge project");
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}

export function registerBatchSpawn(program: Command): void {
  program
    .command("batch-spawn")
    .description("Spawn sessions for multiple issues with duplicate detection")
    .argument("<project>", "Project ID from config")
    .argument("<issues...>", "Issue identifiers")
    .option("--open", "Open sessions in terminal tabs")
    .action(async (projectId: string, issues: string[], opts: { open?: boolean }) => {
      const config = loadConfig();
      if (!config.projects[projectId]) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      console.log(banner("BATCH SESSION SPAWNER"));
      console.log();
      console.log(`  Project: ${chalk.bold(projectId)}`);
      console.log(`  Issues:  ${issues.join(", ")}`);
      console.log();

      // Pre-flight once before the loop so a missing prerequisite fails fast
      try {
        await runSpawnPreflight(config, projectId);
        await ensureLifecycleWorker(config, projectId);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const created: Array<{ session: string; issue: string }> = [];
      const skipped: Array<{ issue: string; existing: string }> = [];
      const failed: Array<{ issue: string; error: string }> = [];
      const spawnedIssues = new Set<string>();

      // Load existing sessions once before the loop to avoid repeated reads + enrichment.
      // Exclude dead/killed sessions so crashed sessions don't block respawning.
      const deadStatuses = new Set(["killed", "done", "exited"]);
      const existingSessions = await sm.list(projectId);
      const existingIssueMap = new Map(
        existingSessions
          .filter((s) => s.issueId && !deadStatuses.has(s.status))
          .map((s) => [s.issueId!.toLowerCase(), s.id]),
      );

      for (const issue of issues) {
        // Duplicate detection — check both existing sessions and same-run duplicates
        if (spawnedIssues.has(issue.toLowerCase())) {
          console.log(chalk.yellow(`  Skip ${issue} — duplicate in this batch`));
          skipped.push({ issue, existing: "(this batch)" });
          continue;
        }

        // Check existing sessions (pre-loaded before loop)
        const existingSessionId = existingIssueMap.get(issue.toLowerCase());
        if (existingSessionId) {
          console.log(chalk.yellow(`  Skip ${issue} — already has session ${existingSessionId}`));
          skipped.push({ issue, existing: existingSessionId });
          continue;
        }

        try {
          const session = await sm.spawn({ projectId, issueId: issue });
          created.push({ session: session.id, issue });
          spawnedIssues.add(issue.toLowerCase());
          console.log(chalk.green(`  Created ${session.id} for ${issue}`));

          if (opts.open) {
            try {
              const tmuxTarget = session.runtimeHandle?.id ?? session.id;
              await exec("open-iterm-tab", [tmuxTarget]);
            } catch {
              // best effort
            }
          }
        } catch (err) {
          failed.push({
            issue,
            error: err instanceof Error ? err.message : String(err),
          });
          console.log(
            chalk.red(
              `  Failed ${issue} — ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      }

      console.log();
      if (created.length > 0) {
        console.log(chalk.green(`Created ${created.length} sessions:`));
        for (const item of created) console.log(`  ${item.session} ← ${item.issue}`);
      }
      if (skipped.length > 0) {
        console.log(chalk.yellow(`Skipped ${skipped.length} issues:`));
        for (const item of skipped) console.log(`  ${item.issue} (existing: ${item.existing})`);
      }
      if (failed.length > 0) {
        console.log(chalk.red(`Failed ${failed.length} issues:`));
        for (const item of failed) console.log(`  ${item.issue}: ${item.error}`);
      }
      console.log();
    });
}
