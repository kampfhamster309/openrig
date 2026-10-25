import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { runSetup, setupCommand, parseSetupInstalls, type SetupDeps, type SetupResult, type SetupStep } from "../src/commands/setup.js";
import { ConfigStore } from "../src/config-store.js";

/**
 * `rig setup` checks for Claude Code, Codex and Pi and OFFERS a missing one. Nothing is installed
 * without an explicit choice, one runtime present is enough to be ready, and none present is the one
 * case that is not. These tests inject deps, so no install, network or real config is touched.
 */

type Runtime = "claude" | "codex" | "pi";
const RUNTIMES: readonly Runtime[] = ["claude", "codex", "pi"];
const PROBES: Record<Runtime, string> = {
  claude: "claude --version",
  codex: "codex --version",
  pi: "pi --version",
};
const PACKAGES: Record<Runtime, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  pi: "@earendil-works/pi-coding-agent",
};
const PACKAGE_TO_RUNTIME = Object.fromEntries(RUNTIMES.map((r) => [PACKAGES[r], r])) as Record<string, Runtime>;

function fixture(
  present: Partial<Record<Runtime, boolean>>,
  opts: { installFails?: Runtime[]; claudeAuthFails?: boolean } = {},
): { deps: SetupDeps; commands: string[]; installed: Record<Runtime, boolean> } {
  const installed: Record<Runtime, boolean> = { claude: !!present.claude, codex: !!present.codex, pi: !!present.pi };
  const commands: string[] = [];
  const deps: SetupDeps = {
    platform: "linux",
    env: { HOME: "/synthetic/home" },
    exec: (cmd: string) => {
      commands.push(cmd);
      if (cmd === "herdr --version") return "herdr 0.9.3\n";
      if (cmd === "tmux -V") return "tmux 3.4\n";
      if (cmd === "tmux list-sessions") return "";
      if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
      const npm = /^npm install -g (\S+)$/.exec(cmd);
      if (npm) {
        const runtime = PACKAGE_TO_RUNTIME[npm[1]!];
        if (!runtime) throw new Error(`unexpected package: ${npm[1]}`);
        if (opts.installFails?.includes(runtime)) throw new Error("npm ERR! network");
        installed[runtime] = true;
        return "added 1 package\n";
      }
      for (const runtime of RUNTIMES) {
        if (cmd === PROBES[runtime]) {
          if (!installed[runtime]) throw new Error(`command not found: ${runtime}`);
          return `${runtime} 1.0.0\n`;
        }
      }
      if (cmd === "claude auth status") {
        if (opts.claudeAuthFails) throw new Error("Not logged in");
        return "Authenticated\n";
      }
      if (cmd === "codex login status") return "Logged in\n";
      throw new Error(`unexpected command: ${cmd}`);
    },
    readFile: () => null,
    writeFile: vi.fn(),
    exists: () => false,
    mkdirp: vi.fn(),
    // Never the person's real config: a path that does not exist reads as unanswered.
    routerLineStore: new ConfigStore(join(tmpdir(), "setup-runtimes-router-line", "config.json")),
    recordProviders: vi.fn(),
  };
  return { deps, commands, installed };
}

const step = (result: SetupResult, id: string): SetupStep | undefined => result.steps.find((s) => s.id === id);
const installCommands = (commands: string[]): string[] => commands.filter((cmd) => cmd.startsWith("npm install"));

describe("rig setup checks three runtimes and offers what is missing", () => {
  describe("the combinations that matter (a bare run installs nothing)", () => {
    it("none present: each is offered, one clear failure names what to install, and setup is not ready", async () => {
      const { deps, commands } = fixture({});
      const result = await runSetup(deps, {});

      for (const runtime of RUNTIMES) {
        expect(step(result, `${runtime}_install`)).toMatchObject({
          status: "skipped",
          message: expect.stringContaining("ask once"),
          fixHint: expect.stringContaining(`--install ${runtime}`),
        });
      }
      expect(installCommands(commands)).toEqual([]);
      const failures = result.steps.filter((s) => s.status === "fail");
      expect(failures.map((s) => s.id)).toEqual(["runtime_present"]);
      expect(failures[0]!.message).toContain("Claude Code, Codex and Pi are all missing");
      expect(failures[0]!.fixHint).toContain("rig setup --install");
      expect(result.ready).toBe(false);
    });

    it("only Claude Code: ready, with Codex and Pi offered rather than failed", async () => {
      const { deps, commands } = fixture({ claude: true });
      const result = await runSetup(deps, {});

      expect(step(result, "claude_install")?.status).toBe("pass");
      expect(step(result, "claude_auth")?.status).toBe("pass");
      expect(step(result, "codex_install")?.status).toBe("skipped");
      expect(step(result, "pi_install")?.status).toBe("skipped");
      expect(step(result, "runtime_present")).toBeUndefined();
      expect(installCommands(commands)).toEqual([]);
      expect(result.ready).toBe(true);
    });

    it("only Codex: ready, and sign-in is checked only for what is here", async () => {
      const { deps, commands } = fixture({ codex: true });
      const result = await runSetup(deps, {});

      expect(step(result, "codex_install")?.status).toBe("pass");
      expect(step(result, "codex_auth")?.status).toBe("pass");
      expect(step(result, "claude_install")?.status).toBe("skipped");
      expect(step(result, "pi_install")?.status).toBe("skipped");
      // No sign-in probe for a runtime that is not installed.
      expect(commands).not.toContain("claude auth status");
      expect(result.ready).toBe(true);
    });

    it("only Pi: ready, Pi's model is said to live in Pi, and the kernel note says the kernel will not start", async () => {
      const { deps, commands } = fixture({ pi: true });
      const result = await runSetup(deps, {});

      expect(step(result, "pi_install")).toMatchObject({
        status: "pass",
        message: expect.stringContaining("configured in Pi (for example its models.json), not by OpenRig"),
      });
      // OpenRig has no Pi sign-in check and does not invent one.
      expect(step(result, "pi_auth")).toBeUndefined();
      expect(commands).not.toContain("claude auth status");
      expect(commands).not.toContain("codex login status");

      expect(step(result, "kernel_runtime")).toMatchObject({
        status: "warn",
        message: expect.stringContaining("no kernel runtime (Claude Code or Codex) is available, so the kernel will not start"),
        fixHint: expect.stringContaining("rig daemon start --no-kernel"),
      });
      // It says what was found, never that setup is ready: another step may have failed.
      expect(step(result, "kernel_runtime")?.message).not.toMatch(/ready/);
      expect(step(result, "kernel_runtime")!.fixHint).toContain("OPENRIG_NO_KERNEL=1");
      // The kernel note is information, not a failure: Pi-only setup is ready.
      expect(result.ready).toBe(true);
    });

    it("all three present: every check passes and nothing is offered", async () => {
      const { deps, commands } = fixture({ claude: true, codex: true, pi: true });
      const result = await runSetup(deps, {});

      for (const runtime of RUNTIMES) expect(step(result, `${runtime}_install`)?.status).toBe("pass");
      expect(step(result, "kernel_runtime")?.message).toContain("kernel runtime found: Claude Code and Codex");
      expect(RUNTIMES.map((r) => step(result, `${r}_install`)!.status)).toEqual(["pass", "pass", "pass"]);
      expect(installCommands(commands)).toEqual([]);
      expect(result.ready).toBe(true);
    });
  });

  describe("--install is the explicit yes, and installs exactly what was chosen", () => {
    it("installs only the runtime named, on a machine that has another", async () => {
      const { deps, commands, installed } = fixture({ claude: true });
      const result = await runSetup(deps, { installs: ["pi"] });

      expect(step(result, "pi_install")).toMatchObject({ status: "applied", message: "Installed Pi with npm." });
      expect(installed.pi).toBe(true);
      expect(installCommands(commands)).toEqual([`npm install -g ${PACKAGES.pi}`]);
      expect(result.ready).toBe(true);
    });

    it("installs exactly the two named and leaves the third as an offer", async () => {
      const { deps, commands } = fixture({});
      const result = await runSetup(deps, { installs: ["claude", "codex"] });

      expect(step(result, "claude_install")?.status).toBe("applied");
      expect(step(result, "codex_install")?.status).toBe("applied");
      expect(step(result, "pi_install")?.status).toBe("skipped");
      expect(installCommands(commands)).toEqual([
        `npm install -g ${PACKAGES.claude}`,
        `npm install -g ${PACKAGES.codex}`,
      ]);
      expect(result.ready).toBe(true);
    });

    it("all installs the three, and the kernel can start afterwards", async () => {
      const { deps, commands } = fixture({});
      const result = await runSetup(deps, { installs: ["claude", "codex", "pi"] });

      expect(installCommands(commands)).toHaveLength(3);
      expect(step(result, "runtime_present")).toBeUndefined();
      expect(step(result, "kernel_runtime")?.status).toBe("pass");
      expect(result.ready).toBe(true);
    });

    it("a chosen install that fails is a failure, and is not reported twice", async () => {
      const { deps } = fixture({}, { installFails: ["claude"] });
      const result = await runSetup(deps, { installs: ["claude"] });

      expect(step(result, "claude_install")).toMatchObject({ status: "fail", message: expect.stringContaining("npm ERR! network") });
      // The person asked for it, so the install step carries the one clear failure.
      expect(result.steps.filter((s) => s.status === "fail").map((s) => s.id)).toEqual(["claude_install"]);
      expect(result.ready).toBe(false);
    });

    it("an install the installer reported but did not deliver is a failure, not a pass", async () => {
      const commands: string[] = [];
      const deps: SetupDeps = {
        ...fixture({}).deps,
        exec: (cmd: string) => {
          commands.push(cmd);
          if (cmd === "herdr --version") return "herdr 0.9.3\n";
          if (cmd === "tmux -V") return "tmux 3.4\n";
          if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
          if (cmd.startsWith("npm install")) return "added 1 package\n"; // returns, but nothing landed
          throw new Error(`command not found: ${cmd.split(" ")[0]}`);
        },
      };
      const result = await runSetup(deps, { installs: ["pi"] });

      expect(step(result, "pi_install")?.status).toBe("fail");
      expect(step(result, "pi_install")?.message).toContain("still does not answer");
    });
  });

  describe("a bare run never installs, whatever is missing", () => {
    it("calls no install command on a machine with nothing, with Claude only, or with Pi only", async () => {
      for (const present of [{}, { claude: true }, { pi: true }] as const) {
        const { deps, commands } = fixture(present);
        const result = await runSetup(deps, {});
        expect(installCommands(commands)).toEqual([]);
        expect(result.steps.some((s) => s.status === "applied" && s.id.endsWith("_install"))).toBe(false);
      }
    });
  });

  describe("--providers keeps its meaning: the kernel providers, and a chosen missing one is installed", () => {
    it("records provider.selected for claude/codex and never names Pi", async () => {
      const recordProviders = vi.fn();
      const { deps } = fixture({ claude: true, codex: true, pi: true });
      deps.recordProviders = recordProviders;
      const result = await runSetup(deps, { providers: ["claude"] });

      expect(recordProviders.mock.calls).toEqual([["claude"]]);
      expect(step(result, "codex_install")).toMatchObject({ status: "skipped", message: expect.stringContaining("Not selected") });
      // Pi is not a kernel provider: it is still checked beside the narrowed provider choice.
      expect(step(result, "pi_install")?.status).toBe("pass");
      expect(result.ready).toBe(true);
    });

    it("installs a chosen provider that is missing, as it does today", async () => {
      const { deps, commands } = fixture({ codex: true });
      const result = await runSetup(deps, { providers: ["claude"] });

      expect(step(result, "claude_install")?.status).toBe("applied");
      expect(installCommands(commands)).toEqual([`npm install -g ${PACKAGES.claude}`]);
    });

    it("unions --providers and --install: the provider and the runtime the person named", async () => {
      const { deps, commands } = fixture({ codex: true });
      const result = await runSetup(deps, { providers: ["claude"], installs: ["pi"] });

      expect(step(result, "claude_install")?.status).toBe("applied");
      expect(step(result, "pi_install")?.status).toBe("applied");
      expect(installCommands(commands)).toEqual([`npm install -g ${PACKAGES.claude}`, `npm install -g ${PACKAGES.pi}`]);
    });

    it("--install naming a runtime --providers left out is honoured: the union, in the run and the plan", async () => {
      const real = fixture({ codex: true });
      const result = await runSetup(real.deps, { providers: ["codex"], installs: ["claude"] });

      // The explicit yes is not silently dropped by the provider exclusion.
      expect(step(result, "claude_install")?.status).toBe("applied");
      expect(installCommands(real.commands)).toEqual([`npm install -g ${PACKAGES.claude}`]);
      // provider.selected still records only --providers, the kernel providers.
      expect((real.deps.recordProviders as ReturnType<typeof vi.fn>).mock.calls).toEqual([["codex"]]);

      const plan = await runSetup(fixture({ codex: true }).deps, { dryRun: true, providers: ["codex"], installs: ["claude"] });
      expect(step(plan, "claude_install")?.message).toContain("would be installed");
      expect(step(plan, "claude_install")?.message).not.toContain("Not selected");
    });

    it("a bare run records nothing, so the kernel's first boot uses every signed-in provider present", async () => {
      const recordProviders = vi.fn();
      const { deps } = fixture({ claude: true });
      deps.recordProviders = recordProviders;
      const result = await runSetup(deps, {});

      expect(recordProviders).not.toHaveBeenCalled();
      expect(step(result, "providers_record")).toBeUndefined();
      expect(step(result, "kernel_runtime")?.reason).toContain("provider.selected is not set");
    });
  });

  describe("dry run: the same plan, and nothing installed", () => {
    it("reports what was found, what would be offered, and what --install would install", async () => {
      const { deps, commands } = fixture({ claude: true });
      const result = await runSetup(deps, { dryRun: true });

      expect(result.steps.every((s) => s.status === "skipped")).toBe(true);
      expect(step(result, "claude_install")?.message).toContain("Dry run: found Claude Code");
      expect(step(result, "codex_install")?.message).toContain("would be offered, not installed");
      expect(step(result, "codex_install")?.message).toContain("rig setup --install codex");
      expect(step(result, "pi_install")?.message).toContain("would be offered, not installed");
      expect(step(result, "kernel_runtime")?.message).toContain("Dry run: kernel runtime found: Claude Code");
      // Detection is the read-only version probe; nothing is installed.
      expect(commands.sort()).toEqual([PROBES.claude, PROBES.codex, PROBES.pi]);
    });

    it("says a chosen runtime would be installed, and only with the choice", async () => {
      const chosen = await runSetup(fixture({}).deps, { dryRun: true, installs: ["pi"] });
      expect(step(chosen, "pi_install")?.message).toContain("--install pi");
      expect(step(chosen, "pi_install")?.message).toContain("would be installed");

      const byProviders = await runSetup(fixture({}).deps, { dryRun: true, providers: ["claude"] });
      expect(step(byProviders, "claude_install")?.message).toContain("--providers claude");
    });

    it("counts a chosen install in the plan, so the plan matches the run it predicts", async () => {
      // Nothing present + --install pi: the run would apply Pi and report no runtime_present, so neither may the plan.
      const none = fixture({});
      const nonePlan = await runSetup(none.deps, { dryRun: true, installs: ["pi"] });
      expect(step(nonePlan, "runtime_present")).toBeUndefined();
      expect(step(nonePlan, "kernel_runtime")?.message).toContain("no kernel runtime");
      // Pi is not a kernel runtime, so the plan says nothing about the flag that added it.
      expect(step(nonePlan, "kernel_runtime")?.message).not.toContain("--install");
      expect(installCommands(none.commands)).toEqual([]);
      expect(none.commands.sort()).toEqual([PROBES.claude, PROBES.codex, PROBES.pi]);

      // Pi only + --install claude: the run gets a kernel runtime, so the plan must not say it has none.
      const piOnly = fixture({ pi: true });
      const piPlan = await runSetup(piOnly.deps, { dryRun: true, installs: ["claude"] });
      expect(step(piPlan, "kernel_runtime")?.message).toContain("kernel runtime found: Claude Code");
      expect(step(piPlan, "kernel_runtime")?.message).toContain("(Claude Code with --install claude).");
      expect(installCommands(piOnly.commands)).toEqual([]);
      expect(piOnly.commands.sort()).toEqual([PROBES.claude, PROBES.codex, PROBES.pi]);

      // The same runtime chosen by naming it in --providers is credited to that flag, not to --install.
      const byProviders = fixture({ pi: true });
      const providerPlan = await runSetup(byProviders.deps, { dryRun: true, providers: ["claude"] });
      expect(step(providerPlan, "kernel_runtime")?.message).toContain("(Claude Code with --providers claude).");
      expect(step(providerPlan, "kernel_runtime")?.message).not.toContain("--install");
    });

    it("carries the Pi-only kernel note and the none-present case as plan steps, not failures", async () => {
      const piOnly = await runSetup(fixture({ pi: true }).deps, { dryRun: true });
      expect(step(piOnly, "kernel_runtime")).toMatchObject({ status: "skipped", message: expect.stringContaining("the kernel will not start") });

      const none = await runSetup(fixture({}).deps, { dryRun: true });
      expect(step(none, "runtime_present")).toMatchObject({ status: "skipped", message: expect.stringContaining("all missing") });
      expect(none.steps.every((s) => s.status === "skipped")).toBe(true);
    });
  });

  describe("parseSetupInstalls", () => {
    it("accepts the three names in any order, and all", () => {
      expect(parseSetupInstalls("pi")).toEqual(["pi"]);
      expect(parseSetupInstalls("codex,claude")).toEqual(["claude", "codex"]);
      expect(parseSetupInstalls(" Pi , claude ")).toEqual(["claude", "pi"]);
      expect(parseSetupInstalls("all")).toEqual(["claude", "codex", "pi"]);
    });

    it("rejects an unknown name or an empty list, and never guesses a runtime", () => {
      expect(parseSetupInstalls("pi,pi")).toEqual(["pi"]);
      expect(parseSetupInstalls("cmux")).toEqual({ error: expect.stringContaining("Unknown runtime 'cmux'") });
      expect(parseSetupInstalls("both")).toEqual({ error: expect.stringContaining("Unknown runtime 'both'") });
      expect(parseSetupInstalls(" , ")).toEqual({ error: expect.stringContaining("--install needs claude, codex, pi, or all") });
    });
  });

  describe("the command surface", () => {
    function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
      const logs: string[] = [];
      const errors: string[] = [];
      const origLog = console.log;
      const origError = console.error;
      const origExitCode = process.exitCode;
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      return fn()
        .then(() => ({ logs, errors, exitCode: process.exitCode }))
        .finally(() => {
          console.log = origLog;
          console.error = origError;
          process.exitCode = origExitCode;
        });
    }

    it("--install reaches the plan through the CLI, and an unknown runtime exits 1 without running setup", async () => {
      const { deps, commands } = fixture({ claude: true });
      const program = new Command().addCommand(setupCommand(deps));
      const { logs } = await captureLogs(() => program.parseAsync(["node", "rig", "setup", "--install", "pi", "--json"]));

      const result = JSON.parse(logs.join("\n")) as SetupResult;
      expect(result.steps.find((s) => s.id === "pi_install")).toMatchObject({ status: "applied" });
      expect(commands).toContain(`npm install -g ${PACKAGES.pi}`);

      const badProgram = new Command().addCommand(setupCommand(fixture({}).deps));
      const bad = await captureLogs(() => badProgram.parseAsync(["node", "rig", "setup", "--install", "nope", "--json"]));
      expect(bad.exitCode).toBe(1);
      expect(bad.errors.join("\n")).toContain("Unknown runtime 'nope'");
      expect(bad.logs).toEqual([]);
    });

    it("helps say what each flag does", async () => {
      const help = setupCommand(fixture({}).deps).helpInformation();
      expect(help).toContain("--install <list>");
      expect(help).toContain("installs nothing");
      expect(help).toContain("--providers <list>");
      expect(help).toContain("never names Pi");
    });
  });

  it("feeds the Pi step into doctor-backed verification without failing it", async () => {
    const { deps } = fixture({ claude: true, codex: true });
    const result = await runSetup(deps, {
      doctorDeps: {
        exists: () => true,
        baseDir: "/install/cli/dist",
        exec: (cmd: string) => (cmd === "tmux -V" ? "tmux 3.4" : ""),
        checkPort: async () => true,
        configStore: {
          resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/openrig/openrig.sqlite" }, transcripts: { enabled: true, path: "/tmp/openrig/transcripts" } }),
        },
        platform: "linux",
        readFile: () => null,
        mkdirp: () => {},
        checkWritable: () => {},
        fetch: async () => { throw new Error("ECONNREFUSED"); },
      },
    });

    const piCheck = result.verification?.checks.find((c) => c.name === "pi_install");
    expect(piCheck?.status).toBe("skipped");
    expect(result.ready).toBe(true);
  });
});
