import { useEffect, useRef } from "react";

export type WidgetRefreshOptions = {
  id: string;
  refreshIntervalMs?: number;
  refresh: () => void | Promise<void>;
};

export function useWidgetRefresh(options: WidgetRefreshOptions) {
  const refreshRef = useRef(options.refresh);
  refreshRef.current = options.refresh;

  const refreshNow = () => {
    void refreshRef.current();
  };

  useEffect(() => {
    refreshNow();
    if (!options.refreshIntervalMs) return undefined;

    const timer = window.setInterval(refreshNow, options.refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [options.id, options.refreshIntervalMs]);

  return { refreshNow };
}
