// 构建前的内容关联校验 —— 让「照片挂错项目」这类问题在构建期就炸掉,而不是安静上线。
//
// 背景:一张照片属于哪个项目,靠的是「照片里的 project 字段」与「Astro 由项目文件名
// 派生的集合 id」严格相等。这两个值来源不同 —— 一个手写在照片里,一个由文件名 slug 化而来 ——
// 一旦对不上,项目页不会报任何错,它会渲染成一个只有标题和简介、照片一张都没有的空页。
// 江西省博物馆(id 带大写)和云冈石窟都这样丢过照片,且都是上线之后才被发现的。
//
// 查三类:
//   · 错误:项目 id 不是规范 slug —— 关联必断的根因
//   · 错误:照片指向了不存在的项目 —— 这张照片哪个项目页都进不去
//   · 提醒:项目下一张照片都没有 —— 可能只是刚建的空项目,也可能是关联断了的征兆
//
// 构建时由 astro.config.mjs 里的 content-guard 集成自动调用;也可以单独跑:
//   node scripts/check-content.mjs
// 确需放行:SKIP_CONTENT_CHECK=1

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontmatter } from "./lib/frontmatter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectsDir = path.join(root, "src", "content", "projects");
const photosDir = path.join(root, "src", "content", "photos");

// 与 admin-server.mjs 的 slugifyProjectId 同一套规则:小写字母/数字,连字符分隔。
// 只要项目 id 不是这个形状,Astro 由文件名派生的集合 id 就会和它不同,关联必断。
const CANONICAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slugify = (v) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

async function readEntries(dir) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return []; // 目录还不存在(全新仓库)不算错
  }
  return Promise.all(
    files.map(async (file) => ({
      file,
      fm: parseFrontmatter(await readFile(path.join(dir, file), "utf8")),
    })),
  );
}

export async function checkContent() {
  const errors = [];
  const warnings = [];

  const projects = (await readEntries(projectsDir)).map(({ file, fm }) => ({
    file,
    id: String(fm.id ?? "").trim() || path.basename(file, ".md"),
    title: String(fm.title ?? "").trim() || path.basename(file, ".md"),
  }));
  const photos = (await readEntries(photosDir)).map(({ file, fm }) => ({
    file,
    project: String(fm.project ?? "").trim(),
  }));

  const ids = new Set(projects.map((p) => p.id));

  // ① 项目 id 必须是规范 slug
  for (const p of projects) {
    if (CANONICAL_ID.test(p.id)) continue;
    const fixed = slugify(p.id);
    errors.push(
      `项目「${p.title}」(${p.file})的 id 是 "${p.id}",不是规范 slug。` +
        `Astro 会按文件名把它派生成另一种小写形式,这个项目的照片将一张都渲染不出来。` +
        (fixed
          ? `请把 id 和文件名都改成 "${fixed}"。`
          : `id 里必须有英文字母或数字,请另起一个英文 id。`),
    );
  }

  // ② 照片必须挂在真实存在的项目下(project 在 schema 里是必填,所以空值也算错)
  const orphans = new Map();
  for (const ph of photos) {
    if (ph.project && ids.has(ph.project)) continue;
    const key = ph.project || "(空)";
    if (!orphans.has(key)) orphans.set(key, []);
    orphans.get(key).push(ph.file);
  }
  for (const [proj, files] of orphans) {
    const near = slugify(proj);
    const hint =
      proj && ids.has(near)
        ? `项目 "${near}" 是存在的 —— 多半只是大小写或写法不一致`
        : `没有这个项目`;
    errors.push(
      `${files.length} 张照片的 project 写作 "${proj}",但${hint}。` +
        `例:${files.slice(0, 3).join("、")}${files.length > 3 ? " 等" : ""}。` +
        `这些照片不会出现在任何项目页里。`,
    );
  }

  // ③ 空项目 —— 只提醒
  const counts = new Map();
  for (const ph of photos) counts.set(ph.project, (counts.get(ph.project) ?? 0) + 1);
  for (const p of projects) {
    if (!counts.get(p.id)) {
      warnings.push(
        `项目「${p.title}」(${p.file})下一张照片都没有 —— 刚建的空项目属正常,否则检查照片的 project 字段。`,
      );
    }
  }

  return { errors, warnings, projectCount: projects.length, photoCount: photos.length };
}

// 直接 node 跑时打印结果并用退出码表意
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { errors, warnings, projectCount, photoCount } = await checkContent();
  console.log(`内容检查:${projectCount} 个项目 / ${photoCount} 张照片`);
  for (const w of warnings) console.log(`  提醒  ${w}`);
  for (const e of errors) console.log(`  错误  ${e}`);
  console.log(errors.length ? `\n未通过:${errors.length} 项错误` : "\n通过");
  process.exit(errors.length ? 1 : 0);
}
