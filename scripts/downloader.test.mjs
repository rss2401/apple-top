import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildAppArchives,
    checkUsdRates,
    collectMediaEntries,
    createCuratedEntries,
    createDetailBatches,
    createRequestThrottle,
    currentUtcMonth,
    getArtworkFileName,
    getFeedConfigsForCountry,
    hasDetailForCountry,
    hashArtworkUrl,
    isLookupCompatibleId,
    isPriceListFile,
    main,
    mapCountryToIso,
    MEDIA_TYPES,
    mergeMediaEntries,
    parseAppStorePage,
    parseArguments,
    parsePriceAmount,
    parseRankingFileName,
    selectPriceStorefronts,
    planArtworkVersions,
    runCountryTasks,
    runSequential,
    shouldReuseCachedDetail,
    splitLookupResults,
    STOREFRONTS,
    toLargeArtworkUrl
} from './downloader.mjs';

test('parseArguments selects media types and data root', () => {
    const options = parseArguments(['rank', '--media', 'books', 'audio-books', '--root', '/data/books']);
    assert.deepEqual(options.mediaTypes, ['books', 'audio-books']);
    assert.equal(options.root, '/data/books');
    assert.deepEqual(parseArguments(['--media=PODCASTS']).mediaTypes, ['podcasts']);
    assert.deepEqual(parseArguments([]).mediaTypes, MEDIA_TYPES);
    assert.deepEqual(MEDIA_TYPES, ['apps', 'music', 'podcasts', 'books', 'audio-books']);
});

test('the default archive month is the current UTC month', () => {
    assert.equal(currentUtcMonth(new Date('2026-07-31T23:59:59Z')), '202607');
    assert.equal(currentUtcMonth(new Date('2026-08-01T00:00:00Z')), '202608');
    assert.equal(parseArguments([]).month, currentUtcMonth());
});

test('feed configs can be limited to the media types of one data repository', () => {
    const mediaOf = configs => [...new Set(configs.map(config => config.mediaType))];
    assert.deepEqual(mediaOf(getFeedConfigsForCountry('us', ['podcasts'])), ['podcasts']);
    assert.deepEqual(mediaOf(getFeedConfigsForCountry('cn', ['audio-books'])), ['audio-books']);
});

test('ranking file names split into country, media type, and feed', () => {
    assert.deepEqual(parseRankingFileName('us_audio-books_top-audio-books.json'), {
        country: 'us', mediaType: 'audio-books', feed: 'top-audio-books'
    });
    assert.equal(parseRankingFileName('cn_top-free.json'), null);
});

test('price lists are regional subscription categories, with legacy names still readable', () => {
    assert.equal(isPriceListFile('us_ai-subs.json'), true);
    assert.equal(isPriceListFile('cn_ai-subs.json'), true);
    assert.equal(isPriceListFile('us_apps_ai-apps-subs.json'), true);
    assert.equal(isPriceListFile('ai-subs.json'), true);
    assert.equal(isPriceListFile('us_ai.json'), false);
    assert.equal(isPriceListFile('us_apps_ai-apps.json'), false);
    assert.equal(isPriceListFile('ai-subs.md'), false);
});

test('archives and index commands work inside the given data root only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'apple-top-root-'));
    try {
        await mkdir(path.join(root, 'rankings', '202607'), { recursive: true });
        await mkdir(path.join(root, 'lists'), { recursive: true });
        await writeFile(
            path.join(root, 'rankings', '202607', 'us_podcasts_top-podcasts.json'),
            `${JSON.stringify({ feed: { results: [{ id: '9', name: 'Show' }] } })}\n`
        );
        await writeFile(path.join(root, 'lists', 'us_apps_demo-apps.json'), '{"feed":{"results":[]}}\n');

        const log = console.log;
        console.log = () => {};
        try {
            await main(['archives', '--root', root]);
            await main(['index', '--root', root]);
        } finally {
            console.log = log;
        }

        const archive = JSON.parse(await readFile(path.join(root, 'archives', '9.json'), 'utf8'));
        const index = JSON.parse(await readFile(path.join(root, 'rankings.json'), 'utf8'));
        assert.equal(archive.results[0].month, '202607');
        assert.deepEqual(index.map(file => file.RelativePath), [
            'lists/us_apps_demo-apps.json',
            'rankings/202607/us_podcasts_top-podcasts.json'
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('parseArguments applies defaults and supported flags', () => {
    const options = parseArguments([
        'details',
        '--skip-existing',
        '--generate-markdown',
        '--limit', '50',
        '--countries', 'cn, jp',
        '--month', '202607'
    ]);

    assert.equal(options.command, 'details');
    assert.equal(options.skipExisting, true);
    assert.equal(options.generateMarkdown, true);
    assert.equal(options.limit, 50);
    assert.deepEqual(options.countries, ['cn', 'jp']);
    assert.equal(options.month, '202607');
});

test('parseArguments defaults to the all command', () => {
    const options = parseArguments([]);
    assert.equal(options.command, 'all');
    assert.deepEqual(options.countries, ['us', 'cn', 'jp', 'gb', 'de', 'fr']);
});

test('parseArguments accepts the curated lists command', () => {
    assert.equal(parseArguments(['lists']).command, 'lists');
});

test('parseArguments selects storefronts for the prices command', () => {
    assert.equal(parseArguments(['prices']).command, 'prices');
    assert.equal(parseArguments(['prices']).storefronts, null);
    assert.equal(parseArguments(['prices']).allStorefronts, false);
    assert.equal(parseArguments(['prices', '--all-storefronts']).allStorefronts, true);
    assert.deepEqual(parseArguments(['prices', '--storefronts', 'CN', 'tr']).storefronts, ['cn', 'tr']);
    assert.deepEqual(parseArguments(['prices', '--storefronts=us,jp']).storefronts, ['us', 'jp']);
    assert.throws(() => parseArguments(['prices', '--storefronts', 'zz']), /Unsupported storefronts: zz/);
    assert.throws(() => parseArguments(['prices', '--storefronts']), /at least one/);
});

test('storefront list holds every App Store storefront once', () => {
    assert.equal(STOREFRONTS.length, 175);
    assert.equal(new Set(STOREFRONTS).size, 175);
    assert.deepEqual([...STOREFRONTS].sort(), STOREFRONTS);
});

test('localized App Store prices are parsed to numbers', () => {
    assert.equal(parsePriceAmount('$19.99'), 19.99);
    assert.equal(parsePriceAmount('USD 100.00'), 100);
    assert.equal(parsePriceAmount('¥738.00'), 738);
    assert.equal(parsePriceAmount('¥9,900'), 9900);
    assert.equal(parsePriceAmount('₹ 1,999'), 1999);
    assert.equal(parsePriceAmount('₺5.299,99'), 5299.99);
    assert.equal(parsePriceAmount('₺999,99'), 999.99);
    assert.equal(parsePriceAmount('1 299,00 kr'), 1299);
    assert.equal(parsePriceAmount('Rp 299.000'), 299000);
    assert.equal(parsePriceAmount('Rp 1.499.000,00'), 1499000);
    assert.equal(parsePriceAmount(''), null);
    assert.equal(parsePriceAmount('Free'), null);
});

function appStorePage({ storefront = 'tr', currency = 'TRY', items } = {}) {
    const serverData = {
        data: [{
            intent: { storefront, language: 'tr', $kind: 'ProductPageIntent', id: '6448311069' },
            data: {
                shelves: [{
                    id: 'information',
                    items: [
                        { $kind: 'Annotation', title: 'Sağlayıcı', summary: 'OpenAI', items: [] },
                        ...(items ? [{ $kind: 'Annotation', title: 'Uygulama İçi Satın Alımlar', items }] : [])
                    ]
                }]
            }
        }]
    };
    return `<html><script id=software-application type="application/ld+json">`
        + `{"@type":"SoftwareApplication","offers":{"@type":"Offer","price":0,"priceCurrency":"${currency}"}}</script>`
        + `<script type="application/json" id="serialized-server-data">${JSON.stringify(serverData)}</script></html>`;
}

test('App Store pages yield storefront, currency, and in-app purchases', () => {
    const page = parseAppStorePage(appStorePage({
        items: [
            { $kind: 'textPair', leadingText: 'ChatGPT Plus', trailingText: '₺999,99' },
            { $kind: 'textPair', leadingText: 'ChatGPT Pro 100', trailingText: '₺5.299,99' },
            { $kind: 'button', title: 'Learn More' }
        ]
    }));
    assert.deepEqual(page, {
        storefront: 'tr',
        currency: 'TRY',
        items: [
            { name: 'ChatGPT Plus', price: '₺999,99', amount: 999.99 },
            { name: 'ChatGPT Pro 100', price: '₺5.299,99', amount: 5299.99 }
        ]
    });
});

test('App Store pages without purchases or data are recognized', () => {
    assert.deepEqual(parseAppStorePage(appStorePage({ storefront: 'cn', currency: 'CNY' })), {
        storefront: 'cn',
        currency: 'CNY',
        items: []
    });
    // A page redirected to another storefront reports that storefront.
    assert.equal(parseAppStorePage(appStorePage({ storefront: 'cn', items: [] })).storefront, 'cn');
    assert.equal(parseAppStorePage('<html><!-- @@BODY@@ --></html>'), null);
});

test('prices are requested where the latest snapshot found the app', () => {
    const snapshot = {
        storefronts: {
            us: { currency: 'USD', items: [] },
            tr: { currency: 'TRY', items: [{ name: 'Plus', price: '₺999,99', amount: 999.99 }] },
            cn: { available: false }
        }
    };
    assert.deepEqual(selectPriceStorefronts(snapshot), ['tr', 'us']);
    assert.deepEqual(selectPriceStorefronts(null), STOREFRONTS);
    assert.deepEqual(selectPriceStorefronts(snapshot, { allStorefronts: true }), STOREFRONTS);
    assert.deepEqual(selectPriceStorefronts(snapshot, { storefronts: ['jp'] }), ['jp']);
    assert.deepEqual(selectPriceStorefronts({ storefronts: { cn: { available: false } } }), []);
});

test('USD rates are kept whole and must cover every listed currency', () => {
    const data = { date: '2026-10-17', usd: { cny: 6.7, try: 49.5, usd: 1, btc: 0.00001 } };
    assert.equal(checkUsdRates(data, ['CNY', 'TRY', 'USD']), data);
    assert.throws(() => checkUsdRates(data, ['NGN']), /no USD rate for NGN/);
});

test('parseArguments rejects invalid values and unknown flags', () => {
    assert.throws(() => parseArguments(['--limit', '0']), /positive integer/);
    assert.throws(() => parseArguments(['--month', '20260701']), /YYYYMM/);
    assert.throws(() => parseArguments(['--month', '202613']), /YYYYMM/);
    assert.throws(() => parseArguments(['--date', '20260701']), /Unknown option/);
    assert.throws(() => parseArguments(['--media', 'videos']), /Unsupported media types: videos/);
    assert.throws(() => parseArguments(['--countries']), /at least one/);
    assert.throws(() => parseArguments(['--countries', 'cn', 'ca']), /Unsupported countries: ca/);
    assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
    assert.throws(() => parseArguments(['unknown']), /Unknown command/);
});

test('parseArguments accepts comma and unquoted space-separated countries', () => {
    assert.deepEqual(parseArguments(['--countries=US,CN']).countries, ['us', 'cn']);
    assert.deepEqual(parseArguments(['--countries', 'jp', 'gb', 'de']).countries, ['jp', 'gb', 'de']);
});

test('subscriber podcast feeds are requested only in supported storefronts', () => {
    const getResources = country => getFeedConfigsForCountry(country)
        .map(config => `${config.feedType}/${config.resource}`);

    assert.equal(getResources('us').includes('top-subscriber/podcasts'), true);
    assert.equal(getResources('gb').includes('top-subscriber/podcast-channels'), true);
    assert.equal(getResources('cn').includes('top-subscriber/podcasts'), false);
    assert.equal(getResources('jp').includes('top-subscriber/podcast-channels'), false);
    assert.equal(getResources('cn').includes('top/podcast-episodes'), true);
});

test('curated app lists become normal detail and media entries', () => {
    const entries = createCuratedEntries([{
        country: 'US',
        mediaType: 'apps',
        ids: ['525463029', '899247664']
    }]);

    assert.deepEqual(entries.map(entry => entry.id), ['525463029', '899247664']);
    assert.equal(entries[0].country, 'us');
    assert.equal(entries[0].item.kind, 'apps');
});

test('curated and ranking entries share one cache entry per App ID', () => {
    const result = mergeMediaEntries(
        [{
            id: '525463029',
            country: 'us',
            item: { id: '525463029', name: 'Apple Podcasts' },
            artworkUrls: ['small.png']
        }],
        [{
            id: '525463029',
            country: 'us',
            item: { id: '525463029', kind: 'apps' },
            artworkUrls: ['large.png']
        }]
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].item.name, 'Apple Podcasts');
    assert.equal(result[0].item.kind, 'apps');
    assert.deepEqual(result[0].artworkUrls, ['small.png', 'large.png']);
});

test('curated entries shared by multiple lists are downloaded once', () => {
    const entries = createCuratedEntries([
        { id: 'ai', country: 'us', mediaType: 'apps', ids: ['6477489729'] },
        { id: 'google', country: 'us', mediaType: 'apps', ids: ['6477489729'] }
    ]);

    assert.equal(mergeMediaEntries(entries).length, 1);
});

test('runSequential processes one item at a time and preserves order', async () => {
    let active = 0;
    let maximumActive = 0;

    const result = await runSequential([1, 2, 3, 4], async value => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return value * 2;
    });

    assert.deepEqual(result, [2, 4, 6, 8]);
    assert.equal(maximumActive, 1);
});

test('runCountryTasks runs countries concurrently', async () => {
    let active = 0;
    let maximumActive = 0;
    const countries = ['us', 'cn', 'jp', 'gb', 'de', 'fr'];

    const result = await runCountryTasks(countries, async country => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return country.toUpperCase();
    });

    assert.deepEqual(result, countries.map(country => country.toUpperCase()));
    assert.equal(maximumActive, countries.length);
});

test('runCountryTasks keeps successful results after all country tasks settle', async () => {
    const completed = [];

    const result = await runCountryTasks(['us', 'cn', 'jp'], async country => {
        await new Promise(resolve => setTimeout(resolve, country === 'cn' ? 1 : 5));
        completed.push(country);
        if (country === 'cn') throw new Error('country failed');
        return country;
    });

    assert.deepEqual(completed.sort(), ['cn', 'jp', 'us']);
    assert.deepEqual(result, ['us', 'jp']);
});

test('artwork filenames include a stable short URL hash', () => {
    assert.equal(hashArtworkUrl('hello'), '4f9f2cab');
    assert.equal(getArtworkFileName('42', 'hello'), '42-4f9f2cab.png');
});

test('detail batches preserve countries and enforce the requested size', () => {
    const entries = [
        ...Array.from({ length: 26 }, (_, index) => ({ id: `us-${index}`, country: 'us' })),
        { id: 'jp-1', country: 'jp' }
    ];
    const batches = createDetailBatches(entries, 25);

    assert.deepEqual(batches.map(batch => batch.length), [25, 1, 1]);
    assert.deepEqual(batches.map(batch => [...new Set(batch.map(entry => entry.country))]), [
        ['us'],
        ['us'],
        ['jp']
    ]);
});

test('Lookup API compatibility excludes Apple Music playlist IDs', () => {
    assert.equal(isLookupCompatibleId('1896321897'), true);
    assert.equal(isLookupCompatibleId('pl.87bb5b36a9bd49db8c975607452bfa2b'), false);
});

test('lookup batch results split into the existing per-ID format', () => {
    const app = { wrapperType: 'software', trackId: 100, trackName: 'App' };
    const album = { wrapperType: 'collection', collectionId: 200, collectionName: 'Album' };
    const results = splitLookupResults(
        [{ id: '100' }, { id: '200' }, { id: '300' }],
        { resultCount: 2, results: [app, album] }
    );

    assert.equal(results.get('100'), app);
    assert.equal(results.get('200'), album);
    assert.equal(results.has('300'), false);
});

test('request throttle enforces a minimum start-to-start interval', async () => {
    let now = 1_000;
    const waits = [];
    const waitForRequestSlot = createRequestThrottle(3_250, {
        now: () => now,
        wait: async milliseconds => {
            waits.push(milliseconds);
            now += milliseconds;
        }
    });

    await waitForRequestSlot();
    now += 1_000;
    await waitForRequestSlot();
    now += 4_000;
    await waitForRequestSlot();

    assert.deepEqual(waits, [2_250]);
});

test('mapCountryToIso maps two-letter country codes to three-letter ISO codes', () => {
    assert.equal(mapCountryToIso('us'), 'USA');
    assert.equal(mapCountryToIso('cn'), 'CHN');
    assert.equal(mapCountryToIso('jp'), 'JPN');
    assert.equal(mapCountryToIso('gb'), 'GBR');
    assert.equal(mapCountryToIso('de'), 'DEU');
    assert.equal(mapCountryToIso('fr'), 'FRA');
});

test('hasDetailForCountry checks if cached details contain target country result', () => {
    const cached = {
        resultCount: 2,
        results: [
            { country: 'USA', trackName: 'US App' },
            { country: 'CHN', trackName: 'CN App' }
        ]
    };

    assert.equal(hasDetailForCountry(cached, 'us'), true);
    assert.equal(hasDetailForCountry(cached, 'cn'), true);
    assert.equal(hasDetailForCountry(cached, 'jp'), false);
});

test('buildAppArchives writes per-app history inside the given directories only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'appstore-archives-'));
    try {
        const rankingsDir = path.join(root, 'rankings');
        const archivesDir = path.join(root, 'archives');
        const feed = results => `${JSON.stringify({ feed: { results } })}\n`;

        await mkdir(path.join(rankingsDir, '202606'), { recursive: true });
        await mkdir(path.join(rankingsDir, '202607'), { recursive: true });
        await mkdir(path.join(rankingsDir, 'not-a-date'), { recursive: true });
        await writeFile(
            path.join(rankingsDir, '202606', 'us_apps_top-free.json'),
            feed([{ id: '1', name: 'One' }, { id: '2', name: 'Two' }])
        );
        await writeFile(
            path.join(rankingsDir, '202607', 'us_apps_top-free.json'),
            feed([{ id: '2', name: 'Two' }])
        );
        await writeFile(
            path.join(rankingsDir, 'not-a-date', 'us_apps_top-free.json'),
            feed([{ id: '3', name: 'Ignored' }])
        );

        const count = await buildAppArchives({ rankingsDir, archivesDir });
        const archive = JSON.parse(await readFile(path.join(archivesDir, '2.json'), 'utf8'));

        assert.equal(count, 2);
        assert.deepEqual((await readdir(archivesDir)).sort(), ['1.json', '2.json']);
        assert.deepEqual(
            archive.results.map(entry => [entry.month, entry.country, entry.mediaType, entry.feed, entry.rank]),
            [
                ['202606', 'us', 'apps', 'top-free', 2],
                ['202607', 'us', 'apps', 'top-free', 1]
            ]
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('toLargeArtworkUrl requests the large rendition of the same image', () => {
    const base = 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts221/v4/ab/cover.jpg';
    assert.equal(toLargeArtworkUrl(`${base}/100x100bb.png`), `${base}/600x600bb.jpg`);
    assert.equal(toLargeArtworkUrl(`${base}/100x150bb.png`), `${base}/600x600bb.jpg`);
    assert.equal(toLargeArtworkUrl(`${base}/512x512bb.jpg`, '1024x1024bb'), `${base}/1024x1024bb.jpg`);
    assert.equal(toLargeArtworkUrl('https://example.com/icon.png'), 'https://example.com/icon.png');
});

test('artwork versions are named by ranking URL but downloaded from that same image', () => {
    const oldUrl = 'https://is1-ssl.mzstatic.com/image/thumb/a/old.png/100x100bb.png';
    const newUrl = 'https://is1-ssl.mzstatic.com/image/thumb/a/new.png/100x100bb.png';
    const versions = planArtworkVersions('42', [oldUrl, newUrl]);

    assert.deepEqual(versions, [
        {
            sourceUrl: 'https://is1-ssl.mzstatic.com/image/thumb/a/old.png/600x600bb.jpg',
            fileName: getArtworkFileName('42', oldUrl)
        },
        {
            sourceUrl: 'https://is1-ssl.mzstatic.com/image/thumb/a/new.png/600x600bb.jpg',
            fileName: getArtworkFileName('42', newUrl)
        }
    ]);
});

test('only entries in the current archive are marked for detail refresh', () => {
    const entries = collectMediaEntries([
        { month: '202606', country: 'us', data: { feed: { results: [{ id: '1', artworkUrl100: 'a1' }, { id: '2', artworkUrl100: 'b1' }] } } },
        { month: '202607', country: 'us', data: { feed: { results: [{ id: '2', artworkUrl100: 'b2' }] } } }
    ], { refreshMonth: '202607' });

    const byId = Object.fromEntries(entries.map(entry => [entry.id, entry]));
    assert.equal(byId['1'].refresh, false);
    assert.equal(byId['2'].refresh, true);
    assert.deepEqual(byId['2'].artworkUrls, ['b1', 'b2']);
});

test('cached details are reused for history but refreshed for current entries', () => {
    const cached = { resultCount: 1, results: [{ country: 'USA' }] };
    const history = { country: 'us', refresh: false };
    const current = { country: 'us', refresh: true };

    assert.equal(shouldReuseCachedDetail(history, cached), true);
    assert.equal(shouldReuseCachedDetail(current, cached), false);
    assert.equal(shouldReuseCachedDetail(current, cached, { skipExisting: true }), true);
    assert.equal(shouldReuseCachedDetail(history, null), false);
    assert.equal(shouldReuseCachedDetail({ country: 'jp', refresh: false }, cached), false);
});

test('curated entries keep their list artwork and are always refreshed', () => {
    const [entry] = createCuratedEntries([{
        feed: { country: 'us', mediaType: 'apps', results: [{ id: '7', artworkUrl100: 'icon.png' }] }
    }]);

    assert.deepEqual(entry.artworkUrls, ['icon.png']);
    assert.equal(entry.refresh, true);
});

