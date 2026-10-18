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
| `details` | Download iTunes Lookup JSON into `details/` |
| `media` | Download artwork into `logos/`, rebuild `archives/` and `rankings.json` |
| `lists` | Refresh curated lists in `lists/` (apps repository only) |
| `archives` | Rebuild `archives/` from `rankings/` |
| `index` | Rebuild `rankings.json` |
| `all` | `rank`, `details`, and `media` in order (default) |

| Option | Default | Description |
| --- | --- | --- |
| `--media <list>` | All | `apps`, `music`, `podcasts`, `books`, `audio-books` |
| `--root <dir>` | Current directory | Data repository root |
| `--month <YYYYMM>` | Current UTC month | Archive month |
| `--skip-existing` | Off | Reuse cached ranking and detail JSON files |
| `--generate-markdown` | Off | Generate `.md` summaries next to ranking files |
| `--limit <number>` | `100` | Results requested from each feed |
| `--countries <list>` | `us cn jp gb de fr` | Countries, comma or space separated |

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

Tests: `node --test scripts/downloader.test.mjs` (they only use temporary directories).

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
