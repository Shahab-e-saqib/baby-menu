import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("extension layout", () => {
  it("keeps the hello world widget in the repo-level extensions directory", async () => {
    const widget = await readFile(
      resolve(import.meta.dirname, "../extensions/hello-world/widget.tsx"),
      "utf8",
    );

    expect(widget).toContain("helloWorldWidget");
    expect(widget).toContain("RefreshableBabyMenuWidget");
    expect(widget).toContain("hello world");
    expect(widget).toContain("tell baby_menu what to build");
    expect(widget).toContain("fontSize: \"var(--fs-3xl)\"");
    expect(widget).toContain("fontSize: \"var(--fs-md)\"");
    expect(widget).toContain("examples");
    expect(widget).toContain("add a battery widget that shows current charge and power source");
    expect(widget).not.toContain("quick asks");
    expect(widget).not.toContain("className=\"src\"");
  });

  it("documents extension authoring separately from core development", async () => {
    const instructions = await readFile(resolve(import.meta.dirname, "../extensions/AGENTS.md"), "utf8");

    expect(instructions).toContain("self-contained baby-menu extensions");
    expect(instructions).toContain("widget.tsx");
    expect(instructions).toContain("server.ts");
    expect(instructions).toContain("window.babyMenu.capabilities.invoke");
    expect(instructions).toContain("Do not modify files outside this directory");
    expect(instructions).toContain("recipes/*.html");
    expect(instructions).toContain("Read the matching recipe before implementing");
  });

  it("exposes runtime widget design guidance to extension agents", async () => {
    const instructions = await readFile(resolve(import.meta.dirname, "../extensions/AGENTS.md"), "utf8");

    expect(instructions).toContain("Monochrome Lab");
    expect(instructions).toContain("Design for a 360px macOS tray popover");
    expect(instructions).toContain("Prefer `value-row`, `value`, `progress`, `fill`, `foot`, `src`, `status`, and `label`");
    expect(instructions).toContain("Public tokens available to widgets");
    expect(instructions).toContain("`--font-mono`");
    expect(instructions).toContain("`--ink-strong`");
    expect(instructions).toContain("`--signal-live`");
    expect(instructions).toContain("`--space-1` through `--space-9`");
    expect(instructions).toContain("Public widget classes available to widgets");
    expect(instructions).toContain("Canonical widget body pattern");
    expect(instructions).toContain("Readable hierarchy rules");
    expect(instructions).toContain("Do not use `foot` for primary instructions");
    expect(instructions).toContain("Onboarding widgets are not data widgets");
    expect(instructions).toContain("Onboarding widget headlines should usually use `--fs-md` or `--fs-lg`");
    expect(instructions).toContain("Starter empty states may use `--fs-2xl` or `--fs-3xl`");
    expect(instructions).toContain("Example prompts should be complete pasteable user asks");
    expect(instructions).toContain("Do not add gradients, emoji");
    expect(instructions).toContain("The host hides `hello-world` automatically once real widgets are discovered");
    expect(instructions).not.toContain("Remove the `hello-world` starter widget");
  });

  it("keeps the dev extension workspace out of git", async () => {
    const gitignore = await readFile(resolve(import.meta.dirname, "../.gitignore"), "utf8");

    expect(gitignore).toContain("extensions-dev/");
  });
});
