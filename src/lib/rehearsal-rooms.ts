import { z } from "zod";
import { eventCode } from "./event-config";
import { canCreateRoomName, canJoinInviteRoom, normalizeInviteCode, normalizeRoomName } from "./room-entry";

const rehearsalRoomStorageKey = `say-on/${eventCode}/rehearsal-rooms/v1`;

const RehearsalRoomSchema = z.object({
  groupNumber: z.number().int().min(1).max(32_767),
  roomName: z.string().min(2).max(40),
  inviteCode: z.string().regex(/^[A-F0-9]{8}$/),
  createdAt: z.string().datetime({ offset: true })
});

const RehearsalRoomsSchema = z.object({
  version: z.literal(1),
  rooms: z.array(RehearsalRoomSchema).max(32_767)
});

export type RehearsalRoom = Readonly<z.infer<typeof RehearsalRoomSchema>>;
export type RehearsalRoomStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): RehearsalRoomStorage | null =>
  typeof window === "undefined" ? null : window.localStorage;

const parseRooms = (candidate: unknown): readonly RehearsalRoom[] | null => {
  const parsed = RehearsalRoomsSchema.safeParse(candidate);
  return parsed.success ? parsed.data.rooms : null;
};

export const readRehearsalRooms = (storage: RehearsalRoomStorage | null = browserStorage()): readonly RehearsalRoom[] => {
  if (storage === null) return [];
  const raw = storage.getItem(rehearsalRoomStorageKey);
  if (raw === null) return [];
  try {
    return parseRooms(JSON.parse(raw)) ?? [];
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
};

export const findRehearsalRoom = (inviteCode: string | null, storage: RehearsalRoomStorage | null = browserStorage()): RehearsalRoom | null => {
  if (inviteCode === null) return null;
  const normalizedInviteCode = normalizeInviteCode(inviteCode);
  if (!canJoinInviteRoom(normalizedInviteCode)) return null;
  return readRehearsalRooms(storage).find((room) => room.inviteCode === normalizedInviteCode) ?? null;
};

const inviteCodeForGroup = (groupNumber: number): string => groupNumber.toString(16).padStart(8, "0").toUpperCase();

export const createRehearsalRoom = (roomName: string, storage: RehearsalRoomStorage | null = browserStorage(), now: Date = new Date()): RehearsalRoom | null => {
  const normalizedRoomName = normalizeRoomName(roomName);
  if (storage === null || !canCreateRoomName(normalizedRoomName)) return null;

  const rooms = readRehearsalRooms(storage);
  const usedGroupNumbers = new Set(rooms.map((room) => room.groupNumber));
  let groupNumber = 1;
  while (usedGroupNumbers.has(groupNumber) && groupNumber <= 32_767) groupNumber += 1;
  if (groupNumber > 32_767) return null;

  const room: RehearsalRoom = {
    groupNumber,
    roomName: normalizedRoomName,
    inviteCode: inviteCodeForGroup(groupNumber),
    createdAt: now.toISOString()
  };
  storage.setItem(rehearsalRoomStorageKey, JSON.stringify({ version: 1, rooms: [...rooms, room] }));
  return room;
};
