// The Mezonas mark on its app-icon square (slate, radius 22%), drawn from mezonas-mark-paper.svg:
// the table and its six seats, one colour.

import { View } from "react-native";
import Svg, { G, Rect } from "react-native-svg";
import { usePalette } from "../theme/theme";

export function Mark({ size = 72 }: { size?: number }) {
  const p = usePalette();
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="Mezonas"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        backgroundColor: p.slate,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Svg width={size * 0.72} height={size * 0.72} viewBox="0 0 48 48">
        <G fill={p.onSlate}>
          <Rect x={12} y={14} width={24} height={20} rx={2} />
          <Rect x={15} y={6} width={7} height={4} rx={1} />
          <Rect x={26} y={6} width={7} height={4} rx={1} />
          <Rect x={15} y={38} width={7} height={4} rx={1} />
          <Rect x={26} y={38} width={7} height={4} rx={1} />
          <Rect x={4} y={20.5} width={4} height={7} rx={1} />
          <Rect x={40} y={20.5} width={4} height={7} rx={1} />
        </G>
      </Svg>
    </View>
  );
}
