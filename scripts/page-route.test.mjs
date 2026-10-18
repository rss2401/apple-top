import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPageUrl, parsePageRoute, resolvePageSelection } from '../page-route.mjs';

const files = [
    { date: '202610', country: 'cn', mediaType: 'apps', feed: 'top-free' },
    { date: '202610', country: 'us', mediaType: 'apps', feed: 'top-free' },
    { date: '202610', country: 'fr', mediaType: 'books', feed: 'top-free' },
    { date: '202610', country: 'us', mediaType: 'books', feed: 'top-free' },
    { date: '202610', country: 'us', mediaType: 'books', feed: 'top-paid' },
    { date: '202607', country: 'jp', mediaType: 'books', feed: 'top-paid' },
    { date: 'price-lists', country: 'cn', mediaType: 'apps', feed: 'ai-subs' }
];

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

test('item hashes and comparison selections survive encoding and URL round trips', () => {
    const state = { ...files[6], appId: '6474233312', view: 'subscriptions', comparison: { month: '202610', purchase: 'Plus 年卡 & More', currency: 'CNY' } };
    const url = buildPageUrl('https://rss.2401.xyz/apple-top/?utm_source=github', state);
    assert.equal(url.hash, '#6474233312');
    assert.equal(url.searchParams.get('source'), 'subscriptions');
    assert.equal(url.searchParams.get('utm_source'), 'github');
    assert.deepEqual(parsePageRoute(url.href), state);
    assert.equal(parsePageRoute('/#pl.u-Example').appId, 'pl.u-Example');
    assert.equal(parsePageRoute('/#app-6474233312').appId, '6474233312');
});

test('closing an item removes its hash and comparison parameters while retaining filters', () => {
    const url = buildPageUrl('/?media=apps&view=subscriptions&purchase=Pro&month=202610#6474233312', files[4]);
    assert.equal(url.hash, '');
    assert.equal(url.searchParams.get('media'), 'books');
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
});
