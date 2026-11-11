import { useEffect, useState } from "react";
import type { Load } from "./format.js";

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Load<T> {
  const [v, setV] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    setV({ state: "loading" });
    load().then(
      (value) => alive && setV({ state: "ready", value }),
      (e: unknown) => alive && setV({ state: "failed", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, deps);
  return v;
}
