// The Mezonas icons (packages/design-system/assets/Icons): 24px grid, 1.5px stroke, square caps,
// miter joins, outline only, coloured with the text around them. Paths copied from the mz-*.svg
// files; only the ones the app uses.
import type { ColorValue } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

export type IconName =
  | "desk"
  | "message"
  | "settings"
  | "chevronRight"
  | "chevronLeft"
  | "check"
  | "close"
  | "info"
  | "alert"
  | "document"
  | "phone"
  | "faceId"
  | "notifications"
  | "sign";

export function Icon({
  name,
  size = 20,
  color,
}: {
  name: IconName;
  size?: number;
  color: ColorValue;
}) {
  const stroke = {
    stroke: color,
    strokeWidth: 1.5,
    strokeLinecap: "square" as const,
    fill: "none",
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      {shape(name, stroke, color)}
    </Svg>
  );
}

function shape(
  name: IconName,
  s: { stroke: ColorValue; strokeWidth: number; strokeLinecap: "square"; fill: string },
  color: ColorValue,
) {
  switch (name) {
    case "desk":
      return (
        <>
          <Rect x={3} y={5} width={18} height={14} rx={1.5} {...s} />
          <Path d="M3 13h5l1.5 2.5h5L16 13h5" {...s} />
        </>
      );
    case "message":
      return <Path d="M4 5h16v11H9l-5 4z M8 9h8 M8 12h5" {...s} />;
    case "settings":
      return (
        <>
          <Path d="M4 7h9 M17 7h3 M4 17h3 M11 17h9" {...s} />
          <Circle cx={15} cy={7} r={2} {...s} />
          <Circle cx={9} cy={17} r={2} {...s} />
        </>
      );
    case "chevronRight":
      return <Path d="M9.5 6l6 6-6 6" {...s} />;
    case "chevronLeft":
      return <Path d="M14.5 6l-6 6 6 6" {...s} />;
    case "check":
      return <Path d="M5 12.5l4.5 4.5L19 7.5" {...s} />;
    case "close":
      return <Path d="M6 6l12 12 M18 6L6 18" {...s} />;
    case "info":
      return (
        <>
          <Circle cx={12} cy={12} r={8.5} {...s} />
          <Path d="M12 11v5.5" {...s} />
          <Circle cx={12} cy={7.75} r={1} fill={color} />
        </>
      );
    case "alert":
      return (
        <>
          <Path d="M12 3.5l9.5 16.5h-19z M12 10v4.5" {...s} />
          <Circle cx={12} cy={17.25} r={1} fill={color} />
        </>
      );
    case "document":
      return <Path d="M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6" {...s} />;
    case "phone":
      return (
        <>
          <Rect x={7} y={3} width={10} height={18} rx={1.5} {...s} />
          <Path d="M11 17.5h2" {...s} />
        </>
      );
    case "faceId":
      // Not in the set: drawn on the same grid and stroke for the Face ID buttons.
      return (
        <Path
          d="M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M9 9.5v1 M15 9.5v1 M12 9.5v3.5h-1 M9.5 15.5c1.4 1 3.6 1 5 0"
          {...s}
        />
      );
    case "notifications":
      return <Path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z M10 20.5h4" {...s} />;
    case "sign":
      return <Path d="M14.5 4.5l3 3L9 16H6v-3z M4 20h16" {...s} />;
  }
}
