/** Icons + colors for "Create your own" exchanges (keep in sync with CUSTOM_ICONS / CUSTOM_COLORS in api/index.ts). */
import { BookOpen, Coffee, Cookie, Gift, Heart, ListChecks, Music, Palette, PartyPopper, Snowflake, Sparkles, Star, TreePine, type LucideIcon } from "lucide-react";
import type { CustomColor, CustomIcon } from "@shared/api";

export const CUSTOM_ICON_MAP: Record<CustomIcon, LucideIcon> = {
  sparkles: Sparkles,
  gift: Gift,
  heart: Heart,
  star: Star,
  tree: TreePine,
  music: Music,
  coffee: Coffee,
  palette: Palette,
  book: BookOpen,
  cookie: Cookie,
  party: PartyPopper,
  snowflake: Snowflake,
};
export const CUSTOM_ICONS = Object.keys(CUSTOM_ICON_MAP) as CustomIcon[];

/** [deep, bright] gradient stops per color. */
export const CUSTOM_COLOR_MAP: Record<CustomColor, [string, string]> = {
  red: ["#7f1d1d", "#dc2626"],
  green: ["#14532d", "#16a34a"],
  gold: ["#78350f", "#d97706"],
  blue: ["#1e3a8a", "#2563eb"],
  purple: ["#4c1d95", "#7c3aed"],
  pink: ["#831843", "#db2777"],
  teal: ["#134e4a", "#0d9488"],
  slate: ["#0f172a", "#475569"],
};
export const CUSTOM_COLORS = Object.keys(CUSTOM_COLOR_MAP) as CustomColor[];

/** Catalog service icons (event_types.icon). */
export const SERVICE_ICON_MAP: Record<string, LucideIcon> = { gift: Gift, party: PartyPopper, list: ListChecks, book: BookOpen, cookie: Cookie, sparkles: Sparkles };

export const gradientFor = (c: CustomColor | undefined | null) => {
  const [a, b] = CUSTOM_COLOR_MAP[c ?? "red"] ?? CUSTOM_COLOR_MAP.red;
  return `radial-gradient(circle at 90% 10%, rgb(253 230 138 / 0.3), transparent 40%), linear-gradient(150deg, ${a}, ${b})`;
};
