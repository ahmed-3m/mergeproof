// `mergeproof retro` (MP-109): summarize how the agent has been doing, per
// (kind, agent, model, skill) bucket, from the events log apply writes
// (MP-107) plus — for revert rates — the trust ledger. The skill string
// already carries its version (`bugfix@4`), so each skill version earns its
// own row. Pure counting and formatting: the command reads the files, this
// module never does I/O.

const bucketKey = (e) => `${e.kind ?? 'unknown'}\u0000${e.agent}\u0000${e.model}\u0000${e.skill ?? 'none'}`;

const rate = (part, whole) => (whole.length === 0 ? null : part.length / whole.length);

/**
 * Group `events` by (kind, agent, model, skill) and count what happened.
 * With a `ledger`, each group also gets a revert rate from the settled
 * (`clean` or `reverted`) ledger outcomes of the same bucket — the events log
 * itself never decides anything about trust.
 * @param {object[]} events parsed events.jsonl records
 * @param {{ outcomes: object[] } | null} [ledger] the trust ledger, or null
 * @param {{ minN?: number }} [opts] groups with fewer runs are flagged insufficient (default 5)
 * @returns {object[]} one summary per group, in first-seen order
 */
export function summarize(events, ledger = null, { minN = 5 } = {}) {
  const buckets = new Map();
  for (const e of events) {
    let b = buckets.get(bucketKey(e));
    if (!b) {
      b = { kind: e.kind ?? 'unknown', agent: e.agent, model: e.model, skill: e.skill ?? 'none', events: [], maxAttempt: new Map() };
      buckets.set(bucketKey(e), b);
    }
    b.events.push(e);
    const attempt = Number.isInteger(e.attempt) && e.attempt >= 1 ? e.attempt : 1;
    b.maxAttempt.set(e.pr, Math.max(b.maxAttempt.get(e.pr) ?? 0, attempt));
  }
  return [...buckets.values()].map((b) => {
    // Why a run went to a human — kept separate, because a tamper run and a
    // mere human-only hold say opposite things about the agent.
    const humanReasons = { tamper: 0, humanOnly: 0, untrusted: 0, other: 0 };
    for (const e of b.events.filter((x) => x.verdict === 'HUMAN')) {
      if ((e.tamperRules ?? []).length > 0) humanReasons.tamper++;
      else if (e.held === true) humanReasons.humanOnly++;
      else if (e.proven === true) humanReasons.untrusted++;
      else humanReasons.other++;
    }
    const prs = [...b.maxAttempt.keys()];
    const mergedPrs = prs.filter((pr) => b.events.some((e) => e.pr === pr && e.merged === true));
    const settled = (ledger?.outcomes ?? []).filter(
      (o) => (o.status === 'clean' || o.status === 'reverted') && o.kind === b.kind && o.agent === b.agent && o.model === b.model && (o.skill ?? 'none') === b.skill,
    );
    const reverted = settled.filter((o) => o.status === 'reverted');
    return {
      kind: b.kind,
      agent: b.agent,
      model: b.model,
      skill: b.skill,
      runs: b.events.length,
      insufficient: b.events.length < minN,
      firstTryProvenRate: rate(b.events.filter((e) => e.attempt === 1 && e.proven === true), b.events.filter((e) => e.attempt === 1)),
      retryProvenRate: rate(b.events.filter((e) => e.attempt > 1 && e.proven === true), b.events.filter((e) => e.attempt > 1)),
      meanAttempts: prs.length === 0 ? 0 : prs.reduce((sum, pr) => sum + b.maxAttempt.get(pr), 0) / prs.length,
      humanReasons,
      mergeRate: prs.length === 0 ? 0 : mergedPrs.length / prs.length,
      revertRate: settled.length === 0 ? null : reverted.length / settled.length,
    };
  });
}

const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);

/**
 * Format the summarize() groups as a human-readable report. A group below
 * minN shows `insufficient data (n=<runs> < <minN>)` instead of its rates:
 * a rate over too few runs would say more than the data does.
 */
export function formatRetro(groups, { minN = 5 } = {}) {
  if (!groups || groups.length === 0) return 'Mergeproof retro — no events yet (nothing has landed)';
  const lines = ['Mergeproof retro'];
  for (const g of groups) {
    lines.push(`${g.kind}  ${g.agent}/${g.model}  skill=${g.skill}  runs=${g.runs}`);
    if (g.insufficient) {
      lines.push(`  insufficient data (n=${g.runs} < ${minN})`);
      continue;
    }
    lines.push(
      `  first-try proven ${pct(g.firstTryProvenRate)} · retry→proven ${pct(g.retryProvenRate)} · mean attempts ${g.meanAttempts.toFixed(1)} · merged ${pct(g.mergeRate)} · reverted ${pct(g.revertRate)}`,
    );
    lines.push(`  HUMAN reasons: ${g.humanReasons.tamper} tamper · ${g.humanReasons.humanOnly} human-only · ${g.humanReasons.untrusted} untrusted · ${g.humanReasons.other} other`);
  }
  return lines.join('\n');
}
