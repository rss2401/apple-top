import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseListFileName } from '../list-files.mjs';
import { getDetailForCountry, loadPriceListApps, setDataRoot } from './downloader.mjs';
import { purchaseNames } from '../pricing-data.mjs';

test('regional list names get media from the containing repository', () => {
    assert.deepEqual(parseListFileName('cn_ai-subs.json'), { country: 'cn', mediaType: 'apps', feed: 'ai-subs', priceList: true });
    assert.deepEqual(parseListFileName('us_ai.json'), { country: 'us', mediaType: 'apps', feed: 'ai', priceList: false });
    assert.deepEqual(parseListFileName('us_apple.json'), { country: 'us', mediaType: 'apps', feed: 'apple', priceList: false });
    assert.deepEqual(parseListFileName('us_favorites.json', 'books'), { country: 'us', mediaType: 'books', feed: 'favorites', priceList: false });
    assert.equal(parseListFileName('cn_ai-subs.md'), null);
    assert.equal(parseListFileName('usd-rates.json'), null);
});

test('legacy list names resolve to the same categories while old indexes remain published', () => {
    assert.deepEqual(parseListFileName('us_apps_ai-apps.json'), parseListFileName('us_ai.json'));
    assert.deepEqual(parseListFileName('cn_apps_ai-apps-subs.json'), parseListFileName('cn_ai-subs.json'));
    assert.deepEqual(parseListFileName('us_apps_apple-apps.json'), parseListFileName('us_apple.json'));
    assert.equal(parseListFileName('ai-subs.json').legacyGlobal, true);
});

test('list metadata and default purchase names follow the source country', () => {
    const us = { country: 'USA', trackName: 'US app' };
    const cn = { country: 'CHN', trackName: '国区应用' };
    assert.equal(getDetailForCountry({ results: [us, cn] }, 'cn'), cn);
    assert.equal(getDetailForCountry({ results: [us, cn] }, 'us'), us);
    assert.equal(getDetailForCountry({ results: [us] }, 'cn'), null);
    const snapshot = { storefronts: { us: { items: [{ name: 'Monthly' }] }, cn: { items: [{ name: '连续包月' }] } } };
    assert.deepEqual(purchaseNames(snapshot, 'cn'), ['连续包月', 'Monthly']);
    assert.deepEqual(purchaseNames(snapshot, 'us'), ['Monthly', '连续包月']);
});

test('price collection filters regional lists and deduplicates shared products', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'apple-top-list-test-'));
    try {
        await mkdir(path.join(root, 'lists'));
        const list = ids => JSON.stringify({ feed: { results: ids.map(id => ({ id, name: 'App ' + id })) } });
        await writeFile(path.join(root, 'lists', 'us_ai-subs.json'), list(['1', '2']));
        await writeFile(path.join(root, 'lists', 'cn_ai-subs.json'), list(['2', '3']));
        await writeFile(path.join(root, 'lists', 'cn_ai.json'), list(['999']));
        setDataRoot(root);
        assert.deepEqual((await loadPriceListApps(['us'])).map(app => app.id), ['1', '2']);
        assert.deepEqual((await loadPriceListApps(['cn'])).map(app => app.id), ['2', '3']);
        assert.deepEqual((await loadPriceListApps()).map(app => app.id).sort(), ['1', '2', '3']);
        assert.deepEqual(await loadPriceListApps(['jp']), []);
    } finally {
        setDataRoot(process.cwd());
        assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'apple-top-list-test-')));
        await rm(root, { recursive: true, force: true });
    }
});
