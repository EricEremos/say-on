import { describe, expect, it } from "vitest";
import drawSource from "./use-group-draw.ts?raw";
import roomSource from "./use-group-room.ts?raw";

// Dependencies of the first effect after `marker`: the list in its closing `}, [...]);`.
const effectDependencies = (source: string, marker: string): string[] => {
  const start = source.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const close = source.indexOf("}, [", start);
  return source.slice(close + 4, source.indexOf("]);", close)).split(",").map((name) => name.trim());
};

// A Supabase Realtime channel that is removed and re-subscribed misses every change that lands
// while it rejoins. The 2026-09-25 connected rehearsal lost roster, readiness and prompt updates
// this way: each received change refreshed the room, which re-created the room channel.
describe("Realtime channels survive room updates", () => {
  it("keeps one room status channel instead of re-subscribing whenever the room object changes", () => {
    expect(effectDependencies(roomSource, ".channel(`say-on-room-")).not.toContain("room");
  });

  it("keeps the room heartbeat interval across room updates", () => {
    expect(effectDependencies(roomSource, "touch_group_session_activity")).not.toContain("room");
  });

  it("keeps one draw channel per room while phase, revision and round change", () => {
    const dependencies = effectDependencies(drawSource, ".channel(`say-on-draw-");
    for (const churning of ["phase", "revision", "roundNumber"]) expect(dependencies).not.toContain(churning);
  });
});
