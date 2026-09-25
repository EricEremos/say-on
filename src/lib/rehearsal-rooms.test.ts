import { describe, expect, it } from "vitest";
import { createRehearsalRoom, findRehearsalRoom, readRehearsalRooms, type RehearsalRoomStorage } from "./rehearsal-rooms";

const memoryStorage = (): RehearsalRoomStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }
  };
};

describe("rehearsal room entry", () => {
  it("persists normalized rooms with a distinct valid invite code for each local group", () => {
    const storage = memoryStorage();
    const first = createRehearsalRoom("  점심   산책  ", storage, new Date("2026-09-14T05:00:00.000Z"));
    const second = createRehearsalRoom("저녁 모임", storage, new Date("2026-09-14T05:01:00.000Z"));

    expect(first).toMatchObject({ groupNumber: 1, roomName: "점심 산책", inviteCode: "00000001" });
    expect(second).toMatchObject({ groupNumber: 2, roomName: "저녁 모임", inviteCode: "00000002" });
    expect(readRehearsalRooms(storage)).toHaveLength(2);
    expect(findRehearsalRoom("0000-0002", storage)).toEqual(second);
  });

  it("does not create malformed room names or trust corrupt stored data", () => {
    const storage = memoryStorage();
    expect(createRehearsalRoom("한", storage)).toBeNull();
    expect(readRehearsalRooms({ getItem: () => "not json", setItem: () => undefined })).toEqual([]);
  });
});
