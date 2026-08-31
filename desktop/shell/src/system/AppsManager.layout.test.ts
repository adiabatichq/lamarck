import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("./SystemRoom.module.css", import.meta.url), "utf8");

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

describe("Apps Manager layout contract", () => {
  test("owns full-height master/detail space without leaking page scroll", () => {
    expect(declarationsFor(".appsManager")).toMatch(/height:\s*100%/);
    expect(declarationsFor(".appsManager")).toMatch(/min-height:\s*0/);
    expect(declarationsFor(".appsManager")).toMatch(/overflow:\s*hidden/);
  });

  test("keeps version history as the stable-gutter scroll owner", () => {
    expect(declarationsFor(".versionScroll")).toMatch(/min-height:\s*0/);
    expect(declarationsFor(".versionScroll")).toMatch(/overflow-y:\s*auto/);
    expect(declarationsFor(".versionScroll")).toMatch(/scrollbar-gutter:\s*stable/);
    expect(css).toMatch(/\.versionPane\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/);
  });

  test("switches to a stacked selected-App drill-in at narrow widths", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.appsManager\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.appMasterList\s*\{[^}]*overflow-x:\s*auto/);
  });
});
