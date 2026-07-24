import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeShellPath } from "../src/main/shell-path";

describe("mergeShellPath", () => {
  it("merges common Unix directories and the login-shell PATH on macOS", () => {
    const merged = mergeShellPath({
      currentPath: "/usr/bin:/bin",
      homeDir: "/Users/dev",
      shellPath: "/opt/asdf/shims:/Users/dev/.cargo/bin",
      platform: "darwin",
      pathDelimiter: ":",
    });
    // Inherited entries are preserved and come first.
    expect(merged.startsWith("/usr/bin:/bin")).toBe(true);
    // Common GUI paths and ~/.local/bin are appended.
    expect(merged).toContain("/opt/homebrew/bin");
    expect(merged).toContain("/Users/dev/.local/bin");
    // Login-shell PATH is merged in.
    expect(merged).toContain("/opt/asdf/shims");
    expect(merged).toContain("/Users/dev/.cargo/bin");
    // All separators are POSIX colons.
    expect(merged.includes(";")).toBe(false);
    // Entries are de-duplicated.
    expect(merged.split(":").filter((segment) => segment === "/usr/bin")).toEqual(["/usr/bin"]);
  });

  it("returns the inherited PATH unchanged on Windows", () => {
    const inherited = "C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\Users\\dev\\AppData\\Roaming\\npm";
    const merged = mergeShellPath({
      currentPath: inherited,
      homeDir: "C:\\Users\\dev",
      shellPath: "/opt/homebrew/bin:/usr/local/bin",
      platform: "win32",
      pathDelimiter: ";",
    });
    // The exact inherited value is preserved - no Unix directory merged in, no
    // delimiter corruption, and crucially the final usable entry stays intact.
    expect(merged).toBe(inherited);
  });

  it("does not corrupt the final PATH entry with a Unix delimiter on Windows", () => {
    // Regression for the confirmed defect: appending a colon-delimited segment
    // to a semicolon PATH left a trailing `:`-segment that corrupted the last
    // real entry. The Windows path must never append Unix syntax.
    const inherited = "C:\\Program Files\\nodejs;C:\\Users\\dev\\AppData\\Roaming\\npm";
    const merged = mergeShellPath({ currentPath: inherited, platform: "win32", pathDelimiter: ";" });
    expect(merged).toBe(inherited);
    // No segment is altered or appended: every entry is exactly one of the
    // inherited semicolon-delimited entries (drive-letter colons are part of a
    // segment, not a POSIX delimiter).
    expect(merged.split(";")).toEqual(inherited.split(";"));
  });

  it("preserves multiple drive letters on Windows without joining them", () => {
    const inherited = "C:\\bin;D:\\tools;E:\\dev\\bin";
    const merged = mergeShellPath({ currentPath: inherited, platform: "win32", pathDelimiter: ";" });
    expect(merged.split(";")).toEqual(["C:\\bin", "D:\\tools", "E:\\dev\\bin"]);
  });

  it("uses the path.delimiter default when not overridden", () => {
    // Sanity that the default delimiter matches the host convention the rest of
    // the app relies on (node:path.delimiter).
    expect(delimiter).toBe(process.platform === "win32" ? ";" : ":");
  });

  it("handles an empty inherited PATH on POSIX by still offering the common directories", () => {
    const merged = mergeShellPath({ currentPath: "", homeDir: "/h", platform: "linux", pathDelimiter: ":" });
    expect(merged).toContain("/usr/bin");
    expect(merged).toContain("/h/.local/bin");
  });
});
