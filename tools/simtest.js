#!/usr/bin/env node
/*
 * Headless sim harness for Pocket GM — Soccer.
 *
 * The whole game is one <script type="text/babel-src"> block inside index.html.
 * This pulls that block out, transpiles it with the vendored Babel, and runs it in
 * a Node vm context with just enough browser shim (localStorage / IndexedDB /
 * document / React) that the module-level code can execute. The UI components are
 * never rendered — we only reach in and call the simulation functions.
 *
 * Usage:
 *   node tools/simtest.js            # run every check
 *   node tools/simtest.js season     # just the full-season invariants
 *
 * Add a case to CHECKS to cover a new rule.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

// Everything the checks below need to reach inside the app bundle. Top-level
// `const`/`let` don't become vm globals, so these are published via an epilogue.
const EXPORTS = [
  "newGame", "migrate", "simRound", "buildCalendar", "buildSchedule", "divRounds", "scaleSpecials",
  "rules", "setRule", "ruleValue", "applyPendingRules", "RULES_DEFAULT", "STRUCTURAL_RULES",
  "DIFFICULTIES", "diff", "tableFor", "leaguePos", "transferWindowOpen",
  "COUNTRIES", "NUM_DIVS", "personalityOf", "PERSONALITIES", "answerPresser", "pickPresser",
  "shuffleSquads", "wageBill", "startNextSeason",
];

/* ------------------------------- load the app ---------------------------- */
function loadGame() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const m = html.match(/<script type="text\/babel-src" id="app-src">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("couldn't find the app-src block in index.html");

  const babelSandbox = { window: {}, self: {}, console, process, setTimeout, clearTimeout };
  babelSandbox.global = babelSandbox;
  vm.createContext(babelSandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "vendor/babel.min.js"), "utf8"), babelSandbox);
  const Babel = babelSandbox.Babel || babelSandbox.window.Babel;
  if (!Babel) throw new Error("vendored Babel didn't expose a Babel global");

  let code = Babel.transform(m[1], { presets: [["react", { runtime: "classic" }]] }).code;
  code += `\n;globalThis.__APP__ = {${EXPORTS.map(n => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(", ")}};`;

  const noop = () => {};
  const store = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Math, Date, JSON,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      key: i => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    },
    indexedDB: undefined,
    document: { getElementById: () => ({}), addEventListener: noop, removeEventListener: noop, visibilityState: "visible" },
    navigator: { userAgent: "node" },
    React: {
      createElement: (...a) => ({ _el: a }),
      useState: v => [typeof v === "function" ? v() : v, noop],
      useEffect: noop, useRef: v => ({ current: v }), useMemo: (f) => f(),
      useCallback: f => f, useContext: () => noop,
      createContext: () => ({ Provider: noop, Consumer: noop }),
      Fragment: "fragment",
    },
    ReactDOM: { createRoot: () => ({ render: noop }) },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "app-src.js" });
  const A = sandbox.__APP__;
  const missing = EXPORTS.filter(n => A[n] === undefined);
  if (missing.length) console.log(`  \x1b[33m! not exported: ${missing.join(", ")}\x1b[0m`);
  return A;
}

/* --------------------------------- helpers ------------------------------- */
let failures = 0;
let checksRun = 0;
function ok(cond, label, detail) {
  checksRun++;
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `\n      ${detail}` : ""}`); }
}
function section(name) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

// Play a campaign from matchday 1 to the end of the regular season.
function simSeason(A, G) {
  let guard = 0;
  while (G.phase === "regular" && G.day < G.schedule.length && guard++ < 200) A.simRound(G);
  return G;
}
const divClubs = (G, ci, d) => G.clubs.filter(c => c.div === d && (c.country || 0) === ci);
const seniorsOf = (G, clubId) => Object.values(G.players).filter(p => p.teamId === clubId && !p.youth);

/* --------------------------------- checks -------------------------------- */
const CHECKS = {
  // A double round-robin is 38 fixtures; one leg is 19. The calendar must also keep
  // every cup and continental round on its own matchday in BOTH shapes.
  fixtures(A) {
    section("Fixture-count rule (legs)");
    [[2, 38], [1, 19]].forEach(([legs, want]) => {
      const G = A.newGame(0, { seed: 3, rules: { legs } });
      const club = G.clubs[0];
      let n = 0;
      G.schedule.forEach(rd => rd.forEach(g => { if (g.home === club.id || g.away === club.id) n++; }));
      ok(n === want, `legs=${legs} → ${want} league fixtures per club (got ${n})`);
      const cupRounds = Object.values(G.cupMD || {});
      const contRounds = Object.values(G.contMD || {});
      ok(cupRounds.includes("Final"), `legs=${legs} → cup final has a matchday`);
      ok(contRounds.includes("Final"), `legs=${legs} → continental final has a matchday`);
      const mds = Object.keys(G.cupMD || {}).concat(Object.keys(G.contMD || {}));
      ok(new Set(mds).size === mds.length, `legs=${legs} → no two competitions share a matchday`);
    });
  },

  // A full season: every club plays its whole slate and the table adds up.
  season(A) {
    section("Full-season invariants (one-leg campaign)");
    const G = A.newGame(0, { seed: 9, rules: { legs: 1 } });
    simSeason(A, G);
    const bad = G.clubs.filter(c => c.pld !== 19);
    ok(bad.length === 0, `every club played all 19 (worst: ${Math.min(...G.clubs.map(c => c.pld))})`,
      bad.length ? `${bad.length} clubs short` : "");
    const d0 = divClubs(G, 0, 0);
    const w = d0.reduce((s, c) => s + c.w, 0), l = d0.reduce((s, c) => s + c.l, 0);
    ok(w === l, `division wins === losses (${w}/${l})`);
    const gf = d0.reduce((s, c) => s + c.gf, 0), ga = d0.reduce((s, c) => s + c.ga, 0);
    ok(gf === ga, `goals for === goals against (${gf}/${ga})`);
    ok(d0.every(c => c.pts === c.w * 3 + c.d), "points reconcile with W/D at 3 points a win");
  },

  // Two points for a win must actually change the table arithmetic.
  points(A) {
    section("Points-for-a-win rule");
    const G = A.newGame(0, { seed: 4, rules: { legs: 1, pointsForWin: 2 } });
    simSeason(A, G);
    const d0 = divClubs(G, 0, 0);
    ok(d0.every(c => c.pts === c.w * 2 + c.d), "every club's points = 2×W + D");
    ok(d0.some(c => c.w > 0), "clubs actually won matches (the check isn't vacuous)");
  },

  // The ladder: how many go up and down each season.
  ladder(A) {
    section("Promotion & relegation rule");
    [2, 3, 4].forEach(n => {
      const G = A.newGame(0, { seed: 12, rules: { legs: 1, promoReleg: n } });
      const before = new Map(G.clubs.map(c => [c.id, c.div]));
      simSeason(A, G);
      A.startNextSeason(G);          // the rollover is a deliberate step, not part of simRound
      const down = G.clubs.filter(c => c.div === before.get(c.id) + 1).length;
      const up = G.clubs.filter(c => c.div === before.get(c.id) - 1).length;
      const want = n * A.COUNTRIES.length * (A.NUM_DIVS - 1);
      ok(down === want, `promoReleg=${n} → ${want} relegated (got ${down})`);
      ok(up === want, `promoReleg=${n} → ${want} promoted (got ${up})`);
    });
  },

  // Substitutions and VAR must move the numbers they claim to.
  matchRules(A) {
    section("Match-day rules (subs, VAR)");
    const goalsIn = r => {
      const G = A.newGame(0, { seed: 21, rules: Object.assign({ legs: 1 }, r) });
      simSeason(A, G);
      return divClubs(G, 0, 0).reduce((s, c) => s + c.gf, 0);
    };
    const off = goalsIn({ var: false }), on = goalsIn({ var: true });
    ok(on < off, `VAR chalks goals off (${on} < ${off})`);

    const benchUsed = G => {
      const club = G.clubs[0];
      return seniorsOf(G, club.id).filter(p => p.stats && p.stats.App > 0 && (p.stats.App - (p.stats.Start || 0)) > 0).length;
    };
    const g3 = A.newGame(0, { seed: 31, rules: { legs: 1, subs: 3 } }); simSeason(A, g3);
    const g5 = A.newGame(0, { seed: 31, rules: { legs: 1, subs: 5 } }); simSeason(A, g5);
    ok(benchUsed(g5) >= benchUsed(g3),
      `five subs spreads minutes at least as wide (${benchUsed(g5)} vs ${benchUsed(g3)} used off the bench)`);
  },

  // Transfer windows: off means always open; on means genuinely shut mid-season.
  windows(A) {
    section("Transfer-window rule");
    const G = A.newGame(0, { seed: 5, rules: { legs: 1, windows: true } });
    let everShut = false, everOpen = false, guard = 0;
    while (G.phase === "regular" && guard++ < 60) {
      if (A.transferWindowOpen(G)) everOpen = true; else everShut = true;
      A.simRound(G);
    }
    ok(everOpen && everShut, "windows on → the market opens and closes during the season");
    const G2 = A.newGame(0, { seed: 5, rules: { legs: 1, windows: false } });
    let alwaysOpen = true, g2 = 0;
    while (G2.phase === "regular" && g2++ < 60) { if (!A.transferWindowOpen(G2)) alwaysOpen = false; A.simRound(G2); }
    ok(alwaysOpen, "windows off → the market never closes");
  },

  // Structural rules must stage until the rollover; match rules apply at once.
  staging(A) {
    section("Structural rules stage until the rollover");
    const G = A.newGame(0, { seed: 8 });
    A.setRule(G, "legs", 1);
    ok(A.rules(G).legs === 2, "live rule unchanged mid-season");
    ok(G.pendingRules && G.pendingRules.legs === 1, "change is staged");
    ok(A.ruleValue(G, "legs") === 1, "UI reads the staged value");
    A.applyPendingRules(G);
    ok(A.rules(G).legs === 1, "applied at the rollover");
    ok(!G.pendingRules, "staging cleared");
    const G2 = A.newGame(0, { seed: 8 });
    A.setRule(G2, "subs", 5);
    ok(A.rules(G2).subs === 5, "match-day rule applies immediately");
  },

  // The save is JSON — anything the sim hangs on a club or player must survive it.
  serializable(A) {
    section("Save stays JSON-serializable");
    const G = A.newGame(0, { seed: 14, rules: { legs: 1, var: true, subs: 5 } });
    simSeason(A, G);
    let json = null, err = null;
    try { json = JSON.stringify(G); } catch (e) { err = e.message; }
    ok(json != null, "save serializes after a full season", err);
    if (json) ok(JSON.parse(json).clubs.length === G.clubs.length, `round-trips (${(json.length / 1024 / 1024).toFixed(1)}MB)`);
  },

  // Personalities + press conferences.
  flavor(A) {
    section("Personalities + press conferences");
    const G = A.newGame(0, { seed: 6, rules: { legs: 1 } });
    const p = Object.values(G.players)[0];
    const lab = A.personalityOf(p).label;
    ok(!!lab && A.personalityOf(p).label === lab, `personality is stable (${lab})`);
    const spread = new Set(Object.values(G.players).slice(0, 400).map(x => A.personalityOf(x).label));
    ok(spread.size >= 4, `personalities vary (${spread.size} distinct)`);

    let asked = 0, guard = 0;
    while (G.phase === "regular" && guard++ < 60) {
      A.simRound(G);
      if (G.presser) { asked++; A.answerPresser(G, 0); ok(G.presser == null, `  presser ${asked} cleared`); if (asked > 2) break; }
    }
    ok(asked > 0, `press conferences fired (${asked})`);
    ok(G.fanConfidence >= 0 && G.fanConfidence <= 100, `fan confidence stayed in range (${G.fanConfidence})`);
  },

  // Squad shuffle: the football-native "shake up the established order" mode.
  shuffle(A) {
    section("Squad shuffle");
    const G = A.newGame(0, { seed: 17, rules: { legs: 1 } });
    const seniors = Object.values(G.players).filter(p => p.teamId != null && !p.youth);
    const before = seniors.length;
    const beforeClub = new Map(seniors.map(p => [p.id, p.teamId]));
    A.shuffleSquads(G);
    const after = Object.values(G.players).filter(p => p.teamId != null && !p.youth).length;
    ok(after === before, `no senior player lost (${after} vs ${before})`);
    const moved = Object.values(G.players).filter(p => p.teamId != null && !p.youth && beforeClub.get(p.id) !== p.teamId).length;
    ok(moved > before * 0.5, `most players actually moved (${moved} of ${before})`);
    const thin = G.clubs.filter(c => seniorsOf(G, c.id).length < 11);
    ok(thin.length === 0, "every club can still field an XI", thin.length ? `${thin.length} clubs under 11` : "");
    const keepers = G.clubs.filter(c => !seniorsOf(G, c.id).some(p => p.pos === "GK"));
    ok(keepers.length === 0, "every club still has a goalkeeper", keepers.length ? `${keepers.length} without` : "");
    simSeason(A, G);
    ok(G.clubs[0].pld === 19, "the shuffled world plays a full season");
  },
};

/* ---------------------------------- main --------------------------------- */
const want = process.argv[2];
const app = loadGame();
console.log(`Pocket GM — Soccer · headless checks${want ? ` (${want})` : ""}`);
const names = want ? [want] : Object.keys(CHECKS);
for (const n of names) {
  if (!CHECKS[n]) { console.error(`unknown check "${n}" — have: ${Object.keys(CHECKS).join(", ")}`); process.exit(2); }
  CHECKS[n](app);
}
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checksRun - failures}/${checksRun} passed\x1b[0m`);
process.exit(failures ? 1 : 0);
