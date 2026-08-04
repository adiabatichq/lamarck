import { constants } from "node:fs";
import { lstat, open, readdir } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { assertJsonValue } from "../json";
import type {
  ConnectorAuthSpec,
  ConnectorConfigField,
  ConnectorConfigOption,
  ConnectorConfigPanel,
  ConnectorConfigFieldType,
  ConnectorEventCatalog,
  ConnectorEventTypeDefinition,
  ConnectorManifest,
  ConnectorPlatform,
  ConnectorPlatformsSpec,
  ConnectorRuntimeMode,
  ConnectorRuntimeSpec,
  ConnectorSourceIdentityKind,
  ConnectorSourceSpec,
} from "./types";
import { validateConnectorSchedule } from "./schedule";
import { ENTRY_ID_PATTERN, PACKAGE_ID_PATTERN } from "../package-id";

const SOURCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const EVENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const CONNECTOR_MODES = new Set<ConnectorRuntimeMode>(["watch", "poll", "manual"]);
const SOURCE_IDENTITY_KINDS = new Set<ConnectorSourceIdentityKind>([
  "single",
  "device",
  "connector",
]);
const CONNECTOR_PLATFORMS = new Set<ConnectorPlatform>([
  "darwin",
  "linux",
  "windows",
  "ios",
  "android",
  "cloud",
]);
const OAUTH_AUTH_TYPES = new Set([
  "oauth2-public",
]);
const AUTH_TYPES = new Set(["none", "apiKey", "managedProvider", ...OAUTH_AUTH_TYPES]);
const CONFIG_FIELD_TYPES = new Set<ConnectorConfigFieldType>(["string", "number", "boolean"]);
const MANIFEST_FIELDS = new Set([
  "manifestVersion",
  "id",
  "name",
  "description",
  "eventCatalog",
  "entry",
  "runtime",
  "source",
  "platforms",
  "auth",
  "config",
  "configPanels",
]);
const RUNTIME_FIELDS = new Set(["mode", "defaultSchedule"]);
const SOURCE_FIELDS = new Set(["identity"]);
const PLATFORM_FIELDS = new Set(["requirements"]);
const CONFIG_FIELD_FIELDS = new Set(["type", "label", "default", "options", "required"]);
const CONFIG_OPTION_FIELDS = new Set(["value", "label"]);
const CONFIG_PANEL_FIELDS = new Set(["label", "description"]);
const NONE_AUTH_FIELDS = new Set(["type"]);
const API_KEY_AUTH_FIELDS = new Set(["type", "label"]);
const MANAGED_PROVIDER_AUTH_FIELDS = new Set(["type", "providerId"]);
const OAUTH_PUBLIC_AUTH_FIELDS = new Set([
  "type",
  "authorizationEndpoint",
  "tokenEndpoint",
  "clientId",
  "scope",
]);
const EVENT_CATALOG_FIELDS = new Set(["catalogVersion", "eventTypes"]);
const EVENT_TYPE_FIELDS = new Set(["description", "payloadSchema"]);
const EVENT_CATALOG_MAX_BYTES = 1024 * 1024;

type PlainObject = Record<string, unknown>;

export function validateConnectorId(id: string): void {
  if (!PACKAGE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid connector id: ${id}`);
  }
}

export function validateSourceKey(key: string): void {
  if (!SOURCE_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid connector source key: ${key}`);
  }
}

export function validateConnectorManifest(value: unknown): ConnectorManifest {
  const manifest = requirePlainObject(value, "Connector manifest");
  assertAllowedFields(manifest, MANIFEST_FIELDS, "Connector manifest");
  if (manifest.manifestVersion !== 1) {
    throw new Error("Connector manifestVersion must be 1");
  }
  if (typeof manifest.id !== "string") {
    throw new Error(`Invalid connector id: ${String(manifest.id)}`);
  }
  validateConnectorId(manifest.id);
  const connectorId = manifest.id;
  if (typeof manifest.name !== "string" || !manifest.name || manifest.name.trim() !== manifest.name) {
    throw new Error(`Connector ${connectorId} requires a valid name`);
  }
  if (
    typeof manifest.description !== "string"
    || !manifest.description
    || manifest.description.trim() !== manifest.description
  ) {
    throw new Error(`Connector ${connectorId} requires a valid description`);
  }
  const eventCatalog = validateConnectorEventCatalogPath(connectorId, manifest.eventCatalog);
  if (typeof manifest.entry !== "string" || !manifest.entry || manifest.entry.trim() !== manifest.entry) {
    throw new Error(`Connector ${connectorId} requires an entry`);
  }

  const runtime = validateRuntimeSpec(connectorId, manifest.runtime);
  const source = validateSourceSpec(connectorId, manifest.source);
  const platforms = validatePlatformsSpec(connectorId, manifest.platforms);
  const auth = validateAuthSpec(connectorId, manifest.auth ?? { type: "none" });
  const config = validateConfigSchema(connectorId, manifest.config);
  const configPanels = validateConfigPanels(connectorId, manifest.configPanels);

  return {
    manifestVersion: 1,
    id: connectorId,
    name: manifest.name,
    description: manifest.description,
    eventCatalog,
    entry: manifest.entry,
    runtime,
    source,
    platforms,
    auth,
    ...(config === undefined ? {} : { config }),
    ...(configPanels === undefined ? {} : { configPanels }),
  };
}

function validateConnectorEventCatalogPath(connectorId: string, value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`Connector ${connectorId} requires an eventCatalog JSON path`);
  }
  if (
    isAbsolute(value)
    || value.includes("\\")
    || value.includes("?")
    || value.includes("#")
    || !value.toLowerCase().endsWith(".json")
  ) {
    throw new Error(`Connector ${connectorId} eventCatalog must be a package-relative JSON path`);
  }
  const segments = value.replace(/^\.\//, "").split("/");
  if (
    segments.length === 0
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Connector ${connectorId} eventCatalog must be a package-relative JSON path`);
  }
  return value;
}

export function validateConnectorEventCatalog(value: unknown): ConnectorEventCatalog {
  const catalog = requirePlainObject(value, "Connector event catalog");
  assertAllowedFields(catalog, EVENT_CATALOG_FIELDS, "Connector event catalog");
  if (catalog.catalogVersion !== 1) {
    throw new Error("Connector event catalogVersion must be 1");
  }
  const eventTypes = requirePlainObject(
    catalog.eventTypes,
    "Connector event catalog eventTypes",
    "Connector event catalog eventTypes must be a non-empty map",
  );
  if (Object.keys(eventTypes).length === 0) {
    throw new Error("Connector event catalog eventTypes must be a non-empty map");
  }

  const normalized: Record<string, ConnectorEventTypeDefinition> = Object.create(null);
  for (const [eventType, rawDefinition] of Object.entries(eventTypes)) {
    if (!EVENT_TYPE_PATTERN.test(eventType)) {
      throw new Error(`Connector event catalog has invalid event type: ${eventType}`);
    }
    const context = `Connector event catalog event type "${eventType}"`;
    const definition = requirePlainObject(rawDefinition, context);
    assertAllowedFields(definition, EVENT_TYPE_FIELDS, context);
    if (
      typeof definition.description !== "string"
      || !definition.description
      || definition.description.trim() !== definition.description
    ) {
      throw new Error(`${context} requires a valid description`);
    }
    if (
      definition.payloadSchema !== true
      && definition.payloadSchema !== false
      && (
        definition.payloadSchema === null
        || typeof definition.payloadSchema !== "object"
        || Array.isArray(definition.payloadSchema)
      )
    ) {
      throw new Error(`${context} payloadSchema must be a JSON Schema object or boolean`);
    }
    assertJsonValue(definition.payloadSchema, `${context} payloadSchema`);
    normalized[eventType] = {
      description: definition.description,
      payloadSchema: definition.payloadSchema as ConnectorEventTypeDefinition["payloadSchema"],
    };
  }

  return {
    catalogVersion: 1,
    eventTypes: normalized,
  };
}

export async function loadConnectorEventCatalog(
  connectorDir: string,
  manifest: ConnectorManifest,
): Promise<ConnectorEventCatalog> {
  const root = resolve(connectorDir);
  const path = resolve(root, manifest.eventCatalog);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Connector ${manifest.id} eventCatalog must stay inside connector directory: ${manifest.eventCatalog}`,
    );
  }
  await assertEventCatalogPathHasNoSymlinks(root, manifest.eventCatalog, manifest.id);

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`Connector ${manifest.id} eventCatalog not found: ${manifest.eventCatalog}`);
    }
    if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
      throw new Error(`Connector ${manifest.id} eventCatalog must not be a symlink`);
    }
    throw error;
  }
  try {
    const file = await handle.stat();
    if (!file.isFile()) {
      throw new Error(`Connector ${manifest.id} eventCatalog must be a regular file`);
    }
    if (file.size < 1 || file.size > EVENT_CATALOG_MAX_BYTES) {
      throw new Error(
        `Connector ${manifest.id} eventCatalog must be between 1 and ${EVENT_CATALOG_MAX_BYTES} bytes`,
      );
    }
    const bytes = await handle.readFile();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Connector ${manifest.id} eventCatalog is not valid UTF-8`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Connector ${manifest.id} eventCatalog is not valid JSON`);
    }
    return validateConnectorEventCatalog(parsed);
  } finally {
    await handle.close();
  }
}

async function assertEventCatalogPathHasNoSymlinks(
  root: string,
  relativePath: string,
  connectorId: string,
): Promise<void> {
  let current = root;
  for (const segment of relativePath.replace(/^\.\//, "").split("/")) {
    current = join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error(`Connector ${connectorId} eventCatalog not found: ${relativePath}`);
      }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Connector ${connectorId} eventCatalog path must not contain symlinks`);
    }
  }
}

function validateRuntimeSpec(connectorId: string, value: unknown): ConnectorRuntimeSpec {
  const runtime = requirePlainObject(value, `Connector ${connectorId} runtime`);
  assertAllowedFields(runtime, RUNTIME_FIELDS, `Connector ${connectorId} runtime`);
  if (!CONNECTOR_MODES.has(runtime.mode as ConnectorRuntimeMode)) {
    throw new Error(`Connector ${connectorId} has invalid runtime mode`);
  }
  if (runtime.defaultSchedule !== undefined) {
    if (typeof runtime.defaultSchedule !== "string") {
      throw new Error(`Connector ${connectorId} defaultSchedule must be a string`);
    }
    if (runtime.mode !== "poll") {
      throw new Error(`Connector ${connectorId} defaultSchedule is only valid for poll runtime`);
    }
    validateConnectorSchedule(runtime.defaultSchedule);
  }
  return {
    mode: runtime.mode as ConnectorRuntimeMode,
    ...(runtime.defaultSchedule === undefined ? {} : { defaultSchedule: runtime.defaultSchedule }),
  };
}

function validateSourceSpec(connectorId: string, value: unknown): ConnectorSourceSpec {
  if (value === undefined) {
    throw new Error(`Connector ${connectorId} requires an explicit source.identity (single, device, or connector)`);
  }
  const source = requirePlainObject(value, `Connector ${connectorId} source`);
  assertAllowedFields(source, SOURCE_FIELDS, `Connector ${connectorId} source`);
  if (source.identity === undefined) {
    throw new Error(`Connector ${connectorId} requires an explicit source.identity (single, device, or connector)`);
  }
  if (!SOURCE_IDENTITY_KINDS.has(source.identity as ConnectorSourceIdentityKind)) {
    throw new Error(`Connector ${connectorId} has invalid source identity`);
  }
  return { identity: source.identity as ConnectorSourceIdentityKind };
}

function validateConfigPanels(
  connectorId: string,
  panels: unknown,
): Record<string, ConnectorConfigPanel> | undefined {
  if (panels === undefined) return undefined;
  const panelMap = requirePlainObject(
    panels,
    `Connector ${connectorId} configPanels`,
    `Connector ${connectorId} configPanels must be a map of panels`,
  );
  const normalized: Record<string, ConnectorConfigPanel> = {};
  for (const [id, value] of Object.entries(panelMap)) {
    if (!ENTRY_ID_PATTERN.test(id)) {
      throw new Error(`Connector ${connectorId} config panel "${id}" has an invalid id`);
    }
    const context = `Connector ${connectorId} config panel "${id}"`;
    const panel = requirePlainObject(value, context, `${context} must be an object`);
    assertAllowedFields(panel, CONFIG_PANEL_FIELDS, context);
    if (typeof panel.label !== "string" || !panel.label.trim()) {
      throw new Error(`Connector ${connectorId} config panel "${id}" requires a label`);
    }
    if (panel.description !== undefined && typeof panel.description !== "string") {
      throw new Error(`Connector ${connectorId} config panel "${id}" description must be a string`);
    }
    normalized[id] = {
      label: panel.label,
      ...(panel.description !== undefined ? { description: panel.description } : {}),
    };
  }
  return normalized;
}

// The config schema is a map of user-facing fields. Each field declares a
// `type`, a `label`, and an optional author `default` (which must match the
// type). Config fields are setup-required by default; defaults satisfy that
// gate when present. Use `required: false` for optional fields. Secrets never go
// here — those are auth. Internal constants are not declared at all; they stay
// in connector code.
function validateConfigSchema(
  connectorId: string,
  config: unknown,
): Record<string, ConnectorConfigField> | undefined {
  if (config === undefined) return undefined;
  const configMap = requirePlainObject(
    config,
    `Connector ${connectorId} config schema`,
    `Connector ${connectorId} config schema must be a map of fields`,
  );
  const normalized: Record<string, ConnectorConfigField> = {};
  for (const [key, value] of Object.entries(configMap)) {
    if (!ENTRY_ID_PATTERN.test(key)) {
      throw new Error(`Connector ${connectorId} config field "${key}" has an invalid key`);
    }
    const context = `Connector ${connectorId} config field "${key}"`;
    const field = requirePlainObject(value, context, `${context} must be an object`);
    assertAllowedFields(field, CONFIG_FIELD_FIELDS, context);
    if (!CONFIG_FIELD_TYPES.has(field.type as ConnectorConfigFieldType)) {
      throw new Error(`Connector ${connectorId} config field "${key}" has invalid type: ${String(field.type)}`);
    }
    if (typeof field.label !== "string" || !field.label.trim()) {
      throw new Error(`Connector ${connectorId} config field "${key}" requires a label`);
    }
    const type = field.type as ConnectorConfigFieldType;
    if (field.default !== undefined && typeof field.default !== type) {
      throw new Error(`Connector ${connectorId} config field "${key}" default must be a ${field.type}`);
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      throw new Error(`Connector ${connectorId} config field "${key}" required must be a boolean`);
    }
    const options = validateConfigOptions(connectorId, key, type, field.options);
    normalized[key] = {
      type,
      label: field.label,
      ...(field.default === undefined ? {} : { default: field.default as ConnectorConfigField["default"] }),
      ...(options ? { options } : {}),
      required: field.required ?? true,
    };
  }
  return normalized;
}

function validateConfigOptions(
  connectorId: string,
  key: string,
  type: ConnectorConfigFieldType,
  options: unknown,
): ConnectorConfigOption[] | undefined {
  if (options === undefined) return undefined;
  const normalized = Array.isArray(options)
    ? normalizeConfigOptionArray(connectorId, key, type, options)
    : normalizeConfigOptionMap(connectorId, key, type, options);
  if (normalized.length === 0) {
    throw new Error(`Connector ${connectorId} config field "${key}" options must not be empty`);
  }
  assertUniqueConfigOptions(connectorId, key, normalized);
  return normalized;
}

function normalizeConfigOptionMap(
  connectorId: string,
  key: string,
  type: ConnectorConfigFieldType,
  options: unknown,
): ConnectorConfigOption[] {
  const optionMap = requirePlainObject(
    options,
    `Connector ${connectorId} config field "${key}" options`,
    `Connector ${connectorId} config field "${key}" options must be a map or array`,
  );
  return Object.entries(optionMap).map(([rawValue, rawLabel]) => {
    if (typeof rawLabel !== "string" || !rawLabel.trim()) {
      throw new Error(`Connector ${connectorId} config field "${key}" option label must be a non-empty string`);
    }
    return {
      value: parseConfigOptionMapValue(connectorId, key, type, rawValue),
      label: rawLabel,
    };
  });
}

function normalizeConfigOptionArray(
  connectorId: string,
  key: string,
  type: ConnectorConfigFieldType,
  options: unknown[],
): ConnectorConfigOption[] {
  return options.map((value, index) => {
    const context = `Connector ${connectorId} config field "${key}" option ${index}`;
    const option = requirePlainObject(value, context, `${context} must be an object`);
    assertAllowedFields(option, CONFIG_OPTION_FIELDS, context);
    if (typeof option.value !== type) {
      throw new Error(`Connector ${connectorId} config field "${key}" option ${index} value must be a ${type}`);
    }
    if (typeof option.label !== "string" || !option.label.trim()) {
      throw new Error(`Connector ${connectorId} config field "${key}" option ${index} label must be a non-empty string`);
    }
    return {
      value: option.value as ConnectorConfigOption["value"],
      label: option.label,
    };
  });
}

function parseConfigOptionMapValue(
  connectorId: string,
  key: string,
  type: ConnectorConfigFieldType,
  rawValue: string,
): string | number | boolean {
  if (type === "string") return rawValue;
  if (type === "number") {
    const value = Number(rawValue);
    if (Number.isFinite(value)) return value;
    throw new Error(`Connector ${connectorId} config field "${key}" option value must be a number: ${rawValue}`);
  }
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`Connector ${connectorId} config field "${key}" option value must be a boolean: ${rawValue}`);
}

function assertUniqueConfigOptions(
  connectorId: string,
  key: string,
  options: ConnectorConfigOption[],
): void {
  const seen = new Set<string>();
  for (const option of options) {
    const marker = JSON.stringify(option.value);
    if (seen.has(marker)) {
      throw new Error(`Connector ${connectorId} config field "${key}" options contain a duplicate value`);
    }
    seen.add(marker);
  }
}

export function currentConnectorPlatform(): ConnectorPlatform {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

export function isPlatformSupported(
  manifest: ConnectorManifest,
  platform: ConnectorPlatform,
): boolean {
  const platforms = manifest.platforms ?? {};
  const declared = Object.keys(platforms);
  return declared.length === 0 || platform in platforms;
}

export function activePlatformRequirements(
  manifest: ConnectorManifest,
  platform: ConnectorPlatform,
): string[] {
  return manifest.platforms?.[platform]?.requirements ?? [];
}

export async function loadConnectorManifest(connectorDir: string): Promise<ConnectorManifest> {
  const entries = await readdir(connectorDir);
  const filename = ["connector.yaml", "connector.yml", "connector.json"].find((candidate) =>
    entries.includes(candidate)
  );
  if (!filename) {
    throw new Error(`Connector manifest not found in ${connectorDir}`);
  }

  const manifestPath = join(connectorDir, filename);
  let handle;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
      throw new Error(`Connector manifest must not be a symlink: ${filename}`);
    }
    throw error;
  }
  let text: string;
  try {
    const file = await handle.stat();
    if (!file.isFile()) {
      throw new Error(`Connector manifest must be a regular file: ${filename}`);
    }
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const raw = filename.endsWith(".json") ? JSON.parse(text) : parseSimpleYaml(text);
  return validateConnectorManifest(raw);
}

function validateAuthSpec(connectorId: string, value: unknown): ConnectorAuthSpec {
  const auth = requirePlainObject(value, `Connector ${connectorId} auth`);
  if (!AUTH_TYPES.has(auth.type as string)) {
    throw new Error(`Connector ${connectorId} has invalid auth type: ${String(auth.type)}`);
  }
  const context = `Connector ${connectorId} ${String(auth.type)} auth`;
  switch (auth.type) {
    case "none":
      assertAllowedFields(auth, NONE_AUTH_FIELDS, context);
      return { type: "none" };
    case "apiKey":
      assertAllowedFields(auth, API_KEY_AUTH_FIELDS, context);
      if (auth.label !== undefined && (typeof auth.label !== "string" || !auth.label.trim())) {
        throw new Error(`Connector ${connectorId} apiKey auth label must be a non-empty string`);
      }
      return {
        type: "apiKey",
        ...(auth.label === undefined ? {} : { label: auth.label as string }),
      };
    case "managedProvider":
      assertAllowedFields(auth, MANAGED_PROVIDER_AUTH_FIELDS, context);
      return {
        type: "managedProvider",
        providerId: validateProviderIdAuthField(connectorId, auth),
      };
    case "oauth2-public": {
      assertAllowedFields(auth, OAUTH_PUBLIC_AUTH_FIELDS, context);
      const scope = validateOAuthScope(connectorId, auth);
      return {
        type: "oauth2-public",
        authorizationEndpoint: validateHttpsAuthField(
          connectorId,
          auth,
          "authorizationEndpoint",
          auth.type,
        ),
        tokenEndpoint: validateHttpsAuthField(connectorId, auth, "tokenEndpoint", auth.type),
        clientId: validateRequiredStringAuthField(connectorId, auth, "clientId", auth.type),
        ...(scope === undefined ? {} : { scope }),
      };
    }
    default:
      throw new Error(`Connector ${connectorId} has invalid auth type: ${String(auth.type)}`);
  }
}

function validateProviderIdAuthField(connectorId: string, auth: Record<string, unknown>): string {
  const value = auth.providerId;
  if (typeof value !== "string" || !ENTRY_ID_PATTERN.test(value)) {
    throw new Error(`Connector ${connectorId} managedProvider auth requires a valid providerId`);
  }
  return value;
}

function validateOAuthScope(connectorId: string, auth: Record<string, unknown>): string[] | undefined {
  if (auth.scope !== undefined &&
    (!Array.isArray(auth.scope) || auth.scope.some((s) => typeof s !== "string"))) {
    throw new Error(`Connector ${connectorId} ${auth.type} scope must be an array of strings`);
  }
  return auth.scope === undefined ? undefined : [...auth.scope] as string[];
}

function validateRequiredStringAuthField(
  connectorId: string,
  auth: Record<string, unknown>,
  field: string,
  authType: string,
): string {
  const value = auth[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Connector ${connectorId} ${authType} auth requires ${field}`);
  }
  return value;
}

function validateHttpsAuthField(
  connectorId: string,
  auth: Record<string, unknown>,
  field: string,
  authType: string,
): string {
  const value = validateRequiredStringAuthField(connectorId, auth, field, authType);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Connector ${connectorId} ${authType} ${field} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Connector ${connectorId} ${authType} ${field} must be https: ${value}`);
  }
  return value;
}

function validatePlatformsSpec(
  connectorId: string,
  platforms: unknown,
): ConnectorPlatformsSpec {
  if (platforms === undefined) return {};
  const platformMap = requirePlainObject(
    platforms,
    `Connector ${connectorId} platforms`,
    `Connector ${connectorId} platforms must be a structured object`,
  );

  const normalized: ConnectorPlatformsSpec = {};
  for (const [platform, value] of Object.entries(platformMap)) {
    if (!CONNECTOR_PLATFORMS.has(platform as ConnectorPlatform)) {
      throw new Error(`Connector ${connectorId} has invalid platform: ${platform}`);
    }
    const context = `Connector ${connectorId} platform ${platform}`;
    const spec = requirePlainObject(value, context, `${context} must be an object`);
    assertAllowedFields(spec, PLATFORM_FIELDS, context);
    const requirements = spec.requirements ?? [];
    if (!Array.isArray(requirements) || !requirements.every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error(`Connector ${connectorId} platform ${platform} requirements must be strings`);
    }
    normalized[platform as ConnectorPlatform] = {
      requirements: [...requirements] as string[],
    };
  }
  return normalized;
}

function requirePlainObject(
  value: unknown,
  context: string,
  errorMessage = `${context} must be a plain object`,
): PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(errorMessage);
  }
  return value as PlainObject;
}

function assertAllowedFields(
  value: PlainObject,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`${context} has unknown field: ${field}`);
    }
  }
}

function parseSimpleYaml(text: string): unknown {
  const lines = text
    .split(/\r?\n/)
    .map((rawLine) => ({
      raw: rawLine,
      withoutComment: rawLine.replace(/\s+#.*$/, ""),
    }))
    .filter((line) => line.withoutComment.trim())
    .map((line) => ({
      raw: line.raw,
      indent: line.withoutComment.match(/^ */)?.[0].length ?? 0,
      text: line.withoutComment.trim(),
    }));

  function parseBlock(index: number, indent: number): { value: unknown; index: number } {
    if (index >= lines.length) return { value: {}, index };
    if (lines[index].indent < indent) return { value: {}, index };
    if (lines[index].indent > indent) {
      throw new Error(`Unsupported connector YAML indentation: ${lines[index].raw}`);
    }

    if (lines[index].text.startsWith("- ")) {
      const array: unknown[] = [];
      while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("- ")) {
        const item = lines[index].text.slice(2).trim();
        index += 1;
        if (!item) {
          const nested = parseBlock(index, indent + 2);
          array.push(nested.value);
          index = nested.index;
        } else {
          array.push(parseYamlScalar(item));
        }
      }
      return { value: array, index };
    }

    const object: Record<string, unknown> = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith("- ")) {
      const match = lines[index].text.match(/^([^:]+):(.*)$/);
      if (!match) throw new Error(`Invalid connector YAML line: ${lines[index].raw}`);
      const key = match[1].trim();
      const value = match[2].trim();
      index += 1;
      if (!value) {
        const nested = parseBlock(index, indent + 2);
        object[key] = nested.value;
        index = nested.index;
      } else {
        object[key] = parseYamlScalar(value);
      }
    }
    return { value: object, index };
  }

  return parseBlock(0, 0).value;
}

function parseYamlScalar(value: string): unknown {
  const unquoted = value.replace(/^["']|["']$/g, "");
  if (unquoted === "{}") return {};
  if (unquoted === "[]") return [];
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}
