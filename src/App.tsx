import { type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button, PromptCard } from "./components/primitives";
import { BalanceQuestion } from "./components/BalanceQuestion";
import "./say-on.css";
import { type TransportMode, useEventTransport } from "./hooks/use-event-transport";
import { useGroupDraw } from "./hooks/use-group-draw";
import type { GroupCardOption } from "./hooks/use-group-draw";
import { useGroupRoom } from "./hooks/use-group-room";
import { useGroupRoomEntry } from "./hooks/use-group-room-entry";
import { RoomLobby } from "./components/RoomLobby";
import { LockIcon, RoomPasswordGateCard, RoomPasswordSetting } from "./components/RoomPasswordForm";
import { balanceArtFor } from "./lib/balance-art";
import { emptyRoomActivity, type BalanceVote, type RoomActivityTransport, useRoomActivity } from "./hooks/use-room-activity";
import { cardQuestion, cardQuestionIndex, maximumGroupDraws } from "./lib/group-draws";
import { canSetExpectedAttendance, canStartGroup, cardThemeFor, cardThemes, isMyCardTurn, roomReadinessMessage } from "./lib/group-room";
import { isValidNickname, normalizeNickname } from "./lib/nickname";
import { balanceCards, type BalanceCard, type GameKey, questionCardBackForGame, questionForGameIndex, questionImageFor, questionImageForGame, questionStickerFor, questionStickerForGame, questionsForGame } from "./lib/questions";
import { canOpenNextIcebreakerCard } from "./lib/room-activity";
import { canCreateRoomName, canJoinInviteRoom, groupRoomPath, inviteRoomPath, normalizeInviteCode, normalizeRoomName, roomGroupNumberFromSearchParams } from "./lib/room-entry";
import {
  createWaitingRoomQAState,
  advanceWaitingRoomQACard,
  beginNextWaitingRoomQASession,
  closeWaitingRoomQAAtlas,
  confirmWaitingRoomQACard,
  continueWaitingRoomQANickname,
  getWaitingRoomQACounts,
  openWaitingRoomQAAtlas,
  resetWaitingRoomQAState,
  selectWaitingRoomQACard,
  setWaitingRoomQAReady,
  startWaitingRoomQA,
  transferWaitingRoomQAHost,
} from "./lib/waiting-room-qa";

const ModeNote = ({ problem }: Readonly<{ problem: string | null }>) => (
  <p className="mode-note" role="alert">연결 오류입니다. {problem ?? "이벤트 연결을 확인해 주세요."}</p>
);

const roomDisplayNameStorageKey = "say-on-room-display-name";

type DisplayNameStorage = Pick<Storage, "getItem" | "setItem">;

const browserDisplayNameStorage = (): DisplayNameStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

export const savedRoomDisplayName = (storage: DisplayNameStorage | null = browserDisplayNameStorage()): string | null => {
  try {
    const value = storage?.getItem(roomDisplayNameStorageKey) ?? null;
    const normalizedValue = value === null ? "" : normalizeNickname(value);
    return isValidNickname(normalizedValue) ? normalizedValue : null;
  } catch {
    return null;
  }
};

export const saveRoomDisplayName = (value: string, storage: DisplayNameStorage | null = browserDisplayNameStorage()): void => {
  const normalizedValue = normalizeNickname(value);
  if (!isValidNickname(normalizedValue)) return;
  try { storage?.setItem(roomDisplayNameStorageKey, normalizedValue); } catch { undefined; }
};

// A send can finish seconds later (it waits for the room refresh); keep anything typed meanwhile.
export const draftAfterSend = (current: string, sent: string): string => (current.trim() === sent ? "" : current);

export const persistRoomDisplayNameAfterRemoteUpdate = async (
  value: string,
  updateDisplayName: (displayName: string) => Promise<boolean>,
  storage: DisplayNameStorage | null = browserDisplayNameStorage(),
): Promise<string | null> => {
  const normalizedValue = normalizeNickname(value);
  if (!isValidNickname(normalizedValue) || !await updateDisplayName(normalizedValue)) return null;
  saveRoomDisplayName(normalizedValue, storage);
  return normalizedValue;
};

export const shouldShowRoomLoading = (mode: TransportMode, isLoadingRooms: boolean): boolean =>
  mode === "connecting" || isLoadingRooms;

/** Arrival: the live room list with create, invite-code and password entry (approved 2026-09-26). */
export const JoinPage = () => <RoomLobby />;

const RoomManagementPage = () => {
  const { eventId, mode, problem } = useEventTransport();
  const { rooms, isLoadingRooms, createRoom, isWorking, problem: roomProblem } = useGroupRoomEntry(eventId);
  const [roomName, setRoomName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const normalizedRoomName = normalizeRoomName(roomName);
  const normalizedInviteCode = normalizeInviteCode(inviteCode);
  const isLobbyLoading = shouldShowRoomLoading(mode, isLoadingRooms);
  const enterRoom = (groupNumber: number): void => {
    const path = groupRoomPath(groupNumber);
    if (path !== null) window.location.assign(path);
  };
  const enterCreatedRoom = (inviteCode: string): void => {
    const path = inviteRoomPath(inviteCode);
    if (path !== null) window.location.assign(path);
  };
  const createRoomEntry = (): void => {
    void createRoom(normalizedRoomName).then((room) => {
      if (room !== null) enterCreatedRoom(room.inviteCode);
    });
  };
  const enterByCode = (): void => {
    const path = inviteRoomPath(normalizedInviteCode);
    if (path !== null) window.location.assign(path);
  };
  return (
    <main className="guest-shell guest-shell--coast">
      <div className="coast-image coast-image--join" aria-hidden="true" />
      <div className="coast-wash" aria-hidden="true" />
      <header className="join-topline">
        <span className="brand">Say-On <span className="say-brand-korean" lang="ko">사연</span></span>
      </header>
      <section className="join-hero" aria-labelledby="join-heading">
        <h1 id="join-heading">방을 만들거나<br />참여하세요.</h1>
        <section className="join-card join-card--lobby" aria-label="방 입장">
          <div className="room-lobby__heading"><h2>참여할 방</h2></div>
          {isLobbyLoading ? <p className="room-lobby__status" role="status">방을 불러오는 중이에요.</p> : rooms.length > 0 ? <ol className="room-lobby__list">{rooms.map((room) => <li className="room-lobby__item" key={room.groupNumber}><button className="room-lobby__room" type="button" disabled={isWorking || mode === "connecting"} onClick={() => enterRoom(room.groupNumber)}><span><strong>{room.roomName}</strong><small>{room.joinedCount} / {room.capacity}명</small></span><b>입장</b></button></li>)}</ol> : <p className="room-lobby__status">아직 만든 방이 없어요. 첫 번째 방을 만들어 보세요.</p>}
          <form className="room-creation" onSubmit={(event) => { event.preventDefault(); createRoomEntry(); }}>
            <label htmlFor="room-name"><b>새 방 만들기</b></label>
            <div><input id="room-name" value={roomName} onChange={(event) => setRoomName(event.target.value)} autoComplete="off" maxLength={40} placeholder="방 이름" /><Button disabled={isWorking || mode === "connecting" || !canCreateRoomName(normalizedRoomName)} type="submit">만들기</Button></div>
            <p className="room-creation__note">15분 동안 활동이 없으면 자동으로 사라집니다.</p>
          </form>
          <details className="invite-fallback"><summary>초대 코드로 들어가기</summary><div className="invite-entry"><label htmlFor="invite-code">초대 코드</label><input id="invite-code" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} inputMode="text" autoCapitalize="characters" autoComplete="off" maxLength={12} placeholder="예: BEEF12A4" /><Button kind="quiet" disabled={isWorking || !canJoinInviteRoom(normalizedInviteCode)} onClick={enterByCode}>입장하기</Button></div></details>
          {roomProblem !== null ? <p className="room-problem" role="alert">{roomProblem}</p> : null}
        </section>
      </section>
      {mode === "error" ? <footer className="join-footer"><ModeNote problem={problem} /></footer> : null}
    </main>
  );
};

export const RoomInviteCode = ({
  inviteCode,
  initiallyOpen = false,
}: Readonly<{
  inviteCode: string;
  initiallyOpen?: boolean;
}>) => {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [isCopied, setIsCopied] = useState(false);

  const copyInviteCode = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;

    void navigator.clipboard.writeText(inviteCode).then(
      () => setIsCopied(true),
      () => setIsCopied(false),
    );
  };

  return (
    <section className="room-invite" aria-label="방 초대 코드">
      <div className="room-invite__heading">
        <button
          className="room-invite__toggle"
          type="button"
          aria-expanded={isOpen}
          aria-controls="room-invite-code-panel"
          onClick={() => setIsOpen((current) => !current)}
        >
          {isOpen ? "방 코드 닫기" : "방 코드 보기"}
        </button>
      </div>
      {isOpen ? (
        <div className="room-invite__panel" id="room-invite-code-panel">
          <div className="room-invite__code">
            <span>초대 코드</span>
            <strong>{inviteCode}</strong>
          </div>
          <button className="button button--quiet room-invite__copy" type="button" onClick={copyInviteCode}>
            {isCopied ? "복사했어요" : "초대 코드 복사"}
          </button>
        </div>
      ) : null}
    </section>
  );
};

const guidebookSteps = [
  { number: "01", title: "방을 열고 코드를 전해요", hint: "방을 만들고 초대 코드를 나눠요. 초대받았다면 코드로 들어와요." },
  { number: "02", title: "모두 모이면 시작해요", hint: "이름을 확인하고 준비해요" },
  { number: "03", title: "카드 한 장으로 시작해요", hint: "아이스브레이크는 질문으로, 밸런스 게임은 두 선택지로 이야기를 나눠요." },
] as const;

export const GuidebookPage = () => (
  <main className="say-arrival say-guide">
    <header className="say-guide__header">
      <a className="say-wordmark" href="/join">Say-On <span className="say-brand-korean" lang="ko">사연</span></a>
      <a className="say-guide__back" href="/join">처음으로</a>
    </header>
    <section className="say-guide__content" aria-labelledby="guidebook-heading">
      <div className="say-guide__intro">
        <div>
          <p className="say-guide__label">이용 방법</p>
          <h1 id="guidebook-heading">휴대폰은 짧게,<br />대화는 길게.</h1>
          <p>질문으로 알아가거나, 두 선택지로 취향을 나눠요.</p>
        </div>
        <img className="say-guide__art" src="/images/say-on/shared-table-cutout-v1.webp" alt="" width={640} height={585} />
      </div>
      <ol className="say-guide__steps" aria-label="진행 순서">
        {guidebookSteps.map((step) => <li key={step.number}>
          <span className="say-guide__number" aria-hidden="true">{step.number}</span>
          <h2>{step.title}</h2>
          <p>{step.hint}</p>
        </li>)}
      </ol>
      <details className="say-guide__notes">
        <summary>초대 코드와 참여 안내</summary>
        <div>
          <h2>방 코드가 다시 필요할 때</h2>
          <p>방 안의 <strong>방 코드 보기</strong>에서 초대 코드를 다시 확인하고 복사할 수 있어요.</p>
          <h2>이야기는 편하게 나눠요</h2>
          <p>질문의 답을 입력할 필요는 없어요. 채팅은 원할 때만 사용해요.</p>
        </div>
      </details>
      <a className="say-action say-guide__start" href="/join">시작하기</a>
    </section>
  </main>
);

type RoomState = ReturnType<typeof useGroupRoom>;

const gameDetails: Readonly<Record<GameKey, Readonly<{ title: string; description: string; illustration: string }>>> = {
  icebreaker: { title: "아이스브레이크", description: "가벼운 질문으로 서로 알아가요.", illustration: "/images/say-on/icebreaker/icebreaker-hero-v1.png" },
  balance: { title: "밸런스 게임", description: "A vs B 질문으로 취향을 나눠요.", illustration: "/brand/balance-paper-v1.webp" }
};

const chatTimeFormatter = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });

const formatChatTime = (createdAt: string): string => {
  const timestamp = new Date(createdAt);
  return Number.isNaN(timestamp.getTime()) ? "" : chatTimeFormatter.format(timestamp);
};

const chatAvatarTone = (name: string): number => Array.from(name).reduce((total, character) => total + character.codePointAt(0)!, 0) % 4;

const RoomChat = ({ activity, selfDisplayName, showProblem = true }: Readonly<{ activity: RoomActivityTransport; selfDisplayName: string | undefined; showProblem?: boolean }>) => {
  const [draft, setDraft] = useState("");
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false);
  const messagesRef = useRef<HTMLOListElement>(null);
  const previousMessageCountRef = useRef(activity.messages.length);
  const hasPositionedInitialMessagesRef = useRef(false);
  const send = (): void => {
    const message = draft.trim();
    if (message.length === 0 || activity.isSending) return;
    void activity.sendMessage(message).then((didSend) => { if (didSend) setDraft((current) => draftAfterSend(current, message)); });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); send(); };

  const scrollToLatest = (): void => {
    const messages = messagesRef.current;
    if (messages !== null) messages.scrollTop = messages.scrollHeight;
    setHasUnreadMessages(false);
  };

  useEffect(() => {
    const messages = messagesRef.current;
    const hasNewMessages = activity.messages.length > previousMessageCountRef.current;
    previousMessageCountRef.current = activity.messages.length;
    if (messages === null || activity.messages.length === 0) return;
    if (!hasPositionedInitialMessagesRef.current) {
      messages.scrollTop = messages.scrollHeight;
      hasPositionedInitialMessagesRef.current = true;
      return;
    }
    if (!hasNewMessages) return;
    const isFollowingLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 28;
    if (isFollowingLatest) {
      messages.scrollTop = messages.scrollHeight;
      setHasUnreadMessages(false);
    } else setHasUnreadMessages(true);
  }, [activity.messages.length]);

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const handleMessagesScroll = (): void => {
    const messages = messagesRef.current;
    if (messages !== null && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 28) setHasUnreadMessages(false);
  };

  return (
    <section className="room-chat" aria-label="방 대화">
      <header className="room-chat__heading"><div className="room-chat__live"><span><i aria-hidden="true" />LIVE</span><strong aria-label={`메시지 ${activity.messages.length}개`}>{activity.messages.length}</strong></div></header>
      <div className="room-chat__feed">
        <ol className="room-chat__messages" ref={messagesRef} role="log" aria-label="방 대화" aria-relevant="additions text" onScroll={handleMessagesScroll}>
          {activity.messages.map((message) => {
            const isMine = selfDisplayName !== undefined && selfDisplayName.length > 0 && message.authorName === selfDisplayName;
            return <li className={`room-chat__message${isMine ? " room-chat__message--mine" : ""}`} key={message.id}>
              <span className={`room-chat__avatar room-chat__avatar--${chatAvatarTone(message.authorName)}`} aria-hidden="true">{message.authorName.slice(0, 1)}</span>
              <div className="room-chat__message-copy"><div className="room-chat__message-meta"><strong>{message.authorName}</strong>{isMine ? <span>나</span> : null}<time dateTime={message.createdAt}>{formatChatTime(message.createdAt)}</time></div><p>{message.content}</p></div>
            </li>;
          })}
        </ol>
        {hasUnreadMessages ? <button className="room-chat__new-messages" type="button" onClick={scrollToLatest}>새 메시지 보기 <span aria-hidden="true">↓</span></button> : null}
      </div>
      <form className="room-chat__composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="room-chat-message">방에 보낼 메시지</label>
        <div className="room-chat__composer-field"><textarea id="room-chat-message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} maxLength={300} rows={2} placeholder="이야기를 남겨 보세요" autoComplete="off" /></div>
        <Button type="submit" disabled={activity.isSending || draft.trim().length === 0}>보내기</Button>
      </form>
      {showProblem && activity.problem !== null ? <p className="room-problem" role="alert">{activity.problem}</p> : null}
    </section>
  );
};

const formatTurnTime = (remainingSeconds: number): string => `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;

const IcebreakerTurnPanel = ({ activity, isHost }: Readonly<{ activity: RoomActivityTransport; isHost: boolean }>) => {
  if (activity.turn === null || activity.turnStatus === "closed") return null;
  return (
    <section className="turn-window" aria-live="polite" aria-labelledby="turn-window-title">
      <h2 id="turn-window-title">{activity.turn.ownerName}님의 차례</h2>
      <div className="turn-window__time"><strong>{formatTurnTime(activity.remainingSeconds)}</strong></div>
      {isHost ? <div className="turn-window__actions"><Button kind="quiet" disabled={activity.isUpdatingTurn} onClick={activity.extendTurn}>+1분</Button><Button disabled={activity.isUpdatingTurn} onClick={activity.closeTurn}>다음 카드 열기</Button></div> : null}
    </section>
  );
};

export const WaitingRoom = ({ roomState, activity = emptyRoomActivity() }: Readonly<{ roomState: RoomState; activity?: RoomActivityTransport }>) => {
  const { room, isWorking, problem, setExpectedAttendance, selectGame, setReady, start, retry, leaveRoom, updateDisplayName } = roomState;
  const [expectedAttendance, setExpectedAttendanceInput] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const waitingTitle = useRef<HTMLHeadingElement>(null);
  const hasFocusedWaitingRoomArrival = useRef(false);
  useEffect(() => {
    if (room !== null) setExpectedAttendanceInput(String(room.expectedAttendance));
  }, [room?.expectedAttendance]);
  useEffect(() => {
    if (room === null) {
      hasFocusedWaitingRoomArrival.current = false;
      return;
    }
    if (hasFocusedWaitingRoomArrival.current) return;
    hasFocusedWaitingRoomArrival.current = true;
    requestAnimationFrame(() => waitingTitle.current?.focus());
  }, [room]);

  const participants = room?.participants ?? [];
  const selfDisplayName = participants.find((participant) => participant.isSelf)?.displayName ?? "";

  useEffect(() => {
    setDisplayNameDraft(selfDisplayName);
  }, [selfDisplayName]);

  if (room === null) {
    return (
      <section className="connection-card" role="alert" aria-labelledby="room-entry-problem-title">
        <h1 id="room-entry-problem-title">방에 들어오지 못했어요.</h1>
        <p>{problem ?? "초대 코드를 다시 확인해 주세요."}</p>
        <Button disabled={isWorking || roomState.isJoining} onClick={retry}>다시 시도하기</Button>
        <p className="room-return"><a href="/join">처음으로</a></p>
      </section>
    );
  }
  const readyMessage = roomReadinessMessage(room);
  const startEnabled = canStartGroup(room);
  const progress = Array.from({ length: room.expectedAttendance }, (_, index) => index < room.readyCount);
  const expectedAttendanceValue = Number(expectedAttendance);
  const canUpdateExpectedAttendance = canSetExpectedAttendance(expectedAttendanceValue, room.joinedCount);
  const updateExpectedAttendance = (): void => {
    if (canUpdateExpectedAttendance) setExpectedAttendance(expectedAttendanceValue);
  };
  const normalizedDisplayName = normalizeNickname(displayNameDraft);
  const canSaveDisplayName = isValidNickname(normalizedDisplayName) && normalizedDisplayName !== selfDisplayName;
  const saveDisplayName = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSaveDisplayName) return;
    void persistRoomDisplayNameAfterRemoteUpdate(normalizedDisplayName, updateDisplayName).then((savedDisplayName) => {
      if (savedDisplayName !== null) {
        setIsEditingName(false);
      }
    });
  };
  const handleLeaveRoom = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (!isWorking) void leaveRoom();
  };
  return (
    <section className="waiting-room" aria-labelledby="waiting-title">
      <div className="waiting-room__flow">
      <div className="waiting-room__intro">
        <h1 id="waiting-title" ref={waitingTitle} tabIndex={-1}>함께 시작할<br />준비를 해요.</h1>
        {roomState.roomLock?.hasPassword ? <p className="say-room-lock"><LockIcon size={14} />비밀번호 방</p> : null}
      </div>
      {room.isHost ? <section className="game-selection" aria-labelledby="game-selection-title">
        <h2 id="game-selection-title">게임을 선택해 주세요.</h2>
        <div className="game-selection__options">{(Object.keys(gameDetails) as GameKey[]).map((game) => {
          const detail = gameDetails[game];
          const selected = room.selectedGame === game;
          return <button className={`game-selection__option${selected ? " game-selection__option--selected" : ""}`} type="button" key={game} disabled={isWorking} aria-pressed={selected} onClick={() => selectGame(game)}><img className="game-selection__illustration" src={detail.illustration} width={80} height={80} alt="" /><strong>{detail.title}</strong><small>{detail.description}</small></button>;
        })}</div>
      </section> : <section className="game-status" aria-live="polite">{room.selectedGame === null ? <strong>방장이 게임을 고르고 있어요.</strong> : <><strong>{gameDetails[room.selectedGame].title}</strong><p>{gameDetails[room.selectedGame].description}</p></>}</section>}
      <p className="readiness-count" role="status">{room.readyCount} / {room.expectedAttendance} 준비 완료</p>
      <div className="readiness-progress" aria-label={`${room.expectedAttendance}명 중 ${room.readyCount}명이 준비를 완료했습니다.`}>{progress.map((isReady, index) => <span className={isReady ? "is-ready" : ""} key={index} aria-hidden="true" />)}</div>
      <p className="readiness-message">{room.isReady ? "준비됐어요. 다른 분들을 기다려요." : readyMessage}</p>
      <section className="participant-roster" aria-label="현재 함께하는 멤버">
        <div className="participant-roster__top"><div className="participant-roster__heading"><h2>현재 함께하는 멤버</h2></div><Button kind="quiet" type="button" disabled={isWorking} onClick={() => setIsEditingName((current) => !current)}>이름 수정하기</Button></div>
        {isEditingName ? <form className="nickname-editor" onSubmit={saveDisplayName}><label htmlFor="room-display-name-edit">내 이름</label><input id="room-display-name-edit" value={displayNameDraft} onChange={(event) => setDisplayNameDraft(event.target.value)} autoComplete="nickname" maxLength={12} placeholder="예: 하늘" /><small>2자에서 12자로 입력해 주세요.</small><div className="nickname-editor__actions"><Button disabled={isWorking || !canSaveDisplayName} type="submit">저장하기</Button><Button kind="quiet" type="button" disabled={isWorking} onClick={() => { setDisplayNameDraft(selfDisplayName); setIsEditingName(false); }}>취소</Button></div></form> : null}
        {participants.length > 0 ? <ol className="participant-roster__list">{participants.map((participant) => <li className="participant-roster__item" key={participant.turnPosition}><strong>{participant.displayName}</strong><span>{participant.isSelf ? "나" : participant.isReady ? "준비 완료" : "입장 완료"}</span></li>)}</ol> : <p className="participant-roster__empty" role="status">함께하는 멤버를 확인하고 있어요.</p>}
      </section>
      <section className="ready-control">
        {room.isHost && startEnabled ? <Button disabled={isWorking} onClick={start}>시작하기</Button> : <Button kind={room.isReady ? "quiet" : "primary"} disabled={isWorking} onClick={() => setReady(!room.isReady)}>{room.isReady ? "준비 취소" : "준비하기"}</Button>}
        {room.isHost && !startEnabled ? <p>{room.selectedGame === null ? "먼저 오늘의 게임을 골라 주세요." : "모두 준비되면 시작할 수 있어요."}</p> : null}
      </section>
      {room.isHost ? <details className="room-utility">
        <summary>방 설정</summary>
        {room.isHost ? (
          <section className="attendance-control" aria-labelledby="attendance-setting-title">
            <div className="attendance-control__copy">
              <h2 id="attendance-setting-title">참여 인원</h2>
            </div>
            <div className="attendance-control__field">
              <label className="sr-only" htmlFor="expected-attendance">함께할 인원</label>
              <input id="expected-attendance" type="number" min="2" max="20" inputMode="numeric" value={expectedAttendance} onChange={(event) => setExpectedAttendanceInput(event.target.value)} />
              <span aria-hidden="true">명</span>
              <Button kind="quiet" disabled={isWorking || expectedAttendanceValue === room.expectedAttendance || !canUpdateExpectedAttendance} onClick={updateExpectedAttendance}>변경</Button>
            </div>
            <p className="attendance-control__note">입장한 인원보다 적게 설정할 수 없어요.</p>
          </section>
        ) : null}
        {roomState.roomLock !== null ? <RoomPasswordSetting hasPassword={roomState.roomLock.hasPassword} disabled={isWorking} onSave={roomState.setRoomPassword} /> : null}
      </details> : null}
      {problem !== null ? <p className="room-problem" role="alert">{problem}</p> : null}
      <p className="room-return"><a href="/join" onClick={handleLeaveRoom}>처음으로</a></p>
      </div>
      <div className="waiting-room__aside">
        <img className="waiting-room__art" src="/images/say-on/shared-table-cutout-v1.webp" alt="" aria-hidden="true" width={640} height={585} />
        <RoomChat activity={activity} selfDisplayName={selfDisplayName} />
      </div>
    </section>
  );
};

type DrawState = ReturnType<typeof useGroupDraw>;

const QuestionAtlas = ({ unlockedQuestionIndexes, onClose, closeLabel = "돌아가기", game = "icebreaker" }: Readonly<{ unlockedQuestionIndexes: readonly number[]; onClose: () => void; closeLabel?: string; game?: GameKey }>) => {
  const unlocked = new Set(unlockedQuestionIndexes);
  const gameQuestions = questionsForGame(game);
  return (
    <section className="question-atlas" aria-labelledby="question-atlas-title">
      <header className="question-atlas__header">
        <span className="section-kicker">대화 카드</span>
        <h1 id="question-atlas-title">오늘의 {game === "balance" ? "밸런스" : "이야기"}</h1>
        <p>함께 연 질문을 다시 볼 수 있어요.</p>
      </header>
      <p className="atlas-count"><strong>질문 보관함</strong><span>{unlocked.size} / {gameQuestions.length}장 열림</span></p>
      <ol className="question-atlas__list">
        {gameQuestions.map((question, index) => {
          const isUnlocked = unlocked.has(index);
          return (
            <li className={isUnlocked ? "question-atlas__entry" : "question-atlas__entry question-atlas__entry--locked"} key={question}>
              <span className="question-atlas__number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{isUnlocked ? question : "아직 열리지 않은 질문"}</strong>
                <p>{isUnlocked ? "오늘 함께 나눈 질문이에요." : "아직 열리지 않았어요."}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <Button kind="quiet" onClick={onClose}>{closeLabel}</Button>
    </section>
  );
};

/** Balance card back: the question's two choice images with a small "VS" (approved game-art board). */
const BalanceCardPair = ({ card }: Readonly<{ card: BalanceCard }>) => {
  const art = balanceArtFor(card);
  return (
    <span className="question-card__pair" aria-hidden="true">
      <img src={art.a} alt="" width={96} height={96} />
      <small>VS</small>
      <img src={art.b} alt="" width={96} height={96} />
    </span>
  );
};

const CardChoices = ({ sun, drawIndex, roundNumber = 1, game = "icebreaker", cardOptions = [], selectedCardIndex = null, disabled = false, onChoose }: Readonly<{ sun: number; drawIndex: number; roundNumber?: number; game?: GameKey; cardOptions?: readonly GroupCardOption[]; selectedCardIndex?: number | null; disabled?: boolean; onChoose: (cardIndex: number) => void }>) => (
  <div className="question-cards">
    {cardThemes.map((card, cardIndex) => {
      const questionIndex = cardOptions.find((option) => option.cardIndex === cardIndex)?.questionIndex ?? cardQuestionIndex(sun, drawIndex, cardIndex, roundNumber, game);
      const selected = selectedCardIndex === cardIndex;
      return (
      <button className={`question-card question-card--${card.materialKey}${selected ? " question-card--selected" : ""}`} key={card.materialKey} type="button" disabled={disabled} onClick={() => onChoose(cardIndex)} aria-pressed={selected} aria-label={`${cardIndex + 1}번 카드${selected ? ", 선택됨" : ""}`}>
        <img className="question-card__art" src={questionCardBackForGame(game, questionIndex)} alt="" aria-hidden="true" />
        <b className="question-card__wash" aria-hidden="true" />
        {game === "balance" && balanceCards[questionIndex] !== undefined
          ? <BalanceCardPair card={balanceCards[questionIndex]!} />
          : <img className="question-card__illustration" src={questionStickerForGame(game, questionIndex)} alt="" aria-hidden="true" />}
        <span className="question-card__number" aria-hidden="true">{cardIndex + 1}</span>
      </button>
      );
    })}
  </div>
);

export const LiveRoom = ({ sun, roomState, drawState, activity = emptyRoomActivity() }: Readonly<{ sun: number; roomState: RoomState; drawState: DrawState; activity?: RoomActivityTransport }>) => {
  const { draws, history, cardOptions = [], isPreparingOptions = false, retryCardOptions, choose, isChoosing, problem } = drawState;
  const room = roomState.room;
  const [choosing, setChoosing] = useState(draws.length === 0);
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [isAtlasOpen, setIsAtlasOpen] = useState(false);
  const [isReturning, setIsReturning] = useState(false);
  const latest = draws.at(-1);
  const nextDrawIndex = draws.length;
  const visibleRound = latest === undefined ? nextDrawIndex + 1 : draws.length;
  useEffect(() => { setChoosing(draws.length === 0); setSelectedCardIndex(null); setIsAtlasOpen(false); }, [room?.roundNumber]);
  useEffect(() => { if (latest !== undefined) { setChoosing(false); setSelectedCardIndex(null); } }, [latest]);
  if (room === null) return null;
  const game = room.selectedGame ?? "icebreaker";
  const selfDisplayName = (room.participants ?? []).find((participant) => participant.isSelf)?.displayName;
  const isMyTurn = isMyCardTurn(room.roundNumber, nextDrawIndex, room.participantCount, room.turnPosition);
  const selectorPosition = ((room.roundNumber - 1) * maximumGroupDraws + nextDrawIndex) % room.participantCount;
  const selectingParticipant = (room.participants ?? []).find((participant) => participant.turnPosition === selectorPosition) ?? null;
  const canOpenAnotherCard = game !== "icebreaker" || canOpenNextIcebreakerCard(activity.turn);
  const canChoose = choosing && nextDrawIndex < maximumGroupDraws && isMyTurn && canOpenAnotherCard && cardOptions.length === 3;
  const isPreparingCardOptions = choosing && nextDrawIndex < maximumGroupDraws && isMyTurn && canOpenAnotherCard && cardOptions.length !== 3;
  const isRoundComplete = draws.length === maximumGroupDraws;
  const theme = cardThemeFor(latest?.cardIndex ?? 0);
  const questionArtwork = questionImageForGame(game, latest?.questionIndex ?? 0);
  const questionIllustration = questionStickerForGame(game, latest?.questionIndex ?? 0);
  const returnTo = (destination: "game-selection" | "event-menu"): void => {
    if (isReturning) return;
    setIsReturning(true);
    const action = destination === "game-selection" ? roomState.returnToGameSelection : roomState.returnToEventMenu;
    void action().then((didReturn) => {
      if (!didReturn) setIsReturning(false);
    }).catch(() => setIsReturning(false));
  };
  if (isAtlasOpen && isRoundComplete) return <QuestionAtlas game={game} unlockedQuestionIndexes={history.map(({ questionIndex }) => questionIndex)} onClose={() => setIsAtlasOpen(false)} />;
  const balanceCard = game === "balance" && latest !== undefined ? balanceCards[latest.questionIndex] : undefined;
  const balanceActivity = {
    ...activity,
    vote: latest !== undefined && activity.vote?.roundNumber === latest.roundNumber && activity.vote.drawIndex === latest.drawIndex ? activity.vote : null
  };
  const latestQuestion = latest === undefined ? null : balanceCard?.prompt ?? questionForGameIndex(game, latest.questionIndex);
  const activityPanel = latest !== undefined && latestQuestion !== null
    ? game === "icebreaker"
      ? <IcebreakerTurnPanel activity={activity} isHost={room.isHost} />
      : null
    : null;
  return (
    <section className={`live-room${game === "balance" ? " live-room--balance" : " live-room--icebreaker"}`} aria-labelledby="live-room-title">
      <div className="live-room__stage">
        <header className="live-room__heading"><h1 id="live-room-title" className={latest === undefined ? undefined : "sr-only"}>{latest === undefined ? "카드를 골라 주세요." : game === "balance" ? "밸런스 질문" : "이야기 질문"}</h1></header>
        {game === "balance" && activity.problem !== null ? <p className="room-problem" role="alert">{activity.problem}</p> : null}
        {canChoose ? (
          <section className="choice-panel" aria-labelledby="choice-title">
            <p id="choice-title">{selectingParticipant === null ? "내 차례예요." : `${selectingParticipant.displayName}님 차례예요.`} 1, 2, 3 중 고르세요.</p>
            <CardChoices sun={sun} drawIndex={nextDrawIndex} roundNumber={room.roundNumber} game={game} cardOptions={cardOptions} selectedCardIndex={selectedCardIndex} disabled={isChoosing} onChoose={setSelectedCardIndex} />
            {selectedCardIndex !== null ? <section className="card-confirmation" aria-label={`${selectedCardIndex + 1}번 카드 선택됨`}><div className="card-confirmation__actions"><Button disabled={isChoosing} onClick={() => choose(nextDrawIndex, selectedCardIndex)}>질문 열기</Button><Button kind="quiet" disabled={isChoosing} onClick={() => setSelectedCardIndex(null)}>다시 고르기</Button></div></section> : null}
          </section>
        ) : isPreparingCardOptions ? (
          <div className="turn-notice"><p role="status">{isPreparingOptions ? "카드 세 장을 준비하고 있어요." : "카드 세 장을 불러오지 못했어요."}</p>{!isPreparingOptions ? <Button kind="quiet" onClick={retryCardOptions}>카드 다시 불러오기</Button> : null}</div>
        ) : latest !== undefined && latestQuestion !== null ? (
          <>{balanceCard !== undefined ? <BalanceQuestion card={balanceCard} activity={balanceActivity} /> : <PromptCard prompt={latestQuestion} theme={theme} artwork={questionArtwork} illustration={questionIllustration} />}{!isRoundComplete ? (isMyTurn ? (canOpenAnotherCard ? <Button kind="quiet" onClick={() => setChoosing(true)}>카드 고르기</Button> : <p className="turn-notice" role="status">이야기를 마친 뒤 방장이 다음 카드를 열어 주세요.</p>) : <p className="turn-notice" role="status">{selectingParticipant === null ? "다음 선택을 기다리고 있어요." : `다음은 ${selectingParticipant.displayName}님이 카드를 고릅니다.`}</p>) : <section className="round-decision" aria-labelledby="round-decision-title"><h2 id="round-decision-title">다음은?</h2>{room.isHost ? <div className="round-decision__actions"><Button disabled={roomState.isWorking || isReturning} onClick={() => returnTo("game-selection")}>한 번 더 하기</Button><Button kind="quiet" disabled={roomState.isWorking || isReturning} onClick={() => returnTo("event-menu")}>메인 메뉴로</Button></div> : <p className="round-decision__status" role="status">방장이 다음 순서를 정하고 있어요.</p>}</section>}</>
        ) : <p className="turn-notice" role="status">{selectingParticipant === null ? "첫 카드 선택을 기다리고 있어요." : `첫 카드는 ${selectingParticipant.displayName}님이 고릅니다.`}</p>}
        {problem !== null ? <p className="room-problem" role="alert">{problem}</p> : null}
      </div>
      <aside className={`live-room__support${activityPanel === null ? " live-room__support--chat-only" : ""}`}>
        {activityPanel}
        <RoomChat activity={activity} selfDisplayName={selfDisplayName} showProblem={game !== "balance"} />
      </aside>
    </section>
  );
};

const RoomPage = () => {
  const { eventId, mode, problem } = useEventTransport();
  const params = new URLSearchParams(window.location.search);
  const inviteCode = normalizeInviteCode(params.get("code") ?? "");
  const hasValidInviteCode = canJoinInviteRoom(inviteCode);
  const requestedGroupNumber = roomGroupNumberFromSearchParams(params);
  const hasValidRoomTarget = hasValidInviteCode || requestedGroupNumber !== null;
  const [displayNameDraft, setDisplayNameDraft] = useState(() => savedRoomDisplayName() ?? "");
  const [displayName, setDisplayName] = useState<string | null>(() => savedRoomDisplayName());
  const normalizedDisplayName = normalizeNickname(displayNameDraft);
  const canEnterRoom = isValidNickname(normalizedDisplayName);
  const enterRoom = (): void => {
    if (!canEnterRoom) return;
    saveRoomDisplayName(normalizedDisplayName);
    setDisplayName(normalizedDisplayName);
  };
  const roomState = useGroupRoom(eventId, hasValidInviteCode ? inviteCode : null, requestedGroupNumber, displayName);
  const groupNumber = roomState.groupNumber;
  const drawState = useGroupDraw(eventId, groupNumber, roomState.room?.roundNumber ?? 1, roomState.room !== null, roomState.room?.revision ?? 0, roomState.room?.phase ?? null, roomState.room?.selectedGame ?? "icebreaker", roomState.room?.participantCount ?? 1, roomState.room?.turnPosition ?? 0);
  const activity = useRoomActivity(eventId, groupNumber, roomState.room, drawState.draws.at(-1) ?? null, roomState.room !== null);
  const isLive = roomState.room?.phase === "live";
  const isPasswordGated = displayName !== null && roomState.room === null && roomState.passwordGate !== null;
  const handleLeaveRoom = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (roomState.room === null) return;
    event.preventDefault();
    if (!roomState.isWorking) void roomState.leaveRoom();
  };
  useEffect(() => {
    if (roomState.releasedToLobby) window.location.replace("/join");
  }, [roomState.releasedToLobby]);
  return (
    <main className={`room-shell${isLive && roomState.room?.selectedGame === "balance" ? " room-shell--balance" : ""}${!hasValidRoomTarget || displayName === null || isPasswordGated ? " say-arrival say-room-entry" : " room-shell--say"}`}>
      <div className="room-shell__image" aria-hidden="true" />
      <div className="room-shell__wash" aria-hidden="true" />
      <header className="room-topline"><a href="/join" className="brand" onClick={handleLeaveRoom}>Say-On <span className="say-brand-korean" lang="ko">사연</span></a></header>
      {displayName !== null && roomState.room !== null && roomState.inviteCode !== null && !roomState.releasedToLobby ? <RoomInviteCode inviteCode={roomState.inviteCode} /> : null}
      {!hasValidRoomTarget ? <section className="connection-card"><h1>방 정보를 확인해 주세요.</h1><a className="button button--quiet" href="/join">처음으로</a></section> : displayName === null ? <section className="connection-card" aria-labelledby="room-name-heading"><h1 id="room-name-heading">이름을 정하고<br />방에 들어가요.</h1><p className="room-identity">함께하는 사람들이 알아볼 수 있는 이름을 사용해 주세요.</p><form onSubmit={(event) => { event.preventDefault(); enterRoom(); }}><label className="nickname-field" htmlFor="room-display-name"><span>방에서 사용할 이름</span><input id="room-display-name" value={displayNameDraft} onChange={(event) => setDisplayNameDraft(event.target.value)} maxLength={12} placeholder="예: 하늘" autoComplete="nickname" autoFocus /><small>한글, 영문, 숫자를 포함해 2자에서 12자로 입력해 주세요.</small></label><Button disabled={!canEnterRoom} type="submit">내 이름으로 들어갑니다 <span aria-hidden="true">→</span></Button></form></section> : roomState.releasedToLobby ? <section className="connection-card" role="status"><h1>메뉴로 돌아가고 있어요.</h1></section> : isPasswordGated && roomState.passwordGate !== null ? <RoomPasswordGateCard gate={roomState.passwordGate} isJoining={roomState.isJoining} onSubmit={roomState.submitPassword} /> : roomState.isJoining || mode === "connecting" ? <section className="connection-card"><h1>방에 들어가고 있어요.</h1></section> : isLive ? <LiveRoom sun={groupNumber ?? 1} roomState={roomState} drawState={drawState} activity={activity} /> : <WaitingRoom roomState={roomState} activity={activity} />}
      {mode === "error" ? <ModeNote problem={problem} /> : null}
    </main>
  );
};

const WaitingRoomQAPage = () => {
  const [state, setState] = useState(createWaitingRoomQAState);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const counts = getWaitingRoomQACounts(state);
  const startEnabled = canStartGroup({ phase: state.phase, selectedGame: "icebreaker", ...counts });
  const currentHost = state.people.find((person) => person.id === state.hostId);
  const latestDraw = state.sessionDraws.at(-1);
  const selectedQuestionIndex = state.selectedCardIndex === null ? null : cardQuestionIndex(7, state.sessionDraws.length, state.selectedCardIndex);
  const selectedQuestion = state.selectedCardIndex === null ? "" : cardQuestion(7, state.sessionDraws.length, state.selectedCardIndex);
  const reset = () => {
    setNicknameDraft("");
    setState(resetWaitingRoomQAState);
  };
  useEffect(() => {
    if (state.stage === "nickname" || state.stage === "confirming") return;
    requestAnimationFrame(() => stageHeading.current?.focus());
  }, [state.stage]);
  let content: ReactNode;

  if (state.stage === "nickname") {
    const normalizedNickname = normalizeNickname(nicknameDraft);
    const canContinue = isValidNickname(normalizedNickname);
    content = <section className="qa-game"><div className="qa-game__header"><span className="section-kicker">LOCAL FLOW · 01</span><h1>이름을 정하고<br />방에 들어갑니다.</h1><p>이름은 함께하는 멤버가 서로를 알아보기 위해서만 사용합니다. 이 점검 화면에서는 어떤 정보도 저장하지 않습니다.</p></div><label className="nickname-field" htmlFor="qa-nickname"><span>방에서 사용할 이름</span><input id="qa-nickname" value={nicknameDraft} onChange={(event) => setNicknameDraft(event.target.value)} maxLength={12} placeholder="예: 하늘" autoComplete="nickname" /><small>한글, 영문, 숫자를 포함해 2자에서 12자로 입력해 주세요.</small></label><Button disabled={!canContinue} onClick={() => setState((current) => continueWaitingRoomQANickname(current, normalizedNickname))}>내 이름으로 들어갑니다 <span aria-hidden="true">→</span></Button></section>;
  } else if (state.stage === "waiting") {
    content = <section className="qa-game"><div className="qa-game__header"><span className="section-kicker">LOCAL FLOW · 02</span><h1 ref={stageHeading} tabIndex={-1}>모두 준비되면<br />함께 시작합니다.</h1><p><strong>{state.nickname}</strong>님이 참여 중입니다. 모든 멤버가 준비를 마치면 방장이 시작할 수 있습니다.</p></div><div className="qa-readiness" aria-live="polite"><p className="readiness-count">{counts.expectedAttendance}명 중 {counts.readyCount}명이 준비를 완료했습니다.</p><div className="readiness-progress" aria-label={`${counts.expectedAttendance}명 중 ${counts.readyCount}명이 준비를 완료했습니다.`}>{state.people.map((person) => <span className={person.ready ? "is-ready" : ""} key={person.id} aria-hidden="true" />)}</div><p className="readiness-message">{roomReadinessMessage(counts)}</p></div><div className="qa-person-list" aria-label="멤버 준비 상태">{state.people.map((person) => <div className="qa-person" key={person.id}><div className="qa-person__copy"><strong>{person.label}</strong>{person.id === state.hostId ? <span>현재 방장</span> : null}</div><button className="qa-person__status" type="button" aria-pressed={person.ready} onClick={() => setState((current) => setWaitingRoomQAReady(current, person.id))}>{person.ready ? "준비됨" : "준비하기"}</button></div>)}</div><section className="ready-control"><Button disabled={!startEnabled} onClick={() => setState(startWaitingRoomQA)}>질문을 시작합니다 <span aria-hidden="true">→</span></Button><p>{startEnabled ? "모두 준비되었습니다. 시작 버튼을 눌러 카드 선택을 확인해 주세요." : "모든 멤버가 준비되면 시작 버튼이 활성화됩니다."}</p></section><details className="room-utility qa-utility"><summary>방장 권한을 점검합니다</summary><p>현재 방장은 {currentHost?.label ?? "방장"}입니다. 다른 멤버에게 권한을 넘길 수 있습니다.</p><label className="qa-host-picker" htmlFor="qa-host-picker"><span>방장 권한을 넘길 멤버</span><select id="qa-host-picker" value={state.hostId} onChange={(event) => setState((current) => transferWaitingRoomQAHost(current, event.target.value))}>{state.people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}</select></label></details></section>;
  } else if (state.stage === "atlas") {
    content = <section className="qa-game"><div className="qa-game__header"><span className="section-kicker">LOCAL FLOW · ATLAS</span><h1 ref={stageHeading} tabIndex={-1}>오늘의 질문<br />보관함입니다.</h1><p>함께 본 질문은 열리고, 아직 선택하지 않은 질문은 살짝 감춰집니다.</p></div><QuestionAtlas unlockedQuestionIndexes={state.unlockedQuestionIndexes} onClose={() => setState(closeWaitingRoomQAAtlas)} /></section>;
  } else if (state.stage === "complete") {
    content = <section className="qa-game qa-session-fork"><div className="qa-game__header"><span className="section-kicker">LOCAL FLOW · 05</span><h1 ref={stageHeading} tabIndex={-1}>다섯 장을<br />모두 나눴어요.</h1></div><div className="qa-game-actions"><Button onClick={() => setState(beginNextWaitingRoomQASession)}>한 번 더 하기</Button><a className="button button--quiet" href="/join">메인 메뉴로</a></div></section>;
  } else if (state.stage === "revealed" && latestDraw !== undefined) {
    const questionIndex = cardQuestionIndex(7, latestDraw.drawIndex, latestDraw.cardIndex);
    content = <section className="qa-game"><div className="qa-game__header"><span className="section-kicker">LOCAL FLOW · {state.sessionDraws.length} / {maximumGroupDraws}</span><h1 ref={stageHeading} tabIndex={-1}>우리 방의 질문이<br />열렸습니다.</h1><p>카드가 뒤집힌 뒤 모두가 같은 질문을 보고, 한 사람씩 편하게 이야기를 나눕니다.</p></div><PromptCard prompt={cardQuestion(7, latestDraw.drawIndex, latestDraw.cardIndex)} theme={cardThemeFor(latestDraw.cardIndex)} artwork={questionImageFor(questionIndex)} illustration={questionStickerFor(questionIndex)} /><div className="qa-game-actions"><Button onClick={() => setState(advanceWaitingRoomQACard)}>{state.sessionDraws.length === maximumGroupDraws ? "오늘의 이야기 마치기" : "다음 카드 세 장을 확인합니다"} <span aria-hidden="true">→</span></Button><Button kind="quiet" onClick={() => setState(openWaitingRoomQAAtlas)}>오늘의 질문 보관함</Button></div></section>;
  } else {
    content = <section className="qa-game"><div className="qa-game__header"><span className="section-kicker">LOCAL FLOW · {state.sessionDraws.length + 1} / {maximumGroupDraws}</span><h1 ref={stageHeading} tabIndex={-1}>이번에는 어떤 이야기를<br />함께 꺼내 볼까요?</h1><p>세 장을 모두 살펴본 뒤, 마음이 가는 한 장을 고릅니다.</p></div><CardChoices sun={7} drawIndex={state.sessionDraws.length} selectedCardIndex={state.selectedCardIndex} onChoose={(cardIndex) => setState((current) => selectWaitingRoomQACard(current, 7, cardIndex))} />{state.stage === "confirming" && selectedQuestionIndex !== null ? <section className="card-confirmation" aria-live="polite"><p><strong>{selectedQuestion}</strong> 카드를 선택하셨습니다. 이 카드로 질문을 열겠습니까?</p><div className="card-confirmation__actions"><Button onClick={() => setState((current) => confirmWaitingRoomQACard(current, 7))}>이 카드로 질문을 엽니다 <span aria-hidden="true">→</span></Button><Button kind="quiet" onClick={() => setState((current) => ({ ...current, selectedCardIndex: null, stage: "choosing" }))}>다시 고릅니다</Button></div></section> : <p className="card-swipe-hint">옆으로 밀어 세 장을 모두 살펴보실 수 있습니다.</p>}</section>;
  }

  return <main className="room-shell qa-shell"><div className="room-shell__image" aria-hidden="true" /><div className="room-shell__wash" aria-hidden="true" /><header className="room-topline"><span className="brand">Say-On <span className="say-brand-korean" lang="ko">사연</span></span><span>LOCAL QA</span></header><section className="qa-card qa-card--game" aria-label="로컬 전체 흐름 점검">{content}<details className="room-utility qa-utility"><summary>점검 상태를 초기화합니다</summary><p>처음부터 다시 확인하고 싶으시면 로컬 점검 상태만 초기화할 수 있습니다.</p><Button kind="quiet" onClick={reset}>점검 상태 초기화</Button></details></section></main>;
};

const BalanceVoteQAPage = () => {
  const [vote, setVote] = useState<BalanceVote>({ roundNumber: 1, drawIndex: 0, aCount: 7, bCount: 6, myChoice: null });
  const activity: RoomActivityTransport = {
    ...emptyRoomActivity(),
    vote,
    castVote: (choice) => setVote((current) => {
      if (current.myChoice !== null) return current;
      return choice === "a"
        ? { ...current, aCount: current.aCount + 1, myChoice: choice }
        : { ...current, bCount: current.bCount + 1, myChoice: choice };
    }),
  };

  return (
    <main className="room-shell qa-shell">
      <div className="room-shell__image" aria-hidden="true" />
      <div className="room-shell__wash" aria-hidden="true" />
      <header className="room-topline"><span className="brand">Say-On <span className="say-brand-korean" lang="ko">사연</span></span><span>LOCAL QA</span></header>
      <section className="qa-card qa-card--game" aria-labelledby="balance-vote-qa-title">
        <div className="qa-game__header"><span className="section-kicker">LOCAL FLOW · BALANCE</span><h1 id="balance-vote-qa-title">하나를 고르면<br />함께 보입니다.</h1></div>
        <BalanceQuestion card={balanceCards[0]!} activity={activity} />
      </section>
    </main>
  );
};

const LiveBalanceQAPage = () => {
  const [messages, setMessages] = useState<RoomActivityTransport["messages"]>([
    { id: "qa-message-1", authorName: "민지", content: "저는 짬뽕이요. 국물이 있어야 해요.", createdAt: "2026-09-14T06:00:00.000Z" }
  ]);
  const [vote, setVote] = useState<BalanceVote>({ roundNumber: 1, drawIndex: 0, aCount: 7, bCount: 6, myChoice: null });
  const roomState: RoomState = {
    room: {
      expectedAttendance: 2, joinedCount: 2, readyCount: 2, phase: "live", roundNumber: 1, revision: 7, eventMenuRevision: 0,
      selectedGame: "balance", isHost: true, isReady: true, participantCount: 2, turnPosition: 0, displayName: "하늘",
      participants: [
        { displayName: "하늘", isReady: true, turnPosition: 0, isSelf: true },
        { displayName: "민지", isReady: true, turnPosition: 1, isSelf: false }
      ]
    },
    groupNumber: 7,
    inviteCode: "SAYON123",
    isJoining: false,
    isWorking: false,
    releasedToLobby: false,
    problem: null,
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
  };
  const draw = { sun: 7, roundNumber: 1, drawIndex: 0, cardIndex: 0, questionIndex: 0, chosenAt: "2026-09-14T06:00:00.000Z" };
  const drawState: DrawState = {
    draws: [draw], history: [draw], cardOptions: [], isPreparingOptions: false,
    retryCardOptions: () => undefined, choose: () => undefined, isChoosing: false, problem: null
  };
  const activity: RoomActivityTransport = {
    ...emptyRoomActivity(),
    messages,
    vote,
    sendMessage: async (content) => {
      setMessages((current) => [...current, { id: `qa-message-${current.length + 1}`, authorName: "하늘", content, createdAt: new Date().toISOString() }]);
      return true;
    },
    castVote: (choice) => setVote((current) => current.myChoice === null
      ? choice === "a" ? { ...current, aCount: current.aCount + 1, myChoice: choice } : { ...current, bCount: current.bCount + 1, myChoice: choice }
      : current)
  };

  return (
    <main className="room-shell room-shell--balance room-shell--say qa-shell">
      <div className="room-shell__image" aria-hidden="true" />
      <div className="room-shell__wash" aria-hidden="true" />
      <header className="room-topline"><span className="brand">Say-On <span className="say-brand-korean" lang="ko">사연</span></span><span>LOCAL QA</span></header>
      <LiveRoom sun={7} roomState={roomState} drawState={drawState} activity={activity} />
    </main>
  );
};

/** DEV-only: renders the real LiveRoom for the Icebreaker at /qa/live-icebreaker?stage=choose|reveal. */
const LiveIcebreakerQAPage = () => {
  const stage = new URLSearchParams(window.location.search).get("stage") === "choose" ? "choose" : "reveal";
  const [messages, setMessages] = useState<RoomActivityTransport["messages"]>([
    { id: "qa-message-1", authorName: "민지", content: "저는 요즘 빵 굽는 걸 처음 배워 봤어요.", createdAt: "2026-09-14T06:00:00.000Z" }
  ]);
  const [openedAt] = useState(() => Date.now());
  const roomState: RoomState = {
    room: {
      expectedAttendance: 3, joinedCount: 3, readyCount: 3, phase: "live", roundNumber: 1, revision: 7, eventMenuRevision: 0,
      selectedGame: "icebreaker", isHost: true, isReady: true, participantCount: 3, turnPosition: 0, displayName: "하늘",
      participants: [
        { displayName: "하늘", isReady: true, turnPosition: 0, isSelf: true },
        { displayName: "민지", isReady: true, turnPosition: 1, isSelf: false },
        { displayName: "지수", isReady: true, turnPosition: 2, isSelf: false }
      ]
    },
    groupNumber: 7,
    inviteCode: "SAYON123",
    isJoining: false,
    isWorking: false,
    releasedToLobby: false,
    problem: null,
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
  };
  const draw = { sun: 7, roundNumber: 1, drawIndex: 0, cardIndex: 1, questionIndex: 2, chosenAt: "2026-09-14T06:00:00.000Z" };
  const reveal = stage === "reveal";
  const drawState: DrawState = {
    draws: reveal ? [draw] : [], history: reveal ? [draw] : [],
    cardOptions: reveal ? [] : [{ cardIndex: 0, questionIndex: 0 }, { cardIndex: 1, questionIndex: 2 }, { cardIndex: 2, questionIndex: 5 }],
    isPreparingOptions: false, retryCardOptions: () => undefined, choose: () => undefined, isChoosing: false, problem: null
  };
  const activity: RoomActivityTransport = {
    ...emptyRoomActivity(),
    messages,
    turn: reveal ? { roundNumber: 1, drawIndex: 0, ownerName: "하늘", startedAt: new Date(openedAt - 78_000).toISOString(), endsAt: new Date(openedAt + 102_000).toISOString(), closedAt: null } : null,
    turnStatus: reveal ? "active" : null,
    remainingSeconds: reveal ? 102 : 0,
    sendMessage: async (content) => {
      setMessages((current) => [...current, { id: `qa-message-${current.length + 1}`, authorName: "하늘", content, createdAt: new Date().toISOString() }]);
      return true;
    }
  };

  return (
    <main className="room-shell room-shell--say qa-shell">
      <div className="room-shell__image" aria-hidden="true" />
      <div className="room-shell__wash" aria-hidden="true" />
      <header className="room-topline"><span className="brand">Say-On <span className="say-brand-korean" lang="ko">사연</span></span><span>LOCAL QA</span></header>
      <LiveRoom sun={7} roomState={roomState} drawState={drawState} activity={activity} />
    </main>
  );
};

const ScreenPage = () => (
  <main className="screen-shell">
    <div className="coast-image coast-image--screen" aria-hidden="true" /><div className="screen-tint" aria-hidden="true" />
    <span className="brand brand--light">Say-On <span className="say-brand-korean" lang="ko">사연</span></span>
    <section><p className="eyebrow eyebrow--light">함께 모여, 편하게</p><h1>모두 모이면,<br />우리 방의 이야기를<br />시작합니다.</h1></section>
    <p>모든 멤버가 준비를 완료하면 방장이 시작합니다.<br />그 뒤에는 정해진 순서의 멤버가 카드를 골라 모두의 대화를 엽니다.</p>
  </main>
);

const ShowcasePage = () => {
  const questionIndex = cardQuestionIndex(7, 0, 0);
  const [balancePreviewIndex, setBalancePreviewIndex] = useState(0);
  const balancePreview = balanceCards[balancePreviewIndex]!;

  const showPreviousBalanceQuestion = () => {
    setBalancePreviewIndex((current) => current === 0 ? balanceCards.length - 1 : current - 1);
  };

  const showNextBalanceQuestion = () => {
    setBalancePreviewIndex((current) => (current + 1) % balanceCards.length);
  };

  return (
    <main className="showcase">
      <span className="brand">Say-On <span className="say-brand-korean" lang="ko">사연</span></span>
      <h1>컴포넌트 미리보기</h1>
      <div className="showcase-row"><Button>저는 준비되었습니다</Button><Button kind="quiet">다음 카드 세 장 보기</Button></div>
      <section className="choice-panel" aria-label="카드 선택 미리보기"><p>선택한 카드에 오늘의 질문이 들어 있습니다.</p><CardChoices sun={7} drawIndex={0} disabled onChoose={() => undefined} /></section>
      <PromptCard prompt={cardQuestion(7, 0, 0)} theme={cardThemeFor(0)} artwork={questionImageFor(questionIndex)} illustration={questionStickerFor(questionIndex)} />
      <section className="showcase__balance" aria-labelledby="showcase-balance-title">
        <div className="showcase__balance-heading">
          <div>
            <p className="showcase__eyebrow">BALANCE GAME</p>
            <h2 id="showcase-balance-title">60개의 일상 선택</h2>
            <p className="showcase__counter" aria-live="polite">{balancePreviewIndex + 1} / {balanceCards.length}</p>
          </div>
          <div className="showcase__balance-controls">
            <Button kind="quiet" onClick={showPreviousBalanceQuestion}>이전 질문</Button>
            <Button kind="quiet" onClick={showNextBalanceQuestion}>다음 질문</Button>
          </div>
        </div>
        <BalanceQuestion card={balancePreview} activity={emptyRoomActivity()} />
      </section>
    </main>
  );
};

export const App = () => {
  const path = window.location.pathname;
  if (import.meta.env.DEV && path === "/qa/waiting-room") return <WaitingRoomQAPage />;
  if (import.meta.env.DEV && path === "/qa/balance-vote") return <BalanceVoteQAPage />;
  if (import.meta.env.DEV && path === "/qa/live-balance") return <LiveBalanceQAPage />;
  if (import.meta.env.DEV && path === "/qa/live-icebreaker") return <LiveIcebreakerQAPage />;
  if (new URLSearchParams(window.location.search).has("showcase")) return <ShowcasePage />;
  if (path === "/guidebook") return <GuidebookPage />;
  if (path === "/manage") return <RoomManagementPage />;
  if (path === "/room" || path.startsWith("/room/")) return <RoomPage />;
  if (path.startsWith("/screen/")) return <ScreenPage />;
  return <JoinPage />;
};
