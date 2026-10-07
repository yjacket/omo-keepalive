/**
 * Pure park policy module - no I/O, no Date.now()
 * Determines parking state based on usage snapshots and config
 */

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
      // Store binding window: the one with latest resetAt
      const binding = overWindows.reduce((latest, w) =>
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

  // Provider resetAt = EARLIEST of binding resetAt times
  // (first account to free determines when the park lifts)
  const providerResetAt = Math.min(...accounts.map(acc => accountBindings[acc].window.resetAt));
  const bindingWindow = Object.values(accountBindings).find(b => b.window.resetAt === providerResetAt).window;

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
    for (const acc of accounts) {
      const binding = accountBindings[acc];
      
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
