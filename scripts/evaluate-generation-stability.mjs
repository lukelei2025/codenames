import fs from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in environment.");
  process.exit(1);
}

const RUNS_PER_DIFFICULTY = Number(process.env.RUNS_PER_DIFFICULTY || 10);
const LANGUAGE = process.env.TEST_LANGUAGE || "中文";
const THEME = process.env.TEST_THEME || "";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 280000);
const PAUSE_MS = Number(process.env.PAUSE_MS || 250);

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

    if (payload.startsWith("__WORD__")) {
      const word = payload.slice(8).trim();
      if (word) state.wordsSeen.push(word);
    }
  }
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

  const wordFreq = new Map();
  const assassinFreq = new Map();
  const boards = [];

  for (const r of successes) {
    const words = r.board.words;
    boards.push(words);
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
    overlap: {
      pairCount: pairwiseJaccard.length,
      meanJaccard: mean(pairwiseJaccard),
      p95Jaccard: percentile(pairwiseJaccard, 95),
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
      const result = await runOne(difficulty, i + 1);
      allResults.push(result);
      const sec = (result.durationMs / 1000).toFixed(1);
      console.log(`[${difficulty}] ${i + 1}/${RUNS_PER_DIFFICULTY} -> ${result.reason} (ok=${result.ok}, ${sec}s)`);
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
