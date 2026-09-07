/** Every CSS variable the chart SVG paints with — resolved against the document before rasterising,
 *  because a standalone SVG (loaded as an image) has no access to the page's custom properties. */
const PAINT_VARS: { name: string; fallback: string }[] = [
  { name: '--accent', fallback: '#22d3ee' },
  { name: '--success', fallback: '#3ddc8d' },
  { name: '--danger', fallback: '#fb7185' },
  { name: '--border', fallback: 'rgba(255,255,255,0.08)' },
  { name: '--foreground', fallback: '#f1f3f6' },
];

const SURFACE_VAR = { name: '--surface', fallback: '#161c26' };

/**
 * Rasterise the chart SVG to a PNG Blob: resolve the CSS-var colours, lay it on an opaque surface at
 * 2×, then stamp the Binsight watermark bottom-left. Returns a Blob so the share dialog can preview /
 * copy / download it (instead of forcing an immediate download).
 */
export function renderChartPng(svg: SVGSVGElement | null): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!svg) {
      reject(new Error('chart not ready'));
      return;
    }
    // The raster matches the SVG's own user space, so the watermark lands where it does on screen.
    const width = svg.viewBox.baseVal.width;
    const height = svg.viewBox.baseVal.height;
    if (width <= 0 || height <= 0) {
      reject(new Error('chart has no viewBox'));
      return;
    }

    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;

    let inner = new XMLSerializer().serializeToString(svg);
    for (const { name, fallback } of PAINT_VARS) {
      inner = inner.replaceAll(`var(${name})`, cssVar(name, fallback));
    }
    const body = inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    const svgStr =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<rect width="100%" height="100%" fill="${cssVar(SURFACE_VAR.name, SURFACE_VAR.fallback)}"/>${body}</svg>`;

    const image = new Image();
    image.onload = () => {
      const density = 2;
      const canvas = document.createElement('canvas');
      canvas.width = width * density;
      canvas.height = height * density;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('no 2d context'));
        return;
      }
      ctx.scale(density, density);
      ctx.drawImage(image, 0, 0);
      drawWatermark(ctx, height, cssVar('--accent', '#22d3ee'));
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
        'image/png',
      );
    };
    image.onerror = () => reject(new Error('chart image failed to load'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;
  });
}

/** The Binsight mark (concentrated-liquidity bins, active bin brightest), bottom-left. */
function drawWatermark(ctx: CanvasRenderingContext2D, height: number, accent: string): void {
  const ox = 18;
  const baseY = height - 16;
  const s = 0.07;
  const bars: [number, number][] = [
    [68, 135],
    [148, 216],
    [228, 300],
    [308, 216],
    [388, 135],
  ];
  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  ctx.save();
  ctx.fillStyle = accent;
  bars.forEach(([bx, bh], i) => {
    const h = bh * s;
    ctx.globalAlpha = i === 2 ? 0.95 : 0.55;
    roundRect(ox + (bx - 68) * s, baseY - h, 56 * s, h, 28 * s);
    ctx.fill();
  });
  ctx.restore();
}
