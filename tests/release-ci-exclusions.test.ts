import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

function pullRequestBlock(source: string): string | undefined {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^  pull_request:/.test(line));
  if (start === -1) return undefined;

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

describe("release metadata CI coverage", () => {
  it("runs every pull-request workflow for metadata-only changes", () => {
    const workflows = readdirSync(workflowsDir)
      .filter((name) => name.endsWith(".yml"))
      .map((name) => ({
        name,
        block: pullRequestBlock(
          readFileSync(join(workflowsDir, name), "utf8"),
        ),
      }))
      .filter(
        (workflow): workflow is { name: string; block: string } =>
          workflow.block !== undefined,
      );

    expect(workflows.map(({ name }) => name).sort()).toEqual([
      "ci.yml",
      "guard-generated-files.yml",
      "no-mistakes-required.yml",
    ]);
    for (const { block } of workflows) {
      expect(block).not.toMatch(/^    paths(?:-ignore)?:/m);
    }
  });

  it("keeps automation exemptions scoped to jobs", () => {
    const guard = readFileSync(
      join(workflowsDir, "guard-generated-files.yml"),
      "utf8",
    );
    const noMistakes = readFileSync(
      join(workflowsDir, "no-mistakes-required.yml"),
      "utf8",
    );

    expect(guard).toContain("github-actions[bot]");
    expect(guard).toContain("release-please[bot]");
    expect(noMistakes).toContain("github-actions[bot]");
    expect(noMistakes).toContain("dependabot[bot]");
    expect(noMistakes).toContain("release-please[bot]");
  });
});
