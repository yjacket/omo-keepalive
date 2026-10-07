import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createHarness({
  sessionId = "s1", isChild = false, model = undefined, branch = [], env = {}, homeDir = undefined, now = 0,
} = {}) {
  const handlers = new Map();
  const commands = new Map();
  const statusLines = new Map();
  const notifications = [];
  const sentMessages = [];
  const sentUserMessages = [];
  const shutdownCalls = [];
  const eventsEmitted = [];
  const timers = new Map();
  let timerId = 0;
  let current = now;
  const tmpHome = homeDir ?? mkdtempSync(join(tmpdir(), "limitless-"));
  const clock = {
    now: () => current,
    advance(ms) {
      current += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= current);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
  const register = (map, name, handler) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(handler);
  };
  const pi = {
    // Senpi ExtensionAPI.on registers an event handler; this fake retains all handlers.
    on: (name, handler) => register(handlers, name, handler),
    // Senpi commands are factory-registered by name with a definition object.
    registerCommand: (name, definition) => commands.set(name, definition),
    // Senpi's shared event bus accepts listeners and emits payloads independently of extension events.
    events: {
      on: (name, handler) => register(handlers, `event:${name}`, handler),
      emit: (name, payload) => {
        eventsEmitted.push({ name, payload });
        return Promise.all((handlers.get(`event:${name}`) ?? []).map((handler) => handler(payload)));
      },
    },
    // Senpi sendMessage accepts custom message plus trigger/delivery options.
    sendMessage: (msg, opts) => sentMessages.push({ msg, opts }),
    // Senpi sendUserMessage always triggers a turn and accepts delivery options.
    sendUserMessage: (text, opts) => sentUserMessages.push({ text, opts }),
    // Timers are provided for extension code that injects clock primitives.
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, at: current + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const ctx = {
    // Senpi session manager exposes current id, branch, and complete branch entries.
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
      getEntries: () => branch,
    },
    model,
    // Senpi UI status is keyed; notifications accept message and severity.
    ui: {
      setStatus: (key, text) => text === undefined ? statusLines.delete(key) : statusLines.set(key, text),
      notify: (text, level) => notifications.push({ text, level }),
    },
    // Senpi reports idle state and shuts down the current session through context methods.
    isIdle: () => true,
    shutdown: () => shutdownCalls.push(true),
    hasUI: true,
    isChild,
  };
  return {
    pi, ctx, handlers, commands, statusLines, notifications, sentMessages, sentUserMessages,
    shutdownCalls, eventsEmitted, clock, tmpHome,
    async fire(eventName, payload = {}) {
      return Promise.all((handlers.get(eventName) ?? []).map((handler) => handler(payload, ctx)));
    },
    cleanup() {
      if (homeDir === undefined) rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}
