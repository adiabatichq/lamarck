export interface UnifiedPatchOptions {
  oldPath: string;
  newPath: string;
  maxDiffCells?: number;
}

interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

const DEFAULT_MAX_DIFF_CELLS = 200_000;

export function createUnifiedPatch(
  before: string,
  after: string,
  opts: UnifiedPatchOptions,
): string {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const maxCells = opts.maxDiffCells ?? DEFAULT_MAX_DIFF_CELLS;

  const diff =
    oldLines.length * newLines.length > maxCells
      ? replacementDiff(oldLines, newLines)
      : computeDiff(oldLines, newLines);

  return [
    `--- ${opts.oldPath}`,
    `+++ ${opts.newPath}`,
    `@@ -${formatRange(1, oldLines.length)} +${formatRange(1, newLines.length)} @@`,
    ...diff.map(formatDiffLine),
  ].join("\n");
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function computeDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "same", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: "del", text: oldLines[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

function replacementDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  return [
    ...oldLines.map((text) => ({ type: "del" as const, text })),
    ...newLines.map((text) => ({ type: "add" as const, text })),
  ];
}

function formatRange(start: number, count: number): string {
  if (count === 0) return "0,0";
  return count === 1 ? String(start) : `${start},${count}`;
}

function formatDiffLine(line: DiffLine): string {
  const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return `${prefix}${line.text}`;
}
