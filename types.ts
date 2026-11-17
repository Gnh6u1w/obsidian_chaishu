export const VIEW_TYPE_CHAISHU_MATRIX = "chaishu-matrix-pro-view";

export type NodeType = "volume" | "unit" | "chapter";

export interface Dimension {
  id: string;
  name: string;
  color: string;
  /** When "chart", this dimension exposes the emotion-chart drawing panel. */
  type?: "chart";
}

export interface NodeData {
  id: string;
  type: NodeType;
  name: string;
  /** Vault-relative path of the volume/unit summary note, "" when not created. */
  summaryFile: string;
  summaryHasContent: boolean;
  children: NodeData[];
  collapsed: boolean;
}

export interface BookInfo {
  title: string;
  author: string;
  score: string;
  /** Vault-relative path of the wallpaper image, "" = none. */
  bgImage: string;
  bgMode: "cover" | "repeat";
  /** Overlay opacity 0..1 (higher = darker mask). */
  bgOverlay: number;
}

export interface CellData {
  /** Vault-relative path of the note, "" when not created yet. */
  filePath: string;
  hasContent: boolean;
}

export interface ChartPoint {
  chapterId: string;
  value: number;
}

export interface BookData {
  id: string;
  bookInfo: BookInfo;
  /** Vault-relative base directory for archiving, "" = vault root. */
  storagePath: string;
  dimensions: Dimension[];
  structure: NodeData[];
  cells: Record<string, CellData>;
  chartData: Record<string, ChartPoint[]>;
}

export interface ChaiShuSettings {
  defaultChapterCount: number;
  defaultDimensionNames: string;
  defaultStoragePath: string;
  activeBookId: string;
  books: BookData[];
}

export const DEFAULT_SETTINGS: ChaiShuSettings = {
  defaultChapterCount: 5,
  defaultDimensionNames: "情绪,长期期待,中期期待,冲突",
  defaultStoragePath: "",
  activeBookId: "",
  books: [],
};

export const DIMENSION_COLORS: string[] = [
  "#3b82f6", // blue
  "#f97316", // orange
  "#ef4444", // red
  "#22c55e", // green
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
  "#eab308", // yellow
];

export const DIMENSION_COLOR_NAMES: string[] = [
  "蓝",
  "橙",
  "红",
  "绿",
  "紫",
  "粉",
  "青",
  "黄",
];

export const CHART_VALUE_MAX = 10;
