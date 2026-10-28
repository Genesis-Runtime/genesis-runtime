import { normalizePluginId, normalizePriority } from "./plugin-system-helpers.js";

/**
 * Scoped context providers (core API 1.6.0). A plugin that holds data a conversation may ask
 * about registers a provider; a host about to answer a message collects from the providers
 * whose scope the message falls in, and shows the model only those notes, attributed to the
 * plugin they came from. Genesis owns the contract, the scoping, budgets and failure
 * isolation; it never calls a model.
 *
 * Scope is decided in two steps, both optional:
 *   - match: declarative keywords and patterns (cheap, no plugin code runs), or a function
 *   - provide(request): the plugin's own answer; returning null means "not about my data",
 *     which is how a provider scopes on identifiers only its data knows
 * A provider with neither keywords nor patterns nor a match function is asked every time.
 */

export const CONTEXT_AUDIENCES = ["chat", "intake", "worker", "planner"];
export const DEFAULT_CONTEXT_MAX_CHARS = 6000;
export const DEFAULT_PROVIDER_MAX_CHARS = 2400;
const MAX_KEYWORDS = 32;
const MAX_PATTERNS = 16;

export function contextProviderKey(pluginId = "", providerId = "") {
  return `${pluginId}:${providerId}`;
}

function compilePattern(source) {
  if (source instanceof RegExp) {
    return new RegExp(source.source, source.flags.replace("g", ""));
  }
  const text = String(source ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    return new RegExp(text, "i");
  } catch {
    return null;
  }
}

export function normalizeContextProviderDescriptor(pluginId = "", descriptor = {}) {
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId || !descriptor || typeof descriptor !== "object") {
    return null;
  }
  const id = normalizePluginId(descriptor.id || descriptor.name || normalizedPluginId);
  if (!id) {
    return null;
  }
  const audiences = [...new Set((Array.isArray(descriptor.audiences) ? descriptor.audiences : ["chat"])
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter((entry) => CONTEXT_AUDIENCES.includes(entry)))];
  const match = descriptor.match;
  const keywords = typeof match === "object" && match && !Array.isArray(match)
    ? [...new Set((Array.isArray(match.keywords) ? match.keywords : [])
      .map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean))].slice(0, MAX_KEYWORDS)
    : [];
  const patterns = typeof match === "object" && match && !Array.isArray(match)
    ? (Array.isArray(match.patterns) ? match.patterns : []).map(compilePattern).filter(Boolean).slice(0, MAX_PATTERNS)
    : [];
  const maxChars = Number(descriptor.maxChars);
  return {
    id,
    pluginId: normalizedPluginId,
    key: contextProviderKey(normalizedPluginId, id),
    title: String(descriptor.title || descriptor.name || id).trim() || id,
    description: String(descriptor.description || "").trim(),
    instruction: String(descriptor.instruction || "").trim(),
    audiences: audiences.length ? audiences : ["chat"],
    priority: normalizePriority(descriptor.priority),
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.min(20000, Math.round(maxChars)) : DEFAULT_PROVIDER_MAX_CHARS,
    match: {
      keywords,
      patterns,
      custom: typeof match === "function" ? match : null
    }
  };
}

// The public view of a provider: what it is and how it is scoped, never its functions.
export function describeContextProvider(provider = {}) {
  return {
    key: provider.key,
    id: provider.id,
    pluginId: provider.pluginId,
    title: provider.title,
    description: provider.description,
    audiences: provider.audiences,
    priority: provider.priority,
    maxChars: provider.maxChars,
    scope: {
      keywords: provider.match?.keywords || [],
      patterns: (provider.match?.patterns || []).map((pattern) => pattern.source),
      custom: Boolean(provider.match?.custom)
    }
  };
}

function wordPattern(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}`, "iu");
}

// The declarative step: which keywords (matched at a word start, so "invoice" matches
// "invoices") and patterns the message hits. Null means the provider has no declarative scope.
export function matchDeclarativeScope(provider = {}, message = "") {
  const { keywords = [], patterns = [] } = provider.match || {};
  if (!keywords.length && !patterns.length) {
    return null;
  }
  const text = String(message || "");
  const matchedKeywords = keywords.filter((keyword) => wordPattern(keyword).test(text));
  const matchedPatterns = [];
  for (const pattern of patterns) {
    const found = text.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
    if (found) {
      matchedPatterns.push(...found);
    }
  }
  return {
    matched: matchedKeywords.length > 0 || matchedPatterns.length > 0,
    keywords: matchedKeywords,
    patterns: [...new Set(matchedPatterns)]
  };
}

function cleanText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

// What provide() may return: null/""/[] (nothing), a string, a list of strings, or
// { notes, instruction, sources }.
export function normalizeContribution(provider = {}, value = null) {
  if (value === null || value === undefined || value === false) {
    return null;
  }
  const raw = typeof value === "string" || Array.isArray(value) ? { notes: value } : value;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const notes = (Array.isArray(raw.notes) ? raw.notes : [raw.notes]).map(cleanText).filter(Boolean);
  if (!notes.length) {
    return null;
  }
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .map((source) => (typeof source === "string" ? { id: source } : source))
    .filter((source) => source && typeof source === "object" && String(source.id ?? "").trim())
    .map((source) => ({ id: String(source.id).trim(), ...(source.label ? { label: String(source.label).trim() } : {}) }))
    .slice(0, 32);
  let remaining = provider.maxChars ?? DEFAULT_PROVIDER_MAX_CHARS;
  const kept = [];
  let truncated = false;
  for (const note of notes) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (note.length > remaining) {
      kept.push(`${note.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`);
      truncated = true;
      remaining = 0;
      break;
    }
    kept.push(note);
    remaining -= note.length;
  }
  return {
    instruction: cleanText(raw.instruction) || provider.instruction || "",
    notes: kept,
    sources,
    truncated
  };
}

// One prompt-ready block per section, attributed, within the total budget. Sections arrive in
// priority order; whatever does not fit is reported, not silently cut mid-note.
export function assembleContext(sections = [], maxChars = DEFAULT_CONTEXT_MAX_CHARS) {
  const included = [];
  const omitted = [];
  let used = 0;
  for (const section of sections) {
    const block = [
      `## ${section.title} (from ${section.pluginName || section.pluginId})`,
      section.instruction,
      section.notes.join("\n---\n")
    ].filter(Boolean).join("\n");
    if (used + block.length > maxChars && included.length > 0) {
      omitted.push({ key: section.key, reason: "context budget exhausted" });
      continue;
    }
    included.push({ ...section, text: block, chars: block.length });
    used += block.length + 2;
  }
  return {
    sections: included,
    text: included.map((section) => section.text).join("\n\n"),
    chars: Math.max(0, used - 2),
    omitted
  };
}
