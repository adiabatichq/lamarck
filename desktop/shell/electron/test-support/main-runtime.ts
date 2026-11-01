import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import { transformSync } from "esbuild";

// Execute Main's actual failure routing without booting Electron, accessing a
// real Workspace, or duplicating the policy under test in a fake callback.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set([
  "errorMessage", "markRuntimeFailed", "detachAllAppWebContents",
  "relaunchDesktopAfterFailedCleanup", "scheduleRuntimeRestart",
  "beginUnexpectedCoreTeardown", "beginUnexpectedGuardTeardown",
]);
const functions = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
const declaration = source.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  .find(node => node.name.getText(source) === "capsuleManager");
const initializer = declaration?.initializer;
if (!initializer || !ts.isNewExpression(initializer)) throw new Error("Main CapsuleManager construction is missing");
const options = initializer.arguments?.[0];
if (!options || !ts.isObjectLiteralExpression(options)) throw new Error("Main CapsuleManager options are missing");
const callback = options.properties.find(node => node.name?.getText(source) === "onBackendBoundaryLost");
if (!callback || functions.length !== names.size) throw new Error("Main runtime lifecycle is missing");
const script = new Script(transformSync([
  ...functions.map(node => node.getText(source)),
  `({ ${callback.getText(source)}, beginUnexpectedCoreTeardown, beginUnexpectedGuardTeardown })`,
].join("\n"), { loader: "ts", target: "node24" }).code, { filename: "main-runtime-test.js" });

export function loadMainRuntimeLifecycle(bindings: Record<string, unknown>): {
  onBackendBoundaryLost(error: unknown): void;
  beginUnexpectedCoreTeardown(child: object, generation: number, reason: string): void;
  beginUnexpectedGuardTeardown(child: object, generation: number, reason: string): void;
} {
  return script.runInNewContext({ Error, AggregateError, ...bindings });
}
