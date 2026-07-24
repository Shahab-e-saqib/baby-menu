import { describe, expect, it } from "vitest";
import {
  buildAdapterLauncherTokens,
  joinLaunchCommand,
  quoteLaunchToken,
  splitAcpxCommand,
} from "../src/main/launch-command";
import { withAdapterLaunchCommands, DEFAULT_AGENTS } from "../src/main/agent-catalog";

// The whole point of this file: a constructed launch command MUST round-trip
// through acpx's own splitCommandLine into the exact tokens the host intended.
// acpx strips backslashes inside double quotes, which silently breaks a quoted
// `C:\Program Files\...` path. These tests prove the quoting survives.
function expectRoundTrip(tokens: string[], platform: NodeJS.Platform) {
  const command = joinLaunchCommand(tokens, platform);
  const parsed = splitAcpxCommand(command);
  expect(parsed).toEqual({ command: tokens[0]!, args: tokens.slice(1) });
  return command;
}

describe("splitAcpxCommand (acpx parser port)", () => {
  it("splits a bare command string", () => {
    expect(splitAcpxCommand("node /o/claude.js")).toEqual({ command: "node", args: ["/o/claude.js"] });
  });

  it("strips backslashes inside double quotes (the confirmed defect)", () => {
    // This is the exact failure the report reproduced: a naive double-quoted
    // Windows path loses every backslash. The port must reproduce acpx's
    // behavior so round-trip tests are meaningful.
    expect(splitAcpxCommand('"C:\\Program Files\\App\\App.exe"')).toEqual({
      command: "C:Program FilesAppApp.exe",
      args: [],
    });
  });

  it("preserves backslashes inside single quotes", () => {
    expect(splitAcpxCommand("'C:\\Program Files\\App\\App.exe'")).toEqual({
      command: "C:\\Program Files\\App\\App.exe",
      args: [],
    });
  });

  it("throws on an unterminated quote", () => {
    expect(() => splitAcpxCommand('node "oops')).toThrow("unterminated quote");
  });
});

describe("quoteLaunchToken round-trips through the acpx parser", () => {
  const WINDOWS_PATHS = [
    "C:\\Program Files\\Baby Menu\\Baby Menu.exe",
    "C:\\Program Files\\Baby Menu\\resources\\app\\out\\adapters\\claude\\index.mjs",
    "D:\\tools\\agent.cmd",
    "C:\\Users\\José\\AppData\\Roaming\\npm\\claude.cmd",
    "C:\\Users\\Müller\\Résumé\\bin\\codex.cmd",
    "C:\\a & b\\path (x86)\\node.exe",
  ];

  it("round-trips every nasty Windows path (spaces, backslashes, &, parens, non-ASCII)", () => {
    for (const path of WINDOWS_PATHS) {
      const quoted = quoteLaunchToken(path, "win32");
      // Backslashes are normalized to forward slashes (parser-safe and
      // Windows-usable by spawn/fs/acpx), so the reparsed token equals the
      // forward-slash form of the original verbatim - no backslashes stripped,
      // no spaces split, no &/()/non-ASCII mangled.
      expect(splitAcpxCommand(quoted).command).toBe(path.replace(/\\/g, "/"));
    }
  });

  it("normalizes backslashes to forward slashes on Windows (parser-safe)", () => {
    const quoted = quoteLaunchToken("C:\\Program Files\\App\\App.exe", "win32");
    // Forward slashes (no escaping) inside double quotes survive the parser.
    expect(quoted).toBe('"C:/Program Files/App/App.exe"');
  });

  it("leaves a bare token without special characters unquoted on Windows", () => {
    expect(quoteLaunchToken("node", "win32")).toBe("node");
    expect(quoteLaunchToken("C:/bin/node.exe", "win32")).toBe("C:/bin/node.exe");
  });

  it("quotes a token containing & or parentheses only when it also has spaces on Windows", () => {
    // &/() are not special to the acpx parser (only whitespace, quotes, and
    // backslash are), so a path with no spaces round-trips bare.
    expect(quoteLaunchToken("C:/a&b/x.exe", "win32")).toBe("C:/a&b/x.exe");
    expect(quoteLaunchToken("C:/a(x86)/x.exe", "win32")).toBe("C:/a(x86)/x.exe");
    // The same content WITH a space gets quoted and still round-trips.
    const spaced = "C:/a & b (x86)/x.exe";
    expect(splitAcpxCommand(quoteLaunchToken(spaced, "win32")).command).toBe(spaced);
  });

  it("preserves the historical macOS double-quoting for paths with spaces", () => {
    // A leading slash is not special to the parser, so it is preserved verbatim;
    // only whitespace triggers double-quoting, matching the historical shellJoin.
    expect(quoteLaunchToken("/Apps/Baby Menu.app/Contents/MacOS/Baby Menu", "darwin")).toBe(
      '"/Apps/Baby Menu.app/Contents/MacOS/Baby Menu"',
    );
    expect(quoteLaunchToken("/Apps/Baby Menu.app", "darwin")).toBe('"/Apps/Baby Menu.app"');
  });

  it("escapes backslashes and quotes on POSIX so the token round-trips", () => {
    const token = "/path/with\\backslash and \"quote";
    expect(splitAcpxCommand(quoteLaunchToken(token, "darwin")).command).toBe(token);
  });
});

describe("joinLaunchCommand", () => {
  it("produces the byte-identical macOS Electron-as-node string (no regression)", () => {
    const command = joinLaunchCommand(
      ["env", "ELECTRON_RUN_AS_NODE=1", "/Apps/Baby Menu.app/Contents/MacOS/Baby Menu", "/Apps/Baby Menu.app/out/adapters/claude/index.js"],
      "darwin",
    );
    expect(command).toBe(
      'env ELECTRON_RUN_AS_NODE=1 "/Apps/Baby Menu.app/Contents/MacOS/Baby Menu" "/Apps/Baby Menu.app/out/adapters/claude/index.js"',
    );
    // And it round-trips through acpx.
    expectRoundTrip(
      ["env", "ELECTRON_RUN_AS_NODE=1", "/Apps/Baby Menu.app/Contents/MacOS/Baby Menu", "/Apps/Baby Menu.app/out/adapters/claude/index.js"],
      "darwin",
    );
  });

  it("round-trips a full Windows install-path launch through acpx", () => {
    const tokens = [
      "C:\\Program Files\\Baby Menu\\Baby Menu.exe",
      "C:\\Program Files\\Baby Menu\\resources\\app\\out\\adapters\\codex\\index.mjs",
    ];
    const command = joinLaunchCommand(tokens, "win32");
    const parsed = splitAcpxCommand(command);
    // Forward-slash-normalized, but each token is intact and unsplit.
    expect(parsed).toEqual({
      command: "C:/Program Files/Baby Menu/Baby Menu.exe",
      args: ["C:/Program Files/Baby Menu/resources/app/out/adapters/codex/index.mjs"],
    });
  });
});

describe("buildAdapterLauncherTokens", () => {
  it("scopes env to the child via an env prefix on POSIX", () => {
    expect(
      buildAdapterLauncherTokens({ executable: "/Apps/Baby Menu.app/MacOS/Baby Menu", env: { ELECTRON_RUN_AS_NODE: "1" }, platform: "darwin" }),
    ).toEqual(["env", "ELECTRON_RUN_AS_NODE=1", "/Apps/Baby Menu.app/MacOS/Baby Menu"]);
  });

  it("omits the env prefix on Windows (no env command; launcher is a documented next step)", () => {
    expect(
      buildAdapterLauncherTokens({
        executable: "C:\\Program Files\\Baby Menu\\Baby Menu.exe",
        env: { ELECTRON_RUN_AS_NODE: "1" },
        platform: "win32",
      }),
    ).toEqual(["C:\\Program Files\\Baby Menu\\Baby Menu.exe"]);
  });

  it("omits the env token entirely when no env is requested on POSIX", () => {
    expect(buildAdapterLauncherTokens({ executable: "/usr/bin/node", platform: "linux" })).toEqual(["/usr/bin/node"]);
  });
});

describe("withAdapterLaunchCommands (Windows quoting)", () => {
  const resolve = (adapter: "claude" | "codex") =>
    `C:\\Program Files\\Baby Menu\\resources\\app\\out\\adapters\\${adapter}\\index.mjs`;

  it("builds a launchCommand that round-trips through acpx for a Windows install path", () => {
    const wired = withAdapterLaunchCommands(
      DEFAULT_AGENTS,
      resolve,
      ["C:\\Program Files\\Baby Menu\\Baby Menu.exe"],
      { platform: "win32" },
    );
    for (const agent of wired) {
      expect(agent.launchCommand).toBeDefined();
      const parsed = splitAcpxCommand(agent.launchCommand!);
      // The reparsed command/args are the forward-slash-normalized intended
      // paths - no backslashes stripped, no spaces split, intact for spawn/fs.
      expect(parsed.command).toBe("C:/Program Files/Baby Menu/Baby Menu.exe");
      expect(parsed.args).toEqual([resolve(agent.adapter as "claude" | "codex").replace(/\\/g, "/")]);
    }
  });

  it("keeps the macOS launchCommand byte-identical when platform is darwin", () => {
    const wired = withAdapterLaunchCommands(
      DEFAULT_AGENTS,
      (adapter) => `/app/out/adapters/${adapter}/index.js`,
      ["env", "ELECTRON_RUN_AS_NODE=1", "/usr/bin/node"],
      { platform: "darwin" },
    );
    expect(wired.find((a) => a.name === "claude")?.launchCommand).toBe(
      "env ELECTRON_RUN_AS_NODE=1 /usr/bin/node /app/out/adapters/claude/index.js",
    );
  });

  it("does not override an explicit custom launchCommand on Windows", () => {
    const custom = [{ name: "claude", label: "Claude", command: "claude", adapter: "claude" as const, launchCommand: "my-claude" }];
    const wired = withAdapterLaunchCommands(custom, resolve, ["x.exe"], { platform: "win32" });
    expect(wired[0]!.launchCommand).toBe("my-claude");
  });
});
