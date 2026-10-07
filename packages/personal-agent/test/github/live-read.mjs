// Explicit opt-in public-only diagnostic, never part of the deterministic test suite.
// No token, CLI auth, mutations, README text or arbitrary API endpoints.
import { GitHubService } from '../../src/github/index.ts';
const owner = process.argv[2];
if (!owner) throw new Error('Pass the independently verified GitHub owner login');
const service = new GitHubService({ owner, authority: async () => {} });
const context = { taskId: 'github-public-read-diagnostic', intentRevision: 1,
  grantId: 'readonly-public', grantRevision: 1, runId: new Date().toISOString() };
const repos = await service.repos(context);
console.log(JSON.stringify({ operation: 'repos', status: repos.status, source: repos.source,
  repositories: repos.data?.repositories?.map(repo => ({ name: repo.name, url: repo.url })),
  complete: repos.data?.complete, nextPage: repos.data?.nextPage, reason: repos.reason }));
if (repos.status === 'ok' && repos.data?.repositories?.some(repo => repo.name.toLowerCase() === 'portfolio')) {
  const readme = await service.file(context, { repository: 'portfolio' }, true);
  console.log(JSON.stringify({ operation: 'portfolio-readme', status: readme.status, source: readme.source,
    bytes: readme.data?.bytes, complete: readme.data?.complete, reason: readme.reason }));
}
