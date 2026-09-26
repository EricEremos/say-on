import { useEffect, useRef, useState, type FormEvent } from "react";
import { useEventTransport } from "../hooks/use-event-transport";
import { useGroupRoomEntry } from "../hooks/use-group-room-entry";
import type { GroupRoomLobbyEntry } from "../hooks/use-group-room";
import { canCreateRoomName, canJoinInviteRoom, groupRoomPath, inviteRoomPath, normalizeInviteCode, normalizeRoomName } from "../lib/room-entry";
import { lobbyRoomAvailability, lobbyRoomStatusLabel, sortLobbyRooms } from "../lib/room-lobby";
import { browserSessionStore, isValidRoomPassword, normalizeRoomPasswordInput, pendingRoomPasswordKey, ROOM_PASSWORD_HINT, savePendingRoomPassword, type RoomPasswordGate } from "../lib/room-password";
import { BottomSheet } from "./BottomSheet";
import { LockIcon, RoomPasswordForm } from "./RoomPasswordForm";
import "./room-lobby.css";

type Sheet = Readonly<{ kind: "create" }> | Readonly<{ kind: "locked"; room: GroupRoomLobbyEntry }> | null;

const SKELETON_ROWS = 3;
const CHECK_PROBLEM = "비밀번호를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.";

const LobbyRoomRow = ({ room, disabled, onEnter }: Readonly<{ room: GroupRoomLobbyEntry; disabled: boolean; onEnter: (room: GroupRoomLobbyEntry) => void }>) => {
  const availability = lobbyRoomAvailability(room);
  const label = lobbyRoomStatusLabel(availability);
  const isOpen = availability === "open";
  const description = `${room.roomName}, ${room.joinedCount} / ${room.capacity}명, ${label}${room.hasPassword ? ", 비밀번호 필요" : ""}`;
  return (
    <li>
      <button className={`say-lobby-room say-lobby-room--${availability}`} type="button" disabled={disabled || !isOpen} onClick={() => onEnter(room)} aria-label={description}>
        <span className="say-lobby-room__main">
          <span className="say-lobby-room__name">{room.hasPassword ? <LockIcon /> : null}<strong>{room.roomName}</strong></span>
          <span className="say-lobby-room__meta">{room.joinedCount} / {room.capacity}명</span>
          {room.hasPassword ? <span className="say-lobby-room__meta">비밀번호 필요</span> : null}
        </span>
        <span className={`say-chip say-chip--${availability}`}>{label}</span>
        <svg className="say-lobby-room__chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>
    </li>
  );
};

export const LobbyRoomList = ({ rooms, isLoading, listProblem, disabled, onEnter, onCreate, onRetry }: Readonly<{
  rooms: readonly GroupRoomLobbyEntry[];
  isLoading: boolean;
  listProblem: string | null;
  disabled: boolean;
  onEnter: (room: GroupRoomLobbyEntry) => void;
  onCreate: () => void;
  onRetry: () => void;
}>) => {
  const sorted = sortLobbyRooms(rooms);
  const problemRow = listProblem !== null ? (
    <p className="say-gate say-gate--error say-lobby__problem" role="alert"><span>{listProblem}</span><span aria-hidden="true">·</span><button type="button" className="say-link-button" onClick={onRetry}>다시 시도</button></p>
  ) : null;
  return (
    <section className="say-lobby__rooms" aria-labelledby="say-lobby-title" aria-busy={isLoading}>
      <header className="say-lobby__rooms-head">
        <h2 id="say-lobby-title">지금 열린 방</h2>
        <span className="say-live"><i aria-hidden="true" />LIVE</span>
        <span className="say-lobby__refreshed">{isLoading ? "" : listProblem === null ? "방금 새로고침" : ""}</span>
      </header>
      {isLoading ? (
        <div className="say-lobby__skeleton">
          <p className="say-lobby__status" role="status">불러오는 중</p>
          {Array.from({ length: SKELETON_ROWS }, (_, index) => <span key={index} className="say-lobby-skeleton" aria-hidden="true"><i /><b /></span>)}
        </div>
      ) : sorted.length === 0 ? (
        listProblem === null ? (
          <div className="say-lobby__empty">
            <p><strong>아직 열린 방이 없어요.</strong><span>첫 방을 만들어 보세요.</span></p>
            <button className="say-action" type="button" onClick={onCreate} disabled={disabled}>방 만들기</button>
          </div>
        ) : null
      ) : (
        <ol className="say-lobby__list">{sorted.map((room) => <LobbyRoomRow key={room.groupNumber} room={room} disabled={disabled} onEnter={onEnter} />)}</ol>
      )}
      {problemRow}
    </section>
  );
};

const CreateRoomSheet = ({ supportsPasswords, isWorking, problem, onClose, onCreate }: Readonly<{
  supportsPasswords: boolean;
  isWorking: boolean;
  problem: string | null;
  onClose: () => void;
  onCreate: (roomName: string, password: string | null) => void;
}>) => {
  const [roomName, setRoomName] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const nameIsValid = canCreateRoomName(roomName);
  const passwordIsValid = !usePassword || isValidRoomPassword(password);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!nameIsValid || !passwordIsValid || isWorking) return;
    onCreate(normalizeRoomName(roomName), usePassword ? password : null);
  };
  return (
    <BottomSheet titleId="say-create-title" title="새 방 만들기" onClose={onClose}>
      <form className="say-sheet__form" onSubmit={submit} aria-busy={isWorking}>
        <label htmlFor="say-create-name">방 이름</label>
        <input id="say-create-name" value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={40} autoComplete="off" placeholder="우리 모임" />
        {supportsPasswords ? (
          <>
            <div className="say-toggle-row">
              <span id="say-create-lock-label">비밀번호 설정</span>
              <button type="button" role="switch" aria-checked={usePassword} aria-labelledby="say-create-lock-label" className={`say-switch${usePassword ? " say-switch--on" : ""}`} onClick={() => setUsePassword((current) => !current)}><i aria-hidden="true" /></button>
            </div>
            {usePassword ? (
              <>
                <label htmlFor="say-create-password">비밀번호</label>
                <input id="say-create-password" className="say-pin-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={password} onChange={(event) => setPassword(normalizeRoomPasswordInput(event.target.value))} aria-describedby="say-create-password-hint" />
                <p id="say-create-password-hint" className="say-entry-note">{ROOM_PASSWORD_HINT}</p>
              </>
            ) : null}
          </>
        ) : null}
        <button className="say-action" type="submit" disabled={!nameIsValid || !passwordIsValid || isWorking}>{isWorking ? "만드는 중…" : "만들기"}</button>
        <p className="say-entry-note">15분 동안 활동이 없으면 방이 사라져요.</p>
        {problem !== null ? <p className="say-entry-error" role="alert">{problem}</p> : null}
      </form>
    </BottomSheet>
  );
};

const LockedRoomSheet = ({ room, gate, problem, isWorking, onClose, onSubmit }: Readonly<{
  room: GroupRoomLobbyEntry;
  gate: RoomPasswordGate | null;
  problem: string | null;
  isWorking: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
}>) => (
  <BottomSheet titleId="say-locked-title" title={room.roomName} icon={<span className="say-sheet__icon"><LockIcon size={30} /></span>} onClose={onClose}>
    <p className="say-sheet__lead">방장에게 받은 비밀번호를 입력해 주세요.</p>
    <RoomPasswordForm idPrefix="say-locked" gate={gate} isWorking={isWorking} onSubmit={onSubmit} />
    {problem !== null ? <p className="say-entry-error" role="alert">{problem}</p> : null}
  </BottomSheet>
);

/** Arrival page: the live room list, create and invite-code entry, and the two sheets. */
export const RoomLobby = () => {
  const { eventId, mode } = useEventTransport();
  const { rooms, isLoadingRooms, createRoom, isWorking, problem, listProblem, refreshRooms, verifyRoomPassword, supportsPasswords } = useGroupRoomEntry(eventId);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [gate, setGate] = useState<RoomPasswordGate | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const [entry, setEntry] = useState<"lobby" | "invite">("lobby");
  const [inviteCode, setInviteCode] = useState("");
  const inviteAction = useRef<HTMLButtonElement>(null);
  const inviteField = useRef<HTMLInputElement>(null);
  const isConnecting = mode === "connecting";

  useEffect(() => { if (entry === "invite") inviteField.current?.focus(); }, [entry]);

  // A paused gate turns back into "enter the password" once its wait has passed.
  useEffect(() => {
    if (gate?.status !== "locked") return undefined;
    const timer = window.setTimeout(() => setGate({ status: "password_required", attemptsLeft: 5, retryAfterSeconds: null }), (gate.retryAfterSeconds ?? 60) * 1000);
    return () => window.clearTimeout(timer);
  }, [gate]);

  const closeSheet = (): void => { setSheet(null); setGate(null); setCheckProblem(null); };

  const enterRoom = (room: GroupRoomLobbyEntry): void => {
    if (room.hasPassword && supportsPasswords) {
      setGate(null);
      setSheet({ kind: "locked", room });
      return;
    }
    const path = groupRoomPath(room.groupNumber);
    if (path !== null) window.location.assign(path);
  };

  const submitPassword = async (room: GroupRoomLobbyEntry, password: string): Promise<void> => {
    setIsChecking(true);
    try {
      const result = await verifyRoomPassword(room.groupNumber, password);
      if (result === "ok") {
        const store = browserSessionStore();
        if (store !== null && eventId !== null) savePendingRoomPassword(store, pendingRoomPasswordKey(eventId, room.groupNumber), password);
        const path = groupRoomPath(room.groupNumber);
        if (path !== null) window.location.assign(path);
        return;
      }
      if (result === null) {
        setCheckProblem(CHECK_PROBLEM);
        return;
      }
      setCheckProblem(null);
      setGate(result);
    } catch {
      setCheckProblem(CHECK_PROBLEM);
    } finally {
      setIsChecking(false);
    }
  };

  const create = async (roomName: string, password: string | null): Promise<void> => {
    const created = await createRoom(roomName, password);
    if (created === null) return;
    const path = inviteRoomPath(created.inviteCode);
    if (path !== null) window.location.assign(path);
  };

  const submitInvite = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const path = inviteRoomPath(inviteCode);
    if (path !== null) window.location.assign(path);
  };

  return (
    <main className="say-arrival say-lobby">
      <header className="say-wordmark">Say-On <span className="say-brand-korean" lang="ko">사연</span></header>
      {entry === "invite" ? (
        <section className="say-lobby__content say-lobby__content--form" aria-labelledby="say-heading">
          <button className="say-back" type="button" onClick={() => { setEntry("lobby"); requestAnimationFrame(() => inviteAction.current?.focus()); }}>← 돌아가기</button>
          <h1 id="say-heading">같은 방에서 만나요.</h1>
          <form className="say-entry-form" onSubmit={submitInvite}>
            <label htmlFor="say-entry-field">초대 코드</label>
            <input ref={inviteField} id="say-entry-field" value={inviteCode} onChange={(event) => setInviteCode(normalizeInviteCode(event.target.value))} maxLength={8} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="8자리 코드" />
            <button className="say-action" disabled={!canJoinInviteRoom(inviteCode)} type="submit">입장하기</button>
          </form>
        </section>
      ) : (
        <section className="say-lobby__content" aria-labelledby="say-heading">
          {/* Source order matches the phone layout (heading, rooms, actions) for keyboard and screen readers. */}
          <h1 id="say-heading" className="say-lobby__title">어떤 이야기부터<br />시작할까요?</h1>
          <LobbyRoomList rooms={rooms} isLoading={isLoadingRooms || isConnecting} listProblem={listProblem} disabled={isWorking || isChecking} onEnter={enterRoom} onCreate={() => setSheet({ kind: "create" })} onRetry={refreshRooms} />
          <div className="say-arrival__actions say-lobby__actions">
            <button className="say-action" type="button" disabled={isConnecting} onClick={() => setSheet({ kind: "create" })}>방 만들기</button>
            <button ref={inviteAction} className="say-action say-action--secondary" type="button" onClick={() => setEntry("invite")}>초대 코드로 참여</button>
          </div>
        </section>
      )}
      {sheet?.kind === "create" ? <CreateRoomSheet supportsPasswords={supportsPasswords} isWorking={isWorking} problem={problem} onClose={closeSheet} onCreate={(roomName, password) => { void create(roomName, password); }} /> : null}
      {sheet?.kind === "locked" ? <LockedRoomSheet room={sheet.room} gate={gate} problem={checkProblem} isWorking={isChecking} onClose={closeSheet} onSubmit={(password) => { void submitPassword(sheet.room, password); }} /> : null}
    </main>
  );
};
