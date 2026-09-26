import { useCallback, useEffect, useRef, useState } from "react";
import { createRehearsalRoom, readRehearsalRooms } from "../lib/rehearsal-rooms";
import { canCreateRoomName, normalizeRoomName } from "../lib/room-entry";
import { LOBBY_REFRESH_MS } from "../lib/room-lobby";
import { isValidRoomPassword, parseRoomPasswordGate } from "../lib/room-password";
import { supabase } from "../lib/supabase";
import {
  parseCreatedGroupRoom,
  parseLobbyRooms,
  visibleLobbyRooms,
  type CreatedGroupRoom,
  type GroupRoomEntryTransport,
  type GroupRoomLobbyEntry,
  type RoomPasswordCheck,
} from "./use-group-room";

const DEFAULT_EXPECTED_ATTENDANCE = 4;
const LIST_PROBLEM = "방 목록을 불러오지 못했어요";

const insertCreatedRoom = (
  rooms: readonly GroupRoomLobbyEntry[],
  created: CreatedGroupRoom,
  hasPassword: boolean,
): readonly GroupRoomLobbyEntry[] => {
  const createdRoom: GroupRoomLobbyEntry = {
    groupNumber: created.groupNumber,
    roomName: created.roomName,
    capacity: DEFAULT_EXPECTED_ATTENDANCE,
    joinedCount: 0,
    phase: "waiting",
    isRosterRoom: false,
    hasPassword,
  };
  return [...rooms.filter((room) => room.groupNumber !== createdRoom.groupNumber), createdRoom]
    .sort((left, right) => left.groupNumber - right.groupNumber);
};

const isPageVisible = (): boolean => typeof document === "undefined" || document.visibilityState === "visible";

const useRemoteGroupRoomEntry = (eventId: string | null): GroupRoomEntryTransport | null => {
  const client = supabase;
  const [rooms, setRooms] = useState<readonly GroupRoomLobbyEntry[]>([]);
  const [isLoadingRooms, setIsLoadingRooms] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const isRefreshing = useRef(false);

  const loadRooms = useCallback(async (): Promise<void> => {
    if (client === null || eventId === null || isRefreshing.current) return;
    isRefreshing.current = true;
    try {
      const result = await client.rpc("list_group_rooms", { p_event_id: eventId });
      const loadedRooms = parseLobbyRooms(result.data);
      if (result.error !== null || loadedRooms === null) throw new Error("room list failed");
      setRooms(visibleLobbyRooms(loadedRooms));
      setListProblem(null);
    } catch {
      setListProblem(LIST_PROBLEM);
    } finally {
      isRefreshing.current = false;
      setIsLoadingRooms(false);
    }
  }, [client, eventId]);

  // Refresh every LOBBY_REFRESH_MS while the page is visible, and at once when it becomes visible.
  useEffect(() => {
    if (client === null || eventId === null) {
      setRooms([]);
      setIsLoadingRooms(false);
      return undefined;
    }
    void loadRooms();
    const timer = window.setInterval(() => { if (isPageVisible()) void loadRooms(); }, LOBBY_REFRESH_MS);
    const onVisible = (): void => { if (isPageVisible()) void loadRooms(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, eventId, loadRooms, refreshRequest]);

  const refreshRooms = useCallback((): void => { setRefreshRequest((request) => request + 1); }, []);

  const createRoom = useCallback(async (roomName: string, password: string | null = null): Promise<CreatedGroupRoom | null> => {
    if (isWorking) return null;
    if (client === null || eventId === null) {
      setProblem("연결을 준비하지 못해 방을 만들 수 없어요. 새로고침 후 다시 시도해 주세요.");
      return null;
    }
    if (password !== null && !isValidRoomPassword(password)) {
      setProblem("비밀번호는 숫자 4~12자로 정해 주세요.");
      return null;
    }
    setIsWorking(true);
    setProblem(null);
    try {
      const params = { p_event_id: eventId, p_room_name: normalizeRoomName(roomName), p_expected_attendance: DEFAULT_EXPECTED_ATTENDANCE, ...(password === null ? {} : { p_password: password }) };
      const result = await client.rpc("create_group_room", params);
      const created = parseCreatedGroupRoom(result.data);
      if (result.error !== null || created === null) throw new Error("room creation failed");
      setRooms((current) => insertCreatedRoom(current, created, password !== null));
      return created;
    } catch {
      setProblem("새 방을 만들지 못했습니다. 이름을 다시 확인해 주세요.");
      return null;
    } finally {
      setIsWorking(false);
    }
  }, [client, eventId, isWorking]);

  const verifyRoomPassword = useCallback(async (groupNumber: number, password: string): Promise<RoomPasswordCheck> => {
    if (client === null || eventId === null) return null;
    const result = await client.rpc("verify_group_room_password", { p_event_id: eventId, p_group_number: groupNumber, p_password: password });
    if (result.error !== null) return null;
    const gate = parseRoomPasswordGate(result.data);
    if (gate !== null) return gate;
    return (result.data as { status?: unknown } | null)?.status === "ok" ? "ok" : null;
  }, [client, eventId]);

  if (client === null) return null;
  return { rooms, isLoadingRooms, createRoom, isWorking, problem, listProblem, refreshRooms, verifyRoomPassword, supportsPasswords: true };
};

const readRehearsalLobbyRooms = (): readonly GroupRoomLobbyEntry[] => readRehearsalRooms().map((room) => ({
  groupNumber: room.groupNumber,
  roomName: room.roomName,
  capacity: DEFAULT_EXPECTED_ATTENDANCE,
  joinedCount: 0,
  phase: "waiting",
  isRosterRoom: false,
  hasPassword: false,
}));

const useRehearsalGroupRoomEntry = (): GroupRoomEntryTransport => {
  const [rooms, setRooms] = useState<readonly GroupRoomLobbyEntry[]>(readRehearsalLobbyRooms);
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
      setRooms((current) => insertCreatedRoom(current, created, false));
      return created;
    } catch {
      setProblem("새 방을 만들지 못했습니다. 이름을 다시 확인해 주세요.");
      return null;
    } finally {
      setIsWorking(false);
    }
  }, [isWorking]);
  const refreshRooms = useCallback((): void => { setRooms(readRehearsalLobbyRooms()); }, []);
  const verifyRoomPassword = useCallback(async (): Promise<RoomPasswordCheck> => "ok", []);
  return { rooms, isLoadingRooms: false, createRoom, isWorking, problem, listProblem: null, refreshRooms, verifyRoomPassword, supportsPasswords: false };
};

export const useGroupRoomEntry = (eventId: string | null): GroupRoomEntryTransport => {
  const remote = useRemoteGroupRoomEntry(eventId);
  const rehearsal = useRehearsalGroupRoomEntry();
  return remote ?? rehearsal;
};
