// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import { checkContent } from "./scripts/check-content.mjs";

// 构建前的最后一道闸:照片的 project 字段必须能对上项目的集合 id。
// 对不上时项目页会安静地变成一个没有照片的空页(而不是报错),所以宁可让构建失败 ——
// 空页上线了没人会发现,构建失败一定会被看到。详见 scripts/check-content.mjs。
// 确需放行:SKIP_CONTENT_CHECK=1 npm run build
const contentGuard = {
  name: "content-guard",
  hooks: {
    "astro:build:start": async () => {
      if (process.env.SKIP_CONTENT_CHECK === "1") {
        console.warn("[内容检查] 已按 SKIP_CONTENT_CHECK=1 跳过");
        return;
      }
      const { errors, warnings, projectCount, photoCount } = await checkContent();
      for (const w of warnings) console.warn(`[内容检查] 提醒:${w}`);
      if (errors.length) {
        throw new Error(
          `内容检查未通过(${projectCount} 个项目 / ${photoCount} 张照片):\n` +
            errors.map((e) => `  · ${e}`).join("\n") +
            `\n\n修好后重试,或确认无误后 SKIP_CONTENT_CHECK=1 强行构建。`,
        );
      }
    },
  },
};

// https://astro.build/config
export default defineConfig({
  integrations: [contentGuard],
  vite: {
    plugins: [tailwindcss()],
  },
});
