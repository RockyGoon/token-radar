# Launch Ledger — a fitted pre-token radar

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/RockyGoon/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/RockyGoon/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

214 protocols that record no token, ranked by implied value: a fitted launch
value times the fitted odds that a protocol like it records a token at all.
Both halves are fitted at run time from the sealed DeFiLlama snapshot itself —
no coefficient is written in advance, and no protocol is named by hand.

## What the numbers are

The snapshot holds 758 protocols at a $50M TVL floor, dated 2026-11-14. Of
those, 214 record no token and are ranked: the 40 on the snapshot's watchlist
plus 174 pre-token protocols outside it. The other 544 are accounted for, not
dropped: 65 traded tokens price the value curve, 79 traded tokens are not
usable comps, 272 record a token but no usable cap, and 128 are left out by
the board's own rules (bridges, staking, exchanges, wrappers, CEX).

**Launch value.** Fitted on the 65 traded tokens with a usable cap and a
listing date. A candidate term is kept only if it lowers the held-out miss in
both a leave-one-out test and a walk-forward test (older protocols price
newer ones) and its bootstrap effect is identified (|t| ≥ 1 over 200 refits).
Only the size curve survives: log value = 10.47 + 0.33 · log TVL (±0.16).
Held-out miss ×2.80 leave-one-out, ×2.26 walk-forward, against a flat median
multiple at ×3.37 / ×3.45. Chain count, seven-day growth and age were tested
and not kept — growth's effect is unidentified (t = 0.11).

**Token odds.** Fitted on all 758 protocols: the share of comparable peers
that record a token. Age and seven-day growth survive both a ten-fold test
and a walk-forward test (Brier 0.231 / 0.240, against 0.248 for the base
rate); size and chain count do not. Fitted: log odds = −1.01 + 1.14 · log age
(±0.18) − 1.87 · growth (±0.88).

**Range.** The printed P25–P75 band is the fitted launch value times the
leave-one-out residual band (×0.38–×3.39), times the odds. 51% of real caps
fall inside the band it calls 50%; 82% inside the P10–P90 band it calls 80%.

**Implied value** = fitted launch value × token odds. The dashboard refits
both halves in the browser from the same comparison sets and checks every
row against the refit: 214 of 214 rows recomputed, worst $0.

**Farm plans.** Every row carries a seven-step plan costed in gas and time,
with a verdict at a 7% drop share and a 12-week horizon: 16 FARM, 122
MARGINAL, 76 SKIP. The expected drop is the drop pool shared among an
assumed 10,000 active wallets — the snapshot carries no wallet count, so
that number is this entry's stated assumption, not a measured figure. The
dashboard lets the drop share and horizon move, and recomputes every verdict
live.

## Run it

Node 22.18+, standard library only, no network, no clock: two runs write
the same bytes.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` reads the snapshot, writes `board.json` and `data.js`, copies
`dashboard/` and `screenshots/`, and builds `dossier.json` last with the
vendored scorer library (`vendor/makefun-board.ts`, byte for byte the kit's
copy). The dashboard is a static page: `dashboard/index.html` reads
`data.js` and renders the board, the evidence tables, the ledger and the
detail views, with no network calls.

## Layout

```
main.ts                 entrypoint: snapshot -> board.json + data.js + dossier.json
lib/fit.ts              the fitting engine: OLS, logistic IRLS, term selection, bootstrap
lib/model.ts            snapshot parsing, accounting, farm plans, verdicts, data.js
dashboard/index.html    page shell
dashboard/app.css       dark green-black theme, no webfonts
dashboard/app.js        renders the board; refits the model and checks it in the browser
screenshots/            1-board.png, 2-detail.png, 3-filtered.png
vendor/makefun-board.ts the kit's dossier builder, byte for byte
LICENSE                 MIT
```

## Reading it honestly

A protocol *records* no token when its entry carries no market cap, no
CoinGecko id and no symbol. That is the record, never proof it has none.
The launch value is what the fitted curve says the token would be worth if
the protocol's record stayed as it is. Nothing here predicts whether or
when a token is issued, and the implied values are this entry's own claim,
never the snapshot's: the snapshot carries no ranking, no value and no plan.
