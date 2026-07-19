import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { StreamKind } from "./types";
import {
  validateOpaqueId,
  validateSessionId,
  validateStreamTicket,
} from "./validate";

const MAX_TICKET_TTL_MS = 60_000;
declare const CONSUMED_TICKET: unique symbol;
// A consumed binding is authority, not merely structured data. Branding it in
// a module-private WeakSet means object spread, structuredClone, JSON, and a
// caller-created lookalike cannot manufacture that authority.
const consumedTicketBindings = new WeakSet<object>();

export type TicketErrorCode =
  | "TICKET_DUPLICATE"
  | "TICKET_UNKNOWN"
  | "TICKET_EXPIRED"
  | "TICKET_SESSION_MISMATCH"
  | "TICKET_KIND_MISMATCH"
  | "TICKET_INVALID_KIND"
  | "TICKET_INVALID_TTL";

export class TicketError extends Error {
  readonly code: TicketErrorCode;

  constructor(code: TicketErrorCode, message: string) {
    super(message);
    this.name = "TicketError";
    this.code = code;
  }
}

export interface Clock {
  now(): number;
}

export interface TicketBinding {
  ticket: string;
  sessionId: string;
  kind: StreamKind;
  appHandle: string;
  subjectHandle: string;
  expiresAt: number;
}

export interface ConsumedTicketBinding extends TicketBinding {
  readonly [CONSUMED_TICKET]: true;
}

export interface IssueTicketOptions {
  sessionId: string;
  kind: StreamKind;
  appHandle: string;
  subjectHandle: string;
  ttlMs: number;
  ticket?: string;
}

export class TicketRegistry {
  private readonly tickets = new Map<string, TicketBinding>();

  constructor(private readonly clock: Clock = { now: () => performance.now() }) {}

  get size(): number {
    return this.tickets.size;
  }

  issue(options: IssueTicketOptions): TicketBinding {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > MAX_TICKET_TTL_MS) {
      throw new TicketError(
        "TICKET_INVALID_TTL",
        `Ticket TTL must be between 1 and ${MAX_TICKET_TTL_MS} milliseconds`,
      );
    }
    assertStreamKind(options.kind);
    const ticket = validateStreamTicket(options.ticket ?? generateStreamTicket(), "ticket");
    if (this.tickets.has(ticket)) {
      throw new TicketError("TICKET_DUPLICATE", "Stream ticket is already registered");
    }
    const binding: TicketBinding = {
      ticket,
      sessionId: validateSessionId(options.sessionId, "sessionId"),
      kind: options.kind,
      appHandle: validateOpaqueId(options.appHandle, "appHandle"),
      subjectHandle: validateOpaqueId(options.subjectHandle, "subjectHandle"),
      expiresAt: this.clock.now() + options.ttlMs,
    };
    this.tickets.set(ticket, binding);
    return { ...binding };
  }

  consume(ticketValue: unknown, sessionValue: unknown, kind: StreamKind): ConsumedTicketBinding {
    assertStreamKind(kind);
    const ticket = validateStreamTicket(ticketValue, "ticket");
    const sessionId = validateSessionId(sessionValue, "sessionId");
    const binding = this.tickets.get(ticket);
    if (!binding) throw new TicketError("TICKET_UNKNOWN", "Unknown or already-consumed stream ticket");
    if (binding.expiresAt <= this.clock.now()) {
      this.tickets.delete(ticket);
      throw new TicketError("TICKET_EXPIRED", "Stream ticket has expired");
    }
    if (binding.sessionId !== sessionId) {
      throw new TicketError("TICKET_SESSION_MISMATCH", "Stream ticket belongs to another session");
    }
    if (binding.kind !== kind) {
      throw new TicketError("TICKET_KIND_MISMATCH", "Stream ticket has a different channel kind");
    }
    this.tickets.delete(ticket);
    const consumed = Object.freeze({ ...binding }) as ConsumedTicketBinding;
    consumedTicketBindings.add(consumed);
    return consumed;
  }

  revokeSession(sessionValue: unknown): number {
    const sessionId = validateSessionId(sessionValue, "sessionId");
    let revoked = 0;
    for (const [ticket, binding] of this.tickets) {
      if (binding.sessionId !== sessionId) continue;
      this.tickets.delete(ticket);
      revoked += 1;
    }
    return revoked;
  }

  /** Revoke exactly one still-unconsumed ticket. Unknown/consumed is idempotent. */
  revoke(ticketValue: unknown): boolean {
    const ticket = validateStreamTicket(ticketValue, "ticket");
    return this.tickets.delete(ticket);
  }

  cleanupExpired(): number {
    const now = this.clock.now();
    let removed = 0;
    for (const [ticket, binding] of this.tickets) {
      if (binding.expiresAt > now) continue;
      this.tickets.delete(ticket);
      removed += 1;
    }
    return removed;
  }
}

export function assertConsumedTicketBinding(
  value: unknown,
): asserts value is ConsumedTicketBinding {
  if (
    typeof value !== "object"
    || value === null
    || !consumedTicketBindings.has(value)
  ) {
    throw new TicketError("TICKET_UNKNOWN", "SDK channel does not carry a consumed ticket");
  }
}

export function generateOpaqueId(): string {
  return randomBytes(16).toString("base64url");
}

export function generateStreamTicket(): string {
  return randomBytes(32).toString("base64url");
}

function assertStreamKind(value: unknown): asserts value is StreamKind {
  if (![
    "sdk",
    "viewer",
    "package-in",
    "dependency-in",
    "artifact-in",
    "artifact-out",
    "logs",
  ].includes(value as string)) {
    throw new TicketError("TICKET_INVALID_KIND", "Unknown stream ticket kind");
  }
}
