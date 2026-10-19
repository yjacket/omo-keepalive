import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLane, readAuthJson } from '../extension/lane.mjs';

test('resolveLane - empty inputs', () => {
  const result = resolveLane({
    model: undefined,
    branch: [],
    authJson: null,
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'unknown');
  assert.deepStrictEqual(result.accounts, []);
});

test('resolveLane - ctx.model claude-sdk-oauth', () => {
  const result = resolveLane({
    model: { api: 'claude-sdk-oauth', provider: 'anthropic-subscription' },
    branch: [],
    authJson: {
      'anthropic-subscription': {
        accounts: [
          { name: 'default', access: 'token1' },
          { name: 'work', access: 'token2' }
        ]
      }
    },
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'anthropic-subscription');
  assert.deepStrictEqual(result.accounts, ['default', 'work']);
});

test('resolveLane - ctx.model openai-codex-responses', () => {
  const result = resolveLane({
    model: { api: 'openai-codex-responses' },
    branch: [],
    authJson: {
      'chatgpt-subscription': {
        access: 'token1'
      }
    },
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'chatgpt-subscription');
  assert.deepStrictEqual(result.accounts, ['default']);
});

test('resolveLane - flat provider entry without access resolves default account', () => {
  const result = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: { 'anthropic-subscription': { accountId: 'id' } },
  });
  assert.deepStrictEqual(result.accounts, ['default']);
});

test('resolveLane - ctx.model wins over last assistant message', () => {
  const result = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [
      {
        type: 'message',
        message: { role: 'assistant', api: 'openai-codex-responses', provider: 'chatgpt-subscription' }
      }
    ],
    authJson: {
      'anthropic-subscription': {
        access: 'token1'
      },
      'chatgpt-subscription': {
        access: 'token2'
      }
    },
    affinity: undefined
  });
  // Model wins, so provider should be anthropic-subscription
  assert.strictEqual(result.provider, 'anthropic-subscription');
});

test('resolveLane - fallback to last assistant message when model undefined', () => {
  const result = resolveLane({
    model: undefined,
    branch: [
      {
        type: 'message',
        message: { role: 'assistant', api: 'openai-codex-responses', provider: 'chatgpt-subscription' }
      }
    ],
    authJson: {
      'chatgpt-subscription': {
        accounts: [
          { name: 'free', access: 'token1' }
        ]
      }
    },
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'chatgpt-subscription');
  assert.deepStrictEqual(result.accounts, ['free']);
});

test('resolveLane - last assistant message with flat entry', () => {
  const result = resolveLane({
    model: undefined,
    branch: [
      {
        type: 'message',
        message: { role: 'assistant', api: 'openai-codex-responses', provider: 'chatgpt-subscription' }
      }
    ],
    authJson: {
      'chatgpt-subscription': {
        access: 'token1'
      }
    },
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'chatgpt-subscription');
  assert.deepStrictEqual(result.accounts, ['default']);
});

test('resolveLane - unknown api maps to other', () => {
  const result = resolveLane({
    model: { api: 'some-unknown-api' },
    branch: [],
    authJson: null,
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'other');
  assert.deepStrictEqual(result.accounts, []);
});

test('resolveLane - missing auth.json returns empty accounts', () => {
  const result = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: null,
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'anthropic-subscription');
  assert.deepStrictEqual(result.accounts, []);
});

test('resolveLane - chatgpt with multiple accounts', () => {
  const result = resolveLane({
    model: { api: 'openai-codex-responses' },
    branch: [],
    authJson: {
      'chatgpt-subscription': {
        accounts: [
          { name: 'personal', access: 'token1' },
          { name: 'work', access: 'token2' }
        ]
      }
    },
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'chatgpt-subscription');
  assert.deepStrictEqual(result.accounts, ['personal', 'work']);
});

test('resolveLane preserves auth account order', () => {
  const result = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: {
      'anthropic-subscription': {
        accounts: [
          { name: 'alice', access: 'token1' },
          { name: 'bob', access: 'token2' },
          { name: 'charlie', access: 'token3' }
        ]
      }
    },
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'anthropic-subscription');
  assert.deepStrictEqual(result.accounts, ['alice', 'bob', 'charlie']);
});

test('readAuthJson - valid auth.json', () => {
  const authJson = {
    'anthropic-subscription': {
      access: 'token123',
      accounts: [{ name: 'default', access: 'token1' }]
    }
  };

  const result = readAuthJson({
    homeDir: '/home/user',
    fs: {
      readFileSync: () => JSON.stringify(authJson)
    }
  });

  assert.deepStrictEqual(result, authJson);
});

test('readAuthJson - missing file returns null', () => {
  const result = readAuthJson({
    homeDir: '/home/user',
    fs: {
      readFileSync: () => {
        throw new Error('ENOENT');
      }
    }
  });

  assert.strictEqual(result, null);
});

test('readAuthJson - malformed JSON returns null', () => {
  const result = readAuthJson({
    homeDir: '/home/user',
    fs: {
      readFileSync: () => '{invalid json}'
    }
  });

  assert.strictEqual(result, null);
});

test('readAuthJson - env as object', () => {
  const authJson = { test: 'data' };

  const result = readAuthJson({
    env: { 'OMO_KEEPALIVE_AUTH_PATH': '/custom/auth.json' },
    homeDir: '/home/user',
    fs: {
      readFileSync: (path) => {
        assert.strictEqual(path, '/custom/auth.json');
        return JSON.stringify(authJson);
      }
    }
  });

  assert.deepStrictEqual(result, authJson);
});

test('readAuthJson - default path construction', () => {
  const authJson = { test: 'data' };
  let capturedPath = null;

  const result = readAuthJson({
    homeDir: '/home/user',
    fs: {
      readFileSync: (path) => {
        capturedPath = path;
        return JSON.stringify(authJson);
      }
    }
  });

  // Should be /home/user/.omo/agent/auth.json
  assert(capturedPath.includes('.omo'));
  assert(capturedPath.includes('agent'));
  assert(capturedPath.includes('auth.json'));
  assert.deepStrictEqual(result, authJson);
});

test('readAuthJson - never throws', () => {
  const result = readAuthJson({
    homeDir: '/home/user',
    fs: {
      readFileSync: () => {
        throw new Error('Some terrible error!');
      }
    }
  });

  assert.strictEqual(result, null);
});

test('resolveLane - empty branch array falls back to unknown', () => {
  const result = resolveLane({
    model: undefined,
    branch: [],
    authJson: null,
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'unknown');
});

test('resolveLane - branch with non-assistant entries ignores them', () => {
  const result = resolveLane({
    model: undefined,
    branch: [
      { type: 'user_message', content: 'hello' },
      { type: 'tool_result', content: 'result' }
    ],
    authJson: null,
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'unknown');
});

test('resolveLane - finds last assistant message in a long branch', () => {
  const result = resolveLane({
    model: undefined,
    branch: [
      { type: 'message', message: { role: 'assistant', api: 'openai-codex-responses', provider: 'chatgpt-subscription' } },
      { type: 'user_message', content: 'hello' },
      { type: 'message', message: { role: 'assistant', api: 'claude-sdk-oauth', provider: 'anthropic-subscription' } },
      { type: 'user_message', content: 'world' }
    ],
    authJson: {
      'anthropic-subscription': { access: 'token' }
    },
    affinity: undefined
  });
  // Should find the LAST assistant message (index 2)
  assert.strictEqual(result.provider, 'anthropic-subscription');
});

test('readAuthJson - corrupted but valid JSON structure', () => {
  const result = readAuthJson({
    homeDir: '/home/user',
    fs: {
      readFileSync: () => 'null'
    }
  });
  assert.strictEqual(result, null);
});

test('resolveLane - accounts with invalid name field are filtered', () => {
  const result = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: {
      'anthropic-subscription': {
        accounts: [
          { name: 'valid', access: 'token1' },
          { access: 'token2' },  // missing name
          { name: '', access: 'token3' },  // empty name
          { name: 'another', access: 'token4' }
        ]
      }
    },
    affinity: undefined
  });
  assert.strictEqual(result.provider, 'anthropic-subscription');
  assert.deepStrictEqual(result.accounts, ['valid', 'another']);
});

test('resolveLane - real JSONL shape: chatgpt-subscription with openai-codex-responses', () => {
  // This test uses the shape from a real senpi JSONL entry
  const result = resolveLane({
    model: undefined,
    branch: [
      {
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'chatgpt-subscription',
          api: 'openai-codex-responses'
        }
      }
    ],
    authJson: {
      'chatgpt-subscription': {
        access: 'x'
      }
    },
    affinity: undefined
  });
  
  assert.strictEqual(result.provider, 'chatgpt-subscription');
  assert.deepStrictEqual(result.accounts, ['default']);
});
