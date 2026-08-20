import assert from "node:assert/strict";
import test from "node:test";

import { eventFromRecord, syncOnce } from "./index.mjs";

test("timestamp-backed daily records preserve the provider instant", () => {
  const record = {
    id: "activity-1",
    day: "2026-08-19",
    timestamp: "2026-08-19T04:00:00.000+08:00",
  };

  const event = eventFromRecord("daily_activity", record);

  assert.equal(event.startedAt, Date.parse(record.timestamp));
  assert.equal(event.endedAt, undefined);
  assert.equal(event.payload.record, record);
});

test("date-only daily records use the same-day activity offset as a calendar range", () => {
  const record = {
    id: "stress-1",
    day: "2025-10-23",
  };
  const temporalContext = {
    dailyActivityOffsets: { [record.day]: "-07:00" },
  };

  const event = eventFromRecord("daily_stress", record, temporalContext);

  assert.equal(event.startedAt, Date.parse("2025-10-23T00:00:00.000-07:00"));
  assert.equal(event.endedAt, Date.parse("2025-10-24T00:00:00.000-07:00"));
  assert.equal(event.payload.record, record);
  assert.deepEqual(Object.keys(event.payload).sort(), ["provider", "record", "schema", "stream"]);
});

test("date-only daily records do not invent a UTC range without timezone evidence", () => {
  assert.throws(() => eventFromRecord("daily_spo2", {
    id: "spo2-1",
    day: "2026-02-01",
  }), /missing a usable timestamp/);
});

test("syncs daily activity first and reuses its offset for date-only streams", async () => {
  const calls = [];
  const events = [];
  let state;
  const records = {
    "/v1/streams/daily_activity": [{
      id: "activity-2",
      day: "2026-08-19",
      timestamp: "2026-08-19T04:00:00.000+08:00",
    }],
    "/v1/streams/daily_stress": [{
      id: "stress-2",
      day: "2026-08-19",
    }],
  };
  const context = {
    auth: {
      type: "managedProvider",
      getToken: async () => "test-token",
    },
    config: {
      streams: ["daily_stress", "daily_activity"],
      "backfill-years": 0,
    },
    state: {
      get: async () => state,
      set: async (value) => {
        state = value;
      },
    },
    guard: {
      writeEvents: async (batch) => {
        events.push(...batch);
      },
    },
  };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.pathname);
    return {
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      text: async () => JSON.stringify({ data: records[url.pathname] ?? [] }),
    };
  };

  await syncOnce(context, {
    baseUrl: "https://provider.test/",
    fetchImpl,
    now: Date.parse("2026-08-21T00:01:00.000+08:00"),
  });

  assert.deepEqual(calls, [
    "/v1/streams/daily_activity",
    "/v1/streams/daily_stress",
  ]);
  const stress = events.find((event) => event.type === "oura.daily_stress");
  assert.equal(stress.startedAt, Date.parse("2026-08-19T00:00:00.000+08:00"));
  assert.equal(stress.endedAt, Date.parse("2026-08-20T00:00:00.000+08:00"));
  assert.equal(state.dailyActivityOffsets["2026-08-19"], "+08:00");
});

test("sync skips unresolved date-only records, warns, and keeps the cursor retryable", async () => {
  const events = [];
  const warnings = new Map();
  let state;
  const context = {
    auth: {
      type: "managedProvider",
      getToken: async () => "test-token",
    },
    config: {
      streams: ["daily_stress"],
      "backfill-years": 0,
    },
    state: {
      get: async () => state,
      set: async (value) => {
        state = value;
      },
    },
    guard: {
      writeEvents: async (batch) => {
        events.push(...batch);
      },
    },
    warnings: {
      set: async (warning) => warnings.set(warning.key, warning),
      clear: async (key) => warnings.delete(key),
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => undefined },
    text: async () => JSON.stringify({
      data: [{ id: "stress-unresolved", day: "2026-08-19" }],
    }),
  });

  await syncOnce(context, {
    baseUrl: "https://provider.test/",
    fetchImpl,
    now: Date.parse("2026-08-21T00:01:00.000+08:00"),
  });

  assert.equal(events.length, 0);
  assert.equal(state.incremental.streams.daily_stress.lastSyncedDate, undefined);
  assert.deepEqual(warnings.get("calendar-day-timezone")?.details.missing, [{
    stream: "daily_stress",
    day: "2026-08-19",
  }]);
});
