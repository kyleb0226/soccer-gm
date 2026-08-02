# Pocket GM — Soccer

Single-file React football-manager game (sibling of `~/baseball-gm`). You manage a club in an
8-nation × 4-division world (640 clubs), pick the XI and tactics, sim the league, the national
cup, a continental Champions Cup and international breaks, work the transfer market, develop
youth, and build a dynasty across seasons.

## Run it
- One static file: `index.html`. Serve the folder — `python3 -m http.server 8126 --directory ~/soccer-gm`
  → http://localhost:8126 — or open it directly.
- Registered in `~/.claude/launch.json` as **soccer-gm** (port 8126) for the preview tooling.
- No build step. React 18 + Babel-standalone + Tailwind, all vendored under `vendor/`.

## Architecture
- The app lives in a `<script type="text/babel-src" id="app-src">` block; an inline script at the
  bottom does `Babel.transform(src, {presets:[["react",{runtime:"classic"}]]})` then `eval`s it.
  The **classic** runtime is required — the default preset emits an ESM `import` that breaks in a
  non-module inline script.
- **State:** one `G` object in `App` `useState`, persisted per save-slot (IndexedDB, with a
  localStorage fallback). Shape changes go in `migrate(G)` rather than bumping the save key.
- **World:** `COUNTRIES` (8 nations, each with `divNames`, wealth, style and attribute tilt),
  `NUM_DIVS` tiers, `CLUBS_PER_COUNTRY` / `TEAMS_PER_DIV`. A club's global id is
  `country*CLUBS_PER_COUNTRY + local index`; `c.div` is its tier.
- **Calendar:** `divRounds(ids, legs)` builds a round-robin by the circle method;
  `buildSchedule(clubs, legs)` merges every league into shared matchdays; `buildCalendar(G)`
  interleaves DEDICATED cup / continental / international matchdays between the league rounds
  using `SEASON_SPECIALS` (authored for a 38-round campaign, re-anchored by `scaleSpecials`).
- **Match engine:** `simMatch` is xG/Poisson-based; `applyMatch` writes the table, player stats,
  ratings and substitutions. `simRound(G)` plays one matchday; `startNextSeason(G)` is a
  deliberate, separate rollover step (promotion/relegation, finances, ageing, fixtures).

## Competition rules, difficulty & flavour (2026-08 batch)
These mirror the same batch in `~/baseball-gm`, but every rule is written for FOOTBALL rather
than translated knob-for-knob from the other sport.

- **Rules (`G.rules`, `RULES_DEFAULT`, `rules(G)`):** read through `rules(G)` so a save that
  predates a knob still sees a complete object. `setRule(G,k,v)` routes **structural** knobs
  (`STRUCTURAL_RULES`: `legs`, `promoReleg`, `promoPlayoff`) into `G.pendingRules`;
  `applyPendingRules(G)` promotes them at the top of `startNextSeason` **before** the calendar is
  rebuilt. `ruleValue(G,k)` reads staged-then-live (what the UI shows). Edited from **📋 Rules**
  in the header (`LeagueRulesModal`; tabs Match / League / Money / Difficulty), with the common
  ones also offered on `Splash`.
  - **`legs` (2 or 1)** — the football-native "season length". 2 = full double round-robin (38
    games); 1 = single round-robin (19). `scaleSpecials` re-anchors every cup/continental round
    proportionally and nudges collisions apart, so a short season still gives each competition
    its own week instead of stranding the finals past the end of the calendar.
  - **`pointsForWin` (3 or 2)** — applied to the DOMESTIC league table only (`applyMatch` and
    `liveFinish`). Continental group stages and international qualifying stay at 3, which is what
    the two-point era actually looked like.
  - **`promoReleg` (2/3/4)** and **`promoPlayoff`** — how many clubs move at each tier boundary,
    and whether the last promotion place is automatic or decided by `playPromoPlayoff` (whose
    seeds now follow the automatic-places count rather than being hardcoded to 3rd–6th).
  - **`subs` (3 or 5)** — the allowance in `credit()`, +2 more in extra time. Subs beyond the
    normal allowance only appear in ET minutes.
  - **`var`** — a small symmetric share of goals is chalked off in `simMatch` (`box.varOff`), so
    the league's goal environment drops slightly without tilting results either way.
  - **`windows`** — transfer windows on/off. When on, `transferWindowOpen` anchors the January
    window proportionally (`0.41`–`0.48` of the calendar) so it still lands mid-season in a
    one-leg campaign; the AI free-agent sweep and `deadlineDay` use the same anchors.
  - **`ffp` / `wageCeilPct`** — `wageCeiling`, `ffpCheck` (a HARD ceiling blocks a signing in
    `buyPlayer`) and `ffpSettle` (a SOFT ceiling is fined at the rollover).
- **Difficulty (`G.difficulty`, `DIFFICULTIES`, `diff(G)`):** Casual / Normal / Cutthroat scale
  the user's annual budget, transfer asking prices (`rivalBid` inflates `feeFor`), injury
  frequency, and how sharply the board reacts to a bad verdict (`boardPatience` divides a
  negative confidence swing and multiplies a positive one). Pressure on the manager only — the
  AI never gets better information.
- **Squad shuffle (`shuffleSquads`):** football has no draft, so the honest translation of
  "blow up the established order" is a one-off redistribution — every senior player is pooled and
  dealt back out at random, keepers first (two per club where supply allows) then the rest
  round-robin so squad sizes stay level. Academy players and active loans stay put. Opt-in on
  `Splash`.
- **Personalities (`PERSONALITIES`, `personalityOf(p)`):** talisman / maverick / model pro /
  hothead / joker / workhorse, derived deterministically from the player id so old saves get one
  without reshuffling anyone. Pure flavour — never touches ratings or the engine — shown on the
  player card and scaling how hard a press conference moves that player.
- **Press conferences (`PRESSERS`, `pickPresser`, `answerPresser`):** the most natural fit of the
  batch. Fires in `simRound` off `club.form5` (a rolling **"W"/"D"/"L"** list, newest last) — a
  3-game losing run, a 4-game unbeaten run, **derby week** (a fixture against `c.rivalId` this
  matchday), or an unsettled star. One question, three answers, each a real trade-off between
  dressing-room morale, `G.fanConfidence` and `G.boardConfidence`. Cooldown `PRESSER_COOLDOWN`
  matchdays; toggle under Rules → Match.
- **Navigation:** `navGroups(G)` splits the old flat 19–21-tab strip into four sections
  (Club / Competitions / Market / History) plus Offseason when it applies; `groupOf(tab)` keeps
  the section row in sync when something else navigates. `CommandPalette` (⌘K / Ctrl-K / `?`) is a
  fuzzy jump-to whose key handler ignores events from inputs.

## Gotchas
- **The service worker caches the bundle.** `sw.js` is network-first but a plain reload can still
  hand you a STALE `index.html` — you'll edit the file, reload, and see nothing change. When
  verifying in a browser, load `index.html?v=N` with a fresh N, or unregister the SW and clear
  caches. The headless harness reads the file directly and is unaffected.
- `applyMatch` takes `G` via `opts.G` (`const G = opts.G`), which can be undefined for some
  callers — `rules(undefined)` deliberately returns defaults so that's safe.
- `startNextSeason` is NOT part of `simRound`; the rollover only happens when the user (or a
  test) calls it.

## `tools/simtest.js`
Headless harness: extracts the `app-src` block, transpiles it with the vendored Babel, runs it in
a Node `vm` with minimal shims, and publishes the functions listed in `EXPORTS` (top-level
`const` doesn't become a vm global, hence the explicit epilogue). Checks run full simulated
seasons over the 640-club world: fixture counts and calendar integrity for both `legs` shapes,
W/L and goal reconciliation, the points system, the promotion ladder at every setting, VAR and
substitutions, transfer windows, rule staging, save serializability, personalities/pressers, and
the squad shuffle.

```bash
node tools/simtest.js          # all checks
node tools/simtest.js ladder   # one check
```

Add a case to `CHECKS` (and any new function to `EXPORTS`) when you add a rule.
