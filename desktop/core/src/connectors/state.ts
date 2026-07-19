import type { DatabaseSync } from "node:sqlite";
import type {
  ConnectorIntegration,
  ConnectorIntegrationStatus,
  ConnectorRequirementRecord,
  ConnectorRunRecord,
  ConnectorRunStatus,
  ConnectorRunTrigger,
  ConnectorSetupStatus,
  ConnectorTrustStatus,
  ConnectorWarningInput,
  ConnectorWarningRecord,
} from "./types";
import { validateConnectorId, validateIntegrationKey } from "./manifest";
import { ulid } from "../utils/ulid";

interface IntegrationRow {
  id: string;
  connector_id: string;
  integration_key: string | null;
  status: ConnectorIntegrationStatus;
  setup_status: ConnectorSetupStatus;
  trust_status: ConnectorTrustStatus;
  schedule_cron: string | null;
  next_run_at: number | null;
  paused_at: number | null;
  resume_at: number | null;
  package_hash: string | null;
  config: string | null;
  sync_state: string | null;
  requirements_status: string | null;
  auth_ref: string | null;
  last_error: string | null;
  warnings: string | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  integration_id: string;
  connector_id: string;
  integration_key: string | null;
  trigger: ConnectorRunTrigger;
  status: ConnectorRunStatus;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  error: string | null;
}

export interface EnsureIntegrationInput<TConfig = unknown> {
  id?: string;
  connectorId: string;
  integrationKey?: string;
  setupStatus?: ConnectorSetupStatus;
  trustStatus?: ConnectorTrustStatus;
  scheduleCron?: string | null;
  nextRunAt?: number | null;
  packageHash?: string;
  config?: TConfig;
  authRef?: string;
}

export type UpdateIntegrationInput<TConfig = unknown> = Omit<
  EnsureIntegrationInput<TConfig>,
  "id" | "connectorId"
>;

export class ConnectorIntegrationStore {
  constructor(private systemDb: DatabaseSync) {}

  ensure<TConfig = unknown, TState = unknown>(
    input: EnsureIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    validateConnectorId(input.connectorId);
    const integrationKey = normalizeIntegrationKey(input.integrationKey);

    const existing = input.id
      ? this.get<TConfig, TState>(input.id)
      : this.getByIdentity<TConfig, TState>(input.connectorId, integrationKey);
    const now = Date.now();
    if (existing) {
      if (existing.connectorId !== input.connectorId) {
        throw new Error(`Connector integration ${existing.id} belongs to ${existing.connectorId}`);
      }
      const nextConfig = input.config === undefined ? existing.config : input.config;
      const nextSetup = input.setupStatus ?? existing.setupStatus;
      const nextIntegrationKey = input.integrationKey === undefined
        ? existing.integrationKey
        : integrationKey;
      validateIntegrationKeyTransition(existing, nextIntegrationKey);
      this.assertIdentityAvailable(existing.connectorId, nextIntegrationKey, existing.id);
      // A setup-gate failure can leave an observed run error. Once that same
      // source becomes ready again, clear the stale operational error; errors
      // from an otherwise-ready run remain visible until Retry.
      const recoveredFromSetup = existing.status === "error"
        && existing.setupStatus === "setup"
        && nextSetup === "ready";
      const nextStatus: ConnectorIntegrationStatus = recoveredFromSetup ? "idle" : existing.status;
      // Recovery into idle clears the stale failure message; a preserved run
      // error keeps its message.
      const nextLastError = nextStatus === "idle" && existing.status !== "idle"
        ? null
        : existing.lastError ?? null;
      const nextScheduleCron = input.scheduleCron === undefined
        ? existing.scheduleCron
        : input.scheduleCron ?? undefined;
      const nextRunAt = input.nextRunAt === undefined
        ? existing.nextRunAt
        : input.nextRunAt ?? undefined;
      const nextPackageHash = input.packageHash ?? existing.packageHash;
      const nextTrustStatus = input.trustStatus ?? existing.trustStatus;
      const nextAuthRef = input.authRef ?? existing.authRef ?? defaultAuthRef(existing.id);
      this.systemDb.prepare(
        `UPDATE connector_integrations
         SET integration_key = ?,
             status = ?,
             setup_status = ?,
             trust_status = ?,
             schedule_cron = ?,
             next_run_at = ?,
             package_hash = ?,
             config = ?,
             auth_ref = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        nextIntegrationKey ?? null,
        nextStatus,
        nextSetup,
        nextTrustStatus,
        nextScheduleCron ?? null,
        nextRunAt ?? null,
        nextPackageHash ?? null,
        stringifyJson(nextConfig),
        nextAuthRef ?? null,
        nextLastError,
        now,
        existing.id,
      );
      return this.get<TConfig, TState>(existing.id)!;
    }

    const id = input.id ?? newIntegrationId();
    const setupStatus = input.setupStatus ?? "ready";
    const status: ConnectorIntegrationStatus = "idle";
    this.systemDb.prepare(
      `INSERT INTO connector_integrations
       (id, connector_id, integration_key, status, setup_status, trust_status,
        schedule_cron, next_run_at, paused_at, resume_at, package_hash, config, sync_state, auth_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.connectorId,
      integrationKey ?? null,
      status,
      setupStatus,
      input.trustStatus ?? "missing",
      input.scheduleCron ?? null,
      input.nextRunAt ?? null,
      null,
      null,
      input.packageHash ?? null,
      stringifyJson(input.config),
      null,
      input.authRef ?? defaultAuthRef(id),
      now,
      now,
    );
    return this.get<TConfig, TState>(id)!;
  }

  update<TConfig = unknown, TState = unknown>(
    id: string,
    input: UpdateIntegrationInput<TConfig>,
  ): ConnectorIntegration<TConfig, TState> {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Connector integration not found: ${id}`);
    }
    return this.ensure<TConfig, TState>({
      ...input,
      id,
      connectorId: existing.connectorId,
    });
  }

  get<TConfig = unknown, TState = unknown>(
    id: string,
  ): ConnectorIntegration<TConfig, TState> | undefined {
    const row = this.systemDb.prepare("SELECT * FROM connector_integrations WHERE id = ?").get(id) as unknown as IntegrationRow | undefined;
    return row ? rowToIntegration<TConfig, TState>(row) : undefined;
  }

  getByIdentity<TConfig = unknown, TState = unknown>(
    connectorId: string,
    integrationKey?: string,
  ): ConnectorIntegration<TConfig, TState> | undefined {
    validateConnectorId(connectorId);
    const key = normalizeIntegrationKey(integrationKey);
    const row = key
      ? this.systemDb.prepare(
        `SELECT * FROM connector_integrations
         WHERE connector_id = ? AND integration_key = ?
         ORDER BY created_at
         LIMIT 1`
      ).get(connectorId, key) as unknown as IntegrationRow | undefined
      : this.systemDb.prepare(
        `SELECT * FROM connector_integrations
         WHERE connector_id = ? AND integration_key IS NULL
         ORDER BY created_at
         LIMIT 1`
      ).get(connectorId) as unknown as IntegrationRow | undefined;
    return row ? rowToIntegration<TConfig, TState>(row) : undefined;
  }

  firstForConnector<TConfig = unknown, TState = unknown>(
    connectorId: string,
  ): ConnectorIntegration<TConfig, TState> | undefined {
    validateConnectorId(connectorId);
    const row = this.systemDb.prepare(
      `SELECT * FROM connector_integrations
       WHERE connector_id = ?
       ORDER BY created_at
       LIMIT 1`
    ).get(connectorId) as unknown as IntegrationRow | undefined;
    return row ? rowToIntegration<TConfig, TState>(row) : undefined;
  }

  delete(id: string): boolean {
    const result = this.systemDb.prepare("DELETE FROM connector_integrations WHERE id = ?").run(id);
    return result.changes > 0;
  }

  list(): ConnectorIntegration[] {
    return (this.systemDb.prepare("SELECT * FROM connector_integrations ORDER BY connector_id, integration_key").all() as unknown as IntegrationRow[])
      .map((row) => rowToIntegration(row));
  }

  pause(id: string, resumeAt?: number): ConnectorIntegration {
    const existing = this.get(id);
    if (!existing) throw new Error(`Connector integration not found: ${id}`);
    const now = Date.now();
    if (resumeAt !== undefined && (!Number.isFinite(resumeAt) || resumeAt <= now)) {
      throw new Error("Connector pause resumeAt must be in the future");
    }
    this.systemDb.prepare(
      `UPDATE connector_integrations
       SET paused_at = ?, resume_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(now, resumeAt ?? null, now, id);
    return this.get(id)!;
  }

  resume(id: string): ConnectorIntegration {
    const existing = this.get(id);
    if (!existing) throw new Error(`Connector integration not found: ${id}`);
    this.systemDb.prepare(
      `UPDATE connector_integrations
       SET paused_at = NULL, resume_at = NULL, updated_at = ?
       WHERE id = ?`
    ).run(Date.now(), id);
    return this.get(id)!;
  }

  resumeExpired(now: number): number {
    return Number(this.systemDb.prepare(
      `UPDATE connector_integrations
       SET paused_at = NULL, resume_at = NULL, updated_at = ?
       WHERE paused_at IS NOT NULL AND resume_at IS NOT NULL AND resume_at <= ?`
    ).run(now, now).changes);
  }

  recoverInterruptedRuns(now = Date.now()): void {
    this.systemDb.prepare(
      `UPDATE connector_runs
       SET status = 'aborted',
           ended_at = ?,
           duration_ms = MAX(0, ? - started_at),
           error = COALESCE(error, 'Core restarted before the run completed')
       WHERE status = 'running'`
    ).run(now, now);
    this.systemDb.prepare(
      `UPDATE connector_integrations
       SET status = 'idle', updated_at = ?
       WHERE status = 'running'`
    ).run(now);
  }

  createRun(input: {
    integration: ConnectorIntegration;
    trigger: ConnectorRunTrigger;
    startedAt?: number;
  }): ConnectorRunRecord {
    const startedAt = input.startedAt ?? Date.now();
    const id = newRunId();
    this.systemDb.prepare(
      `INSERT INTO connector_runs
       (id, integration_id, connector_id, integration_key, trigger, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`
    ).run(
      id,
      input.integration.id,
      input.integration.connectorId,
      input.integration.integrationKey ?? null,
      input.trigger,
      startedAt,
    );
    this.pruneRuns(input.integration.id);
    return this.getRun(id)!;
  }

  finishRun(id: string, status: Exclude<ConnectorRunStatus, "running">, error?: string): ConnectorRunRecord | undefined {
    const existing = this.getRun(id);
    if (!existing) return undefined;
    const endedAt = Date.now();
    this.systemDb.prepare(
      `UPDATE connector_runs
       SET status = ?, ended_at = ?, duration_ms = ?, error = ?
       WHERE id = ?`
    ).run(
      status,
      endedAt,
      Math.max(0, endedAt - existing.startedAt),
      error ?? null,
      id,
    );
    return this.getRun(id);
  }

  listRuns(integrationId: string, limit = 8): ConnectorRunRecord[] {
    return (this.systemDb.prepare(
      `SELECT * FROM connector_runs
       WHERE integration_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`
    ).all(integrationId, limit) as unknown as RunRow[]).map(rowToRun);
  }

  setState<TState>(id: string, state: TState): void {
    this.updateJsonColumn(id, "sync_state", state);
  }

  setRequirementsStatus(id: string, value: Record<string, ConnectorRequirementRecord>): void {
    this.updateJsonColumn(id, "requirements_status", value);
  }

  setWarning(id: string, input: ConnectorWarningInput): void {
    const warning = normalizeWarningInput(input);
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Connector integration not found: ${id}`);
    }

    const now = Date.now();
    const warnings = [...(existing.warnings ?? [])];
    const index = warnings.findIndex((record) => record.key === warning.key);
    const nextRecord: ConnectorWarningRecord = {
      ...warning,
      firstSeenAt: index >= 0 ? warnings[index].firstSeenAt : now,
      lastSeenAt: now,
    };

    if (index >= 0) {
      warnings[index] = nextRecord;
    } else {
      warnings.push(nextRecord);
    }
    this.setWarnings(id, warnings);
  }

  clearWarning(id: string, key: string): void {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Connector integration not found: ${id}`);
    }
    const warnings = existing.warnings ?? [];
    const next = warnings.filter((record) => record.key !== key);
    if (next.length === warnings.length) return;
    this.setWarnings(id, next);
  }

  // Explicit recovery from a run error: back to idle, stale failure message and
  // pending schedule cleared so the scheduler picks the integration up fresh.
  resetErrorToIdle(id: string): void {
    this.systemDb.prepare(
      `UPDATE connector_integrations
       SET status = 'idle', last_error = NULL, next_run_at = NULL, updated_at = ?
       WHERE id = ?`
    ).run(Date.now(), id);
  }

  setStatus(id: string, status: ConnectorIntegrationStatus, error?: string): void {
    const now = Date.now();
    this.systemDb.prepare(
      `UPDATE connector_integrations
       SET status = ?, last_error = ?, updated_at = ?, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END
       WHERE id = ?`
    ).run(status, error ?? null, now, status === "idle" ? 1 : 0, now, id);
  }

  setTrustForConnector(connectorId: string, trustStatus: ConnectorTrustStatus, packageHash?: string): void {
    validateConnectorId(connectorId);
    this.systemDb.prepare(
      `UPDATE connector_integrations
       SET trust_status = ?, package_hash = COALESCE(?, package_hash), updated_at = ?
       WHERE connector_id = ?`
    ).run(trustStatus, packageHash ?? null, Date.now(), connectorId);
  }

  private updateJsonColumn(id: string, column: "config" | "sync_state" | "requirements_status", value: unknown): void {
    this.systemDb.prepare(
      `UPDATE connector_integrations SET ${column} = ?, updated_at = ? WHERE id = ?`
    ).run(stringifyJson(value), Date.now(), id);
  }

  private setWarnings(id: string, warnings: ConnectorWarningRecord[]): void {
    this.systemDb.prepare(
      `UPDATE connector_integrations SET warnings = ?, updated_at = ? WHERE id = ?`
    ).run(stringifyJson(warnings.length ? warnings : undefined), Date.now(), id);
  }

  private assertIdentityAvailable(
    connectorId: string,
    integrationKey: string | undefined,
    currentId: string,
  ): void {
    if (!integrationKey) return;
    const existing = this.getByIdentity(connectorId, integrationKey);
    if (existing && existing.id !== currentId) {
      throw new Error(`Connector integration key is already in use: ${connectorId}:${integrationKey}`);
    }
  }

  private getRun(id: string): ConnectorRunRecord | undefined {
    const row = this.systemDb.prepare("SELECT * FROM connector_runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  private pruneRuns(integrationId: string, keep = 50): void {
    this.systemDb.prepare(
      `DELETE FROM connector_runs
       WHERE integration_id = ?
         AND id NOT IN (
           SELECT id FROM connector_runs
           WHERE integration_id = ?
           ORDER BY started_at DESC, id DESC
           LIMIT ?
         )`
    ).run(integrationId, integrationId, keep);
  }
}

export function createConnectorStateHandle<TState>(
  store: ConnectorIntegrationStore,
  instanceId: string,
) {
  return {
    async get(): Promise<TState | undefined> {
      return store.get<unknown, TState>(instanceId)?.syncState;
    },
    async set(state: TState): Promise<void> {
      store.setState(instanceId, state);
    },
  };
}

export function newIntegrationId(): string {
  return ulid();
}

function newRunId(): string {
  return ulid();
}

export function defaultAuthRef(integrationId: string): string {
  return `connector-integration:${integrationId}:auth`;
}

function normalizeIntegrationKey(key: string | undefined): string | undefined {
  if (key === undefined || key === "") return undefined;
  validateIntegrationKey(key);
  return key;
}

function validateIntegrationKeyTransition(
  existing: ConnectorIntegration,
  nextKey: string | undefined,
): void {
  if (existing.integrationKey === nextKey) return;
  if (existing.integrationKey) {
    throw new Error("Connector integration key rename requires an explicit migration");
  }
  if (existing.setupStatus !== "setup") {
    throw new Error("Connector integration key can only be set during setup");
  }
}

function rowToIntegration<TConfig, TState>(row: IntegrationRow): ConnectorIntegration<TConfig, TState> {
  return {
    id: row.id,
    connectorId: row.connector_id,
    integrationKey: row.integration_key ?? undefined,
    pausedAt: row.paused_at ?? undefined,
    resumeAt: row.resume_at ?? undefined,
    status: normalizeObservedStatus(row.status),
    setupStatus: row.setup_status,
    trustStatus: row.trust_status,
    scheduleCron: row.schedule_cron ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    packageHash: row.package_hash ?? undefined,
    config: parseJson(row.config) as TConfig | undefined,
    syncState: parseJson(row.sync_state) as TState | undefined,
    requirementsStatus: parseJson(row.requirements_status) as
      | Record<string, ConnectorRequirementRecord>
      | undefined,
    authRef: row.auth_ref ?? undefined,
    lastError: row.last_error ?? undefined,
    warnings: normalizeWarningRecords(parseJson(row.warnings)),
    lastRunAt: row.last_run_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isIntegrationPaused(
  integration: Pick<ConnectorIntegration, "pausedAt" | "resumeAt">,
  now = Date.now(),
): boolean {
  return integration.pausedAt !== undefined
    && (integration.resumeAt === undefined || integration.resumeAt > now);
}

function normalizeObservedStatus(status: string): ConnectorIntegrationStatus {
  return status === "running" || status === "error" ? status : "idle";
}

function rowToRun(row: RunRow): ConnectorRunRecord {
  return {
    id: row.id,
    integrationId: row.integration_id,
    connectorId: row.connector_id,
    integrationKey: row.integration_key ?? undefined,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    error: row.error ?? undefined,
  };
}

function parseJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function normalizeWarningInput(input: ConnectorWarningInput): ConnectorWarningInput {
  if (!input || typeof input !== "object") {
    throw new Error("Connector warning must be an object");
  }
  const key = typeof input.key === "string" ? input.key.trim() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!key) throw new Error("Connector warning key is required");
  if (!message) throw new Error("Connector warning message is required");
  const warning: ConnectorWarningInput = { key, message };
  if (input.details !== undefined) warning.details = input.details;
  return warning;
}

function normalizeWarningRecords(value: unknown): ConnectorWarningRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records = value.filter(isWarningRecord);
  return records.length ? records : undefined;
}

function isWarningRecord(value: unknown): value is ConnectorWarningRecord {
  return Boolean(
    value
      && typeof value === "object"
      && typeof (value as ConnectorWarningRecord).key === "string"
      && typeof (value as ConnectorWarningRecord).message === "string"
      && Number.isFinite((value as ConnectorWarningRecord).firstSeenAt)
      && Number.isFinite((value as ConnectorWarningRecord).lastSeenAt),
  );
}
