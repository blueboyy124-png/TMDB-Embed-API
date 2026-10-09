/* Uniform metadata on every stream, from one source of truth.
 *
 * Why this exists: the same episode was being described several different ways by different providers.
 * DahmerMovies put the real episode name in its own title string, the anime provider said nothing but
 * "S21E1", and CastleTV said "S21E01 (1999) | 2.05 GB | Castle" -- none of which matched, and all of which
 * had to be maintained per provider. Meanwhile the canonical answer was already in the response, one level
 * up, and simply was not being copied down onto the streams.
 *
 * So every stream gets the same fields, derived from TMDB, applied centrally in the API rather than inside
 * each provider. CastleTV and the anime provider therefore return byte-identical episode metadata for the
 * same episode, and a provider added later inherits it for free.
 *
 * Two rules, both about not destroying information:
 *   - `title` is replaced ONLY when we actually have an episode name. A movie, or an episode TMDB has not
 *     named, keeps the provider's own title. A title is never blanked.
 *   - the provider's original title is always preserved in `sourceTitle`, so replacing it costs nothing --
 *     "4.8 GB | Remux AAC 2 0" and "2.05 GB | Castle" survive there.
 *
 * Nothing here adds an upstream request. It reads the metadata the response has already fetched and cached.
 */

// Long episode names make unusable one-line titles, so `title` gets a trimmed copy. The untruncated text is
// always available in `episodeName`, so nothing is lost -- only the display string is shortened.
const TITLE_MAX = 60;

// Anime audio-track convention: the "sub" track of a Japanese anime is the Japanese original, and "dub" is the
// English dub. Kept here, in one documented place, because it is a convention about the content rather than
// about any one provider. A track we do not recognise stays null: an unlabelled stream is not a guessing
// stream, and a wrong language is worse than an absent one.
const TRACK_LANGUAGE = {
  sub: { language: 'ja', languageLabel: 'Japanese' },
  dub: { language: 'en', languageLabel: 'English' }
};

function truncate(text, max = TITLE_MAX) {
  const s = String(text == null ? '' : text).trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Language fields from whatever the provider declared. `track` is authoritative; some providers also speak
// `language`/`lang` directly, so those are honoured when they carry a real code.
function languageFields(stream) {
  const declared = clean(stream.track || stream.audio || stream.lang);
  if (declared && TRACK_LANGUAGE[declared.toLowerCase()]) {
    return { track: declared.toLowerCase(), ...TRACK_LANGUAGE[declared.toLowerCase()] };
  }
  if (declared) {
    // A provider that already reports a language code, rather than a track name.
    return { track: null, language: declared, languageLabel: declared };
  }
  return { track: null, language: null, languageLabel: null };
}

/**
 * @param {Array} streams provider output, unmodified in place
 * @param {object|null} details result of utils/metadata.getMetadata (may be null if unavailable)
 * @returns {Array} the same array, enriched
 */
function enrichStreams(streams, details, opts = {}) {
  // Always hand back an array. A provider that returned null (error path) must not leave a caller iterating
  // something that is not a list, which would throw further downstream than the original problem.
  if (!Array.isArray(streams)) return [];
  if (!streams.length) return streams;
  const d = details && typeof details === 'object' ? details : null;
  // Opt-in verbose shape. Off by default because the repeated fields are 28% of the payload and the same
  // values are already served once at metadata.episode.
  const verbose = !!(opts && opts.perStreamMeta);

  // Movies have no episode, so the title's own description/still/date are the closest true answer.
  const isMovie = d && d.type === 'movie';
  const ep = d && d.episode ? d.episode : null;

  const episodeName = clean(ep && ep.name);
  const description = clean(ep ? ep.overview : (isMovie ? d.overview : null));
  const still = clean(ep ? ep.still : (isMovie ? d.poster : null));
  const airDate = clean(ep ? ep.airDate : (isMovie ? d.releaseDate : null));
  const absoluteEpisode = Number.isFinite(ep && ep.absoluteEpisode) ? ep.absoluteEpisode : null;

  return streams.map(s => {
    if (!s || typeof s !== 'object') return s;
    const out = { ...s };
    // Kept before anything overwrites the title, and unconditionally: this is the provider's own wording.
    out.sourceTitle = clean(s.title) || clean(s.name) || null;
    // Only when we know the name. Otherwise the provider's title stands, unchanged.
    if (episodeName) out.title = truncate(episodeName);

    // These are IDENTICAL on every stream of a response, so they are not repeated per stream: measured at
    // 28% of the payload (~9.7KB of 34KB for 20 streams) for no benefit to anyone. The same values are
    // already served once at `metadata.episode` (and at the top level for movies), which is where a client
    // should read them. A client that has only one stream object in hand can call /api/metadata, or pass
    // ?perStreamMeta=1 to get the verbose per-stream shape back.
    if (verbose) {
      out.episodeName = episodeName;
      out.description = description;
      out.still = still;
      out.airDate = airDate;
      out.absoluteEpisode = absoluteEpisode;
    } else {
      // Present but null, so a client's `stream.description` never throws on a missing key.
      out.episodeName = null;
      out.description = null;
      out.still = null;
      out.airDate = null;
      out.absoluteEpisode = null;
    }

    Object.assign(out, languageFields(s));
    return out;
  });
}

// Language names as they appear in HLS manifests, mapped to what this API reports. vixsrc (and many other
// packagers) advertise EXT-X-MEDIA audio renditions with LANGUAGE="eng" / NAME="English", which was being
// parsed and then dropped on the floor: parsePlaylist built `audioTracks` and returned only
// `{ sources, subtitles }`.
//
// Kept here rather than in the provider because the manifest vocabulary is shared, and because a client
// comparing two providers' languages should not have to know that one says "eng" and another says "en".
//
// Both ISO 639-2 ("jpn", "hin") and ISO 639-1 ("ja", "hi") forms are accepted, because real manifests use
// both -- an earlier version listed only the three-letter codes and silently failed on "pt-BR".
const LANGUAGE_CODES = {
  en: 'en', eng: 'en', english: 'en',
  ja: 'ja', jpn: 'ja', jpn_orig: 'ja', jpn_orig_national: 'ja', japanese: 'ja',
  hi: 'hi', hin: 'hi', hindi: 'hi',
  es: 'es', spa: 'es', spanish: 'es',
  fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr',
  de: 'de', deu: 'de', ger: 'de', german: 'de',
  ko: 'ko', kor: 'ko', korean: 'ko',
  zh: 'zh', zho: 'zh', chi: 'zh', chs: 'zh', cht: 'zh', chinese: 'zh',
  ru: 'ru', rus: 'ru', russian: 'ru',
  pt: 'pt', por: 'pt', portuguese: 'pt',
  it: 'it', ita: 'it', italian: 'it',
  ar: 'ar', ara: 'ar', arabic: 'ar',
  tr: 'tr', tur: 'tr', turkish: 'tr',
  pl: 'pl', pol: 'pl', polish: 'pl',
  nl: 'nl', nld: 'nl', dut: 'nl', dutch: 'nl',
  sv: 'sv', swe: 'sv', th: 'th', tha: 'th', vi: 'vi', vie: 'vi',
  id: 'id', ind: 'id', ms: 'ms', may: 'ms', uk: 'uk', ukr: 'uk',
  und: null                                    // "undetermined": the manifest is saying nothing
};

// Accepts "eng", "en", "English", "en-US". Returns {language, languageLabel} or nulls when unrecognised --
// an unrecognised tag is not guessed into a language.
function normaliseLanguage(raw) {
  if (raw === undefined || raw === null) return { language: null, languageLabel: null };
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'unknown') return { language: null, languageLabel: null };
  const base = s.toLowerCase().split(/[-_]/)[0];
  const code = LANGUAGE_CODES[base];
  if (code === undefined) return { language: null, languageLabel: null };
  if (code === null) return { language: null, languageLabel: null };  // explicitly undetermined
  return { language: code, languageLabel: labelForCode(code) };
}

function labelForCode(code) {
  const names = {
    en: 'English', ja: 'Japanese', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German',
    ko: 'Korean', zh: 'Chinese', ru: 'Russian', pt: 'Portuguese', it: 'Italian', ar: 'Arabic',
    tr: 'Turkish', pl: 'Polish', nl: 'Dutch'
  };
  return names[code] || null;
}

// Picks the language worth reporting for a stream that has several audio renditions. A manifest that offers
// both Japanese and English has no single answer, so this prefers a non-English original (the usual reason to
// list alternatives is that the original is wanted) and otherwise takes the first real one.
function pickPrimaryLanguage(audioTracks) {
  if (!Array.isArray(audioTracks)) return { language: null, languageLabel: null };
  const mapped = audioTracks.map(t => ({ ...t, ...normaliseLanguage(t.language || t.label) }));
  const known = mapped.filter(t => t.language);
  if (!known.length) return { language: null, languageLabel: null };
  const nonEnglish = known.find(t => t.language !== 'en');
  const chosen = nonEnglish || known[0];
  return { language: chosen.language, languageLabel: chosen.languageLabel, audioTracks: mapped };
}

// Playback facts every client needs, decided once here rather than in every client.
//
// `container` and `playableInBrowser` were never set by this API -- both were absent from every response, and
// because clients test `playableInBrowser !== false`, an absent field reads as "yes, playable". So a 2160p MKV
// was advertised as playable: my-anime-site ranks streams by exactly that field (a 100000 penalty for
// `=== false`, which therefore never fired), and a Roku client would hand the URL straight to a Video node
// that cannot decode Matroska. Both end in a black screen.
//
// Decided centrally so a provider added later inherits it, and so the three existing client copies (the test
// player, player.html, resolver.js) can stop re-deriving it. The extension test has to look through the
// proxy, because with `enableProxy` on the URL is <origin>/ts-proxy?url=<encoded .mkv> and a bare /\.mkv/ test
// misses it entirely -- the same trap that mislabelled 20 of 20 streams as "plain file" in player.html.
function classifyForPlayback(stream) {
  if (!stream || typeof stream !== 'object') return stream;
  const raw = String(stream.url || '');
  const m = /[?&]url=([^&]+)/.exec(raw);
  let target = raw;
  if (m && /\/m3u8-proxy|\/ts-proxy/.test(raw)) {
    try { target = decodeURIComponent(m[1]); } catch { /* keep the proxied form */ }
  }
  // Explicit container wins: a provider that already knows beats guessing from the path.
  let container = stream.container;
  if (!container) {
    const ext = (/\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(target) || [])[1];
    container = ext ? ext.toLowerCase() : (/m3u8-proxy/i.test(raw) ? 'm3u8' : null);
  }
  // HLS is playable; Matroska is not, in any browser or on any Roku. Neither is a raw .ts or .avi.
  const playable = !['mkv', 'avi', 'ts', 'wmv', 'flv'].includes(String(container || '').toLowerCase())
    && !/\.(mkv|avi|wmv|flv)(\?|#|$)/i.test(target);
  return {
    ...stream,
    container: container || null,
    // Only claim unplayable when we actually know: an unknown container is left undefined rather than
    // asserted false, because a false here hides the stream from clients that skip on it.
    ...(playable ? { playableInBrowser: true } : { playableInBrowser: false })
  };
}

module.exports = { enrichStreams, truncate, TRACK_LANGUAGE, classifyForPlayback, TITLE_MAX, normaliseLanguage, pickPrimaryLanguage, labelForCode, LANGUAGE_CODES };
