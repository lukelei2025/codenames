import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_LOCAL_PATH = path.join(PROJECT_ROOT, ".env.local");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

function withTimeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(baseUrl, { method: "GET" });
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(1000);
  }
  throw new Error(
    `无法连接前端服务：${baseUrl}。请先启动 dev server（例如 npm run dev -- --host 127.0.0.1 --port 5173）。`,
  );
}

async function waitForCardClass(page, word, classPart, timeout = 15000) {
  await page.waitForFunction(
    ({ targetWord, cls }) => {
      const buttons = Array.from(document.querySelectorAll(".board-grid button"));
      const target = buttons.find((b) => b.textContent?.trim() === targetWord);
      return !!target && typeof target.className === "string" && target.className.includes(cls);
    },
    { targetWord: word, cls: classPart },
    { timeout },
  );
}

async function waitForCardDisabled(page, word, expected = true, timeout = 15000) {
  await page.waitForFunction(
    ({ targetWord, expectedDisabled }) => {
      const buttons = Array.from(document.querySelectorAll(".board-grid button"));
      const target = buttons.find((b) => b.textContent?.trim() === targetWord);
      return !!target && target.disabled === expectedDisabled;
    },
    { targetWord: word, expectedDisabled: expected },
    { timeout },
  );
}

async function waitForTurn(page, teamText, timeout = 15000) {
  await page.waitForFunction(
    ({ expectedText }) => {
      const el = document.querySelector(".turn-indicator");
      return !!el && (el.textContent || "").includes(expectedText);
    },
    { expectedText: `当前回合: ${teamText}` },
    { timeout },
  );
}

async function runStep(name, fn) {
  const started = Date.now();
  console.log(`[E2E] ${name}...`);
  await fn();
  console.log(`[E2E] ${name} ✅ (${Date.now() - started}ms)`);
}

function buildFixedBoard(roomId) {
  const words = [
    ["R1", "red"], ["B1", "blue"], ["N1", "neutral"], ["X1", "assassin"], ["R2", "red"],
    ["B2", "blue"], ["N2", "neutral"], ["R3", "red"], ["B3", "blue"], ["N3", "neutral"],
    ["R4", "red"], ["B4", "blue"], ["N4", "neutral"], ["R5", "red"], ["B5", "blue"],
    ["N5", "neutral"], ["R6", "red"], ["B6", "blue"], ["N6", "neutral"], ["R7", "red"],
    ["B7", "blue"], ["N7", "neutral"], ["R8", "red"], ["B8", "blue"], ["R9", "red"],
  ];

  return words.map(([word, color], position) => ({
    room_id: roomId,
    word,
    color,
    position,
    is_revealed: false,
  }));
}

async function main() {
  loadEnvFile(ENV_PATH);
  loadEnvFile(ENV_LOCAL_PATH);

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:5173";
  const headless = process.env.E2E_HEADLESS !== "0";
  const routeMode = (process.env.E2E_ROUTE_MODE || "hash").toLowerCase();
  const defaultWaitMs = Number(process.env.E2E_WAIT_MS || 30000);
  const subscribeStabilizeMs = Number(process.env.E2E_SUBSCRIBE_STABILIZE_MS || 2500);

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("缺少环境变量 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");
  }

  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    throw new Error(
      "缺少 Playwright 依赖。请执行：npm i -D @playwright/test && npx playwright install chromium",
    );
  }

  await waitForServer(baseUrl, 30000);
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let roomId = null;
  let browser = null;

  try {
    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .insert([{ theme: "E2E_REALTIME", language: "中文", current_turn: "red", winner: null }])
      .select()
      .single();
    if (roomError) throw roomError;
    roomId = room.id;

    const cards = buildFixedBoard(roomId);
    const { error: cardsError } = await supabase.from("cards").insert(cards);
    if (cardsError) throw cardsError;

    browser = await chromium.launch({ headless });
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const roomUrl =
      routeMode === "browser"
        ? `${baseUrl}/game/${roomId}`
        : `${baseUrl}/#/game/${roomId}`;
    await Promise.all([pageA.goto(roomUrl), pageB.goto(roomUrl)]);

    await runStep("等待双页面基础加载", async () => {
      await Promise.all([
        pageA.waitForSelector(".board-grid button", { timeout: defaultWaitMs }),
        pageB.waitForSelector(".board-grid button", { timeout: defaultWaitMs }),
        waitForTurn(pageA, "红队", defaultWaitMs),
        waitForTurn(pageB, "红队", defaultWaitMs),
      ]);
    });

    // 可视化模式下页面渲染/订阅建立更慢，给实时通道一点稳定时间，避免首个动作错过事件。
    await pageA.waitForTimeout(subscribeStabilizeMs);
    await pageB.waitForTimeout(subscribeStabilizeMs);

    const countA = await pageA.locator(".board-grid button").count();
    const countB = await pageB.locator(".board-grid button").count();
    assert.equal(countA, 25, "页面A牌数应为25");
    assert.equal(countB, 25, "页面B牌数应为25");

    // A 点击蓝词，红队回合应切到蓝队；B 端需实时同步翻牌。
    await runStep("A 点蓝词，验证双端同步与回合切换", async () => {
      await pageA.locator(".board-grid button", { hasText: "B1" }).click();
      await Promise.race([
        Promise.all([
          waitForCardClass(pageB, "B1", "revealed-blue", defaultWaitMs),
          waitForTurn(pageA, "蓝队", defaultWaitMs),
          waitForTurn(pageB, "蓝队", defaultWaitMs),
        ]),
        withTimeout(defaultWaitMs + 5000),
      ]);
    });

    // 测试结束回合按钮，蓝队 -> 红队。
    await runStep("结束回合，验证蓝队->红队同步", async () => {
      await pageA.getByRole("button", { name: "结束当前回合" }).click();
      await Promise.all([
        waitForTurn(pageA, "红队", defaultWaitMs),
        waitForTurn(pageB, "红队", defaultWaitMs),
      ]);
    });

    // B 点击中立词，红队应切回蓝队。
    await runStep("B 点中立词，验证双端同步与回合切换", async () => {
      await pageB.locator(".board-grid button", { hasText: "N1" }).click();
      await Promise.all([
        waitForCardClass(pageA, "N1", "revealed-neutral", defaultWaitMs),
        waitForTurn(pageA, "蓝队", defaultWaitMs),
        waitForTurn(pageB, "蓝队", defaultWaitMs),
      ]);
    });

    // 间谍头目视角下禁止翻牌。
    await runStep("验证间谍头目视角禁点", async () => {
      await pageA.getByRole("button", { name: "间谍头目视角" }).click();
      await waitForCardDisabled(pageA, "R2", true, defaultWaitMs);
      await pageA.getByRole("button", { name: "队员视角" }).click();
      await waitForCardDisabled(pageA, "R2", false, defaultWaitMs);
    });

    // B 点击刺客，蓝队误点刺客，红队直接获胜。两端都应进入终局并禁点。
    await runStep("B 点刺客，验证终局同步", async () => {
      await pageB.locator(".board-grid button", { hasText: "X1" }).click();
      await Promise.all([
        pageA.waitForSelector(".game-over-alert", { timeout: defaultWaitMs }),
        pageB.waitForSelector(".game-over-alert", { timeout: defaultWaitMs }),
      ]);
    });

    const gameOverA = await pageA.locator(".game-over-alert").innerText();
    const gameOverB = await pageB.locator(".game-over-alert").innerText();
    assert.match(gameOverA, /红队/, "页面A终局应显示红队获胜");
    assert.match(gameOverB, /红队/, "页面B终局应显示红队获胜");

    await runStep("验证终局后禁点", async () => {
      await Promise.all([
        waitForCardDisabled(pageA, "R2", true, defaultWaitMs),
        waitForCardDisabled(pageB, "R2", true, defaultWaitMs),
      ]);
    });

    console.log("E2E 双页面联机回归通过：翻牌同步、回合同步、结束回合、刺客终局、终局禁点均正常。");
  } finally {
    if (browser) await browser.close();
    if (roomId) {
      await supabase.from("rooms").delete().eq("id", roomId);
    }
  }
}

main().catch((err) => {
  console.error("E2E 回归失败:", err?.stack || err?.message || err);
  process.exit(1);
});
