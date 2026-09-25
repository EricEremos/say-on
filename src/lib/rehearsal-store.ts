import { z } from "zod";
import { eventCode, rehearsalEventStorageKey, rehearsalEventChannelName } from "./event-config";

const PhaseSchema = z.enum(["waiting", "live", "paused"]);
const EventStateSchema = z.object({
  code: z.literal(eventCode),
  title: z.string().min(1).max(120),
  phase: PhaseSchema,
  round: z.number().int().min(0),
  startedAt: z.string().datetime().nullable(),
  durationSeconds: z.number().int().positive(),
  remainingSeconds: z.number().int().min(0),
  revision: z.number().int().min(0)
});

export type EventPhase = z.infer<typeof PhaseSchema>;
export type EventState = Readonly<z.infer<typeof EventStateSchema>>;

const storageKey = rehearsalEventStorageKey;
const channelName = rehearsalEventChannelName;

export const initialEvent = (): EventState => ({
  code: eventCode,
  title: "Say-On 사연",
  phase: "waiting",
  round: 0,
  startedAt: null,
  durationSeconds: 300,
  remainingSeconds: 300,
  revision: 0
});

const parseEvent = (candidate: unknown): EventState | null => {
  const parsed = EventStateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

export const readRehearsalEvent = (): EventState => {
  const raw = window.localStorage.getItem(storageKey);
  if (raw === null) return initialEvent();
  try {
    const parsedJson: unknown = JSON.parse(raw);
    return parseEvent(parsedJson) ?? initialEvent();
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return initialEvent();
    throw error;
  }
};

export const writeRehearsalEvent = (event: EventState): void => {
  const serialized = JSON.stringify(event);
  window.localStorage.setItem(storageKey, serialized);
  window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: serialized }));
};

const currentRemainingSeconds = (event: EventState, now: number): number => {
  if (event.phase !== "live" || event.startedAt === null) return event.remainingSeconds;
  const elapsed = Math.floor((now - new Date(event.startedAt).getTime()) / 1_000);
  return Math.min(event.durationSeconds, Math.max(0, event.durationSeconds - elapsed));
};

export const nextEvent = (event: EventState, action: "start" | "pause" | "resume" | "reset"): EventState => {
  const revision = event.revision + 1;
  switch (action) {
    case "start":
      return { ...event, phase: "live", startedAt: new Date().toISOString(), remainingSeconds: event.durationSeconds, revision };
    case "pause":
      return { ...event, phase: "paused", remainingSeconds: currentRemainingSeconds(event, Date.now()), revision };
    case "resume": {
      const elapsedSeconds = event.durationSeconds - event.remainingSeconds;
      return { ...event, phase: "live", startedAt: new Date(Date.now() - elapsedSeconds * 1_000).toISOString(), revision };
    }
    case "reset":
      return { ...initialEvent(), revision };
  }
};

export const createEventChannel = (onEvent: (event: EventState) => void): BroadcastChannel => {
  const channel = new BroadcastChannel(channelName);
  channel.addEventListener("message", (message: MessageEvent<unknown>) => {
    const event = parseEvent(message.data);
    if (event !== null) onEvent(event);
  });
  return channel;
};

export const broadcastEvent = (channel: BroadcastChannel, event: EventState): void => channel.postMessage(event);
