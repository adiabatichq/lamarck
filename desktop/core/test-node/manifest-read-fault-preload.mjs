import {
  fstatSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";

const controlPath = process.env.LAMARCK_TEST_MANIFEST_READ_FAULT_CONTROL;
const targetPath = process.env.LAMARCK_TEST_MANIFEST_READ_FAULT_TARGET;

if (!controlPath || !targetPath) {
  throw new Error("manifest read fault preload requires exact control and target paths");
}

const probe = await open(targetPath, "r");
const fileHandlePrototype = Object.getPrototypeOf(probe);
const originalReadFile = fileHandlePrototype.readFile;
await probe.close();

fileHandlePrototype.readFile = async function (...args) {
  let code;
  try {
    code = readFileSync(controlPath, "utf8").trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (code === "EIO" || code === "EACCES") {
    const opened = fstatSync(this.fd, { bigint: true });
    const target = statSync(targetPath, { bigint: true });
    if (opened.dev === target.dev && opened.ino === target.ino) {
      unlinkSync(controlPath);
      throw Object.assign(new Error(`injected manifest ${code}`), { code });
    }
  }

  return await Reflect.apply(originalReadFile, this, args);
};
