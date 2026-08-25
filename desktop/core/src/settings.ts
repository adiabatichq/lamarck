import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

export interface CoreSettings {
  corePort?: number;
  vaultId?: string;
}

export class SettingsStore {
  private filePath: string;
  private cached: CoreSettings | null = null;

  constructor(private lamarckDir: string) {
    this.filePath = join(lamarckDir, "settings.json");
  }

  async get(): Promise<CoreSettings> {
    if (this.cached) return this.cached;
    try {
      this.cached = JSON.parse(await readFile(this.filePath, "utf8")) as CoreSettings;
    } catch {
      this.cached = {};
    }
    return this.cached;
  }

  async update(patch: Partial<CoreSettings>): Promise<CoreSettings> {
    const next = { ...(await this.get()), ...patch };
    await mkdir(this.lamarckDir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
    this.cached = next;
    return next;
  }
}
