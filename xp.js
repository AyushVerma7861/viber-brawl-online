/* =============================================================================
   progression/xp.js — the XP rules.

   Every number here is computed from a match the SERVER refereed. Nothing in
   this file accepts a client-supplied statistic, and the whole file is pure
   functions so it can be unit-tested without a database.

   The rules follow what the established games do:
     * participation always pays, so a losing streak is not a dead end
     * placement and knockouts are the skill rewards
     * damage is CAPPED, because uncapped damage is farmable by one player
       beating on another who is not fighting back
     * the first win of the day is worth more than several matches — it is the
       cheapest and strongest reason to come back tomorrow
   ============================================================================= */

export const XP = {
  participation: 25,
  placement: [0, 60, 35, 20, 10],   /* index = placement (1st..4th) */
  perKo: 12,
  damagePer100: 1,                  /* 1 XP per 100 damage dealt */
  damageCap: 40,
  survivalPer10s: 2,
  survivalCap: 30,
  winBonus: 40,
  firstWinOfDay: 200,
  cleanSweep: 30,                   /* won without losing a stock */
  noFalls: 15,                      /* won without falling off */
  comeback: 25                      /* won from the last stock */
};

/**
 * XP for one player's match.
 *
 * @param result   one row from match_results
 * @param opts     { durationS, playerCount, firstWinToday, lostAStock, fellOff }
 * @returns [{ reason, amount }] — one entry per line of the XP breakdown, so the
 *          profile screen can show a player exactly where their XP came from.
 */
export function xpForMatch(result, opts = {}) {
  const out = [];
  const add = (reason, amount) => {
    const n = Math.round(amount);
    if (n > 0) out.push({ reason, amount: n });
  };

  const placement = Math.max(1, Math.min(4, result.placement || 4));
  const durationS = Math.max(0, opts.durationS || 0);
  const playerCount = Math.max(2, opts.playerCount || 2);

  /* --- always pays ------------------------------------------------------- */
  add('match', XP.participation);

  /* Placement only pays as a bonus for actually beating people: in a 2-player
     match, 2nd place should not feel like a reward. */
  if (placement < playerCount) {
    add('placement', XP.placement[placement] || 0);
  }

  /* --- skill ------------------------------------------------------------- */
  add('kos', (result.kos || 0) * XP.perKo);
  add('damage', Math.min(XP.damageCap, Math.floor((result.dmg_dealt || 0) / 100) * XP.damagePer100));
  add('survival', Math.min(XP.survivalCap, Math.floor(durationS / 10) * XP.survivalPer10s));

  if (result.winner) {
    add('win', XP.winBonus);
    if (!opts.lostAStock) add('flawless', XP.cleanSweep);
    if (!opts.fellOff) add('surefooted', XP.noFalls);
    if (opts.comeback) add('comeback', XP.comeback);
  }

  /* --- the retention hook ------------------------------------------------ */
  if (result.winner && opts.firstWinToday) add('first_win_of_day', XP.firstWinOfDay);

  return out;
}

export const xpTotal = (entries) => entries.reduce((n, e) => n + e.amount, 0);

/* ---------------------------------------------------------------- helpers -- */

/** The period keys used to scope daily and weekly challenges. */
export function periodKeys(now = Date.now()) {
  const d = new Date(now);
  const day = d.toISOString().slice(0, 10);                 /* 2026-10-05 */
  /* ISO week number */
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return { day, week: `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}` };
}

/** True when the player has not won since the last daily reset. */
export function isFirstWinToday(lastFirstWinAt, now = Date.now()) {
  if (!lastFirstWinAt) return true;
  const a = new Date(lastFirstWinAt).toISOString().slice(0, 10);
  const b = new Date(now).toISOString().slice(0, 10);
  return a !== b;
}

/**
 * How much a match contributes to each challenge metric.
 * Kept separate from XP so a challenge can track something XP does not.
 */
export function challengeDeltas(result, opts = {}) {
  return {
    matches: 1,
    wins: result.winner ? 1 : 0,
    kos: result.kos || 0,
    falls: result.falls || 0,
    damage: Math.round(result.dmg_dealt || 0),
    playtime: Math.round(opts.durationS || 0),
    char_wins: result.winner ? 1 : 0,
    char_id: result.char_id || null
  };
}
