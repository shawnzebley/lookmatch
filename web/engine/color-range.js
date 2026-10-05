// HSL membership for a picked source color. Hue wraps at 360 degrees; widths are radii.
export function rgbToHsl(rgb) {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  let s = 0;
  if (d > 1e-12) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: s * 100, l: l * 100 };
}

const smooth = (x) => x * x * (3 - 2 * x);
const distance = (a, b, period = Infinity) => {
  const d = Math.abs(a - b);
  return period === Infinity ? d : Math.min(d, period - d);
};

// Returns a feathered 0..1 membership weight for normalized sRGB triples or HSL objects.
export function colorRangeWeight(rgbOrHsl, selection) {
  if (!selection || !rgbOrHsl) return 1;
  const c = Array.isArray(rgbOrHsl) ? rgbToHsl(rgbOrHsl) : rgbOrHsl;
  const widths = [selection.hueWidth, selection.satWidth, selection.lightWidth];
  const deltas = [distance(c.h, selection.h, 360), Math.abs(c.s - selection.s), Math.abs(c.l - selection.l)];
  const feather = Math.max(0.001, Math.min(1, selection.softness ?? 0.25));
  let w = 1;
  for (let i = 0; i < 3; i++) {
    const radius = Math.max(0.001, widths[i]);
    const inner = radius * (1 - feather);
    if (deltas[i] >= radius) return 0;
    if (deltas[i] > inner) w = Math.min(w, smooth((radius - deltas[i]) / (radius - inner)));
  }
  return w;
}
