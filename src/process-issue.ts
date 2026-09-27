export type IssueReference = {
  issueNumber: number;
  owner: string;
  repository: string;
};

export type IssueSnapshot = {
  body: string;
  number: number;
  title: string;
  url: string;
};

export type RunManifest = {
  issueContract: {
    capturedAt: string;
    issue: IssueSnapshot & {
      owner: string;
      repository: string;
    };
  };
  runId: string;
  schemaVersion: 1;
  state: 'planning';
};

export type ProcessIssueDependencies = {
  loadIssue: (reference: IssueReference) => Promise<IssueSnapshot>;
  newRunId: () => string;
  now: () => Date;
  saveManifest: (manifest: RunManifest) => Promise<string>;
};

function parseIssueReference(value: string) {
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(value);
  if (!match) throw new Error("Issue must use the form 'owner/repository#number'");

  const [, owner, repository, issueNumber] = match;
  if (owner === undefined || repository === undefined || issueNumber === undefined) {
    throw new Error('Issue reference is incomplete');
  }

  return {
    issueNumber: Number(issueNumber),
    owner,
    repository,
  };
}

export async function processIssue(
  rawReference: string,
  dependencies: ProcessIssueDependencies,
) {
  const reference = parseIssueReference(rawReference);
  const issue = await dependencies.loadIssue(reference);
  const manifest: RunManifest = {
    issueContract: {
      capturedAt: dependencies.now().toISOString(),
      issue: {
        ...issue,
        owner: reference.owner,
        repository: reference.repository,
      },
    },
    runId: dependencies.newRunId(),
    schemaVersion: 1,
    state: 'planning',
  };
  const manifestPath = await dependencies.saveManifest(manifest);
  return { manifestPath, reference };
}
