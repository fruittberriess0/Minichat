import { describe, expect, it } from "vitest";
import { escapeHtml, initials, formatTime } from "./format.js";

describe("format helpers", () => {
  it("escapes HTML metacharacters before displaying user content", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
    );
    expect(escapeHtml(null)).toBe("");
  });

  it("builds initials for names and missing values", () => {
    expect(initials("Timur Ovcharenko")).toBe("TO");
    expect(initials("Настя")).toBe("Н");
    expect(initials("")).toBe("M");
  });

  it("formats valid timestamps and handles invalid ones safely", () => {
    expect(formatTime("not-a-date")).toBe("");
    expect(formatTime(null)).toBe("");
    expect(formatTime("2026-10-24T10:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
  });
});
