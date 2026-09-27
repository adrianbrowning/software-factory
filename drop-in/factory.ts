export type CheckResult = { command: string; exitCode: number; stderr: string; stdout: string };
export type GitHubIssue = { body: string; number: number; title: string; url: string };
export type ReviewFinding = {
  evidence: string;
  file: string;
  line: number | null;
  recommendation: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
};
export type ReviewReport = { findings: ReviewFinding[] };
export type ExecResult = { exitCode: number; stderr: string; stdout: string };
export type FactoryMode = 'implement' | 'review-only';

export type FactoryOptions = {
  baseRef: string;
  checks: string[];
  execute: (command: string) => Promise<ExecResult>;
  fix: (prompt: string) => Promise<void>;
  implement: (prompt: string) => Promise<void>;
  issue: GitHubIssue;
  maxRounds: number;
  mode?: FactoryMode;
  onStatus?: (message: string) => void;
  review: (prompt: string) => Promise<unknown>;
};

export type FactoryResult = {
  checks: CheckResult[];
  findings: ReviewFinding[];
  rounds: number;
  status: 'failed' | 'passed';
};

function report(options: FactoryOptions, message: string) {
  options.onStatus?.(message);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFinding(value: unknown): value is ReviewFinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const finding = <Record<string, unknown>>value;
  return isString(finding.evidence)
    && isString(finding.file)
    && (finding.line === null || typeof finding.line === 'number')
    && isString(finding.recommendation)
    && ['critical', 'high', 'medium', 'low'].includes(String(finding.severity))
    && isString(finding.title);
}

function isReviewReport(value: unknown): value is ReviewReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const review = <Record<string, unknown>>value;
  return Array.isArray(review.findings) && review.findings.every(isFinding);
}

async function runChecks(options: FactoryOptions) {
  const results: CheckResult[] = [];
  for (const command of options.checks) {
    report(options, `[check] ${command}`);
    const result = await options.execute(command);
    report(options, `[check] ${command} ${result.exitCode === 0 ? '✓' : '✗'}`);
    results.push({ command, ...result });
  }
  return results;
}

function implementationPrompt(issue: GitHubIssue) {
  return `Implement this GitHub issue in the current repository.

Issue #${issue.number}: ${issue.title}
${issue.url}

${issue.body}

Read the repository instructions and relevant code before changing anything. Implement the complete requested behavior, add or update tests, and commit the changes. Do not broaden the issue's scope. When finished, output <promise>COMPLETE</promise>.`;
}

function reviewPrompt(baseRef: string, issue: GitHubIssue) {
  return `You are a read-only code reviewer. Review the repository changes in ${baseRef}...HEAD against GitHub issue #${issue.number}: ${issue.title}.

Issue requirements:
${issue.body}

Inspect the actual diff and relevant surrounding code. Report only concrete, actionable defects introduced by the changes: unmet requirements, correctness bugs, security problems, broken error handling, unsafe types, and missing tests for changed behavior. Do not modify files and do not report stylistic preferences.

Return JSON inside <review>...</review> with this exact shape:
{"findings":[{"severity":"critical|high|medium|low","title":"...","file":"...","line":1,"evidence":"...","recommendation":"..."}]}

Use an empty findings array when no actionable defects remain.`;
}

function trimEvidence(value: string) {
  const limit = 4_000;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

function fixPrompt(checks: CheckResult[], findings: ReviewFinding[], issue: GitHubIssue) {
  const failedChecks = checks.filter(check => check.exitCode !== 0).map(check => ({
    command: check.command,
    exitCode: check.exitCode,
    stderr: trimEvidence(check.stderr),
    stdout: trimEvidence(check.stdout),
  }));

  return `Repair the current implementation of GitHub issue #${issue.number}: ${issue.title}.

Deterministic check failures:
${JSON.stringify(failedChecks, null, 2)}

Review findings:
${JSON.stringify(findings, null, 2)}

Validate the evidence against the code, make the smallest correct changes, add or update tests where needed, and commit the changes. Do not broaden scope. When finished, output <promise>COMPLETE</promise>.`;
}

export async function runFactory(options: FactoryOptions) {
  if (options.checks.length === 0) throw new Error('Configure at least one deterministic check');
  if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1) {
    throw new Error('maxRounds must be a positive integer');
  }

  if ((options.mode ?? 'implement') === 'review-only') {
    report(options, '[review-only] Skipping implementation');
  } else {
    report(options, `[implement] Starting issue #${options.issue.number}`);
    await options.implement(implementationPrompt(options.issue));
    report(options, '[implement] Complete');
  }

  let checks: CheckResult[] = [];
  let findings: ReviewFinding[] = [];

  for (let round = 1; round <= options.maxRounds; round += 1) {
    report(options, `[round ${round}/${options.maxRounds}] Starting`);
    checks = await runChecks(options);
    if (!checks.every(check => check.exitCode === 0)) {
      if (round < options.maxRounds) {
        report(options, '[repair] Fixing failed checks');
        await options.fix(fixPrompt(checks, [], options.issue));
        report(options, '[repair] Complete');
      } else {
        report(options, `[failed] Checks still failing after round ${round}`);
      }
      continue;
    }

    report(options, '[review] Starting');
    const review = await options.review(reviewPrompt(options.baseRef, options.issue));
    if (!isReviewReport(review)) throw new Error('Reviewer returned an invalid report');
    findings = review.findings;

    if (findings.length === 0) {
      report(options, '[review] Clean');
      report(options, `[complete] Passed in round ${round}`);
      return { checks, findings, rounds: round, status: 'passed' } satisfies FactoryResult;
    }

    report(options, `[review] ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
    if (round < options.maxRounds) {
      report(options, '[repair] Processing review findings');
      await options.fix(fixPrompt(checks, findings, options.issue));
      report(options, '[repair] Complete');
    } else {
      report(options, `[failed] Review findings remain after round ${round}`);
    }
  }

  return { checks, findings, rounds: options.maxRounds, status: 'failed' } satisfies FactoryResult;
}
