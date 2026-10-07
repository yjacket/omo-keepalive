import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLane } from '../extension/lane.mjs';
import { decide } from '../extension/policy.mjs';

// Default config from the plan
const defaultConfig = {
  thresholds: {
    fiveHour: 90,
    sevenDay: 95
  },
  waitLimitMs: {
    'anthropic-subscription': 4 * 60 * 60 * 1000,  // 4 hours
    'chatgpt-subscription': 2 * 60 * 60 * 1000     // 2 hours
  },
  warm: {
    'anthropic-subscription': {
      on: true,
      intervalMs: 3300000
    },
    'chatgpt-subscription': {
      on: true,
      intervalMs: 1620000,
      requireTtlSeconds: 1800
    }
  }
};

test('lane-policy: empty session with ctx.model claude-sdk-oauth resolves and policy returns ok', () => {
  // Empty branch (no messages) with ctx.model
  const lane = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: {
      'anthropic-subscription': {
        accounts: [{ name: 'default', access: 'token1' }]
      }
    },
    affinity: undefined
  });

  assert.strictEqual(lane.provider, 'anthropic-subscription');
  assert.deepStrictEqual(lane.accounts, ['default']);

  // Now call policy with well below threshold usage
  const now = Date.now();
  const snapshots = [{
    provider: 'anthropic-subscription',
    account: 'default',
    windows: [
      {
        kind: 'five_hour',
        utilization: 50,
        resetAt: now + 3600000
      },
      {
        kind: 'seven_day',
        utilization: 60,
        resetAt: now + 86400000
      }
    ],
    overageEnabled: false,
    source: 'endpoint'
  }];

  const result = decide({ snapshots, config: defaultConfig, now });
  assert.strictEqual(result.state, 'ok');
});

test('lane-policy: two chatgpt accounts at 40% and 96% returns ok', () => {
  const lane = resolveLane({
    model: { api: 'openai-codex-responses' },
    branch: [],
    authJson: {
      'chatgpt-subscription': {
        accounts: [
          { name: 'account1', access: 'token1' },
          { name: 'account2', access: 'token2' }
        ]
      }
    },
    affinity: undefined
  });

  assert.strictEqual(lane.provider, 'chatgpt-subscription');
  assert.deepStrictEqual(lane.accounts, ['account1', 'account2']);

  // Both accounts below threshold: should return ok
  const now = Date.now();
  const snapshots = [
    {
      provider: 'chatgpt-subscription',
      account: 'account1',
      windows: [
        {
          kind: 'seven_day',
          utilization: 40,
          resetAt: now + 86400000
        }
      ],
      overageEnabled: false,
      source: 'endpoint'
    },
    {
      provider: 'chatgpt-subscription',
      account: 'account2',
      windows: [
        {
          kind: 'seven_day',
          utilization: 96,
          resetAt: now + 86400000
        }
      ],
      overageEnabled: false,
      source: 'endpoint'
    }
  ];

  const result = decide({ snapshots, config: defaultConfig, now });
  assert.strictEqual(result.state, 'ok');
});

test('lane-policy: two chatgpt accounts both at 96% returns park-wait', () => {
  const lane = resolveLane({
    model: { api: 'openai-codex-responses' },
    branch: [],
    authJson: {
      'chatgpt-subscription': {
        accounts: [
          { name: 'account1', access: 'token1' },
          { name: 'account2', access: 'token2' }
        ]
      }
    },
    affinity: undefined
  });

  assert.strictEqual(lane.provider, 'chatgpt-subscription');
  assert.deepStrictEqual(lane.accounts, ['account1', 'account2']);

  // Both accounts over threshold: should park
  const now = Date.now();
  const resetTime = now + 1 * 60 * 60 * 1000;  // 1 hour
  const snapshots = [
    {
      provider: 'chatgpt-subscription',
      account: 'account1',
      windows: [
        {
          kind: 'seven_day',
          utilization: 96,
          resetAt: resetTime
        }
      ],
      overageEnabled: false,
      source: 'endpoint'
    },
    {
      provider: 'chatgpt-subscription',
      account: 'account2',
      windows: [
        {
          kind: 'seven_day',
          utilization: 96,
          resetAt: resetTime
        }
      ],
      overageEnabled: false,
      source: 'endpoint'
    }
  ];

  const result = decide({ snapshots, config: defaultConfig, now });
  assert.strictEqual(result.state, 'park-wait');
  assert.strictEqual(result.window, 'seven_day');
  assert.strictEqual(result.warm.on, true);
});

test('lane-policy: resolver + policy with missing auth.json returns ok', () => {
  const lane = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: null
  });

  assert.strictEqual(lane.provider, 'anthropic-subscription');
  assert.deepStrictEqual(lane.accounts, []);

  // When auth.json is missing (accounts = []), there are no snapshots to check.
  // Policy should return ok when there are no snapshots for the provider.
  const now = Date.now();
  const snapshots = [];  // Empty snapshots array when no accounts exist

  const result = decide({ snapshots, config: defaultConfig, now });
  // When accounts[] is empty (auth.json missing), policy returns ok
  assert.strictEqual(result.state, 'ok');
});

test('lane-policy: claude-sdk-oauth above 5h threshold but below 7d', () => {
  const lane = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: {
      'anthropic-subscription': {
        accounts: [{ name: 'default', access: 'token1' }]
      }
    }
  });

  assert.strictEqual(lane.provider, 'anthropic-subscription');

  const now = Date.now();
  const resetTime = now + 3 * 60 * 60 * 1000;  // 3 hours

  const snapshots = [{
    provider: 'anthropic-subscription',
    account: 'default',
    windows: [
      {
        kind: 'five_hour',
        utilization: 92,
        resetAt: resetTime
      },
      {
        kind: 'seven_day',
        utilization: 80,
        resetAt: now + 86400000
      }
    ],
    overageEnabled: false,
    source: 'endpoint'
  }];

  const result = decide({ snapshots, config: defaultConfig, now });
  assert.strictEqual(result.state, 'park-wait');
  assert.strictEqual(result.window, 'five_hour');
});

test('lane-policy: claude above threshold with long wait time returns park-exit', () => {
  const lane = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: {
      'anthropic-subscription': {
        accounts: [{ name: 'default', access: 'token1' }]
      }
    }
  });

  const now = Date.now();
  const resetTime = now + 5 * 60 * 60 * 1000;  // 5 hours (beyond 4h limit)

  const snapshots = [{
    provider: 'anthropic-subscription',
    account: 'default',
    windows: [
      {
        kind: 'seven_day',
        utilization: 96,
        resetAt: resetTime
      }
    ],
    overageEnabled: false,
    source: 'endpoint'
  }];

  const result = decide({ snapshots, config: defaultConfig, now });
  assert.strictEqual(result.state, 'park-exit');
});

test('lane-policy: 99% utilization disables warm', () => {
  const lane = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: {
      'anthropic-subscription': {
        accounts: [{ name: 'default', access: 'token1' }]
      }
    }
  });

  const now = Date.now();
  const resetTime = now + 1 * 60 * 60 * 1000;

  const snapshots = [{
    provider: 'anthropic-subscription',
    account: 'default',
    windows: [
      {
        kind: 'seven_day',
        utilization: 99,
        resetAt: resetTime
      }
    ],
    overageEnabled: false,
    source: 'endpoint'
  }];

  const result = decide({ snapshots, config: defaultConfig, now });
  assert.strictEqual(result.state, 'park-wait');
  assert.strictEqual(result.warm.on, false);
});

test('lane-policy: 100% with overage enabled disables warm', () => {
  const lane = resolveLane({
    model: { api: 'claude-sdk-oauth' },
    branch: [],
    authJson: {
      'anthropic-subscription': {
        accounts: [{ name: 'default', access: 'token1' }]
      }
    }
  });

  const now = Date.now();
  const resetTime = now + 1 * 60 * 60 * 1000;

  const snapshots = [{
    provider: 'anthropic-subscription',
    account: 'default',
    windows: [
      {
        kind: 'seven_day',
        utilization: 100,
        resetAt: resetTime
      }
    ],
    overageEnabled: true,
    source: 'endpoint'
  }];

  const result = decide({ snapshots, config: defaultConfig, now });
  assert.strictEqual(result.state, 'park-wait');
  assert.strictEqual(result.warm.on, false);
});

test('lane-policy: unknown provider from resolver returns ok in policy', () => {
  const lane = resolveLane({
    model: { api: 'some-unknown-api' },
    branch: [],
    authJson: null
  });

  assert.strictEqual(lane.provider, 'other');

  const now = Date.now();
  const snapshots = [{
    provider: 'other',
    account: undefined,
    windows: [],
    overageEnabled: false,
    source: 'none'
  }];

  const result = decide({ snapshots, config: defaultConfig, now });
  assert.strictEqual(result.state, 'ok');
});
