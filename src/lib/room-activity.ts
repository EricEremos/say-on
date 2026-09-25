export type TurnWindowStatus = "active" | "elapsed" | "closed";

export type RoomTurnWindow = Readonly<{
  roundNumber: number;
  drawIndex: number;
  ownerName: string;
  startedAt: string;
  endsAt: string;
  closedAt: string | null;
}>;

export const turnWindowStatus = (turn: RoomTurnWindow, now = new Date()): TurnWindowStatus => {
  if (turn.closedAt !== null) return "closed";
  return new Date(turn.endsAt).getTime() <= now.getTime() ? "elapsed" : "active";
};

export const canOpenNextIcebreakerCard = (turn: RoomTurnWindow | null, now = new Date()): boolean =>
  turn === null || turnWindowStatus(turn, now) === "closed";

export const balanceChoicesForQuestion = (question: string): Readonly<{ a: string; b: string }> | null => {
  const choices = question.split(/\s+VS\s+/u).map((choice) => choice.trim());
  if (choices.length !== 2 || choices.some((choice) => choice.length === 0)) return null;
  const [a, b] = choices;
  return { a: a!, b: b! };
};
