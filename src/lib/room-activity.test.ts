import { describe, expect, it } from "vitest";
import { balanceChoicesForQuestion, canOpenNextIcebreakerCard, turnWindowStatus } from "./room-activity";

describe("online room activity rules", () => {
  const now = new Date("2026-08-31T02:00:00.000Z");

  it("holds the next Icebreaker card until a host closes or extends the active turn", () => {
    const activeTurn = {
      roundNumber: 1,
      drawIndex: 0,
      ownerName: "하늘",
      startedAt: "2026-08-31T01:57:00.000Z",
      endsAt: "2026-08-31T02:00:00.000Z",
      closedAt: null
    };

    expect(turnWindowStatus(activeTurn, now)).toBe("elapsed");
    expect(canOpenNextIcebreakerCard(activeTurn, now)).toBe(false);
    expect(canOpenNextIcebreakerCard({ ...activeTurn, closedAt: "2026-08-31T02:00:01.000Z" }, now)).toBe(true);
  });

  it("turns a Balance prompt into two deliberate, labeled choices", () => {
    expect(balanceChoicesForQuestion("평생 치킨 못 먹기 VS 평생 라면 못 먹기")).toEqual({
      a: "평생 치킨 못 먹기",
      b: "평생 라면 못 먹기"
    });
    expect(balanceChoicesForQuestion("질문을 불러오는 중입니다.")).toBeNull();
  });

});
