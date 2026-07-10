const GITHUB_RELEASES_API = 'https://api.github.com/repos/jihuaib/NetNexus/releases';
const CACHE_KEY = 'netnexus.releaseDownloadStats.v2';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PAGES = 10;
const DOWNLOAD_ASSET_EXTENSIONS = [
    '.exe',
    '.dmg',
    '.zip',
    '.appimage',
    '.msi',
    '.pkg',
    '.deb',
    '.rpm',
    '.tar.gz',
    '.tgz',
    '.7z'
];

function readCachedStats() {
    try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (!cached || !cached.cachedAt || Date.now() - cached.cachedAt > CACHE_TTL_MS) {
            return null;
        }
        return cached.stats || null;
    } catch (_) {
        return null;
    }
}

function writeCachedStats(stats) {
    try {
        localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({
                cachedAt: Date.now(),
                stats
            })
        );
    } catch (_) {
        // Cache is optional; ignore storage failures in private browsing modes.
    }
}

async function fetchReleasePage(page) {
    const response = await fetch(`${GITHUB_RELEASES_API}?per_page=100&page=${page}`, {
        headers: {
            Accept: 'application/vnd.github+json'
        }
    });

    if (!response.ok) {
        throw new Error(`GitHub releases request failed: ${response.status}`);
    }

    const releases = await response.json();
    if (!Array.isArray(releases)) {
        throw new Error('GitHub releases response is not an array');
    }
    return releases;
}

function isDownloadableAsset(asset) {
    const name = String(asset?.name || '').toLowerCase();
    return DOWNLOAD_ASSET_EXTENSIONS.some(extension => name.endsWith(extension));
}

export async function fetchReleaseDownloadStats() {
    const cached = readCachedStats();
    if (cached) {
        return { ...cached, fromCache: true };
    }

    const releases = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const releasePage = await fetchReleasePage(page);
        releases.push(...releasePage);
        if (releasePage.length < 100) {
            break;
        }
    }

    const stats = releases.reduce(
        (summary, release) => {
            const assets = Array.isArray(release.assets) ? release.assets : [];
            for (const asset of assets) {
                if (!isDownloadableAsset(asset)) {
                    continue;
                }
                summary.totalDownloads += Number(asset.download_count) || 0;
                summary.assetCount += 1;
            }
            return summary;
        },
        {
            totalDownloads: 0,
            releaseCount: releases.length,
            assetCount: 0,
            updatedAt: new Date().toISOString()
        }
    );

    writeCachedStats(stats);
    return stats;
}

function trimUnitValue(value) {
    const precision = value >= 10 ? 0 : 1;
    return value.toFixed(precision).replace(/\.0$/u, '');
}

export function formatDownloadCount(value) {
    const count = Number(value);
    if (!Number.isFinite(count)) {
        return '--';
    }
    if (count >= 100000000) {
        return `${trimUnitValue(count / 100000000)}亿`;
    }
    if (count >= 10000) {
        return `${trimUnitValue(count / 10000)}万`;
    }
    return new Intl.NumberFormat('zh-CN').format(count);
}
