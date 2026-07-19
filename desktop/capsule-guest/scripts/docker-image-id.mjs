import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCKER_IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAXIMUM_IMAGE_ID_BYTES = 128;

/** Read the immutable image identity emitted by `docker build --iidfile`. */
export async function readDockerImageId(pathValue) {
  const path = resolve(pathValue);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size < 1n
      || before.size > BigInt(MAXIMUM_IMAGE_ID_BYTES)
    ) throw new Error("Docker builder image ID is not a bounded single-link regular file");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error("Docker builder image ID changed while it was read");
    const source = bytes.toString("utf8");
    const imageId = source.endsWith("\n") ? source.slice(0, -1) : source;
    if (!DOCKER_IMAGE_ID_PATTERN.test(imageId) || (source !== imageId && source !== `${imageId}\n`)) {
      throw new Error("Docker builder did not emit one canonical immutable sha256 image ID");
    }
    return imageId;
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path] = process.argv.slice(2);
  if (!path || process.argv.length !== 3) {
    throw new Error("usage: docker-image-id.mjs <docker-iid-file>");
  }
  process.stdout.write(await readDockerImageId(path));
}
