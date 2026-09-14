import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";
import { collectBoundedRange, parseBoundedDateRange } from "../src/range-export.js";

function message(id: number, date: string): Api.Message {
  return { id, date: new Date(date) } as unknown as Api.Message;
}

test("requires timezone-explicit bounded export ranges", () => {
  const now = new Date("2026-08-07T12:00:00.000Z");
  const range = parseBoundedDateRange(
    "2026-08-06T00:00:00+03:00",
    "now",
    14,
    now,
  );
  assert.equal(range.from.toISOString(), "2026-08-05T21:00:00.000Z");
  assert.equal(range.to.toISOString(), now.toISOString());
  assert.throws(
    () => parseBoundedDateRange("2026-08-06", "now", 14, now),
    /explicit timezone/,
  );
  assert.throws(
    () => parseBoundedDateRange("2026-07-01T00:00:00Z", "now", 14, now),
    /lookback/,
  );
});

test("collects only the requested range and stops after reaching older history", async () => {
  const pages = new Map<number, Api.Message[]>([
    [0, [
      message(5, "2026-08-08T01:00:00Z"),
      message(4, "2026-08-07T10:00:00Z"),
      message(3, "2026-08-06T10:00:00Z"),
    ]],
    [3, [message(2, "2026-08-05T20:00:00Z"), message(1, "2026-08-05T10:00:00Z")]],
  ]);
  const calls: number[] = [];
  const result = await collectBoundedRange(
    async (offsetId) => {
      calls.push(offsetId);
      return pages.get(offsetId) ?? [];
    },
    { from: new Date("2026-08-06T00:00:00Z"), to: new Date("2026-08-08T00:00:00Z") },
    { historyPageSize: 3, maxPages: 3, maxMessages: 9 },
  );
  assert.deepEqual(calls, [0, 3]);
  assert.deepEqual(result.map((entry) => entry.id), [3, 4]);
});

test("fails closed instead of writing an incomplete capped range", async () => {
  await assert.rejects(
    collectBoundedRange(
      async () => [message(3, "2026-08-07T03:00:00Z"), message(2, "2026-08-07T02:00:00Z")],
      { from: new Date("2026-08-06T00:00:00Z"), to: new Date("2026-08-08T00:00:00Z") },
      { historyPageSize: 2, maxPages: 1, maxMessages: 2 },
    ),
    /no partial export was written/,
  );
});
