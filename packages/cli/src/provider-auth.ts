import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveCodexHome } from "./lib/codex-auth.js";

export interface ProviderAuthDeps {
  exec: (cmd: string) => string;
  readFile: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

/** Pi's model and provider live in Pi's own config; OpenRig never signs Pi in and must not imply it does. */
export const PI_PRESENT_MESSAGE = "Pi available. Pi's model and provider are configured in Pi (for example its models.json), not by OpenRig.";

/** Issue #194 — how the Codex provider selected in `$CODEX_HOME/config.toml`
 *  authenticates. Only an explicit provider entry with
 *  `requires_openai_auth = false` and an `env_key` uses its credential
 *  variable; every unresolved case keeps the OpenAI login check. Other Codex
 *  config layers are not resolved here. The daemon's kernel probe
 *  (`selectCodexProviderAuth` in kernel-boot.ts) carries the same rule. */
export type CodexProviderAuth =
  | { kind: "openai-login"; unresolved?: string }
  | { kind: "env-key"; providerId: string; envKey: string };

export function selectCodexProviderAuth(configToml: string | null): CodexProviderAuth {
  if (configToml === null) return { kind: "openai-login" };
  let config: Record<string, unknown>;
  try {
    config = parseToml(configToml) as Record<string, unknown>;
  } catch {
    return { kind: "openai-login", unresolved: "config.toml could not be parsed" };
  }
  if (Object.hasOwn(config, "profile")) {
    return { kind: "openai-login", unresolved: "config.toml selects a legacy profile, which is not resolved here" };
  }
  const providerId = config["model_provider"];
  const providers = config["model_providers"];
  if (typeof providerId !== "string" || !providers || typeof providers !== "object" || !Object.hasOwn(providers, providerId)) {
    return { kind: "openai-login" };
  }
  const entry = (providers as Record<string, unknown>)[providerId];
  if (!entry || typeof entry !== "object") return { kind: "openai-login" };
  const { requires_openai_auth: requiresOpenAiAuth, env_key: envKey } = entry as Record<string, unknown>;
  if (requiresOpenAiAuth !== false || typeof envKey !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
    return { kind: "openai-login" };
  }
  return { kind: "env-key", providerId, envKey };
}

export function checkClaudeAuth(deps: ProviderAuthDeps, installed: boolean): ProviderCheck {
  if (installed) {
    try {
      deps.exec("claude auth status");
      return { name: "claude_auth", status: "pass", message: "Claude Code authentication available." };
    } catch (err) {
      return {
        name: "claude_auth",
        status: "fail",
        message: `Claude Code is installed but not ready to launch: ${(err as Error).message}`,
        reason: "Claude Code seats cannot launch until the Claude CLI is logged in and usable.",
        fix: "Run `claude auth login` or open `claude` once to complete authentication, then rerun `rig setup`.",
      };
    }
  } else {
    return {
      name: "claude_auth",
      status: "skipped",
      message: "Skipped: Claude Code is not installed.",
      reason: "Authentication cannot be checked until the Claude Code CLI is installed.",
    };
  }
}

export function checkCodexAuth(deps: ProviderAuthDeps, installed: boolean): ProviderCheck {
  if (installed) {
    const env = deps.env ?? process.env;
    const codexAuth = selectCodexProviderAuth(deps.readFile(path.join(resolveCodexHome(env).codexHome, "config.toml")));
    if (codexAuth.kind === "env-key") {
      if (env[codexAuth.envKey]?.trim()) {
        return {
          name: "codex_auth",
          status: "pass",
          message: `Codex provider "${codexAuth.providerId}" does not use an OpenAI login, and its credential variable ${codexAuth.envKey} is set. This confirms a local credential is available, not that the provider accepts it or that managed seats receive it.`,
        };
      } else {
        return {
          name: "codex_auth",
          status: "fail",
          message: `Codex provider "${codexAuth.providerId}" needs ${codexAuth.envKey}, which is not set in this environment.`,
          reason: "Codex seats using this provider cannot authenticate without that variable.",
          fix: `Export ${codexAuth.envKey} in the environment that runs rig setup and the OpenRig daemon, then rerun \`rig setup\`.`,
        };
      }
    } else {
      try {
        deps.exec("codex login status");
        return { name: "codex_auth", status: "pass", message: "Codex authentication available." };
      } catch (err) {
        const unresolved = codexAuth.unresolved ? ` (${codexAuth.unresolved}, so the OpenAI login was checked)` : "";
        return {
          name: "codex_auth",
          status: "fail",
          message: `Codex is installed but not ready to launch${unresolved}: ${(err as Error).message}`,
          reason: "Codex seats cannot launch until the Codex CLI is logged in and usable.",
          fix: "Run `codex login` and complete authentication, then rerun `rig setup`.",
        };
      }
    }
  } else {
    return {
      name: "codex_auth",
      status: "skipped",
      message: "Skipped: Codex is not installed.",
      reason: "Authentication cannot be checked until the Codex CLI is installed.",
    };
  }
}

/**
 * `rig doctor`'s runtime checks, under the rule `rig setup` uses: a runtime that is missing is
 * offered, not a failure, and only a machine with none of the three is unhealthy. Sign-in checks are
 * unchanged and run only for a runtime that is present; Pi has no sign-in check in OpenRig. The whole
 * function is read-only: it neither installs a CLI nor starts a login or an agent session.
 */
export function checkProviderReadiness(deps: ProviderAuthDeps): ProviderCheck[] {
  const checks: ProviderCheck[] = [];
  const runtimes = [
    { command: "claude", label: "Claude Code", npmPackage: "@anthropic-ai/claude-code", auth: checkClaudeAuth },
    { command: "codex", label: "Codex", npmPackage: "@openai/codex", auth: checkCodexAuth },
    { command: "pi", label: "Pi", npmPackage: "@earendil-works/pi-coding-agent", auth: null },
  ] as const;
  let present = 0;
  for (const { command, label, npmPackage, auth } of runtimes) {
    let installed = false;
    try {
      deps.exec(`${command} --version`);
      installed = true;
      present += 1;
      checks.push({ name: `${command}_install`, status: "pass", message: command === "pi" ? PI_PRESENT_MESSAGE : `${label} available.` });
    } catch {
      checks.push({
        name: `${command}_install`, status: "warn", message: `${label} not found.`,
        reason: `${label} is not installed. OpenRig needs at least one of Claude Code, Codex or Pi, so a runtime you do not use is not a failure.`,
        fix: `Install it with \`rig setup --install ${command}\` (or \`npm install -g ${npmPackage}\`), then rerun \`rig doctor\`.`,
      });
    }
    if (auth) checks.push(auth(deps, installed));
  }
  if (present === 0) {
    checks.push({
      name: "runtime_present", status: "fail",
      message: "No OpenRig runtime is installed: Claude Code, Codex and Pi are all missing.",
      reason: "OpenRig needs at least one of Claude Code, Codex or Pi to run seats.",
      fix: "Install at least one: rig setup --install claude (or codex, or pi; names combine), then rerun rig doctor.",
    });
  }
  return checks;
}
