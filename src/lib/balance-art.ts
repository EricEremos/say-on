import type { BalanceCard } from "./questions";

const individuallyGenerated = new Set(["bal-v2-e01", "bal-v2-e02", "bal-v2-e03", "bal-v2-e04", "bal-v2-e05", "bal-v2-e06", "bal-v2-e07", "bal-v2-e08", "bal-v2-e09", "bal-v2-e10", "bal-v2-e11", "bal-v2-e12", "bal-v2-e13", "bal-v2-e14", "bal-v2-e15", "bal-v2-t01", "bal-v2-t02", "bal-v2-t03", "bal-v2-t04", "bal-v2-t05", "bal-v2-t06", "bal-v2-t07", "bal-v2-t08", "bal-v2-t09", "bal-v2-t10", "bal-v2-t11", "bal-v2-t12", "bal-v2-t13", "bal-v2-t14", "bal-v2-t15", "bal-v2-i01", "bal-v2-i02", "bal-v2-i03", "bal-v2-i04", "bal-v2-i05", "bal-v2-i06", "bal-v2-i07", "bal-v2-i08", "bal-v2-i09", "bal-v2-i10", "bal-v2-i11", "bal-v2-i12", "bal-v2-i13", "bal-v2-i14", "bal-v2-i15", "bal-v2-p01", "bal-v2-p02", "bal-v2-p03", "bal-v2-p04", "bal-v2-p05", "bal-v2-p06", "bal-v2-p07", "bal-v2-p08", "bal-v2-p09", "bal-v2-p10", "bal-v2-p11", "bal-v2-p12", "bal-v2-p13", "bal-v2-p14", "bal-v2-p15"]);

const asset = (id: string, choice: "a" | "b"): string => (
  individuallyGenerated.has(id)
    ? `/images/say-on/balance-catalog-individual-v3/${id}-${choice}-v1.png`
    : "/brand/balance-paper-v1.webp"
);

export const balanceArtFor = (card: BalanceCard): Readonly<{ a: string; b: string }> => ({
  a: asset(card.id, "a"),
  b: asset(card.id, "b"),
});
