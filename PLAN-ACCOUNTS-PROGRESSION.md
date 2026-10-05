# Viber Brawl — Accounts, Progression, Analytics & Profiles

## STATUS — what is built (updated 2026-10-05)

| Phase | Status | What exists |
|---|---|---|
| **0** D1 database, schema, migrations | **done** | 21 tables, 30 achievements, 35 cosmetic unlocks, 6 challenges. `npm run db:migrate` |
| **1** Server-authoritative match reporting | **done** | Every finished match is written to D1 by the Durable Object, idempotently |
| **2** Accounts, sessions, authentication | **done** | Guest play, guest→account upgrade, Google/Discord OAuth, email+password, sessions, deletion, rate limiting, ACCOUNT screen |
| **3** XP, levels, rewards, ledger | **done** | XP rules, level curve, append-only XP ledger, achievements, cosmetic unlocks, challenges |
| **4** Profile screen | **next** | The data is already served by `/api/progress/me` — this is the UI |
| **5** Achievements & Locker UI | partly | Achievements and unlocks are evaluated and granted; the browsable screens are phase 5 |
| **6** Analytics dashboard | not started | Server events are already being recorded |
| **7** Polish | not started | — |

**Test suite: 321 checks across 7 files, all passing.** `npm run verify`

Your decisions are implemented as chosen: **both** sign-in methods, **cosmetic-only**
unlocks, **both** analytics audiences, **one page**.

> ⚠️ **Email + password needs Cloudflare's $5/month plan.** Hashing a password
> costs 200–400 ms of CPU and the free plan allows 10 ms per request. Set
> `AUTH_PASSWORD = "0"` in `wrangler.toml` to run OAuth-only on the free plan —
> Google and Discord sign-in cost no CPU at all.

---

**Status: PLAN ONLY. No game code has been changed yet.** This document is the proposal to
review before implementation starts. Every decision I need from you is listed in
[§9 Open decisions](#9-open-decisions--my-recommendation) with my recommendation, so you can
just say "go with your recommendations" if you'd rather not pick.

---

## 0. The one thing that is already done

You asked me to *"create a copy of the original game file and make all changes only on that copy,
leaving the original file completely untouched."*

**That is already how this project works, and has been from the start.**

| File | Role | Touched? |
|---|---|---|
| `public/viber-brawl-v6-original.html` | a byte-identical copy of your game | **never written to** |
| `public/viber-brawl-multiplayer.html` | the generated working copy — *all* changes happen here | regenerated each build |
| `build-client.mjs` | the generator | refuses to output unless the original script survives verbatim |

Your original file is verified on every build. Right now:

```
your file on disk       3676261bea7f36177d02bc63854e52f9
the copy in the project 3676261bea7f36177d02bc63854e52f9   ← identical
original script preserved verbatim : YES
solo systems still present         : ALL 15
```

So the guarantee you asked for is in place. Everything below is **added to the generated copy
only** — new screens, new client module, new server routes. Nothing in your original is edited.

---

## 1. What I'm proposing, in one paragraph

Turn Viber Brawl from "a link you send a friend" into **a game people can have an account in** —
sign in once, keep your name and stats, level up from matches you actually play, unlock cosmetics
you can show off, and see a profile page with your record. Under the hood, every stat is computed
**on the server from matches the server itself refereed**, so none of it can be faked. Alongside it,
a private analytics pipeline so you can see how people actually play — where they drop out, which
Vibers win, whether they come back the next day.

The single most important design choice: **progression is cosmetic, not power.** That's how
Fortnite, Apex, Valorant, Overwatch and Rocket League all do it, and it's the only way to keep a
competitive game fair.

---

## 2. How leading multiplayer games actually do this

I looked at how the established titles handle each area. Summary of what they do, and what's
worth copying:

### Accounts

| What they do | Why | Copy it? |
|---|---|---|
| **Platform-first identity** (Steam/Epic/PSN) with an optional first-party account | One click to play, no new password | Yes — Google/Discord is our equivalent |
| **Guest → account upgrade** — you can play before you sign up, and keep your progress when you do | Forcing signup before first play kills conversion | **Yes, definitely.** This is the single biggest onboarding win |
| Never store passwords if you can avoid it (OAuth delegation) | Nothing to leak, nothing to reset | Yes — see the CPU constraint in §4 |
| Email verification + password reset exist from day one | Account recovery is the #1 support cost in any game | Yes, but only if we do passwords |
| Account deletion is a real, working button | GDPR/legal, and basic respect | Yes |
| Session tokens in httpOnly cookies, short-lived, rotating | XSS can't read them | Yes |
| Rate-limit and bot-check login/register | Credential stuffing is constant | Yes — Cloudflare Turnstile + rate limiting |

### Progression

| What they do | Why | Copy it? |
|---|---|---|
| **Two separate numbers**: a *level* (prestige, from XP) and a *skill rating* (MMR, from results) | Conflating them makes both meaningless | **Yes.** Level ≠ skill |
| **Cosmetic-only unlocks in competitive modes** | Never sell or gate power | **Yes — non-negotiable for fairness** |
| XP from *many* sources: completion, placement, KOs, damage, survival, first-win-of-day, challenges | Rewards participation, not just winning | Yes, all of them |
| **First win of the day** bonus | The single best cheap retention mechanic in the genre | **Yes, day one** |
| **Daily and weekly challenges** (3 + 3) | Gives a reason to log in beyond "I feel like it" | Yes |
| **Per-character mastery** — a separate level for each Viber you play | Apex/Overwatch/League all use it; it's a huge engagement loop | Yes — we already have 4 Vibers |
| **Battle pass / season track** — time-boxed, free + premium lanes | The main monetisation shape in modern games | Later — needs a season concept first |
| Anti-frustration: you always earn *something* | A player who loses 5 in a row and earns nothing quits | Yes |

### Analytics

| What they do | Why | Copy it? |
|---|---|---|
| **Two separate streams**: gameplay telemetry (per-event, authoritative) and product analytics (funnels, retention) | They answer different questions | **Yes** |
| **Server-authoritative events only** for anything that affects progression | Client-reported stats are cheatable | **Yes — we already have this for free** |
| Versioned event schema (`schema_version` on every event) | Lets you change the schema without breaking history | Yes |
| Standard metric set: DAU/WAU/MAU, D1/D7/D30 retention, session length, completion rate | These are the numbers that actually tell you if the game is alive | Yes |
| **Balance telemetry**: per-Viber pick rate *and* win rate | The only way to know if a Viber is broken | **Yes — you have 4 characters and no data on them today** |
| Death/KO position heatmaps | Shows which arena spots are death traps | Yes, cheap and revealing |
| Pseudonymous IDs, no PII in events, retention limits, delete-on-request | Legal + ethical | Yes |
| Aggregates kept forever, raw events expire (e.g. 90 days) | Keeps storage bounded | Yes |

### Profiles

| What they do | Why | Copy it? |
|---|---|---|
| Career page: matches, wins, win rate, KOs, K/D, playtime, favourite character | The "look what I've done" page | Yes |
| **Match history** (last N matches, per-match breakdown) | Makes every match feel recorded | Yes |
| Achievements with tiers (bronze/silver/gold) and rarity % | Chase goals beyond winning | Yes |
| A **locker / showcase** for cosmetics | Cosmetics are worthless if you can't display them | Yes |
| Public/private visibility toggle | Some people don't want to be looked up | Yes |
| Level + XP-to-next displayed prominently | The core loop needs to be visible | Yes |

---

## 3. Proposed architecture

```
                    ┌─────────────────────────────────────────────┐
                    │  Browser — generated game copy              │
                    │  (original game + new screens)              │
                    └───────────────┬─────────────────────────────┘
                                    │
                 HTTPS              │                    WebSocket
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐          ┌────────────────┐          ┌─────────────────┐
│ /api/auth/*   │          │ /api/profile/* │          │ /ws?room=&token │
│ /api/progress │          │ /api/events    │          │                 │
└───────┬───────┘          └───────┬────────┘          └────────┬────────┘
        │                          │                            │
        └──────────┬───────────────┘                            ▼
                   ▼                                  ┌──────────────────────┐
        ┌──────────────────────┐                      │  BattleRoom          │
        │  Worker (existing)   │                      │  Durable Object      │
        │  + new routes        │                      │  60 Hz authoritative │
        └──────────┬───────────┘                      │  sim (unchanged)     │
                   │                                  └──────────┬───────────┘
                   │                                             │
                   │                        match ends ──────────┘
                   │                        writes the result itself
                   ▼                                             ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  D1 (SQLite)  accounts · sessions · profiles · progress      │
        │               match_results · xp_ledger · achievements       │
        │               unlocks · events                               │
        └──────────────────────────────────────────────────────────────┘
```

### The key architectural insight

**You already have the hard part.** The Durable Object already computes, server-side and
uncheatably, everything a progression system needs:

```js
// already produced by the existing match, per player:
{ id, name, charId, placement, lives, kos, falls, dmgDealt, dmgTaken, winner, disconnected }
```

Every other indie game has to *build* trusted stats. We get them free. So progression and
analytics are driven **entirely from server-verified match results** — a client can never claim
XP, a KO, or a win. That preserves the "no cheating" property the whole multiplayer build rests on.

### New components

| Component | Where | Purpose |
|---|---|---|
| `migrations/` + `schema.sql` | `multiplayer/db/` | D1 schema, versioned |
| `auth/` module | `multiplayer/src/auth/` | sessions, OAuth, password hashing (if used), rate limiting |
| `profile/` module | `multiplayer/src/profile/` | stats aggregation, public profile, match history |
| `progression/` module | `multiplayer/src/progression/` | XP rules, level curve, rewards, achievements |
| `analytics/` module | `multiplayer/src/analytics/` | event ingestion, aggregation queries, dashboard |
| `matchReporter` | inside `BattleRoom` | on match end, writes results + awards XP (idempotent) |
| Account + Profile screens | `multiplayer/client/` | new UI, additive to the generated copy |

### Data model (D1)

```
accounts            id, email, email_verified, provider, provider_id,
                    password_hash, password_salt, created_at, status, deleted_at
profiles            account_id, display_name, display_name_lower, avatar_viber,
                    country, is_public, created_at
sessions            id, account_id, token_hash, created_at, expires_at,
                    last_seen_at, ip_hash, ua_hash, revoked_at
progress            account_id, level, xp_total, xp_this_level, updated_at
viber_mastery       account_id, char_id, xp, level
match_summary       match_id, room_code, map, player_count, duration_s,
                    started_at, ended_at, winner_account_id, ruleset_hash
match_results       id, match_id, account_id, char_id, placement, lives_left,
                    kos, falls, dmg_dealt, dmg_taken, winner, disconnected
xp_ledger           id, account_id, match_id, amount, reason, created_at
achievements        id, name, description, tier, secret, sort_order      (static)
account_achievements account_id, achievement_id, progress, unlocked_at
unlocks             id, kind, name, unlock_condition_json                 (static)
account_unlocks     account_id, unlock_id, unlocked_at, source
events              id, account_id, session_id, name, props_json,
                    schema_version, ts
```

Notes:
* `xp_ledger` is an **append-only audit trail**. If a number ever looks wrong you can replay it.
  Every serious game has one; it is the difference between "a bug" and "we have no idea".
* `match_summary` + `match_results` are written with `INSERT OR IGNORE` on a unique
  `match_id`, so a Durable Object restart can never double-award XP.
* `ruleset_hash` records the exact game constants used for that match, so if you retune the game
  later you can still interpret old results.

---

## 4. The one hard technical constraint you need to decide on

**Cloudflare Workers on the free plan allow 10 ms of CPU time per request.**
(Paid is $5/month, default 30 s.)

Password hashing — PBKDF2, bcrypt or argon2 — costs 50–300 ms of CPU. It **cannot run on the free
plan.** This isn't a preference, it's a hard limit, and it changes the auth design:

| Option | Works on free plan? | Security | Setup effort for you |
|---|---|---|---|
| **A. Google / Discord sign-in (OAuth)** | ✅ Yes — no hashing at all | Strongest (no passwords to leak, 2FA for free) | One-time: register an app with Google and/or Discord |
| **B. Email + password** | ❌ No — needs the $5/mo plan | Fine if done right | Cheapest to build, most to maintain (reset flows, verification, support) |
| **C. Magic link (email a login link)** | ✅ Yes | Strong | Needs an email provider (e.g. Resend) |
| **D. Managed auth service** (Clerk, Supabase Auth, Better Auth) | ✅ Yes — hashing happens elsewhere | Strong | Another account + vendor, some lock-in |
| **E. Username + password, weak hashing** | ✅ Yes | ❌ **Do not do this** | — |

**My recommendation: A + guest play, with B added later if you want it.**
Google and Discord sign-in is what most modern games offer anyway, it removes the entire class of
"forgot my password" problems, it needs no CPU budget, and it works on the free plan. A guest can
play immediately and link an account later without losing anything.

I'll flag D1's exact free-tier read/write allowances before we rely on them — I have not verified
those numbers yet and I don't want to guess at them.

---

## 5. Feature set, area by area

### 5.1 Accounts

* **Guest play first.** You can open the game, join a room and play with no account at all — exactly
  as today. A guest gets a local identity and a prompt, never a wall.
* **Sign in with Google / Discord** (one click), or email + password if we go with the paid plan.
* **Upgrade in place.** A guest who signs in keeps their name and any stats earned that session.
* **Session handling.** httpOnly + Secure + SameSite cookies, rotating, revocable. Sign out
  everywhere. Idle expiry.
* **Account screen** in-game: who you're signed in as, linked providers, sign out, delete account.
* **Abuse protection.** Rate-limited login/register (sliding window), Cloudflare Turnstile on
  signup, generic error messages so we don't leak which emails exist.
* **Account deletion** that actually deletes: personal fields wiped, match history anonymised,
  analytics rows de-identified.
* **Display name rules**: 3–14 chars, unique (case-insensitive), profanity screen, changeable
  with a cooldown.

### 5.2 Progression

* **Level** from total XP. Cosmetic prestige only. Visible everywhere.
* **Skill rating** kept separate and *not* shown as "level". Starts hidden; we can surface it later.
* **XP sources** (all server-verified from match results):

  | Source | Notes |
  |---|---|
  | Match completed | small base — everyone who finishes gets something |
  | Placement | 1st > 2nd > 3rd > 4th |
  | Knockouts | the main skill reward |
  | Damage dealt | **capped per match** so it can't be farmed |
  | Survival time | rewards not dying |
  | First win of the day | large, once per day — the retention hook |
  | Daily challenges (3) | e.g. "land 5 KOs", "win a match as Phantom", "survive 3 minutes" |
  | Weekly challenges (3) | bigger, longer |
  | Achievements | one-off chunks |

* **Anti-frustration rule:** a loss still pays. Never zero.
* **Level curve:** gentle early, flattening later (`xpForLevel(n)` from a tuned table, capped at
  level 100 for launch). Aim: first level in ~2 matches, level 10 in a few hours.
* **Rewards per level**: cosmetics + a little currency, never power.
* **Per-Viber mastery**: separate XP per character, with its own small reward track. Four Vibers =
  four parallel goals from day one.
* **Seasons**: deliberately deferred. It needs the rest to exist first.

### 5.3 Unlocks & cosmetics

* **Cosmetic only** — palettes/skins for each Viber, KO effects, trails, banner frames, player
  titles. None of it touches `CHAR_STATS` or anything the server sim reads.
* **Two acquisition routes**: level-gated (grind) and achievement-gated (skill). Mixing them means
  both kinds of player always have something to chase.
* **A Locker screen** to browse, equip, and preview.
* **The hard rule, enforced in code:** an unlock record can only ever point at a cosmetic id. The
  progression module must not be able to reach gameplay constants. If a future feature wants
  gameplay unlocks, that's a deliberate, reviewed decision — not an accident.

### 5.4 Analytics

* **Server events** (authoritative, emitted by the Durable Object):
  `match_started`, `match_ended`, `player_joined`, `player_left`, `ko`, `fall`, `powerup_picked`,
  `hazard_hit`, `ability_used`, `rematch`, `room_created`, `room_joined`, `room_abandoned`.
* **Client events** (funnel/UX only, explicitly *not* used for stats):
  `app_open`, `menu_view`, `multiplayer_clicked`, `room_code_entered`, `match_start_clicked`,
  `error_shown`, `profile_viewed`, `signin_started`, `signin_completed`.
* **Dashboard metrics:**
  * Alive: DAU / WAU / MAU, D1 / D7 / D30 retention
  * Engagement: sessions per player, matches per player, average session length
  * Health: match completion rate, quit rate, abandonment by stage
  * Funnel: open → MULTIPLAYER → room → ready → match start → match complete, with drop-off at each step
  * Balance: **per-Viber pick rate and win rate**, average KOs, average damage — you currently have
    no data on whether Phantom is broken
  * Arena: KO/fall position heatmap, which platforms are death traps
  * Technical: error rate, average RTT, disconnect rate
* **Privacy**: pseudonymous ids, no emails/names in events, raw events expire after 90 days,
  aggregates kept, deletion honoured.
* **Storage**: D1 to start (volume is tiny at this scale). Cloudflare Analytics Engine is the
  upgrade path if event volume grows — I'll note the migration trigger.

### 5.5 Profile

A new in-game screen, reachable from the menu, with tabs:

| Tab | Contents |
|---|---|
| **Overview** | Level, XP bar, next reward, favourite Viber, total playtime, current streak |
| **Stats** | Matches, wins, win rate, total KOs, K/D, damage dealt/taken, best placement, longest win streak, per-Viber breakdown |
| **Achievements** | Grid of locked/unlocked, progress bars, rarity %, recently earned |
| **Locker** | Cosmetics owned, equip/preview |
| **History** | Last 20 matches: date, Viber, placement, KOs, damage, duration, who won |

Plus a **public profile** at a shareable link (`/p/displayname`) so people can show their record
off — opt-out-able.

---

## 6. Implementation plan (phases, each one shippable)

| Phase | What | Why this order |
|---|---|---|
| **0** | D1 database, schema, migrations, local dev wiring | Nothing user-visible; everything depends on it |
| **1** | Server-side match reporting → `match_results` | The data foundation. No UI yet, but it starts recording real matches immediately |
| **2** | Accounts: guest identity, OAuth sign-in, sessions, account screen | Now stats have an owner |
| **3** | Progression: XP rules, level curve, `xp_ledger`, level-up feedback | First visible reward loop |
| **4** | Profile screen: overview + stats + match history | Makes progress visible and shareable |
| **5** | Achievements + unlocks + Locker | Depth and long-term goals |
| **6** | Analytics pipeline + private dashboard | Needs real data accumulated first |
| **7** | Polish: public profiles, leaderboards, Viber mastery, seasons | Only once the base is proven |

Each phase ends with: the build still verifying solo is untouched, the existing 173 checks still
green, plus new checks for the phase.

---

## 7. Security model

* **Never trust the client for anything that matters.** All progression input comes from the
  server-refereed match result. Client events are analytics-only and clearly separated in the schema.
* Sessions in httpOnly/Secure cookies; token stored hashed at rest; rotation on refresh; revocation
  list.
* Password hashing (if we do passwords): PBKDF2-SHA256, OWASP iteration count, per-user salt.
  **Requires the paid plan.**
* Rate limiting on every auth endpoint (sliding window), plus Turnstile on registration.
* Input validation and output escaping on every user-controlled string — display names go into the
  game UI and into profiles, so they are an XSS surface.
* No PII in analytics. Emails never leave the auth tables.
* Full account deletion that anonymises history rather than orphaning it.
* CSP and standard security headers on the API responses.

## 8. Risks I want on the record

1. **Scope.** This is roughly the size of everything we've built so far, times two. The phasing
   above exists precisely so each step is independently useful and stoppable.
2. **The free-plan CPU limit** is a real blocker for password auth. Solved by OAuth or $5/month.
3. **D1 free-tier allowances** — I have not verified exact read/write numbers. I will confirm
   before we depend on them, and design so we're nowhere near the ceiling at your scale.
4. **The solo-mode guarantee must hold.** The new screens are additive, and `build-client.mjs`
   already refuses to build if your original script changes. I'll extend its checks, not weaken them.
5. **Cosmetic-vs-power is a one-way door.** Once someone earns an advantage, taking it away causes
   real anger. Better to never ship it.
6. **Analytics volume.** One row per event per player is nothing at your scale, but a runaway event
   could fill storage — hence the 90-day raw retention and a hard cap on client event rate.

## 9. Open decisions — and my recommendation

| # | Decision | Options | **My recommendation** |
|---|---|---|---|
| **1** | **Sign-in method** | Google/Discord OAuth · email+password (needs $5/mo) · magic link · managed service | **OAuth (Google + Discord) + guest play.** Free-plan compatible, nothing to leak, no password resets |
| **2** | **Do unlocks affect gameplay?** | Cosmetic only · unlocks change stats/new Vibers | **Cosmetic only.** Keeps competitive integrity, and it's what every serious game does |
| **3** | **Pace** | One big push through all 7 phases · phase by phase with a check-in · auth + profile only | **Phase by phase, starting at phase 0–2**, so you can see and steer it |
| **4** | **Who is analytics for?** | Just you (private dashboard) · player-facing stats only · both | **Both**, but the private dashboard first — player-facing stats come free from the profile screen |

**One more thing I'd like your call on (not a blocker):** should the account + profile screens live
in the **same page** as multiplayer (one link to share, simpler), or in a **second generated page**
(multiplayer stays exactly as it is today, accounts are a separate URL)? I lean toward one page.

---

## 10. What I will do next

Once you answer §9 — or tell me to use the recommendations above — I'll start at **phase 0**:
create the D1 database, write the schema and migrations, wire local dev, and add the server-side
match reporting so the game begins recording trustworthy match history. No visible change yet, and
your original file stays untouched throughout.
