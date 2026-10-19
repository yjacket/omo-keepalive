import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the session's lane (provider and accounts).
 * 
 * @param {Object} opts
 * @param {Object} opts.model - ctx.model or undefined (has provider, api fields)
 * @param {Array} opts.branch - Session branch entries (array of messages)
 * @param {Object} opts.authJson - Parsed auth.json or null
 * @returns {{provider: string, accounts: string[]}}
 *   provider: "anthropic-subscription", "chatgpt-subscription", "other", or "unknown"
 *   accounts: list of account names
 */
export function resolveLane({ model, branch, authJson }) {
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

  return {
    provider,
    accounts
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
  if (Array.isArray(providerEntry?.accounts)) {
    return providerEntry.accounts
      .filter(acc => acc && typeof acc === 'object' && acc.name)
      .map(acc => acc.name);
  }

  return providerEntry ? ['default'] : [];
}

/**
 * Read and parse auth.json.
 * 
 * @param {Object} opts
 * @param {Object} opts.env - Environment variables
 * @param {string} opts.homeDir - User home directory path
 * @param {Object} opts.fs - File system object (readFileSync, statSync, etc.)
 * @returns {Object|null} Parsed auth.json or null (never throws)
 */
export function readAuthJson({ env, homeDir, fs }) {
  try {
    // Determine path: OMO_KEEPALIVE_AUTH_PATH or <homeDir>/.omo/agent/auth.json
    let authPath;
    if (typeof env === 'object' && env !== null) {
      // env is an object (for testing)
      const envPath = env['OMO_KEEPALIVE_AUTH_PATH'];
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
