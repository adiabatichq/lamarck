import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";
import {
  createProductionDrivers,
  DriverUnavailableError,
  UnavailableRuncDriver,
  UnavailableVmBackend,
  type RuncLaunchRequest,
} from "../src/drivers";
import { createOciBundlePlan } from "../src/oci/plan";
import { TicketRegistry } from "../src/protocol/tickets";
import { FakeClock, FakeRuncDriver, FakeVmBackend } from "../src/testing/fakes";

const APP_HANDLE = "A".repeat(22);
const WORKLOAD_HANDLE = "W".repeat(22);
const SESSION_ID = "S".repeat(43);
const SDK_TICKET = "T".repeat(43);
const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;

describe("Capsule driver boundary", () => {
  test("production construction never falls back to direct Host execution", async () => {
    const drivers = createProductionDrivers();
    expect(drivers.runc.available).toBe(false);
    expect(drivers.vm.available).toBe(false);
    await expect(drivers.runc.start(launchRequest())).rejects.toMatchObject({
      code: "CAPSULE_DRIVER_UNAVAILABLE",
      driver: "runc",
    });
    await expect(drivers.vm.boot()).rejects.toMatchObject({
      code: "CAPSULE_DRIVER_UNAVAILABLE",
      driver: "vm",
    });
  });

  test("explicit unavailable drivers fail every mutating entry point", async () => {
    const runc = new UnavailableRuncDriver("test runtime absent");
    const vm = new UnavailableVmBackend("test hypervisor absent");
    await expect(runc.stop("w-dead", 100)).rejects.toBeInstanceOf(DriverUnavailableError);
    await expect(runc.delete("w-dead")).rejects.toBeInstanceOf(DriverUnavailableError);
    await expect(vm.boot()).rejects.toBeInstanceOf(DriverUnavailableError);
  });

  test("fake drivers are opt-in and record validated plans deterministically", async () => {
    const runc = new FakeRuncDriver();
    runc.enqueueExit({ exitCode: 7, signal: null });
    const request = launchRequest();
    const execution = await runc.start(request);
    expect(await execution.wait()).toEqual({ exitCode: 7, signal: null });
    await runc.stop(execution.containerId, 250);
    await runc.delete(execution.containerId);
    expect(runc.calls.map((call) => call.type)).toEqual(["start", "stop", "delete"]);
    expect(runc.calls[0]).toMatchObject({
      type: "start",
      request: {
        sdkChannel: {
          source: expect.any(PassThrough),
          consumedTicket: {
            appHandle: APP_HANDLE,
            subjectHandle: WORKLOAD_HANDLE,
          },
        },
      },
    });

    const vm = new FakeVmBackend();
    const instance = await vm.boot();
    await instance.stop();
    expect(vm.calls).toEqual([
      { type: "boot" },
      { type: "stop", instanceId: "fake-vm-1" },
    ]);
  });

  test("fails closed unless the SDK bridge is backed by the consumed per-launch ticket", async () => {
    const runc = new FakeRuncDriver();
    const valid = launchRequest();
    const unconsumedClone = {
      ...valid,
      plan: structuredClone(valid.plan),
      expectedIdentity: structuredClone(valid.expectedIdentity),
      sdkChannel: {
        ...valid.sdkChannel,
        source: new PassThrough(),
        consumedTicket: { ...valid.sdkChannel.consumedTicket },
      },
    } as RuncLaunchRequest;
    await expect(runc.start(unconsumedClone)).rejects.toThrow(/consumed ticket/);

    const anotherWorkload = {
      ...launchRequest(),
      expectedIdentity: {
        ...launchRequest().expectedIdentity,
        workloadHandle: "X".repeat(22),
      },
    };
    await expect(runc.start(anotherWorkload)).rejects.toThrow(/container ID is not bound/);
  });
});

function plan() {
  return createOciBundlePlan({
    appHandle: APP_HANDLE,
    workloadHandle: WORKLOAD_HANDLE,
    workloadKind: "job",
    artifactDigest: ARTIFACT_DIGEST,
    mappedHostUid: 100_000,
    mappedHostGid: 200_000,
    argv: ["node", "job.mjs"],
    cwd: "/app",
    environment: {},
  });
}

function launchRequest(): RuncLaunchRequest {
  const tickets = new TicketRegistry(new FakeClock(0));
  tickets.issue({
    sessionId: SESSION_ID,
    kind: "sdk",
    appHandle: APP_HANDLE,
    subjectHandle: WORKLOAD_HANDLE,
    ttlMs: 1_000,
    ticket: SDK_TICKET,
  });
  const consumedTicket = tickets.consume(SDK_TICKET, SESSION_ID, "sdk");
  return {
    plan: plan(),
    expectedIdentity: {
      appHandle: APP_HANDLE,
      workloadHandle: WORKLOAD_HANDLE,
      workloadKind: "job",
      artifactDigest: ARTIFACT_DIGEST,
      mappedHostUid: 100_000,
      mappedHostGid: 200_000,
      argv: ["node", "job.mjs"],
      cwd: "/app",
      environment: {},
      resources: {
        memoryBytes: 512 * 1024 * 1024,
        pids: 256,
        cpuQuotaMicros: 100_000,
      },
    },
    sessionId: SESSION_ID,
    sdkChannel: {
      source: new PassThrough(),
      consumedTicket,
    },
  };
}
