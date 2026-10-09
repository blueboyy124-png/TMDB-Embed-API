#!/usr/bin/env node
/**
 * Episode numbering verification.
 *
 * TMDB reuses one field, episode_number, for two different numbering schemes: it continues across seasons
 * for long runners (One Piece S21 starts at 892) and restarts at 1 for everything else (Attack on Titan S2
 * starts at 1, but is absolutely #26). Reading that field as "the absolute number" therefore shipped the
 * wrong episode for standard-numbered anime -- Attack on Titan S2E1 was handed out as #1, i.e. S1E1.
 *
 * This checks the rules in utils/episodeNumbering.js that replaced it:
 *   - offline cases, which pin the decisions (both schemes, irregular seasons, and the never-guess rule)
 *   - --live cases, which check real shows against TMDB and AniList to catch data drift
 *
 * Usage:
 *   node scripts/verify-numbering.mjs            # offline rules only
 *   node scripts/verify-numbering.mjs --live     # + real TMDB/AniList lookups
 */
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const N = require('../utils/episodeNumbering.js');
const args = process.argv.slice(2);
const LIVE = args.includes('--live');

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  cond ? pass++ : fail++;
  console.log((cond ? '  ok   ' : '  FAIL ') + label.padEnd(58) + detail);
}

// Build a TMDB-shaped season array, so the offline cases read like the API responses they model.
const season = (numbers) => numbers.map(n => ({ episode_number: n, name: 'ep' + n }));
const countsOf = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));

console.log('\n== classifySeason ==');
check('1..12 is relative', N.classifySeason(season([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).mode === 'relative');
check('892..898 is absolute', N.classifySeason(season([892, 893, 894, 895, 896, 897, 898])).mode === 'absolute');
check('1,2,4,5 is irregular', N.classifySeason(season([1, 2, 4, 5])).mode === 'irregular');
check('empty is unknown', N.classifySeason([]).mode === 'unknown');
check('absolute reports its base', N.classifySeason(season([892, 893])).firstNumber === 892);

console.log('\n== absoluteOffset ==');
const counts = countsOf({ 1: 25, 2: 12, 3: 22, 4: 28 });
check('season 1 has zero offset', N.absoluteOffset(counts, 1) === 0);
check('season 2 offset is season 1 count', N.absoluteOffset(counts, 2) === 25);
check('season 4 offset sums 1..3', N.absoluteOffset(counts, 4) === 59);
check('gap before the season returns null', N.absoluteOffset(countsOf({ 1: 25, 3: 22 }), 3) === null);
check('no counts at all returns null', N.absoluteOffset(new Map(), 2) === null);

console.log('\n== resolveNumbering: relative season (the bug this fixes) ==');
const aotS2 = N.resolveNumbering({ episodes: season([1, 2, 3]), counts, season: 2, episode: 1 });
check('AoT-like S2E1 is 26, not 1', aotS2.absoluteEpisode === 26, 'got ' + aotS2.absoluteEpisode);
check('reported as relative', aotS2.seasonNumbering === 'relative');
check('source is derived', aotS2.source === 'derived');
const aotS2e3 = N.resolveNumbering({ episodes: season([1, 2, 3]), counts, season: 2, episode: 3 });
check('S2E3 is 28', aotS2e3.absoluteEpisode === 28, 'got ' + aotS2e3.absoluteEpisode);

console.log('\n== resolveNumbering: absolute season ==');
const opS21 = N.resolveNumbering({ episodes: season([892, 893]), counts: countsOf({ 1: 61, 2: 16 }), season: 21, episode: 1 });
check('absolute season uses TMDB number', opS21.absoluteEpisode === 892, 'got ' + opS21.absoluteEpisode);
check('reported as absolute', opS21.seasonNumbering === 'absolute');
check('source is tmdb', opS21.source === 'tmdb');
check('base is 892', opS21.numberingBase === 892);

console.log('\n== never guess ==');
const gap = N.resolveNumbering({ episodes: season([1, 2]), counts: countsOf({ 1: 25, 3: 22 }), season: 3, episode: 1 });
check('missing earlier count yields null', gap.absoluteEpisode === null, 'got ' + gap.absoluteEpisode);
check('and a warning', gap.warnings.length === 1, gap.warnings[0] || '');
const noStructure = N.resolveNumbering({ episodes: [], counts: new Map(), season: 1, episode: 1 });
check('no episode data at all yields null', noStructure.absoluteEpisode === null, 'got ' + noStructure.absoluteEpisode);

console.log('\n== irregular season does not extrapolate ==');
const irregular = N.resolveNumbering({ episodes: season([1, 2, 4, 5]), counts, season: 1, episode: 3 });
check('flagged irregular', irregular.seasonNumbering === 'irregular');
check('still returns a position-based number', irregular.absoluteEpisode === 3, 'got ' + irregular.absoluteEpisode);
check('with a warning', irregular.warnings.length >= 1, irregular.warnings[0] || '');

console.log('\n== AniList cross-check ==');
const partial = N.resolveNumbering({ episodes: season([1, 2]), counts, season: 2, episode: 1, anilistTotalEpisodes: 25 });
check('partial AniList coverage is flagged', partial.warnings.some(w => w.includes('part of the run')), partial.warnings[0] || '');
const agree = N.resolveNumbering({ episodes: season([1, 2]), counts, season: 2, episode: 1, anilistTotalEpisodes: 87 });
check('agreeing counts produce no warning', agree.warnings.length === 0, agree.warnings.join('; '));

console.log('\n== Cinemeta-shaped counts (onetouchtv) ==');
check('array offset: S2E1 of [25,12] is 26', N.absoluteFromCountsArray([25, 12], 2, 1) === 26);
check('array offset: season 1 is itself', N.absoluteFromCountsArray([25, 12], 1, 5) === 5);
check('array with a zero season returns null', N.absoluteFromCountsArray([25, 0, 22], 3, 1) === null);

if (LIVE) {
  const { getMetadata } = require('../utils/metadata.js');
  console.log('\n== live TMDB + AniList ==');
  const cases = [
    ['Attack on Titan', '1429', 2, 1, 26, 'Beast Titan'],
    ['Breaking Bad', '1396', 2, 1, 8, 'Seven Thirty-Seven'],
    ['Demon Slayer', '85937', 2, 1, 27, 'Flame Hashira'],
    ['One Piece', '37854', 21, 1, 892, 'Land of Wano'],
    ['Naruto Shippuden', '31910', 2, 1, 33, 'New Target'],
    ['Bleach', '30984', 2, 1, 367, 'Blood Warfare']
  ];
  for (const [name, id, s, e, wantAbs, wantName] of cases) {
    const m = await getMetadata('tv', id, { season: s, episode: e });
    const abs = m && m.absoluteEpisode;
    const nm = (m && m.episode && m.episode.name) || '';
    check(`${name} S${s}E${e} -> #${wantAbs}`, abs === wantAbs && nm.toLowerCase().includes(wantName.toLowerCase()),
      `abs=${abs} "${nm}"`);
  }
} else {
  console.log('\n(live TMDB/AniList cases skipped; re-run with --live)');
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ': ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
