export type DiffLine = { op: " " | "+" | "-"; text: string };

/** A line diff (longest common subsequence), for showing what an event changed in pretty-printed JSON. */
export function lineDiff(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * width + j] = before[i] === after[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ op: " ", text: after[j]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) out.push({ op: "-", text: before[i++]! });
    else out.push({ op: "+", text: after[j++]! });
  }
  while (i < n) out.push({ op: "-", text: before[i++]! });
  while (j < m) out.push({ op: "+", text: after[j++]! });
  return out;
}
