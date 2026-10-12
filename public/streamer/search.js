/* MacStream — search.js
 * Typo-tolerant search layered on top of the existing GET /api/search?q= endpoint (no backend changes).
 *
 * How it works
 *  1. Normalise the query (case, accents, punctuation, extra spaces, "&" -> "and").
 *  2. Fire the cleaned query plus a few cheap variants in parallel:
 *       - words joined ("spider man" -> "spiderman")
 *       - the closest titles we already know (trending, past results, watch history), matched fuzzily
 *     and, only if nothing good came back, truncated forms of the longest word ("intersteler" -> "interstel").
 *  3. Merge, de-duplicate, then re-rank every result by title similarity (exact > prefix > contains >
 *     per-word fuzzy > whole-string edit distance) so the right title floats to the top.
 *  4. If the user's spelling matched nothing but a variant did, report it as `corrected` so the UI can say
 *     "Showing results for …".
 */
(function () {
  'use strict';

  const VOCAB_KEY = 'macstream.vocab.v1';
  const VOCAB_MAX = 800;
  const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to']);

  /* ---------- normalisation ---------- */
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim().replace(/\s+/g, ' ');
  }
  const squash = (s) => norm(s).replace(/ /g, '');
  const tolerance = (n) => (n <= 3 ? 0 : n <= 6 ? 1 : n <= 9 ? 2 : 3);

  /* ---------- Damerau–Levenshtein (optimal string alignment), with an early-out ---------- */
  function editDistance(a, b, max) {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    if (!la || !lb) return Math.max(la, lb);
    let prev2 = null;
    let prev = Array.from({ length: lb + 1 }, (_, j) => j);
    for (let i = 1; i <= la; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[lb];
  }

  /* Sound-alike key so "nite"/"night", "fone"/"phone", "kat"/"cat" compare equal. */
  function phon(w) {
    let x = w.replace(/ght/g, 't').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/^kn/, 'n').replace(/^wr/, 'r')
      .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k').replace(/z/g, 's').replace(/x/g, 'ks')
      .replace(/(.)\1+/g, '$1');
    if (x.length > 3) x = x.replace(/e$/, '');
    return x;
  }

  /* ---------- similarity: 0..1 between a query and a title ---------- */
  function similarity(query, title) {
    const q = norm(query), t = norm(title);
    if (!q || !t) return 0;
    const qs = q.replace(/ /g, ''), ts = t.replace(/ /g, '');
    if (qs === ts) return 1;
    if (ts.startsWith(qs)) return 0.94 - Math.min(0.1, (ts.length - qs.length) * 0.004);
    if (qs.length >= 3 && ts.includes(qs)) return 0.84;
    if (qs.length >= 3 && qs.includes(ts) && ts.length >= 4) return 0.7;

    // per-word matching (handles reordered/missing words and a typo in each word)
    const qt = q.split(' ').filter((w) => !STOP.has(w));
    const tt = t.split(' ');
    let wordScore = 0;
    if (qt.length) {
      let sum = 0;
      for (const w of qt) {
        let best = 0;
        for (const x of tt) {
          if (w === x) { best = 1; break; }
          if (w.length >= 2 && x.startsWith(w)) best = Math.max(best, 0.93);
          if (w.length >= 3 && phon(w) === phon(x)) best = Math.max(best, 0.86);
          const tol = tolerance(Math.min(w.length, x.length));
          if (tol) {
            const d = editDistance(w, x, tol);
            if (d <= tol) best = Math.max(best, 0.88 - d * 0.1);
          }
        }
        sum += best;
      }
      wordScore = (sum / qt.length) * 0.9;
    }

    // whole-string distance, also against a same-length prefix so half-typed titles still match
    const maxD = Math.max(1, Math.floor(qs.length * 0.3));
    const d1 = editDistance(qs, ts, maxD);
    const d2 = qs.length >= 4 ? editDistance(qs, ts.slice(0, qs.length), maxD) : maxD + 1;
    const dBest = Math.min(d1, d2 + 0.5);
    const whole = dBest <= maxD ? 0.9 - (dBest / Math.max(qs.length, 4)) * 1.2 : 0;

    const sound = qs.length >= 4 && phon(qs) === phon(ts) ? 0.85 : 0;
    return Math.max(wordScore, whole, sound);
  }

  /* ---------- vocabulary of titles we've seen (for "did you mean") ---------- */
  let vocab = null;
  function loadVocab() {
    if (vocab) return vocab;
    try { vocab = JSON.parse(localStorage.getItem(VOCAB_KEY)) || []; } catch (_) { vocab = []; }
    if (!Array.isArray(vocab)) vocab = [];
    return vocab;
  }
  function learn(items) {
    const v = loadVocab();
    const seen = new Set(v.map((x) => norm(x)));
    let changed = false;
    (items || []).forEach((it) => {
      const t = it && (it.title || it);
      if (typeof t !== 'string' || t.length < 2) return;
      const k = norm(t);
      if (!k || seen.has(k)) return;
      seen.add(k); v.unshift(t); changed = true;
    });
    if (changed) {
      if (v.length > VOCAB_MAX) v.length = VOCAB_MAX;
      try { localStorage.setItem(VOCAB_KEY, JSON.stringify(v)); } catch (_) { /* private mode / quota */ }
    }
  }
  function closestKnown(query, limit) {
    return loadVocab()
      .map((t) => ({ t, s: similarity(query, t) }))
      .filter((x) => x.s >= 0.62 && x.s < 1.0001)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit || 3);
  }

  /* ---------- query variants ---------- */
  function primaryVariants(raw) {
    const clean = String(raw).trim().replace(/\s+/g, ' ');
    const n = norm(raw);
    const out = [];
    const add = (q, why) => { q = q.trim(); if (q.length >= 2 && !out.some((o) => o.q.toLowerCase() === q.toLowerCase())) out.push({ q, why }); };
    add(clean, 'exact');
    const words = n.split(' ').filter(Boolean);
    if (words.length > 1) add(words.join(''), 'joined');
    closestKnown(raw, 3).forEach((k) => add(k.t, 'known'));
    return out;
  }
  function truncationVariants(raw) {
    const words = norm(raw).split(' ').filter(Boolean).sort((a, b) => b.length - a.length);
    const out = [];
    const long = words[0];
    if (!long || long.length < 5) return out;
    out.push({ q: long.slice(0, -1), why: 'trim1' });
    if (long.length >= 7) out.push({ q: long.slice(0, -2), why: 'trim2' });
    if (words.length > 1) out.push({ q: long, why: 'longest' });
    // also try dropping a character from the middle region that often differs (skipped letters / doubled letters)
    const head = long.slice(0, Math.max(4, Math.ceil(long.length * 0.6)));
    out.push({ q: head, why: 'head' });
    return out.filter((o, i, a) => a.findIndex((x) => x.q === o.q) === i).slice(0, 4);
  }

  /* ---------- main entry ---------- */
  /**
   * @param {string} raw
   * @param {(q:string, signal:AbortSignal)=>Promise<Array>} fetchResults  returns [{id,type,title,...}]
   * @param {AbortSignal} signal
   * @returns {Promise<{results:Array, corrected:string|null, variantsTried:string[]}>}
   */
  async function search(raw, fetchResults, signal) {
    const n = norm(raw);
    if (!n) return { results: [], corrected: null, variantsTried: [] };

    const pool = new Map();       // key -> { item, score }
    const tried = [];
    let primaryCount = 0;
    let primaryError = null;

    const run = async (variants, isPrimary) => {
      const settled = await Promise.allSettled(variants.map((v) => fetchResults(v.q, signal)));
      settled.forEach((res, i) => {
        tried.push(variants[i].q);
        if (res.status !== 'fulfilled') {
          if (isPrimary && variants[i].why === 'exact') primaryError = res.reason;
          return;
        }
        const list = res.value || [];
        if (isPrimary && variants[i].why === 'exact') primaryCount = list.length;
        list.forEach((item) => {
          const key = `${item.type}:${item.id}`;
          const score = similarity(raw, item.title);
          const have = pool.get(key);
          if (!have) pool.set(key, { item, score, viaVariant: variants[i].why !== 'exact', direct: variants[i].why === 'exact' });
          else if (variants[i].why === 'exact') have.direct = true;
        });
      });
    };

    await run(primaryVariants(raw), true);
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (primaryError && !pool.size) throw primaryError;       // genuine API failure, not "no matches"

    const bestScore = () => Math.max(0, ...[...pool.values()].map((x) => x.score));
    if (bestScore() < 0.75) {
      await run(truncationVariants(raw), false);
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    }

    // Keep results that came straight from the user's own query (the API found them relevant);
    // only keep variant-only hits if they genuinely resemble what was typed.
    const kept = [...pool.values()].filter((x) => x.direct || x.score >= 0.6);
    kept.sort((a, b) => (b.score - a.score) || ((b.item.rating || 0) - (a.item.rating || 0)));
    const results = kept.map((x) => x.item);

    let corrected = null;
    if (kept.length) {
      const top = kept[0];
      const typedExactish = similarity(raw, top.item.title) >= 0.9 && top.direct;
      if (!typedExactish && (primaryCount === 0 || (top.score >= 0.75 && !top.direct))) corrected = top.item.title;
    }
    learn(results.slice(0, 20));
    return { results, corrected, variantsTried: tried };
  }

  window.MacSearch = { search, learn, similarity, norm, editDistance, closestKnown };
})();