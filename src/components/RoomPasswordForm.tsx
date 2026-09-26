import { useEffect, useState } from "react";
import { isValidRoomPassword, normalizeRoomPasswordInput, ROOM_PASSWORD_HINT, roomPasswordGateMessage, type RoomPasswordGate } from "../lib/room-password";
import { Button } from "./primitives";

export const LockIcon = ({ size = 18 }: Readonly<{ size?: number }>) => (
  <svg className="say-lock-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <path d="M7 10V7.5a5 5 0 0 1 10 0V10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    <rect x="4.5" y="10" width="15" height="11" rx="2.5" fill="currentColor" />
    <circle cx="12" cy="15.5" r="1.6" fill="#fffcf5" />
  </svg>
);

const AlertIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /><path d="M12 7v6" stroke="#fffcf5" strokeWidth="2.2" strokeLinecap="round" /><circle cx="12" cy="16.8" r="1.3" fill="#fffcf5" /></svg>
);

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);

/** Error (terracotta) or wait (muted grey) state from the approved board; nothing for "required". */
export const RoomPasswordGateNotice = ({ gate, id }: Readonly<{ gate: RoomPasswordGate | null; id: string }>) => {
  if (gate === null || gate.status === "password_required") return null;
  const isWait = gate.status === "locked";
  return (
    <p id={id} className={`say-gate${isWait ? " say-gate--wait" : " say-gate--error"}`} role="alert">
      {isWait ? <ClockIcon /> : <AlertIcon />}
      <span>{roomPasswordGateMessage(gate)}</span>
    </p>
  );
};

/** PIN entry shared by the lobby sheet and the room page. Digits only, 4 to 12. */
export const RoomPasswordForm = ({ idPrefix, gate, isWorking, submitLabel = "입장하기", onSubmit }: Readonly<{
  idPrefix: string;
  gate: RoomPasswordGate | null;
  isWorking: boolean;
  submitLabel?: string;
  onSubmit: (password: string) => void;
}>) => {
  const [password, setPassword] = useState("");
  const isPaused = gate?.status === "locked";
  const canSubmit = isValidRoomPassword(password) && !isWorking && !isPaused;
  const noticeId = `${idPrefix}-gate`;
  return (
    <form className="say-password-form" aria-busy={isWorking} onSubmit={(event) => { event.preventDefault(); if (canSubmit) onSubmit(password); }}>
      <label className="sr-only" htmlFor={`${idPrefix}-password`}>비밀번호</label>
      <input
        id={`${idPrefix}-password`}
        className="say-pin-input"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={12}
        value={password}
        onChange={(event) => setPassword(normalizeRoomPasswordInput(event.target.value))}
        aria-describedby={gate !== null && gate.status !== "password_required" ? noticeId : undefined}
      />
      <button className="say-action" type="submit" disabled={!canSubmit}>{isWorking ? "확인하고 있어요…" : submitLabel}</button>
      <RoomPasswordGateNotice gate={gate} id={noticeId} />
    </form>
  );
};

/** Room page (invite code or a direct room link): asks for the password the server requires. */
export const RoomPasswordGateCard = ({ gate, isJoining, onSubmit }: Readonly<{
  gate: RoomPasswordGate;
  isJoining: boolean;
  onSubmit: (password: string) => void;
}>) => {
  const [shownGate, setShownGate] = useState<RoomPasswordGate>(gate);
  useEffect(() => { setShownGate(gate); }, [gate]);
  useEffect(() => {
    if (shownGate.status !== "locked") return undefined;
    const timer = window.setTimeout(() => setShownGate({ status: "password_required", attemptsLeft: 5, retryAfterSeconds: null }), (shownGate.retryAfterSeconds ?? 60) * 1000);
    return () => window.clearTimeout(timer);
  }, [shownGate]);
  return (
    <section className="connection-card room-password-gate" aria-labelledby="room-password-heading">
      <span className="say-sheet__icon"><LockIcon size={30} /></span>
      <h1 id="room-password-heading">비밀번호가 필요한 방이에요.</h1>
      <p className="room-identity">방장에게 받은 비밀번호를 입력해 주세요.</p>
      <RoomPasswordForm idPrefix="room-gate" gate={shownGate} isWorking={isJoining} onSubmit={onSubmit} />
      <a className="say-back" href="/join">처음으로</a>
    </section>
  );
};

/** Host setting in the waiting room's room settings: shows the lock state and changes or clears it. */
export const RoomPasswordSetting = ({ hasPassword, disabled, onSave }: Readonly<{
  hasPassword: boolean;
  disabled: boolean;
  onSave: (password: string | null) => Promise<boolean>;
}>) => {
  const [isEditing, setIsEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const save = async (value: string | null): Promise<void> => {
    setIsSaving(true);
    try {
      if (await onSave(value)) {
        setIsEditing(false);
        setPassword("");
      }
    } finally {
      setIsSaving(false);
    }
  };
  const busy = disabled || isSaving;
  return (
    <section className="room-password-setting" aria-labelledby="room-password-setting-title">
      <div className="room-password-setting__row">
        <h2 id="room-password-setting-title">비밀번호</h2>
        <span>{hasPassword ? "설정됨" : "없음"}</span>
        <div className="room-password-setting__actions">
          <Button kind="quiet" disabled={busy} onClick={() => setIsEditing((current) => !current)}>{hasPassword ? "바꾸기" : "설정"}</Button>
          {hasPassword ? <Button kind="quiet" disabled={busy} onClick={() => { void save(null); }}>해제</Button> : null}
        </div>
      </div>
      {isEditing ? (
        <form className="say-password-form" onSubmit={(event) => { event.preventDefault(); if (isValidRoomPassword(password) && !busy) void save(password); }}>
          <label className="sr-only" htmlFor="room-password-new">새 비밀번호</label>
          <input id="room-password-new" className="say-pin-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={password} onChange={(event) => setPassword(normalizeRoomPasswordInput(event.target.value))} aria-describedby="room-password-new-hint" />
          <p id="room-password-new-hint" className="attendance-control__note">{ROOM_PASSWORD_HINT}</p>
          <Button type="submit" disabled={busy || !isValidRoomPassword(password)}>저장</Button>
        </form>
      ) : null}
    </section>
  );
};
