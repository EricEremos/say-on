import { describe, expect, it } from "vitest";
import { canCreateRoomName, canJoinInviteRoom, groupRoomPath, inviteRoomPath, normalizeInviteCode, normalizeRoomName, parseRoomGroupNumber, roomGroupNumberFromSearchParams } from "./room-entry";

describe("invite room entry", () => {
  it("turns a pasted invite code into the stable room URL", () => {
    expect(normalizeInviteCode(" beef-12 a4 ")).toBe("BEEF12A4");
    expect(canJoinInviteRoom("beef-12 a4")).toBe(true);
    expect(inviteRoomPath(" beef-12 a4 ")).toBe("/room?code=BEEF12A4");
  });

  it("rejects a code that cannot identify a room", () => {
    expect(normalizeInviteCode("beef-12")).toBe("BEEF12");
    expect(canJoinInviteRoom("beef-12")).toBe(false);
    expect(inviteRoomPath("beef-12")).toBeNull();
  });

  it("normalizes a named room and creates a stable direct-entry path", () => {
    expect(normalizeRoomName("  우리   방  ")).toBe("우리 방");
    expect(canCreateRoomName("우리 방")).toBe(true);
    expect(canCreateRoomName("방")).toBe(false);
    expect(groupRoomPath(12)).toBe("/room?group=12");
    expect(parseRoomGroupNumber("12")).toBe(12);
    expect(parseRoomGroupNumber("12.0")).toBeNull();
    expect(parseRoomGroupNumber("0")).toBeNull();
  });

  it("accepts both the current and legacy group-link query keys", () => {
    expect(roomGroupNumberFromSearchParams(new URLSearchParams("group=12"))).toBe(12);
    expect(roomGroupNumberFromSearchParams(new URLSearchParams("sun=7"))).toBe(7);
    expect(roomGroupNumberFromSearchParams(new URLSearchParams("sun=0"))).toBeNull();
  });
});
