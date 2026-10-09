// Unit tests for utils/streamMeta.js -- the uniform metadata applied to every provider's streams.
//
// The problem it fixes: the same episode was described three different ways. The anime provider said
// "Auto | ONE PIECE (1999) S21E1", CastleTV said "One Piece S21E01 (1999) 1080p | 2.05 GB | Castle", and
// DahmerMovies alone carried the real episode name -- because each provider built its own title string.
// The canonical name was already in the response one level up, just never copied down onto the streams.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { enrichStreams, truncate, TITLE_MAX, normaliseLanguage, pickPrimaryLanguage } = require('../utils/streamMeta.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

const EPISODE = {
  name: 'The Land of Wano! To the Samurai Country where Cherry Blossoms Flutter!',
  overview: 'A mysterious country, a rampaging slasher, ancient samurai rituals of seppuku.',
  still: 'https://image.tmdb.org/t/p/w300/still.jpg',
  airDate: '2019-07-07',
  absoluteEpisode: 892
};
const details = { type: 'tv', episode: EPISODE };

// 1. Three providers, three very different original titles -> one identical title.
const input = [
  { provider: 'anime', title: 'Auto | ONE PIECE (1999) S21E1', track: 'sub' },
  { provider: 'castletv', title: 'One Piece S21E01 (1999) 1080p | 2.05 GB | Castle' },
  { provider: 'dahmermovies', title: '1080p | Original | 4.8 GB | MKV | One Piece 1999 S21E01 The Land of Wano! ... Remux' }
];
const out = enrichStreams(input.map(s => ({ ...s })), details);

check('every provider gets the same title', new Set(out.map(s => s.title)).size === 1, JSON.stringify(out.map(s => s.title)));
check('title is the episode name', out[0].title.startsWith('The Land of Wano!'), out[0].title);
check('title is truncated for display', out[0].title.length <= TITLE_MAX, `${out[0].title.length} chars`);
// The full name is no longer repeated per stream by default; it is served once at metadata.episode, or per
// stream under ?perStreamMeta=1. Checked in the verbose run below.
check('full name is not lost (verbose shape)', enrichStreams([{ title: 'x' }], details, { perStreamMeta: true })[0].episodeName === EPISODE.name);

// 2. The provider's own wording must survive, verbatim. This is the whole reason sourceTitle exists.
check('sourceTitle preserved for every provider', out.every(s => typeof s.sourceTitle === 'string' && s.sourceTitle.length),
  out.map(s => s.sourceTitle.slice(0, 28)).join(' | '));
check('dahmermovies size/codec detail kept', /67|4\.8 GB|Remux/.test(out[2].sourceTitle), out[2].sourceTitle.slice(0, 40));
check('originals are distinct', new Set(out.map(s => s.sourceTitle)).size === 3);

// 3. The input must not be mutated: other code (tags, proxying) has already run by this point.
check('input objects not mutated', input[0].title === 'Auto | ONE PIECE (1999) S21E1', input[0].title);

// 4. Language mapping, and the refusal to guess.
check('sub -> ja / Japanese', out[0].language === 'ja' && out[0].languageLabel === 'Japanese' && out[0].track === 'sub',
  `${out[0].track}/${out[0].language}/${out[0].languageLabel}`);
check('no track -> all null', out[1].track === null && out[1].language === null && out[1].languageLabel === null,
  `${out[1].track}/${out[1].language}/${out[1].languageLabel}`);
const dubbed = enrichStreams([{ title: 'x', track: 'dub' }], details)[0];
check('dub -> en / English', dubbed.language === 'en' && dubbed.languageLabel === 'English', `${dubbed.language}/${dubbed.languageLabel}`);
const weird = enrichStreams([{ title: 'x', track: 'commentary' }], details)[0];
check('unknown track is not guessed into a language', weird.language === 'commentary' && weird.track === null, `got ${weird.language}`);

// 5. Description/still/airDate come from the EPISODE, never the show -- when the verbose shape is asked for.
//    By default they are omitted per stream (they are identical on every one and cost 28% of the payload),
//    so the default run is checked with perStreamMeta and the compact default separately below.
const out2 = enrichStreams([{ title: 'x' }], details, { perStreamMeta: true });
const v = out2[0];
check('description is the episode overview', v.description === EPISODE.overview, v.description.slice(0, 30));
check('still is the episode still', v.still === EPISODE.still);
check('airDate is the episode air date', v.airDate === '2019-07-07');
check('absoluteEpisode carried', v.absoluteEpisode === 892);

// 5b. Default (compact) shape: keys present but null, so a client reading stream.description never throws.
const compact = enrichStreams([{ title: 'x' }], details)[0];
check('compact shape keeps the title', compact.title.startsWith('The Land of Wano!'), compact.title.slice(0, 30));
check('compact shape nulls the repeated fields', compact.description === null && compact.still === null && compact.airDate === null && compact.absoluteEpisode === null);
check('compact shape still carries sourceTitle', typeof compact.sourceTitle === 'string');
check('the same facts are available in the verbose shape', out2[0].description === EPISODE.overview);

// 6. Never blank a title. A movie has no episode, and an unnamed episode must leave the provider's alone.
const movie = enrichStreams([{ title: 'Movie Title 1080p' }], { type: 'movie', overview: 'A doorway.', poster: 'p.jpg', releaseDate: '2026-01-01' }, { perStreamMeta: true })[0];
check('movie title untouched', movie.title === 'Movie Title 1080p', movie.title);
check('movie episodeName is null', movie.episodeName === null);
check('movie still/description from the title itself', movie.still === 'p.jpg' && movie.description === 'A doorway.');
const unnamed = enrichStreams([{ title: 'Provider Wording Kept' }], { type: 'tv', episode: { name: null, overview: null } })[0];
check('unnamed episode keeps the provider title', unnamed.title === 'Provider Wording Kept', unnamed.title);
check('unnamed episode has no description', unnamed.description === null);

// 7. Missing metadata must not break anything or invent values.
const noMeta = enrichStreams([{ title: 'Untouched' }], null)[0];
check('no metadata -> title untouched', noMeta.title === 'Untouched', noMeta.title);
check('no metadata -> no invented language', noMeta.language === null && noMeta.languageLabel === null);
check('empty stream list is safe', Array.isArray(enrichStreams([], details)) && enrichStreams([], details).length === 0);
check('null stream list becomes an empty array', Array.isArray(enrichStreams(null, details)) && enrichStreams(null, details).length === 0);

// 8. Truncation helper.
check('short text untouched', truncate('short') === 'short');
check('long text ellipsised', truncate('x'.repeat(200)).endsWith('…') && truncate('x'.repeat(200)).length === TITLE_MAX);
check('truncate handles null', truncate(null) === '');

// 9. Language from a provider that reports one by name rather than by track -- the HLS-rendition path, which
//    previously threw the information away (vixsrc parsed it and returned nothing; castletv flattened it
//    into a display label and never emitted a field). vixsrc has since been removed as a provider, but the
//    path survives in utils/hlsPlaylist.js and in castletv.
check('ISO 639-2 "eng" -> en/English', normaliseLanguage('eng').language === 'en' && normaliseLanguage('eng').languageLabel === 'English');
check('"English" -> en/English', normaliseLanguage('English').language === 'en');
check('"jpn" -> ja/Japanese', normaliseLanguage('jpn').language === 'ja' && normaliseLanguage('jpn').languageLabel === 'Japanese');
check('region variant "pt-BR" -> pt', normaliseLanguage('pt-BR').language === 'pt', normaliseLanguage('pt-BR').language);
check('"hin" -> hi/Hindi', normaliseLanguage('hin').language === 'hi');
check('"und" is treated as unknown, not guessed', normaliseLanguage('und').language === null);
check('"unknown" stays null', normaliseLanguage('unknown').language === null);
check('nonsense stays null', normaliseLanguage('klingon').language === null);
check('empty stays null', normaliseLanguage('').language === null && normaliseLanguage(null).language === null);

const picked = pickPrimaryLanguage([{ language: 'eng', label: 'English' }, { language: 'jpn', label: 'Japanese' }]);
check('multi-audio prefers the non-English original', picked.language === 'ja' && picked.languageLabel === 'Japanese', `${picked.language}`);
check('multi-audio keeps the full list', Array.isArray(picked.audioTracks) && picked.audioTracks.length === 2);
check('single english track reports English', pickPrimaryLanguage([{ language: 'eng' }]).language === 'en');
check('no usable tracks report nothing', pickPrimaryLanguage([]).language === null && pickPrimaryLanguage([{ language: 'und' }]).language === null);
check('undefined input is safe', pickPrimaryLanguage(undefined).language === null);

console.log('');
console.log('--- HLS manifest parsing (upstream-independent) ---');
// The language path is verified against a real EXT-X-MEDIA manifest here rather than through the network.
// parsePlaylist (now in utils/hlsPlaylist.js; it lived in providers/vixsrc.js before that provider was
// removed) used to build `audioTracks` and then return only { sources, subtitles } -- the language was
// parsed and thrown away.
const { parsePlaylist } = require('../utils/hlsPlaylist');
const MANIFEST = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="Japanese",LANGUAGE="jpn",DEFAULT=YES,URI="audio/jpn.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",LANGUAGE="eng",URI="audio/eng.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",NAME="English",LANGUAGE="eng",URI="sub/eng.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2074179,RESOLUTION=1920x1080,CODECS="avc1.640032"',
  'https://cdn.example/video/1080/index.m3u8'
].join('\n');
const parsed = parsePlaylist(MANIFEST, 'https://cdn.example/video/master.m3u8', 'https://embed.example/x');
check('audioTracks are actually returned now', Array.isArray(parsed.audioTracks) && parsed.audioTracks.length === 2,
  `${(parsed.audioTracks || []).length} tracks`);
check('Japanese track parsed', parsed.audioTracks.some(t => t.language === 'jpn'), JSON.stringify(parsed.audioTracks));
check('English track parsed', parsed.audioTracks.some(t => t.language === 'eng'));
check('manifest language maps to ja', normaliseLanguage('jpn').language === 'ja');
check('the two-track manifest picks Japanese', pickPrimaryLanguage(parsed.audioTracks).language === 'ja');
check('subtitles still parsed', parsed.subtitles.length === 1);
check('a stream was produced', parsed.sources.length === 1);
const emptyManifest = parsePlaylist('#EXTM3U\n', 'https://x/m.m3u8', 'https://x');
check('a manifest with no variants returns no streams and no audio', emptyManifest.sources.length === 0 && emptyManifest.audioTracks.length === 0);

console.log('');
if (failures) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
console.log('PASS: stream metadata is uniform across providers and never invents a value');
