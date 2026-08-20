# Oura time semantics

This connector preserves provider records under `payload.record`, but maps their
time fields into Lamarck event time according to the semantics of each Oura data
type. A `day` value is an Oura-assigned local date label, not a UTC timestamp.

## Provider behavior

Oura documents three different day buckets:

| Oura day type | Local-time interval | Date label |
| --- | --- | --- |
| Activity Day | 04:00 to the following 04:00 | The starting date |
| Calendar Day | 00:00 to the following 00:00 | The device-local calendar date |
| Sleep Day | Previous-day 18:00 to current-day 18:00 | The day receiving the primary sleep result |

Oura synchronizes the ring to the paired mobile device's local time when the app
and ring connect over Bluetooth. The API also interprets date query parameters in
the user's local timezone. The `day` field itself does not serialize that timezone
or offset.

In the connector QA data, `daily_activity.timestamp` consistently identifies the
local Activity Day boundary and includes the historical UTC offset. In contrast,
every observed `daily_sleep.timestamp` and `daily_readiness.timestamp` is UTC
midnight, regardless of the user's actual timezone. The connector therefore
treats those UTC-midnight values as date markers rather than event instants.

## Lamarck mapping

`D` below means `payload.record.day`. Ranges are half-open: the start is included
and the end is excluded.

| Streams | Mapping to `started_at` / `ended_at` |
| --- | --- |
| `daily_activity` | Preserve the provider `timestamp` as an instant; do not synthesize an end. |
| `daily_sleep`, `daily_readiness`, `daily_spo2` | Sleep Day: `[D-1 18:00, D 18:00)`. Ignore a UTC-midnight daily marker. |
| `daily_stress`, `daily_resilience`, `daily_cardiovascular_age`, `sleep_time` | Calendar Day: `[D 00:00, D+1 00:00)`. |
| `vo2_max` | Preserve the provider `timestamp`; use Calendar Day only if the timestamp is absent. |
| Other streams | Keep their existing stream-specific provider timestamp mappings; this document does not redefine them. |

The day-bucket association in this table is a connector interpretation of Oura's
documented product semantics. It is intentionally stream-specific; do not replace
it with one generic rule for every object containing `day` or `timestamp`.

## Timezone evidence and missing records

The connector extracts the offset from each `daily_activity.timestamp` and stores
it by `daily_activity.day` in connector state. Calendar Day records require the
offset for `D`. Sleep Day records require offsets for both `D-1` and `D`, allowing
travel and offset changes across the range to remain visible.

If the required offset evidence is unavailable, the connector:

1. skips the record instead of inventing a UTC range;
2. retains a `calendar-day-timezone` warning with the stream and day;
3. advances incremental and backfill cursors so later ingestion is not blocked;
4. clears that unresolved entry if the record is seen again with sufficient
   evidence.

Existing D0 events are append-only and are not rewritten when this mapping changes.
Historical validation therefore requires a fresh ingestion target.

## References

- [Oura: Understanding the Different Types of Oura Days](https://partnersupport.ouraring.com/hc/en-us/articles/29040334963219-Understanding-the-Different-Types-of-Oura-Days-in-Oura-Teams)
- [Oura General FAQs: time zone changes](https://support.ouraring.com/hc/en-us/articles/4408961184147-General-FAQs)
- [Oura API V2 documentation](https://cloud.ouraring.com/v2/docs)
