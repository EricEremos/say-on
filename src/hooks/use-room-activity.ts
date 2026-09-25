import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import type { GroupDraw } from "../lib/group-draws";
import type { GroupRoom } from "./use-group-room";
import { type RoomTurnWindow, turnWindowStatus, type TurnWindowStatus } from "../lib/room-activity";
import { supabase } from "../lib/supabase";
import { realtimeStatusProblem } from "../lib/realtime-status";
import { rehearsalCatalogKey } from "../lib/questions";

const ChatMessageSchema = z.object({
  id: z.union([z.number(), z.string()]),
  authorName: z.string().min(2).max(12),
  content: z.string().min(1).max(300),
  createdAt: z.string().datetime({ offset: true })
});

const TurnSchema = z.object({
  roundNumber: z.number().int().min(1),
  drawIndex: z.number().int().min(0).max(4),
  ownerName: z.string().min(2).max(12),
  startedAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).nullable()
});

const VoteSchema = z.object({
  roundNumber: z.number().int().min(1),
  drawIndex: z.number().int().min(0).max(4),
  aCount: z.number().int().min(0),
  bCount: z.number().int().min(0),
  myChoice: z.enum(["a", "b"]).nullable()
});

const ActivitySchema = z.object({
  messages: ChatMessageSchema.array(),
  turn: TurnSchema.nullable(),
  vote: VoteSchema.nullable()
});

export type RoomChatMessage = Readonly<{ id: string; authorName: string; content: string; createdAt: string }>;
export type BalanceVote = Readonly<{ roundNumber: number; drawIndex: number; aCount: number; bCount: number; myChoice: "a" | "b" | null }>;

export type RoomActivityTransport = Readonly<{
  messages: readonly RoomChatMessage[];
  turn: RoomTurnWindow | null;
  turnStatus: TurnWindowStatus | null;
  remainingSeconds: number;
  vote: BalanceVote | null;
  isSending: boolean;
  isUpdatingTurn: boolean;
  isCastingVote: boolean;
  problem: string | null;
  sendMessage: (content: string) => Promise<boolean>;
  extendTurn: () => void;
  closeTurn: () => void;
  castVote: (choice: "a" | "b") => void;
}>;

type ActivitySnapshot = Readonly<{ messages: readonly RoomChatMessage[]; turn: RoomTurnWindow | null; vote: BalanceVote | null }>;

const blankSnapshot: ActivitySnapshot = { messages: [], turn: null, vote: null };

const toSnapshot = (candidate: unknown): ActivitySnapshot | null => {
  const parsed = ActivitySchema.safeParse(candidate);
  if (!parsed.success) return null;
  return {
    messages: parsed.data.messages.map((message) => ({ ...message, id: String(message.id) })),
    turn: parsed.data.turn,
    vote: parsed.data.vote
  };
};

const useClock = (turn: RoomTurnWindow | null): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (turn === null || turn.closedAt !== null) return undefined;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [turn?.closedAt, turn?.endsAt]);
  return now;
};

const withClock = (snapshot: ActivitySnapshot, now: Date, isSending: boolean, isUpdatingTurn: boolean, isCastingVote: boolean, problem: string | null, actions: Pick<RoomActivityTransport, "sendMessage" | "extendTurn" | "closeTurn" | "castVote">): RoomActivityTransport => {
  const turnStatus = snapshot.turn === null ? null : turnWindowStatus(snapshot.turn, now);
  const remainingSeconds = snapshot.turn === null || turnStatus === "closed"
    ? 0
    : Math.max(0, Math.ceil((new Date(snapshot.turn.endsAt).getTime() - now.getTime()) / 1000));
  return { ...snapshot, turnStatus, remainingSeconds, isSending, isUpdatingTurn, isCastingVote, problem, ...actions };
};

const activityFilter = (eventId: string): string => `event_id=eq.${eventId}`;

export const roomActivityDrawKey = (draw: GroupDraw | null): string | null => (
  draw === null ? null : `${draw.roundNumber}:${draw.drawIndex}:${draw.chosenAt}`
);

const sameGroup = (candidate: unknown, sun: number): boolean => {
  if (typeof candidate !== "object" || candidate === null) return false;
  const groupNumber = (candidate as Record<string, unknown>)["group_number"];
  return groupNumber === sun;
};

const useRemoteRoomActivity = (eventId: string | null, sun: number | null, enabled: boolean, latestDrawKey: string | null): RoomActivityTransport | null => {
  const client = supabase;
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(blankSnapshot);
  const [problem, setProblem] = useState<string | null>(null);
  const [channelProblem, setChannelProblem] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isUpdatingTurn, setIsUpdatingTurn] = useState(false);
  const [isCastingVote, setIsCastingVote] = useState(false);
  const now = useClock(snapshot.turn);

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null || eventId === null || sun === null || !enabled) return;
    const result = await client.rpc("get_group_room_activity", { p_event_id: eventId, p_group_number: sun });
    const next = result.error === null ? toSnapshot(result.data) : null;
    if (next === null) {
      setProblem("방 대화 상태를 불러오지 못했습니다.");
      return;
    }
    setSnapshot(next);
    setProblem(null);
  }, [client, enabled, eventId, sun]);

  useEffect(() => {
    if (client === null || eventId === null || sun === null || !enabled) {
      setSnapshot(blankSnapshot);
      setProblem(null);
      setChannelProblem(null);
      return undefined;
    }
    let active = true;
    const load = async (): Promise<void> => {
      await refresh();
    };
    void load();
    const receive = (payload: { new: unknown; old: unknown }): void => {
      if (active && (sameGroup(payload.new, sun) || sameGroup(payload.old, sun))) void refresh();
    };
    const channel = client.channel(`say-on-activity-${sun}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "group_chat_messages", filter: activityFilter(eventId) }, receive)
      .on("postgres_changes", { event: "*", schema: "public", table: "group_turn_windows", filter: activityFilter(eventId) }, receive)
      .on("postgres_changes", { event: "*", schema: "public", table: "group_balance_votes", filter: activityFilter(eventId) }, receive)
      .subscribe((status) => {
        if (active) setChannelProblem(realtimeStatusProblem(status, "방 대화"));
      });
    return () => { active = false; void client.removeChannel(channel); };
  }, [client, enabled, eventId, refresh, sun]);

  useEffect(() => {
    if (latestDrawKey !== null) void refresh();
  }, [latestDrawKey, refresh]);

  if (client === null || eventId === null || sun === null || !enabled) return null;

  const sendMessage = async (content: string): Promise<boolean> => {
    if (eventId === null || sun === null || isSending) return false;
    setIsSending(true);
    setProblem(null);
    try {
      const result = await client.rpc("send_group_chat_message", { p_event_id: eventId, p_group_number: sun, p_content: content });
      if (result.error !== null) {
        setProblem("메시지를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return false;
      }
      await refresh();
      return true;
    } catch {
      setProblem("메시지를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
      return false;
    } finally {
      setIsSending(false);
    }
  };

  const updateTurn = (rpc: "extend_group_turn_window" | "close_group_turn_window"): void => {
    if (eventId === null || sun === null || isUpdatingTurn) return;
    setIsUpdatingTurn(true);
    setProblem(null);
    const send = async (): Promise<void> => {
      try {
        const result = await client.rpc(rpc, { p_event_id: eventId, p_group_number: sun });
        const next = result.error === null ? toSnapshot(result.data) : null;
        if (next === null) setProblem("진행 시간을 바꾸지 못했습니다. 방 상태를 다시 확인해 주세요.");
        else setSnapshot(next);
      } catch {
        setProblem("진행 시간을 바꾸지 못했습니다. 방 상태를 다시 확인해 주세요.");
      } finally {
        setIsUpdatingTurn(false);
      }
    };
    void send();
  };

  const castVote = (choice: "a" | "b"): void => {
    if (eventId === null || sun === null || isCastingVote) return;
    setIsCastingVote(true);
    setProblem(null);
    const send = async (): Promise<void> => {
      try {
        const result = await client.rpc("cast_group_balance_vote", { p_event_id: eventId, p_group_number: sun, p_choice: choice });
        const next = result.error === null ? toSnapshot(result.data) : null;
        if (next === null) setProblem("선택을 반영하지 못했습니다. 방 상태를 다시 확인해 주세요.");
        else setSnapshot(next);
      } catch {
        setProblem("선택을 반영하지 못했습니다. 방 상태를 다시 확인해 주세요.");
      } finally {
        setIsCastingVote(false);
      }
    };
    void send();
  };

  return withClock(snapshot, now, isSending, isUpdatingTurn, isCastingVote, problem ?? channelProblem, {
    sendMessage,
    extendTurn: () => updateTurn("extend_group_turn_window"),
    closeTurn: () => updateTurn("close_group_turn_window"),
    castVote
  });
};

/** Browser-local rehearsal activity is scoped per room: two rehearsal rooms in one browser profile must never share chat, closed turns, or votes. */
export const rehearsalActivityStorageKey = (sun: number): string => `say-on/rehearsal-room-activity/${rehearsalCatalogKey}/room-${sun}`;
export type RehearsalActivity = Readonly<{ messages: readonly RoomChatMessage[]; closedTurnKeys: readonly string[]; votes: Readonly<Record<string, "a" | "b">> }>;
const emptyRehearsal: RehearsalActivity = { messages: [], closedTurnKeys: [], votes: {} };

export const readRehearsalActivity = (storage: Pick<Storage, "getItem">, storageKey: string): RehearsalActivity => {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) ?? "") as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptyRehearsal;
    const value = parsed as Partial<RehearsalActivity>;
    if (!Array.isArray(value.messages) || !Array.isArray(value.closedTurnKeys) || typeof value.votes !== "object" || value.votes === null) return emptyRehearsal;
    return { messages: value.messages, closedTurnKeys: value.closedTurnKeys.filter((key): key is string => typeof key === "string"), votes: value.votes as Record<string, "a" | "b"> };
  } catch {
    return emptyRehearsal;
  }
};

const readRehearsal = (storageKey: string): RehearsalActivity => (typeof window === "undefined" ? emptyRehearsal : readRehearsalActivity(window.localStorage, storageKey));

const writeRehearsal = (storageKey: string, next: RehearsalActivity): void => {
  window.localStorage.setItem(storageKey, JSON.stringify(next));
  window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
};

type RehearsalLocks = Readonly<{ request: (name: string, callback: () => void) => Promise<unknown> }>;

// localStorage has no atomic update across tabs: two tabs sending at the same moment each read the
// same list, and the later write drops the other's message. A Web Lock named for the room
// serializes the read-modify-write across same-origin tabs; without Web Locks, write directly.
export const runExclusiveRehearsalUpdate = async (locks: RehearsalLocks | undefined, storageKey: string, action: () => void): Promise<void> => {
  if (locks === undefined) {
    action();
    return;
  }
  await locks.request(storageKey, () => { action(); });
};

const browserLocks = (): RehearsalLocks | undefined => (typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined);

const useRehearsalRoomActivity = (sun: number, room: GroupRoom | null, latestDraw: GroupDraw | null): RoomActivityTransport => {
  const storageKey = rehearsalActivityStorageKey(sun);
  const [activity, setActivity] = useState<RehearsalActivity>(() => readRehearsal(storageKey));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setActivity(readRehearsal(storageKey));
    const receive = (event: StorageEvent): void => { if (event.key === storageKey) setActivity(readRehearsal(storageKey)); };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, [storageKey]);
  const turnKey = latestDraw === null ? null : `${sun}:${roomActivityDrawKey(latestDraw)}`;
  const turn = room?.selectedGame === "icebreaker" && latestDraw !== null && turnKey !== null
    ? {
      roundNumber: latestDraw.roundNumber,
      drawIndex: latestDraw.drawIndex,
      ownerName: room.displayName ?? "이번 차례",
      startedAt: latestDraw.chosenAt,
      endsAt: new Date(new Date(latestDraw.chosenAt).getTime() + 3 * 60 * 1000).toISOString(),
      closedAt: activity.closedTurnKeys.includes(turnKey) ? new Date().toISOString() : null
    }
    : null;
  const now = useClock(turn);
  const currentVote = room?.selectedGame === "balance" && latestDraw !== null && turnKey !== null ? activity.votes[turnKey] ?? null : null;
  const snapshot: ActivitySnapshot = {
    messages: activity.messages,
    turn,
    vote: latestDraw !== null && room?.selectedGame === "balance" ? { roundNumber: latestDraw.roundNumber, drawIndex: latestDraw.drawIndex, aCount: currentVote === "a" ? 1 : 0, bCount: currentVote === "b" ? 1 : 0, myChoice: currentVote } : null
  };
  // Re-read the stored activity inside a cross-tab lock so a message another tab is writing at the same moment is never overwritten.
  const update = (mutate: (current: RehearsalActivity) => RehearsalActivity): void => {
    void runExclusiveRehearsalUpdate(browserLocks(), storageKey, () => {
      const next = mutate(readRehearsal(storageKey));
      writeRehearsal(storageKey, next);
      setActivity(next);
    }).catch(() => setProblem("이 브라우저에 저장하지 못했어요. 잠시 후 다시 시도해 주세요."));
  };
  const sendMessage = async (content: string): Promise<boolean> => {
    const normalized = content.replace(/\r\n?/gu, "\n").replace(/[^\S\r\n]+/gu, " ").trim();
    if (normalized.length === 0 || normalized.length > 300) {
      setProblem("메시지는 1~300자로 보내 주세요.");
      return false;
    }
    const message: RoomChatMessage = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, authorName: room?.displayName ?? "나", content: normalized, createdAt: new Date().toISOString() };
    update((current) => ({ ...current, messages: [...current.messages, message].slice(-50) }));
    setProblem(null);
    return true;
  };
  const closeTurn = (): void => {
    if (turnKey === null) return;
    update((current) => ({ ...current, closedTurnKeys: [...new Set([...current.closedTurnKeys, turnKey])] }));
  };
  const castVote = (choice: "a" | "b"): void => {
    if (turnKey === null) return;
    update((current) => ({ ...current, votes: { ...current.votes, [turnKey]: choice } }));
  };
  return withClock(snapshot, now, false, false, false, problem, { sendMessage, extendTurn: () => setProblem("리허설에서는 3분 타이머를 직접 기다려 주세요."), closeTurn, castVote });
};

export const useRoomActivity = (eventId: string | null, sun: number | null, room: GroupRoom | null, latestDraw: GroupDraw | null, enabled = true): RoomActivityTransport => {
  const remote = useRemoteRoomActivity(eventId, sun, enabled, roomActivityDrawKey(latestDraw));
  const rehearsal = useRehearsalRoomActivity(sun ?? 1, room, latestDraw);
  return remote ?? rehearsal;
};

export const emptyRoomActivity = (): RoomActivityTransport => ({
  messages: [], turn: null, turnStatus: null, remainingSeconds: 0, vote: null,
  isSending: false, isUpdatingTurn: false, isCastingVote: false, problem: null,
  sendMessage: async () => false, extendTurn: () => undefined, closeTurn: () => undefined, castVote: () => undefined
});
