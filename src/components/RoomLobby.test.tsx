import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GroupRoomLobbyEntry } from "../hooks/use-group-room";
import { LobbyRoomList } from "./RoomLobby";
import { RoomPasswordGateNotice } from "./RoomPasswordForm";

const room = (overrides: Partial<GroupRoomLobbyEntry>): GroupRoomLobbyEntry => ({
  groupNumber: 1,
  roomName: "금요일 저녁 모임",
  capacity: 6,
  joinedCount: 3,
  phase: "waiting",
  isRosterRoom: false,
  hasPassword: false,
  ...overrides,
});

const noop = () => undefined;
const render = (props: Partial<Parameters<typeof LobbyRoomList>[0]>) => renderToStaticMarkup(
  <LobbyRoomList rooms={[]} isLoading={false} listProblem={null} disabled={false} onEnter={noop} onCreate={noop} onRetry={noop} {...props} />,
);

describe("lobby room list (approved board, 2026-09-26)", () => {
  it("shows the board's loading state", () => {
    const markup = render({ isLoading: true });
    expect(markup).toContain("불러오는 중");
    expect(markup).toContain('aria-busy="true"');
  });

  it("invites the first room when the list is empty", () => {
    const markup = render({});
    expect(markup).toContain("아직 열린 방이 없어요.");
    expect(markup).toContain("첫 방을 만들어 보세요.");
    expect(markup).toContain("방 만들기");
  });

  it("keeps a retry next to the error when the list cannot load", () => {
    const markup = render({ listProblem: "방 목록을 불러오지 못했어요" });
    expect(markup).toContain("방 목록을 불러오지 못했어요");
    expect(markup).toContain("다시 시도");
    expect(markup).not.toContain("아직 열린 방이 없어요.");
  });

  it("lists joinable rooms first, marks locks, and disables full and playing rooms", () => {
    const markup = render({ rooms: [
      room({ groupNumber: 1, roomName: "생일 파티", capacity: 8, joinedCount: 4, phase: "live" }),
      room({ groupNumber: 2, roomName: "주말 캠핑 이야기", capacity: 5, joinedCount: 5 }),
      room({ groupNumber: 3, roomName: "우리 팀 회식", capacity: 4, joinedCount: 2, hasPassword: true }),
      room({ groupNumber: 4, roomName: "금요일 저녁 모임" }),
    ] });
    const order = ["금요일 저녁 모임", "우리 팀 회식", "주말 캠핑 이야기", "생일 파티"].map((name) => markup.indexOf(`<strong>${name}</strong>`));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(markup).toContain("비밀번호 필요");
    expect(markup).toContain("say-lock-icon");
    expect(markup).toContain("대기 중");
    expect(markup).toContain("가득 참");
    expect(markup).toContain("진행 중");
    expect(markup.match(/<button class="say-lobby-room say-lobby-room--(full|playing)"[^>]*disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="우리 팀 회식, 2 / 4명, 대기 중, 비밀번호 필요"');
  });
});

describe("room password notices", () => {
  it("shows a terracotta error for a wrong password and a muted wait for a pause", () => {
    const wrong = renderToStaticMarkup(<RoomPasswordGateNotice id="x" gate={{ status: "invalid_password", attemptsLeft: 4, retryAfterSeconds: null }} />);
    const pause = renderToStaticMarkup(<RoomPasswordGateNotice id="x" gate={{ status: "locked", attemptsLeft: 0, retryAfterSeconds: 60 }} />);
    expect(wrong).toContain("say-gate--error");
    expect(wrong).toContain("비밀번호가 맞지 않아요 · 남은 시도 4회");
    expect(pause).toContain("say-gate--wait");
    expect(pause).toContain("잠시 후 다시 시도해 주세요 · 1분");
    expect(renderToStaticMarkup(<RoomPasswordGateNotice id="x" gate={{ status: "password_required", attemptsLeft: 5, retryAfterSeconds: null }} />)).toBe("");
  });
});
