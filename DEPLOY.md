# 部署说明

## 生产环境：Cloudflare Pages

- 项目名：`nes-emu-5j6`（`nes-emu` 被占用，Cloudflare 自动加了后缀）
- 域名：https://nes.adcakeyuan.top
- 形态：单文件静态页（`dist/index.html`，esbuild 内联全部 JS）

```bash
npm run build:web
npx wrangler pages deploy dist --project-name nes-emu-5j6 --branch main
```

要求：本机已 `npx wrangler login`（或设置 `CLOUDFLARE_API_TOKEN`）。

## GitHub Pages（已停用）

仓库里保留了 `gh-pages` 分支作为静态快照，但它**不是**生产来源：
自定义域已解除，HTTPS 证书始终未签发，已整体迁到 Cloudflare Pages。

## 测试

```bash
npm test          # 116/123，7 项 dot 级时序为已知限制（见 REPORT.md §0.7）
npm run typecheck
npm run bench     # 性能基准，不参与正确性 gate
```

测试 ROM 不入库（版权），首次需：

```bash
npm run fetch:test-roms
```