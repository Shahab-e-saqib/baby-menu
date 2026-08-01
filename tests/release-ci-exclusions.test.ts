import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");
const releaseOutputs = [
  ".release-please-manifest.json",
  "CHANGELOG.md",
  "package.json",
];

function workflow(name: string): string {
  return readFileSync(join(workflowsDir, name), "utf8");
}

describe("release-please CI exclusions", () => {
  it("excludes output-only release PRs from pull-request workflows", () => {
    for (const name of [
      "ci.yml",
      "guard-generated-files.yml",
      "no-mistakes-required.yml",
    ]) {
      const source = workflow(name);
      expect(source).toContain("pull_request:");
      expect(source).toContain("paths-ignore:");
      for (const path of releaseOutputs) {
        expect(source).toContain(`      - ${path}`);
      }
    }
  });

  it("rejects human metadata-only PRs from the trusted base workflow", () => {
    const source = workflow("release-metadata-policy.yml");

    expect(source).toContain("pull_request_target:");
    expect(source).toContain("paths:");
    for (const path of releaseOutputs) {
      expect(source).toContain(`      - ${path}`);
    }
    expect(source).toContain("github.event.pull_request.user.login != 'release-please[bot]'");
    expect(source).toContain("github.event.pull_request.user.login != 'github-actions[bot]'");
    expect(source).toContain("gh api --paginate");
    expect(source).toContain("grep -qvE");
    expect(source).not.toContain("actions/checkout");
  });

  it("keeps automation exemptions on generated-file guards", () => {
    const guard = workflow("guard-generated-files.yml");
    const noMistakes = workflow("no-mistakes-required.yml");

    expect(guard).toContain("github-actions[bot]");
    expect(guard).toContain("release-please[bot]");
    expect(noMistakes).toContain("github-actions[bot]");
    expect(noMistakes).toContain("dependabot[bot]");
    expect(noMistakes).toContain("release-please[bot]");
  });
});
