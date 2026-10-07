import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const GOAL_CONTINUATION_TEXT = "Continue working toward the active thread goal.\n\n<untrusted_objective>fake</untrusted_objective>";

export function createHarness({
  sessionId = "s1", isChild = false, model = undefined, branch = [], env = {}, homeDir = undefined, now = 0,
  goal = null, idle = true,
} = {}) {
  const handlers = new Map();
  const commands = new Map();
  const statusLines = new Map();
  const notifications = [];
  const sentMessages = [];
  const sentUserMessages = [];
  const shutdownCalls = [];
  const eventsEmitted = [];
  const queuedTurns = [];
  const timers = new Map();
  let timerId = 0;
  let current = now;
  let isIdleNow = idle;
  let pendingMessages = false;
  const tmpHome = homeDir ?? mkdtempSync(join(tmpdir(), "limitless-"));
  const dueTimers = () => [...timers.entries()].filter(([, timer]) => timer.at <= current).sort((a, b) => a[1].at - b[1].at);
  const clock = {
    now: () => current,
    advance(ms) {
      current += ms;
      for (const [id, timer] of dueTimers()) {
        timers.delete(id);
        timer.fn();
      }
    },
    // Like advance, but awaits async timer callbacks (and timers they schedule that are already due).
    async tick(ms) {
      current += ms;
      for (let due = dueTimers(); due.length > 0; due = dueTimers()) {
        const [id, timer] = due[0];
        timers.delete(id);
        await timer.fn();
      }
    },
    pendingTimers: () => [...timers.values()].map((timer) => timer.at).sort((a, b) => a - b),
  };
  const register = (map, name, handler) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(handler);
  };
  // In-memory stand-in for senpi's goal store (goal/store.js readGoal/updateGoal through store-ref).
  const goalStore = {
    goal: goal ? { ...goal } : null,
    setStatusCalls: [],
    async read() {
      return goalStore.goal ? { ...goalStore.goal } : null;
    },
    async setStatus(_ctx, status) {
      goalStore.setStatusCalls.push(status);
      if (!goalStore.goal) throw new Error("cannot update goal: no goal exists");
      goalStore.goal = { ...goalStore.goal, status };
      return { ...goalStore.goal };
    },
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
    // Senpi sendMessage accepts custom message plus trigger/delivery options; triggerTurn queues a turn.
    sendMessage: (msg, opts) => {
      sentMessages.push({ msg, opts });
      if (opts?.triggerTurn) queuedTurns.push({ trigger: "extension", prompt: String(msg?.content ?? ""), msg });
    },
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
      getCwd: () => tmpHome,
    },
    cwd: tmpHome,
    model,
    // Senpi UI status is keyed; notifications accept message and severity.
    ui: {
      setStatus: (key, text) => text === undefined ? statusLines.delete(key) : statusLines.set(key, text),
      notify: (text, level) => notifications.push({ text, level }),
    },
    // Senpi reports idle state and shuts down the current session through context methods.
    isIdle: () => isIdleNow,
    hasPendingMessages: () => pendingMessages,
    shutdown: () => shutdownCalls.push(true),
    hasUI: true,
    isChild,
  };
  const fire = async (eventName, payload = {}) =>
    Promise.all((handlers.get(eventName) ?? []).map((handler) => handler(payload, ctx)));
  const harness = {
    pi, ctx, handlers, commands, statusLines, notifications, sentMessages, sentUserMessages,
    shutdownCalls, eventsEmitted, clock, tmpHome, goalStore, queuedTurns,
    fire,
    setIdle(value) { isIdleNow = value; },
    setPendingMessages(value) { pendingMessages = value; },
    setGoal(value) { goalStore.goal = value ? { ...value } : null; },
    // Deps bundle for createCore/startLimitless: injected clock, timers, temp home, fake goal store.
    deps(extra = {}) {
      return {
        env, homeDir: tmpHome, now: clock.now, setTimeout: pi.setTimeout, clearTimeout: pi.clearTimeout,
        goalStore, ...extra,
      };
    },
    writeHomeJson(relativePath, data) {
      const path = join(tmpHome, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
      return path;
    },
    readHomeJson(relativePath) {
      try { return JSON.parse(readFileSync(join(tmpHome, relativePath), "utf8")); } catch { return null; }
    },
    // Mirrors the goal extension's goal_store_changed handler (goal/index.js:81-105): when idle with an
    // active goal it queues a hidden continuation turn (lifecycle-helpers.js queueHiddenGoalPrompt).
    installFakeGoalExtension() {
      pi.events.on("goal_store_changed", async (data) => {
        if (data?.threadId !== sessionId || !ctx.isIdle() || ctx.hasPendingMessages()) return;
        const current = await goalStore.read();
        if (current?.status !== "active") return;
        pi.sendMessage({ customType: "goal-continuation", content: GOAL_CONTINUATION_TEXT, display: false }, { triggerTurn: true, deliverAs: "followUp" });
      });
    },
    // Runs one agent run: before_agent_start, the given tool calls, agent_end, turn_end, agent_settled.
    // A tool "executes" when no tool_call handler returned {block:true}.
    async runTurn({ trigger = "prompt", prompt = "hi", tools = [] } = {}) {
      const before = await fire("before_agent_start", { type: "before_agent_start", trigger, prompt, systemPrompt: "", systemPromptOptions: {} });
      const executed = [];
      const blocked = [];
      for (const toolName of tools) {
        const results = await fire("tool_call", { type: "tool_call", toolName, toolCallId: `${toolName}-${executed.length + blocked.length}`, input: {} });
        const block = results.find((result) => result?.block === true);
        if (block) blocked.push({ toolName, reason: block.reason });
        else executed.push(toolName);
      }
      await fire("agent_end", { type: "agent_end", messages: [] });
      await fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
      await fire("agent_settled", { type: "agent_settled" });
      return { before, executed, blocked };
    },
    async runQueuedTurns(tools = []) {
      const results = [];
      while (queuedTurns.length > 0) {
        const turn = queuedTurns.shift();
        results.push(await harness.runTurn({ trigger: turn.trigger, prompt: turn.prompt, tools }));
      }
      return results;
    },
    cleanup() {
      if (homeDir === undefined) rmSync(tmpHome, { recursive: true, force: true });
    },
  };
  return harness;
}
