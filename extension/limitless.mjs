import { loadConfig } from "./config.mjs";

const CHILD_ENV = ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"];

export default (pi) => createLimitless(pi);

export function createLimitless(pi, deps = {}) {
  const env = deps.env ?? process.env;
  if (CHILD_ENV.some((key) => (env[key] ?? "").length > 0)) return null;
  const loaded = loadConfig({ env, homeDir: deps.homeDir, fs: deps.fs });
  return { config: loaded.config, warnings: loaded.warnings };
}
