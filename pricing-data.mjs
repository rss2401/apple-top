// Shared purchase-price selection rules for app details and the Price Lists module.
const COUNTRY_ISO = { us: 'USA', cn: 'CHN', jp: 'JPN', gb: 'GBR', de: 'DEU', fr: 'FRA' };

export function selectLocalizedDetail(results, country) {
    if (!Array.isArray(results)) return null;
    const code = String(country).toLowerCase();
    const matching = results.find(item => [code, COUNTRY_ISO[code]?.toLowerCase()]
        .includes(String(item.country || '').toLowerCase()));
    // App prices must never fall back to a different country's detail record.
    return matching || results.find(item => item.wrapperType !== 'software' && !['software', 'apps'].includes(item.kind)) || null;
}

export function localStorefront(snapshot, country) {
    return snapshot?.storefronts?.[String(country).toLowerCase()] || null;
}

export function localPurchaseItems(snapshot, country) {
    const store = localStorefront(snapshot, country);
    if (!store || store.available === false) return [];
    return [...new Map((store.items || []).map(item => [JSON.stringify([item.name, item.price]), item])).values()];
}

export function purchaseNames(snapshot, country = 'us') {
    const preferred = /^[a-z]{2}$/.test(country) ? country : 'us';
    const entries = Object.entries(snapshot?.storefronts || {}).sort(([a], [b]) =>
        (a === preferred ? -1 : b === preferred ? 1 : 0) || a.localeCompare(b));
    return [...new Set(entries.flatMap(([, value]) => (value.items || []).map(item => item.name)))];
}

export function toUsd(amount, currency, rates) {
    const rate = String(currency).toUpperCase() === 'USD' ? 1 : Number(rates?.usd?.[String(currency).toLowerCase()]);
    return Number.isFinite(amount) && rate > 0 ? amount / rate : null;
}

export function comparisonRows(snapshot, rates, name) {
    const rows = Object.entries(snapshot?.storefronts || {}).map(([country, store]) => {
        const unique = new Map();
        for (const item of store.items || []) {
            if (item.name !== name) continue;
            const key = JSON.stringify([item.amount, item.price]);
            if (!unique.has(key)) unique.set(key, { ...item, usd: toUsd(item.amount, store.currency, rates) });
        }
        const items = [...unique.values()].sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity));
        return {
            country, currency: store.currency, available: store.available !== false,
            fetchedAt: store.fetchedAt || snapshot.fetchedAt,
            items, usd: items.length === 1 ? items[0].usd : null,
            minimum: items.reduce((value, item) => item.usd === null ? value : Math.min(value, item.usd), Infinity)
        };
    });
    const reference = rows.find(row => row.country === 'us' && row.available)?.usd;
    return rows.map(row => ({
        ...row,
        // Repeated names may be different billing periods. Compare only a
        // single listed amount on each side; never choose a nearest US price.
        difference: reference > 0 && row.usd !== null ? (row.usd / reference - 1) * 100 : null
    }));
}
