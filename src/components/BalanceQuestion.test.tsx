import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyRoomActivity } from "../hooks/use-room-activity";
import { balanceArtFor } from "../lib/balance-art";
import { balanceCards } from "../lib/questions";
import { BalanceQuestion } from "./BalanceQuestion";

describe("BalanceQuestion", () => {
  it("does not expose the group tally before the participant chooses", () => {
    const activity = { ...emptyRoomActivity(), vote: { roundNumber: 1, drawIndex: 0, aCount: 8, bCount: 2, myChoice: null } };
    const markup = renderToStaticMarkup(<BalanceQuestion card={balanceCards[0]!} activity={activity} />);
    expect(markup).toContain(balanceCards[0]!.choices.a);
    expect(markup).toContain(balanceCards[0]!.choices.b);
    expect(markup).not.toContain("8표");
    expect(markup).not.toContain("선택함");
  });
  it("shows the selected state, tally, and a nonvisual vote confirmation", () => {
    const activity = { ...emptyRoomActivity(), vote: { roundNumber: 1, drawIndex: 0, aCount: 3, bCount: 2, myChoice: "b" as const } };
    const markup = renderToStaticMarkup(<BalanceQuestion card={balanceCards[0]!} activity={activity} />);
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(markup).toContain("3표");
    expect(markup).toContain('role="status"');
    expect(markup).toContain(`${balanceCards[0]!.choices.b} 선택. 현재 3표 대 2표.`);
    expect(markup).not.toContain("✓ 선택함");
    expect(markup).not.toContain(balanceCards[0]!.followUp);
  });
  it("prevents duplicate submissions while a vote is pending", () => {
    const markup = renderToStaticMarkup(<BalanceQuestion card={balanceCards[0]!} activity={{ ...emptyRoomActivity(), isCastingVote: true }} />);
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('aria-busy="true"');
  });
  it("uses the available individual pair while remaining safe as the catalog art collection grows", () => {
    const markup = renderToStaticMarkup(<BalanceQuestion card={balanceCards[0]!} activity={emptyRoomActivity()} />);
    const choiceButtons = markup.match(/<button\b[\s\S]*?<\/button>/g) ?? [];

    expect(markup).toContain(balanceCards[0]!.choices.a);
    expect(markup).toContain("balance-catalog-individual-v3/bal-v2-e01-a-v1.png");
    expect(markup).toContain("balance-catalog-individual-v3/bal-v2-e01-b-v1.png");
    expect(markup).not.toContain("balance-choice-ritual-v1.png");
    expect(markup).not.toContain("cutout-v3.webp");
    expect(choiceButtons).toHaveLength(2);
    expect(choiceButtons[0]).toContain("say-balance__choice-art");
    expect(choiceButtons[0]).toContain("bal-v2-e01-a-v1.png");
    expect(choiceButtons[1]).toContain("say-balance__choice-art");
    expect(choiceButtons[1]).toContain("bal-v2-e01-b-v1.png");
  });

  it("keeps the active 60-question catalog bound to an explicit art source", () => {
    const assets = balanceCards.flatMap((card) => Object.values(balanceArtFor(card)));

    expect(balanceCards).toHaveLength(60);
    expect(assets).toHaveLength(120);
    expect(assets).toEqual(expect.arrayContaining([
      "/images/say-on/balance-catalog-individual-v3/bal-v2-e01-a-v1.png",
      "/images/say-on/balance-catalog-individual-v3/bal-v2-e01-b-v1.png",
      "/images/say-on/balance-catalog-individual-v3/bal-v2-p15-b-v1.png",
    ]));
  });
});
