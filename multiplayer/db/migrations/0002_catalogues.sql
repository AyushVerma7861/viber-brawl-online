-- =============================================================================
-- Migration 0002: static catalogues
--
-- Achievements, cosmetic unlocks and challenges. These are CONTENT, not user
-- data, so they are versioned here and re-applied with OR IGNORE on every
-- migration run. Editing a row here and re-running updates nothing that already
-- exists — to change live content, add a new migration that UPDATEs it.
--
-- Every achievement below is evaluated purely from server-refereed match
-- results, so none of them can be earned by lying to the client.
-- =============================================================================

-- ---------------------------------------------------------------- achievements
INSERT OR IGNORE INTO achievements (id, name, description, tier, secret, points, xp_reward, sort_order) VALUES
  ('first_match',      'First Steps',        'Play your first match.',                                   'bronze',   0,  5,   50,  10),
  ('first_win',        'Last Viber Standing','Win your first match.',                                    'bronze',   0, 10,  100,  20),
  ('first_ko',         'First Blood',        'Land your first knockout.',                                'bronze',   0,  5,   50,  30),
  ('play_10',          'Regular',            'Play 10 matches.',                                         'bronze',   0, 10,  100,  40),
  ('kos_10',           'Brawler',            'Land 10 knockouts.',                                       'bronze',   0, 10,  100,  50),
  ('falls_10',         'Learning Curve',     'Fall off the arena 10 times.',                             'bronze',   0,  5,   50,  60),
  ('damage_500',       'Heavy Hitter',       'Deal 500 total damage.',                                   'bronze',   0, 10,  100,  70),

  ('win_10',           'Contender',          'Win 10 matches.',                                          'silver',   0, 25,  250, 110),
  ('kos_50',           'Enforcer',           'Land 50 knockouts.',                                       'silver',   0, 25,  250, 120),
  ('streak_3',         'On A Roll',          'Win 3 matches in a row.',                                  'silver',   0, 25,  250, 130),
  ('flawless',         'Untouched',          'Win a match without losing a single stock.',               'silver',   0, 30,  300, 140),
  ('comeback',         'Down To The Wire',   'Win a match after being down to your last stock.',         'silver',   0, 30,  300, 150),
  ('no_fall_win',      'Sure Footed',        'Win a match without falling off the arena.',               'silver',   0, 25,  250, 160),
  ('damage_5000',      'Devastator',         'Deal 5,000 total damage.',                                 'silver',   0, 25,  250, 170),
  ('all_vibers_played','Jack Of All Vibers', 'Play a match as each of the four Vibers.',                 'silver',   0, 25,  250, 180),

  ('win_50',           'Champion',           'Win 50 matches.',                                          'gold',     0, 60,  600, 210),
  ('kos_500',          'Knockout Artist',    'Land 500 knockouts.',                                      'gold',     0, 60,  600, 220),
  ('streak_5',         'Unstoppable',        'Win 5 matches in a row.',                                  'gold',     0, 60,  600, 230),
  ('all_vibers_win',   'Master Of All',      'Win a match with each of the four Vibers.',                'gold',     0, 70,  700, 240),
  ('mastery_10_any',   'Dedicated',          'Reach mastery level 10 with any Viber.',                   'gold',     0, 50,  500, 250),
  ('level_25',         'Seasoned',           'Reach account level 25.',                                  'gold',     0, 60,  600, 260),
  ('level_50',         'Veteran',            'Reach account level 50.',                                  'gold',     0, 80,  800, 270),

  ('win_100',          'Legend Of The Arena','Win 100 matches.',                                         'platinum', 0, 150, 1500, 310),
  ('kos_2000',         'Apex Predator',      'Land 2,000 knockouts.',                                    'platinum', 0, 150, 1500, 320),
  ('streak_10',        'Untouchable',        'Win 10 matches in a row.',                                 'platinum', 0, 150, 1500, 330),
  ('mastery_20_all',   'True Master',        'Reach mastery level 20 with every Viber.',                 'platinum', 0, 200, 2000, 340),
  ('level_100',        'Viber Legend',       'Reach account level 100.',                                 'platinum', 0, 250, 2500, 350),

  ('hazard_ko',        'Arena Is Lava',      'Knock someone out with an arena hazard.',                  'silver',   1, 30,  300, 410),
  ('pad_ko',           'Spring Loaded',      'Knock someone out with a spike pad.',                      'silver',   1, 30,  300, 420),
  ('self_hazard',      'Own Worst Enemy',    'Knock yourself out with an arena hazard.',                 'bronze',   1,  5,   50, 430);

-- --------------------------------------------------------------------- unlocks
-- Cosmetic only. `payload_json` carries colours and effect styles. There is no
-- column here that could hold a gameplay value, and nothing in the progression
-- module can read the game's stat tables.
INSERT OR IGNORE INTO unlocks (id, kind, name, char_id, source, level_req, achievement_id, payload_json, sort_order) VALUES
  -- default kit: everyone starts with these
  ('pal_default_miner',  'palette', 'Crimson Standard', 'miner',   'default', NULL, NULL, '{"accent":"#DFF902","body":"#C0392B"}', 10),
  ('pal_default_moss',   'palette', 'Moss Standard',    'moss',    'default', NULL, NULL, '{"accent":"#5CFFE7","body":"#2E7D32"}', 11),
  ('pal_default_volt',   'palette', 'Volt Standard',    'volt',    'default', NULL, NULL, '{"accent":"#FFD36A","body":"#1565C0"}', 12),
  ('pal_default_phantom','palette', 'Phantom Standard', 'phantom', 'default', NULL, NULL, '{"accent":"#A56BFF","body":"#4A148C"}', 13),

  -- level-gated palettes
  ('pal_frost',      'palette', 'Frostbite',     NULL, 'level',  5, NULL, '{"accent":"#B5D4F4","body":"#0C447C"}', 20),
  ('pal_ember',      'palette', 'Ember',         NULL, 'level', 10, NULL, '{"accent":"#FF9F27","body":"#712B13"}', 21),
  ('pal_toxic',      'palette', 'Toxic',         NULL, 'level', 15, NULL, '{"accent":"#97C459","body":"#173404"}', 22),
  ('pal_midnight',   'palette', 'Midnight',      NULL, 'level', 20, NULL, '{"accent":"#7F77DD","body":"#1A1A2E"}', 23),
  ('pal_gold',       'palette', 'Gilded',        NULL, 'level', 30, NULL, '{"accent":"#FAC775","body":"#633806"}', 24),
  ('pal_void',       'palette', 'Void',          NULL, 'level', 50, NULL, '{"accent":"#EEEDFE","body":"#0B0B12"}', 25),

  -- achievement-gated palettes: earned, not ground out
  ('pal_flawless',   'palette', 'Porcelain',     NULL, 'achievement', NULL, 'flawless',        '{"accent":"#FFFFFF","body":"#B4B2A9"}', 30),
  ('pal_champion',   'palette', 'Champion Gold', NULL, 'achievement', NULL, 'win_50',          '{"accent":"#DFF902","body":"#854F0B"}', 31),
  ('pal_legend',     'palette', 'Legend',        NULL, 'achievement', NULL, 'win_100',         '{"accent":"#FF5B5B","body":"#26215C"}', 32),
  ('pal_untouchable','palette', 'Untouchable',   NULL, 'achievement', NULL, 'streak_10',       '{"accent":"#5CFFE7","body":"#04342C"}', 33),

  -- KO effects
  ('ko_default',     'ko_effect', 'Standard Burst', NULL, 'default',     NULL, NULL,             '{"style":"burst","color":"#DFF902"}', 110),
  ('ko_shockwave',   'ko_effect', 'Shockwave',      NULL, 'level',          5, NULL,             '{"style":"shockwave","color":"#5CFFE7"}', 111),
  ('ko_supernova',   'ko_effect', 'Supernova',      NULL, 'level',         25, NULL,             '{"style":"supernova","color":"#FF9F27"}', 112),
  ('ko_shatter',     'ko_effect', 'Shatter',        NULL, 'achievement',   NULL, 'kos_500',        '{"style":"shatter","color":"#A56BFF"}', 113),

  -- trails
  ('trail_default',  'trail', 'Plain Streak',  NULL, 'default',     NULL, NULL,        '{"style":"line","color":"#DFF902"}', 210),
  ('trail_ribbon',   'trail', 'Ribbon',        NULL, 'level',          8, NULL,        '{"style":"ribbon","color":"#5CFFE7"}', 211),
  ('trail_comet',    'trail', 'Comet',         NULL, 'achievement',   NULL, 'streak_3',  '{"style":"comet","color":"#FFD36A"}', 212),
  ('trail_void',     'trail', 'Void Wake',     NULL, 'achievement',   NULL, 'mastery_10_any', '{"style":"void","color":"#7F77DD"}', 213),

  -- banner frames (shown on the profile and the results screen)
  ('banner_default', 'banner', 'Plain',        NULL, 'default',     NULL, NULL,          '{"frame":"plain","pattern":"none"}', 310),
  ('banner_bronze',  'banner', 'Bronze Frame', NULL, 'level',          3, NULL,          '{"frame":"bronze","pattern":"solid"}', 311),
  ('banner_silver',  'banner', 'Silver Frame', NULL, 'level',         12, NULL,          '{"frame":"silver","pattern":"chevron"}', 312),
  ('banner_gold',    'banner', 'Gold Frame',   NULL, 'level',         35, NULL,          '{"frame":"gold","pattern":"chevron"}', 313),
  ('banner_plasma',  'banner', 'Plasma Frame', NULL, 'achievement',   NULL, 'level_50',    '{"frame":"plasma","pattern":"grid"}', 314),

  -- titles
  ('title_rookie',   'title', 'Rookie',        NULL, 'default',     NULL, NULL,           '{"text":"ROOKIE"}', 410),
  ('title_brawler',  'title', 'Brawler',       NULL, 'level',          5, NULL,           '{"text":"BRAWLER"}', 411),
  ('title_contender','title', 'Contender',     NULL, 'achievement',   NULL, 'win_10',       '{"text":"CONTENDER"}', 412),
  ('title_flawless', 'title', 'Untouched',     NULL, 'achievement',   NULL, 'flawless',     '{"text":"UNTOUCHED"}', 413),
  ('title_hammer',   'title', 'Heavy Hitter',  NULL, 'achievement',   NULL, 'damage_5000',  '{"text":"HEAVY HITTER"}', 414),
  ('title_champion', 'title', 'Champion',      NULL, 'achievement',   NULL, 'win_50',       '{"text":"CHAMPION"}', 415),
  ('title_legend',   'title', 'Viber Legend',  NULL, 'achievement',   NULL, 'level_100',    '{"text":"VIBER LEGEND"}', 416),
  ('title_apex',     'title', 'Apex Predator', NULL, 'achievement',   NULL, 'kos_2000',     '{"text":"APEX PREDATOR"}', 417);

-- ------------------------------------------------------------------- challenges
INSERT OR IGNORE INTO challenges (id, name, description, period, metric, char_id, target, xp_reward, sort_order) VALUES
  ('d_win_1',    'Daily Victory',   'Win 1 match',                  'daily',  'wins',     NULL,     1,  150, 10),
  ('d_kos_5',    'Daily Brawler',   'Land 5 knockouts',             'daily',  'kos',      NULL,     5,  120, 11),
  ('d_play_3',   'Daily Warmup',    'Play 3 matches',               'daily',  'matches',  NULL,     3,  100, 12),
  ('w_win_5',    'Weekly Champion', 'Win 5 matches',                'weekly', 'wins',     NULL,     5,  600, 20),
  ('w_kos_25',   'Weekly Enforcer', 'Land 25 knockouts',            'weekly', 'kos',      NULL,    25,  500, 21),
  ('w_damage',   'Weekly Devastator','Deal 3,000 total damage',     'weekly', 'damage',   NULL,  3000,  500, 22);
