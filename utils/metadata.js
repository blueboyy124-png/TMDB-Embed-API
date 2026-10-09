/* Title + episode metadata, merged from TMDB and AniList.
 *
 * Why this exists: the stream endpoints used to return metadata for movies only, and only the anime
 * provider knew anything about AniList. A client therefore had to call TMDB itself, twice, to draw a title
 * screen, and every provider had a different idea of what a show was called. One endpoint that answers
 * "what is this, and what is this episode" for every provider keeps that logic in one place.
 *
 * Rule: this never throws and never blocks playback. A missing piece comes back null.
 */

const { getDetails } = require('./tmdb');
const anilist = require('./anilist');
const episodeNumbering = require('./episodeNumbering');
const { BoundedTtlCache } = require('./boundedCache');

// Capped: one entry per title ever asked about, holding a merged TMDB+AniList object. Browsing a catalogue
// would otherwise grow this without limit.
const MAX_CACHE_ENTRIES = 1000;

const cache = new BoundedTtlCache(MAX_CACHE_ENTRIES);
const inflight = new Map();
const TTL = 6 * 60 * 60 * 1000;

function fresh(e) { return e && (Date.now() - e.ts) < TTL; }

const IMG_BASE = 'https://image.tmdb.org/t/p';
const img = (path, size = 'w500') => (path ? `${IMG_BASE}/${size}${path}` : null);

// Two TMDB quirks make episode lookup unreliable if you assume it is neat, and both bit us here:
//   1. append_to_response=episodes is silently ignored (the show comes back with no `episodes` key), so
//      episode data has to come from the season endpoints.
//   2. A season may be numbered absolutely (One Piece S21 starts at 892) or season-relatively (Attack on
//      Titan S2 starts at 1), and the field is the same either way. utils/episodeNumbering.js decides which,
//      and this uses it rather than reading episode_number directly.
// Matching on the array POSITION (offset by episode-1) is what works for the season list; see below for why
// a season that numbers absolutely should be addressed by its own number instead.
async function getEpisodeDetails(tmdbId, season, episode, opts = {}) {
  if (!tmdbId || !season || !episode) return null;
  const seasonNo = Number(season), epNo = Number(episode);

  // TMDB addresses an episode by its episode_number. For an absolute-numbered season that number is not the
  // season-relative one, so One Piece S21E1 is really `season/21/episode/892`. Asking for `.../episode/1`
  // just 404s and costs a wasted round trip, so address it correctly when the scheme is known.
  const numbered = opts.numbering && opts.numbering.seasonNumbering === 'absolute' && opts.numbering.absoluteEpisode;
  const addressable = numbered ? opts.numbering.absoluteEpisode : epNo;
  try {
    const one = await getDetails('tv', tmdbId, `season/${seasonNo}/episode/${addressable}`);
    if (one && one.id) return shapeEpisode(one, seasonNo, epNo, opts);
  } catch { /* not addressable by that number, or not listed yet */ }

  try {
    const s = await getDetails('tv', tmdbId, `season/${seasonNo}`);
    const list = (s && s.episodes) || [];
    if (!list.length || epNo > list.length) return null;
    // Position in the array is the season-relative number, whatever the episode_number field claims.
    const byIndex = list[epNo - 1];
    if (byIndex && byIndex.id) return shapeEpisode(byIndex, seasonNo, epNo, opts);
    // Some seasons are 1-indexed by episode_number, so keep that as a second chance.
    const byNumber = list.find(e => e.episode_number === epNo);
    if (byNumber) return shapeEpisode(byNumber, seasonNo, epNo, opts);
    return {
      season: seasonNo, episode: epNo, name: null, overview: null, still: null, airDate: null,
      runtime: (s.episode_run_time && s.episode_run_time[0]) || null, rating: null,
      seasonEpisodeLabel: `S${seasonNo}E${epNo}`
    };
  } catch { return null; }
}

function shapeEpisode(e, season, episode, opts = {}) {
  const numbering = opts.numbering || null;
  return {
    season: Number(season),
    episode: Number(episode),
    name: e.name || null,
    overview: e.overview || null,
    still: img(e.still_path, 'w300'),
    airDate: e.air_date || null,
    runtime: e.runtime ?? null,
    rating: e.vote_average ?? null,
    seasonEpisodeLabel: `S${Number(season)}E${Number(episode)}`,
    // The running number anime sites index by, from utils/episodeNumbering.js. Note this is NOT simply
    // e.episode_number: that field is absolute for some shows and season-relative for others, so reading it
    // directly is wrong for standard-numbered anime (Attack on Titan S2E1 is absolutely #26, not #1).
    // `opts.absolute` is the caller's pre-resolved answer and is only a fallback for callers that did not
    // pass the full `numbering` object.
    absoluteEpisode: numbering ? numbering.absoluteEpisode : (opts.absolute ?? null),
    // Alias kept for existing clients. Which of the two numbers is authoritative is `numberingSource`
    // below: 'tmdb' when TMDB's own absolute numbering was used, 'derived'/'season1' when it was worked out
    // from the earlier seasons' episode counts.
    absoluteEpisodeComputed: numbering ? numbering.absoluteEpisode : (opts.absolute ?? null),
    // The season-relative number, which is what TMDB's own UI and URLs use.
    seasonRelativeEpisode: Number(episode),
    // 'absolute' | 'relative' | 'irregular' | 'unknown' -- how TMDB numbers this season.
    seasonNumbering: numbering ? numbering.seasonNumbering : null,
    numberingSource: numbering ? numbering.source : null
  };
}


// The one call a client makes. Returns everything a title screen and an episode row need, from both
// sources, already merged. `anilist` is null for live action, which is the correct answer, not a failure.
async function getMetadata(type, tmdbId, opts = {}) {
  const key = `${type}:${tmdbId}`;
  const hit = cache.get(key);
  let base = fresh(hit) ? hit.data : null;
  if (!base && inflight.has(key)) base = await inflight.get(key);
  if (!base) {
    const p = (async () => {
      let d = null;
      try { d = await getDetails(type, tmdbId); } catch { d = null; }
      if (!d) return null;
      const isMovie = type === 'movie';
      const enLogo = d.images && d.images.find(i => i.iso_639_1 === 'en' && i.file_path);
      return {
        tmdbId: String(tmdbId),
        type,
        title: d.title || d.name || null,
        originalTitle: d.original_title || d.original_name || null,
        // A show is often known by several names; hand all of them over so a UI can offer search aliases.
        alternativeTitles: (d.alternative_titles || []).flatMap(a => [a.title, ...(a.titles || [])]).filter(Boolean),
        overview: d.overview || null,
        tagline: d.tagline || null,
        status: d.status || null,
        genres: (d.genres || []).map(g => g.name).filter(Boolean),
        poster: img(d.poster_path, 'w500'),
        backdrop: img(d.backdrop_path, 'w1280'),
        logo: enLogo ? img(enLogo.file_path, 'w500') : null,
        releaseDate: d.release_date || d.first_air_date || null,
        year: Number(String(d.release_date || d.first_air_date || '').slice(0, 4)) || null,
        runtime: d.runtime ?? (d.episode_run_time && d.episode_run_time[0]) ?? null,
        voteAverage: d.vote_average ?? null,
        seasonCount: isMovie ? null : ((d.seasons || []).filter(s => s.season_number > 0).length || null),
        episodeCounts: isMovie ? null : (d.seasons || []).filter(s => s.season_number > 0).map(s => [s.season_number, s.episode_count]),
        isAnime: !isMovie && (d.genres || []).some(g => g.id === 16) && d.original_language === 'ja',
        externalIds: d.external_ids || null
      };
    })().then(v => { cache.set(key, { data: v, ts: Date.now() }); inflight.delete(key); return v; });
    inflight.set(key, p);
    base = await p;
  }
  if (!base) return null;

  // AniList is looked up for series only (a movie rarely has an entry worth showing) and is cached, so
  // this is free after the first call for a title.
  const al = base.type === 'movie' ? null : await anilist.getForTmdb('tv', tmdbId);

  const out = {
    ...base,
    anilist: al ? {
      id: al.id, idMal: al.idMal, titles: al.titles, displayTitle: al.displayTitle,
      description: al.description, synonyms: al.synonyms, score: al.score, genres: al.genres,
      totalEpisodes: al.episodes, format: al.format, status: al.status, season: al.season,
      seasonYear: al.seasonYear, coverImage: al.coverImage, coverColor: al.coverColor,
      bannerImage: al.bannerImage, studios: al.studios, startDate: al.startDate
    } : null,
    episode: null
  };

  // For anime, prefer AniList's description and original title: TMDB's are often the English dub and thin.
  if (al) {
    if (al.displayTitle && !al.titles.english) out.title = al.displayTitle;
    if (al.description && (!out.overview || out.overview.length < 80)) out.overview = al.description;
    if (al.coverImage && !out.poster) out.poster = al.coverImage;
  }

  if (opts.season && opts.episode) {
    // All numbering decisions live in utils/episodeNumbering.js, so the episode name, the stream lookup and
    // the API response all agree on which episode this is. The season array is fetched first because the
    // scheme (absolute vs season-relative) can only be read from it.
    const seasonPayload = base.type === 'movie'
      ? null
      : await getDetails('tv', tmdbId, `season/${Number(opts.season)}`).catch(() => null);
    const seasonEpisodes = (seasonPayload && seasonPayload.episodes) || [];
    const counts = episodeNumbering.countsFromSeasons(
      // The base details payload already carries the season list; only refetch if it is absent.
      (base.episodeCounts || []).length ? (base.episodeCounts || []).map(([n, c]) => ({ season_number: n, episode_count: c })) : []
    );
    const numbering = episodeNumbering.resolveNumbering({
      episodes: seasonEpisodes,
      counts,
      season: Number(opts.season),
      episode: Number(opts.episode),
      anilistTotalEpisodes: al && al.episodes
    });
    const abs = numbering.absoluteEpisode;

    const ep = await getEpisodeDetails(tmdbId, opts.season, opts.episode, { absolute: abs, numbering });
    if (ep) {
      ep.absoluteEpisodeComputed = abs;
      if (al) ep.anilist = await anilist.getEpisodeContext(al, opts.season, opts.episode);
      // Surface the numbering warnings on the episode itself so a client does not have to dig for them.
      if (numbering.warnings.length) ep.numberingWarnings = numbering.warnings;
      out.episode = ep;
    }
    out.absoluteEpisode = abs;
    out.numbering = {
      seasonNumbering: numbering.seasonNumbering,
      numberingBase: numbering.numberingBase,
      totalEpisodes: numbering.totalEpisodes,
      anilistTotalEpisodes: numbering.anilistTotalEpisodes,
      source: numbering.source,
      warnings: numbering.warnings
    };
    // Backwards-compatible single string for callers that only read the old field.
    if (numbering.warnings.length) out.numberingWarning = numbering.warnings[0];
  }
  return out;
}

function clear() { cache.clear(); inflight.clear(); }

module.exports = { getMetadata, clear };
