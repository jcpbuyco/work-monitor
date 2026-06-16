import { useEffect, useState } from "react";

/** Current location hash (e.g. "#/cost"), updated on `hashchange`.
 *  An empty hash normalizes to "#/". */
export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}
