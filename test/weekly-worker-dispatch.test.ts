import { describe, it, expect } from "vitest";
import { resolveWeeklyPublishedPath } from "../../scripts/lib/weekly-worker-dispatch.ts";

describe("weekly-worker-dispatch (#8310)", () => {
  it("resolveWeeklyPublishedPath", () => {
    expect(resolveWeeklyPublishedPath(".","260905")).toContain("06-weekly-published.json");
  });
});
