export const normalizeNickname = (value: string): string => value.normalize("NFC").trim().replace(/\s+/g, " ");

export const isValidNickname = (value: string): boolean => {
  const length = Array.from(normalizeNickname(value)).length;
  return length >= 2 && length <= 12;
};
