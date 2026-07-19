import { describe, expect, test } from "vitest";
import { HttpStatusError, readJsonBody } from "../src/http-body";

describe("Node Core JSON request body", () => {
  test("parses bounded JSON", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    await expect(readJsonBody(request, 64)).resolves.toEqual({ ok: true });
  });

  test("fails closed when a streamed body exceeds the cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/api", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readJsonBody(request, 8)).rejects.toMatchObject({ status: 413 } satisfies Partial<HttpStatusError>);
    expect(cancelled).toBe(true);
  });

  test("rejects invalid JSON as a client error", async () => {
    const request = new Request("http://localhost/api", { method: "POST", body: "{" });
    await expect(readJsonBody(request)).rejects.toMatchObject({ status: 400 } satisfies Partial<HttpStatusError>);
  });
});
