// The collapsible reply panel (observer-compat/browser/collapsible.js) and its settings.

import assert from "node:assert/strict";
import test from "node:test";
import { createCollapsible } from "../observer-compat/browser/collapsible.js";
import { normalizeResponsePanel } from "./ui-settings.js";
import { profileManagerInternals } from "./profile-manager.js";
import { createGenesisPluginManager } from "./plugin-system.js";

function element(id = "") {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  return {
    id, hidden: false, textContent: "",
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    click: () => listeners.get("click")?.()
  };
}

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

test("the toggle collapses and expands the reply, keeping aria and its label in step", () => {
  const container = element(); const body = element("responseText"); const toggle = element();
  const panel = createCollapsible({ container, body, toggle, storage: null });
  assert.equal(toggle.getAttribute("aria-controls"), "responseText");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.textContent, "Minimise");
  toggle.click();
  assert.equal(panel.isCollapsed(), true);
  assert.equal(body.hidden, true);
  assert.equal(container.classList.contains("collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent, "Expand");
  panel.reveal();
  assert.equal(panel.isCollapsed(), false, "a new reply always opens by default");
});

test("the viewer's choice is remembered, but reveal does not overwrite it", () => {
  const storage = memoryStorage();
  const first = createCollapsible({ container: element(), body: element(), toggle: element(), storage, storageKey: "reply" });
  first.collapse();
  assert.equal(storage.values.get("reply"), "collapsed");
  first.reveal();
  assert.equal(storage.values.get("reply"), "collapsed");
  const again = createCollapsible({ container: element(), body: element(), toggle: element(), storage, storageKey: "reply" });
  assert.equal(again.isCollapsed(), true);
});

test("settings: start collapsed, stay closed on new replies, or not collapsible at all", () => {
  const closed = createCollapsible({ container: element(), body: element(), storage: null, settings: { startCollapsed: true, expandOnNewReply: false } });
  assert.equal(closed.isCollapsed(), true);
  assert.equal(closed.reveal(), true);
  const toggle = element();
  const fixed = createCollapsible({ container: element(), body: element(), toggle, storage: null, settings: { collapsible: false } });
  fixed.collapse();
  assert.equal(fixed.isCollapsed(), false);
  assert.equal(toggle.hidden, true);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => createCollapsible({ container: element(), body: element(), storage: broken, storageKey: "x" }).collapse());
  assert.throws(() => createCollapsible({}), /container and a body/);
});

test("profiles carry responsePanel settings to /api/ui/settings", () => {
  assert.deepEqual(normalizeResponsePanel(), { collapsible: true, startCollapsed: false, expandOnNewReply: true, rememberState: true });
  const profile = profileManagerInternals.normalizeProfile({ id: "p", ui: { responsePanel: { startCollapsed: true } } });
  assert.equal(profile.ui.responsePanel.startCollapsed, true);
  const manager = createGenesisPluginManager({ profile: { ui: { responsePanel: { expandOnNewReply: false } } } });
  assert.equal(manager.getUiSettings().responsePanel.expandOnNewReply, false);
});
