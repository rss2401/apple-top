import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPageUrl, parsePageRoute, resolvePageSelection, routeFileForIndex } from '../page-route.mjs';

const files = [
    { date: '202610', country: 'cn', mediaType: 'apps', feed: 'top-free' },
    { date: '202610', country: 'us', mediaType: 'apps', feed: 'top-free' },
    { date: '202610', country: 'fr', mediaType: 'books', feed: 'top-free' },
    { date: '202610', country: 'us', mediaType: 'books', feed: 'top-free' },
    { date: '202610', country: 'us', mediaType: 'books', feed: 'top-paid' },
    { date: '202607', country: 'jp', mediaType: 'books', feed: 'top-paid' },
    { date: 'price-lists', country: 'cn', mediaType: 'apps', feed: 'ai-subs' },
    { date: 'price-lists', country: 'us', mediaType: 'apps', feed: 'ai-subs' }
];
const indexFiles = files.map(parsed => ({
    SourceMedia: parsed.mediaType,
    RelativePath: parsed.date === 'price-lists' ? `lists/${parsed.country}_${parsed.feed}.json`
        : `rankings/${parsed.date}/${parsed.country}_${parsed.mediaType}_${parsed.feed}.json`,
    parsed
}));

test('a media-only homepage selects an available region and newest archive', () => {
    const selection = resolvePageSelection(files, parsePageRoute('/?media=books'));
    assert.deepEqual(selection, files[2]);
    assert.equal(parsePageRoute('/?media=book').mediaType, 'books');
    assert.equal(parsePageRoute('/?type=audiobook').mediaType, 'audio-books');
    assert.deepEqual(resolvePageSelection(files, {}), files[0]);
});

test('explicit filters resolve together, with safe defaults for missing combinations', () => {
    assert.deepEqual(resolvePageSelection(files, parsePageRoute('/?media=books&country=us&feed=top-paid')), files[4]);
    assert.deepEqual(resolvePageSelection(files, parsePageRoute('/?media=books&date=202607&country=jp')), files[5]);
    assert.deepEqual(resolvePageSelection(files, parsePageRoute('/?media=books&country=cn&date=202699')), files[2]);
    assert.deepEqual(resolvePageSelection(files, parsePageRoute('/?source=subscriptions&country=cn')), files[6]);
    assert.equal(resolvePageSelection([], {}), null);
});

test('a fully selected subscription URL is only its actual JSON file and item hash', () => {
    const state = { ...files[6], file: routeFileForIndex(indexFiles[6]), appId: '6474233312', view: 'subscriptions', latestMonth: '202610', comparison: { month: '202610', purchase: 'Plus 年卡 & More', currency: 'CNY' } };
    const url = buildPageUrl('https://rss.2401.xyz/apple-top/?utm_source=github', state);
    assert.equal(url.hash, '#6474233312');
    assert.equal(url.searchParams.get('file'), 'apple-top-apps/lists/cn_ai-subs.json');
    assert.equal(url.searchParams.get('utm_source'), 'github');
    assert.equal(url.href, 'https://rss.2401.xyz/apple-top/?utm_source=github&file=apple-top-apps/lists/cn_ai-subs.json#6474233312');
    assert.deepEqual(resolvePageSelection(indexFiles, parsePageRoute(url.href)), files[6]);
    for (const key of ['media', 'source', 'date', 'country', 'feed', 'view', 'month', 'purchase', 'currency']) assert.equal(url.searchParams.has(key), false);
    assert.equal(parsePageRoute('/#pl.u-Example').appId, 'pl.u-Example');
    assert.equal(parsePageRoute('/#app-6474233312').appId, '6474233312');
});

test('closing an item removes its hash and comparison parameters while retaining filters', () => {
    const url = buildPageUrl('/?media=apps&view=subscriptions&purchase=Pro&month=202610#6474233312', { ...files[4], file: routeFileForIndex(indexFiles[4]) });
    assert.equal(url.hash, '');
    assert.equal(url.search, '?file=apple-top-books/rankings/202610/us_books_top-paid.json');
    for (const key of ['view', 'purchase', 'month']) assert.equal(url.searchParams.has(key), false);
});

test('malformed or non-item hashes and invalid query values cannot become data paths', () => {
    for (const hash of ['#%E0%A4%A', '#../1', '#%3Cscript%3E', '#json-date-202610']) assert.equal(parsePageRoute('/' + hash).appId, '');
    const route = parsePageRoute('/?media=unknown&country=USA&feed=../bad&currency=badcode&month=202613&view=oops');
    assert.equal(route.mediaType, '');
    assert.equal(route.country, '');
    assert.equal(route.feed, '');
    assert.equal(route.comparison.month, '');
    assert.equal(route.comparison.currency, '');
    assert.equal(route.view, '');
    for (const file of ['https://example.com/data.json', '../../secrets.json', 'apple-top-apps/lists/../details/1.json', 'apple-top-apps/prices/202610/1.json', 'apple-top-apps/rankings/202699/us_apps_top-free.json']) {
        assert.equal(parsePageRoute('/?file=' + encodeURIComponent(file)).file, '');
    }
    assert.equal(routeFileForIndex({ SourceMedia: 'apps', RelativePath: '../secrets.json' }), '');
});

test('file links select the exact indexed JSON before any conflicting old filters', () => {
    const route = parsePageRoute('/?file=../apple-top-books/rankings/202610/us_books_top-paid.json&media=apps&country=cn');
    assert.equal(route.file, 'apple-top-books/rankings/202610/us_books_top-paid.json');
    assert.deepEqual(resolvePageSelection(indexFiles, route), files[4]);
    assert.equal(resolvePageSelection(indexFiles, parsePageRoute('/?file=apple-top-books/rankings/202501/us_books_top-paid.json')), null);
});

test('legacy global and regional list filenames resolve across published index migrations', () => {
    assert.deepEqual(resolvePageSelection(indexFiles, parsePageRoute('/?file=apple-top-apps/lists/ai-subs.json')), files[7]);
    assert.deepEqual(resolvePageSelection(indexFiles, parsePageRoute('/?source=subscriptions&country=all&feed=ai-subs')), files[7]);
    const legacy = { SourceMedia: 'apps', RelativePath: 'lists/ai-subs.json', parsed: { date: 'price-lists', country: 'all', mediaType: 'apps', feed: 'ai-subs' } };
    assert.deepEqual(resolvePageSelection([legacy], parsePageRoute('/?file=apple-top-apps/lists/us_ai-subs.json')), legacy.parsed);
    assert.deepEqual(resolvePageSelection([legacy], parsePageRoute('/?file=apple-top-apps/lists/cn_ai-subs.json')), legacy.parsed);
});

test('historical months and non-default views are retained without purchase or currency noise', () => {
    const route = parsePageRoute('/?media=apps&source=subscriptions&country=cn&view=details&month=202607&purchase=Claude+Pro+-+Monthly&currency=USD#6473753684');
    assert.equal(route.comparison.purchase, 'Claude Pro - Monthly');
    assert.equal(route.comparison.currency, 'USD');
    const url = buildPageUrl('/?purchase=Old&currency=EUR', { ...files[6], file: routeFileForIndex(indexFiles[6]), appId: route.appId, view: route.view, latestMonth: '202610', comparison: route.comparison });
    assert.equal(url.search, '?file=apple-top-apps/lists/cn_ai-subs.json&view=details&month=202607');
    assert.equal(url.hash, '#6473753684');
    assert.equal(parsePageRoute(url.href).comparison.month, '202607');
});
