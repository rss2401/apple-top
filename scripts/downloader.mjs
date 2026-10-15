#!/usr/bin/env node

import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Data directories live in the data repository (for example apple-top-podcasts),
// not next to this script. The root defaults to the current working directory
// and can be changed with --root.
let ROOT_DIR;
let RANKINGS_DIR;
let DETAILS_DIR;
let LOGOS_DIR;
let ARCHIVES_DIR;
let LISTS_DIR;
let RANKINGS_INDEX;

export function setDataRoot(root) {
    ROOT_DIR = path.resolve(root);
    RANKINGS_DIR = path.join(ROOT_DIR, 'rankings');
    DETAILS_DIR = path.join(ROOT_DIR, 'details');
    LOGOS_DIR = path.join(ROOT_DIR, 'logos');
    ARCHIVES_DIR = path.join(ROOT_DIR, 'archives');
    LISTS_DIR = path.join(ROOT_DIR, 'lists');
    RANKINGS_INDEX = path.join(ROOT_DIR, 'rankings.json');
}

setDataRoot(process.cwd());

// Archive directories are named by month: rankings/YYYYMM/.
const ARCHIVE_MONTH_PATTERN = /^\d{6}$/;
const DETAIL_BATCH_SIZE = 25;
// Size token requested from Apple's image CDN when saving artwork.
// "bb" keeps the original aspect ratio inside the bounding box.
const ARTWORK_SIZE_TOKEN = '600x600bb';
const LOOKUP_MIN_INTERVAL_MS = 3_250;
const LOOKUP_RATE_LIMIT_DELAYS_MS = [30_000, 60_000];

const COUNTRIES = ['us', 'cn', 'jp', 'gb', 'de', 'fr'];
const FEED_CONFIGS = [
    { mediaType: 'apps', feedType: 'top-free', resource: 'apps', fileSuffix: 'top-free' },
    { mediaType: 'apps', feedType: 'top-paid', resource: 'apps', fileSuffix: 'top-paid' },
    { mediaType: 'music', feedType: 'most-played', resource: 'songs', fileSuffix: 'top-songs' },
    { mediaType: 'music', feedType: 'most-played', resource: 'albums', fileSuffix: 'top-albums' },
    { mediaType: 'music', feedType: 'most-played', resource: 'music-videos', fileSuffix: 'top-music-videos' },
    { mediaType: 'music', feedType: 'most-played', resource: 'playlists', fileSuffix: 'top-playlists' },
    { mediaType: 'podcasts', feedType: 'top', resource: 'podcasts', fileSuffix: 'top-podcasts' },
    { mediaType: 'podcasts', feedType: 'top-subscriber', resource: 'podcasts', fileSuffix: 'top-subscriber-podcasts', countries: ['us', 'gb'] },
    { mediaType: 'podcasts', feedType: 'top', resource: 'podcast-episodes', fileSuffix: 'top-podcast-episodes' },
    { mediaType: 'podcasts', feedType: 'top-subscriber', resource: 'podcast-channels', fileSuffix: 'top-subscriber-podcast-channels', countries: ['us', 'gb'] },
    { mediaType: 'books', feedType: 'top-free', resource: 'books', fileSuffix: 'top-free' },
    { mediaType: 'books', feedType: 'top-paid', resource: 'books', fileSuffix: 'top-paid' },
    { mediaType: 'audio-books', feedType: 'top', resource: 'audio-books', fileSuffix: 'top-audio-books' }
];

export const MEDIA_TYPES = [...new Set(FEED_CONFIGS.map(config => config.mediaType))];

export function getFeedConfigsForCountry(country, mediaTypes = MEDIA_TYPES) {
    return FEED_CONFIGS.filter(config => (
        mediaTypes.includes(config.mediaType)
        && (!config.countries || config.countries.includes(country))
    ));
}

/**
 * Splits a ranking file name such as "us_podcasts_top-podcasts.json" into its
 * parts. Returns null for names that do not follow the country_media_feed form.
 */
export function parseRankingFileName(fileName) {
    const parts = fileName.replace(/\.json$/i, '').split('_');
    if (parts.length < 3) return null;
    return { country: parts[0], mediaType: parts[1], feed: parts.slice(2).join('_') };
}

function isSelectedRankingFile(fileName, countries, mediaTypes) {
    const parsed = fileName.endsWith('.json') ? parseRankingFileName(fileName) : null;
    return Boolean(parsed && countries.includes(parsed.country) && mediaTypes.includes(parsed.mediaType));
}

const COUNTRY_ISO_MAP = {
    us: 'USA',
    cn: 'CHN',
    jp: 'JPN',
    gb: 'GBR',
    de: 'DEU',
    fr: 'FRA'
};

export function mapCountryToIso(country) {
    return COUNTRY_ISO_MAP[String(country).toLowerCase()] || String(country).toUpperCase();
}

export function hasDetailForCountry(cachedJson, country) {
    if (!cachedJson || !Array.isArray(cachedJson.results) || cachedJson.results.length === 0) {
        return false;
    }
    const targetIso = mapCountryToIso(country);
    return cachedJson.results.some(
        item => item.country === targetIso
            || item.country === country
            || item.country?.toLowerCase() === String(country).toLowerCase()
    );
}

class HttpError extends Error {
    constructor(message, status, retryAfterMs = 0) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

function printHelp() {
    console.log(`Apple Top downloader

Usage:
  node <apple-top>/scripts/downloader.mjs <command> [options]

Run it from the root of a data repository (or pass --root).

Commands:
  rank                     Download ranking RSS into rankings/YYYYMM/
  details                  Download lookup JSON into details/
  media                    Download artwork, build archives, and publish the index
  lists                    Download details and artwork only for curated lists
  archives                 Rebuild archives/ from rankings/
  index                    Rebuild rankings.json
  all                      Run rank, details, and media in order (default)

Options:
  --media <list>           Media types: ${MEDIA_TYPES.join(', ')} (default: all)
  --root <dir>             Data repository root (default: current directory)
  --month <YYYYMM>         Archive month (default: current UTC month)
  --skip-existing          Reuse cached ranking and detail JSON files
  --generate-markdown      Generate Markdown summaries for ranking files
  --limit <number>         Results requested from each feed (default: 100)
  --countries <list>       Countries separated by commas or spaces (default: all)
  -h, --help               Show this help
`);
}

function readPositiveInteger(value, optionName) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${optionName} must be a positive integer.`);
    }
    return parsed;
}

function parseCountries(value) {
    const countries = String(value || '')
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean);
    const invalidCountries = countries.filter(country => !COUNTRIES.includes(country));

    if (countries.length === 0) {
        throw new Error('--countries must include at least one country code.');
    }
    if (invalidCountries.length > 0) {
        throw new Error(
            `Unsupported countries: ${[...new Set(invalidCountries)].join(', ')}. `
            + `Supported values: ${COUNTRIES.join(', ')}.`
        );
    }
    return [...new Set(countries)];
}

function parseMediaTypes(value) {
    const mediaTypes = String(value || '')
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean);
    const invalid = mediaTypes.filter(mediaType => !MEDIA_TYPES.includes(mediaType));

    if (mediaTypes.length === 0) {
        throw new Error('--media must include at least one media type.');
    }
    if (invalid.length > 0) {
        throw new Error(
            `Unsupported media types: ${[...new Set(invalid)].join(', ')}. `
            + `Supported values: ${MEDIA_TYPES.join(', ')}.`
        );
    }
    return [...new Set(mediaTypes)];
}

function readListValues(args, index) {
    const values = [];
    while (args[index + 1] && !args[index + 1].startsWith('-')) {
        values.push(args[++index]);
    }
    return { value: values.join(' '), index };
}

export function currentUtcMonth(date = new Date()) {
    return date.toISOString().slice(0, 7).replace('-', '');
}

export function parseArguments(argv) {
    const args = [...argv];
    const commands = new Set(['rank', 'details', 'media', 'lists', 'archives', 'index', 'all']);
    let command = 'all';

    if (args[0] && !args[0].startsWith('-')) {
        command = args.shift();
        if (!commands.has(command)) throw new Error(`Unknown command: ${command}`);
    }

    const options = {
        command,
        skipExisting: false,
        generateMarkdown: false,
        limit: 100,
        countries: [...COUNTRIES],
        mediaTypes: [...MEDIA_TYPES],
        month: currentUtcMonth(),
        root: process.cwd(),
        help: false
    };

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];

        if (argument === '--media') {
            const result = readListValues(args, index);
            index = result.index;
            options.mediaTypes = parseMediaTypes(result.value);
        } else if (argument.startsWith('--media=')) {
            options.mediaTypes = parseMediaTypes(argument.slice('--media='.length));
        } else if (argument === '--root') {
            options.root = args[++index];
            if (!options.root) throw new Error('--root requires a directory.');
        } else if (argument.startsWith('--root=')) {
            options.root = argument.slice('--root='.length);
        } else if (argument === '--month') {
            options.month = args[++index];
        } else if (argument.startsWith('--month=')) {
            options.month = argument.slice('--month='.length);
        } else if (argument === '--skip-existing') {
            options.skipExisting = true;
        } else if (argument === '--generate-markdown') {
            options.generateMarkdown = true;
        } else if (argument === '--limit') {
            options.limit = readPositiveInteger(args[++index], '--limit');
        } else if (argument.startsWith('--limit=')) {
            options.limit = readPositiveInteger(argument.slice('--limit='.length), '--limit');
        } else if (argument === '--countries') {
            const result = readListValues(args, index);
            index = result.index;
            options.countries = parseCountries(result.value);
        } else if (argument.startsWith('--countries=')) {
            options.countries = parseCountries(argument.slice('--countries='.length));
        } else if (argument === '--help' || argument === '-h') {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }

    if (!ARCHIVE_MONTH_PATTERN.test(options.month || '')
        || Number(options.month.slice(4)) < 1
        || Number(options.month.slice(4)) > 12) {
        throw new Error('--month must use the YYYYMM format.');
    }

    return options;
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function hashArtworkUrl(url) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < url.length; index += 1) {
        hash ^= url.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function getArtworkFileName(id, artworkUrl) {
    return `${id}-${hashArtworkUrl(artworkUrl)}.png`;
}

/**
 * Rewrites an Apple CDN thumbnail URL such as ".../100x100bb.png" to the
 * large rendition of the same image. URLs that do not follow the pattern
 * are returned unchanged.
 */
export function toLargeArtworkUrl(url, sizeToken = ARTWORK_SIZE_TOKEN) {
    const pattern = /\/\d+x\d+[a-z]*\.(?:png|jpe?g|webp)$/i;
    return pattern.test(url) ? url.replace(pattern, `/${sizeToken}.jpg`) : url;
}

async function fileExists(filePath) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function atomicWrite(filePath, contents) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        await writeFile(temporaryPath, contents);
        try {
            await rename(temporaryPath, filePath);
        } catch (error) {
            if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
            await rm(filePath, { force: true });
            await rename(temporaryPath, filePath);
        }
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
    }
}

function parseRetryAfter(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

async function fetchResource(url, { responseType, attempts = 3, timeoutMs = 30_000 }) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                headers: { 'user-agent': 'apple-top-charts-archive/1.0' },
                signal: controller.signal
            });

            if (!response.ok) {
                throw new HttpError(
                    `HTTP ${response.status} ${response.statusText}`,
                    response.status,
                    parseRetryAfter(response.headers.get('retry-after'))
                );
            }

            if (responseType === 'json') {
                return JSON.parse(await response.text());
            }
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            lastError = error;
            const retryable = !(error instanceof HttpError)
                || error.status === 408
                || error.status === 429
                || error.status >= 500;

            if (!retryable || attempt === attempts) break;

            const backoff = error.retryAfterMs
                || (2 ** (attempt - 1) * 1000) + Math.floor(Math.random() * 500);
            console.warn(`Request failed (${attempt}/${attempts}): ${url}`);
            console.warn(`Retrying in ${Math.ceil(backoff / 1000)}s: ${error.message}`);
            await sleep(backoff);
        } finally {
            clearTimeout(timeout);
        }
    }

    if (lastError && !lastError.requestUrl) {
        lastError.requestUrl = url;
        lastError.message = `${lastError.message}; URL: ${url}`;
    }
    throw lastError;
}

async function downloadToFile(url, filePath, { responseType, skipExisting }) {
    if (skipExisting && await fileExists(filePath)) {
        if (responseType !== 'json') return { data: null, skipped: true };
        try {
            return { data: await readJson(filePath), skipped: true };
        } catch {
            console.warn(`Cached JSON is invalid and will be refreshed: ${path.relative(ROOT_DIR, filePath)}`);
        }
    }

    const data = await fetchResource(url, { responseType });
    const contents = responseType === 'json'
        ? `${JSON.stringify(data, null, 2)}\n`
        : data;
    await atomicWrite(filePath, contents);
    return { data, skipped: false };
}

export async function runSequential(items, worker) {
    const results = [];
    for (let index = 0; index < items.length; index += 1) {
        results.push(await worker(items[index], index));
    }
    return results;
}

export async function runCountryTasks(countries, worker) {
    const outcomes = await Promise.allSettled(
        countries.map((country, index) => worker(country, index))
    );
    const failures = [];
    const successes = [];

    outcomes.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') {
            successes.push(outcome.value);
            return;
        }

        const country = countries[index];
        failures.push({ country, reason: outcome.reason });
        console.warn(
            `[rank:${country}] failed; continuing with other countries: `
            + (outcome.reason?.message || outcome.reason)
        );
    });

    if (failures.length > 0) {
        console.warn(
            `[rank] ${failures.length} country task(s) failed (${failures.map(failure => failure.country).join(', ')}); `
            + `continuing with ${successes.length} successful country task(s).`
        );
    }

    return successes;
}

async function ensureDirectories() {
    await Promise.all([
        mkdir(RANKINGS_DIR, { recursive: true }),
        mkdir(DETAILS_DIR, { recursive: true }),
        mkdir(LOGOS_DIR, { recursive: true }),
        mkdir(ARCHIVES_DIR, { recursive: true })
    ]);
}

async function downloadCountryRankings(country, outputDirectory, options) {
    console.log(`[rank:${country}] started`);
    const configs = getFeedConfigsForCountry(country, options.mediaTypes);
    const results = await runSequential(configs, async config => {
        const url = `https://rss.marketingtools.apple.com/api/v2/${country}/${config.mediaType}/${config.feedType}/${options.limit}/${config.resource}.json`;
        const fileName = `${country}_${config.mediaType}_${config.fileSuffix}.json`;
        const filePath = path.join(outputDirectory, fileName);

        try {
            const result = await downloadToFile(url, filePath, {
                responseType: 'json',
                skipExisting: options.skipExisting
            });
            console.log(`[rank:${country}] ${result.skipped ? 'cached' : 'saved'} ${fileName}`);
            return { country, filePath, data: result.data };
        } catch (error) {
            if (await fileExists(filePath)) {
                try {
                    console.warn(`[rank:${country}] using existing archive ${fileName}: ${error.message}`);
                    return { country, filePath, data: await readJson(filePath) };
                } catch {
                    // Ignore an unreadable fallback file.
                }
            }

            if (error instanceof HttpError && error.status === 404) {
                console.warn(`[rank:${country}] feed unavailable ${fileName}`);
                return null;
            }
            throw new Error(`[rank:${country}] ${fileName}: ${error.message}`, { cause: error });
        }
    });

    console.log(`[rank:${country}] completed`);
    return results.filter(Boolean);
}

async function downloadRankings(options) {
    const outputDirectory = path.join(RANKINGS_DIR, options.month);
    await mkdir(outputDirectory, { recursive: true });

    await runCountryTasks(
        options.countries,
        country => downloadCountryRankings(country, outputDirectory, options)
    );

    try {
        return await loadRankingResults(options.month, options.countries, options.mediaTypes);
    } catch (error) {
        throw new Error('No readable ranking feeds are available after all country tasks finished.', {
            cause: error
        });
    }
}

async function loadRankingResults(month, countries = COUNTRIES, mediaTypes = MEDIA_TYPES) {
    const directory = path.join(RANKINGS_DIR, month);
    if (!await fileExists(directory)) {
        throw new Error(`Ranking archive does not exist: rankings/${month}`);
    }

    const files = (await readdir(directory))
        .filter(fileName => isSelectedRankingFile(fileName, countries, mediaTypes))
        .sort();
    if (files.length === 0) {
        throw new Error(
            `No ranking JSON files found in rankings/${month} for ${countries.join(', ')} / ${mediaTypes.join(', ')}.`
        );
    }

    return runSequential(files, async fileName => ({
        month,
        country: fileName.split('_')[0],
        filePath: path.join(directory, fileName),
        data: await readJson(path.join(directory, fileName))
    }));
}

/**
 * Collects unique media entries from ranking files. Artwork URLs keep the
 * chronological order of the input, so the last URL is the newest version.
 * Entries that appear in the `refreshMonth` archive are marked for refresh;
 * older entries are only backfilled when their cached detail is missing.
 */
export function collectMediaEntries(rankingResults, { refreshMonth } = {}) {
    const entries = new Map();

    for (const ranking of rankingResults) {
        const country = ranking.country || 'us';
        const refresh = refreshMonth !== undefined && ranking.month === refreshMonth;
        for (const item of ranking.data?.feed?.results || []) {
            const id = String(item.id || '');
            if (!id) continue;

            const key = `${country}:${id}`;
            const artworkUrl = item.artworkUrl100 || item.artworkUrl60 || '';
            if (!entries.has(key)) {
                entries.set(key, { id, country, item, artworkUrls: [], refresh: false });
            }

            const entry = entries.get(key);
            if (refresh) entry.refresh = true;
            if (artworkUrl && !entry.artworkUrls.includes(artworkUrl)) {
                entry.artworkUrls.push(artworkUrl);
            }
        }
    }

    return [...entries.values()];
}

// Curated lists exist only in the apps data repository; elsewhere lists/ is absent.
async function loadCuratedLists(countries = COUNTRIES) {
    const files = (await readdir(LISTS_DIR).catch(() => []))
        .filter(fileName => fileName.endsWith('-apps.json'))
        .sort();
    const lists = [];

    for (const fileName of files) {
        const list = await readJson(path.join(LISTS_DIR, fileName));
        const country = String(list.feed?.country || 'us').toLowerCase();
        if (!countries.includes(country)) continue;
        lists.push({ ...list, country, fileName });
    }

    return lists;
}

export function createCuratedEntries(lists) {
    const entries = [];

    for (const list of lists) {
        const country = String(list.feed?.country || list.country || 'us').toLowerCase();
        const results = list.feed?.results || list.results || (Array.isArray(list.ids) ? list.ids.map(id => ({ id })) : []);
        for (const item of results) {
            const id = String(item.id || '');
            if (!id) continue;
            const artworkUrl = item.artworkUrl100 || item.artworkUrl60 || '';
            entries.push({
                id,
                country,
                item: { id, kind: list.feed?.mediaType || list.mediaType || 'apps' },
                artworkUrls: artworkUrl ? [artworkUrl] : [],
                refresh: true
            });
        }
    }

    return entries;
}

export function mergeMediaEntries(...entryGroups) {
    const entries = new Map();

    for (const group of entryGroups) {
        for (const entry of group) {
            const key = `${entry.country}:${entry.id}`;
            if (!entries.has(key)) {
                entries.set(key, {
                    ...entry,
                    item: { ...entry.item },
                    artworkUrls: [...entry.artworkUrls]
                });
                continue;
            }

            const existing = entries.get(key);
            existing.item = { ...entry.item, ...existing.item };
            existing.refresh = Boolean(existing.refresh || entry.refresh);
            for (const artworkUrl of entry.artworkUrls) {
                if (!existing.artworkUrls.includes(artworkUrl)) {
                    existing.artworkUrls.push(artworkUrl);
                }
            }
        }
    }

    return [...entries.values()];
}

async function listArchiveMonths(rankingsDir = RANKINGS_DIR) {
    const entries = await readdir(rankingsDir, { withFileTypes: true }).catch(() => []);
    return entries
        .filter(entry => entry.isDirectory() && ARCHIVE_MONTH_PATTERN.test(entry.name))
        .map(entry => entry.name)
        .sort();
}

async function loadAllHistoricalRankingResults(countries = COUNTRIES, mediaTypes = MEDIA_TYPES) {
    const allResults = [];
    for (const month of await listArchiveMonths()) {
        try {
            const results = await loadRankingResults(month, countries, mediaTypes);
            allResults.push(...results);
        } catch {
            // Ignore months without matching ranking files.
        }
    }
    return allResults;
}

async function loadSelectedCuratedLists(options) {
    return options.mediaTypes.includes('apps') ? loadCuratedLists(options.countries) : [];
}

async function loadAllMediaEntries(options) {
    const rankings = await loadAllHistoricalRankingResults(options.countries, options.mediaTypes);
    const lists = await loadSelectedCuratedLists(options);
    return mergeMediaEntries(
        collectMediaEntries(rankings, { refreshMonth: options.month }),
        createCuratedEntries(lists)
    );
}

function summarizeMedia(entry, lookupData) {
    const targetIso = mapCountryToIso(entry.country);
    const details = lookupData?.results?.find(
        item => item.country === targetIso || item.country === entry.country || item.country?.toLowerCase() === entry.country.toLowerCase()
    ) || lookupData?.results?.[0] || {};

    const artworkUrl = details.artworkUrl600
        || details.artworkUrl512
        || details.artworkUrl100
        || details.artworkUrl60
        || entry.item.artworkUrl100
        || entry.item.artworkUrl60
        || '';

    return {
        id: entry.id,
        name: details.trackName || details.collectionName || details.name || entry.item.name || '',
        description: details.description || details.longDescription || '',
        artworkUrl,
        versionArtworkUrls: entry.artworkUrls.length > 0
            ? entry.artworkUrls
            : artworkUrl ? [artworkUrl] : []
    };
}

export function createRequestThrottle(
    minIntervalMs = LOOKUP_MIN_INTERVAL_MS,
    { now = Date.now, wait = sleep } = {}
) {
    let lastStartedAt = null;

    return async function waitForRequestSlot() {
        if (lastStartedAt !== null) {
            const waitMs = Math.max(0, minIntervalMs - (now() - lastStartedAt));
            if (waitMs > 0) await wait(waitMs);
        }
        lastStartedAt = now();
    };
}

export function createDetailBatches(entries, batchSize = DETAIL_BATCH_SIZE) {
    const entriesByCountry = new Map();

    for (const entry of entries) {
        if (!entriesByCountry.has(entry.country)) entriesByCountry.set(entry.country, []);
        entriesByCountry.get(entry.country).push(entry);
    }

    const batches = [];
    for (const countryEntries of entriesByCountry.values()) {
        for (let index = 0; index < countryEntries.length; index += batchSize) {
            batches.push(countryEntries.slice(index, index + batchSize));
        }
    }
    return batches;
}

/**
 * Current-archive and curated entries are refreshed unless --skip-existing is
 * set; historical-only entries are fetched only when their detail is missing.
 */
export function shouldReuseCachedDetail(entry, cachedJson, { skipExisting = false } = {}) {
    if (!hasDetailForCountry(cachedJson, entry.country)) return false;
    return skipExisting || !entry.refresh;
}

export function isLookupCompatibleId(id) {
    return /^\d+$/.test(String(id));
}

function getPrimaryLookupResultId(result) {
    if (result.wrapperType === 'collection' && result.collectionId != null) {
        return String(result.collectionId);
    }
    if (result.wrapperType === 'artist' && result.artistId != null) {
        return String(result.artistId);
    }
    return String(result.trackId ?? result.collectionId ?? result.artistId ?? '');
}

export function splitLookupResults(entries, lookupData) {
    const requestedIds = new Set(entries.map(entry => String(entry.id)));
    const resultsById = new Map();

    for (const result of lookupData?.results || []) {
        const candidateIds = [
            getPrimaryLookupResultId(result),
            result.trackId,
            result.collectionId,
            result.artistId
        ].filter(value => value !== undefined && value !== null && value !== '')
            .map(String);
        const id = candidateIds.find(candidateId => requestedIds.has(candidateId));
        if (id && !resultsById.has(id)) resultsById.set(id, result);
    }

    return resultsById;
}

async function downloadSingleDetail(entry, options) {
    const filePath = path.join(DETAILS_DIR, `${entry.id}.json`);
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(entry.id)}&country=${encodeURIComponent(entry.country)}`;
    let lookupData = null;
    let failed = false;

    try {
        const result = await downloadToFile(url, filePath, {
            responseType: 'json',
            skipExisting: options.skipExisting
        });
        lookupData = result.data;
    } catch (error) {
        if (await fileExists(filePath)) {
            lookupData = await readJson(filePath).catch(() => null);
        }
        if (lookupData) console.warn(`[details] using existing ${entry.id}: ${error.message}`);
        else {
            console.warn(`[details] failed ${entry.id}: ${error.message}`);
            failed = true;
        }
    }

    return { lookupData, failed };
}

async function fetchDetailBatch(entries, waitForRequestSlot) {
    const country = entries[0].country;
    const ids = entries.map(entry => entry.id).join(',');
    const url = `https://itunes.apple.com/lookup?id=${ids}&country=${encodeURIComponent(country)}`;
    let retryDelayMs = 0;
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (retryDelayMs > 0) await sleep(retryDelayMs);
        await waitForRequestSlot();

        try {
            return await fetchResource(url, { responseType: 'json', attempts: 1 });
        } catch (error) {
            lastError = error;
            const rateLimited = error instanceof HttpError
                && (error.status === 403 || error.status === 429);
            const retryable = !(error instanceof HttpError)
                || rateLimited
                || error.status === 408
                || error.status >= 500;

            if (!retryable || attempt === 3) break;

            retryDelayMs = error.retryAfterMs
                || (rateLimited
                    ? LOOKUP_RATE_LIMIT_DELAYS_MS[attempt - 1]
                    : (2 ** (attempt - 1)) * 1000);
            console.warn(
                `[details:${country}] batch request failed (${attempt}/3); `
                + `retrying in ${Math.ceil(retryDelayMs / 1000)}s: ${error.message}`
            );
        }
    }

    throw lastError;
}

async function saveDetailBatch(entries, lookupData) {
    const resultsById = splitLookupResults(entries, lookupData);

    for (const entry of entries) {
        const filePath = path.join(DETAILS_DIR, `${entry.id}.json`);
        const newResult = resultsById.get(String(entry.id));

        const existing = await readJson(filePath).catch(() => null);
        let results = Array.isArray(existing?.results) ? [...existing.results] : [];

        if (newResult) {
            const targetIso = mapCountryToIso(entry.country);
            const resultToSave = {
                ...newResult,
                country: newResult.country || targetIso
            };

            const existingIndex = results.findIndex(
                item => item.country === resultToSave.country || item.country === targetIso || item.country === entry.country
            );

            if (existingIndex >= 0) {
                results[existingIndex] = resultToSave;
            } else {
                results.push(resultToSave);
            }

            await atomicWrite(
                filePath,
                `${JSON.stringify({ resultCount: results.length, results }, null, 2)}\n`
            );
            continue;
        }

        if (existing) {
            console.warn(`[details] lookup omitted ${entry.id}; keeping existing file`);
        } else {
            await atomicWrite(filePath, `${JSON.stringify({ resultCount: 0, results: [] }, null, 2)}\n`);
            console.warn(`[details] lookup returned no result for ${entry.id}`);
        }
    }
}

async function downloadDetails(entries, options) {
    let completed = 0;
    let nextProgress = 100;
    let lastReported = -1;
    const failures = [];
    const pendingEntries = [];
    const waitForRequestSlot = createRequestThrottle();

    const reportProgress = force => {
        if (completed === lastReported) return;
        if (!force && completed < nextProgress) return;
        console.log(`[details] ${completed}/${entries.length}`);
        lastReported = completed;
        while (nextProgress <= completed) nextProgress += 100;
    };

    for (const entry of entries) {
        const filePath = path.join(DETAILS_DIR, `${entry.id}.json`);
        const existing = await readJson(filePath).catch(() => null);
        if (shouldReuseCachedDetail(entry, existing, options)) {
            completed += 1;
        } else if (!isLookupCompatibleId(entry.id)) {
            if (!existing) {
                await atomicWrite(
                    filePath,
                    `${JSON.stringify({ resultCount: 0, results: [] }, null, 2)}\n`
                );
            }
            console.warn(
                `[details] Lookup API does not accept ${entry.id}; using ranking metadata only`
            );
            completed += 1;
        } else {
            pendingEntries.push(entry);
        }
    }

    reportProgress(false);

    for (const batch of createDetailBatches(pendingEntries)) {
        try {
            const lookupData = await fetchDetailBatch(batch, waitForRequestSlot);
            await saveDetailBatch(batch, lookupData);
        } catch (error) {
            const uncachedIds = [];
            for (const entry of batch) {
                const filePath = path.join(DETAILS_DIR, `${entry.id}.json`);
                const existing = await readJson(filePath).catch(() => null);
                if (!existing) uncachedIds.push(entry.id);
            }

            if (uncachedIds.length > 0) {
                failures.push(...uncachedIds);
                console.warn(
                    `[details:${batch[0].country}] batch failed without cache for `
                    + `${uncachedIds.join(', ')}: ${error.message}`
                );
            } else {
                console.warn(
                    `[details:${batch[0].country}] batch failed; using existing files: ${error.message}`
                );
            }
        }

        completed += batch.length;
        reportProgress(false);
    }

    reportProgress(true);

    if (failures.length > 0) {
        throw new Error(`Details stage incomplete: ${failures.length} item(s) failed.`);
    }
}

/**
 * Maps each ranking artwork URL to the file it is cached in and the large
 * rendition of that same image. The file name is derived from the ranking URL,
 * so each versioned file holds exactly the artwork of that ranking version.
 */
export function planArtworkVersions(id, versionArtworkUrls) {
    return versionArtworkUrls.map(artworkUrl => ({
        sourceUrl: toLargeArtworkUrl(artworkUrl),
        fileName: getArtworkFileName(id, artworkUrl)
    }));
}

async function downloadArtwork(mediaItems) {
    const itemsWithArtwork = mediaItems.filter(item => item.versionArtworkUrls.length > 0);
    let completed = 0;
    const failures = [];

    await runSequential(itemsWithArtwork, async item => {
        const stableFilePath = path.join(LOGOS_DIR, `${item.id}.png`);
        const versions = planArtworkVersions(item.id, item.versionArtworkUrls);
        const newest = versions.at(-1);
        const newestFilePath = path.join(LOGOS_DIR, newest.fileName);
        let newestDownloaded = false;

        for (const version of versions) {
            const filePath = path.join(LOGOS_DIR, version.fileName);
            if (await fileExists(filePath)) continue;
            try {
                await downloadToFile(version.sourceUrl, filePath, {
                    responseType: 'binary',
                    skipExisting: false
                });
                if (version === newest) newestDownloaded = true;
                console.log(`[media] saved ${version.fileName}`);
            } catch (error) {
                // Older artwork versions may be gone from Apple's CDN; only the
                // stable file below decides whether this item failed.
                console.warn(`[media] version unavailable ${version.fileName}: ${error.message}`);
            }
        }

        try {
            if (newestDownloaded) {
                await atomicWrite(stableFilePath, await readFile(newestFilePath));
            } else if (!await fileExists(stableFilePath)) {
                if (await fileExists(newestFilePath)) {
                    await atomicWrite(stableFilePath, await readFile(newestFilePath));
                    console.log(`[media] restored ${item.id}.png`);
                } else if (item.artworkUrl) {
                    await downloadToFile(toLargeArtworkUrl(item.artworkUrl), stableFilePath, {
                        responseType: 'binary',
                        skipExisting: false
                    });
                    console.log(`[media] saved ${item.id}.png from lookup artwork`);
                }
            }
        } catch (error) {
            console.warn(`[media] stable artwork update failed ${item.id}: ${error.message}`);
        }

        if (!await fileExists(stableFilePath)) {
            console.warn(`[media] failed ${item.id}: no artwork available`);
            failures.push(item.id);
        }

        completed += 1;
        if (completed % 100 === 0 || completed === itemsWithArtwork.length) {
            console.log(`[media] ${completed}/${itemsWithArtwork.length}`);
        }
    });

    if (failures.length > 0) {
        throw new Error(`Media stage incomplete: ${failures.length} artwork file(s) failed.`);
    }
}

async function loadMediaItems(entries) {
    return runSequential(entries, async entry => {
        const filePath = path.join(DETAILS_DIR, `${entry.id}.json`);
        const lookupData = await readJson(filePath).catch(() => null);
        return summarizeMedia(entry, lookupData);
    });
}

async function listFiles(directory, predicate) {
    const found = [];
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...await listFiles(entryPath, predicate));
        } else if (!predicate || predicate(entryPath)) {
            found.push(entryPath);
        }
    }

    return found;
}

function createAnchor(text, fallback) {
    const anchor = String(text || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
    return anchor || fallback;
}

function escapeMarkdown(text) {
    return String(text || '').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

async function generateMarkdownFiles(month, countries = COUNTRIES, mediaTypes = MEDIA_TYPES) {
    const archiveDirectory = path.join(RANKINGS_DIR, month);
    const rankingFiles = (await listFiles(archiveDirectory, file => (
        isSelectedRankingFile(path.basename(file), countries, mediaTypes)
    ))).sort();
    const detailsCache = new Map();

    for (const rankingFile of rankingFiles) {
        const ranking = await readJson(rankingFile);
        const results = ranking.feed?.results || [];
        const toc = [];
        const sections = [];

        for (const item of results) {
            const id = String(item.id || '');
            if (!id) continue;

            if (!detailsCache.has(id)) {
                const detailPath = path.join(DETAILS_DIR, `${id}.json`);
                detailsCache.set(id, await readJson(detailPath).catch(() => null));
            }

            const details = detailsCache.get(id)?.results?.[0] || {};
            const title = details.trackName || details.collectionName || item.name || id;
            const description = details.description || details.longDescription || '';
            const anchor = createAnchor(title, id);
            const versionArtworkUrl = item.artworkUrl100 || item.artworkUrl60 || '';
            const versionLogoPath = versionArtworkUrl
                ? path.join(LOGOS_DIR, getArtworkFileName(id, versionArtworkUrl))
                : '';
            const logoFilePath = versionLogoPath && await fileExists(versionLogoPath)
                ? versionLogoPath
                : path.join(LOGOS_DIR, `${id}.png`);
            const logoPath = path.relative(
                path.dirname(rankingFile),
                logoFilePath
            ).split(path.sep).join('/');

            toc.push(`- [${escapeMarkdown(title)}](#${anchor})`);
            sections.push([
                `<a id="${anchor}"></a>`,
                `## ${title}`,
                '',
                `![${escapeMarkdown(title)}](${logoPath})`,
                '',
                description,
                '',
                item.url ? `[View on Apple](${item.url})` : ''
            ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n'));
        }

        const markdownPath = rankingFile.replace(/\.json$/i, '.md');
        await atomicWrite(markdownPath, `${toc.join('\n')}\n\n${sections.join('\n\n')}\n`);
    }

    console.log(`[markdown] generated ${rankingFiles.length} files`);
}

export async function rebuildRankingsIndex() {
    const isJson = file => file.endsWith('.json');
    const files = [
        ...await listFiles(RANKINGS_DIR, isJson),
        ...await listFiles(LISTS_DIR, isJson).catch(() => [])
    ];
    const index = await Promise.all(files.map(async filePath => {
        const fileStat = await stat(filePath);
        // No modification time: CI checkouts reset mtimes, which would make
        // every run rewrite the whole index without any real data change.
        return {
            Name: path.basename(filePath),
            RelativePath: path.relative(ROOT_DIR, filePath).split(path.sep).join('/'),
            Length: fileStat.size
        };
    }));
    index.sort((left, right) => (
        left.RelativePath < right.RelativePath ? -1 : left.RelativePath > right.RelativePath ? 1 : 0
    ));

    await atomicWrite(RANKINGS_INDEX, `${JSON.stringify(index, null, 2)}\n`);
    console.log(`[index] wrote ${index.length} ranking files`);
}

export async function runRankStage(options) {
    console.log('[stage 1/3] Downloading ranking RSS...');
    const results = await downloadRankings(options);
    console.log(`[stage 1/3] Complete: ${results.length} ranking feed(s).`);
}

export async function runDetailsStage(options) {
    console.log('[stage 2/3] Downloading detail JSON...');
    const entries = await loadAllMediaEntries(options);
    await downloadDetails(entries, options);
    console.log(`[stage 2/3] Complete: ${entries.length} unique media item(s).`);
}

export async function buildAppArchives({
    rankingsDir = RANKINGS_DIR,
    archivesDir = ARCHIVES_DIR
} = {}) {
    console.log('[archives] Building per-item historical archives...');
    await mkdir(archivesDir, { recursive: true });

    const archivesMap = new Map();

    for (const month of await listArchiveMonths(rankingsDir)) {
        const monthDir = path.join(rankingsDir, month);
        const rankingFiles = (await readdir(monthDir).catch(() => []))
            .filter(fileName => fileName.endsWith('.json'))
            .sort();

        for (const fileName of rankingFiles) {
            const parsed = parseRankingFileName(fileName);
            if (!parsed) continue;
            const { country, mediaType, feed } = parsed;

            const filePath = path.join(monthDir, fileName);
            const rankingData = await readJson(filePath).catch(() => null);
            const results = rankingData?.feed?.results || [];

            results.forEach((item, index) => {
                const id = String(item.id || '');
                if (!id) return;

                if (!archivesMap.has(id)) {
                    archivesMap.set(id, []);
                }

                archivesMap.get(id).push({
                    month,
                    country,
                    mediaType,
                    feed,
                    rank: index + 1,
                    ...item
                });
            });
        }
    }

    for (const [id, history] of archivesMap.entries()) {
        const archivePath = path.join(archivesDir, `${id}.json`);
        await atomicWrite(
            archivePath,
            `${JSON.stringify({ resultCount: history.length, results: history }, null, 2)}\n`
        );
    }

    console.log(`[archives] Complete: ${archivesMap.size} archive(s) generated.`);
    return archivesMap.size;
}

export async function runMediaStage(options) {
    console.log('[stage 3/3] Downloading media files...');
    const entries = await loadAllMediaEntries(options);
    const mediaItems = await loadMediaItems(entries);
    await downloadArtwork(mediaItems);

    await buildAppArchives();

    if (options.generateMarkdown) {
        await generateMarkdownFiles(options.month, options.countries, options.mediaTypes);
    } else {
        console.log('[markdown] skipped');
    }

    await rebuildRankingsIndex();
    console.log(`[stage 3/3] Complete: ${mediaItems.length} media item(s); archives and rankings.json published.`);
}

export async function runListsStage(options) {
    console.log('[lists] Downloading curated app details and media...');
    const lists = await loadCuratedLists(options.countries);
    if (lists.length === 0) {
        console.log('[lists] No curated lists found in lists/; nothing to do.');
        return;
    }
    const entries = mergeMediaEntries(createCuratedEntries(lists));
    await downloadDetails(entries, options);
    const mediaItems = await loadMediaItems(entries);
    await downloadArtwork(mediaItems);

    console.log('[lists] Backfilling curated lists metadata...');
    for (const list of lists) {
        if (!list.feed || !Array.isArray(list.feed.results)) continue;
        
        for (let i = 0; i < list.feed.results.length; i++) {
            const item = list.feed.results[i];
            const id = String(item.id || '');
            if (!id) continue;
            
            const detailPath = path.join(DETAILS_DIR, `${id}.json`);
            const detailsData = await readJson(detailPath).catch(() => null);
            const details = detailsData?.results?.[0];
            
            if (details) {
                item.artistName = details.artistName || item.artistName || '';
                item.id = String(details.trackId ?? details.collectionId ?? id);
                item.name = details.trackName || details.collectionName || details.name || item.name || '';
                if (details.releaseDate) {
                    item.releaseDate = details.releaseDate.slice(0, 10);
                }
                item.kind = item.kind || 'apps';
                item.artworkUrl100 = details.artworkUrl100 || details.artworkUrl60 || item.artworkUrl100 || '';
                
                if (details.genreIds && details.genres) {
                    item.genres = details.genreIds.map((genreId, idx) => ({
                        genreId: String(genreId),
                        name: details.genres[idx] || '',
                        url: `https://itunes.apple.com/genre/id${genreId}`
                    }));
                } else if (details.primaryGenreId && details.primaryGenreName) {
                    item.genres = [{
                        genreId: String(details.primaryGenreId),
                        name: details.primaryGenreName,
                        url: `https://itunes.apple.com/genre/id${details.primaryGenreId}`
                    }];
                } else {
                    item.genres = item.genres || [];
                }
                
                item.url = details.trackViewUrl || details.collectionViewUrl || details.artistViewUrl || details.url || item.url || '';
            }
        }

        const listPath = path.join(LISTS_DIR, list.fileName);
        const outputJson = {
            feed: list.feed
        };
        await atomicWrite(listPath, `${JSON.stringify(outputJson, null, 2)}\n`);
        console.log(`[lists] Updated ${list.fileName}`);
    }

    await rebuildRankingsIndex();
    console.log(`[lists] Complete: ${lists.length} list(s); ${mediaItems.length} app(s); index updated.`);
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.help) {
        printHelp();
        return;
    }

    setDataRoot(options.root);
    console.log(`Command: ${options.command}; archive month: ${options.month}`);
    console.log(`Data root: ${ROOT_DIR}`);
    console.log(`Media: ${options.mediaTypes.join(', ')}; countries: ${options.countries.join(', ')}`);
    console.log(`Limit: ${options.limit}; skip existing: ${options.skipExisting}`);
    await ensureDirectories();

    if (options.command === 'rank' || options.command === 'all') {
        await runRankStage(options);
    }
    if (options.command === 'details' || options.command === 'all') {
        await runDetailsStage(options);
    }
    if (options.command === 'media' || options.command === 'all') {
        await runMediaStage(options);
    }
    if (options.command === 'archives') {
        await buildAppArchives();
    }
    if (options.command === 'index') {
        await rebuildRankingsIndex();
    }
    if (options.command === 'lists') {
        await runListsStage(options);
    }
    console.log('Done.');
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
    main().catch(error => {
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}
