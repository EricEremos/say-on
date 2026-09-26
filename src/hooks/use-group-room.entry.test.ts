import { describe, expect, it } from "vitest";
import { parseCreatedGroupRoom, parseGroupRoom, parseLobbyRooms, shouldJoinRemoteRoom, shouldReleaseRoomMember, type GroupRoom, visibleLobbyRooms } from "./use-group-room";

const liveGuest: GroupRoom = {
  expectedAttendance: 4,
  joinedCount: 4,
  readyCount: 4,
  phase: "live",
  roundNumber: 1,
  revision: 3,
  eventMenuRevision: 3,
  selectedGame: "icebreaker",
  isHost: false,
  isReady: true,
  participantCount: 4,
  turnPosition: 1,
  participants: []
};

describe("group room lobby transport", () => {
  it("maps the launch catalog to Balance and rejects legacy or unknown catalogs", () => {
    expect(parseGroupRoom({ ...liveGuest, selectedGame: "balance-ko-2026-10" })?.selectedGame).toBe("balance");
    expect(parseGroupRoom({ ...liveGuest, selectedGame: "balance" })).toBeNull();
    expect(parseGroupRoom({ ...liveGuest, selectedGame: "balance-ko-future" })).toBeNull();
    expect(parseGroupRoom({ ...liveGuest, selectedGame: null })?.selectedGame).toBeNull();
  });

  it("does not attempt the authenticated room join until a valid participant name is present", () => {
    expect(shouldJoinRemoteRoom(null, 14, null)).toBe(false);
    expect(shouldJoinRemoteRoom(null, 14, "한")).toBe(false);
    expect(shouldJoinRemoteRoom(null, 14, " QA 호스트 ")).toBe(true);
    expect(shouldJoinRemoteRoom("86f5e1bc", null, "바다")).toBe(true);
    expect(shouldJoinRemoteRoom(null, null, "바다")).toBe(false);
  });

  it("maps Supabase's snake_case room list into the UI's room model", () => {
    expect(parseLobbyRooms([{
      group_number: 7,
      room_name: "기존 행사 방",
      capacity: 8,
      joined_count: 0,
      phase: "waiting",
      is_roster_room: true
    }])).toEqual([{
      groupNumber: 7,
      roomName: "기존 행사 방",
      capacity: 8,
      joinedCount: 0,
      phase: "waiting",
      isRosterRoom: true,
      hasPassword: false
    }]);
  });

  it("reads each room's lock and accepts finished rooms, so one of them cannot empty the list", () => {
    expect(parseLobbyRooms([
      { group_number: 21, room_name: "우리 팀 회식", capacity: 4, joined_count: 2, phase: "waiting", is_roster_room: false, has_password: true },
      { group_number: 22, room_name: "생일 파티", capacity: 8, joined_count: 4, phase: "complete", is_roster_room: false, has_password: false }
    ])?.map((room) => [room.groupNumber, room.phase, room.hasPassword])).toEqual([[21, "waiting", true], [22, "complete", false]]);
  });

  it("keeps retired roster rooms out of the fresh-room lobby", () => {
    const rooms = parseLobbyRooms([
      { group_number: 7, room_name: "기존 행사 방", capacity: 8, joined_count: 0, phase: "waiting", is_roster_room: true },
      { group_number: 13, room_name: "새 모임", capacity: 4, joined_count: 1, phase: "waiting", is_roster_room: false }
    ]);

    expect(rooms).not.toBeNull();
    expect(visibleLobbyRooms(rooms ?? [])).toEqual([{
      groupNumber: 13,
      roomName: "새 모임",
      capacity: 4,
      joinedCount: 1,
      phase: "waiting",
      isRosterRoom: false,
      hasPassword: false
    }]);
  });

  it("accepts the production custom-room creation payload without requiring a nested room snapshot", () => {
    expect(parseCreatedGroupRoom({
      groupNumber: 13,
      roomName: "Release QA Balance",
      inviteCode: "A1B2C3D4"
    })).toEqual({
      groupNumber: 13,
      roomName: "Release QA Balance",
      inviteCode: "A1B2C3D4"
    });
  });

  it("releases every member only for a newer explicit event-menu return", () => {
    expect(shouldReleaseRoomMember(liveGuest, { group_number: 7, phase: "waiting", event_menu_revision: 3 }, 7)).toBe(false);
    expect(shouldReleaseRoomMember(liveGuest, { group_number: 7, phase: "waiting", event_menu_revision: 4 }, 7)).toBe(true);
    expect(shouldReleaseRoomMember({ ...liveGuest, isHost: true }, { group_number: 7, phase: "waiting", event_menu_revision: 4 }, 7)).toBe(true);
    expect(shouldReleaseRoomMember(liveGuest, { group_number: 8, phase: "waiting", event_menu_revision: 4 }, 7)).toBe(false);
  });

  it("accepts display names using the database's Unicode character length", () => {
    const sevenEmojiName = "😀😀😀😀😀😀😀";

    expect(parseGroupRoom({ ...liveGuest, displayName: sevenEmojiName, participants: [{ displayName: sevenEmojiName, isReady: true, turnPosition: 1, isSelf: true }] })).toMatchObject({ displayName: sevenEmojiName });
  });
});
