// The design system on the phone: the colours of the OS's light or dark theme, and text styles in
// Geist (sans) and Geist Mono (eyebrows and references), from the generated tokens.
import { useColorScheme } from "react-native";
import { colors, type TypeName, type } from "./tokens";

export type Palette = { [K in keyof (typeof colors)["light"]]: string };

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? colors.dark : colors.light;
}

/** The font file each family and weight loads as (src/theme/fonts.ts). */
export function fontFamily(family: string, weight: number): string {
  if (family === "mono") return "GeistMono_500Medium";
  if (weight >= 600) return "Geist_600SemiBold";
  if (weight >= 500) return "Geist_500Medium";
  return "Geist_400Regular";
}

export interface TextStyleTokens {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
  textTransform?: "uppercase";
}

export function textStyle(name: TypeName): TextStyleTokens {
  const t = type[name] as {
    family: string;
    fontSize: number;
    lineHeight: number;
    fontWeight: number;
    letterSpacing?: number;
    uppercase?: boolean;
  };
  return {
    fontFamily: fontFamily(t.family, t.fontWeight),
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    ...(t.letterSpacing !== undefined ? { letterSpacing: t.letterSpacing } : {}),
    ...(t.uppercase ? { textTransform: "uppercase" as const } : {}),
  };
}

export { radius, space } from "./tokens";
