import { describe, expect, it } from "vitest";
import {
  isValidRoomPassword,
  normalizeRoomPasswordInput,
  parseRoomPasswordGate,
  pendingRoomPasswordKey,
  roomPasswordGateMessage,
  savePendingRoomPassword,
  takePendingRoomPassword,
} from "./room-password";

const memoryStore = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    size: () => values.size,
  };
};

describe("room passwords", () => {
  it("accepts only 4 to 12 digits, matching the server rule", () => {
    expect(isValidRoomPassword("4821")).toBe(true);
    expect(isValidRoomPassword("123456789012")).toBe(true);
    expect(isValidRoomPassword("123")).toBe(false);
    expect(isValidRoomPassword("1234567890123")).toBe(false);
    expect(isValidRoomPassword("12a4")).toBe(false);
    expect(isValidRoomPassword("")).toBe(false);
  });

  it("keeps typed input to digits and at most 12 characters", () => {
    expect(normalizeRoomPasswordInput(" 48-21 ")).toBe("4821");
    expect(normalizeRoomPasswordInput("12345678901234")).toBe("123456789012");
    expect(normalizeRoomPasswordInput("abc")).toBe("");
  });

  it("reads the server's password gate and ignores ordinary room entries", () => {
    expect(parseRoomPasswordGate({ groupNumber: 3, passwordGate: { status: "invalid_password", attemptsLeft: 4 } }))
      .toEqual({ status: "invalid_password", attemptsLeft: 4, retryAfterSeconds: null });
    expect(parseRoomPasswordGate({ groupNumber: 3, passwordGate: { status: "locked", attemptsLeft: 0, retryAfterSeconds: 42 } }))
      .toEqual({ status: "locked", attemptsLeft: 0, retryAfterSeconds: 42 });
    expect(parseRoomPasswordGate({ status: "password_required", attemptsLeft: 5 }))
      .toEqual({ status: "password_required", attemptsLeft: 5, retryAfterSeconds: null });
    expect(parseRoomPasswordGate({ groupNumber: 3, room: {} })).toBeNull();
    expect(parseRoomPasswordGate({ status: "ok" })).toBeNull();
    expect(parseRoomPasswordGate(null)).toBeNull();
  });

  it("words each gate the way the approved board does", () => {
    expect(roomPasswordGateMessage({ status: "password_required", attemptsLeft: 5, retryAfterSeconds: null })).toBe("방장에게 받은 비밀번호를 입력해 주세요.");
    expect(roomPasswordGateMessage({ status: "invalid_password", attemptsLeft: 4, retryAfterSeconds: null })).toBe("비밀번호가 맞지 않아요 · 남은 시도 4회");
    expect(roomPasswordGateMessage({ status: "locked", attemptsLeft: 0, retryAfterSeconds: 42 })).toBe("잠시 후 다시 시도해 주세요 · 1분");
    expect(roomPasswordGateMessage({ status: "locked", attemptsLeft: 0, retryAfterSeconds: 95 })).toBe("잠시 후 다시 시도해 주세요 · 2분");
  });

  it("hands a verified password to the room page once, per room, then forgets it", () => {
    const store = memoryStore();
    const key = pendingRoomPasswordKey("event-1", 7);
    expect(key).toBe("say-on/room-password/event-1/7");
    expect(savePendingRoomPassword(store, key, "4821")).toBe(true);
    expect(takePendingRoomPassword(store, key)).toBe("4821");
    expect(takePendingRoomPassword(store, key)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("never stores or returns a malformed password, and survives a broken store", () => {
    const store = memoryStore();
    const key = pendingRoomPasswordKey("event-1", 7);
    expect(savePendingRoomPassword(store, key, "12")).toBe(false);
    store.setItem(key, "not-a-pin");
    expect(takePendingRoomPassword(store, key)).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(savePendingRoomPassword(broken, key, "4821")).toBe(false);
    expect(takePendingRoomPassword(broken, key)).toBeNull();
  });
});
