import { describe, expect, it } from "vitest";
import { isUncPath, isUncWindowsLaunch } from "../src/shared/paths";

describe("isUncPath", () => {
  it("recognizes backslash UNC paths (e.g. WSL network share)", () => {
    expect(isUncPath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\workspace")).toBe(true);
    expect(isUncPath("\\\\server\\share\\dir")).toBe(true);
  });

  it("recognizes forward-slash UNC paths", () => {
    expect(isUncPath("//server/share/dir")).toBe(true);
  });

  it("rejects native drive paths and relative paths", () => {
    expect(isUncPath("C:\\Users\\dev\\workspace")).toBe(false);
    expect(isUncPath("C:/Users/dev/workspace")).toBe(false);
    expect(isUncPath("relative/path")).toBe(false);
    expect(isUncPath("claude.cmd")).toBe(false);
  });

  it("rejects the verbatim \\\\?\\ namespace (not UNC)", () => {
    expect(isUncPath("\\\\?\\C:\\Users\\dev")).toBe(false);
  });
});

describe("isUncWindowsLaunch (narrow GPU-fallback decision)", () => {
  // The MAIN app process only disables GPU when launched from UNC. Native-drive
  // installs keep full GPU acceleration and the sandbox; non-Windows is unaffected.
  it("is true on win32 when the executable path is UNC", () => {
    expect(isUncWindowsLaunch("win32", "\\\\wsl.localhost\\Ubuntu\\app\\Baby Menu.exe", "C:\\Users")).toBe(true);
  });

  it("is true on win32 when the current working directory is UNC", () => {
    expect(isUncWindowsLaunch("win32", "C:\\app\\Baby Menu.exe", "\\\\wsl.localhost\\Ubuntu\\ws")).toBe(true);
  });

  it("is false on win32 when both paths are native local drives", () => {
    expect(isUncWindowsLaunch("win32", "C:\\Program Files\\Baby Menu\\Baby Menu.exe", "C:\\Users\\dev\\.baby-menu")).toBe(false);
  });

  it("is false on darwin/linux even with a UNC-looking path", () => {
    expect(isUncWindowsLaunch("darwin", "\\\\wsl.localhost\\Ubuntu\\app", "/home/dev")).toBe(false);
    expect(isUncWindowsLaunch("linux", "//server/share", "/home/dev")).toBe(false);
  });
});
