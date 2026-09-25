import type { GameKey } from "./questions";

export type GroupRoomPhase = "waiting" | "live";

export type GroupRoomCounts = Readonly<{
  expectedAttendance: number;
  joinedCount: number;
  readyCount: number;
}>;

export type GroupStartState = GroupRoomCounts & Readonly<{ phase: GroupRoomPhase; selectedGame?: GameKey | null }>;

export type CardTheme = Readonly<{
  materialKey: "wave" | "sand" | "ember";
}>;

export const cardThemes: readonly CardTheme[] = [
  {
    materialKey: "wave"
  },
  {
    materialKey: "sand"
  },
  {
    materialKey: "ember"
  }
];

export const cardThemeFor = (cardIndex: number): CardTheme => {
  if (cardIndex === 1) return cardThemes[1]!;
  if (cardIndex === 2) return cardThemes[2]!;
  return cardThemes[0]!;
};

const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

export const canSetExpectedAttendance = (
  expectedAttendance: number,
  joinedCount: number,
): boolean =>
  Number.isInteger(expectedAttendance) &&
  expectedAttendance >= 2 &&
  expectedAttendance <= 20 &&
  isCount(joinedCount) &&
  expectedAttendance >= joinedCount;

export const canStartGroup = ({ phase, expectedAttendance, joinedCount, readyCount, selectedGame }: GroupStartState): boolean =>
  phase === "waiting" &&
  (selectedGame === "icebreaker" || selectedGame === "balance") &&
  Number.isInteger(expectedAttendance) &&
  expectedAttendance >= 2 &&
  isCount(joinedCount) &&
  isCount(readyCount) &&
  joinedCount === expectedAttendance &&
  readyCount === expectedAttendance;

export const isMyCardTurn = (
  roundNumber: number,
  drawIndex: number,
  participantCount: number,
  turnPosition: number,
): boolean =>
  Number.isInteger(roundNumber) && roundNumber >= 1 &&
  Number.isInteger(drawIndex) && drawIndex >= 0 && drawIndex < 5 &&
  Number.isInteger(participantCount) && participantCount > 0 &&
  Number.isInteger(turnPosition) && turnPosition >= 0 && turnPosition < participantCount &&
  ((roundNumber - 1) * 5 + drawIndex) % participantCount === turnPosition;

export const roomReadinessMessage = ({ expectedAttendance, joinedCount, readyCount }: GroupRoomCounts): string => {
  const missingAttendance = Math.max(expectedAttendance - joinedCount, 0);
  const missingReadiness = Math.max(joinedCount - readyCount, 0);

  if (missingAttendance > 0) {
    return `${missingAttendance}명 더 기다려요.`;
  }

  if (missingReadiness > 0) {
    return `${missingReadiness}명 준비 중이에요.`;
  }

  return "모두 준비됐어요.";
};

export const normalizeHandoffCode = (value: string): string =>
  value.normalize("NFKD").toUpperCase().replaceAll(/[^A-Z0-9]/g, "").slice(0, 8);
