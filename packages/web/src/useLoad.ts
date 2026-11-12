import { useEffect, useState } from "react";
import type { Load } from "./format.js";

/**
 * Load once, and again every `refreshMs` when given. A refresh keeps showing the last value until
 * the new one arrives, so the page does not flash.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], refreshMs?: number): Load<T> {
  const [v, setV] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setV({ state: "loading" });
    const fetchOnce = (first: boolean) =>
      load().then(
        (value) => alive && setV({ state: "ready", value }),
        (e: unknown) => alive && first && setV({ state: "failed", message: e instanceof Error ? e.message : String(e) }),
      ).finally(() => {
        if (alive && refreshMs) timer = setTimeout(() => void fetchOnce(false), refreshMs);
      });
    void fetchOnce(true);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, deps);
  return v;
}
