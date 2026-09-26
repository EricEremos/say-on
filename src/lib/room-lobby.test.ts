import { describe, expect, it } from "vitest";
import { LOBBY_REFRESH_MS, lobbyRoomAvailability, lobbyRoomStatusLabel, sortLobbyRooms } from "./room-lobby";

const room = (overrides: Partial<Parameters<typeof lobbyRoomAvailability>[0]> = {}) => ({
  groupNumber: 1,
  roomName: "금요일 저녁 모임",
  capacity: 6,
  joinedCount: 3,
  phase: "waiting" as const,
  isRosterRoom: false,
  hasPassword: false,
  ...overrides,
});

describe("room lobby", () => {
  it("refreshes every five seconds, as the approved board states", () => {
    expect(LOBBY_REFRESH_MS).toBe(5_000);
  });

  it("marks waiting rooms with space as open, full rooms as full, and started rooms as playing", () => {
    expect(lobbyRoomAvailability(room())).toBe("open");
    expect(lobbyRoomAvailability(room({ joinedCount: 6 }))).toBe("full");
    expect(lobbyRoomAvailability(room({ phase: "live" }))).toBe("playing");
    expect(lobbyRoomAvailability(room({ phase: "complete" }))).toBe("playing");
  });

  it("labels each availability with the board's chip text", () => {
    expect(lobbyRoomStatusLabel("open")).toBe("대기 중");
    expect(lobbyRoomStatusLabel("full")).toBe("가득 참");
    expect(lobbyRoomStatusLabel("playing")).toBe("진행 중");
  });

  it("lists joinable rooms first, newest first within each group, without mutating the input", () => {
    const rooms = [
      room({ groupNumber: 1, phase: "live" }),
      room({ groupNumber: 2 }),
      room({ groupNumber: 3, joinedCount: 6 }),
      room({ groupNumber: 4 }),
    ];
    const sorted = sortLobbyRooms(rooms);
    expect(sorted.map((entry) => entry.groupNumber)).toEqual([4, 2, 3, 1]);
    expect(rooms.map((entry) => entry.groupNumber)).toEqual([1, 2, 3, 4]);
  });
});
