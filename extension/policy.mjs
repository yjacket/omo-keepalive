/**
 * Pure park policy module - no I/O, no Date.now()
 * Determines parking state based on usage snapshots and config
 */

// Windows over threshold as Map<kind, earliest finite resetAt | null>, with policy's park rule: empty unless EVERY
// account of the provider has an over window (union of the over kinds across accounts otherwise).
export function overWindows({ snapshots, config }) {
  const provider = snapshots?.[0]?.provider;
  const own = (snapshots ?? []).filter((s) => s?.provider === provider && Array.isArray(s.windows));
  const kinds = new Map();
  let accountsOver = 0;
  for (const snapshot of own) {
    const over = snapshot.windows.filter((w) =>
      w.utilization >= (w.kind === "five_hour" ? config.thresholds.fiveHour : config.thresholds.sevenDay));
    if (over.length > 0) accountsOver += 1;
    for (const w of over) {
      const known = Number.isFinite(w.resetAt) ? w.resetAt : null;
      const prev = kinds.get(w.kind);
      kinds.set(w.kind, prev === undefined || prev === null ? known : known === null ? prev : Math.min(prev, known));
    }
  }
  return own.length > 0 && accountsOver === new Set(own.map((s) => s.account)).size ? kinds : new Map();
}

export function decide({ snapshots, config, now }) {
  // Edge cases: empty or source "none"
  if (!snapshots || snapshots.length === 0) {
    return { state: "ok", reason: "no snapshots" };
  }

  if (snapshots.length === 1 && snapshots[0].source === "none") {
    return { state: "ok", reason: "source none" };
  }

  const provider = snapshots[0]?.provider;
  
  // Unknown provider: no waitLimitMs entry means ok
  if (!config.waitLimitMs.hasOwnProperty(provider)) {
    return { state: "ok", reason: "unknown provider" };
  }

  // Collect ALL accounts and find over windows for each
  const allAccounts = new Set();
  const accountBindings = {};
  
  for (const snapshot of snapshots) {
    if (snapshot.provider !== provider) continue;
    allAccounts.add(snapshot.account);
  }

  // Check each account for over windows
  for (const snapshot of snapshots) {
    if (snapshot.provider !== provider) continue;
    
    const account = snapshot.account;
    const thresholds = config.thresholds;
    
    // Find all over windows for this account
    const overWindows = snapshot.windows.filter(w => {
      const threshold = w.kind === "five_hour" ? thresholds.fiveHour : thresholds.sevenDay;
      return w.utilization >= threshold;
    });

    if (overWindows.length > 0) {
      // Missing or invalid reset times cannot be waited on safely.
      const validOverWindows = overWindows.filter(w =>
        Number.isFinite(w.resetAt)
      );
      if (validOverWindows.length === 0) {
        accountBindings[account] = {
          window: null,
          overageEnabled: snapshot.overageEnabled,
          allWindows: snapshot.windows
        };
        continue;
      }

      // Store binding window: the one with latest valid resetAt
      const binding = validOverWindows.reduce((latest, w) =>
        w.resetAt > latest.resetAt ? w : latest
      );
      
      accountBindings[account] = {
        window: binding,
        overageEnabled: snapshot.overageEnabled,
        allWindows: snapshot.windows // Keep for 99% / 100% checks
      };
    }
  }

  // Multi-account rule: park only if EVERY account is over
  // (all accounts must have at least one over window)
  const allAccountsOver = allAccounts.size > 0 && 
    allAccounts.size === Object.keys(accountBindings).length;

  if (!allAccountsOver) {
    return { state: "ok", reason: "not all accounts over threshold" };
  }

  const accounts = Object.keys(accountBindings);

  // With no known reset, park-wait without a deadline so the caller re-checks.
  if (accounts.every(acc => accountBindings[acc].window === null)) {
    return {
      state: "park-wait",
      resetAt: null,
      warm: { on: false },
      reason: "over threshold; reset unknown"
    };
  }

  // An account with unknown reset blocks waiting, but another known reset
  // provides a safe re-check point.
  // Provider resetAt = EARLIEST of binding resetAt times
  // (first account to free determines when the park lifts)
  const knownBindings = accounts
    .map(acc => accountBindings[acc])
    .filter(binding => binding.window !== null);
  const providerResetAt = Math.min(...knownBindings.map(binding => binding.window.resetAt));
  const bindingWindow = knownBindings.find(b => b.window.resetAt === providerResetAt).window;

  // Determine park-wait vs park-exit based on waitLimitMs
  const waitLimitMs = config.waitLimitMs[provider];
  const timeUntilReset = providerResetAt - now;
  
  // Park-wait only if reset is in future and within waitLimit; otherwise park-exit
  const state = (timeUntilReset > 0 && timeUntilReset <= waitLimitMs) ? "park-wait" : "park-exit";

  // Determine warm.on
  // False when: lane's warm is off, utilization >= 99, or overage enabled with utilization >= 100
  const warmConfig = config.warm[provider];
  let warmOn = warmConfig?.on ?? false;
  
  if (warmOn) {
    // Check all accounts for no-warm conditions
    for (const binding of knownBindings) {
      
      // 99% or higher means no warm
      if (binding.window.utilization >= 99) {
        warmOn = false;
        break;
      }
      
      // Overage enabled + 100% = no warm
      if (binding.overageEnabled && binding.window.utilization >= 100) {
        warmOn = false;
        break;
      }
    }
  }

  const reason = `${bindingWindow.kind === "five_hour" ? "5h" : "7d"} ${bindingWindow.utilization}%`;

  return {
    state,
    window: bindingWindow.kind,
    resetAt: providerResetAt,
    warm: {
      on: warmOn,
      intervalMs: warmConfig?.intervalMs,
      requireTtlSeconds: warmConfig?.requireTtlSeconds
    },
    reason
  };
}
