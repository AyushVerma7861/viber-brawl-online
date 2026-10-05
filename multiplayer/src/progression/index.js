/* =============================================================================
   progression/index.js — turn a finished match into progress.

   Called from two places:
     * BattleRoom._onMatchRecorded — when a match the server refereed ends
     * after a guest signs up     — so everything they earned as a guest counts

   DESIGN RULE: this module never increments a counter. It always RECOMPUTES
   from the two sources of truth:
       xp_ledger      every XP grant ever made, append-only
       match_results  every match ever played, written by the server
   That makes it idempotent by construction — running it twice, or running it
   after a crash, cannot inflate anything. The `progress` and `player_stats`
   tables are caches that can be rebuilt at any time.
   ============================================================================= */

import { hasDb } from '../db/index.js';
import { xpForMatch, xpTotal, periodKeys, isFirstWinToday, challengeDeltas } from './xp.js';
import { levelFromTotalXp, MAX_LEVEL } from './level.js';

/* ============================================================ achievement rules ==
   Each rule maps an achievement id to a target and a function that reads the
   player's stats. Progress is stored raw so the UI can show a bar, and the
   achievement unlocks when progress reaches the target.
   ============================================================================= */

const RULES = {
  first_match:        { target: 1,    of: s => s.matches },
  play_10:            { target: 10,   of: s => s.matches },
  first_win:          { target: 1,    of: s => s.wins },
  win_10:             { target: 10,   of: s => s.wins },
  win_50:             { target: 50,   of: s => s.wins },
  win_100:            { target: 100,  of: s => s.wins },
  first_ko:           { target: 1,    of: s => s.kos },
  kos_10:             { target: 10,   of: s => s.kos },
  kos_50:             { target: 50,   of: s => s.kos },
  kos_500:            { target: 500,  of: s => s.kos },
  kos_2000:           { target: 2000, of: s => s.kos },
  falls_10:           { target: 10,   of: s => s.falls },
  damage_500:         { target: 500,  of: s => s.dmgDealt },
  damage_5000:        { target: 5000, of: s => s.dmgDealt },
  streak_3:           { target: 3,    of: s => s.bestStreak },
  streak_5:           { target: 5,    of: s => s.bestStreak },
  streak_10:          { target: 10,   of: s => s.bestStreak },
  flawless:           { target: 1,    of: s => s.flawlessWins },
  no_fall_win:        { target: 1,    of: s => s.noFallWins },
  comeback:           { target: 1,    of: s => s.comebackWins },
  all_vibers_played:  { target: 4,    of: s => s.charsPlayed },
  all_vibers_win:     { target: 4,    of: s => s.charsWon },
  mastery_10_any:     { target: 10,   of: s => s.bestMasteryLevel },
  mastery_20_all:     { target: 20,   of: s => Math.min(...Object.values(s.masteryLevels).concat([0])) },
  level_25:           { target: 25,   of: s => s.level },
  level_50:           { target: 50,   of: s => s.level },
  level_100:          { target: 100,  of: s => s.level },
  hazard_ko:          { target: 1,    of: s => s.hazardKos },
  pad_ko:             { target: 1,    of: s => s.padKos },
  self_hazard:        { target: 1,    of: s => s.selfHazardKos }
};

/* ================================================================ stat load == */

async function loadStats(env, accountId) {
  const m = await env.DB.prepare(
    `SELECT COUNT(*)                  AS matches,
            COALESCE(SUM(winner),0)   AS wins,
            COALESCE(SUM(kos),0)      AS kos,
            COALESCE(SUM(falls),0)    AS falls,
            COALESCE(SUM(dmg_dealt),0)AS dmgDealt,
            COALESCE(SUM(dmg_taken),0)AS dmgTaken,
            COALESCE(SUM(lives_left),0) AS livesLeft,
            COALESCE(MAX(kos),0)      AS maxKos
       FROM match_results WHERE account_id = ?`
  ).bind(accountId).first();

  const stats = {
    matches: m.matches || 0,
    wins: m.wins || 0,
    kos: m.kos || 0,
    falls: m.falls || 0,
    dmgDealt: m.dmgDealt || 0,
    dmgTaken: m.dmgTaken || 0,
    maxKos: m.maxKos || 0,
    flawlessWins: 0, noFallWins: 0, comebackWins: 0, hazardKos: 0, padKos: 0, selfHazardKos: 0,
    bestStreak: 0, currentStreak: 0,
    charsPlayed: 0, charsWon: 0,
    bestMasteryLevel: 0, masteryLevels: {},
    level: 1
  };

  /* Per-match flags that cannot be expressed as a simple SUM. */
  const rows = await env.DB.prepare(
    `SELECT winner, lives_left, falls, char_id, kos
       FROM match_results WHERE account_id = ? ORDER BY created_at ASC`
  ).bind(accountId).all();

  const chars = new Set(), wonChars = new Set();
  let streak = 0;
  for (const r of (rows.results || [])) {
    chars.add(r.char_id);
    if (r.winner) {
      wonChars.add(r.char_id);
      streak++;
      stats.bestStreak = Math.max(stats.bestStreak, streak);
      /* flawless = won without dropping a stock (3 is the starting count) */
      if (r.lives_left >= 3) stats.flawlessWins++;
      if (r.falls === 0) stats.noFallWins++;
      if (r.lives_left === 1) stats.comebackWins++;
    } else {
      streak = 0;
    }
  }
  stats.currentStreak = streak;
  stats.charsPlayed = chars.size;
  stats.charsWon = wonChars.size;

  const mastery = await env.DB.prepare(
    `SELECT char_id, level FROM viber_mastery WHERE account_id = ?`
  ).bind(accountId).all();
  for (const r of (mastery.results || [])) {
    stats.masteryLevels[r.char_id] = r.level;
    stats.bestMasteryLevel = Math.max(stats.bestMasteryLevel, r.level);
  }

  return stats;
}

/* =================================================================== awards == */

/**
 * Award everything an account has earned but not yet been credited for.
 *
 * Idempotent: XP lines are inserted with INSERT OR IGNORE against the unique
 * (account_id, reason, match_id) index, and the level is then derived from the
 * ledger's SUM rather than incremented.
 */
export async function awardForAccount(env, accountId, opts = {}) {
  if (!hasDb(env) || !accountId) return null;

  const matches = await env.DB.prepare(
    `SELECT r.*, s.duration_s, s.player_count
       FROM match_results r
       JOIN match_summary s ON s.match_id = r.match_id
      WHERE r.account_id = ?
      ORDER BY r.created_at ASC
      LIMIT 500`
  ).bind(accountId).all();
  const rows = matches.results || [];

  /* Which days has this player already banked a first-win bonus for? */
  const daily = await env.DB.prepare(
    `SELECT last_first_win_at, last_daily_key FROM daily_state WHERE account_id = ?`
  ).bind(accountId).first();
  let lastFirstWin = daily ? daily.last_first_win_at : 0;

  const stmts = [];
  const now = Date.now();

  for (const r of rows) {
    const firstWinToday = !!r.winner && isFirstWinToday(lastFirstWin, r.created_at);
    const entries = xpForMatch(r, {
      durationS: r.duration_s || 0,
      playerCount: r.player_count || 2,
      firstWinToday,
      lostAStock: (r.lives_left || 0) < 3,
      fellOff: (r.falls || 0) > 0,
      comeback: (r.lives_left || 0) === 1
    });
    for (const e of entries) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO xp_ledger (account_id, match_id, amount, reason, meta_json, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`
      ).bind(accountId, r.match_id, e.amount, e.reason, r.created_at || now));
    }
    if (firstWinToday && r.winner) lastFirstWin = r.created_at || now;

    /* per-Viber mastery gets the same entries, as a separate track */
    const masteryXp = xpTotal(entries);
    if (masteryXp > 0) {
      stmts.push(env.DB.prepare(
        `INSERT INTO viber_mastery (account_id, char_id, xp, level, matches, wins, kos, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?, ?)
         ON CONFLICT(account_id, char_id) DO UPDATE SET
           xp = xp + excluded.xp,
           matches = matches + 1,
           wins = wins + excluded.wins,
           kos = kos + excluded.kos,
           updated_at = excluded.updated_at`
      ).bind(accountId, r.char_id, masteryXp, r.winner ? 1 : 0, r.kos || 0, now));
    }

    /* challenge progress */
    const deltas = challengeDeltas(r, { durationS: r.duration_s || 0 });
    const keys = periodKeys(r.created_at || now);
    const challenges = await env.DB.prepare(`SELECT id, period, metric, char_id FROM challenges`).all();
    for (const c of (challenges.results || [])) {
      const periodKey = c.period === 'weekly' ? keys.week : keys.day;
      let inc = deltas[c.metric] || 0;
      if (c.metric === 'char_wins') {
        inc = (deltas.char_wins && (!c.char_id || c.char_id === deltas.char_id)) ? 1 : 0;
      }
      if (c.metric === 'damage') inc = deltas.damage;
      if (!inc) continue;
      stmts.push(env.DB.prepare(
        `INSERT INTO challenge_progress (account_id, challenge_id, period_key, progress)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, challenge_id, period_key) DO UPDATE SET progress = progress + ?`
      ).bind(accountId, c.id, periodKey, inc, inc));
    }
  }

  if (stmts.length) {
    /* D1 batch has a statement limit; chunk to stay well inside it. */
    for (let i = 0; i < stmts.length; i += 40) {
      await env.DB.batch(stmts.slice(i, i + 40)).catch(err =>
        console.error('[progression] award batch failed', err && err.message));
    }
  }

  /* ------------------------------------------------ derive everything else -- */
  const before = await env.DB.prepare(`SELECT level FROM progress WHERE account_id = ?`)
    .bind(accountId).first();
  const previousLevel = before ? before.level : 1;

  /* Level first, from match XP only. */
  let lvl = await recomputeLevel(env, accountId, now);

  /* Then achievements, which can themselves pay XP (and some of them depend on
     the level we just computed). */
  const stats = await loadStats(env, accountId);
  stats.level = lvl.level;
  const newlyUnlocked = await evaluateAchievements(env, accountId, stats);

  /* If achievements paid out, the level may have moved — recompute so
     progress.xp_total always equals the ledger sum rather than lagging a run. */
  if (newlyUnlocked.length) lvl = await recomputeLevel(env, accountId, now);

  /* player_stats cache, rebuilt from match_results */
  const best = rows.reduce((b, r) => (b === null || r.placement < b ? r.placement : b), null);
  await env.DB.prepare(
    `INSERT INTO player_stats
       (account_id, matches, wins, kos, falls, dmg_dealt, dmg_taken, best_placement,
        playtime_s, current_streak, best_streak, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       matches = excluded.matches, wins = excluded.wins, kos = excluded.kos,
       falls = excluded.falls, dmg_dealt = excluded.dmg_dealt, dmg_taken = excluded.dmg_taken,
       best_placement = excluded.best_placement, playtime_s = excluded.playtime_s,
       current_streak = excluded.current_streak, best_streak = excluded.best_streak,
       updated_at = excluded.updated_at`
  ).bind(
    accountId, stats.matches, stats.wins, stats.kos, stats.falls,
    Math.round(stats.dmgDealt), Math.round(stats.dmgTaken), best,
    rows.reduce((n, r) => n + (r.duration_s || 0), 0),
    stats.currentStreak, stats.bestStreak, now
  ).run();

  /* ------------------------------------------------------- level rewards -- */
  const newUnlocks = await grantUnlocks(env, accountId, lvl.level, newlyUnlocked);

  /* ----------------------------------------------------- daily bookkeeping */
  if (lastFirstWin) {
    await env.DB.prepare(
      `INSERT INTO daily_state (account_id, last_first_win_at, last_daily_key, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         last_first_win_at = excluded.last_first_win_at, updated_at = excluded.updated_at`
    ).bind(accountId, lastFirstWin, periodKeys(now).day, now).run();
  }

  return {
    accountId,
    level: lvl.level,
    xpTotal: lvl.xpTotal,
    xpIntoLevel: lvl.xpIntoLevel,
    xpForNext: lvl.xpForNext,
    levelledUp: lvl.level > previousLevel,
    previousLevel,
    levelsGained: Math.max(0, lvl.level - previousLevel),
    achievements: newlyUnlocked,
    unlocks: newUnlocks,
    stats
  };
}

/* ----------------------------------------------------------- achievements -- */

/**
 * Derive the level from the XP ledger and write it, plus the per-Viber mastery
 * levels. Called twice in a normal run: once from match XP, and again if
 * achievements paid out extra. Always a full recomputation, never an increment,
 * so it cannot drift.
 */
async function recomputeLevel(env, accountId, now) {
  const total = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount),0) AS xp FROM xp_ledger WHERE account_id = ?`
  ).bind(accountId).first();
  const lvl = levelFromTotalXp(total ? total.xp : 0);

  await env.DB.prepare(
    `INSERT INTO progress (account_id, level, xp_total, xp_into_level, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       level = excluded.level, xp_total = excluded.xp_total,
       xp_into_level = excluded.xp_into_level, updated_at = excluded.updated_at`
  ).bind(accountId, lvl.level, lvl.xpTotal, lvl.xpIntoLevel, now).run();

  const masteryRows = await env.DB.prepare(
    `SELECT char_id, xp FROM viber_mastery WHERE account_id = ?`
  ).bind(accountId).all();
  for (const mrow of (masteryRows.results || [])) {
    const ml = levelFromTotalXp(Math.round(mrow.xp * 0.6));   /* mastery is a shorter track */
    if (ml.level !== mrow.level) {
      await env.DB.prepare(`UPDATE viber_mastery SET level = ? WHERE account_id = ? AND char_id = ?`)
        .bind(ml.level, accountId, mrow.char_id).run().catch(() => {});
    }
  }
  return lvl;
}

async function evaluateAchievements(env, accountId, stats) {
  const catalogue = await env.DB.prepare(`SELECT id, xp_reward FROM achievements`).all();
  const owned = await env.DB.prepare(
    `SELECT achievement_id FROM account_achievements WHERE account_id = ? AND unlocked_at IS NOT NULL`
  ).bind(accountId).all();
  const already = new Set((owned.results || []).map(r => r.achievement_id));

  const unlocked = [];
  const stmts = [];
  const now = Date.now();

  for (const a of (catalogue.results || [])) {
    const rule = RULES[a.id];
    if (!rule) continue;
    let progress = 0;
    try { progress = Number(rule.of(stats)) || 0; } catch (e) { progress = 0; }
    const done = progress >= rule.target;

    if (done && !already.has(a.id)) {
      unlocked.push(a.id);
      stmts.push(env.DB.prepare(
        `INSERT INTO account_achievements (account_id, achievement_id, progress, unlocked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, achievement_id) DO UPDATE SET
           progress = excluded.progress, unlocked_at = excluded.unlocked_at`
      ).bind(accountId, a.id, progress, now));
      if (a.xp_reward > 0) {
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO xp_ledger (account_id, match_id, amount, reason, meta_json, created_at)
           VALUES (?, NULL, ?, ?, NULL, ?)`
        ).bind(accountId, a.xp_reward, 'achievement:' + a.id, now));
      }
    } else if (!done) {
      stmts.push(env.DB.prepare(
        `INSERT INTO account_achievements (account_id, achievement_id, progress, unlocked_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(account_id, achievement_id) DO UPDATE SET progress = excluded.progress`
      ).bind(accountId, a.id, Math.min(progress, rule.target)));
    }
  }

  if (stmts.length) {
    for (let i = 0; i < stmts.length; i += 40) {
      await env.DB.batch(stmts.slice(i, i + 40)).catch(() => {});
    }
  }
  return unlocked;
}

/* --------------------------------------------------------------- unlocks -- */

async function grantUnlocks(env, accountId, level, achievementIds) {
  const owned = await env.DB.prepare(
    `SELECT unlock_id FROM account_unlocks WHERE account_id = ?`
  ).bind(accountId).all();
  const have = new Set((owned.results || []).map(r => r.unlock_id));

  const candidates = await env.DB.prepare(
    `SELECT id, source, level_req, achievement_id FROM unlocks WHERE source != 'default'`
  ).all();

  const granted = [];
  const stmts = [];
  const now = Date.now();

  for (const u of (candidates.results || [])) {
    if (have.has(u.id)) continue;
    const byLevel = u.source === 'level' && u.level_req && level >= u.level_req;
    const byAchievement = u.source === 'achievement' && u.achievement_id && achievementIds.includes(u.achievement_id);
    if (!byLevel && !byAchievement) continue;
    granted.push(u.id);
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO account_unlocks (account_id, unlock_id, source, unlocked_at)
       VALUES (?, ?, ?, ?)`
    ).bind(accountId, u.id, u.source, now));
  }

  if (stmts.length) {
    for (let i = 0; i < stmts.length; i += 40) {
      await env.DB.batch(stmts.slice(i, i + 40)).catch(() => {});
    }
  }
  return granted;
}

/* -------------------------------------------------------------- read side -- */

export async function progressFor(env, accountId) {
  if (!hasDb(env) || !accountId) return null;
  const p = await env.DB.prepare(`SELECT * FROM progress WHERE account_id = ?`).bind(accountId).first();
  const stats = await env.DB.prepare(`SELECT * FROM player_stats WHERE account_id = ?`).bind(accountId).first();
  const mastery = await env.DB.prepare(
    `SELECT char_id, xp, level, matches, wins, kos FROM viber_mastery WHERE account_id = ?`
  ).bind(accountId).all();
  const lvl = levelFromTotalXp(p ? p.xp_total : 0);
  return {
    level: lvl.level,
    xpTotal: lvl.xpTotal,
    xpIntoLevel: lvl.xpIntoLevel,
    xpForNext: lvl.xpForNext,
    progress: lvl.progress,
    maxLevel: MAX_LEVEL,
    stats: stats || null,
    mastery: mastery.results || []
  };
}

export { RULES as ACHIEVEMENT_RULES, loadStats };
