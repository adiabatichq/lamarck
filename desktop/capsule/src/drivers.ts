import {
  assertOciSecurityInvariants,
  type OciBundlePlan,
  type OciExpectedIdentity,
} from "./oci/plan";
import {
  assertConsumedTicketBinding,
  type ConsumedTicketBinding,
} from "./protocol/tickets";
import type { Duplex } from "node:stream";

export class DriverUnavailableError extends Error {
  readonly code = "CAPSULE_DRIVER_UNAVAILABLE";
  readonly driver: "runc" | "vm";

  constructor(driver: "runc" | "vm", reason: string) {
    super(`${driver} driver unavailable: ${reason}`);
    this.name = "DriverUnavailableError";
    this.driver = driver;
  }
}

export interface WorkloadExit {
  exitCode: number | null;
  signal: string | null;
}

export interface RuncExecution {
  readonly containerId: string;
  wait(): Promise<WorkloadExit>;
}

export interface RuncLaunchRequest {
  readonly plan: OciBundlePlan;
  readonly expectedIdentity: OciExpectedIdentity;
  readonly sessionId: string;
  readonly sdkChannel: {
    /** Already ticket-authenticated Host stream retained by the Guest bridge. */
    readonly source: Duplex;
    readonly consumedTicket: ConsumedTicketBinding;
  };
  readonly cliChannel: {
    /** Already ticket-authenticated Host stream for fixed private App CLI operations. */
    readonly source: Duplex;
    readonly consumedTicket: ConsumedTicketBinding;
  };
  readonly logsChannel?: {
    /** Authenticated raw stdout/stderr sink; the driver never interprets it. */
    readonly source: Duplex;
    readonly consumedTicket: ConsumedTicketBinding;
  };
  readonly signal?: AbortSignal;
}

export interface RuncDriver {
  readonly available: boolean;
  start(request: RuncLaunchRequest): Promise<RuncExecution>;
  stop(containerId: string, graceMs: number): Promise<void>;
  delete(containerId: string): Promise<void>;
}

export interface CapsuleVmInstance {
  readonly instanceId: string;
  stop(): Promise<void>;
}

export interface CapsuleVmBackend {
  readonly available: boolean;
  boot(): Promise<CapsuleVmInstance>;
}

/**
 * This slice deliberately ships no production execution fallback. In
 * particular, it never runs an App directly on the Host when runc or the VM
 * backend is absent.
 */
export class UnavailableRuncDriver implements RuncDriver {
  readonly available = false;

  constructor(private readonly reason = "real runc integration has not been installed") {}

  async start(_request: RuncLaunchRequest): Promise<RuncExecution> {
    throw new DriverUnavailableError("runc", this.reason);
  }

  async stop(_containerId: string, _graceMs: number): Promise<void> {
    throw new DriverUnavailableError("runc", this.reason);
  }

  async delete(_containerId: string): Promise<void> {
    throw new DriverUnavailableError("runc", this.reason);
  }
}

/** Validate every attribution carried across the eventual runc spawn boundary. */
export function assertRuncLaunchRequest(
  request: RuncLaunchRequest,
): void {
  assertOciSecurityInvariants(request.plan, request.expectedIdentity);
  assertConsumedTicketBinding(request.sdkChannel.consumedTicket);
  if (
    typeof request.sdkChannel.source !== "object"
    || request.sdkChannel.source === null
    || typeof request.sdkChannel.source.on !== "function"
    || typeof request.sdkChannel.source.pipe !== "function"
    || request.sdkChannel.source.destroyed
  ) {
    throw new Error("SDK channel source must be an open authenticated stream");
  }
  const ticket = request.sdkChannel.consumedTicket;
  if (ticket.kind !== "sdk") throw new Error("SDK bridge is not bound to an SDK ticket");
  if (ticket.sessionId !== request.sessionId) {
    throw new Error("SDK bridge belongs to another VM session");
  }
  if (ticket.appHandle !== request.expectedIdentity.appHandle) {
    throw new Error("SDK bridge belongs to another App");
  }
  if (ticket.subjectHandle !== request.expectedIdentity.workloadHandle) {
    throw new Error("SDK bridge belongs to another workload");
  }
  assertConsumedTicketBinding(request.cliChannel.consumedTicket);
  if (
    typeof request.cliChannel.source !== "object"
    || request.cliChannel.source === null
    || typeof request.cliChannel.source.pipe !== "function"
    || request.cliChannel.source.destroyed
  ) throw new Error("App CLI channel source must be an open authenticated stream");
  const cliTicket = request.cliChannel.consumedTicket;
  if (
    cliTicket.kind !== "cli"
    || cliTicket.sessionId !== request.sessionId
    || cliTicket.appHandle !== request.expectedIdentity.appHandle
    || cliTicket.subjectHandle !== request.expectedIdentity.workloadHandle
  ) throw new Error("App CLI bridge belongs to another launch identity");
  if (request.logsChannel) {
    assertConsumedTicketBinding(request.logsChannel.consumedTicket);
    if (
      typeof request.logsChannel.source !== "object"
      || request.logsChannel.source === null
      || typeof request.logsChannel.source.write !== "function"
    ) {
      throw new Error("Logs channel source must be an open stream");
    }
    const logsTicket = request.logsChannel.consumedTicket;
    if (logsTicket.kind !== "logs") throw new Error("Logs stream is not bound to a logs ticket");
    if (
      logsTicket.sessionId !== request.sessionId
      || logsTicket.appHandle !== request.expectedIdentity.appHandle
      || logsTicket.subjectHandle !== request.expectedIdentity.workloadHandle
    ) {
      throw new Error("Logs stream belongs to another launch identity");
    }
  }
}

export class UnavailableVmBackend implements CapsuleVmBackend {
  readonly available = false;

  constructor(private readonly reason = "platform VM integration has not been installed") {}

  async boot(): Promise<CapsuleVmInstance> {
    throw new DriverUnavailableError("vm", this.reason);
  }
}

export function createProductionDrivers(): {
  runc: RuncDriver;
  vm: CapsuleVmBackend;
} {
  return {
    runc: new UnavailableRuncDriver(
      `no approved Guest runc adapter is bundled for ${process.platform}/${process.arch}`,
    ),
    vm: new UnavailableVmBackend(
      `no approved Capsule VM backend is bundled for ${process.platform}/${process.arch}`,
    ),
  };
}
