/* =============================================================================
   progression/level.js — the level curve.

   Level is COSMETIC PRESTIGE ONLY. It never touches a gameplay constant, and
   this module deliberately has no reference to CHAR_STATS or anything the
   simulation reads. Skill lives in a separate rating; conflating the two is what
   makes both meaningless.

   The curve is deliberately front-loaded: the first level should land after one
   match, because a player who sees no progress in their first session does not
   come back for a second one.
   ============================================================================= */

export const MAX_LEVEL = 100;

/**
 * XP required to go from `level` to `level + 1`.
 *
 * Tuned against a target: with an average match paying roughly 150 XP,
 *     level 2   after 1 match        (the first session must show progress)
 *     level 10  after ~15 matches    (a few sessions)
 *     level 50  after ~300 matches   (a real commitment)
 *     level 100 after ~1200 matches  (the long-term goal)
 * A steeper curve looks impressive in a spreadsheet and miserable in practice —
 * an earlier version needed 2,300 matches for level 50, which is a dead end
 * dressed up as content.
 */
export function xpForLevel(level) {
  if (level >= MAX_LEVEL) return Infinity;
  const n = Math.max(1, level | 0);
  return Math.round(55 * Math.pow(n, 0.9));
}

/* Cumulative totals are cheap to derive and cached, because the curve never
   changes at runtime. */
let CUMULATIVE = null;
function cumulative() {
  if (CUMULATIVE) return CUMULATIVE;
  const arr = [0, 0];                 /* index 1 = 0 xp to be level 1 */
  let sum = 0;
  for (let l = 1; l < MAX_LEVEL; l++) {
    sum += xpForLevel(l);
    arr[l + 1] = sum;
  }
  CUMULATIVE = arr;
  return arr;
}

/** Total XP needed to REACH a level (level 1 = 0). */
export function totalXpForLevel(level) {
  const arr = cumulative();
  const l = Math.max(1, Math.min(MAX_LEVEL, level | 0));
  return arr[l] || 0;
}

/**
 * Turn a lifetime XP total into a level and a progress bar.
 * @returns { level, xpIntoLevel, xpForNext, xpTotal, progress }
 */
export function levelFromTotalXp(totalXp) {
  const total = Math.max(0, Math.floor(totalXp || 0));
  let level = 1;
  while (level < MAX_LEVEL && total >= totalXpForLevel(level + 1)) level++;
  const floorXp = totalXpForLevel(level);
  const need = level >= MAX_LEVEL ? 0 : xpForLevel(level);
  const into = total - floorXp;
  return {
    level,
    xpTotal: total,
    xpIntoLevel: into,
    xpForNext: need,
    progress: need > 0 ? Math.min(1, into / need) : 1
  };
}

/**
 * The full ladder of level rewards, derived from the unlock catalogue rather
 * than hard-coded here, so adding a reward is a data change not a code change.
 * Returns [{ level, unlocks: [...] }] ascending.
 */
export function levelRewards(unlockRows) {
  const byLevel = new Map();
  for (const u of (unlockRows || [])) {
    if (u.source !== 'level' || !u.level_req) continue;
    if (!byLevel.has(u.level_req)) byLevel.set(u.level_req, []);
    byLevel.get(u.level_req).push(u);
  }
  return [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, unlocks]) => ({ level, unlocks }));
}

/** The next reward at or after a given level, for the "up next" line in the UI. */
export function nextRewardAt(level, unlockRows) {
  const ladder = levelRewards(unlockRows);
  for (const step of ladder) if (step.level > level) return step;
  return null;
}
