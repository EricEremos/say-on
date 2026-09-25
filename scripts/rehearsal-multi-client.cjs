"use strict";

/**
 * Drives a host plus two guests through the Say-On shared-room journey
 * (create room -> join by invite code -> ready up -> pick a game -> start ->
 * vote on a Balance prompt -> leave/rejoin -> room isolation) and writes a
 * machine-readable evidence file.
 *
 * Two modes:
 *  - rehearsal (default): ONE Chromium browser context with four pages
 *    (host, guestA, guestB, separateRoom) so the app's browser-local
 *    "rehearsal" transport (localStorage + BroadcastChannel, see
 *    src/hooks/use-group-room.ts and src/hooks/use-room-activity.ts) can
 *    sync between pages of the same profile, exactly like a real user
 *    opening several tabs. No Supabase env is required; --base-url must
 *    point at a `vite preview`/static server of the production build.
 *  - connected: FOUR isolated Chromium browser contexts (host, guestA,
 *    guestB, separateRoom), each with independent storage/anonymous auth,
 *    so the journey exercises the real Supabase RPC + Realtime transport
 *    (src/hooks/use-group-room.ts's useRemoteGroupRoom and friends).
 *    --base-url must point at a build served with real
 *    VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY/VITE_EVENT_CODE.
 *
 * Known, verified rehearsal-mode gaps (see the final report / commit
 * message for how these were confirmed): the browser-local room hook
 * (`useRehearsalGroupRoom`) keeps an independent, per-tab copy of the room
 * roster that never learns about other tabs (it ignores the displayName
 * argument entirely and never increments joinedCount past 1), so the
 * shared roster/readiness/"start the round" portion of the journey is
 * unreachable by design in --mode rehearsal. Those steps are recorded as
 * `skipped` with a reason instead of a faked pass. Everything else (room
 * creation, invite-code join, local UI actions, chat, and the separate-room
 * check) is exercised for real in both modes.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const SCRIPT_VERSION = "1.1.0"; // 1.1.0: connected-mode card draw, exact tallies, pacing, known gaps only in rehearsal mode
const DEFAULT_ROOM_NAME = "QA rehearsal";
const WAIT_TIMEOUT_MS = 6000;
const SHORT_SETTLE_MS = 500; // below the 1s fixed-sleep ceiling; used only to let a fired-and-forgotten async write settle before reading

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    mode: "rehearsal",
    baseUrl: null,
    out: null,
    // Active room names are unique per event, and a closed browser leaves its room open until it
    // expires, so each invocation needs its own name to rerun against the same project.
    roomName: `${DEFAULT_ROOM_NAME} ${Date.now().toString(36).slice(-6)}`,
    runs: 1,
    headless: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      index += 1;
      return value;
    };
    if (token === "--mode") args.mode = takeValue();
    else if (token === "--base-url") args.baseUrl = takeValue();
    else if (token === "--out") args.out = takeValue();
    else if (token === "--room-name") args.roomName = takeValue();
    else if (token === "--runs") args.runs = Number(takeValue());
    else if (token === "--headless") args.headless = true;
    else if (token === "--headless=false" || token === "--no-headless") args.headless = false;
    else if (token === "--headless=true") args.headless = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

const USAGE = `Usage: node scripts/rehearsal-multi-client.cjs --base-url <url> [options]

Options:
  --base-url <url>     Origin of the served build (required), e.g. http://127.0.0.1:4184
  --mode <mode>         rehearsal (default) or connected
  --out <path>          Evidence JSON path (default docs/design-review/say-on-multi-client-rehearsal-<timestamp>.json)
  --room-name <name>    Room name the host creates (default "${DEFAULT_ROOM_NAME} <run id>")
  --runs <n>             Repeat the concurrency-sensitive steps n times (default 1)
  --headless / --no-headless  Chromium headless toggle (default headless)
`;

// ---------------------------------------------------------------------------
// Evidence recorder
// ---------------------------------------------------------------------------

function createEvidence({ mode, baseUrl, roomName, runs }) {
  const steps = [];

  const push = (entry) => {
    steps.push(entry);
    return entry;
  };

  /**
   * Runs `fn(...)`, records the outcome. If `fn` throws and `knownGapReason`
   * was supplied for the active mode, the step is recorded as `skipped`
   * (not failed) with that reason -- used only for the documented rehearsal
   * transport gaps, never to hide a real defect.
   */
  const step = async (name, client, fn, { run = null, knownGapReason = null } = {}) => {
    const startedAt = Date.now();
    try {
      const observed = await fn();
      return push({ name, client, run, observed: observed ?? "ok", passed: true, skipped: false, reason: null, ms: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Known gaps describe the browser-local transport only; in connected mode every throw is a failure.
      if (knownGapReason !== null && mode === "rehearsal") {
        return push({ name, client, run, observed: message, passed: false, skipped: true, reason: knownGapReason, ms: Date.now() - startedAt });
      }
      return push({ name, client, run, observed: message, passed: false, skipped: false, reason: null, ms: Date.now() - startedAt });
    }
  };

  /** Records a step that this mode deliberately does not run, with the reason. */
  const skip = (name, client, reason, { run = null } = {}) =>
    push({ name, client, run, observed: "not run in this mode", passed: false, skipped: true, reason, ms: 0 });

  const summarize = () => {
    const passed = steps.filter((entry) => entry.passed).length;
    const skipped = steps.filter((entry) => entry.skipped).length;
    const failed = steps.filter((entry) => !entry.passed && !entry.skipped).length;
    return { total: steps.length, passed, failed, skipped, mode, baseUrl, roomName, runs };
  };

  return { steps, step, skip, summarize };
}

function printTable(steps) {
  const rows = steps.map((entry) => ({
    run: entry.run === null ? "-" : String(entry.run),
    status: entry.skipped ? "SKIP" : entry.passed ? "PASS" : "FAIL",
    client: entry.client,
    name: entry.name,
    ms: String(entry.ms),
  }));
  const widths = ["run", "status", "client", "name", "ms"].reduce((acc, key) => {
    acc[key] = Math.max(key.length, ...rows.map((row) => row[key].length));
    return acc;
  }, {});
  const line = (row) => ["run", "status", "client", "name", "ms"].map((key) => row[key].padEnd(widths[key])).join("  ");
  console.log(line({ run: "run", status: "status", client: "client", name: "name", ms: "ms" }));
  console.log(["run", "status", "client", "name", "ms"].map((key) => "-".repeat(widths[key])).join("  "));
  for (const row of rows) console.log(line(row));
}

// ---------------------------------------------------------------------------
// DOM helpers -- Korean labels/roles read directly from src/App.tsx,
// src/hooks/use-group-room.ts, src/hooks/use-room-activity.ts,
// src/lib/room-entry.ts and src/components/BalanceQuestion.tsx.
// ---------------------------------------------------------------------------

const inviteCodeFromUrl = (url) => {
  const match = new URL(url).pathname === "/room" ? new URL(url).searchParams.get("code") : null;
  return match;
};

async function openJoinPage(page, baseUrl) {
  await page.goto(`${baseUrl}/join`, { waitUntil: "domcontentloaded" }); // fonts come from a third-party CDN; never wait on them
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: WAIT_TIMEOUT_MS });
  return await page.getByRole("heading", { level: 1 }).first().innerText();
}

async function createRoom(page, roomName) {
  await page.getByRole("button", { name: "방 만들기", exact: true }).click();
  const nameField = page.getByRole("textbox", { name: "방 이름", exact: true });
  await nameField.waitFor({ timeout: WAIT_TIMEOUT_MS });
  await nameField.fill(roomName);
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await page.waitForURL(/\/room\?code=[A-F0-9]{8}/, { timeout: WAIT_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  const code = inviteCodeFromUrl(page.url());
  assert.ok(code !== null, "invite code missing from post-creation URL");
  return code;
}

async function enterDisplayName(page, name) {
  const field = page.getByRole("textbox", { name: "방에서 사용할 이름" });
  await field.waitFor({ timeout: WAIT_TIMEOUT_MS });
  await field.fill(name);
  await page.getByRole("button", { name: "내 이름으로 들어갑니다" }).click();
  await page.locator("#waiting-title").waitFor({ timeout: WAIT_TIMEOUT_MS });
  return await page.locator("#waiting-title").innerText();
}

async function joinRoomByInviteCode(page, baseUrl, code, name) {
  await page.goto(`${baseUrl}/room?code=${code}`, { waitUntil: "domcontentloaded" });
  return enterDisplayName(page, name);
}

async function rosterNames(page) {
  const items = page.locator(".participant-roster__item strong");
  const count = await items.count();
  const names = [];
  for (let index = 0; index < count; index += 1) names.push((await items.nth(index).innerText()).trim());
  return names;
}

async function toggleReady(page) {
  const button = page.getByRole("button", { name: /준비하기|준비 취소/ });
  await button.waitFor({ timeout: WAIT_TIMEOUT_MS });
  await button.click({ timeout: WAIT_TIMEOUT_MS });
  return (await page.locator(".readiness-count").innerText()).trim();
}

async function selectGame(page, gameLabel) {
  const button = page.getByRole("button", { name: gameLabel, exact: false });
  await button.waitFor({ timeout: WAIT_TIMEOUT_MS });
  await button.click();
  await page.waitForFunction(
    (label) => Array.from(document.querySelectorAll(".game-selection__option--selected strong")).some((el) => el.textContent === label),
    gameLabel,
    { timeout: WAIT_TIMEOUT_MS },
  );
  return `${gameLabel} selected`;
}

async function sendChatMessage(page, content) {
  const composer = page.locator("#room-chat-message");
  await composer.waitFor({ timeout: WAIT_TIMEOUT_MS });
  await composer.fill(content);
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page.waitForFunction((text) => document.querySelector(".room-chat__messages")?.textContent?.includes(text) ?? false, content, { timeout: WAIT_TIMEOUT_MS });
}

// The page's Google Fonts stylesheet blocks the app's module script, so a slow font CDN delays
// DOMContentLoaded and fails unrelated steps. Text falls back to system fonts; the journey under
// test does not depend on them.
async function withoutThirdPartyFonts(context) {
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//u, (route) => route.abort());
}

async function waitForGuestGameStatus(pages, gameLabel) {
  await Promise.all(pages.map((page) => page.waitForFunction(
    (label) => document.querySelector(".game-status strong")?.textContent?.trim() === label,
    gameLabel,
    { timeout: WAIT_TIMEOUT_MS },
  )));
  return `${gameLabel} seen by ${pages.length} guests`;
}

// A connected round draws a card before any prompt exists: the client whose turn it is picks one
// of three cards and opens the question. Returns the index of the page that chose.
async function drawCardAsTurnOwner(pages) {
  // Only a client allowed to choose renders the choice panel (#choice-title); poll until one does.
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let titles = [];
  while (Date.now() < deadline) {
    titles = await Promise.all(pages.map(async (page) => ((await page.locator("#choice-title").count()) > 0 ? page.locator("#choice-title").innerText() : null)));
    if (titles.some((title) => title !== null)) break;
    await pages[0].waitForTimeout(250);
  }
  const mine = titles.findIndex((title) => title?.startsWith("내 차례"));
  const ownerIndex = mine !== -1 ? mine : titles.findIndex((title) => title !== null);
  if (ownerIndex === -1) {
    const views = await Promise.all(pages.map((page) => page.locator(".live-room").innerText().then((text) => text.replace(/\s+/g, " ").slice(0, 120)).catch(() => "no live room")));
    throw new Error(`no client can choose a card: ${views.join(" | ")}`);
  }
  await pages[ownerIndex].locator(".question-cards button.question-card").first().click();
  await pages[ownerIndex].getByRole("button", { name: "질문 열기", exact: true }).click();
  return ownerIndex;
}

// Polls until every page shows exactly `expected` Balance counts ([choice A, choice B]): over a
// real network a vote needs a round trip plus a Realtime event before other clients show it, and
// matching an exact distribution (not mere agreement) proves this run's votes actually landed.
async function waitForTallies(pages, expected) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let counts = [];
  while (Date.now() < deadline) {
    counts = await Promise.all(pages.map(async (page) => (await page.locator(".say-balance__count").allInnerTexts()).map((text) => Number.parseInt(text, 10))));
    if (counts.every((pageCounts) => JSON.stringify(pageCounts) === JSON.stringify(expected))) return expected.map((count) => `${count}표`);
    await pages[0].waitForTimeout(250);
  }
  throw new Error(`tallies did not reach ${JSON.stringify(expected)} on every client: ${JSON.stringify(counts)}`);
}

// A room accepts at most five chat messages per author in ten seconds (send_group_chat_message);
// pace each author so a deliberate anti-spam rejection is never mistaken for a lost message.
const CHAT_WINDOW_MS = 10_500;
const chatSendsByAuthor = new Map();
async function waitForChatAllowance(page, author) {
  const recent = (chatSendsByAuthor.get(author) ?? []).filter((time) => Date.now() - time < CHAT_WINDOW_MS);
  if (recent.length >= 5) await page.waitForTimeout(CHAT_WINDOW_MS - (Date.now() - recent[0]));
  chatSendsByAuthor.set(author, [...recent.filter((time) => Date.now() - time < CHAT_WINDOW_MS), Date.now()]);
}

// Leaves from wherever the member is: the waiting room's own link, or during a round the header's
// brand link, which runs the same leave handler (src/App.tsx handleLeaveRoom).
async function leaveRoom(page) {
  const inWaitingRoom = (await page.locator(".waiting-room").count()) > 0;
  const link = inWaitingRoom
    ? page.locator(".waiting-room").getByRole("link", { name: "처음으로" })
    : page.locator("header.room-topline a.brand");
  await link.waitFor({ timeout: WAIT_TIMEOUT_MS });
  await link.click({ timeout: WAIT_TIMEOUT_MS });
  await page.waitForURL(/\/join$/, { timeout: WAIT_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  return page.url();
}

async function expandRoomSettings(page) {
  // <summary> is the disclosure control for <details class="room-utility"> in
  // WaitingRoom (host only). It is NOT exposed with an ARIA "button" role in
  // Chromium (verified empirically), so it must be targeted structurally
  // rather than via getByRole -- getByRole("button", { name: "방 설정" })
  // always resolves to zero matches even though the element is real and
  // clickable.
  const summary = page.locator("details.room-utility summary", { hasText: "방 설정" });
  if ((await summary.count()) === 0) return false;
  const expanded = await page.locator("details.room-utility").getAttribute("open");
  if (expanded === null) await summary.click({ timeout: WAIT_TIMEOUT_MS });
  return true;
}

async function setExpectedAttendance(page, value) {
  const opened = await expandRoomSettings(page);
  if (!opened) throw new Error("room settings disclosure not present (non-host page)");
  const input = page.locator("#expected-attendance");
  await input.waitFor({ timeout: WAIT_TIMEOUT_MS });
  await input.fill(String(value));
  const applyButton = page.getByRole("button", { name: "변경", exact: true });
  await applyButton.click();
  await page.waitForFunction((expected) => document.querySelector(".readiness-count")?.textContent?.includes(`/ ${expected} `), value, { timeout: WAIT_TIMEOUT_MS });
  return (await page.locator(".readiness-count").innerText()).trim();
}

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

async function runJourney({ mode, baseUrl, roomName, runs, headless }) {
  const evidence = createEvidence({ mode, baseUrl, roomName, runs });
  const browser = await chromium.launch({ headless });
  const isRehearsal = mode === "rehearsal";

  try {
    let host;
    let guestA;
    let guestB;
    let separateRoom;
    let closeAll;

    // Every action (click/fill/wait) defaults to Playwright's own 30s
    // actionability timeout unless a context sets its own default, which
    // would let one stalled action silently triple the script's runtime.
    // Bound every context to WAIT_TIMEOUT_MS so a stalled action fails fast
    // and predictably instead.
    if (isRehearsal) {
      const context = await browser.newContext();
      context.setDefaultTimeout(WAIT_TIMEOUT_MS);
      await withoutThirdPartyFonts(context);
      [host, guestA, guestB, separateRoom] = await Promise.all([context.newPage(), context.newPage(), context.newPage(), context.newPage()]);
      closeAll = () => context.close();
    } else {
      const [hostContext, guestAContext, guestBContext, separateContext] = await Promise.all([
        browser.newContext(),
        browser.newContext(),
        browser.newContext(),
        browser.newContext(),
      ]);
      for (const context of [hostContext, guestAContext, guestBContext, separateContext]) context.setDefaultTimeout(WAIT_TIMEOUT_MS);
      await Promise.all([hostContext, guestAContext, guestBContext, separateContext].map(withoutThirdPartyFonts));
      [host, guestA, guestB, separateRoom] = await Promise.all([
        hostContext.newPage(),
        guestAContext.newPage(),
        guestBContext.newPage(),
        separateContext.newPage(),
      ]);
      closeAll = () => Promise.all([hostContext.close(), guestAContext.close(), guestBContext.close(), separateContext.close()]);
    }

    let inviteCode = null;

    await evidence.step("host opens /join", "host", async () => await openJoinPage(host, baseUrl));

    await evidence.step("host creates the room and lands on /room?code=", "host", async () => {
      inviteCode = await createRoom(host, roomName);
      assert.equal(new URL(host.url()).pathname, "/room");
      return { inviteCode, url: host.url() };
    });

    await evidence.step("host enters a display name and reaches the waiting room", "host", async () => await enterDisplayName(host, "호스트"));

    await evidence.step("guestA joins by invite code and enters a display name", "guestA", async () => await joinRoomByInviteCode(guestA, baseUrl, inviteCode, "게스트A"));

    await evidence.step("guestB joins by invite code and enters a display name", "guestB", async () => await joinRoomByInviteCode(guestB, baseUrl, inviteCode, "게스트B"));

    await evidence.step(
      "all three clients see the same member roster",
      "host+guestA+guestB",
      async () => {
        await host.waitForFunction(() => document.querySelectorAll(".participant-roster__item").length >= 3, undefined, { timeout: WAIT_TIMEOUT_MS });
        const names = await rosterNames(host);
        assert.deepEqual(new Set(names), new Set(["호스트", "게스트A", "게스트B"]));
        return { hostRoster: names };
      },
      {
        knownGapReason:
          "useRehearsalGroupRoom (src/hooks/use-group-room.ts) keeps an independent per-tab room object seeded from initialRehearsalRoom() and never threads the displayName argument into it, so participants stays [] on every tab; only room *existence* (invite code) is shared via localStorage (src/lib/rehearsal-rooms.ts). Observed: each tab's .participant-roster showed the '함께하는 멤버를 확인하고 있어요.' placeholder instead of a shared roster.",
      },
    );

    await evidence.step("host sets expected attendance to 3 so a 3-person room can become ready", "host", async () => await setExpectedAttendance(host, 3));

    await evidence.step("host toggles ready", "host", async () => await toggleReady(host));
    await evidence.step("guestA toggles ready", "guestA", async () => await toggleReady(guestA));
    await evidence.step("guestB toggles ready", "guestB", async () => await toggleReady(guestB));

    await evidence.step(
      "readiness toggles propagate to every client",
      "host+guestA+guestB",
      async () => {
        await host.waitForFunction(() => document.querySelector(".readiness-count")?.textContent?.trim() === "3 / 3 준비 완료", undefined, { timeout: WAIT_TIMEOUT_MS });
        return { hostReadinessText: (await host.locator(".readiness-count").innerText()).trim() };
      },
      {
        knownGapReason:
          "Each rehearsal tab's readyCount is local (see the room-roster gap above): host/guestA/guestB each independently read back their own '1 / 2 준비 완료' after only toggling themselves ready, never the other tabs' contributions.",
      },
    );

    await evidence.step("host selects the Balance Game", "host", async () => await selectGame(host, "밸런스 게임"));

    if (mode === "connected") {
      await evidence.step("guests see the host's game selection", "guestA+guestB", async () => await waitForGuestGameStatus([guestA, guestB], "밸런스 게임"));
      await evidence.step("a game switch before the start reaches every client", "host+guestA+guestB", async () => {
        await selectGame(host, "아이스브레이크");
        await waitForGuestGameStatus([guestA, guestB], "아이스브레이크");
        await selectGame(host, "밸런스 게임");
        return await waitForGuestGameStatus([guestA, guestB], "밸런스 게임");
      });
    }

    await evidence.step(
      "host starts the round once everyone is ready",
      "host",
      async () => {
        const startButton = host.getByRole("button", { name: "시작하기", exact: true });
        await startButton.waitFor({ timeout: WAIT_TIMEOUT_MS });
        await startButton.click();
        await host.waitForFunction(() => document.querySelector(".live-room") !== null, undefined, { timeout: WAIT_TIMEOUT_MS });
        return "phase moved to live";
      },
      {
        knownGapReason:
          "canStartGroup() (src/lib/group-room.ts) requires joinedCount === expectedAttendance === readyCount, but useRehearsalGroupRoom's joinedCount is hard-coded to 1 in initialRehearsalRoom() and no rehearsal action ever increments it, while canSetExpectedAttendance() forbids expectedAttendance below 2 -- so joinedCount can never equal expectedAttendance and the host's '시작하기' button never renders (observed count: 0). The live phase is unreachable in --mode rehearsal by design.",
      },
    );

    await evidence.step(
      "all three clients see the same Balance prompt",
      "host+guestA+guestB",
      async () => {
        await Promise.all([guestA, guestB].map((page) => page.waitForFunction(() => document.querySelector(".live-room") !== null, undefined, { timeout: WAIT_TIMEOUT_MS })));
        const chooser = mode === "connected" ? ["host", "guestA", "guestB"][await drawCardAsTurnOwner([host, guestA, guestB])] : null;
        await Promise.all([host, guestA, guestB].map((page) => page.locator("#balance-question-title").waitFor({ timeout: WAIT_TIMEOUT_MS })));
        const [hostPrompt, guestAPrompt, guestBPrompt] = await Promise.all([host, guestA, guestB].map((page) => page.locator("#balance-question-title").innerText()));
        assert.equal(hostPrompt, guestAPrompt);
        assert.equal(hostPrompt, guestBPrompt);
        return { hostPrompt, chooser };
      },
      { knownGapReason: "Cascades from 'host starts the round': the live phase (and its Balance prompt) is unreachable in --mode rehearsal, so guests never leave the waiting room." },
    );

    for (let run = 1; run <= runs; run += 1) {
      await evidence.step(
        "each client casts a Balance vote and tallies match across clients",
        "host+guestA+guestB",
        async () => {
          await host.locator(".say-balance__choices button").nth(0).click();
          await guestA.locator(".say-balance__choices button").nth(0).click();
          await guestB.locator(".say-balance__choices button").nth(1).click();
          // host A, guestA A, guestB B
          return { tallies: await waitForTallies([host, guestA, guestB], [2, 1]) };
        },
        { run, knownGapReason: "Cascades from the unreachable live phase in --mode rehearsal." },
      );

      await evidence.step(
        "a changed vote does not double count",
        "host",
        async () => {
          const before = await waitForTallies([host, guestA, guestB], [2, 1]);
          await host.locator(".say-balance__choices button").nth(1).click();
          // The host moves from A to B: one count moves, the total stays three on every client.
          const after = await waitForTallies([host, guestA, guestB], [1, 2]);
          return { before, after };
        },
        { run, knownGapReason: "Cascades from the unreachable live phase in --mode rehearsal." },
      );
    }

    if (mode === "connected") {
      evidence.skip("host switches the room's game selection to Icebreaker", "host",
        "A live round cannot change its game; connected mode exercises the switch before the start ('a game switch before the start reaches every client').");
    } else await evidence.step(
      "host switches the room's game selection to Icebreaker",
      "host",
      async () => {
        await host.goto(`${baseUrl}/room?code=${inviteCode}`, { waitUntil: "domcontentloaded" });
        await host.locator("#waiting-title").waitFor({ timeout: WAIT_TIMEOUT_MS }).catch(() => undefined);
        if ((await host.locator(".game-selection").count()) === 0) throw new Error("game-selection control not present (room already left waiting phase)");
        return await selectGame(host, "아이스브레이크");
      },
      {
        knownGapReason:
          "Reaching a completed round (한 번 더 하기 / 메인 메뉴로) requires the live phase, which is unreachable in --mode rehearsal (see 'host starts the round'). This step instead exercises the always-reachable pre-start game-selection switch; if even that control is gone (e.g. a prior step navigated away) it is recorded here rather than faked.",
      },
    );

    await evidence.step(
      "guestB leaves the room and returns to /join",
      "guestB",
      async () => {
        const url = await leaveRoom(guestB);
        assert.match(new URL(url).pathname, /\/join$/);
        return url;
      },
    );

    if (mode === "connected") {
      evidence.skip("the remaining clients' roster reflects guestB leaving", "host+guestA",
        "The live room renders no roster, so the check would pass vacuously; the guest-leave path is covered by room_lifecycle_expiry.test.sql and the waiting-room roster sync above.");
    } else await evidence.step(
      "the remaining clients' roster reflects guestB leaving",
      "host+guestA",
      async () => {
        await host.waitForFunction(() => !Array.from(document.querySelectorAll(".participant-roster__item strong")).some((el) => el.textContent === "게스트B"), undefined, { timeout: WAIT_TIMEOUT_MS });
        return await rosterNames(host);
      },
      { knownGapReason: "Cascades from the roster-sync gap above: the roster was never populated with other tabs' members, so a departure cannot be observed as a roster change either." },
    );

    await evidence.step("a fourth page creates a separate room", "separateRoom", async () => {
      await openJoinPage(separateRoom, baseUrl);
      const separateCode = await createRoom(separateRoom, `${roomName} 분리방`);
      assert.notEqual(separateCode, inviteCode, "separate room must not reuse the first room's invite code");
      await enterDisplayName(separateRoom, "분리방장");
      return { separateCode };
    });

    for (let run = 1; run <= runs; run += 1) {
      const marker = `ISOLATION-MARK-${mode}-${run}-${Date.now()}`;
      await evidence.step(
        "the separate room cannot see the first room's chat activity",
        "separateRoom",
        async () => {
          await waitForChatAllowance(host, "host");
          await sendChatMessage(host, marker);
          // Over a real network a leak would need a Realtime round trip to show up; wait long enough to see one.
          await host.waitForTimeout(mode === "connected" ? 2000 : SHORT_SETTLE_MS);
          const leaked = await separateRoom.evaluate((text) => document.body.innerText.includes(text), marker);
          assert.equal(leaked, false, `separate room must not see message '${marker}' sent in the first room`);
          return { marker, leaked };
        },
        { run },
      );
    }

    for (let run = 1; run <= runs; run += 1) {
      await evidence.step(
        "concurrent chat sends from clients in the same room are not lost",
        "host+guestA",
        async () => {
          const markers = [`CONCURRENCY-HOST-${run}-${Date.now()}`, `CONCURRENCY-GUESTA-${run}-${Date.now()}`];
          // The composer stays disabled until the sender's previous send and refresh finish; waiting
          // for it is latency, not loss. A message that never arrives still fails below.
          const sendTimeout = mode === "connected" ? WAIT_TIMEOUT_MS * 3 : WAIT_TIMEOUT_MS;
          await Promise.all([waitForChatAllowance(host, "host"), waitForChatAllowance(guestA, "guestA")]);
          await Promise.all([
            host.locator("#room-chat-message").fill(markers[0]).then(() => host.getByRole("button", { name: "보내기", exact: true }).click({ timeout: sendTimeout })),
            guestA.locator("#room-chat-message").fill(markers[1]).then(() => guestA.getByRole("button", { name: "보내기", exact: true }).click({ timeout: sendTimeout })),
          ]);
          // Poll instead of a fixed settle: a slow round trip is not a lost message, a missing one after the timeout is.
          await host.waitForFunction(
            (expected) => expected.every((text) => document.querySelector(".room-chat__messages")?.textContent?.includes(text) ?? false),
            markers,
            { timeout: WAIT_TIMEOUT_MS },
          ).catch(() => undefined);
          const hostText = await host.locator(".room-chat__messages").innerText();
          const seenOnHost = markers.map((marker) => hostText.includes(marker));
          assert.deepEqual(seenOnHost, [true, true], `both concurrent messages must be present, observed presence=${JSON.stringify(seenOnHost)}`);
          return { markers, seenOnHost };
        },
        { run },
      );
    }

    await closeAll();
  } finally {
    await browser.close();
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Environment metadata (no secrets, no env values, host only)
// ---------------------------------------------------------------------------

function baseUrlHostOnly(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}`;
}

async function collectEnvironment(mode, baseUrl, headless) {
  const browser = await chromium.launch({ headless: true });
  let chromiumVersion = null;
  try {
    chromiumVersion = browser.version();
  } finally {
    await browser.close();
  }
  let playwrightVersion = null;
  try {
    playwrightVersion = require("playwright/package.json").version;
  } catch {
    playwrightVersion = null;
  }
  return {
    node: process.version,
    platform: process.platform,
    chromiumVersion,
    playwrightVersion,
    mode,
    baseUrlHost: baseUrlHostOnly(baseUrl),
    headless,
    scriptVersion: SCRIPT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.baseUrl === null) throw new Error(`--base-url is required\n\n${USAGE}`);
  if (args.mode !== "rehearsal" && args.mode !== "connected") throw new Error(`--mode must be "rehearsal" or "connected", got "${args.mode}"`);
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error(`--runs must be a positive integer, got "${args.runs}"`);

  const baseUrl = args.baseUrl.replace(/\/$/, "");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = args.out ?? path.join("docs", "design-review", `say-on-multi-client-rehearsal-${timestamp}.json`);

  const [environment, evidence] = await Promise.all([
    collectEnvironment(args.mode, baseUrl, args.headless),
    runJourney({ mode: args.mode, baseUrl, roomName: args.roomName, runs: args.runs, headless: args.headless }),
  ]);

  const summary = evidence.summarize();
  const report = {
    generatedAt: new Date().toISOString(),
    environment,
    summary,
    steps: evidence.steps,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log("");
  printTable(evidence.steps);
  console.log("");
  console.log(`Evidence written to ${outPath}`);
  console.log(`Summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (of ${summary.total})`);

  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
