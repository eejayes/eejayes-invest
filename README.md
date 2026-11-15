# Equity Research Dashboard

A web-based equity research dashboard. It combines Yahoo Finance price history with quarterly SEC EDGAR company facts.

Named portfolios, analysis collections, screener settings, and comparison-table columns are saved automatically in the browser's local storage. No account or database is required.

## Run locally

Install Node.js and npm first. Use Node.js 22.20 or newer on the Node 22
release line, or Node.js 24.12 or newer on the Node 24 release line. Check
your versions with `node --version` and `npm --version`. Installing dependencies
requires access to the npm registry.

```bash
npm ci
npm run dev
```

`npm ci` installs the locked dependencies, including `htmlparser2` and any required
platform-specific binaries, into `node_modules/`. No separate installations are needed;
dependencies and build output are not committed. `npm ci` replaces an existing
`node_modules/` directory.

Net tangible assets per share uses assets, total intangibles including goodwill, liabilities,
preferred stock, and common shares. Missing balance-sheet amounts are assumed to be zero and
identified in the detail view and metric tooltips; positive common shares are required.
Historical values are converted to USD using the current exchange rate.
Compare shows price divided by net tangible assets per share; the chart uses the closing price
on or before each filing date. The ratio is unavailable when net tangible assets are nonpositive.

Open `http://localhost:5173`. The API runs on `http://localhost:8787`.
Development startup uses fixed ports and exits if either is already occupied. This prevents
Vite from silently moving to another port, because browser-local portfolio storage is isolated
by origin (including the port). If startup reports an occupied port, stop the application
using it before restarting. Verify the API at `http://localhost:8787/api/health`; it
should return `{"ok":true}`. The app also needs internet access to SEC and Yahoo sources.

To check the production frontend build and run the regression tests:

```bash
npm run build
npx tsx --test tests/*.test.ts
```

To open the app from another device on the same network, start it with `npm run dev`, find
the host computer's LAN IP address, and open `http://<LAN-IP>:5173` on the other device.
For example, on Linux/macOS:

```bash
hostname -I | awk '{print $1}'
```

Allow TCP ports `5173` and `8787` through the host firewall if the other device cannot connect.
The development server is intentionally exposed to the local network only; do not forward
these ports to the public internet.

For responsible SEC API identification, set a contact address:

```bash
SEC_USER_AGENT="EquityResearchDashboard your-email@example.com" npm run dev
```

## Production serving

Build the frontend and API, then start the Node server:

```bash
npm run build
SEC_USER_AGENT="EquityResearchDashboard your-email@example.com" npm start
```

The server serves the built frontend and API from the same origin. It listens on
port `8787` by default; set `PORT` to the port provided by your hosting platform.
Deploy the build output and production dependencies (`dist/`, `dist-server/`, and
`node_modules/`), and put the service behind HTTPS using the hosting platform or a
reverse proxy. Do not expose the Vite development server to the public internet.

## Metrics

- Price and change relative to the first visible price
- Historical P/E based on the latest four quarterly EPS values filed by each chart date
- Current trailing P/E and price/book
- Quarter-over-quarter EPS growth
- Exponentially weighted EPS and revenue growth (alpha 0.45)
- Configurable comparison columns with a saved layout
- Sortable screener with ascending and descending metric ordering
- Filters for ticker/company, exchange, market cap, P/E, price/book, EPS growth, and revenue growth
- Multiple independent named portfolios and analysis collections
- Per-symbol enable/disable controls inside analysis collections
- Exact-size random analysis samples from 1 to 100 eligible Nasdaq/NYSE SEC filers
- Optional random-sample constraints for the highest-volume pool and minimum/maximum market capitalization
- Bounded-concurrency fundamental calculation with progress and per-symbol error reporting

Each random sample request refreshes the official Nasdaq Trader listing files and SEC ticker list with HTTP caching disabled, so newly listed and delisted symbols are reflected immediately.

SEC issuers use different XBRL taxonomies, so some fields can be unavailable. The server caches upstream responses in memory and keeps all API-specific logic behind its own endpoints.
