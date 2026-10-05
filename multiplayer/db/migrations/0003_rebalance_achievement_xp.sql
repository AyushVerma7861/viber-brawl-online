-- =============================================================================
-- Migration 0003: rebalance achievement XP
--
-- Why: with the original values, a player's FIRST match paid out more XP from
-- achievements (750) than from actually playing it (320), which shot them to
-- level 7 in one game and made the level number feel worthless. Achievements
-- should be a meaningful bonus on top of play, not the main source of it.
--
-- New shape, by tier:
--     bronze 30   silver 100   gold 350   platinum 1000
-- A first match now lands around level 3-4, which is a strong welcome without
-- making the ladder meaningless.
--
-- This is a data migration, not a code change: the rewards live in the
-- catalogue so they can be retuned without touching the progression module.
-- =============================================================================

UPDATE achievements SET xp_reward = 30   WHERE tier = 'bronze';
UPDATE achievements SET xp_reward = 100  WHERE tier = 'silver';
UPDATE achievements SET xp_reward = 350  WHERE tier = 'gold';
UPDATE achievements SET xp_reward = 1000 WHERE tier = 'platinum';
