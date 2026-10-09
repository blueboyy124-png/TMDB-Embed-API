// "Enough" — has this response already got a good answer?
//
// The aggregate's soft deadline answers "how long is too long", but it waited the full 20s even when the
// response was complete at 7s and the only thing still running was a provider that was going to add
// nothing. Across a 26-title sweep the median response was 12.6s with a p90 of 17.8s, and almost all of it
// was spent waiting on stragglers long after 30+ playable streams were already in hand. dahmermovies alone
// accounted for 7.1s of a Better Call Saul request that returned 2 streams either way.
//
// So the aggregate returns as soon as it has enough. Both thresholds matter, and the provider half is the
// one that is easy to get wrong: a stream count alone would be satisfied by three providers returning one
// stream each, which is three chances to be wrong and defeats the entire point of aggregating 14 of them.
// Requiring ENOUGH_PROVIDERS distinct sources is what keeps a bad provider survivable.
//
// A slot is `undefined` while its provider is still working and `[]` once it has settled empty, so anything
// that is not a non-empty array is simply skipped -- providers still in flight never count as evidence.
const DEFAULT_ENOUGH_STREAMS = 12;
const DEFAULT_ENOUGH_PROVIDERS = 3;

function isEnough(slots, neededStreams = DEFAULT_ENOUGH_STREAMS, neededProviders = DEFAULT_ENOUGH_PROVIDERS) {
  if (!Array.isArray(slots)) return false;
  let streams = 0;
  let providers = 0;
  for (const s of slots) {
    if (!Array.isArray(s) || s.length === 0) continue;
    providers++;
    streams += s.length;
  }
  return streams >= neededStreams && providers >= neededProviders;
}

// A stream counts as "high quality" when it beats 1080p. Above this we never want to return early, because
// 4K is exactly what the wait is for.
const HIGH_QUALITY_MIN = Number(process.env.ENOUGH_HIGH_QUALITY_MIN) || 1440;

// Reads a quality label into a number. "Auto" is an adaptive playlist whose real ceiling is unknown from the
// label alone, so it is NOT counted as high quality -- claiming otherwise would let a manifest we have not
// inspected satisfy the gate.
function qualityValue(label) {
  const s = String(label || '').toLowerCase();
  if (/2160|4k|uhd/.test(s)) return 2160;
  if (/1440|2k/.test(s)) return 1440;
  if (/1080/.test(s)) return 1080;
  if (/720/.test(s)) return 720;
  if (/480/.test(s)) return 480;
  return 0;
}

/** True when anything in `slots` is above 1080p.
 *
 *  Judged on VERIFIED streams only. `isVerified` says whether a link has already been probed alive; anything
 *  unverified is treated as not-high-quality. That matters because the obvious implementation -- just scan the
 *  raw provider output -- is wrong: DahmerMovies returns five 2160p entries that are all HTTP 403, so they
 *  satisfied the gate, the aggregate stopped at 1.4s, and the response came back with bestQuality 1080 and
 *  zero 4K while 4khdhub's real 2160p was still running. The gate has to be satisfied by something that
 *  actually plays, or it defeats its own purpose.
 *
 *  `probeHighQuality` is an async probe for unverified candidates. Only 4K-labelled links are probed -- there
 *  are usually one or two, versus twenty-odd 1080p links, so the cost is small and it happens on the critical
 *  path only when everything else is already good. */
async function hasVerifiedHighQuality(slots, { verifyDeadLinks } = {}) {
  if (!Array.isArray(slots)) return false;
  for (const s of slots) {
    if (!Array.isArray(s) || s.length === 0) continue;
    // Cheap pass first: anything already known alive and above 1080p settles it immediately.
    if (s.some(one => one && one.playableInBrowser !== false &&
        qualityValue(one.quality) >= HIGH_QUALITY_MIN && verifyDeadLinks?.isVerifiedAlive(one))) return true;
  }
  if (typeof verifyDeadLinks !== 'function') return false;
  // Slow pass: probe the unverified high-quality candidates.
  for (const s of slots) {
    if (!Array.isArray(s)) continue;
    for (const one of s) {
      if (!one || one.playableInBrowser === false) continue;
      if (qualityValue(one.quality) < HIGH_QUALITY_MIN) continue;
      if (verifyDeadLinks.isVerifiedAlive(one)) return true;
      if (await verifyDeadLinks.probeIfUnknown(one)) return true;
    }
  }
  return false;
}

module.exports = {
  isEnough, hasVerifiedHighQuality, qualityValue,
  DEFAULT_ENOUGH_STREAMS, DEFAULT_ENOUGH_PROVIDERS, HIGH_QUALITY_MIN
};