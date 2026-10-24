import { describe, expect, it } from "vitest";
import { escapeHtml, initials, formatTime } from "../../src/utils/format.js";

describe("formatting utilities", () => {
  it("escapes HTML characters", () => {
    expect(escapeHtml('<img src="x" onerror="alert(1)">')).toBe("&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;");
  });

  it("creates initials from one or two words", () => {
    expect(initials("Timur Ovcharenko")).toBe("TO");
    expect(initials("Настя")).toBe("Н");
    expect(initials("")).toBe("M");
  });

  it("formats valid timestamps and rejects invalid values", () => {
    expect(formatTime("not a date")).toBe("");
    expect(formatTime("2026-10-24T10:20:00.000Z")).toMatch(/\d{1,2}:\d{2}/);
  });
});
