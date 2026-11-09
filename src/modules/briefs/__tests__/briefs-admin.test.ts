import { describe, expect, it } from "vitest";
import {
  BRIEF_TIME_PATTERN,
  isIanaTimeZone,
  slotView,
} from "../service/briefs-admin";

const slot = {
  id: "europe" as const,
  timezone: "Europe/Berlin",
  localTime: "08:00",
  enabled: true,
};
// 06:00 in Berlin (UTC+1 in March).
const now = new Date("2031-03-03T05:00:00Z");

describe("briefs admin (D369)", () => {
  it("moving the time moves the next run", () => {
    const before = slotView(slot, now);
    expect(before.nextRunUtc).toBe("2031-03-03T07:00:00.000Z");
    expect(before.nextRunLocal).toBe("2031-03-03 08:00");
    const later = slotView({ ...slot, localTime: "09:45" }, now);
    expect(later.nextRunUtc).toBe("2031-03-03T08:45:00.000Z");
    expect(later.nextRunLocal).toBe("2031-03-03 09:45");
    // Earlier than now: tomorrow.
    const earlier = slotView({ ...slot, localTime: "05:30" }, now);
    expect(earlier.nextRunUtc).toBe("2031-03-04T04:30:00.000Z");
  });

  it("moving the zone moves the next run", () => {
    const chicago = slotView({ ...slot, timezone: "America/Chicago" }, now);
    expect(chicago.nextRunUtc).toBe("2031-03-03T14:00:00.000Z");
  });

  it("accepts only IANA zones and 15-minute times", () => {
    expect(isIanaTimeZone("Europe/Moscow")).toBe(true);
    expect(isIanaTimeZone("UTC")).toBe(true);
    expect(isIanaTimeZone("Mars/Base")).toBe(false);
    expect(isIanaTimeZone("+03:00")).toBe(false);
    expect(BRIEF_TIME_PATTERN.test("08:15")).toBe(true);
    expect(BRIEF_TIME_PATTERN.test("08:10")).toBe(false);
    expect(BRIEF_TIME_PATTERN.test("24:00")).toBe(false);
  });
});
