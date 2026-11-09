import { describe, expect, it } from "vitest";
import {
  employerBriefTimeZone,
  dueSlotDate,
  nextSlotStart,
  slotForOffset,
  slotForTimeZone,
  type BriefSlot,
} from "../lib/briefs";

const at = (iso: string) => new Date(iso);

const chicago: BriefSlot = {
  id: "americas",
  timezone: "America/Chicago",
  localTime: "08:00",
  enabled: true,
};
const moscow: BriefSlot = {
  id: "cis",
  timezone: "Europe/Moscow",
  localTime: "08:00",
  enabled: true,
};

describe("slotForTimeZone (D340)", () => {
  it("splits the world into three mornings by the current offset", () => {
    const now = at("2026-10-07T12:00:00Z");
    expect(slotForTimeZone("America/Los_Angeles", now)).toBe("americas");
    expect(slotForTimeZone("America/Sao_Paulo", now)).toBe("americas");
    expect(slotForTimeZone("Europe/London", now)).toBe("europe");
    expect(slotForTimeZone("Europe/Berlin", now)).toBe("europe");
    expect(slotForTimeZone("Europe/Moscow", now)).toBe("cis");
    expect(slotForTimeZone("Asia/Almaty", now)).toBe("cis");
    expect(slotForTimeZone("Asia/Kathmandu", now)).toBe("cis");
  });

  it("falls back to Europe without or with a broken time zone", () => {
    const now = at("2026-10-07T12:00:00Z");
    expect(slotForTimeZone(null, now)).toBe("europe");
    expect(slotForTimeZone("Not/AZone", now)).toBe("europe");
  });

  it("puts the edges where the spec says", () => {
    expect(slotForOffset(-180)).toBe("americas");
    expect(slotForOffset(-120)).toBe("europe");
    expect(slotForOffset(120)).toBe("europe");
    expect(slotForOffset(180)).toBe("cis");
  });
});

describe("dueSlotDate (D340)", () => {
  it("fires from the slot time for two hours, on the local date", () => {
    // Moscow is UTC+3 all year: 08:00 local is 05:00Z.
    expect(dueSlotDate(moscow, at("2026-10-07T04:59:00Z"))).toBeNull();
    expect(dueSlotDate(moscow, at("2026-10-07T05:00:00Z"))).toBe("2026-10-07");
    expect(dueSlotDate(moscow, at("2026-10-07T06:59:00Z"))).toBe("2026-10-07");
    expect(dueSlotDate(moscow, at("2026-10-07T07:00:00Z"))).toBeNull();
  });

  it("follows daylight saving time in Chicago", () => {
    // CDT (-5) in October, CST (-6) in January.
    expect(dueSlotDate(chicago, at("2026-10-07T13:00:00Z"))).toBe("2026-10-07");
    expect(dueSlotDate(chicago, at("2026-01-12T13:00:00Z"))).toBeNull();
    expect(dueSlotDate(chicago, at("2026-01-12T14:00:00Z"))).toBe("2026-01-12");
  });

  it("honours a quarter-hour time set by the admin", () => {
    const slot = { ...moscow, localTime: "07:45" };
    expect(dueSlotDate(slot, at("2026-10-07T04:44:00Z"))).toBeNull();
    expect(dueSlotDate(slot, at("2026-10-07T04:45:00Z"))).toBe("2026-10-07");
  });

  it("never fires a paused slot", () => {
    expect(
      dueSlotDate({ ...moscow, enabled: false }, at("2026-10-07T05:00:00Z")),
    ).toBeNull();
  });
});

describe("nextSlotStart (D340)", () => {
  it("is today's morning before it and tomorrow's after it", () => {
    expect(nextSlotStart(moscow, at("2026-10-07T04:00:00Z"))).toEqual(
      at("2026-10-07T05:00:00Z"),
    );
    expect(nextSlotStart(moscow, at("2026-10-07T05:00:00Z"))).toEqual(
      at("2026-10-08T05:00:00Z"),
    );
  });
});

describe("employerBriefTimeZone (20-morning-briefs §10.3)", () => {
  const now = new Date("2026-03-10T07:00:00Z");

  it("takes the companies' zone when all of them share one valid zone", () => {
    expect(employerBriefTimeZone(["America/Chicago"], now)).toBe(
      "America/Chicago",
    );
    expect(employerBriefTimeZone(["Europe/Moscow", "Europe/Moscow"], now)).toBe(
      "Europe/Moscow",
    );
  });

  it("falls back to null for mixed, empty or invalid zones", () => {
    expect(
      employerBriefTimeZone(["Europe/Moscow", "America/Chicago"], now),
    ).toBeNull();
    expect(employerBriefTimeZone(["Europe/Moscow", null], now)).toBeNull();
    expect(employerBriefTimeZone([null], now)).toBeNull();
    expect(employerBriefTimeZone([], now)).toBeNull();
    expect(employerBriefTimeZone(["Not/AZone"], now)).toBeNull();
  });
});
