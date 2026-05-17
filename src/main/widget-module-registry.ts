import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { BabyMenuWidgetModuleDescriptor } from "../shared/contracts";
import { getExtensionsDir } from "../shared/paths";

export type WidgetModuleRegistry = {
  list: () => Promise<BabyMenuWidgetModuleDescriptor[]>;
};

export type DiscoverWidgetModulesOptions = {
  rootDir: string;
  extensionsDir?: string;
};

const STARTER_EXTENSION_ID = "hello-world";
const WIDGET_FILE_PATTERN = /^widget\.(tsx|jsx|ts|js|mjs)$/;

export function createWidgetModuleRegistry(rootDir: string): WidgetModuleRegistry {
  return {
    list: () => discoverWidgetModules({ rootDir }),
  };
}

export async function discoverWidgetModules({
  rootDir,
  extensionsDir = getExtensionsDir(rootDir),
}: DiscoverWidgetModulesOptions): Promise<BabyMenuWidgetModuleDescriptor[]> {
  const files = await discoverWidgetFiles(resolve(extensionsDir));
  const modules = await Promise.all(files.map((filePath) => widgetModuleDescriptor(rootDir, filePath)));
  return modules
    .filter((module): module is BabyMenuWidgetModuleDescriptor => Boolean(module))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function discoverWidgetFiles(rootDir: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(rootDir, entry.name);
      if (entry.isDirectory()) return discoverWidgetFiles(entryPath);
      if (entry.isFile() && WIDGET_FILE_PATTERN.test(entry.name)) return [entryPath];
      return [];
    }),
  );
  return files.flat();
}

async function widgetModuleDescriptor(rootDir: string, filePath: string): Promise<BabyMenuWidgetModuleDescriptor | null> {
  const extensionId = inferExtensionId(rootDir, filePath);
  if (!extensionId || extensionId === STARTER_EXTENSION_ID) return null;

  const fileStat = await stat(filePath);
  return {
    id: `${extensionId}.widget`,
    extensionId,
    moduleUrl: rendererModuleUrl(filePath, fileStat.mtimeMs),
  };
}

function inferExtensionId(rootDir: string, filePath: string): string | null {
  const extensionRoot = getExtensionsDir(rootDir);
  const relativePath = relative(extensionRoot, filePath);
  const firstSegment = relativePath.split(/[\\/]/)[0];
  if (firstSegment && firstSegment !== ".." && firstSegment !== ".") return firstSegment;

  const parent = basename(dirname(filePath));
  return parent && parent !== "." ? parent : basename(filePath, extname(filePath));
}

function rendererModuleUrl(filePath: string, mtimeMs: number): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath);
  const normalizedPath = absolutePath.split("\\").join("/");
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  return `/@fs${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}?babyMenuWidgetVersion=${Math.trunc(mtimeMs)}`;
}
