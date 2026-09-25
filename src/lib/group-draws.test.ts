import { describe, expect, it } from "vitest";
import { cardQuestionIndex } from "./group-draws";

describe("game-aware card rotation", () => {
  it("keeps every rehearsal card in the 60-question launch catalog", () => {
    const seen = new Set<number>();
    for (let round = 1; round <= 4; round += 1) {
      for (let draw = 0; draw < 5; draw += 1) {
        for (let card = 0; card < 3; card += 1) {
          const index = cardQuestionIndex(12, draw, card, round, "balance");
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(60);
          seen.add(index);
        }
      }
    }
    expect(seen.size).toBe(60);
  });
});
