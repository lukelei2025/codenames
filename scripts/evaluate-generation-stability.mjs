import fs from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in environment.");
  process.exit(1);
}

const RUNS_PER_DIFFICULTY = Number(process.env.RUNS_PER_DIFFICULTY || 10);
const MAX_ATTEMPTS_PER_RUN = Number(process.env.MAX_ATTEMPTS_PER_RUN || 1);
const LANGUAGE = process.env.TEST_LANGUAGE || "中文";
const THEME = process.env.TEST_THEME || "";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 280000);
const PAUSE_MS = Number(process.env.PAUSE_MS || 250);
const RETRY_PAUSE_MS = Number(process.env.RETRY_PAUSE_MS || 600);

const allDifficulties = ["简易", "适中", "困难"];
const requestedDifficulties = (process.env.TEST_DIFFICULTIES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DIFFICULTIES = requestedDifficulties.length
  ? requestedDifficulties.filter((d) => allDifficulties.includes(d))
  : allDifficulties;

if (DIFFICULTIES.length === 0) {
  console.error("TEST_DIFFICULTIES is set but contains no valid values. Use: 简易,适中,困难");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSSEChunk(state, chunkText) {
  state.buffer += chunkText;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();

    if (payload === "__DONE__") {
      state.done = true;
      continue;
    }

    if (payload === "__THINKING__") continue;

    if (payload.startsWith("__ERROR__")) {
      state.error = payload.slice(9);
      continue;
    }

    if (payload.startsWith("__CARDS__")) {
      try {
        state.cards = JSON.parse(payload.slice(9));
      } catch {
        state.cardsParseError = true;
      }
      continue;
    }

    if (payload.startsWith("__META__")) {
      try {
        state.meta = JSON.parse(payload.slice(8));
      } catch {
        state.metaParseError = true;
      }
      continue;
    }

    if (payload.startsWith("__WORD__")) {
      const word = payload.slice(8).trim();
      if (word) state.wordsSeen.push(word);
    }
  }
}

function providerOf(result) {
  return result?.meta?.primaryProvider || "unknown";
}

function fallbackUsed(result) {
  const usedCount = result?.meta?.fallback?.usedCount;
  if (typeof usedCount === "number") return usedCount > 0;
  return Boolean(result?.meta?.primaryUsedFallback);
}

function cardColorCounts(cards) {
  const counts = { red: 0, blue: 0, neutral: 0, assassin: 0 };
  for (const c of cards) {
    if (c && typeof c.color === "string" && c.color in counts) {
      counts[c.color] += 1;
    }
  }
  return counts;
}

function analyzeBoard(cards) {
  const words = cards.map((c) => c.word);
  const uniqueWords = new Set(words);
  const colors = cardColorCounts(cards);
  const assassinWord = cards.find((c) => c.color === "assassin")?.word ?? null;

  const shapeOk =
    cards.length === 25 &&
    uniqueWords.size === 25 &&
    colors.red === 9 &&
    colors.blue === 8 &&
    colors.neutral === 7 &&
    colors.assassin === 1;

  return {
    shapeOk,
    cardsCount: cards.length,
    uniqueWordCount: uniqueWords.size,
    words,
    assassinWord,
    colorCounts: colors,
  };
}

async function runOne(difficulty, runIndex) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-board`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        theme: THEME,
        language: LANGUAGE,
        difficulty,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      return {
        difficulty,
        runIndex,
        ok: false,
        reason: `http_${response.status}`,
        httpStatus: response.status,
        httpBody: body.slice(0, 400),
        durationMs: Date.now() - startedAt,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = {
      buffer: "",
      done: false,
      error: "",
      cards: null,
      cardsParseError: false,
      meta: null,
      metaParseError: false,
      wordsSeen: [],
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parseSSEChunk(state, decoder.decode(value, { stream: true }));
      if (state.done || state.error) break;
    }

    if (state.buffer.trim()) parseSSEChunk(state, "\n");

    const durationMs = Date.now() - startedAt;

    if (state.error) {
      return {
        difficulty,
        runIndex,
        ok: false,
        reason: "stream_error",
        streamError: state.error,
        wordsSeenCount: state.wordsSeen.length,
        cardsSeenCount: Array.isArray(state.cards) ? state.cards.length : 0,
        meta: state.meta,
        metaParseError: state.metaParseError,
        durationMs,
      };
    }

    if (!Array.isArray(state.cards)) {
      return {
        difficulty,
        runIndex,
        ok: false,
        reason: state.cardsParseError ? "cards_parse_error" : "missing_cards",
        wordsSeenCount: state.wordsSeen.length,
        meta: state.meta,
        metaParseError: state.metaParseError,
        durationMs,
      };
    }

    const board = analyzeBoard(state.cards);
    return {
      difficulty,
      runIndex,
      ok: board.shapeOk,
      reason: board.shapeOk ? "ok" : "invalid_board_shape",
      durationMs,
      wordsSeenCount: state.wordsSeen.length,
      meta: state.meta,
      metaParseError: state.metaParseError,
      board,
    };
  } catch (err) {
    return {
      difficulty,
      runIndex,
      ok: false,
      reason: err?.name === "AbortError" ? "timeout" : "exception",
      error: String(err?.message || err),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runWithRetries(difficulty, runIndex) {
  const attempts = [];
  let lastResult = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_RUN; attempt++) {
    const result = await runOne(difficulty, runIndex);
    lastResult = result;
    attempts.push({
      attempt,
      ok: result.ok,
      reason: result.reason,
      durationMs: result.durationMs,
      error: result.error,
      streamError: result.streamError,
      httpStatus: result.httpStatus,
    });

    if (result.ok) {
      return {
        ...result,
        attemptsTried: attempt,
        successOnAttempt: attempt,
        attempts,
      };
    }

    if (attempt < MAX_ATTEMPTS_PER_RUN && RETRY_PAUSE_MS > 0) {
      await sleep(RETRY_PAUSE_MS);
    }
  }

  return {
    ...lastResult,
    attemptsTried: MAX_ATTEMPTS_PER_RUN,
    successOnAttempt: null,
    attempts,
  };
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function jaccard(wordsA, wordsB) {
  const a = new Set(wordsA);
  const b = new Set(wordsB);
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildDifficultySummary(results) {
  const total = results.length;
  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  const reasonCounts = Object.fromEntries(
    Object.entries(
      failures.reduce((acc, r) => {
        acc[r.reason] = (acc[r.reason] || 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  );

  const durations = results.map((r) => r.durationMs).filter((n) => typeof n === "number");
  const successDurations = successes.map((r) => r.durationMs);
  const attemptsUsedAll = results.map((r) => r.attemptsTried ?? 1);
  const attemptsUsedSuccess = successes.map((r) => r.attemptsTried ?? 1);
  const successAttemptDistribution = Object.fromEntries(
    Object.entries(
      successes.reduce((acc, r) => {
        const key = String(r.successOnAttempt ?? 1);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => Number(a[0]) - Number(b[0])),
  );

  const wordFreq = new Map();
  const assassinFreq = new Map();
  const providerCounts = new Map();
  const successByAttemptProvider = new Map();
  const fallbackCountByLabel = new Map();
  let fallbackUsedRuns = 0;
  const boards = [];
  const boardsByProvider = new Map();
  const boardsByAttempt = new Map();

  for (const r of successes) {
    const words = r.board.words;
    boards.push(words);
    const provider = providerOf(r);
    const attempt = Number(r.successOnAttempt || 1);
    providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
    const apKey = `${attempt}|${provider}`;
    successByAttemptProvider.set(apKey, (successByAttemptProvider.get(apKey) || 0) + 1);

    if (!boardsByProvider.has(provider)) boardsByProvider.set(provider, []);
    boardsByProvider.get(provider).push(words);
    if (!boardsByAttempt.has(attempt)) boardsByAttempt.set(attempt, []);
    boardsByAttempt.get(attempt).push(words);

    if (fallbackUsed(r)) {
      fallbackUsedRuns += 1;
      const labels = r?.meta?.fallback?.labels || [];
      for (const label of labels) {
        fallbackCountByLabel.set(label, (fallbackCountByLabel.get(label) || 0) + 1);
      }
    }

    for (const w of words) {
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }
    if (r.board.assassinWord) {
      const aw = r.board.assassinWord;
      assassinFreq.set(aw, (assassinFreq.get(aw) || 0) + 1);
    }
  }

  const pairwiseJaccard = [];
  for (let i = 0; i < boards.length; i++) {
    for (let j = i + 1; j < boards.length; j++) {
      pairwiseJaccard.push(jaccard(boards[i], boards[j]));
    }
  }

  const overlapByProvider = Object.fromEntries(
    [...boardsByProvider.entries()].map(([provider, providerBoards]) => {
      const vals = [];
      for (let i = 0; i < providerBoards.length; i++) {
        for (let j = i + 1; j < providerBoards.length; j++) {
          vals.push(jaccard(providerBoards[i], providerBoards[j]));
        }
      }
      return [
        provider,
        {
          boards: providerBoards.length,
          pairCount: vals.length,
          meanJaccard: mean(vals),
          p95Jaccard: percentile(vals, 95),
        },
      ];
    }),
  );

  const attemptBuckets = Object.fromEntries(
    [...boardsByAttempt.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([attempt, attemptBoards]) => {
        const vals = [];
        for (let i = 0; i < attemptBoards.length; i++) {
          for (let j = i + 1; j < attemptBoards.length; j++) {
            vals.push(jaccard(attemptBoards[i], attemptBoards[j]));
          }
        }
        return [
          String(attempt),
          {
            boards: attemptBoards.length,
            pairCount: vals.length,
            meanJaccard: mean(vals),
            p95Jaccard: percentile(vals, 95),
          },
        ];
      }),
  );

  const crossAttemptOverlap = {};
  const attemptKeys = [...boardsByAttempt.keys()].sort((a, b) => a - b);
  for (let i = 0; i < attemptKeys.length; i++) {
    for (let j = i + 1; j < attemptKeys.length; j++) {
      const a = attemptKeys[i];
      const b = attemptKeys[j];
      const vals = [];
      for (const ba of boardsByAttempt.get(a)) {
        for (const bb of boardsByAttempt.get(b)) {
          vals.push(jaccard(ba, bb));
        }
      }
      crossAttemptOverlap[`${a}_vs_${b}`] = {
        pairCount: vals.length,
        meanJaccard: mean(vals),
        p95Jaccard: percentile(vals, 95),
      };
    }
  }

  const topRepeatedWords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([word, count]) => ({ word, count }));

  const topAssassinWords = [...assassinFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));

  return {
    totalRuns: total,
    successRuns: successes.length,
    successRate: total ? successes.length / total : 0,
    failureReasonCounts: reasonCounts,
    durationMs: {
      avgAll: mean(durations),
      p50All: percentile(durations, 50),
      p95All: percentile(durations, 95),
      avgSuccess: mean(successDurations),
      p95Success: percentile(successDurations, 95),
    },
    attempts: {
      maxAttemptsPerRun: MAX_ATTEMPTS_PER_RUN,
      avgAll: mean(attemptsUsedAll),
      avgSuccess: mean(attemptsUsedSuccess),
      successOnAttemptCounts: successAttemptDistribution,
      successByAttemptAndProvider: Object.fromEntries(
        [...successByAttemptProvider.entries()]
          .sort((a, b) => {
            const [aa, ap] = a[0].split("|");
            const [ba, bp] = b[0].split("|");
            return Number(aa) - Number(ba) || ap.localeCompare(bp);
          })
          .map(([k, v]) => {
            const [attempt, provider] = k.split("|");
            return [`attempt_${attempt}.${provider}`, v];
          }),
      ),
    },
    modelUsage: {
      primaryProviderCounts: Object.fromEntries(
        [...providerCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
      fallbackUsedRuns,
      fallbackUsedRate: successes.length ? fallbackUsedRuns / successes.length : null,
      fallbackLabelCounts: Object.fromEntries(
        [...fallbackCountByLabel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
    },
    overlap: {
      pairCount: pairwiseJaccard.length,
      meanJaccard: mean(pairwiseJaccard),
      p95Jaccard: percentile(pairwiseJaccard, 95),
      byProvider: overlapByProvider,
      bySuccessAttempt: attemptBuckets,
      crossSuccessAttempts: crossAttemptOverlap,
    },
    topRepeatedWords,
    topAssassinWords,
  };
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  const runStartedAt = Date.now();
  const allResults = [];

  for (const difficulty of DIFFICULTIES) {
    for (let i = 0; i < RUNS_PER_DIFFICULTY; i++) {
      const result = await runWithRetries(difficulty, i + 1);
      allResults.push(result);
      const sec = (result.durationMs / 1000).toFixed(1);
      const attemptText = result.ok
        ? `success_on_attempt=${result.successOnAttempt}`
        : `failed_after_attempt=${result.attemptsTried}`;
      console.log(`[${difficulty}] ${i + 1}/${RUNS_PER_DIFFICULTY} -> ${result.reason} (ok=${result.ok}, ${sec}s, ${attemptText})`);
      if (PAUSE_MS > 0) await sleep(PAUSE_MS);
    }
  }

  const grouped = Object.fromEntries(
    DIFFICULTIES.map((d) => [d, allResults.filter((r) => r.difficulty === d)]),
  );

  const summary = Object.fromEntries(
    DIFFICULTIES.map((d) => [d, buildDifficultySummary(grouped[d])]),
  );

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      totalDurationMs: Date.now() - runStartedAt,
      runsPerDifficulty: RUNS_PER_DIFFICULTY,
      maxAttemptsPerRun: MAX_ATTEMPTS_PER_RUN,
      language: LANGUAGE,
      theme: THEME,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
    summary,
    runs: allResults,
  };

  const stamp = nowStamp();
  const outDir = path.resolve("analysis");
  await fs.mkdir(outDir, { recursive: true });

  const jsonPath = path.join(outDir, `generation-stability-${stamp}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`Saved raw report: ${jsonPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
