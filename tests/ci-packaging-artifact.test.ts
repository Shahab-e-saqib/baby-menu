import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CI packaging artifact contract", () => {
  it("builds the NSIS installer from existing build output in the windows CI job", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("electron-builder --win nsis --x64 --config electron-builder.yml --publish never");
  });

  it("verifies the unsigned NSIS artifact has exact expected name, is non-empty, and passes PE magic-byte check", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("Get-ChildItem \"release/Baby-Menu-*-x64-unsigned.exe\"");
    expect(workflow).toContain("if ($installers.Count -ne 1)");
    expect(workflow).toContain("0x4D -or $bytes[1] -ne 0x5A");
  });

  it("uploads the unsigned NSIS installer as a short-retention internal-only artifact", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("name: baby-menu-unsigned-nsis-x64");
    expect(workflow).toContain("path: release/Baby-Menu-*-x64-unsigned.exe");
    expect(workflow).toContain("retention-days: 1");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("does not publish or code-sign the NSIS installer as a public release", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");

    expect(workflow).not.toContain("gh release upload");
    expect(workflow).not.toContain("CSC_IDENTITY_AUTO_DISCOVERY");
    expect(workflow).not.toMatch(/codesign|signtool|authenticode/i);
    expect(workflow).not.toContain("release-please.yml");
  });

  it("declares the unsigned artifactName pattern in electron-builder config", async () => {
    const config = await readFile(resolve(import.meta.dirname, "../electron-builder.yml"), "utf8");

    expect(config).toContain("artifactName: Baby-Menu-${version}-x64-unsigned.${ext}");
  });
});
