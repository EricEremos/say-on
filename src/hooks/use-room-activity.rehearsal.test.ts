import { describe, expect, it } from "vitest";
import { rehearsalCatalogKey } from "../lib/questions";
import { readRehearsalActivity, rehearsalActivityStorageKey } from "./use-room-activity";

// Regression case for the 2026-09-24 multi-client rehearsal finding: a chat message sent in one
// browser-local rehearsal room was visible from a separately created rehearsal room in the same
// browser profile because the activity storage key was global.
describe("rehearsal room activity storage", () => {
  it("scopes the storage key to the room so separate rehearsal rooms never share chat, turns, or votes", () => {
    expect(rehearsalActivityStorageKey(1)).not.toBe(rehearsalActivityStorageKey(2));
    expect(rehearsalActivityStorageKey(1)).toContain(rehearsalCatalogKey);
    expect(rehearsalActivityStorageKey(7)).toMatch(/\/room-7$/u);
  });

  it("reads only the requested room's activity", () => {
    const store = new Map<string, string>();
    store.set(
      rehearsalActivityStorageKey(1),
      JSON.stringify({ messages: [{ id: "m1", authorName: "민지", content: "저는 짜장면이요.", createdAt: "2026-09-24T12:00:00.000Z" }], closedTurnKeys: [], votes: {} })
    );
    const storage = { getItem: (key: string): string | null => store.get(key) ?? null };

    expect(readRehearsalActivity(storage, rehearsalActivityStorageKey(1)).messages).toHaveLength(1);
    expect(readRehearsalActivity(storage, rehearsalActivityStorageKey(2)).messages).toHaveLength(0);
  });

  it("falls back to empty activity when the stored value is missing or malformed", () => {
    const empty = { messages: [], closedTurnKeys: [], votes: {} };
    expect(readRehearsalActivity({ getItem: () => null }, rehearsalActivityStorageKey(3))).toEqual(empty);
    expect(readRehearsalActivity({ getItem: () => "{not json" }, rehearsalActivityStorageKey(3))).toEqual(empty);
    expect(readRehearsalActivity({ getItem: () => JSON.stringify({ messages: "no" }) }, rehearsalActivityStorageKey(3))).toEqual(empty);
  });
});
