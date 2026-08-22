import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const DEFAULT_CONFIG = {
  "poll-timeout-sec": 25,
  "clear-webhook-on-start": false,
};

const DEFAULT_SETUP = {
  version: 1,
  dm: { mode: "paired_only" },
  groups: { mode: "disabled", requireMention: true },
};

const UPDATE_TYPES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
  "guest_message",
];
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export default {
  async run(context) {
    await connectOnce(context);

    while (!context.signal.aborted) {
      await syncOnce(context);
    }
  },

  async configUi(context) {
    return startSetupPanel(context);
  },

  async resolveSourceIdentity(context) {
    return resolveSourceIdentity(context);
  },
};

export async function resolveSourceIdentity(context, deps = {}) {
  assertApiKeyAuth(context.auth);
  const token = await context.auth.getToken();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Telegram connector requires fetch");
  }

  const me = await telegramApi(token, "getMe", {}, {
    fetchImpl,
    signal: context.signal,
  });
  if (!Number.isSafeInteger(me?.id) || me.id <= 0) {
    throw new Error("Telegram getMe returned an invalid bot id");
  }
  return {
    key: String(me.id),
    ...(typeof me.username === "string" ? { label: me.username } : {}),
  };
}

export async function connectOnce(context, deps = {}) {
  assertApiKeyAuth(context.auth);
  const token = await context.auth.getToken();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Telegram connector requires fetch");
  }

  const config = normalizeConfig(context.config);
  const previous = normalizeState(await context.state.get());
  const nowMs = readNowMs(deps.now);

  if (config["clear-webhook-on-start"]) {
    await telegramApi(token, "deleteWebhook", { drop_pending_updates: false }, {
      fetchImpl,
      signal: context.signal,
    });
  }

  const me = await telegramApi(token, "getMe", {}, {
    fetchImpl,
    signal: context.signal,
  });
  const bot = summarizeBot(me);
  await context.state.set({
    ...previous,
    version: 1,
    connection: {
      status: "connected",
      checkedAt: nowMs,
    },
    bot,
  });
  await context.warnings?.clear?.("telegram-api");
  return bot;
}

export async function syncOnce(context, deps = {}) {
  assertApiKeyAuth(context.auth);
  const token = await context.auth.getToken();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Telegram connector requires fetch");
  }

  const config = normalizeConfig(context.config);
  const cursorState = normalizeState(await context.state.get());

  const offset = Number.isFinite(cursorState.cursor.lastUpdateId)
    ? cursorState.cursor.lastUpdateId + 1
    : undefined;
  let updates;
  try {
    updates = await telegramApi(token, "getUpdates", {
      offset,
      timeout: Math.max(0, Math.floor(config["poll-timeout-sec"])),
      limit: 100,
      allowed_updates: UPDATE_TYPES,
    }, {
      fetchImpl,
      signal: context.signal,
    });
    await context.warnings?.clear?.("telegram-api");
  } catch (err) {
    await recordTelegramWarning(context, err);
    throw err;
  }

  // getUpdates can block for the full long-poll timeout. Re-read state after it
  // returns so a pairing challenge created by the setup panel while the poll was
  // pending is visible and is not overwritten by the pre-poll snapshot.
  const next = normalizeState(await context.state.get());
  const events = [];
  const setup = normalizeSetupConfig(config.telegramSetup);
  for (const update of Array.isArray(updates) ? updates : []) {
    if (context.signal.aborted) break;
    if (!isObject(update) || !Number.isFinite(update.update_id)) continue;

    const message = messageFromUpdate(update);
    if (!message) {
      next.cursor.lastUpdateId = Math.max(next.cursor.lastUpdateId ?? 0, update.update_id);
      continue;
    }
    const pairing = handlePairingMessage(next.setup, message, update, readNowMs(deps.now));
    if (pairing.handled) {
      next.cursor.lastUpdateId = Math.max(next.cursor.lastUpdateId ?? 0, update.update_id);
      continue;
    }
    recordPendingCandidate(next.setup, message, update);
    if (shouldCaptureMessage(message, setup, next.setup, next.bot)) {
      events.push(eventFromUpdate(update, { bot: next.bot }));
    }
    next.cursor.lastUpdateId = Math.max(next.cursor.lastUpdateId ?? 0, update.update_id);
  }

  if (events.length) {
    if (typeof context.guard.writeEvents === "function") {
      await context.guard.writeEvents(events);
    } else {
      for (const event of events) {
        await context.guard.writeEvent(event);
      }
    }
  }
  next.setup.lastCheckedAt = readNowMs(deps.now);
  await context.state.set(next);
  return { updates: Array.isArray(updates) ? updates.length : 0, events: events.length };
}

export function eventFromUpdate(update, opts = {}) {
  const message = messageFromUpdate(update);
  // No fallback: D0 is append-only and cannot express an unknown timestamp, so
  // an update we cannot time must fail the run rather than be dated "now".
  const startedAt = timestampFromMessage(message);
  if (startedAt === undefined) {
    throw new Error(`Telegram update ${update?.update_id} has no usable message date`);
  }
  const updateType = updateTypeFromUpdate(update);
  const botKey = botKeyFromBot(opts.bot);
  return {
    type: "telegram.message.received",
    externalId: externalIdForUpdate(update, opts.bot),
    startedAt,
    payload: compactObject({
      schema: "telegram.message.v1",
      provider: "telegram",
      transport: "telegram-bot-api",
      telegram: compactObject({
        botId: opts.bot?.id,
        updateId: Number.isFinite(update?.update_id) ? update.update_id : undefined,
        updateType,
      }),
      messageKey: messageKeyFromMessage(message, botKey),
      chatKey: chatKeyFromMessage(message, botKey),
      message: cloneJson(message),
      text: textFromMessage(message) ?? null,
      textKind: textKindFromMessage(message) ?? null,
      attachmentTypes: attachmentTypesFromMessage(message) ?? [],
      mediaRefs: mediaRefsFromMessage(message) ?? [],
    }),
  };
}

export function normalizeConfig(config) {
  const raw = isObject(config) ? config : {};
  const pollTimeout = Number.isFinite(raw["poll-timeout-sec"])
    ? raw["poll-timeout-sec"]
    : DEFAULT_CONFIG["poll-timeout-sec"];
  return {
    ...raw,
    "poll-timeout-sec": clamp(pollTimeout, 1, 50),
    "clear-webhook-on-start": typeof raw["clear-webhook-on-start"] === "boolean"
      ? raw["clear-webhook-on-start"]
      : DEFAULT_CONFIG["clear-webhook-on-start"],
    telegramSetup: normalizeSetupConfig(raw.telegramSetup),
  };
}

export function normalizeState(state) {
  const raw = isObject(state) ? state : {};
  return {
    ...cloneJson(raw),
    version: 1,
    cursor: isObject(raw.cursor) ? cloneJson(raw.cursor) : {},
    setup: normalizeSetupState(raw.setup),
  };
}

export function pairingChallengeForCode(code, nowMs = Date.now(), opts = {}) {
  const normalized = normalizePairingCode(code);
  if (!normalized) throw new Error("Pairing code must be a non-empty string");
  const salt = opts.salt ?? randomToken();
  return {
    version: 1,
    salt,
    codeHash: hashPairingCode(normalized, salt),
    createdAt: nowMs,
    expiresAt: nowMs + PAIRING_CODE_TTL_MS,
    attempts: 0,
  };
}

async function startSetupPanel({ configStore, state, signal }) {
  const token = randomToken();
  const port = await startLoopbackFetchServer(
    (req) => handleSetupRequest(req, { token, configStore, state }),
    signal,
  );
  return {
    url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
  };
}

async function startLoopbackFetchServer(fetchHandler, signal) {
  if (signal.aborted) throw new Error("setup panel was aborted");
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error("request body is too large");
        chunks.push(chunk);
      }
      const method = incoming.method ?? "GET";
      const response = await fetchHandler(new Request(
        new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "127.0.0.1"}`),
        {
          method,
          headers: incoming.headers,
          body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
        },
      ));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: errorMessage(err) }));
    }
  });
  signal.addEventListener("abort", () => {
    server.closeAllConnections();
    server.close();
  }, { once: true });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("setup panel failed to bind a loopback port");
  return address.port;
}

async function handleSetupRequest(req, ctx) {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== ctx.token) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  try {
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(setupHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      return jsonResponse(await setupSnapshot(ctx));
    }
    if (req.method === "POST" && url.pathname === "/api/policy") {
      const body = await req.json().catch(() => ({}));
      const current = await currentConfig(ctx.configStore);
      const setup = normalizeSetupConfig(body.telegramSetup);
      await ctx.configStore.patch({ set: { telegramSetup: setup } });
      return jsonResponse({ telegramSetup: setup, previous: current.telegramSetup });
    }
    if (req.method === "POST" && url.pathname === "/api/pairing-code") {
      return jsonResponse(await createPairingCode(ctx));
    }
    if (req.method === "POST" && url.pathname === "/api/clear") {
      const body = await req.json().catch(() => ({}));
      return jsonResponse(await clearCandidate(ctx, body.kind, body.id));
    }
    if (req.method === "POST" && url.pathname === "/api/unpair") {
      const body = await req.json().catch(() => ({}));
      return jsonResponse(await unpairCandidate(ctx, body.kind, body.id));
    }
    return jsonResponse({ error: "not_found" }, 404);
  } catch (err) {
    return jsonResponse({ error: errorMessage(err) }, 500);
  }
}

async function setupSnapshot(ctx) {
  const state = normalizeState(await ctx.state.get());
  return {
    config: await currentConfig(ctx.configStore),
    state: publicState(state),
  };
}

async function currentConfig(configStore) {
  return normalizeConfig(await configStore.get());
}

async function createPairingCode(ctx) {
  const code = generatePairingCode();
  const nowMs = Date.now();
  const currentState = normalizeState(await ctx.state.get());
  currentState.setup.pairingChallenge = pairingChallengeForCode(code, nowMs);
  delete currentState.setup.lastPairingAttempt;
  await ctx.state.set(currentState);
  return {
    code,
    command: `/pair ${code}`,
    expiresAt: currentState.setup.pairingChallenge.expiresAt,
    state: publicState(currentState),
  };
}

async function clearCandidate(ctx, kind, id) {
  const candidateId = stringFrom(id);
  if (!candidateId) throw new Error("clear requires an id");
  const currentState = normalizeState(await ctx.state.get());
  if (kind === "user") {
    delete currentState.setup.pendingUsers[candidateId];
  } else if (kind === "group") {
    delete currentState.setup.pendingGroups[candidateId];
  } else {
    throw new Error("clear kind must be user or group");
  }
  await ctx.state.set(currentState);
  return { state: publicState(currentState) };
}

export async function unpairCandidate(ctx, kind, id) {
  const candidateId = stringFrom(id);
  if (!candidateId) throw new Error("unpair requires an id");
  const currentState = normalizeState(await ctx.state.get());
  if (kind === "user") {
    delete currentState.setup.pairedUsers[candidateId];
  } else if (kind === "group") {
    delete currentState.setup.pairedGroups[candidateId];
  } else {
    throw new Error("unpair kind must be user or group");
  }
  if (String(currentState.setup.lastPairingAttempt?.id) === candidateId) {
    delete currentState.setup.lastPairingAttempt;
  }
  await ctx.state.set(currentState);
  return { state: publicState(currentState) };
}

async function telegramApi(token, method, params, opts) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const response = await opts.fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stripUndefined(params)),
    signal: opts.signal,
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok || body.ok !== true) {
    throw new TelegramApiError(body.description || `Telegram ${method} failed`, {
      status: response.status,
      code: body.error_code,
      method,
    });
  }
  return body.result;
}

class TelegramApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "TelegramApiError";
    this.details = details;
  }
}

async function recordTelegramWarning(context, err) {
  if (!context.warnings?.set) return;
  const details = err instanceof TelegramApiError ? err.details : {};
  const code = details?.code;
  const message = code === 409
    ? "Telegram reported another active getUpdates consumer for this bot token"
    : errorMessage(err);
  await context.warnings.set({
    key: "telegram-api",
    message,
    details: compactObject({
      code,
      status: details?.status,
      method: details?.method,
    }),
  });
}

function shouldCaptureMessage(message, setup, setupState, bot) {
  if (!message?.chat) return false;
  const chat = message.chat;
  const chatId = String(chat.id);
  if (chat.type === "private") {
    if (setup.dm.mode === "disabled") return false;
    if (setup.dm.mode === "paired_only") {
      const userId = message.from?.id ? String(message.from.id) : undefined;
      return Boolean(userId && setupState.pairedUsers[userId]);
    }
    return true;
  }

  if (setup.groups.mode === "disabled") return false;
  if (setup.groups.mode === "paired_only" && !setupState.pairedGroups[chatId]) {
    return false;
  }
  if (setup.groups.requireMention) {
    return messageMentionsBot(message, bot);
  }
  return true;
}

function handlePairingMessage(setupState, message, update, nowMs) {
  const code = pairingCodeFromMessage(message);
  if (!code) return { handled: false };
  if (!message?.chat) {
    return { handled: true, paired: false };
  }

  const challenge = setupState.pairingChallenge;
  if (!isActivePairingChallenge(challenge, nowMs)) {
    setupState.lastPairingAttempt = {
      status: "expired_or_missing",
      at: nowMs,
      updateId: update.update_id,
    };
    delete setupState.pairingChallenge;
    return { handled: true, paired: false };
  }

  const normalizedCode = normalizePairingCode(code);
  if (hashPairingCode(normalizedCode, challenge.salt) !== challenge.codeHash) {
    challenge.attempts = (Number.isFinite(challenge.attempts) ? challenge.attempts : 0) + 1;
    challenge.lastFailedAt = nowMs;
    setupState.lastPairingAttempt = {
      status: "wrong_code",
      at: nowMs,
      updateId: update.update_id,
    };
    return { handled: true, paired: false };
  }

  const isPrivate = message.chat.type === "private";
  const id = isPrivate && message.from?.id
    ? String(message.from.id)
    : String(message.chat.id);
  if (isPrivate) {
    setupState.pairedUsers[id] = {
      ...summarizeUser(message.from),
      pairedAt: nowMs,
      pairingMethod: "otp",
      lastUpdateId: update.update_id,
    };
    delete setupState.pendingUsers[id];
  } else {
    setupState.pairedGroups[id] = {
      ...summarizeChat(message.chat),
      pairedAt: nowMs,
      pairingMethod: "otp",
      pairedBy: summarizeUser(message.from),
      lastUpdateId: update.update_id,
    };
    delete setupState.pendingGroups[id];
  }
  setupState.lastPairingAttempt = {
    status: isPrivate ? "paired_user" : "paired_group",
    at: nowMs,
    updateId: update.update_id,
    id,
  };
  delete setupState.pairingChallenge;
  return { handled: true, paired: true };
}

function recordPendingCandidate(setupState, message, update) {
  if (!message?.chat) return;
  const nowMs = Date.now();
  const chat = message.chat;
  if (chat.type === "private" && message.from?.id) {
    const id = String(message.from.id);
    setupState.pendingUsers[id] = {
      ...summarizeUser(message.from),
      firstSeenAt: setupState.pendingUsers[id]?.firstSeenAt ?? nowMs,
      lastSeenAt: nowMs,
      lastUpdateId: update.update_id,
      lastText: textFromMessage(message),
    };
    return;
  }

  const id = String(chat.id);
  setupState.pendingGroups[id] = {
    ...summarizeChat(chat),
    firstSeenAt: setupState.pendingGroups[id]?.firstSeenAt ?? nowMs,
    lastSeenAt: nowMs,
    lastUpdateId: update.update_id,
    lastText: textFromMessage(message),
  };
}

function messageMentionsBot(message, bot) {
  const username = typeof bot?.username === "string" ? bot.username.toLowerCase() : undefined;
  if (!username) return false;
  const text = textFromMessage(message)?.toLowerCase() ?? "";
  return text.includes(`@${username}`);
}

function messageFromUpdate(update) {
  if (!isObject(update)) return undefined;
  return update.message
    ?? update.edited_message
    ?? update.channel_post
    ?? update.edited_channel_post
    ?? update.business_message
    ?? update.edited_business_message
    ?? update.guest_message;
}

function updateTypeFromUpdate(update) {
  if (update?.message) return "message";
  if (update?.edited_message) return "edited_message";
  if (update?.channel_post) return "channel_post";
  if (update?.edited_channel_post) return "edited_channel_post";
  if (update?.business_message) return "business_message";
  if (update?.edited_business_message) return "edited_business_message";
  if (update?.guest_message) return "guest_message";
  return undefined;
}

function timestampFromMessage(message) {
  return Number.isFinite(message?.date) ? message.date * 1000 : undefined;
}

function textFromMessage(message) {
  return stringFrom(message?.text) ?? stringFrom(message?.caption);
}

function summarizeBot(bot) {
  if (!isObject(bot)) return undefined;
  return compactObject({
    id: bot.id,
    username: bot.username,
    firstName: bot.first_name,
    canJoinGroups: bot.can_join_groups,
    canReadAllGroupMessages: bot.can_read_all_group_messages,
    supportsInlineQueries: bot.supports_inline_queries,
  });
}

function summarizeUser(user) {
  if (!isObject(user)) return undefined;
  return compactObject({
    id: user.id,
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    isBot: user.is_bot,
    languageCode: user.language_code,
  });
}

function summarizeChat(chat) {
  if (!isObject(chat)) return undefined;
  return compactObject({
    id: chat.id,
    type: chat.type,
    title: chat.title,
    username: chat.username,
    firstName: chat.first_name,
    lastName: chat.last_name,
  });
}

function externalIdForUpdate(update, bot) {
  if (update?.update_id === undefined) {
    throw new Error("Telegram update has no update_id; cannot derive a stable event id");
  }
  return `bot:${botKeyFromBot(bot)}:update:${update.update_id}`;
}

function botKeyFromBot(bot) {
  // The bot key is part of externalId. A placeholder would make the same update
  // dedup differently once the real identity is known, permanently duplicating it.
  const key = bot?.id ?? bot?.username;
  if (key === undefined || key === null || key === "") {
    throw new Error("Telegram bot identity is unavailable; cannot derive a stable event id");
  }
  return key;
}

function messageKeyFromMessage(message, botKey) {
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  if (chatId === undefined || messageId === undefined) return undefined;
  return `bot:${botKey}:chat:${chatId}:message:${messageId}`;
}

function chatKeyFromMessage(message, botKey) {
  const chatId = message?.chat?.id;
  if (chatId === undefined) return undefined;
  return `bot:${botKey}:chat:${chatId}`;
}

function textKindFromMessage(message) {
  if (stringFrom(message?.text)) return "text";
  if (stringFrom(message?.caption)) return "caption";
  return undefined;
}

function attachmentTypesFromMessage(message) {
  if (!isObject(message)) return undefined;
  const fields = [
    "photo",
    "document",
    "video",
    "voice",
    "audio",
    "animation",
    "sticker",
    "video_note",
    "live_photo",
    "paid_media",
    "contact",
    "location",
    "venue",
    "poll",
    "dice",
    "web_app_data",
  ];
  const types = fields.filter((field) => hasTelegramField(message[field]));
  return types.length ? types : undefined;
}

function hasTelegramField(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

function mediaRefsFromMessage(message) {
  if (!isObject(message)) return undefined;
  const refs = [
    photoMediaRef("photo", message.photo),
    telegramFileMediaRef("document", message.document),
    telegramFileMediaRef("video", message.video),
    telegramFileMediaRef("voice", message.voice),
    telegramFileMediaRef("audio", message.audio),
    telegramFileMediaRef("animation", message.animation),
    telegramFileMediaRef("sticker", message.sticker),
    telegramFileMediaRef("video_note", message.video_note),
    telegramFileMediaRef("live_photo", message.live_photo),
    ...paidMediaRefs(message.paid_media),
  ].filter(Boolean);
  return refs.length ? refs : undefined;
}

function paidMediaRefs(paidMediaInfo) {
  if (!isObject(paidMediaInfo) || !Array.isArray(paidMediaInfo.paid_media)) return [];
  return paidMediaInfo.paid_media.flatMap((item, index) => {
    if (!isObject(item)) return [];
    if (item.type === "photo") {
      const ref = photoMediaRef("paid_media", item.photo, {
        paidMediaType: "photo",
        paidMediaIndex: index,
      });
      return ref ? [ref] : [];
    }
    if (item.type === "video") {
      const ref = telegramFileMediaRef("paid_media", item.video, {
        paidMediaType: "video",
        paidMediaIndex: index,
      });
      return ref ? [ref] : [];
    }
    if (item.type === "live_photo") {
      const ref = telegramFileMediaRef("paid_media", item.live_photo, {
        paidMediaType: "live_photo",
        paidMediaIndex: index,
      });
      return ref ? [ref] : [];
    }
    return [];
  });
}

function photoMediaRef(telegramType, photo, extra = {}) {
  const selected = selectedPhotoSize(photo);
  if (!selected) return undefined;
  return telegramFileMediaRef(telegramType, selected, {
    mimeType: "image/jpeg",
    ...extra,
  });
}

function selectedPhotoSize(photo) {
  if (!Array.isArray(photo) || photo.length === 0) return undefined;
  return photo
    .filter(isObject)
    .reduce((best, item) => {
      if (!best) return item;
      const bestRank = mediaRank(best);
      const itemRank = mediaRank(item);
      return itemRank >= bestRank ? item : best;
    }, undefined);
}

function mediaRank(item) {
  return numberFrom(item?.file_size) ?? ((numberFrom(item?.width) ?? 0) * (numberFrom(item?.height) ?? 0));
}

function telegramFileMediaRef(telegramType, file, extra = {}) {
  if (!isObject(file) || !stringFrom(file.file_id)) return undefined;
  const width = numberFrom(file.width) ?? (telegramType === "video_note" ? numberFrom(file.length) : undefined);
  const height = numberFrom(file.height) ?? (telegramType === "video_note" ? numberFrom(file.length) : undefined);
  return compactObject({
    kind: "telegram-file",
    telegramType,
    ...extra,
    fileId: file.file_id,
    fileUniqueId: stringFrom(file.file_unique_id),
    fileName: stringFrom(file.file_name),
    width,
    height,
    durationSec: numberFrom(file.duration),
    mimeType: stringFrom(file.mime_type) ?? extra.mimeType,
    sizeBytes: numberFrom(file.file_size),
  });
}

function numberFrom(value) {
  return Number.isFinite(value) ? value : undefined;
}

function normalizeSetupConfig(value) {
  const raw = isObject(value) ? value : {};
  const dm = isObject(raw.dm) ? raw.dm : {};
  const groups = isObject(raw.groups) ? raw.groups : {};
  return {
    version: 1,
    dm: {
      mode: setupMode(dm.mode, DEFAULT_SETUP.dm.mode, ["capture_all", "paired_only", "disabled"]),
    },
    groups: {
      mode: setupMode(groups.mode, DEFAULT_SETUP.groups.mode, ["disabled", "paired_only", "capture_all"]),
      requireMention: typeof groups.requireMention === "boolean"
        ? groups.requireMention
        : DEFAULT_SETUP.groups.requireMention,
    },
  };
}

function normalizeSetupState(value) {
  const raw = isObject(value) ? value : {};
  return compactObject({
    pendingUsers: normalizeRecord(raw.pendingUsers),
    pendingGroups: normalizeRecord(raw.pendingGroups),
    pairedUsers: normalizeRecord(raw.pairedUsers),
    pairedGroups: normalizeRecord(raw.pairedGroups),
    pairingChallenge: normalizePairingChallenge(raw.pairingChallenge),
    lastPairingAttempt: isObject(raw.lastPairingAttempt) ? cloneJson(raw.lastPairingAttempt) : undefined,
    lastCheckedAt: Number.isFinite(raw.lastCheckedAt) ? raw.lastCheckedAt : undefined,
  });
}

function setupMode(value, fallback, choices) {
  return typeof value === "string" && choices.includes(value) ? value : fallback;
}

function normalizeRecord(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, record]) => key && isObject(record))
      .map(([key, record]) => [key, cloneJson(record)]),
  );
}

function normalizePairingChallenge(value) {
  if (!isObject(value)) return undefined;
  const salt = stringFrom(value.salt);
  const codeHash = stringFrom(value.codeHash);
  if (!salt || !codeHash) return undefined;
  return compactObject({
    version: 1,
    salt,
    codeHash,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : Date.now(),
    attempts: Number.isFinite(value.attempts) ? value.attempts : 0,
    lastFailedAt: Number.isFinite(value.lastFailedAt) ? value.lastFailedAt : undefined,
  });
}

function isActivePairingChallenge(challenge, nowMs) {
  return isObject(challenge)
    && typeof challenge.salt === "string"
    && typeof challenge.codeHash === "string"
    && Number.isFinite(challenge.expiresAt)
    && challenge.expiresAt >= nowMs;
}

function pairingCodeFromMessage(message) {
  const text = textFromMessage(message);
  if (!text) return undefined;
  const match = text.trim().match(/^\/pair(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9-]{4,16})$/i);
  return match ? normalizePairingCode(match[1]) : undefined;
}

function normalizePairingCode(code) {
  if (typeof code !== "string") return undefined;
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(normalized) ? normalized : undefined;
}

function hashPairingCode(code, salt) {
  return createHash("sha256")
    .update(`${salt}:${code}`)
    .digest("hex");
}

function generatePairingCode() {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, "0");
}

function publicState(state) {
  const next = cloneJson(state);
  if (next?.setup?.pairingChallenge) {
    next.setup.pairingChallenge = compactObject({
      active: true,
      createdAt: next.setup.pairingChallenge.createdAt,
      expiresAt: next.setup.pairingChallenge.expiresAt,
      attempts: next.setup.pairingChallenge.attempts,
      lastFailedAt: next.setup.pairingChallenge.lastFailedAt,
    });
  }
  return next;
}

function assertApiKeyAuth(auth) {
  if (!auth || auth.type !== "apiKey" || typeof auth.getToken !== "function") {
    throw new Error("Telegram connector requires a Telegram bot token");
  }
}

export function setupHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Telegram Setup</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17201b;
      --muted: #66736c;
      --line: #c9d3ce;
      --paper: #f6f5ef;
      --panel: #fffefa;
      --accent: #0f766e;
      --warn: #a84c1d;
      --dark: #1e2b24;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(23, 32, 27, 0.045) 1px, transparent 1px),
        linear-gradient(rgba(23, 32, 27, 0.035) 1px, transparent 1px),
        var(--paper);
      background-size: 26px 26px;
      color: var(--ink);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    main {
      width: min(1040px, calc(100vw - 40px));
      margin: 0 auto;
      padding: 36px 0 44px;
    }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: end;
      border-bottom: 2px solid var(--dark);
      padding-bottom: 18px;
      margin-bottom: 22px;
    }
    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 34px;
      font-weight: 700;
      line-height: 1.05;
      letter-spacing: 0;
    }
    .sub { margin: 8px 0 0; color: var(--muted); max-width: 650px; }
    .status {
      border: 1px solid var(--dark);
      background: var(--dark);
      color: #fffefa;
      padding: 10px 13px;
      min-width: 220px;
      font-size: 13px;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 0.95fr) minmax(360px, 1.05fr);
      gap: 18px;
      align-items: start;
    }
    section {
      border: 1px solid var(--line);
      background: rgba(255, 254, 250, 0.92);
      padding: 16px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    ol { margin: 0; padding-left: 22px; color: var(--ink); }
    li { margin: 0 0 10px; }
    code {
      border: 1px solid var(--line);
      background: #eef3ef;
      padding: 1px 5px;
      font-family: "SF Mono", Menlo, monospace;
      font-size: 0.92em;
    }
    .field {
      display: grid;
      grid-template-columns: 170px 1fr;
      gap: 12px;
      align-items: center;
      border-top: 1px solid var(--line);
      padding: 12px 0;
    }
    .field:first-of-type { border-top: 0; }
    label { color: var(--muted); font-size: 13px; }
    select, input[type="checkbox"] {
      accent-color: var(--accent);
    }
    select {
      width: 100%;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      padding: 9px 10px;
      font: inherit;
    }
    button {
      border: 1px solid var(--dark);
      background: var(--dark);
      color: #fffefa;
      padding: 8px 11px;
      font: inherit;
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--dark);
    }
    button[hidden] { display: none; }
    button:focus-visible, select:focus-visible, input:focus-visible {
      outline: 3px solid rgba(15, 118, 110, 0.28);
      outline-offset: 2px;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 8px;
      align-items: center;
      border-top: 1px solid var(--line);
      padding: 10px 0;
    }
    .row:first-child { border-top: 0; }
    .name { font-weight: 700; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .empty { color: var(--muted); border-top: 1px solid var(--line); padding-top: 10px; }
    .warn { color: var(--warn); }
    .pairing {
      display: grid;
      gap: 10px;
    }
    .pair-command {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: stretch;
    }
    .pair-code {
      border: 1px solid var(--dark);
      background: #eef3ef;
      padding: 12px;
      font-family: "SF Mono", Menlo, monospace;
      font-size: 18px;
      word-break: break-word;
    }
    .pair-note {
      color: var(--muted);
      font-size: 13px;
      margin: 0;
    }
    .pair-meta {
      color: var(--muted);
      font-family: "SF Mono", Menlo, monospace;
      font-size: 12px;
      min-height: 18px;
    }
    @media (max-width: 760px) {
      header, .grid, .field { grid-template-columns: 1fr; }
      .status { min-width: 0; }
      .row, .pair-command { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Telegram Setup</h1>
        <p class="sub">Create a bot with <code>@BotFather</code>, then pair the chats Lamarck should capture.</p>
      </div>
      <div class="status" id="connection">Loading connection state</div>
    </header>
    <div class="grid">
      <section>
        <h2>BotFather guide</h2>
        <ol>
          <li>Open Telegram and search for <code>@BotFather</code>.</li>
          <li>Send <code>/newbot</code>, choose a display name, then choose a globally unique username ending in <code>bot</code>.</li>
          <li>Copy the token BotFather gives you.</li>
          <li>Paste it into the Telegram Bot auth field in Source Console.</li>
          <li>Generate a pairing code here, then send the shown <code>/pair</code> command from the direct message or group you want to pair.</li>
        </ol>
      </section>
      <section>
        <h2>Pair a chat</h2>
        <div class="pairing">
          <p class="pair-note">Generate a command, then send it from the direct message or group you want to pair.</p>
          <div class="pair-command">
            <div id="pairing-status" class="pair-code">Ready to pair</div>
            <button id="copy-pairing" class="secondary" hidden>Copy</button>
          </div>
          <div id="pairing-meta" class="pair-meta"></div>
          <button id="generate-pairing">Generate code</button>
        </div>
      </section>
      <section>
        <h2>Paired users</h2>
        <div id="paired-users" class="empty">No paired users</div>
      </section>
      <section>
        <h2>Paired groups</h2>
        <div id="paired-groups" class="empty">No paired groups</div>
      </section>
      <section>
        <h2>Capture policy</h2>
        <div class="field">
          <label for="dm-mode">Direct messages</label>
          <select id="dm-mode">
            <option value="paired_only">Paired users only</option>
            <option value="capture_all">All direct messages</option>
            <option value="disabled">Do not capture</option>
          </select>
        </div>
        <div class="field">
          <label for="group-mode">Groups</label>
          <select id="group-mode">
            <option value="disabled">Do not capture</option>
            <option value="paired_only">Paired groups only</option>
            <option value="capture_all">All groups</option>
          </select>
        </div>
        <div class="field">
          <label for="require-mention">Group mention</label>
          <span><input type="checkbox" id="require-mention"> Require @botname mention</span>
        </div>
        <button id="save-policy">Save policy</button>
      </section>
      <section>
        <h2>Unpaired activity</h2>
        <div id="pending-users" class="empty">No unpaired users seen</div>
      </section>
      <section>
        <h2>Unpaired group activity</h2>
        <div id="pending-groups" class="empty">No unpaired groups seen</div>
      </section>
    </div>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get("token");
    let snapshot = null;
    let latestPairingCommand = null;
    let pairingRefreshTimer = null;

    async function api(path, options = {}) {
      const res = await fetch(path + "?token=" + encodeURIComponent(token), {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers || {}) },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Request failed");
      return body;
    }

    async function load() {
      snapshot = await api("/api/snapshot");
      render();
      schedulePairingRefresh();
    }

    function render() {
      const setup = snapshot.config.telegramSetup;
      const state = snapshot.state;
      const bot = state.bot;
      document.getElementById("connection").innerHTML = bot
        ? "Connected as <strong>@" + escapeHtml(bot.username || bot.firstName || bot.id) + "</strong>"
        : "<span class='warn'>Waiting for auth and watcher start</span>";
      renderPairing(state.setup);
      document.getElementById("dm-mode").value = setup.dm.mode;
      document.getElementById("group-mode").value = setup.groups.mode;
      document.getElementById("require-mention").checked = setup.groups.requireMention;
      renderCandidates("pending-users", state.setup.pendingUsers, "user");
      renderCandidates("pending-groups", state.setup.pendingGroups, "group");
      renderPairedRecords("paired-users", state.setup.pairedUsers, "user");
      renderPairedRecords("paired-groups", state.setup.pairedGroups, "group");
    }

    function renderPairing(setupState) {
      const el = document.getElementById("pairing-status");
      const meta = document.getElementById("pairing-meta");
      const copy = document.getElementById("copy-pairing");
      const last = setupState.lastPairingAttempt;
      const challenge = setupState.pairingChallenge;
      const challengeActive = Number.isFinite(challenge?.expiresAt) && challenge.expiresAt >= Date.now();
      if (latestPairingCommand && challengeActive) {
        el.textContent = latestPairingCommand.command;
        copy.hidden = false;
        meta.textContent = pairingMeta(latestPairingCommand.expiresAt, last?.status);
        return;
      }
      latestPairingCommand = null;
      if (challengeActive) {
        el.textContent = last?.status === "wrong_code" ? "Code not recognized" : "Code active";
        copy.hidden = true;
        meta.textContent = pairingMeta(challenge.expiresAt, last?.status);
        return;
      }
      copy.hidden = true;
      meta.textContent = "";
      if (last && (last.status === "paired_user" || last.status === "paired_group")) {
        const records = last.status === "paired_group" ? setupState.pairedGroups : setupState.pairedUsers;
        const item = records?.[String(last.id)];
        el.textContent = "Paired · " + recordLabel(item, last.id);
        return;
      }
      if (last?.status === "expired_or_missing") {
        el.textContent = "Code expired";
        return;
      }
      if (challenge?.expiresAt) {
        el.textContent = "Code expired";
        return;
      }
      el.textContent = "Ready to pair";
    }

    function pairingMeta(expiresAt, lastStatus) {
      const prefix = lastStatus === "wrong_code" ? "Try again · " : "";
      return prefix + "Expires " + new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · One use";
    }

    function schedulePairingRefresh() {
      clearTimeout(pairingRefreshTimer);
      const expiresAt = snapshot?.state?.setup?.pairingChallenge?.expiresAt;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      pairingRefreshTimer = setTimeout(() => {
        load().catch(showError);
      }, 1500);
    }

    function renderCandidates(id, records, kind) {
      const el = document.getElementById(id);
      const entries = Object.entries(records || {});
      if (!entries.length) {
        el.className = "empty";
        el.textContent = kind === "user" ? "No unpaired users seen" : "No unpaired groups seen";
        return;
      }
      el.className = "";
      el.innerHTML = entries.map(([key, item]) => {
        return "<div class='row'><div><div class='name'>" + escapeHtml(recordLabel(item, key)) + "</div><div class='meta'>ID " + escapeHtml(key) + " · unpaired</div></div><button class='secondary' data-action='clear' data-kind='" + kind + "' data-id='" + escapeHtml(key) + "'>Clear</button></div>";
      }).join("");
    }

    function renderPairedRecords(id, records, kind) {
      const el = document.getElementById(id);
      const entries = Object.entries(records || {});
      if (!entries.length) {
        el.className = "empty";
        el.textContent = kind === "user" ? "No paired users" : "No paired groups";
        return;
      }
      el.className = "";
      el.innerHTML = entries.map(([key, item]) => {
        return "<div class='row'><div><div class='name'>" + escapeHtml(recordLabel(item, key)) + "</div><div class='meta'>ID " + escapeHtml(key) + "</div></div><button class='secondary' data-action='unpair' data-kind='" + kind + "' data-id='" + escapeHtml(key) + "'>Unpair</button></div>";
      }).join("");
    }

    function recordLabel(item, fallback) {
      if (item?.title) return item.title;
      if (item?.username) return "@" + item.username;
      return [item?.firstName, item?.lastName].filter(Boolean).join(" ") || String(fallback);
    }

    document.addEventListener("click", async (event) => {
      const target = event.target;
      if (target.id === "save-policy") {
        const next = structuredClone(snapshot.config.telegramSetup);
        next.dm.mode = document.getElementById("dm-mode").value;
        next.groups.mode = document.getElementById("group-mode").value;
        next.groups.requireMention = document.getElementById("require-mention").checked;
        await api("/api/policy", { method: "POST", body: JSON.stringify({ telegramSetup: next }) });
        await load();
      }
      if (target.id === "generate-pairing") {
        latestPairingCommand = await api("/api/pairing-code", { method: "POST", body: "{}" });
        await load();
      }
      if (target.id === "copy-pairing" && latestPairingCommand) {
        await navigator.clipboard.writeText(latestPairingCommand.command);
        target.textContent = "Copied";
        setTimeout(() => { target.textContent = "Copy"; }, 1200);
      }
      if (target.dataset.action === "clear" || target.dataset.action === "unpair") {
        await api("/api/" + target.dataset.action, {
          method: "POST",
          body: JSON.stringify({ kind: target.dataset.kind, id: target.dataset.id }),
        });
        await load();
      }
    });

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    function showError(err) {
      document.getElementById("connection").textContent = err.message;
    }

    load().catch(showError);
  </script>
</body>
</html>`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function stripUndefined(value) {
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function compactObject(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringFrom(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readNowMs(now) {
  if (typeof now === "function") return Number(now());
  if (Number.isFinite(now)) return Number(now);
  return Date.now();
}

function randomToken() {
  return randomBytes(18).toString("base64url");
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
