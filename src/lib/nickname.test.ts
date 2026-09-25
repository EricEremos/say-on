import { describe, expect, it } from "vitest";
import { isValidNickname, normalizeNickname } from "./nickname";

describe("room nickname", () => {
  it("keeps Korean names readable while removing accidental whitespace", () => {
    expect(normalizeNickname("  하늘  바다  ")).toBe("하늘 바다");
  });

  it("accepts a short participant name and rejects missing or excessive text", () => {
    expect(isValidNickname("하늘")).toBe(true);
    expect(isValidNickname(" ")).toBe(false);
    expect(isValidNickname("가나다라마바사아자차카타파하")).toBe(false);
  });
});
