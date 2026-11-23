// fitted-1's fitting engine: everything the value curve and the token odds claim is
// fitted here, at run time, from the snapshot's own protocols. No coefficient is
// written in advance. A candidate term is kept only when it passes two tests at once:
//
//   1. it lowers the held-out miss in BOTH the leave-one-out test and the walk-forward
//      test (older protocols price newer ones), and
//   2. its bootstrap coefficient is identified: |coefficient| / standard error >= 1,
//      over 200 refits on resamples drawn by a fixed-seed generator.
//
// The same rule, with the same order of candidate terms, runs in the dashboard's
// app.js, so the page refits the model in the browser and checks the board's numbers.
//
// Determinism: fixed iteration orders, sorted inputs, a seeded generator. Nothing
// here reads the clock, the environment or the network, so two runs write the same
// bytes.

/** A small dense linear solve by Gaussian elimination with partial pivoting. */
export function solveLinear(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const aug = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = r;
    }
    const tmp = aug[col]!;
    aug[col] = aug[pivot]!;
    aug[pivot] = tmp;
    const div = aug[col]![col]!;
    const safe = div === 0 ? 1e-12 : div;
    for (let j = col; j <= n; j++) aug[col]![j] = aug[col]![j]! / safe;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r]![col]!;
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) aug[r]![j] = aug[r]![j]! - factor * aug[col]![j]!;
    }
  }
  return aug.map((row) => row[n]!);
}

/** Ordinary least squares through the normal equations. */
export function ols(design: number[][], target: number[]): number[] {
  const k = design[0]!.length;
  const normal: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rhs = new Array<number>(k).fill(0);
  for (let r = 0; r < design.length; r++) {
    const row = design[r]!;
    for (let i = 0; i < k; i++) {
      rhs[i] = rhs[i]! + row[i]! * target[r]!;
      for (let j = 0; j < k; j++) normal[i]![j] = normal[i]![j]! + row[i]! * row[j]!;
    }
  }
  return solveLinear(normal, rhs);
}

/** A seeded generator (mulberry32): the bootstrap's only source of randomness. */
export function seededGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The q-th quantile of values already sorted ascending. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** The median of an array (a copy is sorted; the input is untouched). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

// ------------------------------------------------------------------ features

/** Seven-day TVL change as a model feature: clamped, in units of 100%. */
export function growthFeature(change7d: number | null): number {
  const g = change7d === null || !Number.isFinite(change7d) ? 0 : change7d;
  return Math.max(-60, Math.min(100, g)) / 100;
}

/** Age in years, log-scaled; an unlisted age reads as one year. */
export function ageFeature(ageDays: number | null): number {
  const days = ageDays === null ? 365 : Math.max(0, ageDays);
  return Math.log1p(days / 365);
}

/** Chain reach, log-scaled. */
export function chainsFeature(chainCount: number): number {
  return Math.log(Math.max(1, chainCount));
}

/** The value curve's candidate terms, in the order they are tested. */
export const VALUE_CANDIDATES = ['size', 'chains', 'growth', 'age'] as const;
export type ValueTerm = (typeof VALUE_CANDIDATES)[number];

/** One row of the value fit: the log of TVL, the log of the market cap, and the features. */
export interface ValueComp {
  logTvl: number;
  logMcap: number;
  chains: number;
  growth: number;
  age: number;
  listedAt: string;
  slug: string;
}

export function valueRow(terms: readonly ValueTerm[], comp: ValueComp): number[] {
  const row = [1];
  if (terms.includes('size')) row.push(comp.logTvl);
  if (terms.includes('chains')) row.push(comp.chains);
  if (terms.includes('growth')) row.push(comp.growth);
  if (terms.includes('age')) row.push(comp.age);
  return row;
}

function valuePredict(coef: number[], terms: readonly ValueTerm[], comp: ValueComp): number {
  const row = valueRow(terms, comp);
  let sum = 0;
  for (let i = 0; i < coef.length; i++) sum += coef[i]! * row[i]!;
  return sum;
}

/** The median absolute multiple error: exp(median |log(pred/actual)|). */
function multipleMiss(predicted: number[], actualLog: number[]): number {
  const errs = predicted.map((p, i) => Math.abs(p - actualLog[i]!)).sort((a, b) => a - b);
  return Math.exp(quantile(errs, 0.5));
}

export interface ValueFit {
  terms: ValueTerm[];
  coef: number[];
  se: number[];
  compCount: number;
  flatMultiple: number;
  flatLooMiss: number;
  flatWfMiss: number;
  looMiss: number;
  wfMiss: number;
  /** Leave-one-out log residuals, in comp order: the range bands are cut from these. */
  looResiduals: number[];
  band2575: [number, number];
  band1090: [number, number];
  cover2575: number;
  cover1090: number;
  /** One row per candidate term: what the two tests said, and whether it survived. */
  trials: { term: ValueTerm; looMiss: number; wfMiss: number; tStat: number; kept: boolean }[];
}

/**
 * Fit the value curve with term selection. `comps` must already be the comparison set
 * (token recorded, usable cap, dated, no wrapper category), in slug order; the
 * walk-forward split sorts a copy by listing date, so the input order never matters.
 */
export function fitValueCurve(comps: ValueComp[]): ValueFit {
  const flatMultiple = Math.exp(median(comps.map((c) => c.logMcap - c.logTvl)));
  const flatPred = comps.map((c) => c.logTvl + Math.log(flatMultiple));
  const actual = comps.map((c) => c.logMcap);
  const byDate = [...comps].sort((a, b) =>
    a.listedAt < b.listedAt ? -1 : a.listedAt > b.listedAt ? 1 : a.slug < b.slug ? -1 : 1,
  );
  const half = Math.floor(byDate.length / 2);
  const wfTrain = byDate.slice(0, half);
  const wfTest = byDate.slice(half);

  const fitOn = (train: ValueComp[], terms: readonly ValueTerm[]): number[] =>
    ols(
      train.map((c) => valueRow(terms, c)),
      train.map((c) => c.logMcap),
    );
  const looMiss = (terms: readonly ValueTerm[]): { miss: number; residuals: number[] } => {
    const residuals: number[] = [];
    for (let i = 0; i < comps.length; i++) {
      const train = [...comps.slice(0, i), ...comps.slice(i + 1)];
      const coef = fitOn(train, terms);
      residuals.push(comps[i]!.logMcap - valuePredict(coef, terms, comps[i]!));
    }
    return { miss: Math.exp(quantile(residuals.map(Math.abs).sort((a, b) => a - b), 0.5)), residuals };
  };
  const wfMiss = (terms: readonly ValueTerm[]): number => {
    const coef = fitOn(wfTrain, terms);
    return multipleMiss(
      wfTest.map((c) => valuePredict(coef, terms, c)),
      wfTest.map((c) => c.logMcap),
    );
  };
  const flatLoo = multipleMiss(flatPred, actual);
  const flatWf = multipleMiss(
    wfTest.map((c) => c.logTvl + Math.log(flatMultiple)),
    wfTest.map((c) => c.logMcap),
  );

  const trials: ValueFit['trials'] = [];
  let terms: ValueTerm[] = [];
  let baseLoo = flatLoo;
  let baseWf = flatWf;
  for (const term of VALUE_CANDIDATES) {
    const candidate = [...terms, term] as ValueTerm[];
    const { miss: candLoo } = looMiss(candidate);
    const candWf = wfMiss(candidate);
    // Bootstrap identification of the new term: 200 refits, fixed seed.
    const coef = fitOn(comps, candidate);
    const draws: number[][] = [];
    const rand = seededGenerator(20261114);
    for (let b = 0; b < 200; b++) {
      const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rand() * comps.length)]!);
      draws.push(fitOn(sample, candidate));
    }
    const idx = 1 + candidate.filter((t) => VALUE_CANDIDATES.indexOf(t) < VALUE_CANDIDATES.indexOf(term)).length;
    const mean = draws.reduce((s, d) => s + d[idx]!, 0) / draws.length;
    const variance = draws.reduce((s, d) => s + (d[idx]! - mean) ** 2, 0) / draws.length;
    const se = Math.sqrt(variance);
    const tStat = se === 0 ? 0 : Math.abs(coef[idx]!) / se;
    const kept = candLoo < baseLoo && candWf < baseWf && tStat >= 1;
    trials.push({ term, looMiss: candLoo, wfMiss: candWf, tStat, kept });
    if (kept) {
      terms = candidate;
      baseLoo = candLoo;
      baseWf = candWf;
    }
  }

  const finalCoef = fitOn(comps, terms);
  const draws: number[][] = [];
  const rand = seededGenerator(20261114);
  for (let b = 0; b < 200; b++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rand() * comps.length)]!);
    draws.push(fitOn(sample, terms));
  }
  const se = finalCoef.map((_, j) => {
    const mean = draws.reduce((s, d) => s + d[j]!, 0) / draws.length;
    return Math.sqrt(draws.reduce((s, d) => s + (d[j]! - mean) ** 2, 0) / draws.length);
  });
  const { miss: finalLoo, residuals } = looMiss(terms);
  const finalWf = wfMiss(terms);
  const sortedRes = [...residuals].sort((a, b) => a - b);
  const band2575: [number, number] = [Math.exp(quantile(sortedRes, 0.25)), Math.exp(quantile(sortedRes, 0.75))];
  const band1090: [number, number] = [Math.exp(quantile(sortedRes, 0.1)), Math.exp(quantile(sortedRes, 0.9))];
  const cover = (lo: number, hi: number): number => {
    let inside = 0;
    for (const r of residuals) if (r >= Math.log(lo) && r <= Math.log(hi)) inside++;
    return residuals.length === 0 ? 0 : inside / residuals.length;
  };
  return {
    terms,
    coef: finalCoef,
    se,
    compCount: comps.length,
    flatMultiple,
    flatLooMiss: flatLoo,
    flatWfMiss: flatWf,
    looMiss: finalLoo,
    wfMiss: finalWf,
    looResiduals: residuals,
    band2575,
    band1090,
    cover2575: cover(band2575[0], band2575[1]),
    cover1090: cover(band1090[0], band1090[1]),
    trials,
  };
}

/** The fitted launch value of a protocol with this TVL and growth, before odds. */
export function launchValue(fit: ValueFit, logTvl: number, growth: number, chains: number, age: number): number {
  const comp: ValueComp = { logTvl, logMcap: 0, chains, growth, age, listedAt: '', slug: '' };
  const row = valueRow(fit.terms, comp);
  let sum = 0;
  for (let i = 0; i < fit.coef.length; i++) sum += fit.coef[i]! * row[i]!;
  return Math.exp(sum);
}

// ------------------------------------------------------------------ the odds

/** The odds fit's candidate terms, in the order they are tested. */
export const ODDS_CANDIDATES = ['age', 'size', 'growth', 'chains'] as const;
export type OddsTerm = (typeof ODDS_CANDIDATES)[number];

/** One peer for the odds fit: the features and whether it records a token. */
export interface OddsPeer {
  age: number;
  logTvl: number;
  growth: number;
  chains: number;
  recordsToken: 0 | 1;
  listedAt: string | null;
  slug: string;
}

export function oddsRow(terms: readonly OddsTerm[], peer: OddsPeer): number[] {
  const row = [1];
  if (terms.includes('age')) row.push(peer.age);
  if (terms.includes('size')) row.push(peer.logTvl);
  if (terms.includes('growth')) row.push(peer.growth);
  if (terms.includes('chains')) row.push(peer.chains);
  return row;
}

function sigmoid(z: number): number {
  const c = Math.max(-30, Math.min(30, z));
  return 1 / (1 + Math.exp(-c));
}

/** Logistic regression by iteratively reweighted least squares, deterministic. */
export function logisticFit(design: number[][], target: number[]): number[] {
  const k = design[0]!.length;
  const base = target.reduce((s, y) => s + y, 0) / target.length;
  let beta = new Array<number>(k).fill(0);
  beta[0] = Math.log(Math.max(1e-6, base) / Math.max(1e-6, 1 - base));
  for (let iter = 0; iter < 25; iter++) {
    const scores = design.map((row) => {
      let s = 0;
      for (let i = 0; i < k; i++) s += beta[i]! * row[i]!;
      return s;
    });
    const probs = scores.map(sigmoid);
    const weights = probs.map((p) => Math.max(1e-6, p * (1 - p)));
    const normal: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const rhs = new Array<number>(k).fill(0);
    for (let r = 0; r < design.length; r++) {
      const row = design[r]!;
      const adjusted = scores[r]! + (target[r]! - probs[r]!) / weights[r]!;
      for (let i = 0; i < k; i++) {
        rhs[i] = rhs[i]! + weights[r]! * row[i]! * adjusted;
        for (let j = 0; j < k; j++) normal[i]![j] = normal[i]![j]! + weights[r]! * row[i]! * row[j]!;
      }
    }
    for (let i = 0; i < k; i++) normal[i]![i] = normal[i]![i]! + 1e-6;
    const next = solveLinear(normal, rhs);
    const shift = Math.max(...next.map((v, i) => Math.abs(v - beta[i]!)));
    beta = next;
    if (shift < 1e-8) break;
  }
  return beta;
}

function brierScore(beta: number[], terms: readonly OddsTerm[], peers: OddsPeer[]): number {
  let total = 0;
  for (const peer of peers) {
    const row = oddsRow(terms, peer);
    let z = 0;
    for (let i = 0; i < beta.length; i++) z += beta[i]! * row[i]!;
    const diff = peer.recordsToken - sigmoid(z);
    total += diff * diff;
  }
  return peers.length === 0 ? 0 : total / peers.length;
}

export interface OddsFit {
  terms: OddsTerm[];
  coef: number[];
  se: number[];
  peerCount: number;
  baseRate: number;
  baseBrier: number;
  brierAll: number;
  brierCv: number;
  brierWf: number;
  trials: { term: OddsTerm; cvBrier: number; wfBrier: number; tStat: number; kept: boolean }[];
}

/**
 * Fit the token odds with term selection. `peers` must be every protocol in the
 * snapshot, in slug order; the ten folds and the walk-forward split are cut from
 * that order and from listing dates, so the input order never matters.
 */
export function fitOdds(peers: OddsPeer[]): OddsFit {
  const baseRate = peers.reduce((s, p) => s + p.recordsToken, 0) / peers.length;
  const baseBrier = peers.reduce((s, p) => s + (p.recordsToken - baseRate) ** 2, 0) / peers.length;
  const dated = peers
    .filter((p) => p.listedAt !== null)
    .sort((a, b) =>
      a.listedAt! < b.listedAt! ? -1 : a.listedAt! > b.listedAt! ? 1 : a.slug < b.slug ? -1 : 1,
    );
  const cut = Math.floor(dated.length * 0.6);
  const wfTrain = dated.slice(0, cut);
  const wfTest = dated.slice(cut);

  const fitOn = (rows: OddsPeer[], terms: readonly OddsTerm[]): number[] =>
    logisticFit(
      rows.map((p) => oddsRow(terms, p)),
      rows.map((p) => p.recordsToken),
    );
  const cvBrier = (terms: readonly OddsTerm[]): number => {
    let total = 0;
    let count = 0;
    for (let fold = 0; fold < 10; fold++) {
      const test = peers.filter((_, i) => i % 10 === fold);
      const train = peers.filter((_, i) => i % 10 !== fold);
      const beta = fitOn(train, terms);
      total += brierScore(beta, terms, test) * test.length;
      count += test.length;
    }
    return count === 0 ? 0 : total / count;
  };
  const wfBrier = (terms: readonly OddsTerm[]): number => brierScore(fitOn(wfTrain, terms), terms, wfTest);

  const trials: OddsFit['trials'] = [];
  let terms: OddsTerm[] = [];
  let baseCv = baseBrier;
  const wfBaseRate = wfTrain.reduce((s, p) => s + p.recordsToken, 0) / wfTrain.length;
  let baseWf = wfTest.reduce((s, p) => s + (p.recordsToken - wfBaseRate) ** 2, 0) / wfTest.length;
  for (const term of ODDS_CANDIDATES) {
    const candidate = [...terms, term] as OddsTerm[];
    const candCv = cvBrier(candidate);
    const candWf = wfBrier(candidate);
    const coef = fitOn(peers, candidate);
    const draws: number[][] = [];
    const rand = seededGenerator(20261114);
    for (let b = 0; b < 100; b++) {
      const sample = Array.from({ length: peers.length }, () => peers[Math.floor(rand() * peers.length)]!);
      draws.push(fitOn(sample, candidate));
    }
    const idx = 1 + candidate.filter((t) => ODDS_CANDIDATES.indexOf(t) < ODDS_CANDIDATES.indexOf(term)).length;
    const mean = draws.reduce((s, d) => s + d[idx]!, 0) / draws.length;
    const variance = draws.reduce((s, d) => s + (d[idx]! - mean) ** 2, 0) / draws.length;
    const se = Math.sqrt(variance);
    const tStat = se === 0 ? 0 : Math.abs(coef[idx]!) / se;
    const kept = candCv < baseCv && candWf < baseWf && tStat >= 1;
    trials.push({ term, cvBrier: candCv, wfBrier: candWf, tStat, kept });
    if (kept) {
      terms = candidate;
      baseCv = candCv;
      baseWf = candWf;
    }
  }

  const finalCoef = fitOn(peers, terms);
  const draws: number[][] = [];
  const rand = seededGenerator(20261114);
  for (let b = 0; b < 100; b++) {
    const sample = Array.from({ length: peers.length }, () => peers[Math.floor(rand() * peers.length)]!);
    draws.push(fitOn(sample, terms));
  }
  const se = finalCoef.map((_, j) => {
    const mean = draws.reduce((s, d) => s + d[j]!, 0) / draws.length;
    return Math.sqrt(draws.reduce((s, d) => s + (d[j]! - mean) ** 2, 0) / draws.length);
  });
  return {
    terms,
    coef: finalCoef,
    se,
    peerCount: peers.length,
    baseRate,
    baseBrier,
    brierAll: brierScore(finalCoef, terms, peers),
    brierCv: cvBrier(terms),
    brierWf: wfBrier(terms),
    trials,
  };
}

/** A protocol's token odds under the fitted model: the share of comparable peers that record a token. */
export function tokenOdds(fit: OddsFit, peer: OddsPeer): number {
  const row = oddsRow(fit.terms, peer);
  let z = 0;
  for (let i = 0; i < fit.coef.length; i++) z += fit.coef[i]! * row[i]!;
  return sigmoid(z);
}
