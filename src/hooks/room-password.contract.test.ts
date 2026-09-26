import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import sheetSource from "../components/BottomSheet.tsx?raw";
import roomSource from "./use-group-room.ts?raw";

const body = (source: string, marker: string, length = 1400): string => {
  const start = source.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  return source.slice(start, start + length);
};

// 2026-09-26 client review: a late password response could overwrite a newer join, and a stale
// gate could hide the "returning to the menu" screen after the host released the room.
describe("room password state stays current", () => {
  it("ignores a join response that a newer join has superseded", () => {
    const join = body(roomSource, "const rejoinFreshRoom = useCallback(");
    expect(join).toContain("joinSequence.current += 1");
    expect(join).toMatch(/if \(sequence !== joinSequence\.current\) return;/);
    expect(join.indexOf("sequence !== joinSequence.current")).toBeLessThan(join.indexOf("setPasswordGate(gate)"));
  });

  it("clears the password gate when the room is released to the lobby", () => {
    expect(body(roomSource, "const releaseRoomToLobby = useCallback(", 240)).toContain("setPasswordGate(null)");
  });

  it("shows the release screen before any password gate", () => {
    const render = body(appSource, "!hasValidRoomTarget ? <section className=\"connection-card\"><h1>방 정보를 확인해 주세요.", 4000);
    expect(render.indexOf("roomState.releasedToLobby ?")).toBeGreaterThan(-1);
    expect(render.indexOf("roomState.releasedToLobby ?")).toBeLessThan(render.indexOf("<RoomPasswordGateCard"));
  });

  it("returns focus to the sheet's opener only while it is still on the page", () => {
    expect(sheetSource).toMatch(/document\.body\.contains\(opener\)/);
  });
});
