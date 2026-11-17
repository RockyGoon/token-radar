# Token Radar

A token launch radar for the make.fun bounty **token-radar-01**. It reads a sealed
DefiLlama snapshot of every protocol, ranks the ones that record no token by what
their launch would be worth, and shows a reader how to farm each one.

## What it does

`main.ts` (Node 22, standard library only) reads the snapshot from `/input`
(or `--input <snapshot.json|directory>`), scores every pre-token protocol with the
model in `lib/model.ts`, and writes to the output directory:

- `board.json` — the ranked board: 200 rows (the 40-protocol watchlist plus 160
  pre-token protocols below the $50M floor), each with an implied value and a
  six-step farm plan.
- `data.js` — the same board in the compact form the dashboard reads.
- `dashboard/` — the static page (no network, no framework).
- `screenshots/` — three 1280x720 screenshots of the page.
- `dossier.json` — the summary the judge reads, built with the vendored
  `vendor/makefun-board.ts` (the kit's copy, unchanged).

Run it locally:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

It runs in well under the 120-second, 1-CPU, 1024-MB budget, with no network.

## The model (radar-2)

One function scores every row, from the snapshot's own figures only. No protocol
name is ever special-cased.

```
implied = round( tvl_usd x 0.25
  x (1 + clamp(change_7d, -60, 120) / 100 x 0.6)
  x (0.6 + min(age_days, 1095) / 1095 x 0.4)
  x (1 + min(chains - 1, 4) x 0.05)
  x category )
```

- **TVL x 0.25** — the size of the prize: a quarter of the value locked, the launch
  a token would price against.
- **Growth** — seven-day TVL change, clamped to -60% .. +120%, weighted 0.6: the
  direction the prize is moving.
- **Maturity** — how long it has run with no token: 0.6 plus up to 0.4 over 1,095
  days. An unlisted age uses 365 days. A protocol that has grown large and stayed
  tokenless is the launch the radar exists to catch.
- **Chain diversity** — one plus 0.05 per extra chain, up to 4 extra: more chains,
  more users to reward and more surface to farm.
- **Category** — 0.70 for a bridge or liquid-staking wrapper, a product of a token
  that already trades, so its own launch is worth less than a venue of the same
  size. Every other category is 1.00.

The board covers the whole 40-protocol watchlist and adds the early radar below
the floor. Live-token protocols are set aside and shown with their market caps,
never mixed into the ranking.

## Farm plans

Every board row carries six steps, each with a cost and a time. The plan is
derived from the protocol's own record — category, chains, TVL, age and name —
so no two protocols share a plan verbatim:

1. A fresh wallet on the protocol's first chain, funded with that chain's gas
   token plus the position capital.
2. The category's action: supply, provide liquidity, bridge, stake, deposit
   margin, fund a market, deposit into a vault, mint, or buy cover.
3. A weekly qualifying action in the category's own terms.
4. A hold of 30–60 days (longer for younger protocols) so the activity counts
   in more than one snapshot.
5. A claim check on the protocol's own points page, in the category's terms.
6. A farm log for the wallet, chain and dates.

## The dashboard

A dark DeFi-terminal page. The ranked board is sortable (rank, name, TVL, 7d,
age, implied value) and filterable by search, category, chain and TVL range,
with a Pre-token / Live-token switch. Selecting a row opens a detail view with
the row's full model breakdown — every multiplier, recomputed in the page and
checked against board.json — and its farm plan. The model is explained in the
page, with the snapshot's date and source stated.

## Layout

```
main.ts                  the program
lib/model.ts             the model, the board, the farm plans
vendor/makefun-board.ts  make.fun's dossier library (kit copy, unchanged)
dashboard/               index.html, app.css, app.js (static, no network)
screenshots/             1-board.png, 2-detail.png, 3-filtered.png
LICENSE                  MIT
```

## License

MIT. See `LICENSE`.
