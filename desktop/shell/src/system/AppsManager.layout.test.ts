import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("./AppsManager.module.css", import.meta.url), "utf8");

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

  test("gives the selected App one stable scroll area for management and secondary tabs", () => {
    expect(declarationsFor(".appDetails")).toMatch(/min-height:\s*0/);
    expect(declarationsFor(".appDetails")).toMatch(/overflow-y:\s*auto/);
    expect(declarationsFor(".appDetails")).toMatch(/scrollbar-gutter:\s*stable/);
    expect(css).not.toContain(".versionPane");
  });

  test("switches to a stacked selected-App drill-in at narrow widths", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.appsManager\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.appMasterList\s*\{[^}]*overflow-x:\s*auto/);
  });
});
