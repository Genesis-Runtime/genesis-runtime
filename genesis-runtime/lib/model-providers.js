import { normalizePluginId } from "./plugin-system-helpers.js";

/**
 * Model provider types (core API 1.6.0). Genesis runs no models, but hosts used to hard-code
 * which kinds of model endpoint they understand ("ollama", "openai-compatible", ...), so a new
 * kind such as a Meterless Runtime meant patching the host. A plugin now registers a provider
 * type: how its configuration is edited (fields, defaults, secrets, actions), how it is checked
 * (probe), and how a completion is made (generate). A host lists the types to build its model
 * editor and calls generate for any processor whose provider is a registered type.
 *
 * Secrets: a provider declares the handles it uses, and its handlers reach them only through
 * ctx.secrets, backed by the installed `secrets:*` capabilities (a host or the secrets
 * plugin). A secret value is never returned by any route.
 */

const FIELD_TYPES = ["text", "url", "number", "select", "textarea", "checkbox"];
const MAX_FIELDS = 24;

function text(value, limit = 400) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeField(field = {}) {
  if (!field || typeof field !== "object") return null;
  const id = String(field.id || field.name || "").trim();
  if (!/^[A-Za-z][\w.-]*$/.test(id)) return null;
  const type = FIELD_TYPES.includes(String(field.type || "").toLowerCase()) ? String(field.type).toLowerCase() : "text";
  return {
    id,
    label: text(field.label || id, 80) || id,
    type,
    ...(field.placeholder ? { placeholder: text(field.placeholder, 200) } : {}),
    ...(field.help ? { help: text(field.help) } : {}),
    required: field.required === true,
    ...(type === "select" && Array.isArray(field.options)
      ? { options: field.options.map((option) => (typeof option === "object" && option ? { value: String(option.value ?? ""), label: text(option.label || option.value, 120) } : { value: String(option), label: String(option) })).filter((option) => option.value) }
      : {}),
    // A select whose options a probe fills in (e.g. the models a runtime lists).
    ...(field.optionsFrom === "probe" ? { optionsFrom: "probe" } : {})
  };
}

export function normalizeModelProviderDescriptor(pluginId = "", descriptor = {}, handlers = {}) {
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId || !descriptor || typeof descriptor !== "object" || typeof handlers?.generate !== "function") {
    return null;
  }
  const id = normalizePluginId(descriptor.id || "");
  if (!id) return null;
  const secrets = (Array.isArray(descriptor.secrets) ? descriptor.secrets : [])
    .map((secret) => (typeof secret === "string" ? { handle: secret } : secret))
    .filter((secret) => secret && /^[A-Za-z0-9][\w.-]*$/.test(String(secret.handle || "")))
    .map((secret) => ({ handle: String(secret.handle), label: text(secret.label || secret.handle, 80), ...(secret.help ? { help: text(secret.help) } : {}) }));
  const actionHandlers = handlers.actions && typeof handlers.actions === "object" ? handlers.actions : {};
  const actions = (Array.isArray(descriptor.actions) ? descriptor.actions : [])
    .map((action) => (typeof action === "string" ? { id: action } : action))
    .filter((action) => action && typeof actionHandlers[action.id] === "function")
    .map((action) => ({ id: String(action.id), label: text(action.label || action.id, 60), ...(action.description ? { description: text(action.description) } : {}) }));
  const defaults = descriptor.defaults && typeof descriptor.defaults === "object" && !Array.isArray(descriptor.defaults)
    ? structuredClone(descriptor.defaults) : {};
  const capabilities = descriptor.capabilities && typeof descriptor.capabilities === "object" ? descriptor.capabilities : {};
  return {
    id,
    pluginId: normalizedPluginId,
    label: text(descriptor.label || id, 80) || id,
    description: text(descriptor.description),
    protocol: text(descriptor.protocol || "custom", 40),
    defaults,
    fields: (Array.isArray(descriptor.fields) ? descriptor.fields : []).map(normalizeField).filter(Boolean).slice(0, MAX_FIELDS),
    secrets,
    actions,
    capabilities: {
      chat: capabilities.chat !== false,
      json: capabilities.json === true,
      tools: capabilities.tools === true,
      embeddings: capabilities.embeddings === true
    },
    handlers: {
      generate: handlers.generate,
      ...(typeof handlers.normalizeConfig === "function" ? { normalizeConfig: handlers.normalizeConfig } : {}),
      ...(typeof handlers.probe === "function" ? { probe: handlers.probe } : {}),
      actions: Object.fromEntries(actions.map((action) => [action.id, actionHandlers[action.id]]))
    }
  };
}

// The public view: everything a model editor needs, no functions.
export function describeModelProvider(provider = {}) {
  return {
    id: provider.id,
    pluginId: provider.pluginId,
    label: provider.label,
    description: provider.description,
    protocol: provider.protocol,
    defaults: structuredClone(provider.defaults || {}),
    fields: structuredClone(provider.fields || []),
    secrets: structuredClone(provider.secrets || []),
    actions: structuredClone(provider.actions || []),
    capabilities: { ...provider.capabilities },
    probe: typeof provider.handlers?.probe === "function"
  };
}

// What generate() may return: a string, or { text, raw, finishReason, usage, model }.
export function normalizeCompletion(value) {
  const raw = typeof value === "string" ? { text: value } : value;
  if (!raw || typeof raw !== "object" || typeof raw.text !== "string") {
    throw new TypeError("model provider returned no text");
  }
  return {
    text: raw.text,
    ...(raw.raw !== undefined ? { raw: raw.raw } : {}),
    finishReason: raw.finishReason ?? null,
    ...(raw.usage && typeof raw.usage === "object" ? { usage: { ...raw.usage } } : {}),
    ...(raw.model ? { model: String(raw.model) } : {})
  };
}

// Probe results keep one shape whatever the provider returns.
export function normalizeProbe(value) {
  const raw = value && typeof value === "object" ? value : {};
  const status = ["online", "unauthorized", "offline"].includes(raw.status) ? raw.status : "offline";
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .map((model) => (typeof model === "string" ? { id: model } : model))
    .filter((model) => model && String(model.id ?? "").trim())
    .map((model) => ({ id: String(model.id), ...(model.description ? { description: text(model.description, 200) } : {}) }));
  return {
    status,
    models,
    detail: text(raw.detail),
    ...(raw.config && typeof raw.config === "object" ? { config: raw.config } : {})
  };
}
