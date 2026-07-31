// Command-string construction for acpx registry overrides.
//
// acpx (pinned 0.7.0) consumes each agent's launch command as a SINGLE STRING
// (`Record<agentName, string>`), then reparses it with its own `splitCommandLine`
// state machine (node_modules/acpx/dist/prompt-turn-*.js) into `{ command, args }`
// before spawning. That parser:
//   - splits tokens on whitespace outside quotes,
//   - treats `\` as an escape character UNLESS inside single quotes (so `\\` -> `\`
//     and `\x` -> `x` inside double quotes, which strips every backslash from a
//     quoted `C:\Program Files\...` path),
//   - preserves everything literally inside single quotes.
// There is no structured `{ executable, args, env }` override surface, so a
// Windows install path (spaces, backslashes, `&`, parens, non-ASCII) must be
// slash-normalized and quoted into a string this parser can round-trip without
// splitting or character loss.
//
// `splitAcpxCommand` below is a faithful port of that parser. It is exported so
// tests can prove a constructed command string reparses into the host's intended
// tokens (after Windows slash normalization) without needing a Windows host or a
// packaged runtime. Keep it in lockstep with the pinned acpx parser.

/** Splits a value on the configured delimiter, tolerating an empty string. */
function splitOn(value: string, delimiter: string): string[] {
  return value.length === 0 ? [] : value.split(delimiter);
}

/**
 * Faithful port of acpx@0.7.0's `splitCommandLine`. Throws on an unterminated
 * quote or an empty command, matching acpx exactly, so a misconstructed launch
 * string fails loudly here instead of launching the wrong executable.
 */
export function splitAcpxCommand(value: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;
  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (quote) throw new Error("Invalid --agent command: unterminated quote");
  if (current.length > 0) parts.push(current);
  if (parts.length === 0) throw new Error("Invalid --agent command: empty command");
  return { command: parts[0]!, args: parts.slice(1) };
}

/** True when a token contains a character acpx's parser would treat specially. */
function needsQuoting(token: string): boolean {
  return /[\s"'\\]/.test(token);
}

/**
 * Quotes a single command token so `splitAcpxCommand` reparses it to the intended
 * launch value. POSIX tokens round-trip exactly. Bare tokens (no
 * whitespace/quote/backslash) are returned as-is, which is why POSIX macOS paths
 * without those characters stay unquoted and the existing macOS launch strings
 * are byte-identical.
 *
 * Windows paths contain backslashes, which acpx strips inside double quotes.
 * Rather than escape every backslash (`\\`), Windows backslashes are normalized
 * to forward slashes first: Node `spawn`, `fs.existsSync`, and acpx's own PATHEXT
 * resolution (`path.extname` + `fs.existsSync`) all accept forward slashes on
 * Windows, and forward slashes have no escaping meaning to the parser.
 */
export function quoteLaunchToken(token: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const normalized = token.replace(/\\/g, "/");
    if (!needsQuoting(normalized)) return normalized;
    // Inside double quotes the parser drops a `\` that precedes any char, so a
    // literal `"` is emitted as `\"` (parser keeps the `"`). There are no other
    // backslashes to escape because normalization already removed them.
    return `"${normalized.replace(/"/g, '\\"')}"`;
  }
  if (!needsQuoting(token)) return token;
  // POSIX: double-quote and escape `\` -> `\\` and `"` -> `\"` so the token
  // round-trips through the parser verbatim.
  return `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Joins command tokens into a single launch-command string, quoting each token as needed. */
export function joinLaunchCommand(tokens: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return tokens.map((token) => quoteLaunchToken(token, platform)).join(" ");
}

export type AdapterLauncherSpec = {
  /** Executable that runs the bundled adapter as a Node program (node, or the bundled Electron). */
  executable: string;
  /** Environment to scope to the adapter child. */
  env?: Record<string, string>;
  /** Platform to build for; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** App path passed to the Electron executable in Windows source/dev mode. */
  windowsAppPath?: string;
};

export const WINDOWS_ADAPTER_LAUNCHER_SWITCH = "--baby-menu-electron-node-launcher";
export const WINDOWS_ADAPTER_LAUNCHER_SEPARATOR = "baby-menu-adapter-entry";

/**
 * Builds the prefix tokens that run the bundled adapter as a Node program.
 *
 * POSIX: `["env", "KEY=VALUE", ..., executable]` - the historical, proven
 *   Electron-as-Node wiring that scopes `ELECTRON_RUN_AS_NODE` to the child.
 * Windows: the Electron app runs a dedicated launcher mode that applies the
 *   requested child environment before starting the adapter.
 */
export function buildAdapterLauncherTokens(spec: AdapterLauncherSpec): string[] {
  const platform = spec.platform ?? process.platform;
  const envEntries = spec.env ? Object.entries(spec.env).map(([key, value]) => `${key}=${value}`) : [];
  if (platform === "win32") {
    if (envEntries.length === 0) return [spec.executable];
    return [
      spec.executable,
      ...(spec.windowsAppPath ? [spec.windowsAppPath] : []),
      WINDOWS_ADAPTER_LAUNCHER_SWITCH,
      ...envEntries,
      WINDOWS_ADAPTER_LAUNCHER_SEPARATOR,
    ];
  }
  return [...(envEntries.length > 0 ? ["env"] : []), ...envEntries, spec.executable];
}
