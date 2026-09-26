import { z } from "zod";

/** Server rule (20260926090000_room_lobby_passwords.sql): 4 to 12 digits. */
const ROOM_PASSWORD_PATTERN = /^[0-9]{4,12}$/;
const MAXIMUM_ROOM_PASSWORD_LENGTH = 12;
const PENDING_PASSWORD_PREFIX = "say-on/room-password";

export const ROOM_PASSWORD_HINT = "숫자 4~12자 · 비밀번호를 아는 사람만 들어올 수 있어요";

const RoomPasswordGateSchema = z.object({
  status: z.enum(["password_required", "invalid_password", "locked"]),
  attemptsLeft: z.number().int().min(0),
  retryAfterSeconds: z.number().int().min(1).nullable().optional(),
});

export type RoomPasswordGate = Readonly<{
  status: "password_required" | "invalid_password" | "locked";
  attemptsLeft: number;
  retryAfterSeconds: number | null;
}>;

type KeyValueStore = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

export const isValidRoomPassword = (value: string): boolean => ROOM_PASSWORD_PATTERN.test(value);

export const normalizeRoomPasswordInput = (value: string): string =>
  value.replaceAll(/[^0-9]/g, "").slice(0, MAXIMUM_ROOM_PASSWORD_LENGTH);

/** Reads a gate from a join/verify response ({ passwordGate }) or from a bare gate object. */
export const parseRoomPasswordGate = (candidate: unknown): RoomPasswordGate | null => {
  const source = typeof candidate === "object" && candidate !== null && "passwordGate" in candidate
    ? (candidate as { passwordGate: unknown }).passwordGate
    : candidate;
  const parsed = RoomPasswordGateSchema.safeParse(source);
  if (!parsed.success) return null;
  return {
    status: parsed.data.status,
    attemptsLeft: parsed.data.attemptsLeft,
    retryAfterSeconds: parsed.data.retryAfterSeconds ?? null,
  };
};

export const roomPasswordGateMessage = (gate: RoomPasswordGate): string => {
  if (gate.status === "invalid_password") return `비밀번호가 맞지 않아요 · 남은 시도 ${gate.attemptsLeft}회`;
  if (gate.status === "locked") return `잠시 후 다시 시도해 주세요 · ${Math.max(1, Math.ceil((gate.retryAfterSeconds ?? 60) / 60))}분`;
  return "방장에게 받은 비밀번호를 입력해 주세요.";
};

export const pendingRoomPasswordKey = (eventId: string, groupNumber: number): string =>
  `${PENDING_PASSWORD_PREFIX}/${eventId}/${groupNumber}`;

/** Keeps a verified password for the next room page in this tab only (never in the URL). */
export const savePendingRoomPassword = (store: KeyValueStore, key: string, password: string): boolean => {
  if (!isValidRoomPassword(password)) return false;
  try {
    store.setItem(key, password);
    return true;
  } catch {
    return false;
  }
};

/** Returns the pending password once and removes it. */
export const takePendingRoomPassword = (store: KeyValueStore, key: string): string | null => {
  try {
    const value = store.getItem(key);
    store.removeItem(key);
    return value !== null && isValidRoomPassword(value) ? value : null;
  } catch {
    return null;
  }
};

export const browserSessionStore = (): KeyValueStore | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
