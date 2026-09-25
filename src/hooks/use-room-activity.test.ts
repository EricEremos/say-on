import { describe, expect, it } from "vitest";
import type { GroupDraw } from "../lib/group-draws";
import { roomActivityDrawKey } from "./use-room-activity";

const revealedDraw = (drawIndex: number, chosenAt: string): GroupDraw => ({
  sun: 1,
  roundNumber: 1,
  drawIndex,
  cardIndex: 0,
  questionIndex: 0,
  chosenAt
});

describe("room activity refresh key", () => {
  it("changes when the authoritative latest card reveal changes", () => {
    const first = revealedDraw(0, "2026-09-01T12:00:00.000Z");
    const next = revealedDraw(1, "2026-09-01T12:03:00.000Z");

    expect(roomActivityDrawKey(null)).toBeNull();
    expect(roomActivityDrawKey(first)).not.toBe(roomActivityDrawKey(next));
  });

  it("distinguishes a new reveal after the round and card numbers reset", () => {
    const beforeReset = revealedDraw(0, "2026-09-01T12:00:00.000Z");
    const afterReset = revealedDraw(0, "2026-09-01T12:03:00.000Z");
    expect(roomActivityDrawKey(beforeReset)).not.toBe(roomActivityDrawKey(afterReset));
  });
});
