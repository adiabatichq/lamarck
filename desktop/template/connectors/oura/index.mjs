import { createHash } from "node:crypto";

const IDENTITY_PATH = "/v1/identity";
const DEFAULT_LOOKBACK_DAYS = 3;
const DEFAULT_BACKFILL_YEARS = 1;
const DATE_BACKFILL_CHUNK_DAYS = 90;
const DATETIME_BACKFILL_CHUNK_DAYS = 30;
const EVENT_BATCH_SIZE = 100;
const HEARTRATE_BUCKET_MS = 15 * 60 * 1000;
const RING_CONFIGURATION_SYNC_INTERVAL_DAYS = 30;
const RING_BATTERY_LOW_LEVEL = 10;
const RING_BATTERY_CRITICAL_LEVEL = 5;
const RING_BATTERY_RECOVERED_LEVEL = 20;
const RING_BATTERY_RECOVERY_DEBOUNCE_MS = 10 * 60 * 1000;

const DEFAULT_STREAM_IDS = [
  "daily_activity",
  "daily_sleep",
  "daily_readiness",
  "sleep",
  "sleep_time",
  "daily_spo2",
  "daily_stress",
  "workout",
  "session",
  "tag",
  "enhanced_tag",
  "rest_mode_period",
  "daily_resilience",
  "daily_cardiovascular_age",
  "vo2_max",
  "ring_configuration",
  "ring_battery_level",
];

const STREAMS = [
  dateStream("daily_activity", "/v1/streams/daily_activity"),
  dateStream("daily_sleep", "/v1/streams/daily_sleep"),
  dateStream("daily_readiness", "/v1/streams/daily_readiness"),
  dateStream("daily_spo2", "/v1/streams/daily_spo2"),
  dateStream("daily_stress", "/v1/streams/daily_stress"),
  dateStream("daily_resilience", "/v1/streams/daily_resilience"),
  dateStream("daily_cardiovascular_age", "/v1/streams/daily_cardiovascular_age"),
  dateStream("sleep_time", "/v1/streams/sleep_time"),
  dateStream("vo2_max", "/v1/streams/vo2_max"),
  {
    id: "sleep",
    path: "/v1/streams/sleep",
    range: "date",
    startedAt: (record) => timestampFromAny(record.bedtime_start, record.day),
    endedAt: (record) => timestampFromAny(record.bedtime_end),
  },
  {
    id: "workout",
    path: "/v1/streams/workout",
    range: "date",
    startedAt: (record) => timestampFromAny(record.start_datetime, record.day),
    endedAt: (record) => timestampFromAny(record.end_datetime),
  },
  {
    id: "session",
    path: "/v1/streams/session",
    range: "date",
    startedAt: (record) => timestampFromAny(record.start_datetime, record.day),
    endedAt: (record) => timestampFromAny(record.end_datetime),
  },
  {
    id: "tag",
    path: "/v1/streams/tag",
    range: "date",
    startedAt: (record) => timestampFromAny(record.timestamp, record.day),
  },
  {
    id: "enhanced_tag",
    path: "/v1/streams/enhanced_tag",
    range: "date",
    startedAt: (record) => timestampFromAny(record.start_time, record.start_day),
    endedAt: (record) => timestampFromAny(record.end_time, record.end_day),
  },
  {
    id: "rest_mode_period",
    path: "/v1/streams/rest_mode_period",
    range: "date",
    startedAt: (record) => timestampFromAny(record.start_time, record.start_day),
    endedAt: (record) => timestampFromAny(record.end_time, record.end_day),
  },
  {
    id: "ring_configuration",
    path: "/v1/streams/ring_configuration",
    range: "none",
    syncIntervalDays: RING_CONFIGURATION_SYNC_INTERVAL_DAYS,
    // No `?? 0` fallback: it would satisfy the finite-timestamp check below and
    // date the event 1970-01-01 instead of failing on a record we cannot time.
    startedAt: (record) => timestampFromAny(record.set_up_at),
  },
  {
    id: "heartrate",
    path: "/v1/streams/heartrate",
    range: "datetime",
    startedAt: (record) => timestampFromAny(record.timestamp_unix, record.timestamp),
    sourceId: (record) => ["ts", record.timestamp_unix ?? record.timestamp, record.source ?? "unknown"].join(":"),
  },
  {
    id: "ring_battery_level",
    path: "/v1/streams/ring_battery_level",
    range: "datetime",
    startedAt: (record) => timestampFromAny(record.timestamp_unix, record.timestamp),
    sourceId: (record) => ["ts", record.timestamp_unix ?? record.timestamp].join(":"),
  },
];

const STREAMS_BY_ID = new Map(STREAMS.map((stream) => [stream.id, stream]));

export default {
  async run(context) {
    await syncOnce(context);
  },

  async resolveSourceIdentity(context) {
    return resolveSourceIdentity(context);
  },
};

export async function resolveSourceIdentity(context, deps = {}) {
  assertManagedProviderAuth(context.auth);
  const token = await context.auth.getToken();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Oura connector requires fetch");
  }

  const baseUrl = managedProviderBaseUrl(context.auth, deps);
  const res = await fetchImpl(providerUrl(baseUrl, IDENTITY_PATH).toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: context.signal,
  });
  const body = await providerResponseBody(res);
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new Error("Oura identity response is missing a stable id");
  }
  return {
    key: body.id,
    ...(typeof body.email === "string" ? { label: body.email } : {}),
  };
}

export async function syncOnce(context, deps = {}) {
  assertManagedProviderAuth(context.auth);

  const config = normalizeConfig(context.config);
  const previous = normalizeState(await context.state.get());
  const next = {
    version: 2,
    incremental: {
      streams: { ...previous.incremental.streams },
    },
    backfill: previous.backfill,
  };
  const token = await context.auth.getToken();
  const nowMs = readNowMs(deps.now);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Oura connector requires fetch");
  }
  const baseUrl = managedProviderBaseUrl(context.auth, deps);
  const streams = selectStreams(config);

  for (const stream of streams) {
    if (isAborted(context.signal)) return;

    const streamState = isObject(next.incremental.streams[stream.id])
      ? next.incremental.streams[stream.id]
      : {};
    const range = buildIncrementalRange(stream, streamState, config, nowMs);
    if (!range) continue;
    const syncStatePatch = await syncStream({
      stream,
      range,
      streamState,
      guard: context.guard,
      token,
      signal: context.signal,
      fetchImpl,
      baseUrl,
      nowMs,
    });

    if (isAborted(context.signal)) return;
    next.incremental.streams[stream.id] = {
      ...streamState,
      ...range.statePatch,
      ...syncStatePatch,
      lastSyncedAt: nowMs,
    };
    await context.state.set(next);
  }

  await syncBackfill({
    context,
    next,
    config,
    streams,
    token,
    nowMs,
    fetchImpl,
    baseUrl,
  });
}

export function eventFromRecord(streamId, record) {
  const stream = STREAMS_BY_ID.get(streamId);
  if (!stream) throw new Error(`Unknown Oura stream: ${streamId}`);

  const startedAt = stream.startedAt(record);
  if (!Number.isFinite(startedAt)) {
    throw new Error(`Oura ${stream.id} record is missing a usable timestamp`);
  }

  const event = {
    type: `oura.${stream.id}`,
    externalId: externalIdForRecord(stream, record),
    startedAt,
    payload: {
      schema: `oura.${stream.id}.v1`,
      provider: "oura",
      stream: stream.id,
      record,
    },
  };

  const endedAt = typeof stream.endedAt === "function" ? stream.endedAt(record) : undefined;
  if (Number.isFinite(endedAt) && endedAt >= startedAt) {
    event.endedAt = endedAt;
  }

  return event;
}

async function syncStream({ stream, range, streamState, guard, token, signal, fetchImpl, baseUrl, nowMs }) {
  if (stream.id === "heartrate") {
    await syncHeartrateStream({ stream, range, guard, token, signal, fetchImpl, baseUrl });
    return {};
  }
  if (stream.id === "ring_battery_level") {
    return syncRingBatteryStream({ stream, range, streamState, guard, token, signal, fetchImpl, baseUrl, nowMs });
  }

  let nextToken;
  const batch = [];

  do {
    if (isAborted(signal)) return;
    const page = await fetchPage({ stream, range, token, nextToken, signal, fetchImpl, baseUrl });
    for (const record of page.data) {
      batch.push(eventFromRecord(stream.id, record));
      if (batch.length >= EVENT_BATCH_SIZE) {
        await writeBatch(guard, batch.splice(0, batch.length));
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);

  if (batch.length) {
    await writeBatch(guard, batch);
  }
  return {};
}

async function syncHeartrateStream({ stream, range, guard, token, signal, fetchImpl, baseUrl }) {
  let nextToken;
  const buckets = new Map();

  do {
    if (isAborted(signal)) return;
    const page = await fetchPage({ stream, range, token, nextToken, signal, fetchImpl, baseUrl });
    for (const record of page.data) {
      const timestamp = stream.startedAt(record);
      if (!Number.isFinite(timestamp)) continue;
      const bucketStart = Math.floor(timestamp / HEARTRATE_BUCKET_MS) * HEARTRATE_BUCKET_MS;
      const bucket = buckets.get(bucketStart) ?? [];
      bucket.push(record);
      buckets.set(bucketStart, bucket);
    }
    nextToken = page.nextToken;
  } while (nextToken);

  const events = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, records]) => eventFromHeartrateBucket(bucketStart, records));

  for (let i = 0; i < events.length; i += EVENT_BATCH_SIZE) {
    if (isAborted(signal)) return;
    await writeBatch(guard, events.slice(i, i + EVENT_BATCH_SIZE));
  }
}

async function syncRingBatteryStream({ stream, range, streamState, guard, token, signal, fetchImpl, baseUrl, nowMs }) {
  let nextToken;
  const records = [];

  do {
    if (isAborted(signal)) return {};
    const page = await fetchPage({ stream, range, token, nextToken, signal, fetchImpl, baseUrl });
    records.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);

  const previousBattery = normalizeRingBatteryState(streamState.ringBattery);
  const battery = { ...previousBattery };
  const events = [];
  const sorted = records
    .map((record) => ({ record, timestamp: stream.startedAt(record) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const lastProcessedAt = timestampMs(previousBattery.lastTimestamp);
  for (const { record, timestamp } of sorted) {
    if (Number.isFinite(lastProcessedAt) && timestamp <= lastProcessedAt) {
      continue;
    }
    const nextEvents = ringBatteryEventsForRecord(record, timestamp, battery);
    events.push(...nextEvents);
    battery.lastTimestamp = new Date(timestamp).toISOString();
    battery.lastLevel = Number.isFinite(Number(record.level)) ? Number(record.level) : undefined;
    battery.lastCharging = record.charging === true;
    battery.lastInCharger = record.in_charger === true;
  }

  events.push(...flushRingBatteryPendingRecovery(battery, nowMs));

  for (let i = 0; i < events.length; i += EVENT_BATCH_SIZE) {
    if (isAborted(signal)) return { ringBattery: battery };
    await writeBatch(guard, events.slice(i, i + EVENT_BATCH_SIZE));
  }

  return { ringBattery: battery };
}

function ringBatteryEventsForRecord(record, timestamp, battery) {
  const level = Number(record.level);
  if (!Number.isFinite(level)) {
    return [];
  }

  const events = [];
  const charging = record.charging === true;
  const inCharger = record.in_charger === true;
  const timestampIso = new Date(timestamp).toISOString();

  if (battery.lowActive && battery.pendingRecovered) {
    const pendingAt = timestampMs(battery.pendingRecovered.timestamp);
    const pendingExpired = Number.isFinite(pendingAt) &&
      timestamp - pendingAt >= RING_BATTERY_RECOVERY_DEBOUNCE_MS;
    if (level >= RING_BATTERY_RECOVERED_LEVEL) {
      events.push(completeRingBatteryRecovery(battery, battery.pendingRecovered));
    } else if (charging || inCharger) {
      updatePendingRingBatteryRecovery(battery, record, timestamp, level);
    } else if (pendingExpired && level < RING_BATTERY_LOW_LEVEL) {
      delete battery.pendingRecovered;
    } else if (pendingExpired) {
      events.push(completeRingBatteryRecovery(battery, battery.pendingRecovered));
    }
  }

  if (battery.lowActive && !battery.pendingRecovered && level >= RING_BATTERY_RECOVERED_LEVEL) {
    updatePendingRingBatteryRecovery(battery, record, timestamp, level);
    events.push(completeRingBatteryRecovery(battery, battery.pendingRecovered));
  }

  if (battery.lowActive && (charging || inCharger)) {
    updatePendingRingBatteryRecovery(battery, record, timestamp, level);
  }

  if (!charging && !inCharger && !battery.lowActive && level < RING_BATTERY_LOW_LEVEL) {
    battery.lowActive = true;
    battery.lowStartedAt = timestampIso;
    events.push(ringBatteryEvent("low", timestamp, record, {
      level,
      threshold: RING_BATTERY_LOW_LEVEL,
    }));
  }

  if (!charging && !inCharger && !battery.criticalActive && level < RING_BATTERY_CRITICAL_LEVEL) {
    battery.criticalActive = true;
    battery.criticalStartedAt = timestampIso;
    events.push(ringBatteryEvent("critical", timestamp, record, {
      level,
      threshold: RING_BATTERY_CRITICAL_LEVEL,
      lowStartedAt: battery.lowStartedAt,
    }));
  }

  return events;
}

function ringBatteryEvent(kind, timestamp, record, details) {
  const timestampIso = new Date(timestamp).toISOString();
  return {
    type: `oura.ring_battery.${kind}`,
    externalId: `ring_battery:${kind}:${timestampIso}`,
    startedAt: timestamp,
    payload: {
      schema: "oura.ring_battery.transition.v1",
      provider: "oura",
      stream: "ring_battery_level",
      kind,
      lowLevel: RING_BATTERY_LOW_LEVEL,
      criticalLevel: RING_BATTERY_CRITICAL_LEVEL,
      recoveredLevel: RING_BATTERY_RECOVERED_LEVEL,
      charging: record.charging === true,
      inCharger: record.in_charger === true,
      ...details,
      record,
    },
  };
}

function updatePendingRingBatteryRecovery(battery, record, timestamp, level) {
  const candidate = {
    timestamp: new Date(timestamp).toISOString(),
    level,
    charging: record.charging === true,
    inCharger: record.in_charger === true,
    previousLowStartedAt: battery.lowStartedAt,
    previousCriticalStartedAt: battery.criticalStartedAt,
    record,
  };
  if (!battery.pendingRecovered || ringBatteryRecoveryCandidateScore(candidate) > ringBatteryRecoveryCandidateScore(battery.pendingRecovered)) {
    battery.pendingRecovered = candidate;
  }
}

function ringBatteryRecoveryCandidateScore(candidate) {
  let score = 0;
  if (candidate.inCharger === true) score += 4;
  if (candidate.charging === true) score += 2;
  if (Number.isFinite(candidate.level) && candidate.level >= RING_BATTERY_LOW_LEVEL) score += 1;
  return score;
}

function flushRingBatteryPendingRecovery(battery, nowMs) {
  if (!battery.lowActive || !battery.pendingRecovered) {
    return [];
  }
  const pendingAt = timestampMs(battery.pendingRecovered.timestamp);
  if (!Number.isFinite(pendingAt) || !Number.isFinite(nowMs) || nowMs - pendingAt < RING_BATTERY_RECOVERY_DEBOUNCE_MS) {
    return [];
  }
  return [completeRingBatteryRecovery(battery, battery.pendingRecovered)];
}

function completeRingBatteryRecovery(battery, candidate) {
  const timestamp = timestampMs(candidate.timestamp);
  const record = isObject(candidate.record)
    ? candidate.record
    : {
      timestamp: candidate.timestamp,
      level: candidate.level,
      charging: candidate.charging,
      in_charger: candidate.inCharger,
    };
  const event = ringBatteryEvent("recovered", timestamp, record, {
    level: candidate.level,
    previousLowStartedAt: candidate.previousLowStartedAt,
    previousCriticalStartedAt: candidate.previousCriticalStartedAt,
    recoveredLevel: RING_BATTERY_RECOVERED_LEVEL,
    recoveryDebounceMs: RING_BATTERY_RECOVERY_DEBOUNCE_MS,
  });
  battery.lowActive = false;
  battery.criticalActive = false;
  delete battery.lowStartedAt;
  delete battery.criticalStartedAt;
  delete battery.pendingRecovered;
  return event;
}

async function fetchPage({ stream, range, token, nextToken, signal, fetchImpl, baseUrl }) {
  const url = providerUrl(baseUrl, stream.path);
  for (const [key, value] of Object.entries(range.query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  if (nextToken) url.searchParams.set("next_token", nextToken);

  const res = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal,
  });
  const body = await providerResponseBody(res);

  return {
    data: Array.isArray(body.data) ? body.data : [],
    nextToken: typeof body.nextToken === "string" && body.nextToken
      ? body.nextToken
      : typeof body.next_token === "string" && body.next_token
        ? body.next_token
        : undefined,
  };
}

async function providerResponseBody(res) {
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  const body = isObject(parsed) ? parsed : {};

  if (!res.ok) {
    const retryAfter = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : undefined;
    const retryHint = retryAfter ? ` retry after ${retryAfter}s` : "";
    const message = typeof body.detail === "string"
      ? body.detail
      : typeof body.message === "string"
        ? body.message
        : `Oura API returned ${res.status}`;
    throw new Error(`${message}${retryHint}`);
  }
  return body;
}

function managedProviderBaseUrl(auth, deps) {
  if (typeof deps.baseUrl === "string" && deps.baseUrl.trim()) {
    return normalizeBaseUrl(deps.baseUrl);
  }
  if (typeof auth.providerOrigin !== "string" || !auth.providerOrigin.trim()) {
    throw new Error("Oura managed provider origin is unavailable");
  }
  return new URL("/providers/oura/", normalizeBaseUrl(auth.providerOrigin)).toString();
}

function providerUrl(baseUrl, path) {
  const relativePath = String(path).replace(/^\/+/, "");
  return new URL(relativePath, normalizeBaseUrl(baseUrl));
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function assertManagedProviderAuth(auth) {
  if (!auth || auth.type !== "managedProvider" || typeof auth.getToken !== "function") {
    throw new Error("Oura connector requires Lamarck managed provider credentials");
  }
}

async function writeBatch(guard, events) {
  if (typeof guard.writeEvents === "function") {
    await guard.writeEvents(events);
    return;
  }
  for (const event of events) {
    await guard.writeEvent(event);
  }
}

function buildIncrementalRange(stream, streamState, config, nowMs) {
  if (stream.range === "none") {
    if (
      stream.syncIntervalDays &&
      Number.isFinite(streamState.lastSyncedAt) &&
      nowMs < addDays(streamState.lastSyncedAt, stream.syncIntervalDays)
    ) {
      return undefined;
    }
    return {
      query: {},
      statePatch: {},
    };
  }

  if (stream.range === "datetime") {
    const end = new Date(nowMs).toISOString();
    const start = streamState.lastSyncedDateTime
      ? toIsoDateTime(addDays(Date.parse(streamState.lastSyncedDateTime), -config.lookbackDays))
      : toIsoDateTime(addDays(nowMs, -config.lookbackDays));
    return {
      query: { start_datetime: start, end_datetime: end },
      statePatch: { lastSyncedDateTime: end },
    };
  }

  const end = isoDate(nowMs);
  const start = streamState.lastSyncedDate
    ? isoDate(addDays(Date.parse(`${streamState.lastSyncedDate}T00:00:00.000Z`), -config.lookbackDays))
    : isoDate(addDays(nowMs, -config.lookbackDays));
  return {
    query: { start_date: start, end_date: end },
    statePatch: { lastSyncedDate: end },
  };
}

async function syncBackfill({ context, next, config, streams, token, nowMs, fetchImpl, baseUrl }) {
  if (config.backfillYears <= 0) return;

  const backfillStreams = streams.filter(
    (stream) => stream.backfill !== false && (stream.range === "date" || stream.range === "datetime"),
  );
  if (backfillStreams.length === 0) return;

  const backfill = normalizeBackfill(next.backfill, config, nowMs);
  next.backfill = backfill;
  if (backfill.done) {
    await context.warnings?.clear?.("backfill");
    return;
  }

  for (const stream of backfillStreams) {
    while (true) {
      if (isAborted(context.signal)) return;

      const streamState = normalizeBackfillStreamState(backfill.streams[stream.id]);
      const nextDate = streamState.nextDate ?? backfill.fromDate;
      if (streamState.done || nextDate >= backfill.untilDate) {
        backfill.streams[stream.id] = {
          nextDate: backfill.untilDate,
          done: true,
          lastSyncedAt: streamState.lastSyncedAt ?? nowMs,
        };
        break;
      }

      const chunkEndDate = minIsoDate(
        isoDate(addDays(Date.parse(`${nextDate}T00:00:00.000Z`), backfillChunkDaysForStream(stream))),
        backfill.untilDate,
      );

      let syncStatePatch;
      try {
        syncStatePatch = await syncStream({
          stream,
          range: buildBackfillRange(stream, nextDate, chunkEndDate),
          streamState: normalizeBackfillStreamState(backfill.streams[stream.id]),
          guard: context.guard,
          token,
          signal: context.signal,
          fetchImpl,
          baseUrl,
          nowMs,
        });
      } catch (err) {
        backfill.lastError = {
          stream: stream.id,
          nextDate,
          chunkEndDate,
          message: err instanceof Error ? err.message : String(err),
          at: nowMs,
        };
        await context.state.set(next);
        await context.warnings?.set?.({
          key: "backfill",
          message: `Oura backfill paused at ${stream.id} ${nextDate}: ${backfill.lastError.message}`,
          details: {
            provider: "oura",
            stream: stream.id,
            nextDate,
            chunkEndDate,
          },
        });
        return;
      }

      if (isAborted(context.signal)) return;
      delete backfill.lastError;
      backfill.streams[stream.id] = {
        ...streamState,
        ...syncStatePatch,
        nextDate: chunkEndDate,
        done: chunkEndDate >= backfill.untilDate,
        lastSyncedAt: nowMs,
      };
      backfill.done = backfillComplete(backfill, backfillStreams);
      await context.state.set(next);

      if (backfill.streams[stream.id].done) break;
    }
  }

  backfill.done = backfillComplete(backfill, backfillStreams);
  await context.state.set(next);
  if (backfill.done) {
    await context.warnings?.clear?.("backfill");
  }
}

function buildBackfillRange(stream, startDate, endDate) {
  if (stream.range === "datetime") {
    return {
      query: {
        start_datetime: `${startDate}T00:00:00.000Z`,
        end_datetime: `${endDate}T00:00:00.000Z`,
      },
      statePatch: {},
    };
  }
  return {
    query: { start_date: startDate, end_date: endDate },
    statePatch: {},
  };
}

function backfillChunkDaysForStream(stream) {
  return stream.range === "datetime" ? DATETIME_BACKFILL_CHUNK_DAYS : DATE_BACKFILL_CHUNK_DAYS;
}

function normalizeConfig(config) {
  const input = isObject(config) ? config : {};
  const lookbackDays = integerInRange(input["lookback-days"] ?? input.lookbackDays, 0, 60, DEFAULT_LOOKBACK_DAYS);
  const backfillYears = integerInRange(input["backfill-years"] ?? input.backfillYears, 0, 10, DEFAULT_BACKFILL_YEARS);
  const includeHeartrate = typeof (input["include-heartrate"] ?? input.includeHeartrate) === "boolean"
    ? Boolean(input["include-heartrate"] ?? input.includeHeartrate)
    : true;
  const streams = Array.isArray(input.streams)
    ? input.streams.filter((value) => typeof value === "string")
    : undefined;
  return {
    lookbackDays,
    backfillYears,
    includeHeartrate,
    streams,
  };
}

function normalizeState(value) {
  if (!isObject(value)) {
    return { version: 2, incremental: { streams: {} }, backfill: undefined };
  }
  const legacyStreams = isObject(value.streams) ? value.streams : undefined;
  const incremental = isObject(value.incremental) && isObject(value.incremental.streams)
    ? value.incremental.streams
    : legacyStreams ?? {};
  return {
    version: 2,
    incremental: { streams: incremental },
    backfill: isObject(value.backfill) ? value.backfill : undefined,
  };
}

function selectStreams(config) {
  const ids = config.streams?.length
    ? config.streams
    : [...DEFAULT_STREAM_IDS, ...(config.includeHeartrate ? ["heartrate"] : [])];
  const streams = [];
  for (const id of ids) {
    const stream = STREAMS_BY_ID.get(id);
    if (!stream) throw new Error(`Unknown Oura stream configured: ${id}`);
    streams.push(stream);
  }
  return streams;
}

function normalizeBackfill(value, config, nowMs) {
  if (isObject(value) && validDate(value.fromDate) && validDate(value.untilDate) && isObject(value.streams)) {
    return {
      fromDate: value.fromDate,
      untilDate: value.untilDate,
      streams: { ...value.streams },
      done: value.done === true,
      lastError: isObject(value.lastError) ? value.lastError : undefined,
    };
  }
  return {
    fromDate: isoDate(addYears(nowMs, -config.backfillYears)),
    untilDate: isoDate(nowMs),
    streams: {},
    done: false,
  };
}

function normalizeBackfillStreamState(value) {
  if (!isObject(value)) return {};
  const state = {
    nextDate: validDate(value.nextDate) ? value.nextDate : undefined,
    done: value.done === true,
    lastSyncedAt: Number.isFinite(value.lastSyncedAt) ? value.lastSyncedAt : undefined,
  };
  if (isObject(value.ringBattery)) {
    state.ringBattery = normalizeRingBatteryState(value.ringBattery);
  }
  return state;
}

function normalizeRingBatteryState(value) {
  if (!isObject(value)) {
    return {};
  }
  return {
    lowActive: value.lowActive === true,
    criticalActive: value.criticalActive === true,
    lowStartedAt: typeof value.lowStartedAt === "string" ? value.lowStartedAt : undefined,
    criticalStartedAt: typeof value.criticalStartedAt === "string" ? value.criticalStartedAt : undefined,
    lastTimestamp: typeof value.lastTimestamp === "string" ? value.lastTimestamp : undefined,
    lastLevel: Number.isFinite(value.lastLevel) ? value.lastLevel : undefined,
    lastCharging: value.lastCharging === true,
    lastInCharger: value.lastInCharger === true,
    pendingRecovered: normalizeRingBatteryPendingRecovered(value.pendingRecovered),
  };
}

function normalizeRingBatteryPendingRecovered(value) {
  if (!isObject(value) || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) {
    return undefined;
  }
  return {
    timestamp: value.timestamp,
    level: Number.isFinite(value.level) ? value.level : undefined,
    charging: value.charging === true,
    inCharger: value.inCharger === true,
    previousLowStartedAt: typeof value.previousLowStartedAt === "string" ? value.previousLowStartedAt : undefined,
    previousCriticalStartedAt: typeof value.previousCriticalStartedAt === "string" ? value.previousCriticalStartedAt : undefined,
    record: isObject(value.record) ? value.record : undefined,
  };
}

function backfillComplete(backfill, streams) {
  return streams.every((stream) => {
    const state = normalizeBackfillStreamState(backfill.streams[stream.id]);
    return state.done || (state.nextDate !== undefined && state.nextDate >= backfill.untilDate);
  });
}

function dateStream(id, path) {
  return {
    id,
    path,
    range: "date",
    startedAt: (record) => timestampFromAny(record.day, record.timestamp),
  };
}

function externalIdForRecord(stream, record) {
  const sourceId = typeof stream.sourceId === "function"
    ? stream.sourceId(record)
    : record.id ?? record.day ?? record.timestamp ?? record.timestamp_unix;
  const stableId = String(sourceId ?? stableStringify(record)).trim();
  const revision = createHash("sha256").update(stableStringify(record)).digest("hex").slice(0, 16);
  return `${stream.id}:${stableId || "record"}:${revision}`;
}

function eventFromHeartrateBucket(bucketStart, records) {
  const samples = [...records].sort((a, b) => {
    const at = timestampFromAny(a.timestamp_unix, a.timestamp) ?? 0;
    const bt = timestampFromAny(b.timestamp_unix, b.timestamp) ?? 0;
    return at - bt;
  });
  const bpms = samples
    .map((record) => Number(record.bpm))
    .filter((value) => Number.isFinite(value));
  const sourceCounts = {};
  for (const sample of samples) {
    const source = typeof sample.source === "string" && sample.source ? sample.source : "unknown";
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
  }

  const payload = {
    schema: "oura.heartrate.batch.v1",
    provider: "oura",
    stream: "heartrate",
    bucketMs: HEARTRATE_BUCKET_MS,
    sampleCount: samples.length,
    sourceCounts,
    samples,
  };
  if (bpms.length > 0) {
    payload.minBpm = Math.min(...bpms);
    payload.maxBpm = Math.max(...bpms);
    payload.avgBpm = Math.round((bpms.reduce((sum, bpm) => sum + bpm, 0) / bpms.length) * 100) / 100;
  }

  const revision = createHash("sha256").update(stableStringify(samples)).digest("hex").slice(0, 16);
  return {
    type: "oura.heartrate.batch",
    externalId: `heartrate:${new Date(bucketStart).toISOString()}:${revision}`,
    startedAt: bucketStart,
    endedAt: bucketStart + HEARTRATE_BUCKET_MS,
    payload,
  };
}

function timestampFromAny(...values) {
  for (const value of values) {
    const ms = timestampMs(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Date.parse(`${value}T00:00:00.000Z`);
  }
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function toIsoDateTime(ms) {
  return new Date(ms).toISOString();
}

function addDays(ms, days) {
  return ms + days * 24 * 60 * 60 * 1000;
}

function addYears(ms, years) {
  const date = new Date(ms);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.getTime();
}

function minIsoDate(a, b) {
  return a <= b ? a : b;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function integerInRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function readNowMs(now) {
  if (typeof now === "function") return now();
  if (Number.isFinite(now)) return now;
  return Date.now();
}

function isAborted(signal) {
  return Boolean(signal?.aborted);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
