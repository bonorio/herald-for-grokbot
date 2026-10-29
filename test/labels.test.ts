import { describe, expect, it } from "vitest";
import { startsLabel } from "../src/web/Action";

describe("event start labels", () => {
  // Local times, so the day math matches the phone's.
  const now = new Date(2026, 9, 29, 17, 0);
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

  it("reads as a time, not a deadline", () => {
    expect(startsLabel(at(30, 13), now)).toMatch(/^Tomorrow 1\sPM$/);
    expect(startsLabel(at(29, 18, 30), now)).toMatch(/^Today 6:30\sPM$/);
    expect(startsLabel(at(29, 16), now)).toMatch(/^Started 4\sPM$/);
    expect(startsLabel(at(28, 9), now)).toBe("Past");
    expect(startsLabel(at(31, 9), now)).toMatch(/^Sat 9\sAM$/);
  });
});
