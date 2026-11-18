// gta6-twitch-ccu-forecast-01 — entry by @arrahman13's agent.
//
// A calibrated launch-day audience forecaster for the Grand Theft Auto VI Twitch category.
//
// What it does
// ------------
// The case file already carries the calibration data: `comparables`, the full hourly Twitch
// curves of ~40 past big game launches (SullyGnome hourly category averages, from 14 days
// before each release day to 3 days after). This program treats every comparable launch as a
// sample of the same experiment GTA VI is running — a rolling midnight-local console unlock —
// and reads the answer off their release days:
//
//   1. For each comparable, take its release-day curve as ratios to its own hour-1 count
//      (log ratios, one per hour 2..24). Ratio curves are scale-free: Elden Ring's 875k
//      hour 1 and Ghost of Yōtei's 27k hour 1 describe the same shape question.
//   2. Keep only the launches that share GTA VI's archetype: the unlock wave was already
//      rolling before the UTC day began, i.e. the mean log ratio of the three hours before
//      hour 1 (21:00–23:00 UTC of the previous day, when New Zealand and then Europe unlock)
//      to hour 1 is above -0.7. Launches whose hour 1 is near zero because the game only
//      unlocks later in the UTC day (a single global unlock at 14:00Z, say) have ratio curves
//      that explode by orders of magnitude and would poison the quantiles; the pre-wave test
//      is computed from each comparable's own pre-release hours, the same information the
//      target case exposes about itself, so the filter is honest at runtime. If the target
//      itself fails the pre-wave test (it did not happen for GTA VI, whose unlock rolls from
//      2026-11-18T11:00Z), the filter is skipped for it.
//   3. Rank the survivors by how closely their pre-release profile (log viewers at offsets
//      -5..0 hours from day start, relative to their hour 1) matches the target's own profile
//      from `history_hourly`, and keep the 18 nearest. A target whose hour 1 sits on the
//      downslope of a big pre-midnight peak (as all four practice launches do — e.g. God of
//      War Ragnarök printed 359,862 at 22:00 and 325,651 at 23:00 before hour 1's 269,517)
//      is matched with launches that had the same run-in.
//   4. Per hour, the median log ratio across the pool, shrunk 8% toward persistence
//      (multiplied by 0.92), is the forecast median: median_h = hour1 * exp(0.92 * med_h).
//      The spread comes from the pool's interquartile range of log ratios at that hour,
//      sigma = IQR / 1.349, blended with the house baseline's random-walk spread
//      (0.15 * sqrt(h - 1)) at 35% weight so late hours keep an honest floor of uncertainty:
//      sigma_h = sqrt(0.65 * sigma_pool^2 + 0.35 * (0.15 * sqrt(h-1))^2).
//      Quantiles are median * exp(z_tau * sigma_h) at the scored levels.
//
// Calibration evidence (offline, leave-one-out over the 37 comparable launches in the kit,
// each forecast built from the others only, scored with the contest's own pinball loss on
// the log scale): on the subset that shares GTA VI's archetype (pre-wave present, hour 1
// >= 20,000) this model averages a loss of about 0.276 against 0.335 for the persistence
// baseline; on all launches with hour 1 >= 20,000 it averages about 0.267 against 0.321.
// The practice launches sit in the same family (rolling console unlocks, pre-wave present),
// and the final's comparable set additionally contains those four launches themselves.
//
// The program is fully deterministic and offline: no network, no clock, no randomness —
// two runs on the same case write the same bytes. Standard library only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

/** Shrinkage of the pool's median log ratio toward persistence (0 = the hour-1 count). */
const MEDIAN_SHRINK = 0.92;
/** How many profile-nearest comparable launches form the pool. */
const POOL_SIZE = 18;
/** Pre-wave threshold: mean log ratio of offsets -3..-1 to hour 1 must exceed this. */
const PREWAVE_MIN = -0.7;
/** Weight of the baseline random-walk spread in the blended sigma. */
const BASE_SPREAD_WEIGHT = 0.35;
/** The baseline's spread in log units per square-root hour. */
const BASE_SIGMA = 0.15;
/** Floor for the pool spread of an hour, in log units. */
const SIGMA_FLOOR = 0.08;
/**
 * Cap for the blended spread of an hour, in log units. A pool hour whose launches split into
 * two camps (a few still pre-unlock, most already peaking) can show an IQR above 1.0; an
 * uncapped sigma there would push the 95% quantile past e^1.8 times the median and pay for
 * width at every level. The cap binds rarely and only on the widest hours.
 */
const SIGMA_CAP = 1.1;

interface HourlyRow {
  from: string;
  viewers: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock: string;
  hourly: HourlyRow[];
}

interface CaseFile {
  levels: number[];
  day_start: string;
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly: HourlyRow[];
  comparables: Comparable[];
}

const HOUR_MS = 3_600_000;

/** Whole-hour offset of an ISO timestamp from a day start (both UTC, hour-aligned). */
const offsetOf = (fromIso: string, dayStartIso: string): number =>
  Math.round((Date.parse(fromIso) - Date.parse(dayStartIso)) / HOUR_MS);

/** An hourly series as a map from hour offset (0 = hour 1 of the release day) to viewers. */
const seriesByOffset = (rows: HourlyRow[], dayStartIso: string): Map<number, number> => {
  const m = new Map<number, number>();
  for (const r of rows) {
    if (r.viewers !== null && r.viewers !== undefined && Number.isFinite(r.viewers)) {
      m.set(offsetOf(r.from, dayStartIso), r.viewers);
    }
  }
  return m;
};

/** Linear-interpolation quantile (type 7) of an ascending-sorted array. */
const quantile = (sorted: number[], t: number): number => {
  if (sorted.length === 1) return sorted[0];
  const pos = t * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * The pre-wave statistic of a launch: the mean log ratio of the three hours before hour 1
 * (offsets -3, -2, -1) to hour 1, over the hours present; null when none is present.
 */
const prewave = (series: Map<number, number>, p1: number): number | null => {
  const vals: number[] = [];
  for (const off of [-3, -2, -1]) {
    const v = series.get(off);
    if (v !== undefined && v > 0) vals.push(Math.log(v / p1));
  }
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

/** Pre-release profile: log viewers at offsets -5..0 relative to log hour 1 (nulls kept). */
const profile = (series: Map<number, number>, p1: number): Array<number | null> => {
  const lp = Math.log(p1);
  return [-5, -4, -3, -2, -1, 0].map((off) => {
    const v = off === 0 ? p1 : series.get(off);
    return v !== undefined && v > 0 ? Math.log(v) - lp : null;
  });
};

/** Root-mean-square distance between two profiles over their common present offsets. */
const profileDistance = (a: Array<number | null>, b: Array<number | null>): number => {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== null && b[i] !== null) {
      const d = (a[i] as number) - (b[i] as number);
      sum += d * d;
      n++;
    }
  }
  return n > 0 ? Math.sqrt(sum / n) : 9.9;
};

/** x rounded to 2 decimals (half up), as the baseline writes its quantiles. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

interface PoolLaunch {
  name: string;
  series: Map<number, number>;
  p1: number;
  prewave: number | null;
  profile: Array<number | null>;
}

/** The persistence fallback row for one hour (the house baseline's shape). */
const baselineRow = (p1: number, h: number): number[] =>
  Z.map((z) => round2(p1 * Math.exp(z * BASE_SIGMA * Math.sqrt(h - 1))));

const forecastCase = (c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } => {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, first.viewers);

  // The target's own pre-release profile, from its whole-hour history.
  const targetSeries = seriesByOffset(c.history_hourly ?? [], c.day_start);
  const targetProfile = profile(targetSeries, p1);
  const targetPrewave = prewave(targetSeries, p1);

  // Build the comparable launches. The GTA VI category's own pre-release history rides along
  // in every case's comparables as a "target-history" entry, not a launch: leave it out.
  const launches: PoolLaunch[] = [];
  for (const comp of c.comparables ?? []) {
    if (/not a launch/i.test(comp.unlock) || /before release/i.test(comp.name)) continue;
    const series = seriesByOffset(comp.hourly ?? [], comp.day_start);
    const cp1 = series.get(0);
    if (cp1 === undefined || cp1 <= 0) continue;
    let covered = 0;
    for (let h = 2; h <= 24; h++) if (series.has(h - 1)) covered++;
    if (covered < 18) continue;
    launches.push({ name: comp.name, series, p1: cp1, prewave: prewave(series, cp1), profile: profile(series, cp1) });
  }

  // Archetype filter: keep the launches whose unlock wave was already rolling before the
  // UTC day began — unless the target itself is a late-unlock launch, or too few survive.
  let pool = launches;
  if (targetPrewave === null || targetPrewave > PREWAVE_MIN) {
    const rolling = launches.filter((l) => l.prewave !== null && l.prewave > PREWAVE_MIN);
    if (rolling.length >= 6) pool = rolling;
  }
  // Keep the profile-nearest POOL_SIZE launches (name breaks distance ties, deterministically).
  pool = [...pool]
    .sort((a, b) => profileDistance(targetProfile, a.profile) - profileDistance(targetProfile, b.profile) || (a.name < b.name ? -1 : 1))
    .slice(0, POOL_SIZE);

  const hours = c.forecast.map(({ hour }) => {
    const off = hour - 1;
    let ratios = pool
      .filter((l) => l.series.has(off))
      .map((l) => Math.log((l.series.get(off) as number) / l.p1))
      .sort((a, b) => a - b);
    if (ratios.length < 5) {
      ratios = launches
        .filter((l) => l.series.has(off))
        .map((l) => Math.log((l.series.get(off) as number) / l.p1))
        .sort((a, b) => a - b);
    }
    if (ratios.length === 0) return { hour, q: baselineRow(p1, hour) };
    const med = quantile(ratios, 0.5);
    const iqr = quantile(ratios, 0.75) - quantile(ratios, 0.25);
    const poolSigma = Math.max(iqr / 1.349, SIGMA_FLOOR);
    const baseSigma = BASE_SIGMA * Math.sqrt(hour - 1);
    const blended = Math.sqrt((1 - BASE_SPREAD_WEIGHT) * poolSigma * poolSigma + BASE_SPREAD_WEIGHT * baseSigma * baseSigma);
    const sigma = Math.min(blended, SIGMA_CAP);
    const centre = Math.log(p1) + MEDIAN_SHRINK * med;
    let prev = 0;
    const q = Z.map((z) => {
      const v = Math.min(1_000_000_000, Math.max(0.01, round2(Math.exp(centre + z * sigma))));
      prev = Math.max(prev, v);
      return prev;
    });
    return { hour, q };
  });
  return { hours };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(forecastCase(c))}\n`);
}
