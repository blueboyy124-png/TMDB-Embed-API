// Universal search-result matching system.
// Ported from Infinite-streams (src/utils/match.ts) for title-search providers.

const QUALITY_TAGS =
  /\b(4k|2160p|1080p|720p|480p|360p|hd|fhd|uhd|hdr|web[-\s]?dl|webrip|web|bluray|blu-ray|brrip|bdrip|dvdrip|hdrip|hdtv|hdcam|cam|dual audio|multi audio|dual[-\s]?audio|multi[-\s]?audio|x264|x265|hevc|h264|h265|10bit|esub|esubs|msubs|amzn|nf|hin|eng|hindi|english|dubbed|dub|subbed|sub|season\s*\d+|s\d{1,2}|complete|full)\b/gi;

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'to', 'with', 'and', 'or', 'for', 'on']);

function baseNormalize(s) {
  return s
    .toLowerCase()
    .replace(/([a-z])\./g, '$1')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStripQuality(s) {
  return baseNormalize(String(s).replace(QUALITY_TAGS, ' '));
}

function tokenize(s) {
  return baseNormalize(s).split(' ').filter(Boolean);
}

function significantTokens(s) {
  return tokenize(s).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function bigrams(s) {
  const clean = baseNormalize(s).replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

function diceCoefficient(a, b) {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return ba.length === bb.length ? 1 : 0;
  const counts = new Map();
  for (const g of ba) counts.set(g, (counts.get(g) || 0) + 1);
  let matches = 0;
  for (const g of bb) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      matches++;
      counts.set(g, c - 1);
    }
  }
  return (2 * matches) / (ba.length + bb.length);
}

function scoreTitleText(query, candidate) {
  if (!query || !candidate) {
    return { exact: 0, normalized: 0, fuzzy: 0, wholeWord: 0, startsWith: 0, score: 0 };
  }
  const exact = String(query).trim().toLowerCase() === String(candidate).trim().toLowerCase() ? 1 : 0;

  const nq = normalizeStripQuality(query);
  const nc = normalizeStripQuality(candidate);
  let normalized = nq === nc ? 1 : 0;
  if (!normalized && nq.replace(/\s+/g, '') === nc.replace(/\s+/g, '')) normalized = 0.92;

  const tokenJaccardOf = () => {
    const qa = new Set(significantTokens(nq));
    const ca = new Set(significantTokens(nc));
    if (qa.size === 0 || ca.size === 0) return 0;
    let intersection = 0;
    for (const t of qa) if (ca.has(t)) intersection++;
    const union = qa.size + ca.size - intersection;
    return union === 0 ? 0 : intersection / union;
  };
  const fuzzy = 0.5 * tokenJaccardOf() + 0.5 * diceCoefficient(nq, nc);

  const qSig = significantTokens(nq);
  const cSigSet = new Set(significantTokens(nc));
  const wholeWord = qSig.length === 0 ? 0 : qSig.filter((w) => cSigSet.has(w)).length / qSig.length;

  let startsWith = 0;
  if (nc.startsWith(nq) || nq.startsWith(nc)) startsWith = 1;
  else {
    const qFirst = nq.split(' ')[0];
    const cFirst = nc.split(' ')[0];
    if (qFirst && cFirst && qFirst === cFirst) startsWith = 0.5;
  }

  const score = exact * 0.35 + normalized * 0.25 + fuzzy * 0.2 + wholeWord * 0.1 + startsWith * 0.1;
  return { exact, normalized, fuzzy, wholeWord, startsWith, score: Math.min(1, score) };
}

function bestTitleScore(query, candidate) {
  const attempts = [{ label: 'title', text: candidate.title }];
  if (candidate.originalTitle) attempts.push({ label: 'originalTitle', text: candidate.originalTitle });
  for (const alias of candidate.aliases || []) attempts.push({ label: `alias:${alias}`, text: alias });

  const queryTitles = [query.title, query.originalTitle, ...(query.aliases || [])].filter((t) => !!t);

  let best = null;
  for (const q of queryTitles) {
    for (const a of attempts) {
      const breakdown = scoreTitleText(q, a.text);
      if (!best || breakdown.score > best.score) {
        best = { score: breakdown.score, breakdown, matchedOn: a.label };
      }
    }
  }
  return best || { score: 0, breakdown: scoreTitleText('', ''), matchedOn: 'title' };
}

function scoreYear(query, candidate) {
  if (!query || !candidate) return 0.5;
  const diff = Math.abs(query - candidate);
  if (diff === 0) return 1;
  if (diff === 1) return 0.6;
  if (diff === 2) return 0.3;
  return 0.05;
}

function scoreType(query, candidate) {
  if (!query || !candidate) return 0.5;
  return query === candidate ? 1 : 0;
}

function scoreSeasonEpisode(query, candidate) {
  if (query.type !== 'series') return 1;
  if (query.season == null || candidate.season == null) return 0.7;
  if (query.season !== candidate.season) return 0.15;
  if (query.episode == null || candidate.episode == null) return 1;
  return query.episode === candidate.episode ? 1 : 0.6;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function scoreCandidate(query, candidate) {
  const text = bestTitleScore(query, candidate);
  const year = scoreYear(query.year, candidate.year);
  const type = scoreType(query.type, candidate.type);
  const seasonEpisode = scoreSeasonEpisode(query, candidate);
  const score = text.score * 0.6 + year * 0.1 + type * 0.2 + seasonEpisode * 0.1;
  return {
    score: Math.min(1, Math.max(0, score)),
    matchedOn: text.matchedOn,
    breakdown: {
      textScore: round(text.score),
      exact: round(text.breakdown.exact),
      normalized: round(text.breakdown.normalized),
      fuzzy: round(text.breakdown.fuzzy),
      wholeWord: round(text.breakdown.wholeWord),
      startsWith: round(text.breakdown.startsWith),
      year: round(year),
      type: round(type),
      seasonEpisode: round(seasonEpisode),
    },
  };
}

const DEFAULT_THRESHOLD = 0.45;

function findBestMatch(query, candidates, options) {
  const threshold = options.threshold || DEFAULT_THRESHOLD;
  const ranked = candidates
    .map((candidate) => {
      const { score, breakdown, matchedOn } = scoreCandidate(query, candidate);
      return { candidate, score, breakdown, matchedOn };
    })
    .sort((a, b) => b.score - a.score);

  if (!options.quiet) {
    console.log(`[Match:${options.provider}] scored candidates`, {
      provider: options.provider,
      query: options.query || query.title,
      resultCount: candidates.length,
      candidates: ranked.map((r) => ({
        title: r.candidate.title,
        year: r.candidate.year,
        type: r.candidate.type,
        score: round(r.score),
        matchedOn: r.matchedOn,
      })),
    });
  }

  const top = ranked[0];
  if (!top) {
    console.log(`[Match:${options.provider}] no candidates returned by search`);
    return { best: null, score: 0, breakdown: {}, matchedOn: '', reason: 'no candidates returned by search', ranked };
  }

  const passed = top.score >= threshold;
  const reason = passed
    ? `best candidate "${top.candidate.title}" scored ${round(top.score)} (>= threshold ${threshold}) via ${top.matchedOn}`
    : `best candidate "${top.candidate.title}" scored ${round(top.score)} which is below threshold ${threshold} — rejected as a likely mismatch`;

  console.log(`[Match:${options.provider}] ${passed ? 'selected result' : 'rejected — no match above threshold'}`, {
    provider: options.provider,
    query: options.query || query.title,
    resultCount: candidates.length,
    selected: passed ? top.candidate.title : null,
    score: round(top.score),
    threshold,
    breakdown: top.breakdown,
    reason,
  });

  if (!passed) {
    return { best: null, score: top.score, breakdown: top.breakdown, matchedOn: top.matchedOn, reason, ranked };
  }
  return { best: top.candidate, score: top.score, breakdown: top.breakdown, matchedOn: top.matchedOn, reason, ranked };
}

async function findBestMatchWithRetry(query, variantTitles, search, options) {
  const threshold = options.threshold || DEFAULT_THRESHOLD;
  const tried = new Set();
  let bestSoFar = null;

  for (const variant of variantTitles) {
    const key = String(variant).trim().toLowerCase();
    if (!key || tried.has(key)) continue;
    tried.add(key);

    let candidates;
    try {
      candidates = await search(variant);
    } catch (err) {
      console.warn(`[Match:${options.provider}] retry search failed:`, err.message);
      continue;
    }
    if (!candidates || !candidates.length) continue;

    const result = findBestMatch({ ...query, title: variant }, candidates, { ...options, query: variant });
    if (!bestSoFar || result.score > bestSoFar.score) bestSoFar = result;
    if (result.best && result.score >= threshold) {
      console.log(`[Match:${options.provider}] retry succeeded with variant "${variant}"`);
      return result;
    }
  }

  if (bestSoFar && bestSoFar.score > 0) {
    console.log(`[Match:${options.provider}] no variant cleared threshold — treating as not found (near-miss logged, not returned)`);
  } else {
    console.log(`[Match:${options.provider}] no results found across any title variant`);
  }

  return {
    best: null,
    score: bestSoFar ? bestSoFar.score : 0,
    breakdown: bestSoFar ? bestSoFar.breakdown : {},
    matchedOn: bestSoFar ? bestSoFar.matchedOn : '',
    reason: bestSoFar
      ? `best candidate across all variants scored ${round(bestSoFar.score)}, below threshold ${threshold} — rejected`
      : 'no results found across any title variant',
    ranked: bestSoFar ? bestSoFar.ranked : [],
  };
}

function buildRetryTitleVariants(opts) {
  const variants = [opts.title, opts.originalTitle, ...(opts.aliases || [])].filter((t) => !!t && String(t).trim().length > 0);
  return [...new Set(variants)];
}

module.exports = { findBestMatch, findBestMatchWithRetry, buildRetryTitleVariants, scoreCandidate, normalizeStripQuality };