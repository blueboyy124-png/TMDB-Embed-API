/* Episode numbering: the one place that decides what number an episode actually is.
 *
 * The problem this solves. Every anime site indexes episodes by a single running number ("episode 892"),
 * while TMDB, AniList, Cinemeta and the client all use season/episode pairs. Converting between the two is
 * where wrong episodes come from, and it used to be done in four places with four different answers:
 * utils/metadata.js, apiServer.js, providers/anime.js and providers/onetouchtv.js.
 *
 * What makes it hard is that TMDB reuses ONE field, episode_number, for TWO different numbering schemes,
 * and which one you get depends on the show. Measured against the live API:
 *
 *   One Piece S2         episode_number 62..77   (absolute: continues from S1)
 *   Naruto Shippuden S2  episode_number 33..53   (absolute)
 *   Fairy Tail S2        episode_number 63..136  (absolute)
 *   Attack on Titan S2   episode_number  1..12   (season-relative! true absolute 26..37)
 *   Breaking Bad S2      episode_number  1..13   (season-relative! true absolute  8..20)
 *   Demon Slayer S2      episode_number  1..7    (season-relative! true absolute 27..33)
 *
 * So episode_number is NOT "the absolute number". Reading it as one is right for long-running shows and
 * silently wrong for everything else, which is the worst kind of bug: Attack on Titan S2E1 would be handed
 * out as absolute #1 (i.e. S1E1) and the player would fetch the wrong episode.
 *
 * The rule, therefore: decide the season's scheme first, then derive from it.
 *   - If the season's numbers run 1,2,3,... they are season-relative, and the absolute number is
 *     (episodes in all earlier seasons) + episode. The offset must come from the season LIST, not from the
 *     season's own array, because a relative array starts at 1 and cannot tell you where it sits.
 *   - If they run first,first+1,... with first > 1 they are already absolute, and TMDB's own value is
 *     authoritative -- the sites we pull streams from key off TMDB, so where the two disagree TMDB wins.
 *
 * Two invariants, both deliberate:
 *   - Never guess. If an earlier season has no episode count we return null and the caller marks the episode
 *     as unnumbered. A plausible-looking wrong number plays the wrong episode, which is worse than no number.
 *   - Never throw. This runs on the request path for every episode lookup.
 */

// A season is "absolute" when its numbering does not restart at 1. Detected from the data rather than
// assumed, because the same show can be absolute in one season and relative in another.
function classifySeason(episodes) {
  const list = Array.isArray(episodes) ? episodes : [];
  const nums = list.map(e => e && e.episode_number).filter(n => Number.isFinite(n));
  if (!nums.length) return { mode: 'unknown', firstNumber: null, lastNumber: null, contiguous: false, length: list.length };

  const first = nums[0];
  const contiguous = nums.every((n, i) => n === first + i);
  // Contiguity is checked first: a season that restarts at 1 but skips numbers (1,2,4,5) is neither scheme,
  // and calling it "relative" would let callers extrapolate by offset and drift onto the wrong episodes.
  const mode = !contiguous ? 'irregular' : (first === 1 ? 'relative' : 'absolute');
  return { mode, firstNumber: first, lastNumber: nums[nums.length - 1], contiguous, length: list.length };
}

// TMDB's `seasons` array -> Map(season_number -> episode_count), specials (season 0) excluded because the
// sites we match against do not count them either.
function countsFromSeasons(seasons) {
  const map = new Map();
  for (const s of (Array.isArray(seasons) ? seasons : [])) {
    if (!s || !(s.season_number > 0)) continue;
    if (Number.isFinite(s.episode_count) && s.episode_count > 0) map.set(s.season_number, s.episode_count);
  }
  return map;
}

// How many episodes aired before `season` started. Null if any earlier season's count is unknown, since a
// partial sum would put the episode somewhere it is not.
function absoluteOffset(counts, season) {
  if (!(counts instanceof Map) || !counts.size) return null;
  if (!(season > 1)) return 0;
  let total = 0;
  for (let s = 1; s < season; s++) {
    const c = counts.get(s);
    if (!Number.isFinite(c) || c <= 0) return null;
    total += c;
  }
  return total;
}

// Sum of every known season count: the show's total episode count as TMDB sees it. Used to sanity-check
// AniList, which often models a different split of the same show.
function totalFromCounts(counts) {
  if (!(counts instanceof Map) || !counts.size) return null;
  let total = 0;
  for (const c of counts.values()) total += c;
  return total || null;
}

// The number anime sites use for this episode, plus everything needed to explain the result.
// `episodes` is optional: pass the season's array when you already have it and the scheme is detected
// directly; omit it and the answer is derived from the season counts alone.
function resolveNumbering({ episodes, counts, season, episode, anilistTotalEpisodes } = {}) {
  const seasonNo = Number(season), epNo = Number(episode);
  const warnings = [];
  const info = classifySeason(episodes);
  if (info.mode === 'irregular') {
    warnings.push('TMDB episode numbers in this season are not contiguous; the absolute number is a best guess');
  }

  const offset = absoluteOffset(counts, seasonNo);
  const derived = offset == null ? null : offset + epNo;
  // With neither a season list nor the season's own episodes there is nothing to number: this is a film, or
  // a series TMDB has no episode data for. Publishing a number here would be inventing one.
  const hasStructure = (counts instanceof Map && counts.size > 0) || (Array.isArray(episodes) && episodes.length > 0);

  // Which number to publish, in order of authority:
  //   1. TMDB's own number, when the season is absolute-numbered (this is what the stream sites index by).
  //   2. The derived offset, when every earlier season's count is known.
  //   3. Nothing. A guess here plays the wrong episode, so null and a warning are the honest answer.
  let absoluteEpisode = null;
  let source = 'none';
  if (info.mode === 'absolute') {
    absoluteEpisode = info.firstNumber + (epNo - 1);
    source = 'tmdb';
    // Only flag a real disagreement, not an off-by-one from a special TMDB counted differently.
    if (derived != null && Math.abs(derived - absoluteEpisode) > 1) {
      warnings.push(`TMDB numbers this season absolutely at #${absoluteEpisode} but the earlier season counts add up to #${derived}`);
    }
  } else if (derived != null) {
    absoluteEpisode = derived;
    source = offset === 0 ? 'season1' : 'derived';
  } else if (seasonNo > 1) {
    warnings.push(`cannot place S${seasonNo}E${epNo} absolutely: TMDB is missing an episode count for an earlier season`);
  } else if (hasStructure) {
    absoluteEpisode = epNo;
    source = 'season1';
  }

  // AniList frequently models a show as several entries (one per cours) while TMDB has it as one series, or
  // the reverse. A large gap therefore usually means the two disagree about the show's SHAPE rather than
  // that the arithmetic is wrong, so this is reported as context and never used to override the number.
  const tmdbTotal = totalFromCounts(counts);
  const alTotal = Number.isFinite(anilistTotalEpisodes) && anilistTotalEpisodes > 0 ? anilistTotalEpisodes : null;
  if (alTotal && tmdbTotal && absoluteEpisode) {
    if (alTotal < tmdbTotal - 2 && absoluteEpisode > alTotal) {
      warnings.push(`AniList lists ${alTotal} episodes for this series but S${seasonNo}E${epNo} is #${absoluteEpisode}; the AniList entry likely covers only part of the run`);
    } else if (Math.abs(alTotal - tmdbTotal) > Math.max(12, tmdbTotal * 0.1)) {
      warnings.push(`episode counts disagree: TMDB totals ${tmdbTotal}, AniList lists ${alTotal}`);
    }
  }

  return {
    absoluteEpisode,
    seasonRelativeEpisode: epNo,
    seasonNumbering: info.mode,            // 'absolute' | 'relative' | 'irregular' | 'unknown'
    numberingBase: info.mode === 'absolute' ? info.firstNumber : 1,
    totalEpisodes: tmdbTotal,
    anilistTotalEpisodes: alTotal,
    source,                                // 'tmdb' | 'derived' | 'season1' | 'none'
    offset,
    warnings
  };
}

// Convenience for callers that only hold a flat array of per-season counts (Cinemeta's shape, and the
// onetouchtv provider). Kept here so those callers share the same "never guess" rule.
function arrayToCounts(countsArray) {
  const map = new Map();
  (Array.isArray(countsArray) ? countsArray : []).forEach((c, i) => {
    if (Number.isFinite(c) && c > 0) map.set(i + 1, c);
  });
  return map;
}

function absoluteFromCountsArray(countsArray, season, episode) {
  const counts = arrayToCounts(countsArray);
  const offset = absoluteOffset(counts, Number(season));
  if (offset == null) return null;
  return offset + Number(episode);
}

module.exports = {
  classifySeason,
  countsFromSeasons,
  absoluteOffset,
  totalFromCounts,
  resolveNumbering,
  arrayToCounts,
  absoluteFromCountsArray
};
