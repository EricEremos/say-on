import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import source from "./App.tsx?raw";
import groupRoomSource from "./hooks/use-group-room.ts?raw";
import { GuidebookPage, JoinPage, LiveRoom, RoomInviteCode, WaitingRoom, draftAfterSend, persistRoomDisplayNameAfterRemoteUpdate, saveRoomDisplayName, savedRoomDisplayName, shouldShowRoomLoading } from "./App";
import type { GroupDrawTransport } from "./hooks/use-group-draw";
import type { GroupRoom, GroupRoomTransport } from "./hooks/use-group-room";
import type { RoomActivityTransport } from "./hooks/use-room-activity";
import type { GroupDraw } from "./lib/group-draws";
import type { GameKey } from "./lib/questions";

// The group noun of the pre-rebrand copy; no current screen may use it as a word.
const legacyGroupNoun = /(^|[^가-힣])순([^가-힣]|$)/u;

const failedRoomState = (): GroupRoomTransport => ({
  room: null,
  groupNumber: null,
  inviteCode: null,
  isJoining: false,
  isWorking: false,
  releasedToLobby: false,
  problem: "방 대기실에 입장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  transfer: null,
  setExpectedAttendance: () => undefined,
  selectGame: () => undefined,
  setReady: () => undefined,
  start: () => undefined,
  returnToGameSelection: async () => false,
  returnToEventMenu: async () => false,
  leaveRoom: async () => false,
  updateDisplayName: async () => false,
  createTransfer: () => undefined,
  acceptTransfer: () => undefined,
  retry: () => undefined,
  passwordGate: null,
  submitPassword: () => undefined,
  roomLock: null,
  setRoomPassword: async () => false
});

const completedRoundDraws: readonly GroupDraw[] = Array.from({ length: 5 }, (_, drawIndex) => ({
  sun: 7,
  roundNumber: 1,
  drawIndex,
  cardIndex: 0,
  questionIndex: drawIndex,
  chosenAt: "2026-08-25T12:00:00.000Z"
}));

const completedRoundDrawState = (): GroupDrawTransport => ({
  draws: completedRoundDraws,
  history: completedRoundDraws,
  cardOptions: [
    { cardIndex: 0, questionIndex: 0 },
    { cardIndex: 1, questionIndex: 1 },
    { cardIndex: 2, questionIndex: 2 }
  ],
  isPreparingOptions: false,
  retryCardOptions: () => undefined,
  choose: () => undefined,
  isChoosing: false,
  problem: null
});

const liveRoomState = (isHost: boolean, selectedGame: GameKey = "icebreaker"): GroupRoomTransport => ({
  ...failedRoomState(),
  room: { expectedAttendance: 2, joinedCount: 2, readyCount: 2, phase: "live", roundNumber: 1, revision: 7, eventMenuRevision: 0, selectedGame, isHost, isReady: true, participantCount: 2, turnPosition: 0, participants: [] }
});

const waitingRoomState = (isHost: boolean, selectedGame: GameKey | null): GroupRoomTransport => ({
  ...failedRoomState(),
  room: { expectedAttendance: 2, joinedCount: 1, readyCount: 0, phase: "waiting", roundNumber: 1, revision: 2, eventMenuRevision: 0, selectedGame, isHost, isReady: false, participantCount: 1, turnPosition: 0, participants: [] }
});

type NamedGroupRoom = GroupRoom & Readonly<{
  displayName: string;
  participants: readonly Readonly<{ displayName: string; isReady: boolean; turnPosition: number; isSelf: boolean }>[];
}>;

const namedLiveRoomState = (): GroupRoomTransport => {
  const room: NamedGroupRoom = {
    expectedAttendance: 2,
    joinedCount: 2,
    readyCount: 2,
    phase: "live",
    roundNumber: 1,
    revision: 7,
    eventMenuRevision: 0,
    selectedGame: "balance",
    isHost: true,
    isReady: true,
    participantCount: 2,
    turnPosition: 0,
    displayName: "하늘",
    participants: [
      { displayName: "하늘", isReady: true, turnPosition: 0, isSelf: true },
      { displayName: "민지", isReady: true, turnPosition: 1, isSelf: false }
    ]
  };
  return { ...failedRoomState(), room };
};

const namedWaitingRoomState = (): GroupRoomTransport => ({
  ...namedLiveRoomState(),
  room: {
    ...namedLiveRoomState().room!,
    phase: "waiting",
    readyCount: 1,
    revision: 3,
    eventMenuRevision: 0,
    isReady: false,
    participants: [
      { displayName: "하늘", isReady: true, turnPosition: 0, isSelf: true },
      { displayName: "민지", isReady: false, turnPosition: 1, isSelf: false }
    ]
  }
});

const chatActivity = (): RoomActivityTransport => ({
  messages: [{ id: "message-1", authorName: "하늘", content: "우와, 이 질문 진짜 좋다\n저는 바다 쪽이에요.", createdAt: "2026-08-31T02:00:00.000Z" }],
  turn: null,
  turnStatus: null,
  remainingSeconds: 0,
  vote: null,
  isSending: false,
  isUpdatingTurn: false,
  isCastingVote: false,
  problem: null,
  sendMessage: async () => true,
  extendTurn: () => undefined,
  closeTurn: () => undefined,
  castVote: () => undefined
});

describe("WaitingRoom", () => {
  it("persists a confirmed nickname edit for the next room join", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value); }
    };

    saveRoomDisplayName("  새  별명  ", storage);

    expect(values.get("say-on-room-display-name")).toBe("새 별명");
    expect(savedRoomDisplayName(storage)).toBe("새 별명");
  });

  it("saves a nickname only after the room update is confirmed", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value); }
    };
    const updateDisplayName = async (): Promise<boolean> => true;

    await expect(persistRoomDisplayNameAfterRemoteUpdate("  새  별명  ", updateDisplayName, storage)).resolves.toBe("새 별명");
    expect(values.get("say-on-room-display-name")).toBe("새 별명");
  });

  // Regression case for the 2026-09-25 connected rehearsal: a send that completed late (after its
  // post-send refresh) cleared the composer even though the next message had been typed meanwhile.
  it("clears the chat composer only when it still holds the message that was sent", () => {
    expect(draftAfterSend("  잘 들었어요  ", "잘 들었어요")).toBe("");
    expect(draftAfterSend("다음 이야기", "잘 들었어요")).toBe("다음 이야기");
    expect(draftAfterSend("", "잘 들었어요")).toBe("");
  });

  it("does not overwrite a nickname when the room update fails", async () => {
    const values = new Map<string, string>([["say-on-room-display-name", "기존 이름"]]);
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value); }
    };
    const updateDisplayName = async (): Promise<boolean> => false;

    await expect(persistRoomDisplayNameAfterRemoteUpdate("새 별명", updateDisplayName, storage)).resolves.toBeNull();
    expect(values.get("say-on-room-display-name")).toBe("기존 이름");
  });

  it("renders a recoverable room-entry state", () => {
    const markup = renderToStaticMarkup(
      <WaitingRoom roomState={failedRoomState()} />
    );

    expect(markup).toContain("방에 들어오지 못했어요.");
    expect(markup).toContain("다시 시도하기");
    expect(markup).toContain("처음으로");
    expect(markup).not.toMatch(legacyGroupNoun);
  });

  it("lets only the host choose a game before everyone marks ready", () => {
    const hostMarkup = renderToStaticMarkup(<WaitingRoom roomState={waitingRoomState(true, "icebreaker")} />);
    const guestMarkup = renderToStaticMarkup(<WaitingRoom roomState={waitingRoomState(false, null)} />);

    expect(hostMarkup).toContain("아이스브레이크");
    expect(hostMarkup).toContain("밸런스 게임");
    expect(hostMarkup).not.toContain("17개의");
    expect(hostMarkup).not.toContain("30개의");
    expect(hostMarkup).toContain('aria-pressed="true"');
    expect(guestMarkup).toContain("방장이 게임을 고르고 있어요.");
    expect(guestMarkup).not.toContain("게임을 선택해 주세요.");
  });

  it("shows the joined nickname roster before the game starts", () => {
    const markup = renderToStaticMarkup(<WaitingRoom roomState={namedWaitingRoomState()} />);

    expect(markup).toContain('aria-label="현재 함께하는 멤버"');
    expect(markup).toContain('<h2>현재 함께하는 멤버</h2>');
    expect(markup).not.toContain('<span class="section-kicker">우리 방</span>');
    expect(markup).toContain("하늘");
    expect(markup).toContain("민지");
    expect(markup).toContain("나");
    expect(markup).toContain("현재 함께하는 멤버");
    expect(markup).toContain("이름 수정하기");
    expect(markup).not.toContain("지금 함께하는 이름");
    expect(markup).toContain("준비 완료");
    expect(markup).toContain("입장 완료");
  });

  it("opens on the live room list with the two Say-On entry actions (owner request 2026-09-26)", () => {
    const markup = renderToStaticMarkup(<JoinPage />);

    expect(markup).toContain("Say-On");
    expect(markup).toContain("어떤 이야기부터");
    expect(markup).toContain("시작할까요?");
    expect(markup).toContain("지금 열린 방");
    expect(markup).toContain("LIVE");
    expect(markup).toContain("방 만들기");
    expect(markup).toContain("초대 코드로 참여");
    expect(markup).not.toContain("참여할 방");
    expect(markup).not.toContain("관리자");
    expect(markup).not.toMatch(legacyGroupNoun);
    expect(markup).not.toContain("join-nickname");
    expect(markup).not.toContain("가이드북 보기");
    expect(markup).not.toContain('href="/guidebook"');
    expect(markup).not.toContain("figma.com");
    expect(markup).not.toContain('target="_blank"');
  });

  it("keeps both game instructions and optional chat guidance on one neutral guide page", () => {
    const markup = renderToStaticMarkup(<GuidebookPage />);

    expect(markup).toContain("휴대폰은 짧게");
    expect(markup).toContain("질문으로 알아가거나, 두 선택지로 취향을 나눠요.");
    expect(markup).toContain("방 코드 보기");
    expect(markup).toContain("방을 열고 코드를 전해요");
    expect(markup).toContain("모두 모이면 시작해요");
    expect(markup).toContain("카드 한 장으로 시작해요");
    expect(markup).toContain("아이스브레이크는 질문으로, 밸런스 게임은 두 선택지로 이야기를 나눠요.");
    expect(markup).toContain("/images/say-on/shared-table-cutout-v1.webp");
    expect(markup).toContain("방 코드가 다시 필요할 때");
    expect(markup).toContain("채팅은 원할 때만 사용해요.");
    expect(markup).toContain("시작하기");
    expect(markup).not.toContain("저장하거나 수집하지 않아요");
    expect(markup).not.toContain("방 목록");
    expect(markup).not.toContain("coastal-tabletop");
    expect(markup).toContain('href="/join"');
    expect(markup).not.toContain("figma.com");
    expect(markup).not.toContain('target="_blank"');
    expect(markup).not.toContain('href="/guidebook/');
    expect(markup).not.toContain("62CA5188");
    expect(markup).not.toContain("3 / 4");
  });

  it("sends a creator straight into the new room without an invitation confirmation panel", () => {
    expect(source).toContain("if (room !== null) enterCreatedRoom(room.inviteCode);");
    expect(source).toContain("const path = inviteRoomPath(inviteCode);");
    expect(source).not.toContain("CreatedRoomInvite");
    expect(source).not.toContain("created-room-invite");
  });

  it("keeps a creator's room code available on demand after entering the room", () => {
    const closedMarkup = renderToStaticMarkup(<RoomInviteCode inviteCode="BEEF12A4" />);
    const openMarkup = renderToStaticMarkup(<RoomInviteCode inviteCode="BEEF12A4" initiallyOpen />);

    expect(closedMarkup).toContain("방 코드 보기");
    expect(closedMarkup).toContain('aria-expanded="false"');
    expect(closedMarkup).not.toContain("BEEF12A4");
    expect(openMarkup).toContain('aria-expanded="true"');
    expect(openMarkup).toContain("BEEF12A4");
    expect(openMarkup).toContain("초대 코드 복사");
  });

  it("keeps the lobby in its loading state until the event connection can load its roster", () => {
    expect(shouldShowRoomLoading("connecting", false)).toBe(true);
    expect(shouldShowRoomLoading("live", true)).toBe(true);
    expect(shouldShowRoomLoading("live", false)).toBe(false);
  });

  it("keeps replay and reset-then-menu controls host-only when a game completes", () => {
    const hostMarkup = renderToStaticMarkup(<LiveRoom sun={7} roomState={liveRoomState(true)} drawState={completedRoundDrawState()} />);
    const guestMarkup = renderToStaticMarkup(<LiveRoom sun={7} roomState={liveRoomState(false)} drawState={completedRoundDrawState()} />);

    expect(hostMarkup).toContain("한 번 더 하기");
    expect(hostMarkup).toContain("메인 메뉴로");
    expect(hostMarkup).not.toContain("다음 5장");
    expect(hostMarkup).not.toMatch(legacyGroupNoun);
    expect(hostMarkup).not.toContain('href="/join"');
    expect(hostMarkup).toContain(">한 번 더 하기</button>");
    expect(hostMarkup).toContain(">메인 메뉴로</button>");
    expect(guestMarkup).toContain("방장이 다음 순서를 정하고 있어요.");
    expect(guestMarkup).not.toContain("한 번 더 하기");
    expect(guestMarkup).not.toContain("메인 메뉴로");
    expect(guestMarkup).not.toContain('href="/join"');
    expect(guestMarkup).toContain(">보내기</button>");
  });

  it("releases room membership before an in-room return can navigate to the menu", () => {
    expect(groupRoomSource).toContain('client.rpc("leave_group_room"');
    expect(source).toContain("void leaveRoom()");
    expect(source).toContain("void roomState.leaveRoom()");
    expect(source).toContain('onClick={handleLeaveRoom}');
  });

  it("renders room chat as a named chronological log without decorative helper copy", () => {
    const markup = renderToStaticMarkup(<LiveRoom sun={7} roomState={namedLiveRoomState()} drawState={completedRoundDrawState()} activity={chatActivity()} />);

    expect(markup).toContain('role="log"');
    expect(markup).toContain('aria-label="방 대화"');
    expect(markup).toContain('aria-relevant="additions text"');
    expect(markup).toContain('room-chat__message room-chat__message--mine');
    expect(markup).toContain("우와, 이 질문 진짜 좋다\n저는 바다 쪽이에요.");
    expect(markup).toContain("LIVE");
    expect(markup).toContain('class="live-room__support live-room__support--chat-only"');
    expect(markup).not.toContain("<summary>대화");
    expect(markup).not.toContain("ROOM PULSE");
    expect(markup).not.toContain("같이 이야기해요");
    expect(markup).not.toContain("이 방 안에서, 지금의 대화를 이어가요.");
    expect(markup).not.toContain("Enter 전송 · Shift + Enter 줄바꿈");
    expect(markup).not.toContain("첫 인사를 남겨 보세요.");
  });

  it.each([
    { roundNumber: 1, drawIndex: 0, current: false },
    { roundNumber: 2, drawIndex: 4, current: false },
    { roundNumber: 1, drawIndex: 4, current: true }
  ])("only shows votes matching the displayed round and draw: %j", ({ roundNumber, drawIndex, current }) => {
    const activity: RoomActivityTransport = { ...chatActivity(), vote: { roundNumber, drawIndex, aCount: 7, bCount: 3, myChoice: "a" } };
    const markup = renderToStaticMarkup(<LiveRoom sun={7} roomState={namedLiveRoomState()} drawState={completedRoundDrawState()} activity={activity} />);

    expect(markup.includes('aria-pressed="true"')).toBe(current);
    expect(markup.includes("7표")).toBe(current);
    expect(markup.includes("3표")).toBe(current);
    expect(markup.includes("aria-pressed=\"true\"")).toBe(current);
    expect(markup).not.toContain("✓ 선택함");
  });

  it("uses visible 1–2–3 markers instead of decorative identity icons on card choices", () => {
    const markup = renderToStaticMarkup(<LiveRoom sun={7} roomState={liveRoomState(true)} drawState={{ ...completedRoundDrawState(), draws: [], history: [] }} />);

    expect(markup).not.toContain("파도 카드");
    expect(markup).not.toContain("모래 카드");
    expect(markup).not.toContain("불씨 카드");
    expect(markup).not.toContain("이어 말하기");
    expect(markup).toContain('aria-label="1번 카드"');
    expect(markup).toContain('class="question-card__number" aria-hidden="true">1</span>');
    expect(markup).toContain('class="question-card__number" aria-hidden="true">2</span>');
    expect(markup).toContain('class="question-card__number" aria-hidden="true">3</span>');
    expect(markup).not.toContain("question-card__icon");
    expect(markup).not.toContain("question-card__sticker");
    expect(markup).not.toContain("card-mark");
    expect(markup.match(/question-card__illustration/g) ?? []).toHaveLength(3);
  });

  it("names the next participant while the balance game waits for their card choice", () => {
    const firstDraw: GroupDraw = { sun: 7, roundNumber: 1, drawIndex: 0, cardIndex: 0, questionIndex: 18, chosenAt: "2026-08-29T12:00:00.000Z" };
    const markup = renderToStaticMarkup(<LiveRoom sun={7} roomState={namedLiveRoomState()} drawState={{ ...completedRoundDrawState(), draws: [firstDraw], history: [firstDraw] }} />);

    expect(markup).toContain("다음은 민지님이 카드를 고릅니다.");
  });
});

describe("Say-On waiting room layout", () => {
  it("keeps the room flow first and places the decorative shared table and room chat beside it", () => {
    const markup = renderToStaticMarkup(<WaitingRoom roomState={namedWaitingRoomState()} />);

    expect(markup).toContain('class="waiting-room__flow"');
    expect(markup).toContain('<img class="waiting-room__art" src="/images/say-on/shared-table-cutout-v1.webp" alt="" aria-hidden="true" width="640" height="585"/>');
    expect(markup.indexOf('class="waiting-room__flow"')).toBeLessThan(markup.indexOf('class="waiting-room__aside"'));
    expect(markup.indexOf('class="waiting-room__aside"')).toBeLessThan(markup.indexOf('class="room-chat"'));
    expect(markup.indexOf("준비하기")).toBeLessThan(markup.indexOf('class="room-chat"'));
  });
});
