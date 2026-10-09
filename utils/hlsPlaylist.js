// Generic HLS master-manifest parsing: variants, audio renditions, subtitles.
//
// This lived in providers/vixsrc.js and moved here when vixsrc was removed from the provider set (see
// CHANGELOG) because its upstream went behind a Cloudflare challenge. It is a pure function with no
// upstream dependency, and it is the only place the audio-rendition language is read out of a manifest --
// the behaviour that used to be silently dropped -- so verify-stream-meta still exercises it here without
// needing any network.

// opts.provider  display name used for the produced source (default 'HLS')
// opts.userAgent sent as the stream's User-Agent header; omitted from headers when not given
function parsePlaylist(content, masterUrl, referrerUrl, opts = {}) {
    const { provider = 'HLS', userAgent } = opts;
    const sources = [];
    const subtitles = [];
    const audioTracks = [];

    const lines = content.split('\n');

    // Audio tracks
    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) continue;
        const language = line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown';
        const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Audio';
        audioTracks.push({ language, label });
    }

    // Subtitles
    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) continue;
        const url = line.match(/URI="([^"]+)"/)?.[1];
        if (!url) continue;
        const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'unknown';
        subtitles.push({ url, label, format: 'vtt' });
    }

    // Quality variants — find the highest resolution
    const variantRegex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)[^\n]*\n([^\n]+)/g;
    let match;
    let bestResolution = 0;
    while ((match = variantRegex.exec(content)) !== null) {
        const res = parseInt(match[1], 10);
        if (res > bestResolution) bestResolution = res;
    }

    if (bestResolution === 0) return { sources: [], subtitles: [], audioTracks };

    const headers = { 'Referer': referrerUrl };
    if (userAgent) headers['User-Agent'] = userAgent;

    sources.push({
        name: `${provider} - ${bestResolution}p`,
        title: `${provider} - ${bestResolution}p`,
        url: masterUrl,
        quality: `${bestResolution}p`,
        provider,
        headers
    });

    return { sources, subtitles, audioTracks };
}

module.exports = { parsePlaylist };
