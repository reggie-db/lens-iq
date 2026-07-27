import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert a `#rrggbb` color into an `rgba(...)` string at the given alpha.
 * Used to derive translucent fills (bbox interiors, label pills, chart
 * cursors) from a solid accent color. `fallback` is the RGB triple to use
 * when `hex` isn't a six-digit hex color; callers pass their own so a
 * malformed model color degrades to that surface's accent, not a shared one.
 */
export function hexToRgba(
  hex: string,
  alpha: number,
  fallback: readonly [number, number, number],
): string {
  const digits = hex.match(/^#?([0-9a-fA-F]{6})$/)?.[1];
  if (!digits) return `rgba(${fallback[0]}, ${fallback[1]}, ${fallback[2]}, ${alpha})`;
  const n = parseInt(digits, 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}
