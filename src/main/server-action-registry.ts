import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BabyMenuCapabilityDescriptor } from "../shared/contracts";

export type ServerActionContext = {
  rootDir: string;
};

export type ServerActionHandler = (input: unknown, context: ServerActionContext) => unknown | Promise<unknown>;

export type ServerActionRegistry = {
  list: () => Promise<BabyMenuCapabilityDescriptor[]>;
  invoke: (extensionId: string, action: string, input?: unknown) => Promise<unknown>;
};

type LoadedServerAction = BabyMenuCapabilityDescriptor & {
  handler: ServerActionHandler;
};

type ServerActionModule = {
  extensionId?: unknown;
  id?: unknown;
  actions?: unknown;
};

type CreateServerActionRegistryOptions = {
  rootDir: string;
  actionRoots?: string[];
};

const DEFAULT_ACTION_ROOTS = ["extensions"];
const SERVER_ACTION_FILE_PATTERN = /(^server|\.server)\.(mjs|js|ts)$/;

export function createServerActionRegistry(options: CreateServerActionRegistryOptions): ServerActionRegistry {
  let importVersion = 0;
  const actionRoots = options.actionRoots ?? DEFAULT_ACTION_ROOTS;

  const loadActions = async (): Promise<LoadedServerAction[]> => {
    const files = (
      await Promise.all(actionRoots.map((root) => discoverServerActionFiles(resolveActionRoot(options.rootDir, root))))
    ).flat();

    const loaded = await Promise.all(files.map(async (filePath) => loadServerActionFile(filePath, options.rootDir, ++importVersion)));
    return loaded.flat();
  };

  return {
    async list() {
      return (await loadActions()).map(({ id, extensionId, action }) => ({ id, extensionId, action }));
    },
    async invoke(extensionId, action, input) {
      const capability = (await loadActions()).find(
        (candidate) => candidate.extensionId === extensionId && candidate.action === action,
      );
      if (!capability) throw new Error(`Unknown server action: ${extensionId}.${action}`);

      return capability.handler(input, { rootDir: options.rootDir });
    },
  };
}

function resolveActionRoot(rootDir: string, actionRoot: string): string {
  return isAbsolute(actionRoot) ? actionRoot : join(rootDir, actionRoot);
}

async function discoverServerActionFiles(rootDir: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(rootDir, entry.name);
      if (entry.isDirectory()) return discoverServerActionFiles(entryPath);
      if (entry.isFile() && SERVER_ACTION_FILE_PATTERN.test(entry.name)) return [entryPath];
      return [];
    }),
  );
  return files.flat().sort();
}

async function loadServerActionFile(filePath: string, rootDir: string, importVersion: number): Promise<LoadedServerAction[]> {
  const importPath = await prepareServerActionModule(filePath, rootDir, importVersion);
  const moduleUrl = pathToFileURL(importPath);
  moduleUrl.searchParams.set("babyMenuServerActionVersion", String(importVersion));
  const module = (await import(moduleUrl.href)) as ServerActionModule;
  const extensionId = normalizeExtensionId(module.extensionId ?? module.id) ?? inferExtensionId(filePath);
  const actions = normalizeActions(module.actions);

  return Object.entries(actions).map(([action, handler]) => ({
    id: `${extensionId}.${action}`,
    extensionId,
    action,
    handler,
  }));
}

async function prepareServerActionModule(filePath: string, rootDir: string, importVersion: number): Promise<string> {
  const cacheRoot = join(rootDir, ".cache", "baby-menu", "server-actions", String(importVersion));
  await copyServerActionModule(filePath, rootDir, cacheRoot, new Set());
  return cachedModulePath(filePath, rootDir, cacheRoot);
}

async function copyServerActionModule(
  filePath: string,
  rootDir: string,
  cacheRoot: string,
  seen: Set<string>,
): Promise<void> {
  const normalizedPath = resolve(filePath);
  if (seen.has(normalizedPath)) return;
  seen.add(normalizedPath);

  const source = await readFile(normalizedPath, "utf8");
  const dependencies = await findLocalServerActionDependencies(source, normalizedPath);
  const rewritten = await rewriteLocalServerActionImports(source, normalizedPath);
  const outputPath = cachedModulePath(normalizedPath, rootDir, cacheRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rewritten);

  await Promise.all(dependencies.map((dependency) => copyServerActionModule(dependency, rootDir, cacheRoot, seen)));
}

function cachedModulePath(filePath: string, rootDir: string, cacheRoot: string): string {
  const relativePath = relative(rootDir, filePath);
  return join(cacheRoot, relativePath);
}

export async function rewriteLocalServerActionImports(source: string, filePath: string): Promise<string> {
  const importPattern = /(\b(?:import|export)\b[\s\S]*?\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g;
  const replacements = await Promise.all(
    [...source.matchAll(importPattern)].map(async (match) => {
      const resolved = await resolveLocalImport(filePath, match[2]);
      if (!resolved) return null;
      return {
        start: match.index + match[1].length,
        end: match.index + match[1].length + match[2].length,
        value: toExtensionSpecifier(match[2], resolved.kind),
      };
    }),
  );

  return applyReplacements(source, replacements.filter((replacement) => replacement !== null));
}

async function findLocalServerActionDependencies(source: string, filePath: string): Promise<string[]> {
  const importPattern = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g;
  const dependencies = await Promise.all(
    [...source.matchAll(importPattern)].map(async (match) => (await resolveLocalImport(filePath, match[1]))?.path),
  );
  return dependencies.filter((dependency): dependency is string => Boolean(dependency));
}

type ResolvedLocalImport = {
  path: string;
  kind: { type: "file"; extension: string } | { type: "index"; extension: string };
};

async function resolveLocalImport(filePath: string, specifier: string): Promise<ResolvedLocalImport | null> {
  if (!specifier.startsWith(".")) return null;
  if (extname(specifier)) return resolveExistingImport(filePath, specifier);

  const basePath = resolve(dirname(filePath), specifier);
  for (const extension of [".ts", ".mjs", ".js"]) {
    if (await fileExists(`${basePath}${extension}`)) {
      return { path: `${basePath}${extension}`, kind: { type: "file", extension } };
    }
  }

  for (const extension of [".ts", ".mjs", ".js"]) {
    const indexPath = join(basePath, `index${extension}`);
    if (await fileExists(indexPath)) return { path: indexPath, kind: { type: "index", extension } };
  }

  return null;
}

async function resolveExistingImport(filePath: string, specifier: string): Promise<ResolvedLocalImport | null> {
  const resolved = resolve(dirname(filePath), specifier);
  if (await fileExists(resolved)) {
    return { path: resolved, kind: { type: "file", extension: extname(resolved) } };
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirname(filePath), { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name === basename(filePath));
  } catch {
    return false;
  }
}

function toExtensionSpecifier(specifier: string, kind: ResolvedLocalImport["kind"]): string {
  if (kind.type === "index") return `${specifier}/index${kind.extension}`;
  return `${specifier}${kind.extension}`;
}

function applyReplacements(source: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce((current, replacement) => {
      return `${current.slice(0, replacement.start)}${replacement.value}${current.slice(replacement.end)}`;
    }, source);
}

function normalizeExtensionId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeActions(value: unknown): Record<string, ServerActionHandler> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, ServerActionHandler] => {
      const [name, handler] = entry;
      return Boolean(name.trim()) && typeof handler === "function";
    }),
  );
}

function inferExtensionId(filePath: string): string {
  const fileName = basename(filePath, extname(filePath));
  if (fileName === "server") return basename(dirname(filePath));
  return fileName.replace(/\.server$/, "") || relative(process.cwd(), filePath);
}
