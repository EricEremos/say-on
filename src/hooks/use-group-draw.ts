import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { broadcastDraws, cardQuestionIndex, chooseRehearsalCard, createDrawChannel, groupDrawRealtimeFilter, maximumGroupDraws, readRehearsalDraws, rehearsalDrawStorageKey } from "../lib/group-draws";
import type { GroupDraw } from "../lib/group-draws";
import { isMyCardTurn, type GroupRoomPhase } from "../lib/group-room";
import { balanceCards, questions, type GameKey } from "../lib/questions";
import { supabase } from "../lib/supabase";
import { realtimeStatusProblem } from "../lib/realtime-status";

// Question indexes are bounded by the largest catalog (Icebreaker 17, Balance 60); the database
// checks the same range (supabase/public/migrations/20260925100000_balance_v2_question_range.sql).
const maximumQuestionIndex = Math.max(questions.length, balanceCards.length) - 1;

const RemoteDrawSchema = z.object({
  group_number: z.number().int().min(1).max(32767),
  round_number: z.number().int().min(1).default(1),
  draw_index: z.number().int().min(0).max(4),
  chosen_card: z.number().int().min(0).max(2),
  question_index: z.number().int().min(0).max(maximumQuestionIndex),
  chosen_at: z.string().datetime({ offset: true })
});

const RemoteCardOptionSchema = z.object({
  card_index: z.number().int().min(0).max(2),
  question_index: z.number().int().min(0).max(maximumQuestionIndex)
});

export type GroupCardOption = Readonly<{ cardIndex: number; questionIndex: number }>;
export type GroupDrawTransport = Readonly<{ draws: readonly GroupDraw[]; history: readonly GroupDraw[]; cardOptions: readonly GroupCardOption[]; isPreparingOptions: boolean; retryCardOptions: () => void; choose: (drawIndex: number, cardIndex: number) => void; isChoosing: boolean; problem: string | null }>;

const toDraw = (candidate: unknown): GroupDraw | null => {
  const parsed = RemoteDrawSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return { sun: parsed.data.group_number, roundNumber: parsed.data.round_number, drawIndex: parsed.data.draw_index, cardIndex: parsed.data.chosen_card, questionIndex: parsed.data.question_index, chosenAt: parsed.data.chosen_at };
};

const byRoundAndDraw = (left: GroupDraw, right: GroupDraw): number => left.roundNumber - right.roundNumber || left.drawIndex - right.drawIndex;

export const reconcileRemoteDrawHistory = (candidates: readonly unknown[]): readonly GroupDraw[] => (
  candidates.map(toDraw).filter((draw): draw is GroupDraw => draw !== null).sort(byRoundAndDraw)
);

export const reconcileRemoteCardOptions = (candidates: readonly unknown[]): readonly GroupCardOption[] | null => {
  const parsed = RemoteCardOptionSchema.array().safeParse(candidates);
  if (!parsed.success || parsed.data.length !== 3 || new Set(parsed.data.map(({ card_index }) => card_index)).size !== 3) return null;
  return parsed.data.sort((left, right) => left.card_index - right.card_index).map(({ card_index, question_index }) => ({ cardIndex: card_index, questionIndex: question_index }));
};

type GroupRoomSnapshot = Readonly<{ phase: GroupRoomPhase | null; roundNumber: number }>;

const isFreshRoomSnapshot = (snapshot: GroupRoomSnapshot): boolean => snapshot.phase === "waiting" && snapshot.roundNumber === 1;

export const mergeRemoteDrawHistory = (current: readonly GroupDraw[], candidates: readonly unknown[], snapshot: GroupRoomSnapshot | null = null): readonly GroupDraw[] => {
  const remote = reconcileRemoteDrawHistory(candidates);
  if (snapshot !== null && isFreshRoomSnapshot(snapshot)) return remote;
  const merged = new Map(current.map((draw) => [`${draw.roundNumber}:${draw.drawIndex}`, draw]));
  for (const draw of remote) merged.set(`${draw.roundNumber}:${draw.drawIndex}`, draw);
  return [...merged.values()].sort(byRoundAndDraw);
};

const useRehearsalGroupDraw = (sun: number, roundNumber: number, game: GameKey): GroupDrawTransport => {
  const [history, setHistory] = useState<readonly GroupDraw[]>(readRehearsalDraws);
  useEffect(() => {
    const channel = createDrawChannel(setHistory);
    const receiveStorage = (event: StorageEvent): void => { if (event.key === rehearsalDrawStorageKey) setHistory(readRehearsalDraws()); };
    window.addEventListener("storage", receiveStorage);
    return () => { window.removeEventListener("storage", receiveStorage); channel.close(); };
  }, []);
  const choose = (drawIndex: number, cardIndex: number): void => {
    const next = chooseRehearsalCard(sun, roundNumber, drawIndex, cardIndex, game);
    setHistory(next);
    const channel = new BroadcastChannel(rehearsalDrawStorageKey);
    broadcastDraws(channel, next);
    channel.close();
  };
  const groupHistory = history.filter((draw) => draw.sun === sun).sort(byRoundAndDraw);
  const draws = groupHistory.filter((draw) => draw.roundNumber === roundNumber);
  const cardOptions = Array.from({ length: 3 }, (_, cardIndex) => ({ cardIndex, questionIndex: cardQuestionIndex(sun, draws.length, cardIndex, roundNumber, game) }));
  return { draws, history: groupHistory, cardOptions, isPreparingOptions: false, retryCardOptions: () => undefined, choose, isChoosing: false, problem: null };
};

const useRemoteGroupDraw = (eventId: string | null, sun: number | null, roundNumber: number, enabled: boolean, revision: number, phase: GroupRoomPhase | null, participantCount: number, turnPosition: number): GroupDrawTransport | null => {
  const client = supabase;
  const [history, setHistory] = useState<readonly GroupDraw[]>([]);
  const [isChoosing, setIsChoosing] = useState(false);
  const [cardOptions, setCardOptions] = useState<readonly GroupCardOption[]>([]);
  const [isPreparingOptions, setIsPreparingOptions] = useState(false);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [channelProblem, setChannelProblem] = useState<string | null>(null);
  const chooseInFlight = useRef(false);
  const snapshot = { phase, roundNumber };
  const isFreshRoom = isFreshRoomSnapshot(snapshot);
  const refreshHistory = useCallback(async (): Promise<void> => {
    if (client === null || eventId === null || sun === null) return;
    try {
      const result = await client.from("group_draws").select("group_number, round_number, draw_index, chosen_card, question_index, chosen_at").eq("event_id", eventId).eq("group_number", sun).order("round_number").order("draw_index");
      if (result.error !== null) {
        setProblem("방 카드 기록을 불러오지 못했습니다.");
        return;
      }
      setHistory((current) => mergeRemoteDrawHistory(current, result.data));
      setProblem(null);
    } catch {
      setProblem("방 카드 기록을 불러오지 못했습니다.");
    }
  }, [client, eventId, sun]);
  useEffect(() => {
    if (client === null || eventId === null || sun === null || !enabled) {
      setHistory([]);
      setProblem(null);
      return undefined;
    }
    if (isFreshRoom) setHistory([]);
    let active = true;
    const load = async (): Promise<void> => {
      const result = await client.from("group_draws").select("group_number, round_number, draw_index, chosen_card, question_index, chosen_at").eq("event_id", eventId).eq("group_number", sun).order("round_number").order("draw_index");
      if (result.error !== null) { if (active) setProblem("방 카드 기록을 불러오지 못했습니다."); return; }
      if (active) setHistory((current) => mergeRemoteDrawHistory(current, result.data, snapshot));
    };
    void load();
    return () => { active = false; };
  }, [client, enabled, eventId, phase, revision, roundNumber, sun]);
  // One channel per room: re-subscribing on every room revision would drop draws inserted mid-rejoin.
  useEffect(() => {
    if (client === null || eventId === null || sun === null || !enabled) {
      setChannelProblem(null);
      return undefined;
    }
    let active = true;
    const channel = client.channel(`say-on-draw-${sun}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "group_draws", filter: groupDrawRealtimeFilter(eventId) }, (payload) => {
      const draw = toDraw(payload.new);
      if (draw !== null && draw.sun === sun && active) setHistory((current) => current.some((item) => item.roundNumber === draw.roundNumber && item.drawIndex === draw.drawIndex) ? current : [...current, draw].sort(byRoundAndDraw));
    }).subscribe((status) => {
      const nextProblem = realtimeStatusProblem(status, "방 카드");
      if (active) setChannelProblem(nextProblem);
    });
    return () => { active = false; void client.removeChannel(channel); };
  }, [client, enabled, eventId, sun]);
  const groupHistory = sun === null ? [] : (isFreshRoom ? [] : history).filter((draw) => draw.sun === sun).sort(byRoundAndDraw);
  const draws = groupHistory.filter((draw) => draw.roundNumber === roundNumber);
  const isCurrentSelector = enabled && phase === "live" && draws.length < maximumGroupDraws && isMyCardTurn(roundNumber, draws.length, participantCount, turnPosition);
  useEffect(() => {
    if (client === null || eventId === null || sun === null || !isCurrentSelector) {
      setCardOptions([]);
      setIsPreparingOptions(false);
      return undefined;
    }
    let active = true;
    setIsPreparingOptions(true);
    const prepare = async (): Promise<void> => {
      try {
        const result = await client.rpc("prepare_group_turn_card_options", { p_event_id: eventId, p_group_number: sun, p_expected_draw_index: draws.length });
        if (result.error !== null && result.error.message.includes("conversation turn must be closed")) {
          if (active) {
            setCardOptions([]);
            setProblem(null);
          }
          return;
        }
        const options = result.error === null && Array.isArray(result.data) ? reconcileRemoteCardOptions(result.data) : null;
        if (!active) return;
        if (options === null) {
          setCardOptions([]);
          setProblem("카드 세 장을 준비하지 못했습니다. 잠시 후 다시 확인해 주세요.");
          return;
        }
        setCardOptions(options);
        setProblem(null);
      } catch {
        if (active) {
          setCardOptions([]);
          setProblem("카드 세 장을 준비하지 못했습니다. 잠시 후 다시 확인해 주세요.");
        }
      } finally {
        if (active) setIsPreparingOptions(false);
      }
    };
    void prepare();
    return () => { active = false; };
  }, [client, draws.length, eventId, isCurrentSelector, prepareAttempt, sun]);
  if (client === null) return null;
  const choose = (drawIndex: number, cardIndex: number): void => {
    if (eventId === null || sun === null || !enabled || isChoosing || chooseInFlight.current || drawIndex >= maximumGroupDraws) return;
    chooseInFlight.current = true;
    setIsChoosing(true); setProblem(null);
    const send = async (): Promise<void> => {
      try {
        const result = await client.rpc("choose_group_card", { p_event_id: eventId, p_group_number: sun, p_expected_draw_index: drawIndex, p_card_index: cardIndex });
        if (result.error !== null) {
          setProblem("이미 다른 카드가 선택되었거나 지금은 카드를 뽑을 수 없습니다. 화면을 확인해 주세요.");
          await refreshHistory();
          return;
        }
        const draw = toDraw(result.data);
        if (draw !== null && draw.sun === sun) {
          setHistory((current) => current.some((item) => item.roundNumber === draw.roundNumber && item.drawIndex === draw.drawIndex) ? current : [...current, draw].sort(byRoundAndDraw));
        }
      } catch (error: unknown) {
        setProblem(error instanceof Error ? error.message : "방 카드 선택을 완료하지 못했습니다.");
        await refreshHistory();
      } finally {
        chooseInFlight.current = false;
        setIsChoosing(false);
      }
    };
    void send();
  };
  const retryCardOptions = (): void => {
    setProblem(null);
    setPrepareAttempt((attempt) => attempt + 1);
  };
  return { draws, history: groupHistory, cardOptions, isPreparingOptions, retryCardOptions, choose, isChoosing, problem: problem ?? channelProblem };
};

export const useGroupDraw = (eventId: string | null, sun: number | null, roundNumber = 1, enabled = true, revision = 0, phase: GroupRoomPhase | null = null, game: GameKey = "icebreaker", participantCount = 1, turnPosition = 0): GroupDrawTransport => {
  const remote = useRemoteGroupDraw(eventId, sun, roundNumber, enabled, revision, phase, participantCount, turnPosition);
  const rehearsal = useRehearsalGroupDraw(sun ?? 1, roundNumber, game);
  return remote ?? rehearsal;
};
