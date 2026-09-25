import { describe, expect, it } from "vitest";
import { promptFor, questions } from "./questions";
import { cardQuestionIndex, groupDrawRealtimeFilter } from "./group-draws";
import { realtimeStatusProblem } from "./realtime-status";

describe("room prompt policy", () => {
  it("does not repeat a prompt for a room before the supplied deck is exhausted", () => {
    const prompts = Array.from({ length: questions.length }, (_, round) => promptFor(7, round));
    expect(new Set(prompts).size).toBe(questions.length);
  });

  it("allows different rooms to receive different offsets in the same round", () => {
    expect(promptFor(1, 0)).not.toBe(promptFor(7, 0));
  });
});

describe("room card draw policy", () => {
  it("offers five three-card turns without repeating a candidate inside one room", () => {
    const candidates = Array.from({ length: 5 }, (_, drawIndex) => Array.from({ length: 3 }, (_, cardIndex) => cardQuestionIndex(7, drawIndex, cardIndex))).flat();
    expect(new Set(candidates).size).toBe(15);
  });

  it("moves a later round through the question deck instead of replaying its opening cards", () => {
    expect(cardQuestionIndex(7, 0, 0, 2)).not.toBe(cardQuestionIndex(7, 0, 0, 1));
  });

  it("subscribes each guest only to its own event and room card rows", () => {
    expect(groupDrawRealtimeFilter("7bc1c7fa-1a1b-4d4c-a50c-423a923a7175")).toBe("event_id=eq.7bc1c7fa-1a1b-4d4c-a50c-423a923a7175");
  });

  it("surfaces Realtime channel failures without treating normal subscription as an error", () => {
    expect(realtimeStatusProblem("SUBSCRIBED", "방 카드")).toBeNull();
    expect(realtimeStatusProblem("CHANNEL_ERROR", "방 카드")).toContain("실시간 연결이 끊겼어요");
    expect(realtimeStatusProblem("TIMED_OUT", "진행 화면")).toContain("인터넷 연결");
  });
});

describe("independent rooms", () => {
  it("does not use a shared event phase to make a card available", () => {
    expect(cardQuestionIndex(1, 0, 0)).toBe(0);
    expect(cardQuestionIndex(12, 4, 2)).toBe(8);
  });
});
