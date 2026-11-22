import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Regenerate the PNG/ICO icons in public/ from public/favicon.svg: `pnpm --filter @budget/web icons`.
const background = '#0f766e';

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background } },
  },
  images: ['public/favicon.svg'],
});
