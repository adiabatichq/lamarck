import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadApps, type AppManifest } from "./app-loader";
import { PACKAGE_ID_PATTERN } from "./package-id";

export const APP_V1_SCAFFOLD_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "index.html",
  "index.tsx",
  "main.tsx",
] as const);

const APP_PACKAGE_NAME_TOKEN = "__LAMARCK_APP_PACKAGE_NAME__";
const APP_DISPLAY_NAME_TOKEN = "__LAMARCK_APP_NAME_JSON__";
const APP_HTML_TITLE_TOKEN = "__LAMARCK_APP_TITLE__";

export interface BlankAppScaffoldOptions {
  appsDir: string;
  scaffoldDir: string;
  id: string;
  name: string;
  description: string;
  initializeGit(appDir: string): Promise<void>;
}

export interface BlankAppScaffoldResult {
  dir: string;
  manifest: AppManifest;
}

/**
 * Creates one complete local App from the checked-in allowlisted scaffold.
 * The target directory is reserved with mkdir, every failure removes only
 * that newly created directory, and manifest.json is written last so Core
 * never observes a partially composed App as runnable authority.
 */
export async function instantiateBlankApp(
  options: BlankAppScaffoldOptions,
): Promise<BlankAppScaffoldResult> {
  validateIdentity(options.id, options.name, options.description);
  await mkdir(options.appsDir, { recursive: true });
  const appDir = join(options.appsDir, options.id);
  let ownsTarget = false;

  try {
    await mkdir(appDir, { recursive: false, mode: 0o755 });
    ownsTarget = true;

    for (const filename of APP_V1_SCAFFOLD_FILES) {
      const source = await readFile(join(options.scaffoldDir, filename));
      const rendered = renderScaffoldFile(filename, source, options.id, options.name);
      await writeFile(join(appDir, filename), rendered, {
        flag: "wx",
        mode: 0o644,
      });
    }

    try {
      await options.initializeGit(appDir);
    } catch (error) {
      console.warn(`[app-scaffold] Could not initialize git for ${options.id}:`, error);
    }

    const manifest: AppManifest = {
      manifestVersion: 1,
      id: options.id,
      name: options.name,
      description: options.description,
      runtime: {
        ui: {
          command: ["npm", "run", "start"],
          port: 3000,
        },
      },
      permissions: {
        writes: {
          files: [],
          tables: [],
        },
      },
    };

    // Authority is published only after every required project file and the
    // best-effort local Git initialization attempt are complete.
    await writeFile(
      join(appDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o644 },
    );

    const loaded = (await loadApps(options.appsDir)).apps.get(options.id);
    if (!loaded || loaded.dir !== appDir) {
      throw new Error(`Generated App ${options.id} did not pass App Manifest V1 validation`);
    }
    return { dir: appDir, manifest: loaded.manifest };
  } catch (error) {
    if (ownsTarget) {
      try {
        await rm(appDir, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Blank App ${options.id} creation failed and rollback was incomplete`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function validateIdentity(id: string, name: string, description: string): void {
  if (!PACKAGE_ID_PATTERN.test(id)) {
    throw new Error("Invalid app id. Use lowercase alphanumeric/hyphen segments separated by dots.");
  }
  if (!name || name.trim() !== name) {
    throw new Error("Invalid app name. Use a non-empty name without surrounding whitespace.");
  }
  if (!description || description.trim() !== description) {
    throw new Error(
      "Invalid app description. Use a non-empty description without surrounding whitespace.",
    );
  }
}

function renderScaffoldFile(
  filename: typeof APP_V1_SCAFFOLD_FILES[number],
  bytes: Buffer,
  appId: string,
  appName: string,
): Buffer | string {
  const packageName = `lamarck-app-${appId}`;
  if (filename === "package.json") {
    return replaceToken(bytes, filename, APP_PACKAGE_NAME_TOKEN, packageName, 1);
  }
  if (filename === "package-lock.json") {
    return replaceToken(bytes, filename, APP_PACKAGE_NAME_TOKEN, packageName, 2);
  }
  if (filename === "index.tsx") {
    return replaceToken(bytes, filename, APP_DISPLAY_NAME_TOKEN, JSON.stringify(appName), 1);
  }
  if (filename === "index.html") {
    return replaceToken(bytes, filename, APP_HTML_TITLE_TOKEN, escapeHtml(appName), 1);
  }
  return bytes;
}

function replaceToken(
  bytes: Buffer,
  filename: string,
  token: string,
  replacement: string,
  expectedOccurrences: number,
): string {
  const text = decodeUtf8(bytes, filename);
  const occurrences = text.split(token).length - 1;
  if (occurrences !== expectedOccurrences) {
    throw new Error(
      `App scaffold ${filename} must contain exactly ${expectedOccurrences} ${token} token(s)`,
    );
  }
  return text.replaceAll(token, replacement);
}

function decodeUtf8(bytes: Buffer, filename: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`App scaffold ${filename} is not valid UTF-8`, { cause: error });
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
