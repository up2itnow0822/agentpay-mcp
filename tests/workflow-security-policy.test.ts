import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Policy guard for .github/workflows (Daybreak Blue F6 / F13 / F17).
// No YAML parser is a dependency of this repo, so these checks use careful
// line-based parsing of the (block-style) workflow files.

const workflowsDir = new URL('../.github/workflows/', import.meta.url);
const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

function readWorkflow(name: string): string {
  return readFileSync(new URL(name, workflowsDir), 'utf8');
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Map of job id -> the lines of that job's block (under top-level `jobs:`). */
function jobBlocks(text: string): Map<string, string[]> {
  const lines = text.split(/\r?\n/);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  const jobs = new Map<string, string[]>();
  if (jobsAt < 0) return jobs;
  let current: string | null = null;
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/.test(line)) break; // next top-level key
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) {
      current = key[1];
      jobs.set(current, []);
      continue;
    }
    if (current) jobs.get(current)!.push(line);
  }
  return jobs;
}

/** Lines nested under the first `<key>:` found at exactly `indent` spaces. */
function nestedBlock(lines: string[], key: string, indent: number): string[] | null {
  const at = lines.findIndex((line) => indentOf(line) === indent && line.trim().startsWith(`${key}:`));
  if (at < 0) return null;
  const inline = lines[at].trim().slice(key.length + 1).trim();
  if (inline && !inline.startsWith('#')) return [inline];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= indent) break;
    out.push(line.replace(/\s+#.*$/, '').trim());
  }
  return out;
}

/** Bodies of every `script: |` block (github-script) in a workflow. */
function githubScripts(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const scripts: string[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*script:\s*\|\s*$/.test(line)) return;
    const keyIndent = indentOf(line);
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() !== '' && indentOf(next) <= keyIndent) break;
      body.push(next);
    }
    scripts.push(body.join('\n'));
  });
  return scripts;
}

const REMOTE_USES = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/;

describe('workflow supply-chain pinning (F6)', () => {
  const usesLines = workflowFiles.flatMap((file) =>
    readWorkflow(file)
      .split(/\r?\n/)
      .map((line, index) => ({ file, line: index + 1, text: line, m: REMOTE_USES.exec(line) }))
      .filter((entry) => entry.m !== null)
      .map((entry) => ({ ...entry, ref: entry.m![1], comment: entry.m![2] ?? '' }))
      .filter((entry) => !entry.ref.startsWith('./') && !entry.ref.startsWith('docker://')),
  );

  it('finds the workflows and their third-party actions (guards against a vacuous pass)', () => {
    expect(workflowFiles).toEqual(
      expect.arrayContaining(['build.yml', 'ci.yml', 'daily-repair.yml', 'daily-review.yml', 'review-gate.yml']),
    );
    expect(workflowFiles.some((name) => name.endsWith('.bak'))).toBe(false);
    expect(usesLines.length).toBeGreaterThanOrEqual(12);
  });

  it('pins every remote action to a full 40-hex commit SHA with a version comment', () => {
    const offenders = usesLines
      .filter((u) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(u.ref) || !/^#\s*v\d+(\.\d+){0,2}\b/.test(u.comment))
      .map((u) => `${u.file}:${u.line}: ${u.text.trim()}`);
    expect(offenders).toEqual([]);
  });

  it('keeps dependabot updating github-actions pins through reviewed PRs', () => {
    const dependabot = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
    expect(dependabot).toMatch(/package-ecosystem:\s*["']?github-actions["']?/);
    expect(dependabot).toMatch(/interval:\s*["']?weekly["']?/);
  });
});

describe('daily-review privilege separation (F17)', () => {
  const text = readWorkflow('daily-review.yml');
  const jobs = jobBlocks(text);
  const agentJobs = [...jobs].filter(([, lines]) => lines.some((l) => /uses:\s*anthropics\/claude-code-action@/.test(l)));

  it('runs the model in exactly one job, separate from the issue-writing job', () => {
    expect(agentJobs.map(([id]) => id)).toEqual(['analyze']);
    const publish = jobs.get('publish');
    expect(publish).toBeDefined();
    expect(publish!.join('\n')).toMatch(/needs:\s*analyze/);
    // No model step and no model credential in the issue-writing job (the
    // secret is only compared to '' to produce a boolean).
    expect(publish!.join('\n')).not.toMatch(/uses:\s*anthropics\//);
    expect(publish!.join('\n')).not.toMatch(/claude_code_oauth_token:/);
    expect(publish!.join('\n')).not.toMatch(/secrets\.CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/);
    const publishPerms = nestedBlock(publish!, 'permissions', 4) ?? [];
    expect(publishPerms).toContain('issues: write');
    expect(publishPerms.join('\n')).not.toMatch(/contents:\s*write|pull-requests:\s*write|write-all/);
  });

  it('gives the model job only read permissions, declared at job level', () => {
    const topLevel = nestedBlock(text.split(/\r?\n/), 'permissions', 0);
    expect(topLevel).toEqual(['{}']);
    const [, lines] = agentJobs[0];
    const perms = nestedBlock(lines, 'permissions', 4);
    expect(perms).not.toBeNull();
    expect(perms!.length).toBeGreaterThan(0);
    for (const entry of perms!) {
      expect(entry).toMatch(/^[a-z-]+:\s*(read|none)\b/);
    }
    expect(perms!.join('\n')).not.toMatch(/issues:\s*write|contents:\s*write|pull-requests:\s*write|write-all|read-all/);
  });

  it('hands the model only the job token, never a PAT or repair token', () => {
    const [, lines] = agentJobs[0];
    const block = lines.join('\n');
    expect(block).not.toMatch(/REPAIR_TOKEN|secrets\.(?!CLAUDE_CODE_OAUTH_TOKEN\b)[A-Z_]+/);
    expect(block).toMatch(/github_token:\s*\$\{\{\s*github\.token\s*\}\}/);
  });

  it('allows the model no mutating command', () => {
    const [, lines] = agentJobs[0];
    const match = /--allowedTools\s+"([^"]+)"/.exec(lines.join('\n'));
    expect(match).not.toBeNull();
    const tools = match![1].split(',').map((t) => t.trim());
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Bash(gh issue view:*)', 'Bash(gh pr view:*)']));
    const forbidden = [
      'gh api',
      'gh issue create',
      'gh issue edit',
      'gh issue comment',
      'gh issue close',
      'gh label create',
      'gh pr comment',
      'gh pr merge',
      'gh pr create',
      'gh pr review',
      'gh workflow run',
      'git push',
      'git commit',
    ];
    for (const tool of tools) {
      const bash = /^Bash\((.*)\)$/.exec(tool);
      if (tool === 'Bash') throw new Error('unrestricted Bash is allowed');
      if (!bash) continue;
      const command = bash[1].replace(/:\*$/, '').trim();
      for (const bad of forbidden) {
        expect(command.startsWith(bad), `${tool} grants ${bad}`).toBe(false);
      }
      // Wildcards over a whole CLI (Bash(gh:*), Bash(git:*)) would re-grant everything.
      expect(['gh', 'git', '*', ''].includes(command), `${tool} is too broad`).toBe(false);
    }
  });

  it('publishes via validated files, never by interpolating report text into shell', () => {
    const publish = jobs.get('publish')!.join('\n');
    expect(publish).toContain('--body-file');
    expect(publish).toContain('MAX_BYTES = 64 * 1024');
    expect(publish).toContain("doc.date !== today");
    expect(publish).toContain('doc.repo !== env.EXPECTED_REPO');
    expect(publish).toMatch(/expected exactly one fenced json block/);
    // Every shell `run:` block in publish must be free of workflow
    // expressions: values (including the analyze job's outputs) arrive via
    // env and files only.
    const lines = jobs.get('publish')!;
    const runBodies: string[] = [];
    lines.forEach((line, i) => {
      if (!/^\s*run:\s*\|\s*$/.test(line)) return;
      const keyIndent = indentOf(line);
      const body: string[] = [];
      for (const next of lines.slice(i + 1)) {
        if (next.trim() !== '' && indentOf(next) <= keyIndent) break;
        body.push(next);
      }
      runBodies.push(body.join('\n'));
    });
    expect(runBodies.length).toBeGreaterThan(0);
    for (const body of runBodies) expect(body).not.toContain('${{');
  });
});

describe('daily-repair privilege separation (Codex review of PR #90)', () => {
  const text = readWorkflow('daily-repair.yml');
  const jobs = jobBlocks(text);
  const agentJobs = [...jobs].filter(([, lines]) => lines.some((l) => /uses:\s*anthropics\/claude-code-action@/.test(l)));

  it('runs the model only in the read-only plan job', () => {
    expect(agentJobs.map(([id]) => id)).toEqual(['plan']);
    expect(nestedBlock(text.split(/\r?\n/), 'permissions', 0)).toEqual(['{}']);
    const perms = nestedBlock(agentJobs[0][1], 'permissions', 4)!;
    expect(perms.length).toBeGreaterThan(0);
    for (const entry of perms) expect(entry).toMatch(/^[a-z-]+:\s*(read|none)\b/);
  });

  it('never lets REPAIR_TOKEN, a persisted credential, or a mutating command reach the model', () => {
    // Comment lines are ignored: the next job's header comment parses into this block.
    const plan = agentJobs[0][1].filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(plan).not.toMatch(/REPAIR_TOKEN/);
    expect(plan).not.toMatch(/secrets\.(?!CLAUDE_CODE_OAUTH_TOKEN\b)[A-Z_]+/);
    expect(plan).toMatch(/persist-credentials:\s*false/);
    expect(plan).toMatch(/github_token:\s*\$\{\{\s*github\.token\s*\}\}/);
    expect(plan).toMatch(/GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    const match = /--allowedTools\s+"([^"]+)"/.exec(plan);
    expect(match).not.toBeNull();
    for (const tool of match![1].split(',').map((t) => t.trim())) {
      if (tool === 'Bash') throw new Error('unrestricted Bash is allowed');
      const bash = /^Bash\((.*)\)$/.exec(tool);
      if (!bash) continue;
      const command = bash[1].replace(/:\*$/, '').trim();
      expect(/^(git (status|diff|log|show|ls-files)|gh (issue view|pr list|pr view))$/.test(command), `${tool} is not read-only`).toBe(true);
    }
  });

  it('keeps REPAIR_TOKEN in the deterministic publisher, which never merges', () => {
    const publish = jobs.get('publish')!.join('\n');
    expect(publish).toMatch(/needs:\s*\[preflight, plan\]/);
    expect(publish).not.toMatch(/uses:\s*anthropics\//);
    expect(publish).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(publish).toMatch(/secrets\.REPAIR_TOKEN/);
    // REPAIR_TOKEN appears nowhere else as a value (preflight only tests presence).
    for (const [id, lines] of jobs) {
      if (id === 'publish') continue;
      for (const line of lines) {
        if (/secrets\.REPAIR_TOKEN/.test(line)) expect(line, `${id}: ${line.trim()}`).toMatch(/secrets\.REPAIR_TOKEN\s*!=\s*''/);
      }
    }
    // No automated merge anywhere in the workflow.
    expect(text).not.toMatch(/gh pr merge|'merge'|--auto\b|enablePullRequestAutoMerge/);
    // Values reach the publisher's shell via env only.
    const lines = jobs.get('publish')!;
    lines.forEach((line, i) => {
      if (!/^\s*run:\s*\|\s*$/.test(line)) return;
      const keyIndent = indentOf(line);
      for (const next of lines.slice(i + 1)) {
        if (next.trim() !== '' && indentOf(next) <= keyIndent) break;
        expect(next).not.toContain('${{');
      }
    });
  });
});

describe('daily-repair runner and REPAIR_TOKEN checkout (SO F3)', () => {
  const text = readWorkflow('daily-repair.yml');
  const jobs = jobBlocks(text);
  const expectedJobs = ['preflight', 'plan', 'publish', 'audit'];

  function checkoutWith(lines: string[], needle: string): string[] | null {
    const at = lines.findIndex((line) => line.includes(needle));
    if (at < 0) return null;
    let start = at;
    while (start > 0 && !/^\s+-\s+name:/.test(lines[start])) start--;
    const stepIndent = indentOf(lines[start]);
    const step: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() !== '' && indentOf(line) <= stepIndent && /^\s+-\s+/.test(line)) break;
      step.push(line);
    }
    return nestedBlock(step, 'with', stepIndent + 2);
  }

  it('hard-codes ubuntu-latest on all four jobs and never interpolates MAINTAINER_RUNNER', () => {
    expect([...jobs.keys()]).toEqual(expectedJobs);
    for (const id of expectedJobs) {
      const runsOn = nestedBlock(jobs.get(id)!, 'runs-on', 4);
      expect(runsOn, `${id} runs-on`).toEqual(['ubuntu-latest']);
    }
    expect(text).not.toMatch(/MAINTAINER_RUNNER/);
    expect(text).not.toMatch(/vars\./);
  });

  it('sets persist-credentials: false on the checkout that uses REPAIR_TOKEN', () => {
    const publish = jobs.get('publish')!;
    const withBlock = checkoutWith(publish, 'secrets.REPAIR_TOKEN');
    expect(withBlock, 'publish checkout with REPAIR_TOKEN').not.toBeNull();
    expect(withBlock).toEqual(expect.arrayContaining([
      'token: ${{ secrets.REPAIR_TOKEN }}',
      'persist-credentials: false',
    ]));
    expect(withBlock!.some((line) => line.includes('inputs.dry_run'))).toBe(false);
  });

  it('runs gh auth setup-git before the publisher git push and keeps persist-credentials: false', () => {
    const publish = jobs.get('publish')!;
    const withBlock = checkoutWith(publish, 'secrets.REPAIR_TOKEN');
    expect(withBlock, 'publish checkout with REPAIR_TOKEN').not.toBeNull();
    expect(withBlock).toEqual(expect.arrayContaining(['persist-credentials: false']));

    const runBodies: string[] = [];
    publish.forEach((line, i) => {
      if (!/^\s*run:\s*\|\s*$/.test(line)) return;
      const keyIndent = indentOf(line);
      const body: string[] = [];
      for (const next of publish.slice(i + 1)) {
        if (next.trim() !== '' && indentOf(next) <= keyIndent) break;
        body.push(next);
      }
      runBodies.push(body.join('\n'));
    });
    const publishStep = runBodies.find((body) => /git push|git\(\['push'/.test(body));
    expect(publishStep, 'publish step that git-pushes repair branches').toBeDefined();
    const commands = publishStep!
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const setupAt = commands.indexOf('gh auth setup-git');
    const pushAt = commands.search(/git push|git\(\['push'/);
    expect(setupAt, 'gh auth setup-git must run in the publish step').toBeGreaterThanOrEqual(0);
    expect(pushAt).toBeGreaterThan(setupAt);
  });
});

describe('least privilege for every workflow', () => {
  it('declares an explicit permissions block (top level or on every job)', () => {
    for (const file of workflowFiles) {
      const text = readWorkflow(file);
      const topLevel = nestedBlock(text.split(/\r?\n/), 'permissions', 0);
      if (topLevel) continue;
      for (const [id, lines] of jobBlocks(text)) {
        expect(nestedBlock(lines, 'permissions', 4), `${file} job ${id} has no permissions block`).not.toBeNull();
      }
    }
  });

  it('runs pull-request code with a read-only token and no persisted credential', () => {
    for (const file of ['build.yml', 'ci.yml']) {
      const text = readWorkflow(file);
      expect(nestedBlock(text.split(/\r?\n/), 'permissions', 0), file).toEqual(['contents: read']);
      expect(text, file).toMatch(/persist-credentials:\s*false/);
      expect(text, file).not.toMatch(/secrets\./);
    }
  });
});

describe('review-gate binds ordinary Codex evidence to the current base SHA (F13)', () => {
  const text = readWorkflow('review-gate.yml');
  const scripts = githubScripts(text);
  const gate = scripts.find((s) => s.includes('async function evaluate(prNumber)'));

  it('embeds syntactically valid JavaScript in every github-script step', () => {
    expect(scripts.length).toBe(3);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => unknown;
    for (const script of scripts) {
      // github-script v9 injects these as function parameters. Declaring
      // `const getOctokit` / `const octokit` would SyntaxError at runtime.
      expect(() => new AsyncFunction(
        'require',
        '__original_require__',
        'github',
        'octokit',
        'getOctokit',
        'context',
        'core',
        'exec',
        'glob',
        'io',
        script,
      )).not.toThrow();
    }
  });

  it('accepts Codex evidence only for the current head SHA (after the last retarget) with every Codex thread resolved', () => {
    expect(gate).toBeDefined();
    const evaluate = gate!.slice(gate!.indexOf('async function evaluate(prNumber)'));
    expect(evaluate).toMatch(/const baseBinding = await currentBaseBinding\(prNumber, headSha, baseRef, baseSha, baseChangedMs\)/);
    expect(evaluate).toContain('postDatesRetarget(review.submitted_at)');
    expect(evaluate).toContain('postDatesRetarget(comment.updated_at || comment.created_at)');
    expect(evaluate).toContain('review.commit_id.toLowerCase() === head');
    expect(evaluate).toContain('sha === head && !dismissedShas.has(sha)');
    expect(evaluate).toContain('const unresolved = await unresolvedCodexThreads(prNumber);');
    expect(gate).toContain('reviewThreads(first: 100, after: $after)');
    // Waivers stay bound to the exact head and the live base tip.
    expect(evaluate).toContain('postDatesCurrentBase(labeled.lastWaiverEvent.created_at');
    expect(evaluate).toContain('baseSha: baseBinding.baseTipSha');
  });

  it('derives the bound from the live base tip and fails closed when it is unknown', () => {
    const binding = gate!.slice(gate!.indexOf('async function currentBaseBinding('));
    expect(binding).toContain('github.rest.repos.getBranch');
    expect(binding).toMatch(/throw new Error\(`PR #\$\{prNumber\} base branch/);
    expect(binding).toMatch(/has no readable committer date/);
    expect(gate).toContain("'GET /repos/{owner}/{repo}/activity'");
    expect(gate).toContain('priorDifferentBaseObservationMs(headSha, baseRef, baseTipSha)');
    expect(gate).toContain('t > baseBinding.reviewNotBeforeMs');
    expect(gate).toContain("'Base moved'");
    expect(gate).toContain('baseMovedBetween(results, pass.results)');
    expect(gate).toContain("const BINDING_PREFIX = '<!-- review-gate-binding:'");
  });

  it('re-evaluates when the default base branch advances, from the default-branch copy', () => {
    expect(text).toMatch(/\n {2}push:\n {4}branches: \[main\]\n/);
    expect(text).toMatch(/github\.event_name == 'push'/);
    expect(text).not.toMatch(/^\s*pull_request:\s*$/m);
  });
});
