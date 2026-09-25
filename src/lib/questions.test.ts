import { describe, expect, it } from "vitest";
import { balanceCards, balanceCatalogId, balanceQuestionCardBacks, balanceQuestionReveals, balanceQuestionStickers, balanceQuestions, remoteGameKey, questionCardArt, questionForGameIndex, questionImageFor, questionStickerFor, questionStickers, questions } from "./questions";

describe("question card artwork", () => {
  it("assigns a unique crop-safe artwork to every supplied question", () => {
    expect(questionCardArt).toHaveLength(questions.length);
    expect(new Set(questionCardArt).size).toBe(questions.length);
  });

  it("uses the first card artwork as a safe fallback", () => {
    expect(questionImageFor(-1)).toBe(questionCardArt[0]);
    expect(questionImageFor(questions.length)).toBe(questionCardArt[0]);
  });

  it("keeps the supplied question illustrations paired with every question", () => {
    expect(questionStickers).toHaveLength(questions.length);
    expect(new Set(questionStickers).size).toBe(questions.length);
    expect(questionStickerFor(-1)).toBe(questionStickers[0]);
    expect(questionStickerFor(questions.length)).toBe(questionStickers[0]);
  });
});

describe("Balance Game question library", () => {
  it("serves the complete 60-question authored launch catalog with neutral artwork", () => {
    expect(balanceCatalogId).toBe("balance-ko-2026-10");
    expect(balanceQuestions).toHaveLength(60);
    expect(new Set(balanceQuestions).size).toBe(60);
    expect(balanceQuestionCardBacks).toHaveLength(balanceQuestions.length);
    expect(balanceQuestionReveals).toHaveLength(balanceQuestions.length);
    expect(balanceQuestionStickers).toHaveLength(balanceQuestions.length);
    for (const path of [...balanceQuestionCardBacks, ...balanceQuestionReveals, ...balanceQuestionStickers]) expect(path).toMatch(/^\/brand\/.*\.webp$/);
    expect(questionForGameIndex("balance", 59)).toBe(balanceQuestions[59]);
    for (const card of balanceCards) {
      expect(card.choices.a).not.toBe(card.choices.b);
      expect(card.prompt.length).toBeGreaterThan(0);
      expect(card.followUp.length).toBeGreaterThan(0);
    }
  });

  it("does not turn an unknown card index into a different valid question", () => {
    for (const index of [-1, 60, 89]) {
      expect(questionForGameIndex("balance", index)).toContain("불러오지 못했어요");
      expect(balanceQuestions).not.toContain(questionForGameIndex("balance", index));
    }
  });

  it("selects the versioned server catalog without changing Icebreaker", () => {
    expect(remoteGameKey("balance")).toBe(balanceCatalogId);
    expect(remoteGameKey("balance")).not.toBe("balance");
    expect(remoteGameKey("icebreaker")).toBe("icebreaker");
  });
});
