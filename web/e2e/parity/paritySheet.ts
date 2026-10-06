import type { Browser } from '@playwright/test';

export interface ParitySheet {
  readonly title: string;
  readonly reference: Buffer | null;
  readonly app: Buffer;
}

const image = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`;

const panel = (caption: string, png: Buffer | null): string =>
  png === null
    ? `<figure><figcaption>${caption}</figcaption><p class="missing">No reference for this state.</p></figure>`
    : `<figure><figcaption>${caption}</figcaption><img src="${image(png)}"></figure>`;

// The reference on the left, the app on the right, at their real size, under one title.
export const composeSheet = async (browser: Browser, sheet: ParitySheet): Promise<Buffer> => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(`<!doctype html><style>
      body { margin: 0; background: #8a8f98; font: 600 18px system-ui, sans-serif; color: #fff; }
      main { display: flex; gap: 24px; padding: 20px; width: max-content; align-items: flex-start; }
      h1 { margin: 20px 20px 0; font-size: 20px; }
      figure { margin: 0; }
      figcaption { margin-bottom: 8px; }
      img { display: block; outline: 1px solid #0006; }
      .missing { width: 390px; padding: 40px 0; text-align: center; background: #0003; }
    </style><h1>${sheet.title}</h1><main>${panel('MOCKUP', sheet.reference)}${panel('APP', sheet.app)}</main>`);
    await page.waitForFunction('[...document.images].every((img) => img.complete)');
    return await page.screenshot({ fullPage: true });
  } finally {
    await page.close();
  }
};
