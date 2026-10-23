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

// The trust bucket for a PR: the base-branch identity (agents.identities) when
// the login has one, the caller's flags otherwise. The config always comes
// from the base branch tip, so the PR still cannot pick its own bucket — the
// flags only stay the fallback so one workflow can gate several agents.
// Shared by `check` (which gates) and `apply` (which re-checks a gate file),
// so the two cannot drift.
export function identityFor(pr, config, flags) {
  const identities = config?.agents?.identities ?? {};
  const identity = pr?.author && Object.hasOwn(identities, pr.author) ? identities[pr.author] : null;
  if (identity) return { agent: identity.agent, model: identity.model };
  return { agent: flags.agent, model: flags.model };
}
