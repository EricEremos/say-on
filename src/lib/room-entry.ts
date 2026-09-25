const inviteCodePattern = /^[A-F0-9]{8}$/;
const groupNumberPattern = /^[1-9][0-9]{0,4}$/;
const maximumGroupNumber = 32_767;
const minimumRoomNameLength = 2;
const maximumRoomNameLength = 40;

export const normalizeInviteCode = (value: string): string =>
  value.normalize("NFKD").toUpperCase().replaceAll(/[^A-Z0-9]/g, "").slice(0, 8);

export const canJoinInviteRoom = (value: string): boolean => inviteCodePattern.test(normalizeInviteCode(value));

export const inviteRoomPath = (value: string): string | null => {
  const code = normalizeInviteCode(value);
  return canJoinInviteRoom(code) ? `/room?code=${encodeURIComponent(code)}` : null;
};

export const normalizeRoomName = (value: string): string => value.normalize("NFC").replaceAll(/\s+/g, " ").trim().slice(0, maximumRoomNameLength);

export const canCreateRoomName = (value: string): boolean => {
  const name = normalizeRoomName(value);
  return name.length >= minimumRoomNameLength && name.length <= maximumRoomNameLength;
};

export const parseRoomGroupNumber = (value: string | null): number | null => {
  if (value === null || !groupNumberPattern.test(value)) return null;
  const groupNumber = Number(value);
  return groupNumber <= maximumGroupNumber ? groupNumber : null;
};

export const roomGroupNumberFromSearchParams = (params: Pick<URLSearchParams, "get">): number | null =>
  parseRoomGroupNumber(params.get("group") ?? params.get("sun"));

export const groupRoomPath = (groupNumber: number): string | null =>
  Number.isInteger(groupNumber) && groupNumber >= 1 && groupNumber <= maximumGroupNumber
    ? `/room?group=${groupNumber}`
    : null;
