// A collapsible panel for host UIs and plugin tabs, such as the box that shows a model's
// reply (core API 1.6.0). Framework-free and DOM-only when called, so it imports anywhere.
// Settings come from GET /api/ui/settings -> responsePanel (lib/ui-settings.js).
//
//   const panel = createCollapsible({ container: dock, body: replyText, toggle: button,
//     storageKey: "app.reply", settings: uiSettings.responsePanel });
//   panel.reveal();   // on a new reply: opens the panel unless settings say otherwise
//
// Collapsing hides `body`, puts `collapsedClass` on `container`, and keeps the toggle's
// label, aria-expanded and aria-controls in step.

const DEFAULT_LABELS = { collapse: "Minimise", expand: "Expand" };

function readStored(storage, key) {
  if (!storage || !key) return null;
  try {
    const value = storage.getItem(key);
    return value === "collapsed" ? true : value === "expanded" ? false : null;
  } catch {
    return null;
  }
}

function writeStored(storage, key, collapsed) {
  if (!storage || !key) return;
  try {
    storage.setItem(key, collapsed ? "collapsed" : "expanded");
  } catch {
    // Storage may be blocked (private window); the panel still works.
  }
}

export function createCollapsible({
  container,
  body,
  toggle = null,
  labels = {},
  collapsedClass = "collapsed",
  storageKey = "",
  storage = globalThis.localStorage,
  settings = {}
} = {}) {
  if (!container || !body) {
    throw new TypeError("createCollapsible needs a container and a body element");
  }
  const options = {
    collapsible: settings.collapsible !== false,
    startCollapsed: settings.startCollapsed === true,
    expandOnNewReply: settings.expandOnNewReply !== false,
    rememberState: settings.rememberState !== false
  };
  const text = { ...DEFAULT_LABELS, ...labels };
  const remembered = options.rememberState ? readStored(storage, storageKey) : null;
  let collapsed = false;
  const listeners = new Set();

  if (toggle) {
    if (body.id && typeof toggle.setAttribute === "function") toggle.setAttribute("aria-controls", body.id);
    toggle.hidden = !options.collapsible;
  }

  function render() {
    container.classList?.toggle(collapsedClass, collapsed);
    body.hidden = collapsed;
    if (toggle) {
      toggle.setAttribute?.("aria-expanded", String(!collapsed));
      toggle.textContent = collapsed ? text.expand : text.collapse;
    }
  }

  function setCollapsed(next, { remember = true } = {}) {
    const value = options.collapsible && next === true;
    if (value === collapsed) return collapsed;
    collapsed = value;
    render();
    if (remember && options.rememberState) writeStored(storage, storageKey, collapsed);
    for (const listener of listeners) listener(collapsed);
    return collapsed;
  }

  const onToggle = () => setCollapsed(!collapsed);
  toggle?.addEventListener?.("click", onToggle);

  collapsed = options.collapsible && (remembered ?? options.startCollapsed);
  render();

  return {
    isCollapsed: () => collapsed,
    collapse: () => setCollapsed(true),
    expand: () => setCollapsed(false),
    toggle: onToggle,
    setCollapsed,
    // New content arrived: open the panel (without overwriting the viewer's remembered
    // choice) unless the settings keep it closed.
    reveal() {
      if (options.expandOnNewReply) setCollapsed(false, { remember: false });
      return collapsed;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      toggle?.removeEventListener?.("click", onToggle);
      listeners.clear();
    }
  };
}
