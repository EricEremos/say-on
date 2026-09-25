import { describe, expect, it, vi } from "vitest";
import { didRemoteRoomRelease, shouldReleaseRoomMember, type GroupRoom } from "./use-group-room";
import source from "./use-group-room.ts?raw";

describe("group-room visible-tab heartbeat", () => {
  const liveRoom = (isHost: boolean): GroupRoom => ({
    expectedAttendance: 2,
    joinedCount: 2,
    readyCount: 2,
    phase: "live",
    roundNumber: 1,
    revision: 8,
    eventMenuRevision: 8,
    selectedGame: "balance",
    isHost,
    isReady: true,
    participantCount: 2,
    turnPosition: 0,
    participants: []
  });

  it("returns every room member to the menu only when the host issues an event-menu return", () => {
    const gameSelectionStatus = { group_number: 7, phase: "waiting", event_menu_revision: 8 };
    const eventMenuStatus = { group_number: 7, phase: "waiting", event_menu_revision: 9 };

    expect(shouldReleaseRoomMember(liveRoom(true), gameSelectionStatus, 7)).toBe(false);
    expect(shouldReleaseRoomMember(liveRoom(false), gameSelectionStatus, 7)).toBe(false);
    expect(shouldReleaseRoomMember(liveRoom(false), eventMenuStatus, 7)).toBe(true);
    expect(shouldReleaseRoomMember(liveRoom(false), { group_number: 8, phase: "waiting", event_menu_revision: 9 }, 7)).toBe(false);
  });

  it("recovers a member who missed Realtime by querying the release revision", async () => {
    const getReleaseStatus = vi.fn().mockResolvedValue({
      data: { group_number: 7, phase: "waiting", event_menu_revision: 9 },
      error: null
    });

    await expect(didRemoteRoomRelease(getReleaseStatus, liveRoom(false), "event-1", 7)).resolves.toBe(true);
    expect(getReleaseStatus).toHaveBeenCalledOnce();
    expect(getReleaseStatus).toHaveBeenCalledWith({ p_event_id: "event-1", p_group_number: 7 });
  });

  it("keeps a member in the room when release recovery is stale, malformed, or unavailable", async () => {
    const staleStatus = vi.fn().mockResolvedValue({
      data: { group_number: 7, phase: "waiting", event_menu_revision: 8 },
      error: null
    });
    const malformedStatus = vi.fn().mockResolvedValue({ data: { unexpected: true }, error: null });
    const failedStatus = vi.fn().mockResolvedValue({ data: null, error: new Error("offline") });

    await expect(didRemoteRoomRelease(staleStatus, liveRoom(false), "event-1", 7)).resolves.toBe(false);
    await expect(didRemoteRoomRelease(malformedStatus, liveRoom(false), "event-1", 7)).resolves.toBe(false);
    await expect(didRemoteRoomRelease(failedStatus, liveRoom(false), "event-1", 7)).resolves.toBe(false);
  });

  it("lets the host release every member server-side and recovers an offline member to the event menu", () => {
    expect(source).toContain('client.rpc("touch_group_session_activity"');
    expect(source).not.toContain('client.rpc("leave_finished_group_session"');
    expect(source).not.toContain("leave_group_after_event_menu");
    expect(source).toContain('client.rpc("get_group_room_release_status"');
    expect(source).toContain("releaseRoomToLobby();");
    expect(source).toContain('document.visibilityState !== "visible"');
    expect(source).toContain('document.addEventListener("visibilitychange", touchWhenVisible)');
    expect(source).toContain("window.setInterval(() => { void touch(); }, 60_000)");
    expect(source).toContain("refreshCurrentRoom()");
    expect(source).toContain("setReleasedToLobby(true)");
    expect(source).toContain("event_menu_revision");
    expect(source).toContain("eventMenuRevision");
  });
});
