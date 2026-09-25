import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { clearRehearsalDraws } from "../lib/group-draws";
import { canSetExpectedAttendance, canStartGroup, normalizeHandoffCode, type GroupRoomPhase } from "../lib/group-room";
import { isValidNickname, normalizeNickname } from "../lib/nickname";
import { balanceCatalogId, remoteGameKey, type GameKey } from "../lib/questions";
import { createRehearsalRoom, findRehearsalRoom, readRehearsalRooms } from "../lib/rehearsal-rooms";
import { canCreateRoomName, canJoinInviteRoom, normalizeInviteCode, normalizeRoomName } from "../lib/room-entry";
import { realtimeStatusProblem } from "../lib/realtime-status";
import { supabase } from "../lib/supabase";

const RemoteDisplayNameSchema = z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= 2 && length <= 12;
}, "display name must be between 2 and 12 characters");

const RemoteRoomParticipantSchema = z.object({
  displayName: RemoteDisplayNameSchema,
  isReady: z.boolean(),
  turnPosition: z.number().int().min(0).max(19),
  isSelf: z.boolean()
});

const RemoteRoomSchema = z.object({
  expectedAttendance: z.number().int().min(2).max(20),
  joinedCount: z.number().int().min(0).max(20),
  readyCount: z.number().int().min(0).max(20),
  phase: z.enum(["waiting", "live"]),
  roundNumber: z.number().int().min(1),
  revision: z.number().int().min(0),
  eventMenuRevision: z.number().int().min(0),
  selectedGame: z.enum(["icebreaker", balanceCatalogId]).nullable().transform((value): GameKey | null => value === balanceCatalogId ? "balance" : value),
  isHost: z.boolean(),
  isReady: z.boolean(),
  participantCount: z.number().int().min(1).max(20),
  turnPosition: z.number().int().min(0).max(19),
  displayName: RemoteDisplayNameSchema.nullable().optional(),
  participants: z.array(RemoteRoomParticipantSchema).max(20).optional().default([])
});

const HostTransferSchema = z.object({
  code: z.string().regex(/^[A-F0-9]{8}$/),
  expiresAt: z.string().datetime({ offset: true })
});

const RemoteRoomEntrySchema = z.object({
  groupNumber: z.number().int().min(1).max(32767),
  room: RemoteRoomSchema
});

const RemoteCreatedRoomSchema = z.object({
  groupNumber: z.number().int().min(1).max(32767),
  roomName: z.string().min(2).max(40),
  inviteCode: z.string().regex(/^[A-F0-9]{8}$/)
});

const RemoteLobbyRoomWireSchema = z.object({
  group_number: z.number().int().min(1).max(32767),
  room_name: z.string().min(2).max(40),
  capacity: z.number().int().min(2).max(20),
  joined_count: z.number().int().min(0).max(20),
  phase: z.enum(["waiting", "live"]),
  is_roster_room: z.boolean()
});

const RemoteRoomStatusSchema = z.object({
  group_number: z.number().int().min(1).max(32767),
  phase: z.enum(["waiting", "live"]),
  event_menu_revision: z.number().int().min(0)
});

export type GroupRoom = Readonly<z.infer<typeof RemoteRoomSchema>>;
export type HostTransfer = Readonly<z.infer<typeof HostTransferSchema>>;
export type GroupRoomLobbyEntry = Readonly<{
  groupNumber: number;
  roomName: string;
  capacity: number;
  joinedCount: number;
  phase: "waiting" | "live";
  isRosterRoom: boolean;
}>;
export type CreatedGroupRoom = Readonly<{
  groupNumber: number;
  roomName: string;
  inviteCode: string;
}>;

export const parseGroupRoom = (candidate: unknown): GroupRoom | null => {
  const parsed = RemoteRoomSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

export const parseCreatedGroupRoom = (candidate: unknown): CreatedGroupRoom | null => {
  const parsed = RemoteCreatedRoomSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

export const shouldReleaseRoomMember = (room: GroupRoom | null, status: unknown, groupNumber: number): boolean => {
  const parsed = RemoteRoomStatusSchema.safeParse(status);
  return room !== null
    && parsed.success
    && parsed.data.group_number === groupNumber
    && parsed.data.event_menu_revision > room.eventMenuRevision;
};

type GetGroupRoomReleaseStatus = (params: Readonly<{ p_event_id: string; p_group_number: number }>) => Promise<Readonly<{ data: unknown; error: unknown | null }>>;

export const didRemoteRoomRelease = async (
  getReleaseStatus: GetGroupRoomReleaseStatus,
  room: GroupRoom,
  eventId: string,
  groupNumber: number,
): Promise<boolean> => {
  const result = await getReleaseStatus({ p_event_id: eventId, p_group_number: groupNumber });
  return result.error === null && shouldReleaseRoomMember(room, result.data, groupNumber);
};

export const parseLobbyRooms = (candidate: unknown): readonly GroupRoomLobbyEntry[] | null => {
  const parsed = RemoteLobbyRoomWireSchema.array().safeParse(candidate);
  if (!parsed.success) return null;
  return parsed.data.map((room) => ({
    groupNumber: room.group_number,
    roomName: room.room_name,
    capacity: room.capacity,
    joinedCount: room.joined_count,
    phase: room.phase,
    isRosterRoom: room.is_roster_room
  }));
};

export const visibleLobbyRooms = (rooms: readonly GroupRoomLobbyEntry[]): readonly GroupRoomLobbyEntry[] =>
  rooms.filter((room) => !room.isRosterRoom);

export const shouldJoinRemoteRoom = (inviteCode: string | null, requestedGroupNumber: number | null, displayName: string | null): boolean => {
  const normalizedInviteCode = inviteCode === null ? null : normalizeInviteCode(inviteCode);
  const hasRoomTarget = (normalizedInviteCode !== null && canJoinInviteRoom(normalizedInviteCode)) || requestedGroupNumber !== null;
  return hasRoomTarget && displayName !== null && isValidNickname(normalizeNickname(displayName));
};

export type GroupRoomTransport = Readonly<{
  groupNumber: number | null;
  inviteCode: string | null;
  room: GroupRoom | null;
  isJoining: boolean;
  isWorking: boolean;
  releasedToLobby: boolean;
  problem: string | null;
  transfer: HostTransfer | null;
  setExpectedAttendance: (expectedAttendance: number) => void;
  selectGame: (game: GameKey) => void;
  setReady: (ready: boolean) => void;
  start: () => void;
  returnToGameSelection: () => Promise<boolean>;
  returnToEventMenu: () => Promise<boolean>;
  leaveRoom: () => Promise<boolean>;
  updateDisplayName: (displayName: string) => Promise<boolean>;
  createTransfer: () => void;
  acceptTransfer: (code: string) => void;
  retry: () => void;
}>;

export type GroupRoomEntryTransport = Readonly<{
  rooms: readonly GroupRoomLobbyEntry[];
  isLoadingRooms: boolean;
  createRoom: (roomName: string) => Promise<CreatedGroupRoom | null>;
  isWorking: boolean;
  problem: string | null;
}>;

const initialRehearsalRoom = (): GroupRoom => ({
  expectedAttendance: 2,
  joinedCount: 1,
  readyCount: 0,
  phase: "waiting",
  roundNumber: 1,
  revision: 0,
  eventMenuRevision: 0,
  selectedGame: null,
  isHost: true,
  isReady: false,
  participantCount: 1,
  turnPosition: 0,
  displayName: null,
  participants: []
});

const useRehearsalGroupRoom = (inviteCode: string | null): GroupRoomTransport => {
  const rehearsalRoom = findRehearsalRoom(inviteCode);
  const [room, setRoom] = useState<GroupRoom>(initialRehearsalRoom);
  const [transfer, setTransfer] = useState<HostTransfer | null>(null);
  const [releasedToLobby, setReleasedToLobby] = useState(false);
  const setExpectedAttendance = (expectedAttendance: number): void => setRoom((current) => canSetExpectedAttendance(expectedAttendance, current.joinedCount) ? { ...current, expectedAttendance, revision: current.revision + 1 } : current);
  const selectGame = (selectedGame: GameKey): void => setRoom((current) => current.isHost && current.phase === "waiting" ? { ...current, selectedGame, revision: current.revision + 1 } : current);
  const setReady = (ready: boolean): void => setRoom((current) => ({ ...current, isReady: ready, readyCount: ready ? 1 : 0, revision: current.revision + 1 }));
  const start = (): void => { if (canStartGroup(room)) setRoom((current) => ({ ...current, phase: "live", revision: current.revision + 1 })); };
  const returnToGameSelection = async (): Promise<boolean> => {
    if (!room.isHost || room.phase !== "live") return false;
    clearRehearsalDraws();
    setRoom((current) => ({ ...current, phase: "waiting", roundNumber: 1, selectedGame: null, readyCount: 0, isReady: false, revision: current.revision + 1 }));
    return true;
  };
  const returnToEventMenu = async (): Promise<boolean> => {
    const returned = await returnToGameSelection();
    if (returned) setReleasedToLobby(true);
    return returned;
  };
  const leaveRoom = async (): Promise<boolean> => {
    setReleasedToLobby(true);
    return true;
  };
  const updateDisplayName = async (displayName: string): Promise<boolean> => {
    const normalizedDisplayName = normalizeNickname(displayName);
    if (!isValidNickname(normalizedDisplayName)) return false;
    setRoom((current) => {
      const hasSelfParticipant = current.participants.some((participant) => participant.isSelf);
      return {
        ...current,
        displayName: normalizedDisplayName,
        participants: hasSelfParticipant ? current.participants.map((participant) => participant.isSelf ? { ...participant, displayName: normalizedDisplayName } : participant) : [{ displayName: normalizedDisplayName, isReady: current.isReady, turnPosition: current.turnPosition, isSelf: true }, ...current.participants],
        revision: current.revision + 1
      };
    });
    return true;
  };
  return {
    groupNumber: rehearsalRoom?.groupNumber ?? 1,
    inviteCode: rehearsalRoom?.inviteCode ?? inviteCode,
    room,
    isJoining: false,
    isWorking: false,
    releasedToLobby,
    problem: null,
    transfer,
    setExpectedAttendance,
    selectGame,
    setReady,
    start,
    returnToGameSelection,
    returnToEventMenu,
    leaveRoom,
    updateDisplayName,
    createTransfer: () => setTransfer({ code: "BEEF12A4", expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    acceptTransfer: () => undefined,
    retry: () => undefined
  };
};

const useRemoteGroupRoom = (eventId: string | null, inviteCode: string | null, requestedGroupNumber: number | null, displayName: string | null): GroupRoomTransport | null => {
  const client = supabase;
  const normalizedInviteCode = inviteCode === null ? null : normalizeInviteCode(inviteCode);
  const normalizedDisplayName = displayName === null ? null : normalizeNickname(displayName);
  const canJoinByCode = normalizedInviteCode !== null && canJoinInviteRoom(normalizedInviteCode);
  const canJoinByNumber = requestedGroupNumber !== null;
  const canJoinWithDisplayName = shouldJoinRemoteRoom(inviteCode, requestedGroupNumber, normalizedDisplayName);
  const [room, setRoom] = useState<GroupRoom | null>(null);
  const [groupNumber, setGroupNumber] = useState<number | null>(null);
  const [isJoining, setIsJoining] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [channelProblem, setChannelProblem] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<HostTransfer | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [releasedToLobby, setReleasedToLobby] = useState(false);

  const applyEntry = useCallback((candidate: unknown): boolean => {
    const parsed = RemoteRoomEntrySchema.safeParse(candidate);
    if (!parsed.success) return false;
    setGroupNumber(parsed.data.groupNumber);
    setRoom(parsed.data.room);
    return true;
  }, []);

  const rejoinFreshRoom = useCallback(async (): Promise<void> => {
    if (client === null || eventId === null) return;
    const result = canJoinByCode
      ? await client.rpc("join_group_room_by_code", { p_event_id: eventId, p_invite_code: normalizedInviteCode, p_display_name: normalizedDisplayName })
      : requestedGroupNumber !== null
        ? await client.rpc("join_group_room_by_number", { p_event_id: eventId, p_group_number: requestedGroupNumber, p_display_name: normalizedDisplayName })
        : null;
    if (result === null || result.error !== null || !applyEntry(result.data)) throw new Error("room refresh failed");
  }, [applyEntry, canJoinByCode, client, eventId, normalizedDisplayName, normalizedInviteCode, requestedGroupNumber]);

  const refreshCurrentRoom = useCallback(async (): Promise<void> => {
    if (client === null || eventId === null || groupNumber === null) return;
    const result = await client.rpc("get_my_group_room", { p_event_id: eventId, p_group_number: groupNumber });
    const parsed = parseGroupRoom(result.data);
    if (result.error !== null || parsed === null) throw new Error("room state refresh failed");
    setRoom(parsed);
  }, [client, eventId, groupNumber]);

  const releaseRoomToLobby = useCallback((): void => {
    setReleasedToLobby(true);
    setRoom(null);
  }, []);

  const releaseIfEventMenuIsNewer = useCallback(async (): Promise<boolean> => {
    if (client === null || eventId === null || groupNumber === null || room === null) return false;
    const released = await didRemoteRoomRelease(
      async (params) => client.rpc("get_group_room_release_status", params),
      room,
      eventId,
      groupNumber,
    );
    if (!released) return false;
    releaseRoomToLobby();
    return true;
  }, [client, eventId, groupNumber, releaseRoomToLobby, room]);

  useEffect(() => {
    if (client === null || eventId === null || (!canJoinByCode && !canJoinByNumber)) {
      setRoom(null);
      setGroupNumber(null);
      setIsJoining(false);
      setProblem("방 정보를 확인해 주세요.");
      return undefined;
    }
    if (!canJoinWithDisplayName) {
      setRoom(null);
      setGroupNumber(null);
      setIsJoining(false);
      setProblem(null);
      return undefined;
    }
    let active = true;
    setIsJoining(true);
    setProblem(null);
    setChannelProblem(null);
    setReleasedToLobby(false);
    const join = async (): Promise<void> => {
      try {
        await rejoinFreshRoom();
      } catch {
        if (active) setProblem("방에 들어오지 못했습니다. 다시 확인해 주세요.");
      } finally {
        if (active) setIsJoining(false);
      }
    };
    void join();
    return () => { active = false; };
  }, [canJoinByCode, canJoinByNumber, canJoinWithDisplayName, client, eventId, joinAttempt, rejoinFreshRoom]);

  useEffect(() => {
    if (client === null || eventId === null || groupNumber === null) return undefined;
    let active = true;
    const channel = client
      .channel(`say-on-room-${eventId}-${groupNumber}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "group_room_status", filter: `event_id=eq.${eventId}` }, (payload) => {
        const row = payload.new;
        const status = RemoteRoomStatusSchema.safeParse(row);
        if (status.success && shouldReleaseRoomMember(room, status.data, groupNumber)) {
          releaseRoomToLobby();
          return;
        }
        if (status.success && status.data.group_number === groupNumber) {
          void refreshCurrentRoom().catch(() => { if (active) setProblem("대기방 상태를 새로 불러오지 못했습니다."); });
        }
      })
      .subscribe((status) => { if (active) setChannelProblem(realtimeStatusProblem(status, "대기방")); });
    return () => { active = false; void client.removeChannel(channel); };
  }, [client, eventId, groupNumber, refreshCurrentRoom, releaseRoomToLobby, room]);

  useEffect(() => {
    if (client === null || eventId === null || groupNumber === null || room === null) return undefined;
    let active = true;
    const touch = async (): Promise<void> => {
      if (document.visibilityState !== "visible") return;
      try {
        const result = await client.rpc("touch_group_session_activity", { p_event_id: eventId, p_group_number: groupNumber });
        const parsed = parseGroupRoom(result.data);
        if (!active) return;
        if (result.error === null && parsed !== null) {
          if (shouldReleaseRoomMember(room, {
            group_number: groupNumber,
            phase: parsed.phase,
            event_menu_revision: parsed.eventMenuRevision
          }, groupNumber)) {
            releaseRoomToLobby();
            return;
          }
          setRoom(parsed);
          return;
        }
        if (await releaseIfEventMenuIsNewer()) return;
        await refreshCurrentRoom();
      } catch {
        if (active && !await releaseIfEventMenuIsNewer()) setProblem("연결이 끊겼습니다. 다시 시도해 주세요.");
      }
    };
    const touchWhenVisible = (): void => { if (document.visibilityState === "visible") void touch(); };
    const heartbeatId = window.setInterval(() => { void touch(); }, 60_000);
    document.addEventListener("visibilitychange", touchWhenVisible);
    return () => {
      active = false;
      window.clearInterval(heartbeatId);
      document.removeEventListener("visibilitychange", touchWhenVisible);
    };
  }, [client, eventId, groupNumber, refreshCurrentRoom, releaseIfEventMenuIsNewer, releaseRoomToLobby, room]);

  const invokeRoomAction = useCallback(async (name: string, params: Record<string, string | number | boolean>): Promise<boolean> => {
    if (client === null || eventId === null || isWorking) return false;
    setIsWorking(true);
    setProblem(null);
    try {
      const result = await client.rpc(name, params);
      const parsed = parseGroupRoom(result.data);
      if (result.error === null && parsed !== null) {
        setRoom(parsed);
        return true;
      }
      throw new Error("room action failed");
    } catch {
      setProblem("요청을 처리하지 못했습니다. 다시 시도해 주세요.");
      try { await refreshCurrentRoom(); } catch { undefined; }
      return false;
    } finally {
      setIsWorking(false);
    }
  }, [client, eventId, isWorking, refreshCurrentRoom]);

  const setReady = useCallback((ready: boolean): void => {
    if (eventId !== null && groupNumber !== null) void invokeRoomAction("set_my_group_ready", { p_event_id: eventId, p_group_number: groupNumber, p_is_ready: ready });
  }, [eventId, groupNumber, invokeRoomAction]);
  const setExpectedAttendance = useCallback((expectedAttendance: number): void => {
    if (!canSetExpectedAttendance(expectedAttendance, room?.joinedCount ?? 0)) {
      setProblem("인원은 현재 입장 인원 이상으로 정해 주세요.");
      return;
    }
    if (eventId !== null && groupNumber !== null) void invokeRoomAction("set_group_expected_attendance", { p_event_id: eventId, p_group_number: groupNumber, p_expected_attendance: expectedAttendance });
  }, [eventId, groupNumber, invokeRoomAction, room?.joinedCount]);
  const selectGame = useCallback((game: GameKey): void => {
    if (eventId !== null && groupNumber !== null) void invokeRoomAction("select_group_game", { p_event_id: eventId, p_group_number: groupNumber, p_game_key: remoteGameKey(game) });
  }, [eventId, groupNumber, invokeRoomAction]);
  const start = useCallback((): void => { if (eventId !== null && groupNumber !== null) void invokeRoomAction("start_group_session", { p_event_id: eventId, p_group_number: groupNumber }); }, [eventId, groupNumber, invokeRoomAction]);
  const returnToGameSelection = useCallback(async (): Promise<boolean> => {
    if (eventId === null || groupNumber === null) return false;
    return invokeRoomAction("return_group_to_game_selection", { p_event_id: eventId, p_group_number: groupNumber });
  }, [eventId, groupNumber, invokeRoomAction]);
  const returnToEventMenu = useCallback(async (): Promise<boolean> => {
    if (client === null || eventId === null || groupNumber === null || isWorking) return false;
    setIsWorking(true);
    setProblem(null);
    try {
      const result = await client.rpc("return_group_to_event_menu", { p_event_id: eventId, p_group_number: groupNumber });
      const returnedRoom = parseGroupRoom(result.data);
      if (result.error !== null || returnedRoom === null) throw new Error("event menu return failed");
      setRoom(returnedRoom);
      releaseRoomToLobby();
      return true;
    } catch {
      setProblem("메인 메뉴로 돌아가지 못했습니다. 다시 시도해 주세요.");
      try { await refreshCurrentRoom(); } catch { undefined; }
      return false;
    } finally {
      setIsWorking(false);
    }
  }, [client, eventId, groupNumber, isWorking, refreshCurrentRoom, releaseRoomToLobby]);
  const leaveRoom = useCallback(async (): Promise<boolean> => {
    if (client === null || eventId === null || groupNumber === null || isWorking) return false;
    setIsWorking(true);
    setProblem(null);
    try {
      const result = await client.rpc("leave_group_room", { p_event_id: eventId, p_group_number: groupNumber });
      if (result.error !== null || result.data !== true) throw new Error("room leave failed");
      releaseRoomToLobby();
      return true;
    } catch {
      setProblem("방에서 나가지 못했습니다. 다시 시도해 주세요.");
      try { await refreshCurrentRoom(); } catch { undefined; }
      return false;
    } finally {
      setIsWorking(false);
    }
  }, [client, eventId, groupNumber, isWorking, refreshCurrentRoom, releaseRoomToLobby]);
  const updateDisplayName = useCallback(async (displayName: string): Promise<boolean> => {
    const normalizedDisplayName = normalizeNickname(displayName);
    if (!isValidNickname(normalizedDisplayName) || eventId === null || groupNumber === null) return false;
    return invokeRoomAction("update_my_group_display_name", { p_event_id: eventId, p_group_number: groupNumber, p_display_name: normalizedDisplayName });
  }, [eventId, groupNumber, invokeRoomAction]);
  const createTransfer = useCallback((): void => {
    if (client === null || eventId === null || groupNumber === null || isWorking) return;
    setIsWorking(true);
    const create = async (): Promise<void> => {
      const result = await client.rpc("create_host_transfer", { p_event_id: eventId, p_group_number: groupNumber });
      const parsed = HostTransferSchema.safeParse(result.data);
      if (result.error === null && parsed.success) setTransfer(parsed.data);
      else setProblem("방장 권한 코드를 만들지 못했습니다.");
      setIsWorking(false);
    };
    void create().catch(() => { setProblem("방장 권한 코드를 만들지 못했습니다."); setIsWorking(false); });
  }, [client, eventId, groupNumber, isWorking]);
  const acceptTransfer = useCallback((code: string): void => {
    const normalized = normalizeHandoffCode(code);
    if (eventId !== null && groupNumber !== null && normalized.length === 8) void invokeRoomAction("accept_host_transfer", { p_event_id: eventId, p_group_number: groupNumber, p_code: normalized });
  }, [eventId, groupNumber, invokeRoomAction]);
  const retry = useCallback((): void => { if (!isJoining) setJoinAttempt((attempt) => attempt + 1); }, [isJoining]);

  if (client === null) return null;
  return { groupNumber, inviteCode: normalizedInviteCode, room, isJoining, isWorking, releasedToLobby, problem: problem ?? channelProblem, transfer, setExpectedAttendance, selectGame, setReady, start, returnToGameSelection, returnToEventMenu, leaveRoom, updateDisplayName, createTransfer, acceptTransfer, retry };
};

const useRemoteGroupRoomEntry = (eventId: string | null): GroupRoomEntryTransport | null => {
  const client = supabase;
  const [rooms, setRooms] = useState<readonly GroupRoomLobbyEntry[]>([]);
  const [isLoadingRooms, setIsLoadingRooms] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const loadRooms = useCallback(async (): Promise<readonly GroupRoomLobbyEntry[] | null> => {
    if (client === null || eventId === null) return null;
    const result = await client.rpc("list_group_rooms", { p_event_id: eventId });
    const loadedRooms = parseLobbyRooms(result.data);
    if (result.error !== null || loadedRooms === null) throw new Error("room list failed");
    const visibleRooms = visibleLobbyRooms(loadedRooms);
    setRooms(visibleRooms);
    return visibleRooms;
  }, [client, eventId]);

  useEffect(() => {
    if (client === null || eventId === null) {
      setRooms([]);
      setIsLoadingRooms(false);
      return undefined;
    }
    let active = true;
    setIsLoadingRooms(true);
    const load = async (): Promise<void> => {
      try {
        await loadRooms();
      } catch {
        if (active) setProblem("방 목록을 불러오지 못했습니다.");
      } finally {
        if (active) setIsLoadingRooms(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [client, eventId, loadRooms]);

  const createRoom = useCallback(async (roomName: string): Promise<CreatedGroupRoom | null> => {
    if (isWorking) return null;
    if (client === null || eventId === null) {
      setProblem("연결을 준비하지 못해 방을 만들 수 없어요. 새로고침 후 다시 시도해 주세요.");
      return null;
    }
    const normalizedRoomName = normalizeRoomName(roomName);
    setIsWorking(true);
    setProblem(null);
    try {
      const result = await client.rpc("create_group_room", { p_event_id: eventId, p_room_name: normalizedRoomName, p_expected_attendance: 4 });
      const created = parseCreatedGroupRoom(result.data);
      if (result.error !== null || created === null) throw new Error("room creation failed");
      const createdRoom: GroupRoomLobbyEntry = {
        groupNumber: created.groupNumber,
        roomName: created.roomName,
        capacity: 4,
        joinedCount: 0,
        phase: "waiting",
        isRosterRoom: false
      };
      setRooms((current) => [...current.filter((room) => room.groupNumber !== createdRoom.groupNumber), createdRoom].sort((left, right) => left.groupNumber - right.groupNumber));
      return created;
    } catch {
      setProblem("새 방을 만들지 못했습니다. 이름을 다시 확인해 주세요.");
      return null;
    } finally {
      setIsWorking(false);
    }
  }, [client, eventId, isWorking]);

  if (client === null) return null;
  return { rooms, isLoadingRooms, createRoom, isWorking, problem };
};

const useRehearsalGroupRoomEntry = (): GroupRoomEntryTransport => {
  const [rooms, setRooms] = useState<readonly GroupRoomLobbyEntry[]>(() => readRehearsalRooms().map((room) => ({
    groupNumber: room.groupNumber,
    roomName: room.roomName,
    capacity: 4,
    joinedCount: 0,
    phase: "waiting",
    isRosterRoom: false
  })));
  const [isWorking, setIsWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const createRoom = useCallback(async (roomName: string): Promise<CreatedGroupRoom | null> => {
    if (isWorking) return null;
    const normalizedRoomName = normalizeRoomName(roomName);
    if (!canCreateRoomName(normalizedRoomName)) {
      setProblem("방 이름을 2자에서 40자로 입력해 주세요.");
      return null;
    }
    setIsWorking(true);
    setProblem(null);
    try {
      const created = createRehearsalRoom(normalizedRoomName);
      if (created === null) throw new Error("rehearsal room creation failed");
      const createdRoom: GroupRoomLobbyEntry = {
        groupNumber: created.groupNumber,
        roomName: created.roomName,
        capacity: 4,
        joinedCount: 0,
        phase: "waiting",
        isRosterRoom: false
      };
      setRooms((current) => [...current.filter((room) => room.groupNumber !== createdRoom.groupNumber), createdRoom].sort((left, right) => left.groupNumber - right.groupNumber));
      return created;
    } catch {
      setProblem("새 방을 만들지 못했습니다. 이름을 다시 확인해 주세요.");
      return null;
    } finally {
      setIsWorking(false);
    }
  }, [isWorking]);
  return { rooms, isLoadingRooms: false, createRoom, isWorking, problem };
};

export const useGroupRoomEntry = (eventId: string | null): GroupRoomEntryTransport => {
  const remote = useRemoteGroupRoomEntry(eventId);
  const rehearsal = useRehearsalGroupRoomEntry();
  return remote ?? rehearsal;
};

export const useGroupRoom = (eventId: string | null, inviteCode: string | null, requestedGroupNumber: number | null = null, displayName: string | null = null): GroupRoomTransport => {
  const remote = useRemoteGroupRoom(eventId, inviteCode, requestedGroupNumber, displayName);
  const rehearsal = useRehearsalGroupRoom(inviteCode);
  return remote ?? rehearsal;
};

export const groupRoomPhase = (room: GroupRoom | null): GroupRoomPhase => room?.phase ?? "waiting";
