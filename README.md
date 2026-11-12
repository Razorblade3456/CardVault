# CardVault

CardVault is a local-first Chase credit card statement organizer built with React, TypeScript, and Vite. It runs in the browser without an account, backend, bank connection, or external AI service. Card profiles, statement data, and original PDFs are saved in IndexedDB on the device.

## Run locally

```sh
npm install
npm run dev
```

For a production build and local preview:

```sh
npm run build
npm run preview
```

## How to Deploy CardVault to Netlify

1. Push the project to a GitHub repository. Commit `package.json`, `package-lock.json`, `.nvmrc`, and `netlify.toml`; do not commit `node_modules` or `dist`.
2. Open Netlify and choose **Add new site → Import an existing project**, then connect the GitHub repository.
3. Set the base directory to the folder containing CardVault's `package.json` and `netlify.toml` (the repository root for this project).
4. Verify the build command is `npm run build` and the publish directory is `dist`. These are also declared in `netlify.toml`.
5. Deploy the site. Netlify reads `.nvmrc` and selects Node.js 22 for the build.
6. Open the deployed URL. Add a test Chase card profile, visit the sections, and check that a statement PDF can be selected locally. Use a backup copy or fictional statement while validating.
7. Verify statement import, Excel export, and backup/restore on the deployed URL before relying on it for records.

CardVault is a static Vite site; deployment does not require Netlify Functions, a database, a server process, or paid Netlify features. The SPA fallback is in `netlify.toml`. Netlify serves existing files from `dist` normally, while the fallback sends unmatched paths to `index.html`.

See Netlify's current [Node dependency guidance](https://docs.netlify.com/build/configure-builds/manage-dependencies/) and [SPA 404 guidance](https://docs.netlify.com/resources/troubleshooting/page-not-found-error-guide/) if the dashboard settings differ.

### Netlify troubleshooting

- **`tsc: Permission denied`:** Confirm the deployment base directory contains this `package.json` and lockfile. Check that the build installed devDependencies and that `npm ci` completed successfully. `tsc` is a local TypeScript dependency and `npm run build` resolves local executables from `node_modules/.bin`; do not change permissions or remove the TypeScript check without identifying the underlying install/environment problem.
- **Missing dependencies:** Check the first install error in the Netlify log, verify `package-lock.json` matches `package.json`, and rerun `npm ci` locally. Do not use `--force` or `--legacy-peer-deps` to suppress conflicts.
- **Incorrect Node version:** Check the effective Node version in the build log and confirm `.nvmrc` is at the configured base directory and contains `22`. Netlify's `NODE_VERSION` or dashboard setting can override repository configuration.
- **Incorrect publish directory:** Set it to `dist`, not the repository root or `src`. Confirm `dist/index.html` exists after `npm run build`.
- **Build failure:** Start with the first TypeScript or Vite error in the log. Reproduce with `npm ci` followed by `npm run build`; avoid clearing caches unless the log points to stale cached dependencies.
- **Blank screen:** Open browser developer tools and inspect the first failed JavaScript or CSS request and console error. Confirm the deployed URL is serving `dist/index.html` and its referenced `/assets/` files.
- **404 on refresh:** Confirm the `/* → /index.html` status-200 redirect from `netlify.toml` is included in the deployed site configuration.
- **Missing PDF.js worker:** PDF.js uses the bundled `pdf.worker.min.mjs` imported by `src/parser.ts`; it does not fetch a worker from a CDN. Confirm the built worker file exists under `dist/assets/` and the Network panel returns it successfully.
- **Browser storage limitations:** CardVault uses IndexedDB on the current origin and device. Private browsing, storage eviction, quota limits, or clearing site data can remove records. Export a ZIP backup regularly; Netlify preview and production URLs have separate browser storage.

## Add cards and import statements

1. Add a Chase card profile with a nickname and last four digits. A type, closing day, and rewards program are optional. CardVault never asks for the full card number.
2. Download the statement PDF directly from Chase.
3. Choose **Upload statement** or drop the PDF onto CardVault. PDF text extraction runs in this browser.
4. Select the card, check the statement dates and balances, and review every extracted transaction. If the masked identifier matches a saved card, that card is preselected for confirmation.
5. Correct uncertain rows before saving. An identical PDF opens the matching card's archive. A replacement statement for an existing card/closing date requires confirmation before replacing the previous PDF and transactions.

For an older imported record, open it in **Statements** and choose **Reprocess statement**. CardVault reparses its saved PDF, compares prior and fresh dates, balances, and transaction counts, flags rows excluded by the new section rules, preserves the card and original PDF, and asks you to confirm before replacing parsed rows. Edited rows and fields are carried forward where possible; unmatched saved corrections are preserved and flagged.

If PDF text is unreadable, use **Enter summary manually** from the error message. The manual fallback records statement totals and does not create itemized transactions.

## Transactions and categories

The **Transactions** view shows saved activity across cards and lets you filter by card, transaction month, type, category, or merchant. Purchases, interest, and fees use positive amounts; payments, refunds, and credits use negative amounts. The original extracted description and PDF remain available in each transaction's details. Payment labels such as “Payment Thank You-Mobile” are presented as “Chase Mobile Payment” without changing the saved source description.

Categories are stored with the local CardVault data in IndexedDB and included in ZIP backups. The searchable category picker supports custom categories; deleting a category moves its transactions and rules to Uncategorized. Smart Merchant Rules normalize punctuation, website suffixes, and trailing numeric references, then require an exact normalized match. A user category correction takes priority over an automatic rule. Rules can be scoped to one card or all cards and can be optionally applied to prior transactions from Settings.

Insights include an actual monthly category breakdown from purchase and refund rows grouped by transaction date. Refunds subtract from their assigned purchase category, while payments and statement credits are excluded from spending.

## Reconciliation

Reconciliation runs two independent checks. First, the official summary check is:

`Previous balance + purchases + cash advances + balance transfers + interest + fees - payments and credits = ending balance`

Then each summary category is compared with the independently extracted Account Activity transactions. Currency is rounded to cents. A summary difference over one cent is **Discrepancy Found**; when the summary balances but detail is incomplete or does not match, the statement stays **Needs Review**. **Reconciled** requires both checks to pass. Missing official summary totals remain unavailable instead of being inferred from unrelated page figures. This checks statement arithmetic; it does not validate purchase authorization or receipts. Review the original PDF because Chase statement layouts can differ.

## Rewards

The parser recognizes a few common statement points labels; other rewards values remain unavailable unless entered by the user. You can configure each card's rewards program, point valuation, and category rates in **Rewards**. The optimizer only compares configured rates and labels the result as an estimate.

## Exports, backup, and restore

- **Export .xlsx** creates a workbook with dashboard summary, card accounts, monthly statements, transactions, payments and credits, rewards history, and reconciliation results. Use the card selector to export one card or all cards.
- **Back up everything** creates a ZIP with `cardvault.json` and each stored statement PDF.
- **Restore a backup** validates the JSON and lists card and statement counts before offering merge or replace. Merge skips duplicate PDF hashes. Replace asks for confirmation.

Backups contain sensitive financial records. Store them securely. Clearing browser data, storage eviction, or device failure can erase records; browser persistent storage is requested in Settings when supported, but it is not a backup.

## Chase parser limits

Version 1 uses PDF.js text extraction and section-aware Chase parsing. Transaction rows are accepted only under recognized **Account Activity** subsections; duplicated heading spans and **Account Activity (Continued)** pages are normalized while preserving transaction descriptions. Account Summary, payment coupon, APR, rewards, and year-to-date figures are kept out of the transaction ledger. Opening/closing date ranges and payment due dates are extracted separately. Official summary arithmetic and transaction category totals are checked independently, so missing or incomplete detail remains **Needs Review**. The August and September 2026 regressions use fictional fixtures with 19 and 70 rows, including a statement credit, a continued purchase page, and unrelated APR/rewards amounts. PDF.js text ordering and Chase layouts vary; every import still needs human review. The parser does not guarantee support for every Chase product, statement revision, language, scanned image, or reading order. Password-protected and image-only PDFs need a readable Chase PDF or manual summary entry.

## Extending the parser

Add layout-specific parsers in `src/parser.ts`, selected by stable Chase headings and verified text/position patterns. Keep the generic fallback conservative. Preserve extracted values separately from user corrections, add fixture PDFs with fictional data, and verify duplicate detection and balance arithmetic before raising confidence for a layout.

## Local data and privacy

No statement or card information is sent to an external service by this application. PDF.js, Excel, and ZIP libraries are bundled and run locally. CardVault does not include external analytics or bank credentials. Use a device you trust and keep secure backups.

Data is stored in IndexedDB for this browser, device, and website origin. A different device or browser will not automatically share the records. Netlify preview URLs and the production URL have separate browser storage. Clearing browser data or storage eviction can permanently remove local records. The IndexedDB schema uses a versioned upgrade callback that preserves existing stores; deployment updates do not intentionally clear application data. Full ZIP backups are the recovery path.

## Build checks

`npm ci` installs the exact versions in `package-lock.json`, including build-time devDependencies. `npm run build` runs `tsc -b` and then creates the static production site in `dist`. `npm test` covers the synthetic August Chase regression, signed-value migration, merchant normalization and rules, refund-aware category totals, reconciliation, Excel/ZIP data, bundled production assets, and Netlify config. The synthetic fixture contains fictional statement rows only. A successful local build is not proof of a successful Netlify deploy; verify the actual deploy and browser workflows on the target site before relying on it.
