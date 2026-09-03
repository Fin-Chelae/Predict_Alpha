/* Predict Alpha — static configuration.
 *
 * Everything the page cannot learn from the chain itself lives here.
 * The wallet address is public on-chain information; no keys, no secrets.
 */
window.PA_CONFIG = {
  // Polymarket deposit wallet the dashboard tracks (read-only).
  wallet: "0xC2A50eaFbA4988955b62162060c08c3283fe0Ce9",

  // Total capital deposited, USD. A constant — deposits are finished and
  // will not change. Cumulative P&L on the page is equity minus this.
  invested: 9963.0,

  // Copy-trading start date. Baseline (day 0) of the cumulative P&L chart.
  inception: "2026-08-12",

  // pUSD (Polymarket USD, CLOB v2 collateral) ERC-20 on Polygon, 6 decimals.
  pusd: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",

  // Public Polygon RPCs, tried in order, for the cash balanceOf call.
  rpcs: [
    "https://polygon.drpc.org",
    "https://1rpc.io/matic",
    "https://polygon-bor-rpc.publicnode.com",
  ],
};
