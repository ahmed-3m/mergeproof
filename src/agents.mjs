// Identity is the author login; anyone can name a branch `agent/...`, and a
// fork can claim any branch name. The branch prefix only narrows a trusted
// login. Shared by `check` (which gates the PR) and `apply` (which re-checks a
// gate verdict before landing it, in case the config changed since).
export function notAnAgentPr(pr, config) {
  if (pr.isFork) return 'PR comes from a fork';
  if (!config.agents.logins.includes(pr.author)) return `not an agent PR (author ${pr.author} is not in agents.logins)`;
  const prefixes = config.agents.branchPrefixes;
  if (prefixes.length > 0 && !prefixes.some((p) => pr.headRef?.startsWith(p))) {
    return `agent branch ${pr.headRef} does not start with ${prefixes.join(' or ')}`;
  }
  return null;
}
