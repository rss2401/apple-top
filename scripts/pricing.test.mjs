import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { comparisonRows, localPurchaseItems, localStorefront, purchaseNames, selectLocalizedDetail, toUsd } from '../pricing-data.mjs';
import { main, planAppPurchaseRequests, runAppPurchasePricesStage, setDataRoot } from './downloader.mjs';

test('app details and local purchases never fall back to another region', () => {
    const us = { country: 'USA', wrapperType: 'software', formattedPrice: '$9.99' };
    const cn = { country: 'CHN', wrapperType: 'software', formattedPrice: '¥68' };
    assert.equal(selectLocalizedDetail([us, cn], 'cn'), cn);
    assert.equal(selectLocalizedDetail([us], 'jp'), null);
    assert.equal(selectLocalizedDetail([{ kind: 'apps', country: 'USA' }], 'cn'), null);
    assert.equal(selectLocalizedDetail([{ kind: 'song', country: 'USA' }], 'cn').kind, 'song');
    const snapshot = { storefronts: { us: { items: [{ name: 'Pro', price: '$20' }] }, cn: { available: false } } };
    assert.equal(localStorefront(snapshot, 'JP'), null);
    assert.deepEqual(localStorefront(snapshot, 'cn'), { available: false });
    assert.equal(localStorefront(snapshot, 'US'), snapshot.storefronts.us);
    assert.deepEqual(localPurchaseItems(snapshot, 'jp'), []);
    assert.deepEqual(localPurchaseItems(snapshot, 'cn'), []);
    assert.deepEqual(localPurchaseItems({ storefronts: { us: { items: [] } } }, 'us'), []);
    assert.deepEqual(localPurchaseItems(snapshot, 'us'), [{ name: 'Pro', price: '$20' }]);
});

test('regional app capture follows current rankings and curated entries only', () => {
    const entry = (id, country, kind, refresh) => ({ id, country, item: { kind, name: 'Demo' }, refresh });
    assert.deepEqual(planAppPurchaseRequests([
        entry('1', 'us', 'apps', true), entry('1', 'cn', 'apps', true), entry('1', 'us', 'apps', true),
        entry('2', 'jp', 'apps', false), entry('3', 'us', 'podcasts', true), entry('4', 'all', 'apps', true)
    ]), [{ id: '1', name: 'Demo', storefronts: ['cn', 'us'] }]);
});

test('comparisons preserve different amounts under one name and omit ambiguous percentages', () => {
    const item = (amount, price = '$' + amount) => ({ name: 'Plus', amount, price });
    const snapshot = { fetchedAt: '2026-10-18', storefronts: {
        us: { currency: 'USD', items: [item(20), item(200)] },
        cn: { currency: 'CNY', items: [item(100, '¥100'), item(100, '¥100')] },
        jp: { available: false }
    } };
    const rates = { usd: { cny: 5 } };
    const rows = comparisonRows(snapshot, rates, 'Plus');
    assert.equal(rows.find(row => row.country === 'us').items.length, 2);
    assert.equal(rows.find(row => row.country === 'cn').items.length, 1);
    assert.equal(rows.find(row => row.country === 'cn').usd, 20);
    assert.ok(rows.every(row => row.difference === null));
    assert.equal(rows.find(row => row.country === 'jp').available, false);
    snapshot.storefronts.us.items = [item(25)];
    assert.ok(Math.abs(comparisonRows(snapshot, rates, 'Plus').find(row => row.country === 'cn').difference + 20) < 1e-8);
    assert.deepEqual(purchaseNames(snapshot), ['Plus']);
    assert.equal(toUsd(100, 'CNY', null), null);
    assert.equal(toUsd(null, 'USD', rates), null);
    assert.equal(toUsd(20, 'USD', null), 20);
});

test('details keeps the existing download price and adds optional in-app purchases separately', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'apple-top-price-test-'));
    const previousFetch = globalThis.fetch;
    const requests = [];
    try {
        await mkdir(path.join(root, 'rankings', '202610'), { recursive: true });
        await mkdir(path.join(root, 'details'), { recursive: true });
        await mkdir(path.join(root, 'prices', '202610'), { recursive: true });
        await writeFile(path.join(root, 'rankings', '202610', 'us_apps_top-free.json'), JSON.stringify({ feed: { results: [{ id: '1', kind: 'apps', name: 'Demo' }] } }));
        const detailContents = JSON.stringify({ resultCount: 1, results: [{ trackId: 1, kind: 'software', wrapperType: 'software', country: 'USA', price: 0, formattedPrice: 'Free' }] });
        await writeFile(path.join(root, 'details', '1.json'), detailContents);
        await writeFile(path.join(root, 'prices', '202610', '1.json'), JSON.stringify({ id: '1', fetchedAt: '2026-10-01', storefronts: { jp: { currency: 'JPY', items: [] } } }));
        const serverData = { data: [{ intent: { $kind: 'ProductPageIntent', storefront: 'us' }, data: { shelves: [{ items: [{ $kind: 'Annotation', items: [{ $kind: 'textPair', leadingText: 'Pro', trailingText: '$20' }] }] }] } }] };
        const page = '<script id="software-application" type="application/ld+json">' + JSON.stringify({ '@type': 'SoftwareApplication', offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' } })
            + '</script><script id="serialized-server-data" type="application/json">' + JSON.stringify(serverData) + '</script>';
        globalThis.fetch = async url => { requests.push(url); return new Response(page); };
        const args = ['details', '--root', root, '--media', 'apps', '--countries', 'us', '--month', '202610', '--skip-existing'];
        await main(args);
        const saved = JSON.parse(await readFile(path.join(root, 'prices', '202610', '1.json'), 'utf8'));
        assert.deepEqual(requests, ['https://apps.apple.com/us/app/id1']);
        assert.deepEqual(saved.storefronts.us.items, [{ name: 'Pro', price: '$20', amount: 20 }]);
        assert.equal(await readFile(path.join(root, 'details', '1.json'), 'utf8'), detailContents);
        assert.equal(saved.storefronts.jp.fetchedAt, '2026-10-01');
        assert.ok(saved.storefronts.us.fetchedAt);
        await main(args);
        assert.equal(requests.length, 1);
        globalThis.fetch = async () => new Response('', { status: 404 });
        await runAppPurchasePricesStage([{ id: '2', country: 'cn', refresh: true, item: { kind: 'apps' } }], { month: '202610' });
        const unavailable = JSON.parse(await readFile(path.join(root, 'prices', '202610', '2.json'), 'utf8'));
        assert.equal(unavailable.storefronts.cn.available, false);
        assert.deepEqual(Object.keys(unavailable.storefronts), ['cn']);
        const pageWithoutPurchases = page.replace(JSON.stringify(serverData), JSON.stringify({ data: [{ intent: { $kind: 'ProductPageIntent', storefront: 'us' } }] }));
        globalThis.fetch = async () => new Response(pageWithoutPurchases);
        await runAppPurchasePricesStage([{ id: '3', country: 'us', refresh: true, item: { kind: 'apps' } }], { month: '202610' });
        const withoutPurchases = JSON.parse(await readFile(path.join(root, 'prices', '202610', '3.json'), 'utf8'));
        assert.deepEqual(withoutPurchases.storefronts.us.items, []);
    } finally {
        globalThis.fetch = previousFetch;
        setDataRoot(process.cwd());
        assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'apple-top-price-test-')));
        await rm(root, { recursive: true, force: true });
    }
});
