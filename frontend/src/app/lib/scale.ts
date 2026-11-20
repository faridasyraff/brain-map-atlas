// Scale bars: pick a round length (1, 2 or 5 x 10^n µm) whose bar is close to
// a target width on screen.

export interface ScaleBarSpec {
  um: number;
  px: number;
  label: string;
}

const STEPS = [1, 2, 5];

export function niceScale(pxPerUm: number, targetPx = 96): ScaleBarSpec | null {
  if (!Number.isFinite(pxPerUm) || pxPerUm <= 0) return null;
  const want = targetPx / pxPerUm; // µm the target width covers
  const exp = Math.floor(Math.log10(want));
  let best = 0;
  for (const e of [exp - 1, exp, exp + 1]) {
    for (const s of STEPS) {
      const um = s * 10 ** e;
      if (um * pxPerUm <= targetPx * 1.25 && um > best) best = um;
    }
  }
  if (!best) return null;
  return { um: best, px: Math.round(best * pxPerUm), label: best >= 1000 ? `${best / 1000} mm` : `${best} µm` };
}
