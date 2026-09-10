import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { materializeCapsuleTree } from "./tree-materializer";
import { validateDependencyBundle } from "./dependency-bundle";
import { chownTree, evaluateInstallInputAt, validateBuildInput, validateInstalledSystemSdk,
  validateSealableTree, ErofsArtifactSealer } from "./build-manager";
import type { BuildPhaseRequest } from "./build-phase-runner";

async function execute(request: BuildPhaseRequest): Promise<unknown> {
  switch (request.op) {
    case "materialize": {
      const file = await open(request.source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await materializeCapsuleTree(file.createReadStream({ autoClose: false }), request.destination); }
      finally { await file.close(); }
      return null;
    }
    case "validate-input": return validateBuildInput(request.workspace, request.installDigest);
    case "install-input": return evaluateInstallInputAt(request.workspace);
    case "validate-dependencies": await validateDependencyBundle(request.directory); return null;
    case "validate-sdk": await validateInstalledSystemSdk(request.nodeModules); return null;
    case "chown": await chownTree(request.root, request.uid, request.gid); return null;
    case "seal":
      await validateSealableTree(request.workspace);
      return new ErofsArtifactSealer(request.mkfsPath).seal(request.workspace, request.output,
        undefined, { readonlyNodeModules: request.warm });
  }
}

// Only the fixed native trampoline invokes this trusted program. No App code
// is imported here; npm lifecycle scripts execute in the separate OCI child.
const input = process.argv[2] ?? "";
if (Buffer.byteLength(input) > 16_384) throw new Error("Oversized worker request");
try {
  const result = await execute(JSON.parse(input));
  const output = JSON.stringify({ result: result ?? null });
  if (Buffer.byteLength(output) > 32_768) throw new Error("Oversized worker result");
  process.stdout.write(output);
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error).slice(0, 4_096),
    code: (error as { code?: string }).code }));
}
