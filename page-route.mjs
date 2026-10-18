// Shareable filters and item links, independent of the page's DOM.
const MEDIA = ['apps', 'music', 'podcasts', 'books', 'audio-books'];
const MEDIA_ALIASES = { app: 'apps', book: 'books', podcast: 'podcasts', audiobook: 'audio-books', audiobooks: 'audio-books' };
const SOURCES = { curated: 'curated', subscriptions: 'price-lists', 'price-lists': 'price-lists' };
const ROUTE_PARAMS = ['media', 'type', 'source', 'date', 'country', 'feed', 'view', 'month', 'purchase', 'currency'];
const isMonth = value => /^\d{4}(0[1-9]|1[0-2])$/.test(value || '');

export function parsePageRoute(href) {
    const url = new URL(href, 'https://example.invalid/');
    const params = url.searchParams;
    const media = (params.get('media') || params.get('type') || '').toLowerCase();
    const country = (params.get('country') || '').toLowerCase();
    const source = params.get('source') || params.get('date');
    let appId = '';
    try { appId = decodeURIComponent(url.hash.slice(1)).replace(/^app-/, ''); } catch { /* Invalid escaping is not an item ID. */ }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(appId) || appId.startsWith('json-date-')) appId = '';
    return {
        mediaType: MEDIA.includes(media) ? media : MEDIA_ALIASES[media] || '',
        date: SOURCES[source] || (isMonth(params.get('date')) ? params.get('date') : ''),
        country: /^(?:[a-z]{2}|all)$/.test(country) ? country : '',
        feed: /^[a-z0-9][a-z0-9_-]*$/.test(params.get('feed') || '') ? params.get('feed') : '',
        appId,
        view: ['details', 'subscriptions'].includes(params.get('view')) ? params.get('view') : '',
        comparison: {
            month: isMonth(params.get('month')) ? params.get('month') : '',
            purchase: params.get('purchase') || '',
            currency: /^[a-z]{3}$/i.test(params.get('currency') || '') ? params.get('currency').toUpperCase() : ''
        }
    };
}

// Resolve requested filters before choosing defaults. A Books-only URL must
// select a region that actually has books, rather than defaulting to CN/apps.
export function resolvePageSelection(files, route = {}) {
    let candidates = files.map(file => file.parsed || file).filter(file => file.date && file.mediaType && file.country && file.feed);
    for (const key of ['mediaType', 'date', 'country', 'feed']) {
        const preferred = route[key] || (key === 'mediaType' ? 'apps' : '');
        const matching = candidates.filter(file => file[key] === preferred);
        if (matching.length) candidates = matching;
    }
    const dates = [...new Set(candidates.map(file => file.date))];
    const newest = dates.filter(isMonth).sort().at(-1) || dates.sort()[0];
    return candidates.filter(file => file.date === newest).sort((a, b) =>
        a.country.localeCompare(b.country) || a.mediaType.localeCompare(b.mediaType) || a.feed.localeCompare(b.feed))[0] || null;
}

export function buildPageUrl(href, state) {
    const url = new URL(href, 'https://example.invalid/');
    ROUTE_PARAMS.forEach(key => url.searchParams.delete(key));
    if (state.mediaType) url.searchParams.set('media', state.mediaType);
    if (SOURCES[state.date]) url.searchParams.set('source', state.date === 'price-lists' ? 'subscriptions' : state.date);
    else if (isMonth(state.date)) url.searchParams.set('date', state.date);
    if (state.country) url.searchParams.set('country', state.country);
    if (state.feed) url.searchParams.set('feed', state.feed);
    url.hash = state.appId ? encodeURIComponent(state.appId) : '';
    if (state.appId) {
        if (state.view) url.searchParams.set('view', state.view);
        for (const key of ['month', 'purchase', 'currency']) {
            if (state.comparison?.[key]) url.searchParams.set(key, state.comparison[key]);
        }
    }
    return url;
}
