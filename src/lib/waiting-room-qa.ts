import { canStartGroup, type GroupRoomCounts } from "./group-room";
import { cardQuestionIndex, maximumGroupDraws } from "./group-draws";
import { isValidNickname, normalizeNickname } from "./nickname";

export type WaitingRoomQAPerson = Readonly<{
  id: string;
  label: string;
  joined: boolean;
  ready: boolean;
}>;

export type WaitingRoomQAState = Readonly<{
  expectedAttendance: number;
  hostId: string;
  people: readonly WaitingRoomQAPerson[];
  phase: "waiting" | "live";
  stage: "nickname" | "waiting" | "choosing" | "confirming" | "revealed" | "complete" | "atlas";
  nickname: string;
  sessionNumber: number;
  selectedCardIndex: number | null;
  sessionDraws: readonly Readonly<{ drawIndex: number; cardIndex: number; questionIndex: number }>[];
  unlockedQuestionIndexes: readonly number[];
}>;

const initialPeople: readonly WaitingRoomQAPerson[] = [
  { id: "host", label: "방장", joined: true, ready: false },
  { id: "member-1", label: "멤버 1", joined: true, ready: false },
  { id: "member-2", label: "멤버 2", joined: true, ready: false },
  { id: "member-3", label: "멤버 3", joined: true, ready: false },
];

export const createWaitingRoomQAState = (): WaitingRoomQAState => ({
  expectedAttendance: 4,
  hostId: "host",
  people: initialPeople,
  phase: "waiting",
  stage: "nickname",
  nickname: "",
  sessionNumber: 1,
  selectedCardIndex: null,
  sessionDraws: [],
  unlockedQuestionIndexes: [],
});

export const getWaitingRoomQACounts = (state: WaitingRoomQAState): GroupRoomCounts => ({
  expectedAttendance: state.expectedAttendance,
  joinedCount: state.people.filter((person) => person.joined).length,
  readyCount: state.people.filter((person) => person.joined && person.ready).length,
});

export const setWaitingRoomQAReady = (state: WaitingRoomQAState, personId: string): WaitingRoomQAState => ({
  ...state,
  people: state.people.map((person) =>
    person.id === personId && person.joined && state.phase === "waiting"
      ? { ...person, ready: !person.ready }
      : person,
  ),
});

export const transferWaitingRoomQAHost = (state: WaitingRoomQAState, personId: string): WaitingRoomQAState =>
  state.people.some((person) => person.id === personId && person.joined)
    ? { ...state, hostId: personId }
    : state;

export const startWaitingRoomQA = (state: WaitingRoomQAState): WaitingRoomQAState =>
  canStartGroup({ phase: state.phase, selectedGame: "icebreaker", ...getWaitingRoomQACounts(state) })
    ? { ...state, phase: "live", stage: "choosing" }
    : state;

export const continueWaitingRoomQANickname = (state: WaitingRoomQAState, nickname: string): WaitingRoomQAState => {
  const normalizedNickname = normalizeNickname(nickname);
  return state.stage === "nickname" && isValidNickname(normalizedNickname)
    ? { ...state, nickname: normalizedNickname, stage: "waiting" }
    : state;
};

const currentDrawIndex = (state: WaitingRoomQAState): number =>
  (state.sessionNumber - 1) * maximumGroupDraws + state.sessionDraws.length;

export const selectWaitingRoomQACard = (state: WaitingRoomQAState, sun: number, cardIndex: number): WaitingRoomQAState =>
  state.phase === "live" && state.stage === "choosing" && cardIndex >= 0 && cardIndex < 3
    ? { ...state, selectedCardIndex: cardIndex, stage: "confirming" }
    : state;

export const confirmWaitingRoomQACard = (state: WaitingRoomQAState, sun: number): WaitingRoomQAState => {
  if (state.phase !== "live" || state.stage !== "confirming" || state.selectedCardIndex === null) return state;
  const drawIndex = currentDrawIndex(state);
  const questionIndex = cardQuestionIndex(sun, drawIndex, state.selectedCardIndex);
  return {
    ...state,
    stage: "revealed",
    sessionDraws: [...state.sessionDraws, { drawIndex, cardIndex: state.selectedCardIndex, questionIndex }],
    selectedCardIndex: null,
    unlockedQuestionIndexes: state.unlockedQuestionIndexes.includes(questionIndex)
      ? state.unlockedQuestionIndexes
      : [...state.unlockedQuestionIndexes, questionIndex],
  };
};

export const advanceWaitingRoomQACard = (state: WaitingRoomQAState): WaitingRoomQAState =>
  state.stage === "revealed"
    ? { ...state, stage: state.sessionDraws.length >= maximumGroupDraws ? "complete" : "choosing" }
    : state;

export const beginNextWaitingRoomQASession = (state: WaitingRoomQAState): WaitingRoomQAState =>
  state.stage === "complete"
    ? { ...state, sessionNumber: state.sessionNumber + 1, sessionDraws: [], selectedCardIndex: null, stage: "choosing" }
    : state;

export const openWaitingRoomQAAtlas = (state: WaitingRoomQAState): WaitingRoomQAState =>
  state.stage === "complete" ? { ...state, stage: "atlas" } : state;

export const closeWaitingRoomQAAtlas = (state: WaitingRoomQAState): WaitingRoomQAState =>
  state.stage === "atlas" ? { ...state, stage: "complete" } : state;

export const resetWaitingRoomQAState = (_state: WaitingRoomQAState): WaitingRoomQAState =>
  createWaitingRoomQAState();
