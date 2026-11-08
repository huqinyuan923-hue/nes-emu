/**
 * Web 打包脚本：esbuild 把 src/web/main.ts 打成单文件，内联进 dist/index.html，
 * 产物可直接部署 GitHub Pages（无外部依赖、无 CDN）。
 *
 * 用法：npm run build:web   （先 npm install -D esbuild）
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const proj = join(root, '..');

const result = await build({
  entryPoints: [join(proj, 'src/web/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  write: false,
  legalComments: 'none',
  logLevel: 'info',
});

const js = result.outputFiles[0].text;
const template = readFileSync(join(proj, 'src/web/index.html'), 'utf8');

// 用内联 <script> 替换模块引用，产出单文件 HTML
const html = template.replace(
  /<script type="module" src="\.\/main\.ts"><\/script>/,
  () => `<script>${js.replace(/<\/script>/gi, '<\\/script>')}</script>`,
);

mkdirSync(join(proj, 'dist'), { recursive: true });
writeFileSync(join(proj, 'dist/index.html'), html);
console.log(`dist/index.html 已生成（${(html.length / 1024).toFixed(1)} KB，单文件可部署）`);
