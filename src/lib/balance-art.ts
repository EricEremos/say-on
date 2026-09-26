import type { BalanceCard } from "./questions";

/**
 * Balance choice art, remade on 2026-09-26 for the current 60-question catalog: one transparent
 * 768 px WebP per choice (Higgsfield gpt_image_2_5, in the style of the Icebreaker stickers).
 * Brief and approval: docs/wireframes/2026-09-26-approval.md.
 */
const BALANCE_ART_DIRECTORY = "/images/say-on/balance-v4";

const asset = (id: string, choice: "a" | "b"): string => `${BALANCE_ART_DIRECTORY}/${id}-${choice}.webp`;

export const balanceArtFor = (card: BalanceCard): Readonly<{ a: string; b: string }> => ({
  a: asset(card.id, "a"),
  b: asset(card.id, "b"),
});
