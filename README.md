# Predict Alpha

A zero-backend, real-time P&L dashboard for a Polymarket copy-trading account.
Pure static HTML/CSS/JS — host it anywhere that serves files (GitHub Pages
included) and it renders itself from public APIs.

## How it gets its data

Everything money-related is read live, in the browser, from CORS-open public
endpoints — there is no server and no build step:

| Source | What |
|---|---|
| Polymarket data-api | open positions, full on-chain activity (fills, redeems, yield) |
| Polymarket CLOB | tick-level prices (WebSocket book + midpoints), price history |
| Polymarket gamma | market resolution (tells a settled position from a live one) |
| Public Polygon RPC | pUSD cash balance (`balanceOf`, read-only) |

Derived client-side from those: equity, cumulative P&L curve (daily replay of
chain activity), closed positions with exit prices and realized P&L, fees,
drawdown, win rate.

Static inputs:

- `config.js` — wallet address, invested-capital constant, inception date.
- `data/scans.json` *(optional)* — forecast-agent reasoning, shown as
  expandable rows. Refreshed by `scripts/sync-scans.mjs` from the Reasoning
  Traces API (bearer token via `TRACES_TOKEN` env or a git-ignored
  `.traces-token` file). In CI, `.github/workflows/sync-scans.yml` runs it
  twice a day with the token from the repo's `TRACES_TOKEN` Actions secret
  and commits the result — set that secret after pushing the repo.
- `data/annotations.json` *(optional)* — why a position was closed manually;
  the chain records the sale, not the intent. Keyed by outcome-token id.

## Deploy on GitHub Pages

1. Push this directory to a GitHub repository (as the repo root).
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/`.
3. Open `https://<user>.github.io/<repo>/`.

## Local preview

Any static server works (opening `index.html` via `file://` does not — the
page needs `fetch` for its data files):

```sh
python3 -m http.server 8000
# → http://localhost:8000/
```

## Notes

- Light/dark theme: follows the OS by default; the ☾/☀ button forces one and
  remembers the choice in `localStorage`.
- Prices use a single convention (CLOB midpoint, two-sided books only, with a
  half-tick deadband) to keep the equity line free of source-mixing sawteeth.
- The wallet address is public on-chain information; the page contains no
  keys and can place no orders.
