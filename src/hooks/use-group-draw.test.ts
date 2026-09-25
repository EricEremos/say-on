import { describe, expect, it } from "vitest";
import type { GroupDraw } from "../lib/group-draws";
import { mergeRemoteDrawHistory, reconcileRemoteDrawHistory } from "./use-group-draw";

describe("remote group-draw reconciliation", () => {
  it("clears retained cards at reset, then lets the restarted room begin again from card one", () => {
    const retained: readonly GroupDraw[] = [
      { sun: 7, roundNumber: 1, drawIndex: 0, cardIndex: 1, questionIndex: 3, chosenAt: "2026-08-25T12:00:00.000Z" },
      { sun: 7, roundNumber: 1, drawIndex: 1, cardIndex: 2, questionIndex: 8, chosenAt: "2026-08-25T12:00:01.000Z" }
    ];

    const resetHistory = mergeRemoteDrawHistory(retained, [], {
        phase: "waiting",
        roundNumber: 1
      });

    expect(resetHistory).toEqual([]);

    const restartedHistory = mergeRemoteDrawHistory(resetHistory, [
      { group_number: 7, round_number: 1, draw_index: 0, chosen_card: 2, question_index: 5, chosen_at: "2026-08-25T12:10:00.000Z" }
    ], {
      phase: "live",
      roundNumber: 1
    });

    expect(restartedHistory).toHaveLength(1);
    expect(restartedHistory[0]).toMatchObject({ roundNumber: 1, drawIndex: 0, cardIndex: 2 });
  });

  it("reconciles a stale local view with the authoritative history after a rejected draw", () => {
    const history = reconcileRemoteDrawHistory([
      { group_number: 7, round_number: 1, draw_index: 1, chosen_card: 2, question_index: 8, chosen_at: "2026-08-25T12:00:01.000Z" },
      { group_number: 7, round_number: 1, draw_index: 0, chosen_card: 1, question_index: 3, chosen_at: "2026-08-25T12:00:00.000Z" }
    ]);

    expect(history.map((draw) => draw.drawIndex)).toEqual([0, 1]);
    expect(history[1]).toMatchObject({ cardIndex: 2, questionIndex: 8 });
  });

  it("keeps a newer realtime draw that arrives while recovery is fetching its snapshot", () => {
    const current: readonly GroupDraw[] = [
      { sun: 7, roundNumber: 1, drawIndex: 0, cardIndex: 1, questionIndex: 3, chosenAt: "2026-08-25T12:00:00.000Z" },
      { sun: 7, roundNumber: 1, drawIndex: 2, cardIndex: 0, questionIndex: 12, chosenAt: "2026-08-25T12:00:02.000Z" }
    ];
    const recovered = mergeRemoteDrawHistory(current, [
      { group_number: 7, round_number: 1, draw_index: 0, chosen_card: 1, question_index: 3, chosen_at: "2026-08-25T12:00:00.000Z" },
      { group_number: 7, round_number: 1, draw_index: 1, chosen_card: 2, question_index: 8, chosen_at: "2026-08-25T12:00:01.000Z" }
    ]);

    expect(recovered.map((draw) => draw.drawIndex)).toEqual([0, 1, 2]);
    expect(recovered[2]).toMatchObject({ questionIndex: 12 });
  });

  it("drops malformed remote rows rather than preserving an invalid turn", () => {
    const history = reconcileRemoteDrawHistory([
      { group_number: 7, round_number: 1, draw_index: 0, chosen_card: 0, question_index: 0, chosen_at: "2026-08-25T12:00:00.000Z" },
      { group_number: 7, round_number: 1, draw_index: 9, chosen_card: 0, question_index: 0, chosen_at: "2026-08-25T12:00:00.000Z" }
    ]);

    expect(history).toHaveLength(1);
    expect(history[0]?.drawIndex).toBe(0);
  });
});
