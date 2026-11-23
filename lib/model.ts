// fitted-1's board: one snapshot in, one ranked board out.
//
// The board ranks every pre-token protocol the snapshot's own rules leave rankable:
// the 40 on the watchlist plus the 174 pre-token protocols outside it. Protocols whose
// token already trades are never ranked; they are the comparison set the value curve
// is fitted on, or the peers the odds are fitted on, and the accounting ledger below
// puts every one of the snapshot's 758 protocols in exactly one group.
//
// A row's implied value is the fitted launch value times the token odds, both fitted
// at run time from the snapshot (see lib/fit.ts). Nothing about a row is decided by
// its name: the same functions score every protocol, and the version-marker and
// category rules below are the snapshot's own, applied to every name alike.

import {
  ageFeature,
  chainsFeature,
  fitOdds,
  fitValueCurve,
  growthFeature,
  launchValue,
  tokenOdds,
  type OddsFit,
  type OddsPeer,
  type ValueComp,
  type ValueFit,
} from './fit.ts';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to `asOf`; null when the listing date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Categories that are a product of a token that already trades: never ranked, never a comp. */
const PRODUCT_CATEGORIES = new Set([
  'bridge',
  'canonical bridge',
  'cross chain bridge',
  'liquid staking',
  'liquid restaking',
  'restaking',
  'staking pool',
  'restaked btc',
  'liquidity manager',
  'stablecoin wrapper',
  'cex',
]);

/** The narrower exclusion for the ranked board: exchanges, bridges and staking products. */
const BOARD_EXCLUDED = new Set([
  'bridge',
  'canonical bridge',
  'liquid staking',
  'liquid restaking',
  'restaked btc',
  'cex',
]);

/** A name ending in a release marker is a versioned pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether the board may rank a protocol: pre-token and not a product of a traded token. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !BOARD_EXCLUDED.has((p.category ?? '').toLowerCase());
}

/** Whether a protocol may price the value curve: a traded token with a usable cap and a date. */
function isComp(p: SnapshotProtocol): boolean {
  return (
    p.mcap_usd !== null &&
    p.mcap_usd > 0 &&
    p.tvl_usd > 0 &&
    p.listed_at !== null &&
    !PRODUCT_CATEGORIES.has((p.category ?? '').toLowerCase())
  );
}

/** The ledger: every protocol in exactly one group, summing to the snapshot's count. */
export interface Accounting {
  rankedWatchlist: number;
  rankedOfflist: number;
  compFit: number;
  tokenNotComp: number;
  tokenNoCap: number;
  leftOut: number;
  total: number;
}

export function accounting(snapshot: Snapshot, ranked: Set<string>, compSlugs: Set<string>): Accounting {
  const watchlist = new Set(snapshot.watchlist);
  let rankedWatchlist = 0;
  let rankedOfflist = 0;
  let compFit = 0;
  let tokenNotComp = 0;
  let tokenNoCap = 0;
  let leftOut = 0;
  for (const p of snapshot.protocols) {
    if (ranked.has(p.slug)) {
      if (watchlist.has(p.slug)) rankedWatchlist++;
      else rankedOfflist++;
    } else if (compSlugs.has(p.slug)) {
      compFit++;
    } else if (p.mcap_usd !== null) {
      tokenNotComp++;
    } else if (p.gecko_id !== null || p.symbol !== null) {
      tokenNoCap++;
    } else {
      leftOut++;
    }
  }
  const total = rankedWatchlist + rankedOfflist + compFit + tokenNotComp + tokenNoCap + leftOut;
  return { rankedWatchlist, rankedOfflist, compFit, tokenNotComp, tokenNoCap, leftOut, total };
}

// ------------------------------------------------------------------ farm plans

/** One farm step: when it happens, what to do, what it costs in dollars, how long it takes. */
export interface PlanStep {
  when: string;
  text: string;
  costUsd: number;
  minutes: number;
  recurringWeekly: boolean;
}

/** A protocol's whole plan: the steps, the starter capital, and the hold window. */
export interface FarmPlan {
  steps: PlanStep[];
  capitalUsd: number;
  holdDays: number;
  gasToken: string;
  chain: string;
  secondChain: string | null;
}

/** The native gas token of a chain, for the wallet and fee steps. */
function gasToken(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'solana') return 'SOL';
  if (c === 'bnb chain' || c === 'binance') return 'BNB';
  if (c === 'avalanche') return 'AVAX';
  if (c === 'polygon') return 'POL';
  if (c === 'bitcoin') return 'BTC';
  if (c === 'hyperliquid l1') return 'HYPE';
  if (c === 'berachain') return 'BERA';
  if (c === 'sui') return 'SUI';
  if (c === 'aptos') return 'APT';
  if (c === 'sonic') return 'S';
  if (c === 'tron') return 'TRX';
  if (c === 'near') return 'NEAR';
  if (c === 'cosmos') return 'ATOM';
  if (c === 'fantom') return 'FTM';
  if (c === 'cronos') return 'CRO';
  if (c === 'cardano') return 'ADA';
  if (c === 'ton') return 'TON';
  return 'ETH';
}

/** Starter capital from the protocol's own TVL: a position that moves the needle without being the pool. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Hold window from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'))
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield asset on ${chain} and hold it`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open`;
}

/** The weekly qualifying action, in the category's own terms. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Borrow a small amount against the deposit on ${name} once a week so the position stays active`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'))
    return `Swap a small amount or add a little liquidity on ${name} once a week so the position stays active`;
  if (c.includes('bridge')) return `Bridge a small amount through ${name} once a week so the route stays active`;
  if (c.includes('staking') || c.includes('restak'))
    return `Claim the staking rewards on ${name} and restake them once a week`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Open or close one small position on ${name} once a week so the account stays active`;
  if (c.includes('prediction')) return `Place one small market position on ${name} once a week`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Check the ${name} vault's allocation and top it up with a small amount once a week`;
  if (c.includes('stable')) return `Mint or redeem a small amount of the stable asset on ${name} once a week`;
  if (c.includes('rwa')) return `Check the yield accrual on ${name} and add a small amount once a week`;
  if (c.includes('insurance')) return `Review the ${name} cover once a week and renew it before it lapses`;
  return `Make one qualifying action on ${name} once a week, such as a deposit, a swap or a vote`;
}

/** What to check before claiming, in the category's own terms. */
function claimFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `open ${name}'s own points page and check the supply and borrow points`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'))
    return `open ${name}'s own points page and check the liquidity and trading points`;
  if (c.includes('bridge')) return `open ${name}'s own page and check the bridging volume credit`;
  if (c.includes('staking') || c.includes('restak'))
    return `open ${name}'s own page and check the staking rewards and any points`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `open ${name}'s own page and check the trading volume and any fee rebates`;
  if (c.includes('prediction')) return `open ${name}'s own page and check the market positions and any points`;
  if (c.includes('curator') || c.includes('allocator'))
    return `open ${name}'s own vault page and check the shares and any points`;
  if (c.includes('stable')) return `open ${name}'s own page and check the minted balance and any points`;
  if (c.includes('rwa')) return `open ${name}'s own page and check the yield accrual and any points`;
  if (c.includes('insurance')) return `open ${name}'s own page and check the cover status and any points`;
  return `open ${name}'s own points page and check the points or rewards`;
}

/**
 * A protocol's farm plan: seven steps, each with a dollar cost and a time. Every step is
 * derived from the protocol's own record (category, chains, TVL, age, name), so no two
 * protocols share a plan verbatim: the chain sets the wallet and the gas token, the
 * category sets the action, the weekly move and the claim check, the TVL sets the
 * capital, and the age sets the hold. Costs are gas at the time of the snapshot's week:
 * about $5 a transaction on Ethereum, about $2 elsewhere; the claim step adds the unwind.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): FarmPlan {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const gas = gasToken(chain);
  const pricey = chain.toLowerCase() === 'ethereum';
  const tx = pricey ? 5 : 2;
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const step3 =
    secondChain === null
      ? {
          when: 'Day 1',
          text: `Opt in on ${p.name}'s own points page and link the farming wallet, so the activity counts toward any future distribution.`,
          costUsd: 0,
          minutes: 10,
          recurringWeekly: false,
        }
      : {
          when: 'Day 1',
          text: `Repeat the position on ${secondChain} with half the capital, $${Math.round(capital / 2)}, so the activity is counted on both chains.`,
          costUsd: tx,
          minutes: 10,
          recurringWeekly: false,
        };
  return {
    steps: [
      {
        when: 'Day 0',
        text: `Open a fresh wallet on ${chain} to farm ${p.name} and fund it with ${gas} for fees plus the $${capital} starter position. Keep the seed phrase offline.`,
        costUsd: tx,
        minutes: 5,
        recurringWeekly: false,
      },
      { when: 'Day 0', text: `${actionFor(p, capital, chain)}.`, costUsd: tx, minutes: 15, recurringWeekly: false },
      step3,
      { when: 'Weekly', text: `${weeklyFor(p)}.`, costUsd: tx, minutes: 10, recurringWeekly: true },
      {
        when: `Hold ${hold}d`,
        text: `Hold the ${p.name} position for at least ${hold} days on ${chain} so the activity is counted in more than one snapshot.`,
        costUsd: 0,
        minutes: 0,
        recurringWeekly: false,
      },
      {
        when: 'Before exit',
        text: `Before you withdraw, ${claimFor(p)}. Claim only from the link the protocol itself publishes.`,
        costUsd: 0,
        minutes: 10,
        recurringWeekly: false,
      },
      {
        when: 'Claim week',
        text: `When ${p.name} announces a token, claim inside its window from the link the protocol itself publishes, then unwind the position in two or three tranches over a week so you are not the exit liquidity. If no token is announced, keep the position and re-check the points page monthly.`,
        costUsd: pricey ? 10 : 4,
        minutes: 30,
        recurringWeekly: false,
      },
    ],
    capitalUsd: capital,
    holdDays: hold,
    gasToken: gas,
    chain,
    secondChain,
  };
}

/** One farm step as the single string board.json carries: action, cost and time. */
export function stepString(step: PlanStep): string {
  const cost =
    step.costUsd === 0
      ? 'no fee'
      : step.recurringWeekly
        ? `about $${step.costUsd} of gas a week`
        : `about $${step.costUsd} of gas`;
  const time =
    step.minutes === 0 ? 'no active time' : step.minutes >= 60 ? `${(step.minutes / 60).toFixed(1)} hours` : `${step.minutes} minutes`;
  let s = `${step.when} — ${step.text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

// ------------------------------------------------------------------ the board

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  farm_steps: string[];
}

/** The dashboard's view of one row, with the model's breakdown and the costed plan. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  versioned: boolean;
  launch_value_usd: number;
  token_odds: number;
  implied_value_usd: number;
  range_low_usd: number;
  range_high_usd: number;
  range10_low_usd: number;
  range10_high_usd: number;
  thesis: string;
  plan: FarmPlan;
  /** The default scenario's verdict: FARM, MARGINAL or SKIP at a 7% drop share. */
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  net_usd: number;
  net_per_hour_usd: number;
  expected_drop_usd: number;
  total_cost_usd: number;
  total_hours: number;
}

/** Drops are read as per-wallet allocations: the drop pool is shared among an
 * assumed 10,000 active wallets, because the snapshot carries no wallet count.
 * That count is the entry's stated assumption, not a measured figure; position
 * size changes the capital charge, not the allocation. A shorter horizon than
 * the plan's hold earns only the matching fraction of the allocation.
 * A pro-rata dollar-days reading pays a retail position fractions of a dollar
 * on every row of this board, so it cannot discriminate and is not used. */
export const ASSUMED_WALLETS = 10000;

/** The verdict arithmetic, shared by the build and the page: one formula, two homes. */
export function scenarioVerdict(
  implied: number,
  _tvl: number,
  _age: number | null,
  plan: FarmPlan,
  dropShare: number,
  horizonDays: number,
): { verdict: 'FARM' | 'MARGINAL' | 'SKIP'; net: number; netPerHour: number; expectedDrop: number; totalCost: number; totalHours: number; holdUsed: number; weeks: number; holdFraction: number } {
  const holdUsed = Math.min(plan.holdDays, horizonDays);
  const weeks = holdUsed / 7;
  const holdFraction = plan.holdDays > 0 ? holdUsed / plan.holdDays : 1;
  const expectedDrop = ((implied * dropShare) / ASSUMED_WALLETS) * holdFraction;
  let gas = 0;
  let minutes = 0;
  for (const step of plan.steps) {
    gas += step.recurringWeekly ? step.costUsd * weeks : step.costUsd;
    minutes += step.recurringWeekly ? step.minutes * weeks : step.minutes;
  }
  const capitalCharge = plan.capitalUsd * 0.02 * (holdUsed / 365);
  const totalCost = gas + capitalCharge;
  const totalHours = minutes / 60;
  const net = expectedDrop - totalCost;
  const netPerHour = totalHours > 0 ? net / totalHours : net;
  const verdict = netPerHour >= 25 ? 'FARM' : net >= 0 ? 'MARGINAL' : 'SKIP';
  return { verdict, net, netPerHour, expectedDrop, totalCost, totalHours, holdUsed, weeks, holdFraction };
}

/** A compact dollar figure for the thesis sentence. */
function fmtTvl(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

function ordinal(n: number): string {
  const suffix = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]}`;
}

function agePhrase(age: number | null): string {
  if (age === null) return 'an unlisted age';
  if (age >= 365) return `${(age / 365).toFixed(1)} years with no token recorded`;
  return `${age} days with no token recorded`;
}

/** One row's thesis: why the rank is what it is, from the snapshot's own figures. */
export function thesisFor(p: SnapshotProtocol, age: number | null, tvlRank: number, odds: number): string {
  const growth =
    p.change_7d === null
      ? 'no seven-day change reported'
      : p.change_7d > 0
        ? `TVL up ${p.change_7d.toFixed(2)}% over seven days`
        : p.change_7d < 0
          ? `TVL down ${Math.abs(p.change_7d).toFixed(2)}% over seven days`
          : 'TVL flat over seven days';
  const chains = p.chains.length === 1 ? 'on 1 chain' : `on ${p.chains.length} chains`;
  return `${p.name} holds ${fmtTvl(p.tvl_usd)} of TVL, the ${ordinal(tvlRank)} largest on this board, ${growth}, ${chains}, ${agePhrase(age)}, and peers like it record a token ${(odds * 100).toFixed(0)}% of the time.`;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  checksum: string;
  watchlist_size: number;
  board_size: number;
  accounting: Accounting;
  value: {
    terms: string[];
    coef: number[];
    se: number[];
    compCount: number;
    flatMultiple: number;
    flatLooMiss: number;
    flatWfMiss: number;
    looMiss: number;
    wfMiss: number;
    band2575: [number, number];
    band1090: [number, number];
    cover2575: number;
    cover1090: number;
    trials: { term: string; looMiss: number; wfMiss: number; tStat: number; kept: boolean }[];
    comps: { lt: number; lm: number; g: number; ch: number; a: number; d: string; s: string }[];
  };
  odds: {
    terms: string[];
    coef: number[];
    se: number[];
    peerCount: number;
    baseRate: number;
    baseBrier: number;
    brierAll: number;
    brierCv: number;
    brierWf: number;
    trials: { term: string; cvBrier: number; wfBrier: number; tStat: number; kept: boolean }[];
    peers: { a: number | null; lt: number; g: number; ch: number; y: 0 | 1; d: string | null; s: string }[];
  };
  worthFarming: number;
  rows: RadarRow[];
}

/** The fitted board and everything the dashboard needs, from one snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  checksum: string,
  modelVersion: string,
): { board: BoardRow[]; radar: RadarData; valueFit: ValueFit; oddsFit: OddsFit } {
  const dated = (p: SnapshotProtocol): ValueComp | null => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age === null || p.mcap_usd === null) return null;
    return {
      logTvl: Math.log(p.tvl_usd),
      logMcap: Math.log(p.mcap_usd),
      chains: chainsFeature(p.chains.length),
      growth: growthFeature(p.change_7d),
      age: ageFeature(age),
      listedAt: p.listed_at!,
      slug: p.slug,
    };
  };
  const comps: ValueComp[] = [];
  for (const p of snapshot.protocols) {
    if (!isComp(p)) continue;
    const row = dated(p);
    if (row !== null) comps.push(row);
  }
  comps.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const valueFit = fitValueCurve(comps);

  const peers: OddsPeer[] = snapshot.protocols
    .map((p) => ({
      age: ageFeature(ageDays(snapshot.as_of, p.listed_at)),
      logTvl: Math.log(p.tvl_usd),
      growth: growthFeature(p.change_7d),
      chains: chainsFeature(p.chains.length),
      recordsToken: (p.gecko_id !== null || p.symbol !== null ? 1 : 0) as 0 | 1,
      listedAt: p.listed_at,
      slug: p.slug,
    }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const oddsFit = fitOdds(peers);

  const rankable = snapshot.protocols.filter(isRankable);
  const watchlist = new Set(snapshot.watchlist);
  const tvlRank = new Map<string, number>();
  [...rankable]
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .forEach((p, i) => tvlRank.set(p.slug, i + 1));

  const scored = rankable.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const launch = launchValue(valueFit, Math.log(p.tvl_usd), growthFeature(p.change_7d), chainsFeature(p.chains.length), ageFeature(age));
    const odds = tokenOdds(oddsFit, {
      age: ageFeature(age),
      logTvl: Math.log(p.tvl_usd),
      growth: growthFeature(p.change_7d),
      chains: chainsFeature(p.chains.length),
      recordsToken: 0,
      listedAt: p.listed_at,
      slug: p.slug,
    });
    const implied = Math.max(1, Math.round(launch * odds));
    return { p, age, launch, odds, implied };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  let worthFarming = 0;
  const rows: RadarRow[] = scored.map((s, i) => {
    const plan = farmPlan(s.p, s.age);
    const verdict = scenarioVerdict(s.implied, s.p.tvl_usd, s.age, plan, 0.07, 84);
    if (verdict.verdict === 'FARM') worthFarming++;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      watchlist: watchlist.has(s.p.slug),
      versioned: VERSIONED.test(s.p.name),
      launch_value_usd: Math.max(1, Math.round(s.launch)),
      token_odds: s.odds,
      implied_value_usd: s.implied,
      range_low_usd: Math.max(1, Math.round(s.launch * valueFit.band2575[0] * s.odds)),
      range_high_usd: Math.max(1, Math.round(s.launch * valueFit.band2575[1] * s.odds)),
      range10_low_usd: Math.max(1, Math.round(s.launch * valueFit.band1090[0] * s.odds)),
      range10_high_usd: Math.max(1, Math.round(s.launch * valueFit.band1090[1] * s.odds)),
      thesis: thesisFor(s.p, s.age, tvlRank.get(s.p.slug) ?? 0, s.odds),
      plan,
      verdict: verdict.verdict,
      net_usd: verdict.net,
      net_per_hour_usd: verdict.netPerHour,
      expected_drop_usd: verdict.expectedDrop,
      total_cost_usd: verdict.totalCost,
      total_hours: verdict.totalHours,
    };
  });

  const board: BoardRow[] = rows.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.plan.steps.map(stepString),
  }));

  const rankedSlugs = new Set(rows.map((r) => r.slug));
  const compSlugs = new Set(comps.map((c) => c.slug));
  const books = accounting(snapshot, rankedSlugs, compSlugs);
  if (books.total !== snapshot.protocols.length) {
    throw new SnapshotError(`the ledger covers ${books.total} of ${snapshot.protocols.length} protocols`);
  }

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: modelVersion,
    checksum,
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    accounting: books,
    value: {
      terms: [...valueFit.terms],
      coef: valueFit.coef,
      se: valueFit.se,
      compCount: valueFit.compCount,
      flatMultiple: valueFit.flatMultiple,
      flatLooMiss: valueFit.flatLooMiss,
      flatWfMiss: valueFit.flatWfMiss,
      looMiss: valueFit.looMiss,
      wfMiss: valueFit.wfMiss,
      band2575: valueFit.band2575,
      band1090: valueFit.band1090,
      cover2575: valueFit.cover2575,
      cover1090: valueFit.cover1090,
      trials: valueFit.trials.map((t) => ({ term: t.term, looMiss: t.looMiss, wfMiss: t.wfMiss, tStat: t.tStat, kept: t.kept })),
      comps: comps.map((c) => ({ lt: c.logTvl, lm: c.logMcap, g: c.growth, ch: c.chains, a: c.age, d: c.listedAt, s: c.slug })),
    },
    odds: {
      terms: [...oddsFit.terms],
      coef: oddsFit.coef,
      se: oddsFit.se,
      peerCount: oddsFit.peerCount,
      baseRate: oddsFit.baseRate,
      baseBrier: oddsFit.baseBrier,
      brierAll: oddsFit.brierAll,
      brierCv: oddsFit.brierCv,
      brierWf: oddsFit.brierWf,
      trials: oddsFit.trials.map((t) => ({ term: t.term, cvBrier: t.cvBrier, wfBrier: t.wfBrier, tStat: t.tStat, kept: t.kept })),
      peers: peers.map((p) => ({
        a: p.listedAt === null ? null : ageDays(snapshot.as_of, p.listedAt),
        lt: p.logTvl,
        g: p.growth,
        ch: p.chains,
        y: p.recordsToken,
        d: p.listedAt,
        s: p.slug,
      })),
    },
    worthFarming,
    rows,
  };
  return { board, radar, valueFit, oddsFit };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const asOf = doc.as_of;
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  const source = doc.source;
  if (typeof source !== 'string') throw new SnapshotError('snapshot.json has no source');
  const floor = doc.floor_usd;
  if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  const rawProtocols = doc.protocols;
  if (!Array.isArray(rawProtocols)) {
    throw new SnapshotError('snapshot.json has no protocols array');
  }
  const rawWatchlist = doc.watchlist;
  if (!Array.isArray(rawWatchlist) || rawWatchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols: SnapshotProtocol[] = rawProtocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = entry as Record<string, unknown>;
    const slug = p.slug;
    const name = p.name;
    const tvl = p.tvl_usd;
    if (typeof slug !== 'string' || typeof name !== 'string' || typeof tvl !== 'number' || !Number.isFinite(tvl)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      slug,
      name,
      category: strOrNull(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: tvl,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: strOrNull(p.listed_at),
      gecko_id: strOrNull(p.gecko_id),
      symbol: strOrNull(p.symbol),
    };
  });
  return {
    as_of: asOf,
    source,
    floor_usd: floor,
    protocols,
    watchlist: rawWatchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
