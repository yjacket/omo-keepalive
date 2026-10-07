import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the session's lane (provider and accounts).
 * 
 * @param {Object} opts
 * @param {Object} opts.model - ctx.model or undefined (has provider, api fields)
 * @param {Array} opts.branch - Session branch entries (array of messages)
 * @param {Object} opts.authJson - Parsed auth.json or null
 * @param {Object} opts.affinity - Optional affinity info for account ordering
 * @returns {{provider: string, accounts: string[]}}
 *   provider: "anthropic-subscription", "chatgpt-subscription", "other", or "unknown"
 *   accounts: list of account names
 */
export function resolveLane({ model, branch, authJson, affinity }) {
  // Step 1: Determine provider and api from model or last assistant message
  let provider = 'unknown';
  let api = null;

  if (model && model.api) {
    // Primary source: ctx.model
    api = model.api;
    provider = mapApiToProvider(api);
  } else if (branch && Array.isArray(branch) && branch.length > 0) {
    // Secondary source: last assistant message's provider/api
    // Scan from end to find the last assistant message
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      // Real shape: {type:"message", message:{role:"assistant", provider, api, ...}}
      if (entry && entry.type === 'message' && entry.message) {
        if (entry.message.role === 'assistant') {
          api = entry.message.api;
          if (api) {
            provider = mapApiToProvider(api);
            break;
          }
        }
      }
    }
  }

  // Step 2: Resolve accounts based on provider
  const accounts = resolveAccounts(provider, authJson);

  // Step 3: Reorder accounts using affinity (if provided and accounts exist)
  let orderedAccounts = accounts;
  if (affinity && accounts.length > 0) {
    orderedAccounts = orderByAffinity(accounts, affinity);
  }

  return {
    provider,
    accounts: orderedAccounts
  };
}

/**
 * Map api string to provider.
 */
function mapApiToProvider(api) {
  if (!api) return 'unknown';
  if (api === 'claude-sdk-oauth') return 'anthropic-subscription';
  if (api === 'openai-codex-responses') return 'chatgpt-subscription';
  return 'other';
}

/**
 * Resolve accounts for a given provider from authJson.
 * 
 * Rules:
 * - If provider entry has accounts[], return accounts[].name
 * - Else if provider has a flat entry, return ["default"]
 * - Else return []
 */
function resolveAccounts(provider, authJson) {
  if (!authJson) return [];

  const providerKey = provider === 'anthropic-subscription' 
    ? 'anthropic-subscription' 
    : provider === 'chatgpt-subscription' 
    ? 'chatgpt-subscription' 
    : null;

  if (!providerKey) return [];

  const providerEntry = authJson[providerKey];
  if (!providerEntry) return [];

  // If accounts[] exists, extract names
  if (providerEntry.accounts && Array.isArray(providerEntry.accounts)) {
    const names = providerEntry.accounts
      .filter(acc => acc && typeof acc === 'object' && acc.name)
      .map(acc => acc.name);
    return names.length > 0 ? names : [];
  }

  // Else if flat entry exists (check for access token), return ["default"]
  if (providerEntry.access) {
    return ['default'];
  }

  return [];
}

/**
 * Reorder accounts using affinity (HRW or similar).
 * Never adds accounts, only reorders existing ones.
 */
function orderByAffinity(accounts, affinity) {
  if (!affinity || accounts.length === 0) return accounts;

  // If affinity provides an order, use it
  if (affinity.order && Array.isArray(affinity.order)) {
    const ordered = [];
    for (const name of affinity.order) {
      if (accounts.includes(name)) {
        ordered.push(name);
      }
    }
    // Add any remaining accounts not in affinity.order
    for (const name of accounts) {
      if (!ordered.includes(name)) {
        ordered.push(name);
      }
    }
    return ordered;
  }

  return accounts;
}

/**
 * Read and parse auth.json.
 * 
 * @param {Object} opts
 * @param {Object} opts.env - Environment accessor function (name: string) -> string | undefined
 * @param {string} opts.homeDir - User home directory path
 * @param {Object} opts.fs - File system object (readFileSync, statSync, etc.)
 * @returns {Object|null} Parsed auth.json or null (never throws)
 */
export function readAuthJson({ env, homeDir, fs }) {
  try {
    // Determine path: OMO_LIMITLESS_AUTH_PATH or <homeDir>/.omo/agent/auth.json
    let authPath;
    if (env && typeof env === 'function') {
      const envPath = env('OMO_LIMITLESS_AUTH_PATH');
      authPath = envPath || join(homeDir, '.omo', 'agent', 'auth.json');
    } else if (typeof env === 'object' && env !== null) {
      // env is an object (for testing)
      const envPath = env['OMO_LIMITLESS_AUTH_PATH'];
      authPath = envPath || join(homeDir, '.omo', 'agent', 'auth.json');
    } else {
      authPath = join(homeDir, '.omo', 'agent', 'auth.json');
    }

    // Try to read the file
    const fsImpl = fs || { readFileSync };
    const content = fsImpl.readFileSync(authPath, 'utf8');
    
    // Try to parse JSON
    const parsed = JSON.parse(content);
    return parsed || null;
  } catch (e) {
    // Missing, unreadable, or malformed JSON - return null
    return null;
  }
}
