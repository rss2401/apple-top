# Apple Top

Monthly archive of Apple's top-chart RSS feeds (App Store, Apple Music, Apple Podcasts,
Apple Books, and audiobooks) with a static website for browsing them.

This repository holds the code: the website, the downloader, and the shared GitHub Actions
workflow. The data lives in one repository per media type:

| Repository | Content | Scheduled update (UTC) |
| --- | --- | --- |
| [apple-top-apps](https://github.com/rss2401/apple-top-apps) | App Store charts and curated app lists | 02:23 |
| [apple-top-podcasts](https://github.com/rss2401/apple-top-podcasts) | Apple Podcasts charts | 03:23 |
| [apple-top-music](https://github.com/rss2401/apple-top-music) | Apple Music charts | 04:23 |
| [apple-top-books](https://github.com/rss2401/apple-top-books) | Apple Books charts | 05:23 |
| [apple-top-audio-books](https://github.com/rss2401/apple-top-audio-books) | Audiobook charts | 06:23 |

Each data repository runs on the first day of every month and every Monday. All runs in a
month overwrite `rankings/YYYYMM/`, so every month keeps its latest weekly snapshot.

## How the pieces fit

```text
rss2401.github.io/apple-top/              ← website (this repository, static.yml)
rss2401.github.io/apple-top-<media>/      ← data (each data repository's own Pages site)
```

The website loads `../apple-top-<media>/rankings.json` for every media type and reads
details, history, and artwork from the same relative base. No CORS or absolute URLs are
involved, and a missing data site only hides its media type.

The existing page, header filters, app cards, and detail modal are shared by all
collections. An app's download price continues to come from its existing Lookup
detail record. The downloader additionally captures listed subscriptions and other
in-app purchase prices from that app's regional App Store page. The ordinary detail
modal shows these extra purchases only when present, in the selected country's
currency; it never substitutes another country's prices.

List names use `<country>_<category>.json`; the repository already supplies the media
type. Examples are `us_ai.json`, `cn_ai.json`, `us_apple.json`, and `us_google.json`.
Select **Subscriptions → US / CN → Ai Subs** in the same page to browse
`lists/us_ai-subs.json` or `lists/cn_ai-subs.json`.
These cards highlight purchase prices and open a comparison-focused version of the
existing modal, with purchase, snapshot, and currency selectors.
The **App Details** and **Subscriptions** buttons switch between the two views
without changing the selected region, snapshot, or purchase.
Distinct amounts sharing a purchase name stay separate, and ambiguous names are excluded from percentage
comparisons because Apple may not identify billing periods. There is no separate site
or page layout for subscriptions.

### Shareable links

The URL identifies the selected JSON file and optional item hash. Refreshing a
link or using the browser's Back/Forward buttons restores that file and item.

- `?file=apple-top-books/rankings/202610/us_books_top-paid.json` opens that ranking.
  Only files in the loaded repository indexes are selected; external URLs and
  parent-directory traversal are not loaded.
- `?file=apple-top-apps/lists/us_ai-subs.json` opens that subscription list.
  The file determines media, source, region, category, and default modal view.
- `#6474233312` opens that item's detail or subscription view, including items
  outside the selected ranking. Closing the modal clears its hash.
- Only a non-default modal `view` and a historical snapshot `month` add query
  parameters. The latest available snapshot is the default. Purchase and currency
  choices stay within the page and are not written into the URL.
- Entry points such as `?media=books`, `?media=book`, and the older filter-based
  links still work and resolve to an indexed JSON file. GitHub Homepages retain
  these media-only links so they always select the newest available archive.

For example, `?file=apple-top-apps/lists/cn_ai-subs.json#6474233312` opens Kimi
subscriptions in China. Legacy list filenames remain readable across data updates.

Each data repository contains a short `.github/workflows/update.yml` that calls
[`update-data.yml`](.github/workflows/update-data.yml) here with its media type. The shared
workflow runs inside the data repository: it checks out this repository into `_tool/`, runs
the unit tests, downloads in three checkpointed stages, commits to the data repository, and
deploys the data repository's Pages site.

## Downloader

`scripts/downloader.mjs` uses only built-in Node.js APIs (Node.js 24+). Run it from the root
of a data repository, or pass `--root`:

```bash
cd ../apple-top-podcasts
node ../apple-top/scripts/downloader.mjs all --media podcasts
```

| Command | Description |
| --- | --- |
| `rank` | Download ranking RSS JSON into `rankings/YYYYMM/` |
| `details` | Download iTunes Lookup JSON; additionally capture listed subscriptions/in-app purchases |
| `media` | Download artwork into `logos/`, rebuild `archives/` and `rankings.json` |
| `lists` | Refresh curated lists, in-app purchase prices, and artwork (apps repository only) |
| `prices` | Save in-app purchase prices into `prices/YYYYMM/` (see below) |
| `archives` | Rebuild `archives/` from `rankings/` |
| `index` | Rebuild `rankings.json` |
| `all` | `rank`, `details`, and `media` in order (default) |

| Option | Default | Description |
| --- | --- | --- |
| `--media <list>` | All | `apps`, `music`, `podcasts`, `books`, `audio-books` |
| `--root <dir>` | Current directory | Data repository root |
| `--month <YYYYMM>` | Current UTC month | Archive month |
| `--skip-existing` | Off | Reuse cached rankings, details, and in-app purchase prices |
| `--generate-markdown` | Off | Generate `.md` summaries next to ranking files |
| `--limit <number>` | `100` | Results requested from each feed |
| `--countries <list>` | `us cn jp gb de fr` | Countries, comma or space separated |
| `--storefronts <list>` | See below | App Store storefronts for `prices` |
| `--all-storefronts` | Off | `prices` checks all 175 storefronts |

Behaviour worth knowing:

- **Details**: items in the current month and in curated lists are refreshed; items that only
  appear in older months are fetched only when their detail file is missing. Lookup requests
  are batched (25 IDs), spaced at least 3.25 s apart, and back off on HTTP 403/429.
- **Artwork**: `logos/<id>-<hash>.png` is named after the ranking's artwork URL and contains the
  large (`600x600bb`, see `ARTWORK_SIZE_TOKEN`) rendition of that same image. Each file is
  written once and never renamed or overwritten; the website computes the file name from the
  artwork URL it already has. Only the newest version is required; old versions that Apple no
  longer serves only produce a warning.
- **Failures**: requests time out and retry; writes go through temporary files. A missing feed
  (404) is skipped, other unrecovered failures fail the stage so incomplete data is not
  committed.

- **Extra subscription/in-app prices**: download prices are already stored in
  `details/` by Lookup. In addition, `details` and `lists` fetch the App Store page in each current
  app entry's own storefront and save its listed in-app purchases under
  `prices/YYYYMM/<id>.json`. Historical-only entries and other media do not trigger price
  requests. `--skip-existing` reuses a storefront already captured in that month's file.
  The extra purchase prices are committed with app details; they do not depend on exchange rates.
  Each storefront carries its own capture time so refreshing one country does not
  make another country's retained prices appear newer.
- **Subscription comparisons**: country-specific files matching `lists/<country>_*-subs.json`
  are price lists (e.g. `lists/us_ai-subs.json` and `lists/cn_ai-subs.json`, in ranking-feed
  format). `--countries` selects which product lists to process; shared apps are fetched
  once. Every price-list app gets a Lookup detail record in its list's source country,
  including apps absent from all rankings. `prices` backfills missing localized details
  before price capture and fails if Lookup still supplies no detail; existing details
  in other countries are preserved. For every app in them, `prices` reads its App Store page
  (`apps.apple.com/<storefront>/app/id<id>`), about 1.5 s apart. The first run of an app, and
  any run with `--all-storefronts`, checks all 175 storefronts; later runs only revisit the
  storefronts where the latest snapshot found the app. It writes `prices/YYYYMM/<id>.json` plus `prices/YYYYMM/usd-rates.json`, the unmodified
  USD rates file of [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) (CC0). Each item keeps
  the listed price string and a parsed `amount`; a 404 is stored as `available: false`, and a
  page served for another storefront is a failure. Apple lists at most ten purchases per page and
  does not label subscriptions or billing periods. The workflow commits prices separately and
  skips incomplete comparison updates, without discarding already committed local
  in-app purchase prices or failing the run, when any comparison page fails.

Tests: `node --test scripts/*.test.mjs` (they only use temporary directories and mocked price pages).

## Local preview

Clone the data repositories next to this one (or use the
[group-apple-top](https://github.com/rss2401/group-apple-top) repository with submodules), then
serve the parent directory:

```bash
python -m http.server 8080
# open http://127.0.0.1:8080/apple-top/
```

## History

Migrated in October 2026 from [xy2401/appstore](https://github.com/xy2401/appstore), which keeps
the full Git history of the earlier data.
