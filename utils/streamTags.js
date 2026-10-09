/* Stream tags.
 *
 * A stream carries up to three fields, all optional:
 *   tag        one string, the grouping key: 'anime' | 'movie' | 'tv'
 *   tags       the same value as a one-element array, so a UI can render a badge list without special-casing
 *   tagSource  which source said so: 'provider' | 'tmdb' | 'request'
 *
 * Two different kinds of knowledge are involved and they are deliberately kept apart:
 *
 *   - providers/anime.js: its links came out of the anime numbering (absolute episode) and an AniList match,
 *     so its streams are stamped 'anime' unconditionally, whatever TMDB thinks the title is. The provider is
 *     the authority here even if the title is live action -- it did the anime work, and hiding that would
 *     only make the client re-derive it. tagSource === 'provider'.
 *   - every other provider: classified through TMDB, exactly like the rest of the pipeline. TMDB says a title
 *     is anime when it carries the animation genre and its original language is Japanese, so a mirror's
 *     stream for an anime title groups with the anime ones. tagSource === 'tmdb'.
 *
 * A stream never carries a tag it did not earn: if TMDB did not answer, only the media type can be claimed,
 * and that comes from the request itself (tagSource === 'request'), not from a lookup that never happened.
 */

const ANIME_PROVIDER = 'anime';
const ANIME = 'anime';

// The media type as this API spells it ('series') vs the tag it maps to ('tv').
const TYPE_TAG = { movie: 'movie', series: 'tv', tv: 'tv', anime: 'anime' };

function normalise(value) { return String(value || '').trim().toLowerCase(); }

// The tag a provider earns by itself, or null when it has none.
function providerTag(providerName) {
  return normalise(providerName) === ANIME_PROVIDER ? ANIME : null;
}

function typeTag(type) { return TYPE_TAG[normalise(type)] || null; }

function stamp(stream, tag, tagSource) {
  return { ...stream, tag, tags: [tag], tagSource };
}

// Applied once, in providers/registry.js, where every provider's output passes through on its way to any
// route -- so no endpoint can forget to tag the anime provider's streams.
function stampProviderTags(streams, providerName) {
  if (!Array.isArray(streams)) return [];
  const tag = providerTag(providerName);
  if (!tag) return streams;
  return streams.map(s => (s && typeof s === 'object' ? stamp(s, tag, 'provider') : s));
}

// TMDB classification for everything else. `isAnime` must be a real boolean from TMDB to be believed;
// undefined (metadata unavailable or too slow) means only the type tag can be claimed.
function applyTmdbTags(streams, { type, isAnime } = {}) {
  if (!Array.isArray(streams)) return [];
  const fallback = typeTag(type);
  const known = isAnime === true || isAnime === false;
  return streams.map(s => {
    if (!s || typeof s !== 'object') return s;
    if (s.tag) return s;                       // already decided by the provider: never overridden
    const tag = isAnime === true ? ANIME : fallback;
    if (!tag) return s;                        // nothing to claim: leave it untagged rather than guess
    return stamp(s, tag, known ? 'tmdb' : 'request');
  });
}

// Counts per tag, for a response summary so a client does not have to walk the array to draw section headers.
function tagCounts(streams) {
  const counts = {};
  for (const s of Array.isArray(streams) ? streams : []) {
    if (s && typeof s.tag === 'string' && s.tag) counts[s.tag] = (counts[s.tag] || 0) + 1;
  }
  return counts;
}

module.exports = { ANIME_PROVIDER, ANIME, providerTag, typeTag, stampProviderTags, applyTmdbTags, tagCounts };
