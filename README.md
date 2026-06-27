# TOTALSEM Content Capture

This project opens a browser for manual login, then captures paginated content by clicking `Next` and writes a single combined output file.

## Install

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm run capture -- --url "https://hub.totalsem.com/content/25056" --max-pages 400
```

What happens:

1. Browser opens to the URL.
2. You log in manually.
3. In the terminal, press Enter when ready.
4. Script navigates and starts paging through `Next`.
5. Output is written to `output/totalsem-content-<timestamp>.txt`.

## Options

- `--url <value>`: target URL.
- `--max-pages <number>`: max pages to save (default `400`).
- `--output <path>`: custom output file path.
- `--headless`: run without opening a browser window.

## Output Behavior

- One combined file is saved.
- If a page load returns JSON from API calls, raw JSON is saved for that page section.
- Otherwise visible page text is saved.
- Duplicate-content detection stops capture early.