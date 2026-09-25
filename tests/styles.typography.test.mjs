import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const document = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("Korean typography contract", () => {
  it("loads the Korean font family and keeps display, page, and question text within the approved responsive scale", () => {
    expect(document).toContain("Noto+Sans+KR:wght@400;500;600;700;800;900");
    expect(styles).toContain('font-family: "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif');
    expect(styles).toContain("--type-display: clamp(36px, 7vw, 64px)");
    expect(styles).toContain("--type-page: clamp(28px, 4vw, 42px)");
    expect(styles).toContain("--type-question: clamp(26px, 4.5vw, 48px)");
    expect(styles).toContain("font-size: var(--type-question)");
  });
});
