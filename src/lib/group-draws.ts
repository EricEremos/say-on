import { z } from "zod";
import { type GameKey, questionForGameIndex, questionsForGame, rehearsalCatalogKey } from "./questions";

const GroupDrawSchema = z.object({
  sun: z.number().int().min(1).max(12),
  roundNumber: z.number().int().min(1).default(1),
  drawIndex: z.number().int().min(0).max(4),
  cardIndex: z.number().int().min(0).max(2),
  questionIndex: z.number().int().min(0).max(59),
  chosenAt: z.string().datetime({ offset: true })
});

export type GroupDraw = Readonly<z.infer<typeof GroupDrawSchema>>;
export const maximumGroupDraws = 5;
export const rehearsalDrawStorageKey = `say-on/rehearsal-group-draws/${rehearsalCatalogKey}`;

export const cardQuestionIndex = (sun: number, drawIndex: number, cardIndex: number, roundNumber = 1, game: GameKey = "icebreaker"): number =>
  (sun - 1 + (roundNumber - 1) * maximumGroupDraws * 3 + drawIndex * 3 + cardIndex) % questionsForGame(game).length;

export const cardQuestion = (sun: number, drawIndex: number, cardIndex: number, roundNumber = 1, game: GameKey = "icebreaker"): string =>
  questionForGameIndex(game, cardQuestionIndex(sun, drawIndex, cardIndex, roundNumber, game));

export const groupDrawRealtimeFilter = (eventId: string): string =>
  `event_id=eq.${eventId}`;

export const readRehearsalDraws = (): readonly GroupDraw[] => {
  const raw = window.localStorage.getItem(rehearsalDrawStorageKey);
  if (raw === null) return [];
  try {
    const parsed = z.array(GroupDrawSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
};

export const writeRehearsalDraws = (draws: readonly GroupDraw[]): void => {
  const value = JSON.stringify(draws);
  window.localStorage.setItem(rehearsalDrawStorageKey, value);
  window.dispatchEvent(new StorageEvent("storage", { key: rehearsalDrawStorageKey, newValue: value }));
};

export const chooseRehearsalCard = (sun: number, roundNumber: number, expectedDrawIndex: number, cardIndex: number, game: GameKey = "icebreaker"): readonly GroupDraw[] => {
  const draws = readRehearsalDraws();
  const current = draws.filter((draw) => draw.sun === sun && draw.roundNumber === roundNumber).length;
  if (current !== expectedDrawIndex || expectedDrawIndex >= maximumGroupDraws) return draws;
  const next: GroupDraw = { sun, roundNumber, drawIndex: expectedDrawIndex, cardIndex, questionIndex: cardQuestionIndex(sun, expectedDrawIndex, cardIndex, roundNumber, game), chosenAt: new Date().toISOString() };
  const updated = [...draws, next];
  writeRehearsalDraws(updated);
  return updated;
};

export const clearRehearsalDraws = (): void => writeRehearsalDraws([]);

export const createDrawChannel = (onDraws: (draws: readonly GroupDraw[]) => void): BroadcastChannel => {
  const channel = new BroadcastChannel(rehearsalDrawStorageKey);
  channel.addEventListener("message", (message: MessageEvent<unknown>) => {
    const parsed = z.array(GroupDrawSchema).safeParse(message.data);
    if (parsed.success) onDraws(parsed.data);
  });
  return channel;
};

export const broadcastDraws = (channel: BroadcastChannel, draws: readonly GroupDraw[]): void => channel.postMessage(draws);
