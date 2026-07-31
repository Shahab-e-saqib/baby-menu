import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type BabyMenuPreferences = {
  openAtLogin: boolean;
  /** Persisted embedded-agent choice; absent until the user picks one. */
  agentName?: string;
  agentModes?: Record<string, "native" | "wsl">;
  wslDistribution?: string;
};

type LoginItemApp = {
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void;
};

export type PreferencesService = {
  get: () => Promise<BabyMenuPreferences>;
  setOpenAtLogin: (openAtLogin: boolean) => Promise<BabyMenuPreferences>;
  setAgent: (agentName: string) => Promise<BabyMenuPreferences>;
  setAgentMode: (agentName: string, mode: "native" | "wsl") => Promise<BabyMenuPreferences>;
  setWslDistribution: (distribution: string) => Promise<BabyMenuPreferences>;
  apply: () => Promise<BabyMenuPreferences>;
};

type CreatePreferencesServiceOptions = {
  userDataDir: string;
  app: LoginItemApp;
  defaultOpenAtLogin?: boolean;
  allowOpenAtLogin?: boolean;
};

export function createPreferencesService({
  userDataDir,
  app,
  defaultOpenAtLogin = true,
  allowOpenAtLogin = true,
}: CreatePreferencesServiceOptions): PreferencesService {
  const filePath = join(userDataDir, "preferences.json");

  function normalizePreferences(preferences: BabyMenuPreferences): BabyMenuPreferences {
    const agentName = preferences.agentName?.trim();
    const agentModes = Object.fromEntries(
      Object.entries(preferences.agentModes ?? {}).filter(([name, mode]) => name.trim() && (mode === "native" || mode === "wsl")),
    ) as Record<string, "native" | "wsl">;
    const wslDistribution = preferences.wslDistribution?.trim();
    return {
      openAtLogin: allowOpenAtLogin && preferences.openAtLogin,
      ...(agentName ? { agentName } : {}),
      ...(Object.keys(agentModes).length ? { agentModes } : {}),
      ...(wslDistribution ? { wslDistribution } : {}),
    };
  }

  function applyLoginItemSettings(preferences: BabyMenuPreferences): void {
    if (!allowOpenAtLogin) return;
    app.setLoginItemSettings({ openAtLogin: preferences.openAtLogin });
  }

  async function readPreferences(): Promise<BabyMenuPreferences> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<BabyMenuPreferences>;
      return normalizePreferences({
        openAtLogin: parsed.openAtLogin ?? defaultOpenAtLogin,
        agentName: parsed.agentName,
        agentModes: parsed.agentModes,
        wslDistribution: parsed.wslDistribution,
      });
    } catch {
      return normalizePreferences({ openAtLogin: defaultOpenAtLogin });
    }
  }

  async function writePreferences(preferences: BabyMenuPreferences): Promise<BabyMenuPreferences> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(preferences, null, 2)}\n`);
    return preferences;
  }

  let preferenceMutation = Promise.resolve();
  function updatePreferences(
    update: (current: BabyMenuPreferences) => BabyMenuPreferences,
    afterWrite?: (preferences: BabyMenuPreferences) => void,
  ): Promise<BabyMenuPreferences> {
    const result = preferenceMutation.then(async () => {
      const current = await readPreferences();
      const preferences = await writePreferences(normalizePreferences(update(current)));
      afterWrite?.(preferences);
      return preferences;
    });
    preferenceMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    get: readPreferences,
    setOpenAtLogin(openAtLogin) {
      return updatePreferences((current) => ({ ...current, openAtLogin }), applyLoginItemSettings);
    },
    setAgent(agentName) {
      return updatePreferences((current) => ({ ...current, agentName }));
    },
    setAgentMode(agentName, mode) {
      return updatePreferences((current) => ({ ...current, agentModes: { ...current.agentModes, [agentName]: mode } }));
    },
    setWslDistribution(distribution) {
      return updatePreferences((current) => ({ ...current, wslDistribution: distribution }));
    },
    async apply() {
      const preferences = await readPreferences();
      applyLoginItemSettings(preferences);
      return preferences;
    },
  };
}
