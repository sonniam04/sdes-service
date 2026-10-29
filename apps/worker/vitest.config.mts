import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import { fileURLToPath } from "node:url";

// SWC ให้ decorator metadata ทำงานใน test ของ NestJS
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  resolve: {
    alias: {
      "@sdes/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@sdes/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["src/**/*.test.ts", "test/**/*.e2e.ts"], environment: "node" },
});
