import { comparisonRows, localPurchaseItems, localStorefront, purchaseNames, selectLocalizedDetail } from './pricing-data.mjs';
import { parseListFileName } from './list-files.mjs';
import { buildPageUrl, parsePageRoute, resolvePageSelection, routeFileForIndex } from './page-route.mjs';

const dateSelect = document.getElementById('dateSelect');
const countrySelect = document.getElementById('countrySelect');
const mediaTypeSelect = document.getElementById('mediaTypeSelect');
const feedSelect = document.getElementById('feedSelect');
const appGrid = document.getElementById('appGrid');
const appModal = document.getElementById('appModal');
const modalBody = document.getElementById('modalBody');
const closeModalBtn = document.querySelector('.close-modal');
const jsonListButton = document.getElementById('jsonListButton');
const themeToggle = document.getElementById('themeToggle');
const subTitle = document.querySelector('.title-sub');
let allFiles = [];
let availableDates = new Set();
let availableCountries = new Set();
let availableMediaTypes = new Set();
let availableFeeds = new Set();
let indexesReady = false;
let currentApps = [];
let activeItemRoute = null;
let lastRoutedHref = '';
let locationRequestSerial = 0;
let selectedRouteFile = '';
const subscriptionSelections = new Map();

// Source value used for files under lists/ (manually curated app collections).
const CURATED_SOURCE = 'curated';
const PRICE_LIST_SOURCE = 'price-lists';
// Price lists are not tied to a single storefront.
const ALL_REGIONS = 'all';
const LIST_SOURCES = [CURATED_SOURCE, PRICE_LIST_SOURCE];

// Extra subscription/in-app purchase snapshots, separate from the download
// price already stored in details/. Subscriptions compares them on this page.
const priceMonthsByApp = new Map();

// Each media type lives in its own data repository, published next to this
// site: rss2401.github.io/apple-top/ reads rss2401.github.io/apple-top-<media>/.
// Locally, serve the folder that contains all apple-top* checkouts side by side.
const MEDIA_TYPES = ['apps', 'music', 'podcasts', 'books', 'audio-books'];

function dataBase(mediaType) {
    return `../apple-top-${mediaType}/`;
}

function dataPath(mediaType, relativePath) {
    return `${dataBase(mediaType)}${String(relativePath).replace(/\\/g, '/')}`;
}

function selectedMediaType() {
    return mediaTypeSelect.value || 'apps';
}

function itemCountry(country = countrySelect.value) {
    return country === ALL_REGIONS ? 'us' : country;
}

// Cache for app details to avoid re-fetching
const appDetailsCache = {};

const systemThemePreference = window.matchMedia('(prefers-color-scheme: dark)');

function hashArtworkUrl(url) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < url.length; index += 1) {
        hash ^= url.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

// logos/ only holds <id>-<hash of the ranking artwork URL>.png files.
function getLogoPath(id, artworkUrl, mediaType = selectedMediaType()) {
    return artworkUrl
        ? dataPath(mediaType, `logos/${id}-${hashArtworkUrl(artworkUrl)}.png`)
        : '';
}

function setImageFallbacks(image, fallbackUrls) {
    const initialUrl = image.getAttribute('src');
    const urls = [...new Set(fallbackUrls.filter(url => url && url !== initialUrl))];
    let nextUrl = 0;

    image.addEventListener('error', () => {
        if (nextUrl >= urls.length) return;
        image.src = urls[nextUrl];
        nextUrl += 1;
    });
}

function getSavedTheme() {
    try {
        const theme = localStorage.getItem('theme');
        return theme === 'light' || theme === 'dark' ? theme : null;
    } catch {
        return null;
    }
}

function updateThemeToggle() {
    const isDark = document.documentElement.dataset.theme === 'dark';
    const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
    themeToggle.setAttribute('aria-label', label);
    themeToggle.title = label;
    themeToggle.innerHTML = isDark
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"></path></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z"></path></svg>';
}

themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
        localStorage.setItem('theme', theme);
    } catch {
        // The current page still switches even when persistence is unavailable.
    }
    updateThemeToggle();
});

systemThemePreference.addEventListener('change', event => {
    if (getSavedTheme()) return;
    document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
    updateThemeToggle();
});

updateThemeToggle();

let modalReturnFocus = null;

function openModal() {
    if (appModal.style.display !== 'flex') modalReturnFocus = document.activeElement;
    appModal.style.display = 'flex';
    document.body.classList.add('modal-open');
    modalBody.scrollTop = 0;
    closeModalBtn.focus({ preventScroll: true });
}

function closeModal({ syncUrl = true } = {}) {
    ++detailRequestSerial;
    appModal.style.display = 'none';
    document.body.classList.remove('modal-open');
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus({ preventScroll: true });
    modalReturnFocus = null;
    activeItemRoute = null;
    if (syncUrl && indexesReady) syncPageUrl({ replace: true });
}

closeModalBtn.addEventListener('click', () => closeModal());
appModal.addEventListener('click', event => {
    if (event.target === appModal) closeModal();
});
document.addEventListener('keydown', event => {
    if (appModal.style.display !== 'flex') return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
    } else if (event.key === 'Tab') {
        const controls = [...appModal.querySelectorAll('button, a[href], select, [tabindex="0"]')]
            .filter(element => !element.disabled && element.getClientRects().length);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !appModal.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !appModal.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
        }
    }
});

function fetchJson(path) {
    return fetch(path).then(response => {
        if (!response.ok) throw new Error(`Failed to load ${path}`);
        return response.json();
    });
}

// Load the rankings.json index of every data repository. A repository that is
// missing or unreachable only hides its media type.
async function loadAllIndexes() {
    const outcomes = await Promise.allSettled(MEDIA_TYPES.map(async mediaType => {
        const files = await fetchJson(dataPath(mediaType, 'rankings.json'));
        return files.map(file => ({ ...file, SourceMedia: mediaType }));
    }));

    const files = [];
    outcomes.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') files.push(...outcome.value);
        else console.warn(`Data for ${MEDIA_TYPES[index]} is unavailable:`, outcome.reason);
    });
    if (files.length === 0) throw new Error('No data repository index could be loaded.');
    return files;
}

loadAllIndexes()
    .then(async files => {
        allFiles = files;
        processFiles();
        populateDropdowns();
        jsonListButton.disabled = !allFiles.some(file => file.parsed);
        
        indexesReady = true;
        await applyLocationRoute();
    })
    .catch(err => {
        appGrid.innerHTML = `<div class="error">Unable to load data.<br>Ensure the apple-top-&lt;media&gt; data sites are published next to this site.</div>`;
        console.error(err);
    });

function selectedIndexFile() {
    const matching = allFiles.filter(file => file.parsed
        && file.parsed.date === dateSelect.value && file.parsed.country === countrySelect.value
        && file.parsed.mediaType === selectedMediaType() && file.parsed.feed === feedSelect.value);
    return matching.find(file => routeFileForIndex(file) === selectedRouteFile) || matching[0];
}

function syncPageUrl({ replace = false, item = activeItemRoute } = {}) {
    const date = dateSelect.value;
    const latestMonth = [...(priceMonthsByApp.get(item?.appId) || [])]
        .filter(month => !/^\d{6}$/.test(date) || month <= date).sort().reverse()[0];
    const url = buildPageUrl(window.location.href, {
        file: routeFileForIndex(selectedIndexFile()), date, country: countrySelect.value,
        mediaType: selectedMediaType(), feed: feedSelect.value, latestMonth, ...item
    });
    lastRoutedHref = url.href;
    if (url.href !== window.location.href) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

async function applyLocationRoute() {
    if (!indexesReady || window.location.href === lastRoutedHref) return;
    lastRoutedHref = window.location.href;
    const request = ++locationRequestSerial;
    const route = parsePageRoute(window.location.href);
    const selection = resolvePageSelection(allFiles.filter(file => file.parsed), route);
    if (!selection) {
        closeModal({ syncUrl: false });
        appGrid.innerHTML = '<div class="error">The requested JSON file is unavailable.</div>';
        return;
    }
    selectedRouteFile = route.file;
    closeModal({ syncUrl: false });
    dateSelect.value = selection.date;
    updateAvailableOptions({ loadIfComplete: false });
    countrySelect.value = selection.country;
    updateAvailableOptions({ loadIfComplete: false });
    mediaTypeSelect.value = selection.mediaType;
    updateAvailableOptions({ loadIfComplete: false });
    feedSelect.value = selection.feed;
    const view = route.view || (selection.date === PRICE_LIST_SOURCE ? 'subscriptions' : 'details');
    const item = route.appId ? { appId: route.appId, view, comparison: route.comparison } : null;
    syncPageUrl({ replace: true, item });
    const routedHref = window.location.href;
    await loadRankings({ syncUrl: false });
    if (request !== locationRequestSerial || window.location.href !== routedHref || !route.appId) return;
    let basic = currentApps.find(app => String(app.id) === route.appId);
    if (!basic) {
        const details = await getAppDetails(route.appId, selection.country, selection.mediaType);
        basic = {
            id: route.appId, name: details?.trackName || details?.collectionName || `Item ${route.appId}`,
            artistName: details?.artistName || details?.sellerName || '',
            artworkUrl100: details?.artworkUrl100 || details?.artworkUrl60 || '',
            url: details?.trackViewUrl || details?.collectionViewUrl || '',
            ...(selection.mediaType === 'apps' ? { kind: 'apps' } : {})
        };
    }
    if (request !== locationRequestSerial || window.location.href !== routedHref) return;
    const card = document.getElementById(`app-${route.appId}`);
    card?.scrollIntoView({ block: 'nearest' });
    card?.focus({ preventScroll: true });
    const navigation = { ...selection, comparison: route.comparison, syncUrl: false };
    if (view === 'subscriptions' && selection.mediaType === 'apps') await showSubscriptionDetails(basic, navigation);
    else await showAppDetails(route.appId, basic, navigation);
}

window.addEventListener('popstate', applyLocationRoute);
window.addEventListener('hashchange', applyLocationRoute);

function processFiles() {
    allFiles.forEach(file => {
        const parts = file.RelativePath.split(/[/\\]/);
        if (file.SourceMedia === 'apps' && parts[0] === 'prices' && parts.length === 3
            && /^\d+\.json$/.test(parts[2])) {
            const appId = parts[2].replace('.json', '');
            if (!priceMonthsByApp.has(appId)) priceMonthsByApp.set(appId, []);
            priceMonthsByApp.get(appId).push(parts[1]);
            return;
        }
        // rankings/YYYYMM/<file>.json or lists/<file>.json
        const isList = parts[0] === 'lists' && parts.length === 2;
        if (isList) {
            const list = parseListFileName(parts[1], file.SourceMedia);
            if (!list) return;
            const date = list.priceList ? PRICE_LIST_SOURCE : CURATED_SOURCE;
            file.parsed = { date, country: list.legacyGlobal ? ALL_REGIONS : list.country, mediaType: list.mediaType, feed: list.feed };
            availableDates.add(date);
            return;
        }
        if (parts[0] === 'rankings' && parts.length >= 3) {
            const date = parts[1];
            const filename = parts[parts.length - 1];
            const nameParts = filename.replace('.json', '').split('_');

            if (nameParts.length >= 3) {
                const country = nameParts[0];
                const mediaType = nameParts[1];
                const feed = nameParts.slice(2).join('_'); // Join rest in case feed has underscores (though we use hyphens)
                
                file.parsed = { date, country, mediaType, feed };
                availableDates.add(date);
            }
        }
    });
}

// Curated lists and price lists first, then archive dates from newest to oldest.
function compareSources(left, right) {
    const leftList = LIST_SOURCES.indexOf(left);
    const rightList = LIST_SOURCES.indexOf(right);
    if (leftList !== -1 || rightList !== -1) {
        return (leftList === -1 ? Infinity : leftList) - (rightList === -1 ? Infinity : rightList);
    }
    return right.localeCompare(left);
}

function populateDropdowns() {
    const sortedDates = Array.from(availableDates).sort(compareSources);
    sortedDates.forEach(date => {
        const option = document.createElement('option');
        option.value = date;
        option.textContent = formatDate(date);
        dateSelect.appendChild(option);
    });
}

function formatDate(dateStr) {
    if (dateStr === CURATED_SOURCE) {
        return 'Curated Lists';
    }
    if (dateStr === PRICE_LIST_SOURCE) {
        return 'Subscriptions';
    }
    if (/^\d{6}$/.test(dateStr)) {
        // YYYYMM -> YYYY-MM
        return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}`;
    }
    return dateStr;
}

function updateAvailableOptions({ selectFirstFeed = false, loadIfComplete = true } = {}) {
    const selectedDate = dateSelect.value;
    const currentCountry = countrySelect.value;
    const currentMediaType = mediaTypeSelect.value;
    const currentFeed = feedSelect.value;

    countrySelect.disabled = false;
    mediaTypeSelect.disabled = false;

    // 1. Update Country (depends on Date)
    availableCountries.clear();
    allFiles.forEach(file => {
        if (file.parsed && file.parsed.date === selectedDate) {
            availableCountries.add(file.parsed.country);
        }
    });
    
    countrySelect.innerHTML = '<option value="" disabled>Region</option>';
    const sortedCountries = Array.from(availableCountries).sort();
    sortedCountries.forEach(country => {
        const option = document.createElement('option');
        option.value = country;
        option.textContent = country === ALL_REGIONS ? 'All Regions' : country.toUpperCase();
        countrySelect.appendChild(option);
    });
    
    // Keep the previous selection if still valid, otherwise take the first option.
    countrySelect.value = availableCountries.has(currentCountry) ? currentCountry : (sortedCountries[0] || '');

    // 2. Update Media Type (depends on Date + Country)
    const selectedCountry = countrySelect.value;
    availableMediaTypes.clear();
    if (selectedCountry) {
        allFiles.forEach(file => {
            if (file.parsed && file.parsed.date === selectedDate && file.parsed.country === selectedCountry) {
                availableMediaTypes.add(file.parsed.mediaType);
            }
        });
    }
    
    mediaTypeSelect.innerHTML = '<option value="" disabled>Media Type</option>';
    const sortedMediaTypes = Array.from(availableMediaTypes).sort();
    sortedMediaTypes.forEach(type => {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        mediaTypeSelect.appendChild(option);
    });

    mediaTypeSelect.value = availableMediaTypes.has(currentMediaType) ? currentMediaType : (sortedMediaTypes[0] || '');

    // 3. Update Feed (depends on Date + Country + MediaType)
    const selectedMediaType = mediaTypeSelect.value;
    availableFeeds.clear();
    if (selectedCountry && selectedMediaType) {
        allFiles.forEach(file => {
            if (file.parsed && 
                file.parsed.date === selectedDate && 
                file.parsed.country === selectedCountry &&
                file.parsed.mediaType === selectedMediaType) {
                availableFeeds.add(file.parsed.feed);
            }
        });
    }

    feedSelect.innerHTML = '<option value="" disabled>Category</option>';
    const sortedFeeds = Array.from(availableFeeds).sort();
    sortedFeeds.forEach(feed => {
        const option = document.createElement('option');
        option.value = feed;
        option.textContent = feed.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        feedSelect.appendChild(option);
    });

    if (selectFirstFeed && sortedFeeds.length > 0) {
        feedSelect.value = sortedFeeds[0];
    } else {
        feedSelect.value = availableFeeds.has(currentFeed) ? currentFeed : (sortedFeeds[0] || '');
    }

    // If we still have a valid selection for everything, load it
    if (loadIfComplete && dateSelect.value && countrySelect.value && mediaTypeSelect.value && feedSelect.value) {
        loadRankings();
    }
}

dateSelect.addEventListener('change', () => {
    updateAvailableOptions({ selectFirstFeed: true });
});

countrySelect.addEventListener('change', () => {
    updateAvailableOptions();
});

mediaTypeSelect.addEventListener('change', () => {
    updateAvailableOptions({ selectFirstFeed: true });
});

feedSelect.addEventListener('change', () => {
    loadRankings();
});

jsonListButton.addEventListener('click', showJsonFileList);

function formatLabel(value) {
    return String(value || '')
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function formatFileSize(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

// Files in apple-top-apps/logos/; versioned logo files are never removed.
const OFFICIAL_MEDIA_LOGOS = {
    apps: { file: '375380948-428807b0.png', alt: 'Apple Store' },
    music: { file: '1598433714-a1d01ea9.png', alt: 'Apple Music Classical' },
    podcasts: { file: '525463029-1ffa6124.png', alt: 'Apple Podcasts' },
    books: { file: '364709193-8d4818f2.png', alt: 'Apple Books' },
    'audio-books': { file: '364709193-8d4818f2.png', alt: 'Apple Books' }
};

function renderMediaIcon(mediaType) {
    const official = OFFICIAL_MEDIA_LOGOS[mediaType];
    const iconIds = {
        apps: 'media-icon-apps',
        music: 'media-icon-music',
        podcasts: 'media-icon-podcasts',
        books: 'media-icon-books',
        'audio-books': 'media-icon-audio-books'
    };
    const fallbackSvgId = iconIds[mediaType] || 'media-icon-file';
    const svgFallbackHtml = `<svg viewBox="0 0 24 24" class="media-svg-icon"><use href="#${fallbackSvgId}"></use></svg>`;

    if (official) {
        return `
            <img src="${escapeHtml(dataPath('apps', `logos/${official.file}`))}"
                 alt="${escapeHtml(official.alt)}" 
                 class="media-official-logo" 
                 loading="lazy" 
                 onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='block';">
            ${svgFallbackHtml.replace('<svg ', '<svg style="display:none;" ')}
        `.trim();
    }
    return svgFallbackHtml;
}

function formatCountryName(country) {
    const names = {
        us: 'United States',
        cn: 'China',
        jp: 'Japan',
        gb: 'United Kingdom',
        de: 'Germany',
        fr: 'France',
        [ALL_REGIONS]: 'All Regions'
    };
    return names[country] || country.toUpperCase();
}

function renderJsonFileCard(file, date, selected) {
    const { country, mediaType, feed } = file.parsed;
    const isCurrent = date === selected.date
        && country === selected.country
        && mediaType === selected.mediaType
        && feed === selected.feed;
    const relativePath = dataPath(file.SourceMedia, file.RelativePath);

    return `
        <article class="json-file-card${isCurrent ? ' is-current' : ''}"
            data-date="${escapeHtml(date)}"
            data-country="${escapeHtml(country)}"
            data-media="${escapeHtml(mediaType)}"
            data-feed="${escapeHtml(feed)}"
            role="button"
            tabindex="0"
            aria-label="Switch to ${escapeHtml(country.toUpperCase())} ${escapeHtml(formatLabel(mediaType))} ${escapeHtml(formatLabel(feed))}">
            <div class="json-file-card-top">
                <span class="json-file-icon" aria-hidden="true">${renderMediaIcon(mediaType)}</span>
                <div class="json-file-identity">
                    <div class="json-file-title-row">
                        <strong>${escapeHtml(formatLabel(mediaType))}</strong>
                        ${isCurrent ? '<span class="json-current-badge">Current</span>' : ''}
                    </div>
                    <span class="json-feed-name">${escapeHtml(formatLabel(feed))}</span>
                </div>
                <span class="json-open-icon" aria-hidden="true">→</span>
            </div>
            <div class="json-file-card-footer">
                <a class="json-file-name" href="${escapeHtml(relativePath)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(file.Name)}">${escapeHtml(file.Name)}</a>
                <span class="json-file-size">${escapeHtml(formatFileSize(file.Length))}</span>
            </div>
        </article>
    `;
}

function showJsonFileList() {
    const mediaTypeOrder = ['apps', 'music', 'podcasts', 'books', 'audio-books'];
    const files = allFiles
        .filter(file => file.parsed)
        .sort((left, right) => {
            return compareSources(left.parsed.date, right.parsed.date)
                || left.parsed.country.localeCompare(right.parsed.country)
                || mediaTypeOrder.indexOf(left.parsed.mediaType) - mediaTypeOrder.indexOf(right.parsed.mediaType)
                || left.parsed.feed.localeCompare(right.parsed.feed);
        });

    const filesByDate = new Map();
    files.forEach(file => {
        if (!filesByDate.has(file.parsed.date)) filesByDate.set(file.parsed.date, []);
        filesByDate.get(file.parsed.date).push(file);
    });

    const selected = {
        date: dateSelect.value,
        country: countrySelect.value,
        mediaType: mediaTypeSelect.value,
        feed: feedSelect.value
    };

    const filesByYear = new Map();
    filesByDate.forEach((dateFiles, date) => {
        const year = LIST_SOURCES.includes(date) ? 'Lists' : date.substring(0, 4);
        if (!filesByYear.has(year)) filesByYear.set(year, []);
        filesByYear.get(year).push([date, dateFiles]);
    });

    const dateNavigation = Array.from(filesByYear, ([year, yearDates]) => `
        <div class="json-date-year-group">
            <strong class="json-date-year">${escapeHtml(year)}</strong>
            <div class="json-date-year-links">
                ${yearDates.map(([date, dateFiles]) => `
                    <a class="json-date-link${date === selected.date ? ' is-selected' : ''}" href="#json-date-${escapeHtml(date)}">
                        <span>${escapeHtml(formatDate(date))}</span>
                        <strong>${dateFiles.length}</strong>
                    </a>
                `).join('')}
            </div>
        </div>
    `).join('');

    const sections = Array.from(filesByDate, ([date, dateFiles]) => {
        const filesByCountry = new Map();
        dateFiles.forEach(file => {
            const country = file.parsed.country;
            if (!filesByCountry.has(country)) filesByCountry.set(country, []);
            filesByCountry.get(country).push(file);
        });

        const countrySections = Array.from(filesByCountry, ([country, countryFiles]) => `
            <div class="json-country-group">
                <div class="json-country-heading">
                    <span class="json-country-code">${escapeHtml(country.toUpperCase())}</span>
                    <strong>${escapeHtml(formatCountryName(country))}</strong>
                    <span>${countryFiles.length} files</span>
                </div>
                <div class="json-file-grid">
                    ${countryFiles.map(file => renderJsonFileCard(file, date, selected)).join('')}
                </div>
            </div>
        `).join('');

        return `
            <section id="json-date-${escapeHtml(date)}" class="json-archive-section">
                <div class="json-date-heading">
                    <h3>${escapeHtml(formatDate(date))}</h3>
                    <span>${dateFiles.length} files</span>
                </div>
                ${countrySections}
            </section>
        `;
    }).join('');

    modalBody.innerHTML = `
        <div class="json-list-header">
            <span class="json-list-eyebrow">Rankings index</span>
            <h2>JSON Files</h2>
            <p>${files.length} archived ranking files. Select a card to open its raw JSON data.</p>
        </div>
        <nav class="json-date-nav" aria-label="Archive dates">
            <div class="json-date-nav-summary">
                <strong>Archive dates</strong>
            </div>
            <div class="json-date-nav-links">
                ${dateNavigation}
            </div>
        </nav>
        <div class="json-list-content">
            ${sections || '<div class="error">No JSON files are available.</div>'}
        </div>
    `;
    modalBody.querySelectorAll('.json-file-card').forEach(card => {
        const selectCard = () => selectRankingFile(card.dataset);
        card.addEventListener('click', event => {
            if (!event.target.closest('.json-file-name')) selectCard();
        });
        card.addEventListener('keydown', event => {
            if (event.target.closest('.json-file-name')) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectCard();
            }
        });
    });
    appModal.classList.add('json-index-modal');
    ++detailRequestSerial;
    openModal();

    const dateNav = modalBody.querySelector('.json-date-nav');
    const updateDateAnchorOffset = () => {
        modalBody.style.setProperty('--json-date-nav-offset', `${dateNav.offsetHeight + 12}px`);
    };
    updateDateAnchorOffset();
    modalBody.querySelectorAll('.json-date-link').forEach(link => {
        link.addEventListener('click', event => {
            event.preventDefault();
            updateDateAnchorOffset();
            document.getElementById(link.getAttribute('href').slice(1))?.scrollIntoView({ block: 'start' });
        });
    });
}

function selectRankingFile({ date, country, media, feed }) {
    dateSelect.value = date;
    updateAvailableOptions({ loadIfComplete: false });

    countrySelect.value = country;
    updateAvailableOptions({ loadIfComplete: false });

    mediaTypeSelect.value = media;
    updateAvailableOptions({ loadIfComplete: false });

    feedSelect.value = feed;
    closeModal({ syncUrl: false });
    loadRankings();
}

let rankingRequestSerial = 0;
async function loadRankings({ syncUrl = true } = {}) {
    const request = ++rankingRequestSerial;
    const date = dateSelect.value;
    const country = countrySelect.value;
    const mediaType = mediaTypeSelect.value;
    const feed = feedSelect.value;

    if (!date || !country || !mediaType || !feed) return;

    if (syncUrl) {
        ++locationRequestSerial;
        closeModal({ syncUrl: false });
        syncPageUrl();
    }
    currentApps = [];

    appGrid.innerHTML = '<div class="loading">Loading charts...</div>';

    const file = selectedIndexFile();

    if (!file) {
        appGrid.innerHTML = '<div class="error">Data file not found.</div>';
        return;
    }

    const fetchPath = dataPath(file.SourceMedia, file.RelativePath);

    return fetchJson(fetchPath)
        .then(data => {
            if (request !== rankingRequestSerial) return;
            if (data.feed && data.feed.results) {
                currentApps = data.feed.results;
                subTitle.textContent = data.feed.title || '';
                if (date === PRICE_LIST_SOURCE) renderSubscriptionApps(data.feed.results);
                else renderApps(data.feed.results);
            } else {
                throw new Error("Invalid data format");
            }
        })
        .catch(err => {
            if (request !== rankingRequestSerial) return;
            appGrid.innerHTML = `<div class="error">Error loading rankings: ${escapeHtml(err.message)}</div>`;
        });
}

async function getAppDetails(appId, country = countrySelect.value, mediaType = selectedMediaType()) {
    country = itemCountry(country);
    const cacheKey = `${mediaType}:${appId}:${country}`;
    if (Object.prototype.hasOwnProperty.call(appDetailsCache, cacheKey)) {
        return appDetailsCache[cacheKey];
    }

    let details = null;
    try {
        const data = await fetchJson(dataPath(mediaType, `details/${appId}.json`));
        if (data.resultCount > 0) {
            details = selectLocalizedDetail(data.results, country);
        }
    } catch {
        // Some media types are not returned by the iTunes lookup endpoint.
    }
    appDetailsCache[cacheKey] = details;
    return details;
}

function renderApps(apps) {
    appGrid.innerHTML = '';

    apps.forEach((app, index) => {
        const item = document.createElement('div');
        item.className = 'app-item';
        item.id = `app-${app.id}`;
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `View details for ${app.name || app.id}`);
        item.onclick = () => showAppDetails(app.id, app); // Pass basic app info as backup
        item.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); }
        };

        const artworkUrl = app.artworkUrl100 || app.artworkUrl60 || '';
        const localLogoPath = getLogoPath(app.id, artworkUrl) || artworkUrl;
        const name = app.name || `App ${app.id}`;
        const artistName = app.artistName || '';
        
        item.innerHTML = `
            <img src="${escapeHtml(localLogoPath)}" alt="${escapeHtml(name)}" class="app-logo">
            <div class="app-info">
                <div class="app-header">
                    <span class="app-rank">${index + 1}</span>
                    <span class="app-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                </div>
                <div class="app-meta" title="${escapeHtml(artistName)}">
                    ${escapeHtml(artistName)}
                </div>
            </div>
        `;

        setImageFallbacks(item.querySelector('.app-logo'), [artworkUrl]);
        appGrid.appendChild(item);
    });
}

// Price lists keep the same grid, header filters, and detail modal as rankings.
// Only their card summaries and modal contents are specific to price comparison.
const comparisonRatesCache = new Map();

async function getComparisonPrices(appId, month) {
    if (!month) return null;
    if (!comparisonRatesCache.has(month)) {
        comparisonRatesCache.set(month, fetchJson(dataPath('apps', `prices/${month}/usd-rates.json`)).catch(() => null));
    }
    const [prices, rates] = await Promise.all([getAppPrices(appId, month), comparisonRatesCache.get(month)]);
    return prices ? { ...prices, rates } : null;
}

function formatConvertedPrice(usd, currency, rates) {
    const rate = currency === 'USD' ? 1 : Number(rates?.usd?.[currency.toLowerCase()]);
    return Number.isFinite(usd) && rate > 0
        ? new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(usd * rate)
        : '—';
}

function renderSubscriptionApps(apps) {
    const sourceCountry = countrySelect.value;
    appGrid.innerHTML = '';
    apps.forEach(app => {
        const item = document.createElement('div');
        item.className = 'app-item curated-app-item';
        item.id = `app-${app.id}`;
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `View subscriptions for ${app.name}`);
        item.onclick = () => showSubscriptionDetails(app);
        item.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); }
        };
        const artwork = app.artworkUrl100 || app.artworkUrl60 || '';
        item.innerHTML = `
            <img src="${escapeHtml(getLogoPath(app.id, artwork, 'apps') || artwork)}" alt="${escapeHtml(app.name)}" class="app-logo">
            <div class="app-info">
                <div class="app-header"><span class="app-name" title="${escapeHtml(app.name)}">${escapeHtml(app.name)}</span></div>
                <div class="app-meta">${escapeHtml(app.artistName)}</div>
                <div class="app-meta subscription-card-plan">Subscriptions & in-app purchases</div>
                <div class="subscription-card-price">Loading subscriptions…</div>
            </div>`;
        setImageFallbacks(item.querySelector('.app-logo'), [artwork]);
        appGrid.appendChild(item);
        const month = [...(priceMonthsByApp.get(String(app.id)) || [])].sort().reverse()[0];
        getComparisonPrices(app.id, month).then(prices => {
            if (!item.isConnected) return;
            const name = purchaseNames(prices?.data, sourceCountry)[0];
            const rows = name ? comparisonRows(prices.data, prices.rates, name).filter(row => row.available && row.items.length) : [];
            const cheapest = rows.flatMap(row => row.items).filter(entry => entry.usd !== null).sort((a, b) => a.usd - b.usd)[0];
            item.querySelector('.subscription-card-plan').textContent = name || 'No purchases listed';
            item.querySelector('.subscription-card-plan').title = name || '';
            item.querySelector('.subscription-card-price').textContent = cheapest
                ? `From ${formatConvertedPrice(cheapest.usd, 'USD', prices.rates)} · ${rows.length} region${rows.length === 1 ? '' : 's'}`
                : prices ? 'No converted amount available' : 'No subscription snapshot yet';
        });
    });
}

function renderSubscriptionPriceSection(prices, appId) {
    const names = purchaseNames(prices.data, prices.country);
    const purchase = names.includes(prices.purchase) ? prices.purchase : names[0] || '';
    const currencies = ['USD', 'EUR', 'GBP', 'CNY', 'JPY'].filter(code => code === 'USD' || prices.rates?.usd?.[code.toLowerCase()] > 0);
    const currency = currencies.includes(prices.currency) ? prices.currency : 'USD';
    const regions = comparisonRows(prices.data, prices.rates, purchase).filter(row => row.available && row.items.length);
    const rows = regions.flatMap(row => row.items.map(item => ({ ...row, item })))
        .sort((a, b) => (a.item.usd ?? Infinity) - (b.item.usd ?? Infinity) || a.country.localeCompare(b.country));
    const cheapest = rows.find(row => row.item.usd !== null);
    const unavailable = Object.entries(prices.data?.storefronts || {}).filter(([, value]) => value.available === false).map(([country]) => formatRegion(country));
    return `
        <div class="modal-section subscription-price-section">
            <h3>Subscriptions & In-App Purchases</h3>
            <div class="price-controls">
                <select class="price-item-select" aria-label="Subscription or in-app purchase"${names.length ? '' : ' disabled'}>
                    ${names.length ? names.map(name => `<option${name === purchase ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('') : '<option>No purchases listed</option>'}
                </select>
                <select class="price-month-select" aria-label="Subscription snapshot month"${prices.months.length ? '' : ' disabled'}>
                    ${prices.months.map(month => `<option value="${month}"${month === prices.month ? ' selected' : ''}>${formatDate(month)}</option>`).join('')}
                </select>
                <select class="price-currency-select" aria-label="Comparison currency">
                    ${currencies.map(code => `<option${code === currency ? ' selected' : ''}>${code}</option>`).join('')}
                </select>
            </div>
            <div class="stats-row">
                ${renderStat('LOWEST LISTED', cheapest ? formatConvertedPrice(cheapest.item.usd, currency, prices.rates) : '—', cheapest ? formatRegion(cheapest.country) : '')}
                ${renderStat('REGIONS', String(regions.length), 'Listing this purchase')}
                ${renderStat('SNAPSHOT', prices.month ? formatDate(prices.month) : '—')}
            </div>
            <div class="price-row price-row-heading"><span>Region</span><span>Listed amount</span><span class="price-usd">${currency}</span><span class="price-diff">vs US</span></div>
            <div class="price-rows">
                ${rows.length ? rows.map(row => `
                    <div class="price-row">
                        <span class="price-region">${escapeHtml(formatRegion(row.country))}<span class="price-captured">${escapeHtml(formatAppDate(row.fetchedAt))}</span></span>
                        <span class="price-local">${escapeHtml(row.item.price)}</span>
                        <span class="price-usd">${formatConvertedPrice(row.item.usd, currency, prices.rates)}</span>
                        <span class="price-diff ${row.difference < 0 ? 'cheaper' : row.difference > 0 ? 'pricier' : ''}">${row.country === 'us' ? 'US' : row.difference === null ? '—' : `${row.difference > 0 ? '+' : ''}${row.difference.toFixed(1)}%`}</span>
                    </div>`).join('') : `<p class="price-empty">${prices.missing ? 'No subscription snapshot available.' : 'No captured storefront lists this purchase.'}</p>`}
            </div>
            <p class="price-note">Original App Store purchase names and listed amounts. Apple may omit billing periods and lists up to ten purchases. Different amounts under the same name are kept separate; ambiguous names are excluded from percentage comparisons.</p>
            <p class="price-note">${prices.rates ? `Exchange rates: ${escapeHtml(prices.rates.date)}.` : 'Exchange rates unavailable; local amounts are retained.'}</p>
            ${unavailable.length ? `<p class="price-note">App unavailable: ${escapeHtml(unavailable.join(', '))}.</p>` : ''}
            ${prices.month && !prices.missing ? `<p class="price-note"><a href="${escapeHtml(dataPath('apps', `prices/${prices.month}/${appId}.json`))}" target="_blank" rel="noopener noreferrer">Snapshot JSON</a></p>` : ''}
        </div>`;
}

function setupSubscriptionPriceSection(section, prices, appId) {
    prices.purchase = section.querySelector('.price-item-select').value;
    prices.currency = section.querySelector('.price-currency-select').value;
    subscriptionSelections.set(String(appId), { purchase: prices.purchase, currency: prices.currency });
    if (activeItemRoute?.appId === String(appId) && activeItemRoute.view === 'subscriptions') {
        activeItemRoute.comparison = { month: prices.month, purchase: prices.purchase, currency: prices.currency };
        syncPageUrl({ replace: true });
    }
    section.querySelectorAll('select').forEach(select => select.addEventListener('change', async () => {
        const request = ++detailRequestSerial;
        const state = {
            month: section.querySelector('.price-month-select').value,
            purchase: section.querySelector('.price-item-select').value,
            currency: section.querySelector('.price-currency-select').value,
            months: prices.months,
            country: prices.country
        };
        Object.assign(prices, state);
        const next = await getComparisonPrices(appId, state.month);
        if (!section.isConnected || request !== detailRequestSerial) return;
        Object.assign(prices, state, next, { data: next?.data || {}, missing: !next });
        section.outerHTML = renderSubscriptionPriceSection(prices, appId);
        setupSubscriptionPriceSection(modalBody.querySelector('.subscription-price-section'), prices, appId);
    }));
}

async function showSubscriptionDetails(app, navigation = {}) {
    const request = ++detailRequestSerial;
    const replaceRoute = Boolean(activeItemRoute);
    activeItemRoute = { appId: String(app.id), view: 'subscriptions', comparison: navigation.comparison };
    if (navigation.syncUrl !== false) syncPageUrl({ replace: replaceRoute });
    const country = itemCountry(navigation.country);
    const date = navigation.date || dateSelect.value;
    const context = { ...navigation, country, date, mediaType: 'apps' };
    appModal.classList.remove('json-index-modal');
    openModal();
    modalBody.innerHTML = '<div class="loading">Loading subscriptions...</div>';
    const months = [...(priceMonthsByApp.get(String(app.id)) || [])]
        .filter(month => !/^\d{6}$/.test(date) || month <= date).sort().reverse();
    const month = months.includes(navigation.comparison?.month) ? navigation.comparison.month : months[0] || '';
    const next = await getComparisonPrices(app.id, month);
    if (request !== detailRequestSerial) return;
    const remembered = subscriptionSelections.get(String(app.id));
    const prices = {
        ...navigation.comparison, ...next, month, months, country, data: next?.data || {}, missing: !next,
        purchase: navigation.comparison?.purchase || remembered?.purchase,
        currency: navigation.comparison?.currency || remembered?.currency
    };
    const artwork = app.artworkUrl100 || app.artworkUrl60 || '';
    modalBody.innerHTML = `
        <div class="modal-header-section">
            <img src="${escapeHtml(getLogoPath(app.id, artwork, 'apps') || artwork)}" alt="${escapeHtml(app.name)}" class="modal-icon">
            <div class="modal-title-info"><h2>${escapeHtml(app.name)}</h2><div class="modal-subtitle">${escapeHtml(app.artistName)}</div>
                <div class="modal-actions">
                    <a href="${escapeHtml(app.url)}" target="_blank" rel="noopener noreferrer" class="get-button">App Store</a>
                    <button type="button" class="get-button modal-view-button">App Details</button>
                </div>
            </div>
        </div>
        ${renderSubscriptionPriceSection(prices, app.id)}`;
    setImageFallbacks(modalBody.querySelector('.modal-icon'), [artwork]);
    modalBody.querySelector('.modal-view-button').onclick = () => showAppDetails(app.id, app, {
        ...context, comparison: { month: prices.month, purchase: prices.purchase, currency: prices.currency }
    });
    setupSubscriptionPriceSection(modalBody.querySelector('.subscription-price-section'), prices, app.id);
}

const appArchiveCache = {};

async function getAppArchive(appId, mediaType = selectedMediaType()) {
    const cacheKey = `${mediaType}:${appId}`;
    if (Object.prototype.hasOwnProperty.call(appArchiveCache, cacheKey)) {
        return appArchiveCache[cacheKey];
    }
    let archive = null;
    try {
        archive = await fetchJson(dataPath(mediaType, `archives/${appId}.json`));
    } catch {
        // Archives might not exist for non-ranking items
    }
    appArchiveCache[cacheKey] = archive;
    return archive;
}

function renderArchiveSection(archive, appId) {
    const results = Array.isArray(archive?.results) ? archive.results : (Array.isArray(archive?.history) ? archive.history : []);
    if (results.length === 0) {
        return '';
    }

    const monthOf = entry => String(entry.month || entry.date || '');
    const sortedHistory = [...results].sort((a, b) => monthOf(b).localeCompare(monthOf(a)));
    const countries = [...new Set(sortedHistory.map(h => h.country))].sort();

    const historyItemsHtml = sortedHistory.map(entry => {
        const logoUrl = entry.artworkUrl100 || entry.artworkUrl60 || entry.artworkUrl || '';
        const versionedLogo = getLogoPath(appId, logoUrl) || logoUrl;
        const formattedDate = formatDate(monthOf(entry));
        const countryCode = (entry.country || 'us').toUpperCase();
        const feedLabel = (entry.feed || '').replace(/-/g, ' ');
        const rankClass = entry.rank <= 3 ? ` rank-top-${entry.rank}` : '';

        return `
            <div class="archive-history-item" data-country="${escapeHtml(entry.country)}">
                <img src="${escapeHtml(versionedLogo)}" alt="${escapeHtml(entry.name || '')}" class="archive-history-icon" loading="lazy" data-fallback="${escapeHtml(logoUrl)}">
                <div class="archive-history-content">
                    <div class="archive-history-top">
                        <span class="archive-date-badge">${escapeHtml(formattedDate)}</span>
                        <span class="archive-country-badge">${escapeHtml(countryCode)}</span>
                        <span class="archive-rank-badge${rankClass}">#${entry.rank}</span>
                    </div>
                    <div class="archive-history-name">${escapeHtml(entry.name || '')}</div>
                    <div class="archive-history-meta">${escapeHtml(entry.artistName || '')} • ${escapeHtml(feedLabel)}</div>
                </div>
            </div>
        `;
    }).join('');

    return `
        <div class="modal-section archive-section">
            <h3>Ranking & Icon History (${results.length})</h3>
            ${countries.length > 1 ? `
                <div class="archive-filter-tabs">
                    <button class="archive-tab active" data-filter="all">All (${results.length})</button>
                    ${countries.map(c => `<button class="archive-tab" data-filter="${escapeHtml(c)}">${escapeHtml(c.toUpperCase())}</button>`).join('')}
                </div>
            ` : ''}
            <div class="archive-history-list">
                ${historyItemsHtml}
            </div>
        </div>
    `;
}

function setupArchiveTabs(container) {
    const tabs = container.querySelectorAll('.archive-tab');
    const items = container.querySelectorAll('.archive-history-item');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const filter = tab.dataset.filter;
            items.forEach(item => {
                if (filter === 'all' || item.dataset.country === filter) {
                    item.style.display = 'flex';
                } else {
                    item.style.display = 'none';
                }
            });
        });
    });

    container.querySelectorAll('.archive-history-icon').forEach(img => {
        const fallback = img.dataset.fallback;
        if (fallback) setImageFallbacks(img, [fallback]);
    });
}

let detailRequestSerial = 0;
async function showAppDetails(appId, basicAppInfo, navigation = {}) {
    const request = ++detailRequestSerial;
    const replaceRoute = Boolean(activeItemRoute);
    activeItemRoute = { appId: String(appId), view: 'details', comparison: navigation.comparison };
    if (navigation.syncUrl !== false) syncPageUrl({ replace: replaceRoute });
    appModal.classList.remove('json-index-modal');
    modalBody.innerHTML = '<div class="loading">Loading details...</div>';
    openModal();
    const currentCountry = itemCountry(navigation.country);
    const mediaType = navigation.mediaType || selectedMediaType();
    const date = navigation.date || dateSelect.value;
    const priceMonths = mediaType === 'apps'
        ? [...(priceMonthsByApp.get(String(appId)) || [])]
            .filter(month => !/^\d{6}$/.test(date) || month <= date).sort().reverse()
        : [];
    const month = priceMonths.includes(navigation.comparison?.month) ? navigation.comparison.month : priceMonths[0];
    const [details, archive, prices] = await Promise.all([
        getAppDetails(appId, currentCountry, mediaType),
        getAppArchive(appId, mediaType),
        month ? getAppPrices(appId, month) : null
    ]);
    if (request !== detailRequestSerial) return;
    renderModalContent(details, appId, basicAppInfo, archive,
        prices && { ...prices, months: priceMonths, country: currentCountry },
        { ...navigation, country: currentCountry, mediaType, date });
    activeItemRoute.comparison = { ...navigation.comparison, month: prices?.month || '' };
    syncPageUrl({ replace: true });
}

const appPricesCache = {};
async function getAppPrices(appId, month) {
    const key = month + ':' + appId;
    if (!Object.hasOwn(appPricesCache, key)) {
        appPricesCache[key] = fetchJson(dataPath('apps', 'prices/' + month + '/' + appId + '.json'))
            .then(data => ({ month, data })).catch(() => null);
    }
    return appPricesCache[key];
}

const regionNames = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function formatRegion(code) {
    try { return regionNames?.of(String(code).toUpperCase()) || String(code).toUpperCase(); }
    catch { return String(code).toUpperCase(); }
}

function renderPriceSection(prices) {
    if (!prices) return '';
    const store = localStorefront(prices.data, prices.country);
    const unique = localPurchaseItems(prices.data, prices.country);
    if (unique.length === 0) return '';
    return '<div class="modal-section price-section">'
        + '<h3>Subscriptions & In-App Purchases · ' + escapeHtml(formatRegion(prices.country)) + '</h3>'
        + (prices.months.length > 1 ? '<div class="price-controls"><select class="price-month-select" aria-label="Subscription snapshot month">'
            + prices.months.map(month => '<option value="' + month + '"' + (month === prices.month ? ' selected' : '') + '>' + formatDate(month) + '</option>').join('')
            + '</select></div>' : '')
        + '<div class="price-rows">' + unique.map(item =>
            '<div class="local-price-row"><span>' + escapeHtml(item.name) + '</span><strong>' + escapeHtml(item.price) + '</strong></div>'
        ).join('') + '</div>'
        + '<p class="price-note">App Store · ' + escapeHtml(prices.country.toUpperCase()) + ' · '
        + escapeHtml(formatAppDate(store?.fetchedAt || prices.data.fetchedAt))
        + '. Prices are shown in this region’s currency. Apple lists up to ten purchases and may omit billing periods.</p></div>';
}

function setupPriceSection(section, prices, appId, navigation) {
    if (!section) return;
    section.querySelector('.price-month-select')?.addEventListener('change', async event => {
        const month = event.target.value;
        const next = await getAppPrices(appId, month);
        if (!section.isConnected || event.target.value !== month) return;
        if (navigation?.comparison) navigation.comparison.month = month;
        if (activeItemRoute?.appId === String(appId) && activeItemRoute.view === 'details') {
            activeItemRoute.comparison = { ...activeItemRoute.comparison, month };
            syncPageUrl({ replace: true });
        }
        const nextPrices = { month, data: next?.data || {}, months: prices.months, country: prices.country };
        section.outerHTML = renderPriceSection(nextPrices);
        setupPriceSection(modalBody.querySelector('.price-section'), nextPrices, appId, navigation);
    });
}

function formatAppDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;

    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatGenres(genres) {
    if (!Array.isArray(genres)) return '';
    return genres
        .map(genre => typeof genre === 'string' ? genre : genre?.name)
        .filter(Boolean)
        .join(', ');
}

function formatMediaType(kind) {
    const labels = {
        apps: 'App',
        software: 'App',
        songs: 'Song',
        song: 'Song',
        albums: 'Album',
        album: 'Album',
        podcasts: 'Podcast',
        podcast: 'Podcast',
        books: 'Book',
        'audio-books': 'Audiobook'
    };

    return labels[kind] || kind || 'Media';
}

function formatPrice(app) {
    if (app.formattedPrice) return app.formattedPrice;

    const price = app.trackPrice ?? app.collectionPrice;
    if (price === undefined || price === null) return '';
    if (Number(price) === 0) return 'Free';

    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: app.currency || 'USD'
        }).format(price);
    } catch {
        return `${price} ${app.currency || ''}`.trim();
    }
}

function formatDuration(milliseconds) {
    if (!milliseconds) return '';
    const totalSeconds = Math.round(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function renderStat(label, value, sub = '') {
    return `
        <div class="stat-item">
            <div class="stat-label">${escapeHtml(label)}</div>
            <div class="stat-value">${escapeHtml(value || '-')}</div>
            ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}
        </div>
    `;
}

function renderInfoRows(rows) {
    return rows
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([label, value]) => `
            <div class="info-row">
                <span>${escapeHtml(label)}</span>
                <span>${escapeHtml(value)}</span>
            </div>
        `)
        .join('');
}

function renderModalContent(details, appId, basicAppInfo, archive, prices = null, navigation = {}) {
    const app = details || {};
    const title = app.trackName || app.collectionName || basicAppInfo.name || 'Untitled';
    const subtitle = app.artistName || app.sellerName || basicAppInfo.artistName || '';
    const kind = basicAppInfo.kind || app.kind || app.collectionType?.toLowerCase() || app.wrapperType;
    const mediaType = formatMediaType(kind);
    const isSoftware = app.wrapperType === 'software' || app.kind === 'software' || kind === 'apps';
    const artworkUrl = app.artworkUrl600
        || app.artworkUrl512
        || app.artworkUrl100
        || app.artworkUrl60
        || basicAppInfo.artworkUrl100
        || basicAppInfo.artworkUrl60
        || '';
    const versionArtworkUrl = basicAppInfo.artworkUrl100
        || basicAppInfo.artworkUrl60
        || artworkUrl;
    const localLogoPath = getLogoPath(appId, versionArtworkUrl, navigation.mediaType) || versionArtworkUrl;
    const storeUrl = app.trackViewUrl || app.collectionViewUrl || basicAppInfo.url || '#';
    const price = formatPrice(app);
    const genres = formatGenres(app.genres) || app.primaryGenreName || formatGenres(basicAppInfo.genres);
    const releaseDate = formatAppDate(app.releaseDate || basicAppInfo.releaseDate);
    const description = app.description || app.longDescription || '';
    const sizeMB = app.fileSizeBytes ? `${(app.fileSizeBytes / 1024 / 1024).toFixed(1)} MB` : '';

    const screenshotsHtml = Array.isArray(app.screenshotUrls) && app.screenshotUrls.length > 0 ?
        `<div class="screenshots-scroll">
            ${app.screenshotUrls.map(url => `<img src="${escapeHtml(url)}" class="screenshot" loading="lazy" alt="">`).join('')}
         </div>` : '';

    let statsHtml;
    let informationRows;

    if (isSoftware) {
        const rating = Number(app.averageUserRating);
        const ratingCount = app.userRatingCountForCurrentVersion || app.userRatingCount || 0;
        statsHtml = [
            renderStat('RATING', Number.isFinite(rating) ? `${rating.toFixed(1)} ★` : '-', `${ratingCount.toLocaleString()} Ratings`),
            renderStat('AGE', app.contentAdvisoryRating || '-'),
            renderStat('CATEGORY', genres || 'App')
        ].join('');

        informationRows = [
            ['Provider', app.sellerName || subtitle],
            ['Size', sizeMB],
            ['Version', app.version],
            ['Original Release', releaseDate],
            ['Last Update', formatAppDate(app.currentVersionReleaseDate)],
            ['Compatibility', app.minimumOsVersion ? `${app.minimumOsVersion}+` : '']
        ];
    } else {
        const itemCount = app.trackCount
            ? `${app.trackCount.toLocaleString()} ${app.kind === 'podcast' ? 'Episodes' : 'Tracks'}`
            : '';
        statsHtml = [
            renderStat('TYPE', mediaType),
            renderStat('GENRE', genres || '-'),
            renderStat(app.kind === 'podcast' ? 'EPISODES' : 'RELEASED', app.kind === 'podcast' ? itemCount : releaseDate)
        ].join('');

        informationRows = [
            [mediaType === 'Book' || mediaType === 'Audiobook' ? 'Author' : 'Artist', subtitle],
            ['Album', app.collectionName && app.collectionName !== title ? app.collectionName : ''],
            ['Genre', genres],
            ['Release', releaseDate],
            ['Duration', app.kind === 'song' ? formatDuration(app.trackTimeMillis) : ''],
            [app.kind === 'podcast' ? 'Episodes' : 'Tracks', itemCount],
            ['Advisory', app.contentAdvisoryRating],
            ['Country', app.country],
            ['Copyright', app.copyright]
        ];
    }

    const archiveHtml = renderArchiveSection(archive, appId);
    const canCompare = isSoftware && (navigation.comparison || Object.values(prices?.data?.storefronts || {})
        .some(store => store.available !== false && store.items?.length));
    if (canCompare) navigation.comparison = { ...navigation.comparison, month: prices?.month || navigation.comparison?.month };

    modalBody.innerHTML = `
        <div class="modal-header-section">
            <img src="${escapeHtml(localLogoPath)}" alt="${escapeHtml(title)}" class="modal-icon">
            <div class="modal-title-info">
                <h2>${escapeHtml(title)}</h2>
                <div class="modal-subtitle">${escapeHtml(subtitle)}</div>
                <div class="modal-actions">
                    <a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener noreferrer" class="get-button">${escapeHtml(price || 'View on Apple')}</a>
                    ${canCompare ? '<button type="button" class="get-button modal-view-button">Subscriptions</button>' : ''}
                </div>
            </div>
        </div>

        <div class="stats-row">
            ${statsHtml}
        </div>

        ${screenshotsHtml}

        ${description ? `
            <div class="modal-section">
                <p class="description">${escapeHtml(description).replace(/\n/g, '<br>')}</p>
            </div>
        ` : ''}

        <div class="modal-section">
            <h3>Information</h3>
            ${renderInfoRows(informationRows)}
        </div>

        ${renderPriceSection(prices)}

        ${archiveHtml}
    `;

    setImageFallbacks(
        modalBody.querySelector('.modal-icon'),
        [versionArtworkUrl]
    );

    modalBody.querySelector('.modal-view-button')?.addEventListener('click', () => showSubscriptionDetails({
        ...basicAppInfo, id: String(appId), kind: 'apps', name: title, artistName: subtitle,
        artworkUrl100: versionArtworkUrl, url: storeUrl
    }, navigation));

    const priceSection = modalBody.querySelector('.price-section');
    if (priceSection) setupPriceSection(priceSection, prices, appId, navigation);

    if (archiveHtml) {
        setupArchiveTabs(modalBody.querySelector('.archive-section'));
    }
}
