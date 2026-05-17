// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWidgetRefresh } from "../src/renderer/menu/useWidgetRefresh";

describe("useWidgetRefresh", () => {
  it("refreshes a widget on its interval", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    renderHook(() =>
      useWidgetRefresh({ id: "quota", refreshIntervalMs: 1000, refresh }),
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2500));

    expect(refresh).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("supports manual refresh", () => {
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useWidgetRefresh({ id: "quota", refreshIntervalMs: 1000, refresh }),
    );
    act(() => result.current.refreshNow());

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
