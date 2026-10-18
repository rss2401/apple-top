// The containing data repository supplies the media type. List file names only
// need a storefront and category: us_ai.json, cn_ai-subs.json, us_apple.json.
export function parseListFileName(fileName, mediaType = 'apps') {
    if (!/\.json$/i.test(fileName)) return null;
    const base = fileName.slice(0, -5).toLowerCase();
    const parts = base.split('_');
    if (parts.length < 2 || !/^[a-z]{2}$/.test(parts[0])) {
        // Read older published indexes while a data repository is being updated.
        return /^[a-z0-9-]+-subs$/.test(base)
            ? { country: 'us', mediaType, feed: base, priceList: true, legacyGlobal: true }
            : null;
    }
    const category = parts.slice(parts[1] === mediaType && parts.length > 2 ? 2 : 1).join('_');
    const feed = mediaType === 'apps' ? category.replace(/-apps(?=-subs$|$)/g, '') : category;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(feed)) return null;
    return { country: parts[0], mediaType, feed, priceList: feed.endsWith('-subs') };
}
