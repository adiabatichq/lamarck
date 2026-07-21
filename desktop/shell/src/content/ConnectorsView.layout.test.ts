import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("./ConnectorsView.module.css", import.meta.url), "utf8");

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

describe("Source Console scrolling contract", () => {
  test("keeps the ledger scrollable instead of shrinking every Source card", () => {
    expect(declarationsFor(".ledger")).toMatch(/overflow-y:\s*auto/);
    expect(declarationsFor(".ledger")).toMatch(/min-height:\s*0/);
    expect(declarationsFor(".card")).toMatch(/flex:\s*0\s+0\s+auto/);
  });
});
