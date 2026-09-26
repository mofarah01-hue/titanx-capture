// Training plans: phases, each with a target heart rate zone range. While a plan runs, every athlete
// gets a quick look status against the current target: on target, work harder (below), slow down
// (above). Zones come from each athlete's own max HR, so one plan fits everyone.
// Durations are seconds; Infinity means "until stopped".

export const INTENSITY = {
  low: { name: 'Low', zones: [1, 2] },
  mid: { name: 'Mid', zones: [3, 3] },
  high: { name: 'High', zones: [4, 5] },
};

export const STATUS = {
  on: { name: 'On target', icon: '✓' },
  below: { name: 'Work harder', icon: '▲' },
  above: { name: 'Slow down', icon: '▼' },
};

/** Example plans for a wrestling room. { repeat, phases } expands to numbered copies. */
export const PLANS = [
  { id: 'technique', name: 'Technique day', intensity: 'low', about: 'Skill work at an easy effort. Quality over pace.', phases: [
    { name: 'Warm up', zone: [2, 2], s: 600 }, { name: 'Drilling', zone: [2, 2], s: 1200 }, { name: 'Situations', zone: [2, 3], s: 900 }, { name: 'Cool down', zone: [1, 1], s: 300 },
  ] },
  { id: 'aerobic', name: 'Aerobic base', intensity: 'mid', about: 'Long steady work that builds the engine.', phases: [
    { name: 'Warm up', zone: [2, 2], s: 480 }, { name: 'Steady conditioning', zone: [3, 3], s: 1200 }, { name: 'Cool down', zone: [1, 1], s: 300 },
  ] },
  { id: 'threshold', name: 'Threshold rounds', intensity: 'high', about: 'Hard rounds just under the limit, short rests between.', phases: [
    { name: 'Warm up', zone: [2, 2], s: 600 }, { repeat: 4, phases: [{ name: 'Threshold', zone: [4, 4], s: 240 }, { name: 'Recover', zone: [2, 2], s: 120 }] }, { name: 'Cool down', zone: [1, 1], s: 300 },
  ] },
  { id: 'live', name: 'Live wrestling', intensity: 'high', about: 'Match pace bouts with rest between, like a tournament day.', phases: [
    { name: 'Warm up', zone: [2, 2], s: 600 }, { name: 'Drilling', zone: [3, 3], s: 600 }, { repeat: 5, phases: [{ name: 'Live bout', zone: [5, 5], s: 120 }, { name: 'Rest', zone: [2, 2], s: 60 }] }, { name: 'Cool down', zone: [1, 1], s: 300 },
  ] },
  { id: 'sprints', name: 'Sprint conditioning', intensity: 'high', about: 'Short all out efforts with full recoveries.', phases: [
    { name: 'Warm up', zone: [2, 2], s: 480 }, { repeat: 6, phases: [{ name: 'Sprint', zone: [5, 5], s: 60 }, { name: 'Recover', zone: [1, 2], s: 90 }] }, { name: 'Cool down', zone: [1, 1], s: 300 },
  ] },
  { id: 'recovery', name: 'Recovery session', intensity: 'low', about: 'Easy movement the day after a hard session.', phases: [
    { name: 'Easy movement', zone: [1, 1], s: 1200 },
  ] },
];

/** A single open ended phase: everyone holds one zone until the coach stops it. */
export const holdPlan = (z) => ({ id: `hold-z${z}`, name: `Hold zone ${z}`, intensity: z <= 2 ? 'low' : z === 3 ? 'mid' : 'high', about: '', phases: [{ name: `Hold zone ${z}`, zone: [z, z], s: Infinity }] });

/** Flat list of phases, repeats expanded and numbered ("Live bout 2 of 5"). */
export function expand(plan) {
  const out = [];
  const walk = (list, rep) => {
    for (const p of list) {
      if (p.repeat) for (let i = 1; i <= p.repeat; i++) walk(p.phases, { i, n: p.repeat });
      else out.push({ name: rep ? `${p.name} ${rep.i} of ${rep.n}` : p.name, zone: p.zone, s: p.s });
    }
  };
  walk(plan.phases, null);
  return out;
}
export const totalS = (plan) => expand(plan).reduce((a, p) => a + p.s, 0);

/** bpm span of zones lo..hi for a max HR. Zone n runs from (40 + 10n) % to (50 + 10n) % of max. */
export function zoneBpm([lo, hi], maxHr) {
  return maxHr ? [Math.round(maxHr * (0.4 + 0.1 * lo)), Math.round(maxHr * (0.5 + 0.1 * hi))] : null;
}

/**
 * Quick look status of one athlete. zone: 0 (below zone 1) to 5, or null when there is no live HR
 * or no max HR, and then there is no status: never a confident colour without data.
 * Below zone 1 counts as on target when zone 1 is the target (resting is fine during recovery).
 */
export function targetStatus(zone, [lo, hi]) {
  if (zone == null) return null;
  if (zone > hi) return 'above';
  if (zone < lo && !(lo === 1 && zone === 0)) return 'below';
  return 'on';
}

// ---------- running a plan (session time t, seconds) ----------
export function startRun(plan, t) {
  return { id: plan.id, name: plan.name, intensity: plan.intensity, phases: expand(plan), idx: 0, phaseStart: t, startedAt: t, done: false };
}

/**
 * Move a running plan forward to time t. Returns every phase entered, each with its scheduled start
 * `at`, so labels line up with the plan even if this ran late (a hidden tab checks rarely).
 */
export function advance(run, t) {
  const entered = [];
  while (!run.done && t - run.phaseStart >= run.phases[run.idx].s) {
    run.phaseStart += run.phases[run.idx].s;
    if (run.idx + 1 >= run.phases.length) { run.done = true; break; }
    run.idx++;
    entered.push({ index: run.idx, at: run.phaseStart, ...run.phases[run.idx] });
  }
  return entered;
}

/** End the current phase now and move on. */
export function skip(run, t) {
  if (run.done) return [];
  run.phases[run.idx] = { ...run.phases[run.idx], s: t - run.phaseStart };
  return advance(run, t);
}

/** Current phase with time left, or null when no plan runs or it has finished. */
export function current(run, t) {
  if (!run || run.done) return null;
  const p = run.phases[run.idx];
  return { ...p, index: run.idx, count: run.phases.length, left: p.s - (t - run.phaseStart), next: run.phases[run.idx + 1] || null };
}
