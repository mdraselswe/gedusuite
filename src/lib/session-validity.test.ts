import { describe, expect, it } from "vitest";
import { sessionIsVoid } from "@/lib/session-validity";

const T = new Date("2026-10-01T10:00:00.000Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

describe("sessionIsVoid", () => {
  it("keeps a session when nothing was reset", () => {
    expect(sessionIsVoid(sec(T), null)).toBe(false);
    expect(sessionIsVoid(sec(T), undefined)).toBe(false);
  });
  it("voids a session issued before the reset", () => {
    expect(sessionIsVoid(sec(T) - 3600, T)).toBe(true);
  });
  it("keeps a session issued after the reset", () => {
    expect(sessionIsVoid(sec(T) + 60, T)).toBe(false);
  });
  it("keeps a session issued in the same second as the reset", () => {
    expect(sessionIsVoid(sec(T), T)).toBe(false);
  });
  it("does not lock out a cookie that has no iat", () => {
    expect(sessionIsVoid(undefined, T)).toBe(false);
  });
});
