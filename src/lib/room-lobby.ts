/** Lobby rules from the approved board (docs/wireframes/2026-09-26-say-on-lobby-password-v1.png). */
export const LOBBY_REFRESH_MS = 5_000;

export type LobbyRoom = Readonly<{
  groupNumber: number;
  roomName: string;
  capacity: number;
  joinedCount: number;
  phase: "waiting" | "live" | "complete";
  isRosterRoom: boolean;
  hasPassword: boolean;
}>;

export type LobbyRoomAvailability = "open" | "full" | "playing";

export const lobbyRoomAvailability = (room: LobbyRoom): LobbyRoomAvailability => {
  if (room.phase !== "waiting") return "playing";
  return room.joinedCount >= room.capacity ? "full" : "open";
};

const STATUS_LABELS: Readonly<Record<LobbyRoomAvailability, string>> = {
  open: "대기 중",
  full: "가득 참",
  playing: "진행 중",
};

export const lobbyRoomStatusLabel = (availability: LobbyRoomAvailability): string => STATUS_LABELS[availability];

const AVAILABILITY_ORDER: Readonly<Record<LobbyRoomAvailability, number>> = { open: 0, full: 1, playing: 2 };

/** Joinable rooms first, then full, then playing; newest first within each group. */
export const sortLobbyRooms = <Room extends LobbyRoom>(rooms: readonly Room[]): readonly Room[] =>
  [...rooms].sort((left, right) =>
    AVAILABILITY_ORDER[lobbyRoomAvailability(left)] - AVAILABILITY_ORDER[lobbyRoomAvailability(right)]
    || right.groupNumber - left.groupNumber);
