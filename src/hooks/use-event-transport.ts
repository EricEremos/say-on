import { useEffect, useState } from "react";
import { z } from "zod";
import { ensureAnonymousIdentity, supabase } from "../lib/supabase";
import type { EventState } from "../lib/rehearsal-store";
import { eventCode } from "../lib/event-config";

const RemoteRowSchema = z.object({
  id: z.string().uuid(),
  public_code: z.literal(eventCode),
  title: z.string().min(1).max(120)
});

type RemoteEvent = Readonly<{ id: string; event: EventState }>;
export type TransportMode = "rehearsal" | "connecting" | "live" | "error";
export type EventTransport = Readonly<{
  event: EventState;
  eventId: string | null;
  mode: TransportMode;
  problem: string | null;
}>;

const alwaysOpenEvent = (title = "Say-On 사연"): EventState => ({
  code: eventCode,
  title,
  phase: "live",
  round: 0,
  startedAt: null,
  durationSeconds: 0,
  remainingSeconds: 0,
  revision: 0
});

const toRemoteEvent = (candidate: unknown): RemoteEvent | null => {
  const parsed = RemoteRowSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const row = parsed.data;
  return {
    id: row.id,
    event: {
      ...alwaysOpenEvent(row.title)
    }
  };
};

const useSupabaseTransport = (): EventTransport | null => {
  const client = supabase;
  const [remote, setRemote] = useState<RemoteEvent | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) return undefined;
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const identity = await ensureAnonymousIdentity();
        if (identity.problem !== null) {
          if (active) setProblem("참여용 연결을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.");
          return;
        }
        const result = await client.from("events").select("id, public_code, title").eq("public_code", eventCode).single();
        if (result.error !== null) {
          if (active) setProblem("모임에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
          return;
        }
        const event = toRemoteEvent(result.data);
        if (event === null) {
          if (active) setProblem("이벤트 데이터 형식이 올바르지 않습니다.");
          return;
        }
        if (active) setRemote(event);
      } catch (error: unknown) {
        if (error instanceof Error && active) setProblem(error.message);
        else throw error;
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [client]);

  if (client === null) return null;
  return { event: remote?.event ?? alwaysOpenEvent(), eventId: remote?.id ?? null, mode: problem === null ? (remote === null ? "connecting" : "live") : "error", problem };
};

export const useEventTransport = (): EventTransport => {
  const remote = useSupabaseTransport();
  if (remote !== null) return remote;
  return { event: alwaysOpenEvent(), eventId: null, mode: "rehearsal", problem: null };
};
