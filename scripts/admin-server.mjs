// 本地后台管理服务(仅本机使用,不参与部署、不出现在摄影网站上)
//
// 用法:
//   npm run admin          # 启动后浏览器打开 http://127.0.0.1:8787
//
// 功能:
//   - 图形化把照片从一个项目移动到另一个项目(拖拽或点选)
//   - 图形化新建项目
//   - 图形化添加照片(上传前检测大小,>10MB 自动压缩;逻辑与 add-photos 一致)
//   - 图形化删除照片(连云端资源一起删)/ 删除项目(还有照片时拦截)
//   - "推送上线"按钮:构建检查 → git commit → git push 一条龙
//   - 直接改写 src/content/photos/*.md 与 src/content/projects/*.md,
//     改完照常用 git push 部署上线
//
// 安全:只监听 127.0.0.1,局域网/外网不可访问;无任何认证(本机即信任边界)。
import { readdir, readFile, writeFile, access, unlink, mkdir, stat, rename, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { v2 as cloudinary } from "cloudinary";
import exifr from "exifr";
import sharp from "sharp";
import { parseFrontmatter, editFrontmatter, yamlStr } from "./lib/frontmatter.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const photosDir = path.join(root, "src", "content", "photos");
const featuredDir = path.join(root, "src", "content", "featured");
const projectsDir = path.join(root, "src", "content", "projects");
const adminDir = path.join(root, "admin");
// 回收站:被删照片的数据文件先挪到这里(可恢复),清空才真正删云端资源。
// 刻意放在三个集合的 base 目录之外 —— Astro 的 glob loader 只扫各自 base,
// 不会把它当成内容加载;并且已加入 .gitignore(删除的元数据不该进公开仓库)。
const trashDir = path.join(root, "src", "content", "trash");

const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp"];
// Cloudinary API 上传上限 10MB;超限自动压缩到 1920px(JPEG q82),同 add-photos
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const PORT = Number(process.argv[2] ?? 8787);
const HOST = "127.0.0.1";

// ---------- 小工具 ----------

// 解析 .env(与 add-photos 同款;此文件 gitignore,不入库)
async function loadEnv() {
  const out = {};
  try {
    const text = await readFile(path.join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
  return out;
}

// id 自动生成:标题转小写字母数字连字符;中文标题则退化为 project-日期(去重)
async function autoId(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug) return slug;
  const base = `project-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const existing = new Set(
    (await readdir(projectsDir)).map((f) => path.basename(f, ".md")),
  );
  let id = base;
  for (let i = 2; existing.has(id); i++) id = `${base}-${i}`;
  return id;
}

// ---------- 数据读取 ----------

// 排序:order 小的在前;没有 order 的(改造前的存量数据)整体排在后面,
// 内部按 date 倒序 —— 即「排过序的项目按手动顺序,没排过的保持原来的按日期」。
// 兜底值用 MAX_SAFE_INTEGER,让存量数据的行为与改造前完全一致。
const ORDER_NONE = Number.MAX_SAFE_INTEGER;
function byOrderThenDate(a, b) {
  const oa = typeof a.order === "number" ? a.order : ORDER_NONE;
  const ob = typeof b.order === "number" ? b.order : ORDER_NONE;
  if (oa !== ob) return oa - ob;
  return String(b.date ?? "").localeCompare(String(a.date ?? ""));
}

async function listProjects() {
  const files = (await readdir(projectsDir)).filter((f) => f.endsWith(".md"));
  const list = await Promise.all(
    files.map(async (f) => {
      const fm = parseFrontmatter(await readFile(path.join(projectsDir, f), "utf8"));
      // 没有 id(或写成空值)时回落到文件名 —— 少了这一步,前端会渲染出一个
      // 名字叫「undefined」、点不开的项目卡片
      return { id: fm.id || path.basename(f, ".md"), ...fm, file: f };
    }),
  );
  return list.sort(byOrderThenDate);
}

async function listPhotos() {
  const files = (await readdir(photosDir)).filter((f) => f.endsWith(".md"));
  const list = await Promise.all(
    files.map(async (f) => {
      const fm = parseFrontmatter(await readFile(path.join(photosDir, f), "utf8"));
      return { id: fm.id || path.basename(f, ".md"), ...fm, file: f };
    }),
  );
  return list.sort(byOrderThenDate);
}

// 照片数据文件的真实路径。文件名不一定等于 id(历史遗留),所以一律经 listPhotos
// 解析,不拼 `${id}.md`。批量操作请先用 photoIndex() 一次性建索引。
async function photoPath(id) {
  const ph = (await listPhotos()).find((p) => p.id === id);
  return ph ? path.join(photosDir, ph.file) : null;
}

// id → 照片条目(含 file/data),供批量写操作用,避免逐个重复扫描目录
async function photoIndex() {
  const map = new Map();
  for (const p of await listPhotos()) map.set(p.id, p);
  return map;
}

// ---------- 写操作 ----------

// 新条目追加到末尾时用的 order 值:目标集合已经排过序(存在显式 order)则 max+1;
// 从没排过序则返回 null = 不写 order,让它跟其他未排序项一起回落到按 date 排序。
// 这样避免「新建的项目/新传的照片突然跳到列表最前面」这种反直觉行为。
function nextOrder(items) {
  const nums = items.map((it) => it.order).filter((n) => typeof n === "number");
  return nums.length ? Math.max(...nums) + 1 : null;
}

// 移动照片:改写该 .md 的 project 行,其余内容原样保留
async function movePhotos(photoIds, targetProject) {
  const index = await photoIndex();
  const results = [];
  for (const id of photoIds) {
    const ph = index.get(id);
    if (!ph) {
      results.push({ id, ok: false, error: "数据文件不存在" });
      continue;
    }
    const file = path.join(photosDir, ph.file);
    const out = editFrontmatter(await readFile(file, "utf8"), {
      set: { project: targetProject },
    });
    if (out === null) {
      results.push({ id, ok: false, error: "数据文件格式异常(缺少 frontmatter)" });
      continue;
    }
    await writeFile(file, out, "utf8");
    results.push({ id, ok: true });
  }
  return results;
}

// 新建项目:frontmatter 与现有项目 .md 同构,正文留占位
async function createProject({ id, title, description = "", date = "", location = "", coverImage = "" }) {
  const all = await listProjects();
  const usedIds = new Set(all.map((p) => p.id));
  if (usedIds.has(id)) throw new Error(`项目 id 已存在:${id}`);
  const order = nextOrder(all);
  const frontmatter = [
    "---",
    `id: ${yamlStr(id)}`,
    `title: ${yamlStr(title)}`,
    `description: ${yamlStr(description)}`,
    `coverImage: ${coverImage ? yamlStr(coverImage) : '""'}`,
    `date: ${date ? yamlStr(date) : ""}`,
    `location: ${location ? yamlStr(location) : ""}`,
    ...(order === null ? [] : [`order: ${order}`]),
    "---",
    "",
  ].join("\n");
  await writeFile(path.join(projectsDir, `${id}.md`), frontmatter, "utf8");
  return { id };
}

// ---------- 添加照片(逻辑与 scripts/add-photos.mjs 一致) ----------

let cloudReady = false;
async function ensureCloudinary() {
  if (cloudReady) return;
  const env = await loadEnv();
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error(".env 缺少 Cloudinary 配置,无法上传照片");
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
  cloudReady = true;
}

// Cloudinary 错误信息优先取 .message;部分网络错误只有 .error 或裸对象,逐级兜底
function errMessage(e) {
  return e?.message || e?.error?.message || (typeof e === "string" ? e : JSON.stringify(e));
}

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, result) => (err ? reject(err) : resolve(result)))
      .end(buffer);
  });
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// 单张照片入库:大小检测(>10MB 自动压缩)→ EXIF → 上传 → 生成 .md
async function addPhoto({ name, data, project = "", featured = false }) {
  const ext = path.extname(name).toLowerCase();
  if (!IMG_EXT.includes(ext)) {
    return { name, ok: false, error: `不支持的图片格式 ${ext}` };
  }
  const base = path.basename(name, ext);
  const outDir = featured ? featuredDir : photosDir;
  if (await fileExists(path.join(outDir, `${base}.md`))) {
    return { name, ok: false, skipped: true, error: "已有数据文件,自动跳过" };
  }
  // 回收站里有同名文件也拦下:否则恢复时会撞名(恢复逻辑会拒绝,但先说清楚更好)
  if (!featured && (await fileExists(path.join(trashDir, `${base}.md`)))) {
    return { name, ok: false, skipped: true, error: "回收站里有同名照片,先恢复或彻底删除它再上传" };
  }

  let buf;
  try {
    buf = Buffer.from(data, "base64");
  } catch {
    return { name, ok: false, error: "文件内容解码失败" };
  }

  // 上传前大小检测:>10MB 自动压缩到 1920px(JPEG q82),同 add-photos
  let compressed = false;
  const origBytes = buf.length;
  if (buf.length > MAX_UPLOAD_BYTES) {
    try {
      buf = await sharp(buf)
        .rotate() // 应用 EXIF 方向
        .resize(1920, null, { withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      compressed = true;
    } catch {
      return { name, ok: false, error: "图片压缩失败(文件可能不是有效图片)" };
    }
  }

  // 读 EXIF(失败降级为今天)
  let date = new Date().toISOString().slice(0, 10),
    camera = "",
    focal = "",
    iso = "";
  try {
    const t = await exifr.parse(buf, { pick: ["Model", "DateTimeOriginal", "FocalLength", "ISO"] });
    if (t?.DateTimeOriginal instanceof Date) {
      const d = t.DateTimeOriginal;
      date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    if (t?.Model) camera = String(t.Model).trim();
    if (typeof t?.FocalLength === "number") focal = `${Math.round(t.FocalLength)}mm`;
    if (typeof t?.ISO === "number") iso = t.ISO;
  } catch {}

  // 上传(overwrite=false 防覆盖;失败自动重试一次;already exists 视为成功)
  await ensureCloudinary();
  let upload;
  const options = { public_id: `photos/${base}`, overwrite: false };
  try {
    upload = await uploadBuffer(buf, options);
  } catch (err) {
    if (errMessage(err).includes("already exists")) {
      upload = null; // 云端已有同名资源,视为成功
    } else {
      try {
        await new Promise((r) => setTimeout(r, 2000));
        upload = await uploadBuffer(buf, options);
      } catch (e2) {
        if (!errMessage(e2).includes("already exists")) {
          return { name, ok: false, error: errMessage(e2) };
        }
        upload = null;
      }
    }
  }

  // 生成 .md(与 add-photos 同构:title 空、date 带引号、iso 必须数字)
  const exifLines = [];
  if (camera) exifLines.push(`  camera: ${yamlStr(camera)}`);
  if (focal) exifLines.push(`  focalLength: ${yamlStr(focal)}`);
  if (iso) exifLines.push(`  iso: ${iso}`);
  const frontmatter = [
    "---",
    `id: ${yamlStr(base)}`,
    `title: ""`, // 标题默认留空,命名由用户在 .md 里手动编辑
    `filename: ${yamlStr(name)}`,
    `date: "${date}"`,
    ...(featured ? [] : [`project: ${yamlStr(project)}`]),
    ...(exifLines.length && !featured ? ["exif:", ...exifLines] : []),
    "---",
    "",
  ].join("\n");
  await writeFile(path.join(outDir, `${base}.md`), frontmatter, "utf8");

  return {
    name,
    ok: true,
    compressed,
    origBytes,
    bytes: buf.length,
    url: upload?.secure_url ?? `https://res.cloudinary.com/${cloudinary.config().cloud_name}/image/upload/photos/${base}`,
  };
}

// ---------- 项目封面 / 首页 Hero / 精选标记 ----------

async function listFeatured() {
  const files = (await readdir(featuredDir)).filter((f) => f.endsWith(".md"));
  const list = await Promise.all(
    files.map(async (f) => {
      const fm = parseFrontmatter(await readFile(path.join(featuredDir, f), "utf8"));
      return { id: fm.id || path.basename(f, ".md"), ...fm, file: f };
    }),
  );
  return list.sort(byOrderThenDate);
}

// 把照片加入首页 Hero(生成 featured 数据文件;该照片已在 Hero 中则跳过,照片本体不动)
async function addHero(filename) {
  const base = path.basename(filename, path.extname(filename));
  const file = path.join(featuredDir, `${base}.md`);
  // 去重不只看同名文件,还要按 id / filename 匹配既有条目(文件名与 id 可能不一致)
  if (await fileExists(file)) return { filename, ok: true, exists: true };
  if (await findFeaturedFile(base)) return { filename, ok: true, exists: true };
  let date = new Date().toISOString().slice(0, 10);
  const ph = (await listPhotos()).find((p) => p.filename === filename);
  if (ph?.date) date = ph.date;
  // 尺寸与主色顺带从照片条目带过来。缺了它们,首页 Hero 这张图既没有 srcset,
  // 也没有 aspect-ratio 预留空间,加载时会明显跳一下。老条目是 backfill 脚本补的,
  // 新加的条目不该再欠这一笔人工账。
  const lines = [
    "---",
    `id: ${yamlStr(base)}`,
    `title: ""`,
    `filename: ${yamlStr(filename)}`,
    `date: "${date}"`,
  ];
  if (ph?.width) lines.push(`width: ${ph.width}`);
  if (ph?.height) lines.push(`height: ${ph.height}`);
  if (ph?.color) lines.push(`color: "${ph.color}"`);
  lines.push("---", "");
  const frontmatter = lines.join("\n");
  await writeFile(file, frontmatter, "utf8");
  return { filename, ok: true, exists: false };
}

// 按 frontmatter id 匹配实际文件名删除(数据文件名不一定等于 id,如 hero-1.md 的 id 是 hero-cheng-ye)
async function findFeaturedFile(id) {
  const files = (await readdir(featuredDir)).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const fm = parseFrontmatter(await readFile(path.join(featuredDir, f), "utf8"));
    if ((fm.id || path.basename(f, ".md")) === id) return f;
  }
  return null;
}

async function removeHero(ids) {
  const results = [];
  for (const id of ids) {
    let removed = false;
    const f = await findFeaturedFile(id);
    if (f) {
      try {
        await unlink(path.join(featuredDir, f));
        removed = true;
      } catch {}
    }
    results.push({ id, removed });
  }
  return results;
}

// 设置项目封面:改写项目 .md 的 coverImage 行
async function setProjectCover(projectId, filename) {
  const proj = (await listProjects()).find((pr) => pr.id === projectId);
  if (!proj) throw new Error("项目不存在");
  const file = path.join(projectsDir, proj.file);
  const lines = (await readFile(file, "utf8")).split("\n");
  const i = lines.findIndex((l) => /^coverImage:\s*/.test(l));
  if (i >= 0) {
    lines[i] = `coverImage: ${yamlStr(filename)}`;
  } else {
    lines.splice(1, 0, `coverImage: ${yamlStr(filename)}`); // 插到 id 行后
  }
  await writeFile(file, lines.join("\n"), "utf8");
  return { projectId, filename };
}

// 精选标记开关:在照片 .md 里加/删 featured: true 行
async function setFeaturedFlag(ids, value) {
  const results = [];
  for (const id of ids) {
    const file = path.join(photosDir, `${id}.md`);
    let md;
    try {
      md = await readFile(file, "utf8");
    } catch {
      results.push({ id, ok: false });
      continue;
    }
    const lines = md.split("\n");
    const i = lines.findIndex((l) => /^featured:\s*/.test(l));
    if (value) {
      if (i < 0) {
        const j = lines.findIndex((l) => /^project:\s*/.test(l));
        lines.splice(j >= 0 ? j : lines.length, 0, "featured: true");
      } else {
        lines[i] = "featured: true";
      }
    } else if (i >= 0) {
      lines.splice(i, 1);
    }
    await writeFile(file, lines.join("\n"), "utf8");
    results.push({ id, ok: true });
  }
  return results;
}

// ---------- 回收站 / 删除项目 ----------

async function ensureTrashDir() {
  await mkdir(trashDir, { recursive: true });
}

// 回收站清单(按删除时间倒序)。目录不存在 = 还没删过东西,返回空数组。
async function listTrash() {
  let files;
  try {
    files = (await readdir(trashDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const list = await Promise.all(
    files.map(async (f) => {
      const full = path.join(trashDir, f);
      const fm = parseFrontmatter(await readFile(full, "utf8").catch(() => ""));
      const st = await stat(full).catch(() => null);
      return {
        file: f, // 回收站里的实际文件名(恢复/彻底删除都按它定位)
        id: fm.id || path.basename(f, ".md"),
        title: fm.title ?? "",
        filename: fm.filename ?? "",
        project: fm.project ?? "",
        featured: fm.featured === true,
        deletedAt: st ? st.mtime.toISOString() : "",
      };
    }),
  );
  return list.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

// 移入回收站:只搬移数据文件,不动 Cloudinary 资源(彻底删除时才清云端)。
// 联动清理首页 Hero 引用与项目封面引用,避免线上出现空引用。
async function trashPhotos(ids) {
  await ensureTrashDir();
  const index = await photoIndex();
  const results = [];
  for (const id of ids) {
    const ph = index.get(id);
    if (!ph) {
      results.push({ id, ok: false, error: "数据文件不存在" });
      continue;
    }
    const src = path.join(photosDir, ph.file);
    const md = await readFile(src, "utf8").catch(() => null);
    if (md === null) {
      results.push({ id, ok: false, error: "数据文件读取失败" });
      continue;
    }
    const fm = parseFrontmatter(md);
    const base = fm.filename ? String(fm.filename).replace(/\.[^.]+$/, "") : ph.id;

    // 回收站已有同名文件(删掉后又传了同名图再删):加时间戳后缀,不覆盖旧的
    let dest = path.join(trashDir, ph.file);
    if (await fileExists(dest)) {
      dest = path.join(trashDir, `${path.basename(ph.file, ".md")}-${Date.now()}.md`);
    }
    await rename(src, dest);

    // 联动①:该照片在首页 Hero 里 → 移除对应数据文件
    let heroRemoved = false;
    try {
      for (const f of (await readdir(featuredDir)).filter((x) => x.endsWith(".md"))) {
        const ffm = parseFrontmatter(await readFile(path.join(featuredDir, f), "utf8"));
        const fid = ffm.id || path.basename(f, ".md");
        const fbase = String(ffm.filename ?? "").replace(/\.[^.]+$/, "");
        if (fid === ph.id || fbase === base || fbase === ph.id) {
          await unlink(path.join(featuredDir, f)).catch(() => {});
          heroRemoved = true;
        }
      }
    } catch {}

    // 联动②:该照片是本项目封面 → 清空 coverImage,否则线上项目页破图
    let coverCleared = "";
    if (ph.project) {
      const proj = (await listProjects()).find((pr) => pr.id === ph.project);
      if (proj && String(proj.coverImage ?? "") === String(fm.filename ?? "__none__")) {
        const pf = path.join(projectsDir, proj.file);
        const out = editFrontmatter(await readFile(pf, "utf8"), { set: { coverImage: "" } });
        if (out !== null) {
          await writeFile(pf, out, "utf8");
          coverCleared = proj.id;
        }
      }
    }

    results.push({ id, ok: true, heroRemoved, coverCleared });
  }
  return results;
}

// 从回收站恢复:数据文件原样搬回(含 featured 等标记,即「恢复一切」)。
// 项目里已有同名 id 的数据文件时拒绝恢复 —— 绝不覆盖正在使用的文件。
async function restoreTrash(ids) {
  await ensureTrashDir();
  const list = await listTrash();
  const results = [];
  for (const id of ids) {
    const item = list.find((x) => x.id === id);
    if (!item) {
      results.push({ id, ok: false, error: "回收站里没有这条记录" });
      continue;
    }
    const dest = path.join(photosDir, `${id}.md`);
    if (await fileExists(dest)) {
      results.push({ id, ok: false, error: "项目里已有同名照片,请先处理后再恢复" });
      continue;
    }
    try {
      await rename(path.join(trashDir, item.file), dest);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

// 彻底删除:从回收站移除数据文件,可选连 Cloudinary 原图一起删。
// files 来自请求,一律 path.basename 归一化,杜绝 ../ 目录穿越。
async function purgeTrash(files, destroy) {
  const results = [];
  for (const f of files) {
    const name = path.basename(String(f));
    const full = path.join(trashDir, name);
    const md = await readFile(full, "utf8").catch(() => null);
    if (md === null) {
      results.push({ file: name, removed: false });
      continue;
    }
    const fm = parseFrontmatter(md);
    // public_id 从 filename 解析(数据文件名不一定等于 id)
    const publicId = fm.filename
      ? String(fm.filename).replace(/\.[^.]+$/, "")
      : (fm.id || path.basename(name, ".md"));
    await unlink(full).catch(() => {});
    let cloud = "skipped";
    if (destroy) {
      await ensureCloudinary();
      const r = await cloudinary.uploader
        .destroy(`photos/${publicId}`)
        .catch((e) => ({ result: errMessage(e) }));
      cloud = r.result; // "ok" / "not found" 均视为清理完成
    }
    results.push({ file: name, id: fm.id ?? "", removed: true, cloud });
  }
  return results;
}

async function deleteProject(id) {
  const proj = (await listProjects()).find((pr) => pr.id === id);
  if (!proj) throw new Error("项目不存在");
  const n = (await listPhotos()).filter((ph) => ph.project === id).length;
  if (n > 0) {
    throw new Error(`「${proj.title ?? id}」还有 ${n} 张照片,请先把照片移到其他项目或删除,再删项目`);
  }
  await unlink(path.join(projectsDir, proj.file));
  return { id };
}

// 推送上线:构建检查 → git add/commit → git push;无改动时跳过提交
// 提交说明经 -F 读 UTF-8 临时文件,避免 Windows cmd.exe 编码导致中文乱码
// 命令输出全部走文件重定向(不用 stdio 管道)—— Windows 上管道 + 子进程异常退出
// 会触发 libuv 崩溃("Assertion failed: UV_HANDLE_CLOSING"),文件重定向可完全绕开
async function pushToGithub(message) {
  const log = [];
  const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
  const cmdLog = path.join(os.tmpdir(), "admin-push.log");
  // 执行命令,输出写临时日志文件,返回 { code, lines }
  const runCmd = async (cmd) => {
    let code = 0;
    try {
      execSync(`${cmd} > "${cmdLog}" 2>&1`, {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (e) {
      code = typeof e.status === "number" ? e.status : 1;
    }
    const out = stripAnsi(await readFile(cmdLog, "utf8").catch(() => ""));
    return { code, lines: out.trim().split("\n").filter(Boolean) };
  };
  try {
    log.push("① 构建检查(npm run build)…");
    const b = await runCmd("npm run build");
    log.push(...b.lines.slice(-5).map((l) => "   " + l));
    if (b.code !== 0) {
      log.push("✗ 构建失败,已停止推送 —— 按上面报错修正后重试");
      return { ok: false, log };
    }
    log.push("② 提交改动(git add + commit)…");
    const msgFile = path.join(os.tmpdir(), "admin-commit-msg.txt");
    await writeFile(msgFile, String(message), "utf8");
    let c;
    try {
      c = await runCmd(`git add -A && git commit -F "${msgFile}"`);
    } finally {
      await unlink(msgFile).catch(() => {});
    }
    if (c.code !== 0) {
      if (c.lines.join("\n").includes("nothing to commit")) {
        log.push("   没有文件改动,跳过提交");
      } else {
        log.push(...c.lines.slice(-8).map((l) => "   " + l));
        log.push("✗ 提交失败,已停止推送");
        return { ok: false, log };
      }
    } else {
      log.push(...c.lines.slice(-3).map((l) => "   " + l));
    }
    log.push("③ 推送到 GitHub(git push)…");
    const p = await runCmd("git push");
    log.push(...p.lines.slice(-3).map((l) => "   " + l));
    if (p.code !== 0) {
      log.push("✗ 推送失败 —— 检查网络或 GitHub 凭据");
      return { ok: false, log };
    }
    log.push("✓ 已推送,Cloudflare Pages 正在自动部署(约 1-2 分钟)");
    return { ok: true, log };
  } catch (e) {
    log.push("执行出错:" + (e?.message ?? e));
    return { ok: false, log };
  }
}

// ---------- 信息编辑(照片 / 项目 / 站点) ----------
//
// 一律白名单键:后端只认这些字段,别的一概不写。
// id / filename / project 永远不可改 —— filename 关联 Cloudinary 的 public_id
// 与项目封面的匹配,改了等于重命名云端资源,站点上会集体破图。

const PHOTO_TEXT_KEYS = ["title", "alt", "location", "date"];
const EXIF_KEYS = ["camera", "lens", "focalLength", "aperture", "shutter", "iso"];
const PROJECT_TEXT_KEYS = ["title", "description", "date", "location", "coverImage"];
const SITE_KEYS = [
  "title", "description", "logo", "footerText", "icp",
  "socialXhs", "socialInstagram", "contactEmail",
];

// 单张编辑。collection = "photos"(默认)或 "featured"(首页 Hero 条目)
async function updatePhoto(id, fields, collection = "photos") {
  const isFeatured = collection === "featured";
  const list = await (isFeatured ? listFeatured() : listPhotos());
  const item = list.find((x) => x.id === id);
  if (!item) throw new Error("找不到这张照片的数据文件");

  const ops = { set: {}, unset: [] };
  for (const k of PHOTO_TEXT_KEYS) {
    if (!(k in fields)) continue;
    // date 在 photos 里是 schema 必填:清空要写 ""(引号空串),不能删行
    if (k === "date" && !isFeatured) {
      ops.set.date = String(fields[k] ?? "").trim();
      continue;
    }
    const v = String(fields[k] ?? "").trim();
    if (v) ops.set[k] = v;
    else ops.unset.push(k);
  }
  if (!isFeatured) {
    if ("tags" in fields) ops.set.tags = Array.isArray(fields.tags) ? fields.tags : [];
    // 灯箱是否展示拍摄参数:缺省(没有这一行)= 不显示。
    // 所以只有 true 才写入,取消勾选时删行而不是写 false —— 保持「老数据零差异」。
    if ("showExif" in fields) {
      if (fields.showExif === true) ops.set.showExif = true;
      else ops.unset.push("showExif");
    }
    const ex = fields.exif;
    if (ex && typeof ex === "object") {
      const exSet = {};
      for (const k of EXIF_KEYS) {
        if (!(k in ex)) continue;
        if (k === "iso") {
          const raw = ex.iso;
          if (raw === "" || raw === null || raw === undefined) {
            exSet.iso = ""; // 空 = 删掉该子键
            continue;
          }
          const n = Number(raw);
          if (Number.isNaN(n)) throw new Error("ISO 必须是数字");
          exSet.iso = n;
        } else {
          exSet[k] = String(ex[k] ?? "").trim();
        }
      }
      if (Object.keys(exSet).length) ops.exif = { set: exSet };
    }
  }

  const dir = isFeatured ? featuredDir : photosDir;
  const file = path.join(dir, item.file);
  const out = editFrontmatter(await readFile(file, "utf8"), ops);
  if (out === null) throw new Error("数据文件格式异常(缺少 frontmatter)");
  await writeFile(file, out, "utf8");
  return { id };
}

// 批量改标签 / 地点(set 语义 = 整体覆盖;tags 传空数组即清空)
async function batchUpdatePhotos(ids, set) {
  const index = await photoIndex();
  const hasTags = set && "tags" in set;
  const tags = hasTags && Array.isArray(set.tags) ? set.tags : [];
  const hasLoc = set && "location" in set;
  const loc = hasLoc ? String(set.location ?? "").trim() : "";
  // 拍摄参数开关:布尔值,不传 = 这些照片保持不变(所以是三态:不改 / 打开 / 关闭)
  const hasShowExif = set && "showExif" in set;
  const showExif = hasShowExif ? set.showExif === true : false;
  const results = [];
  for (const id of ids) {
    const ph = index.get(id);
    if (!ph) {
      results.push({ id, ok: false, error: "数据文件不存在" });
      continue;
    }
    const ops = { set: {}, unset: [] };
    if (hasTags) ops.set.tags = tags;
    if (hasLoc) {
      if (loc) ops.set.location = loc;
      else ops.unset.push("location");
    }
    if (hasShowExif) {
      if (showExif) ops.set.showExif = true;
      else ops.unset.push("showExif");
    }
    if (!Object.keys(ops.set).length && !ops.unset.length) {
      results.push({ id, ok: true });
      continue;
    }
    const file = path.join(photosDir, ph.file);
    const out = editFrontmatter(await readFile(file, "utf8"), ops);
    if (out === null) {
      results.push({ id, ok: false, error: "格式异常" });
      continue;
    }
    await writeFile(file, out, "utf8");
    results.push({ id, ok: true });
  }
  return results;
}

// 项目设置(含可见性)。visibility 留空 = 公开,此时删掉该行(公开是缺省值)
async function updateProject(id, fields) {
  const proj = (await listProjects()).find((pr) => pr.id === id);
  if (!proj) throw new Error("项目不存在");
  const ops = { set: {}, unset: [] };
  for (const k of PROJECT_TEXT_KEYS) {
    if (!(k in fields)) continue;
    const v = String(fields[k] ?? "").trim();
    // title / coverImage 在 schema 里必填:清空写 ""(引号空串),不删行
    if (k === "title" || k === "coverImage") {
      ops.set[k] = v;
      continue;
    }
    if (v) ops.set[k] = v;
    else ops.unset.push(k);
  }
  if ("visibility" in fields) {
    const v = String(fields.visibility ?? "").trim();
    if (!["public", "private", "draft", ""].includes(v)) throw new Error("可见性取值非法");
    if (v && v !== "public") ops.set.visibility = v;
    else ops.unset.push("visibility");
  }
  const file = path.join(projectsDir, proj.file);
  const out = editFrontmatter(await readFile(file, "utf8"), ops);
  if (out === null) throw new Error("项目文件格式异常(缺少 frontmatter)");
  await writeFile(file, out, "utf8");
  return { id };
}

// ---------- 拖拽排序:全量重写 order 1..n ----------
//
// orderedIds 是前端当前看到的完整顺序。与磁盘实际成员比对:
// 少传的(并发新增)补到末尾,多传的(已被删)忽略 —— 只重写局部 order
// 会立刻产生重叠值,所以必须整组重排。
async function applyOrder(kind, orderedIds, projectId) {
  let items, dir;
  if (kind === "project") {
    items = await listProjects();
    dir = projectsDir;
  } else if (kind === "hero") {
    items = await listFeatured();
    dir = featuredDir;
  } else {
    if (!projectId) throw new Error("缺少 projectId");
    items = (await listPhotos()).filter((p) => p.project === projectId);
    dir = photosDir;
  }
  const byId = new Map(items.map((x) => [x.id, x]));
  const seen = new Set();
  const finalIds = [];
  for (const id of orderedIds) {
    if (byId.has(id) && !seen.has(id)) {
      seen.add(id);
      finalIds.push(id);
    }
  }
  for (const x of items) if (!seen.has(x.id)) finalIds.push(x.id);

  const results = [];
  for (let i = 0; i < finalIds.length; i++) {
    const item = byId.get(finalIds[i]);
    const file = path.join(dir, item.file);
    const out = editFrontmatter(await readFile(file, "utf8"), { set: { order: i + 1 } });
    if (out === null) {
      results.push({ id: finalIds[i], ok: false });
      continue;
    }
    await writeFile(file, out, "utf8");
    results.push({ id: finalIds[i], ok: true });
  }
  return results;
}

// ---------- Git 状态 / 仪表盘 ----------

// 执行 git 命令:输出走文件重定向(Windows 上管道 + 子进程异常退出会触发
// libuv 崩溃,详见 pushToGithub 的注释),这是全仓库统一的调用姿势。
async function runGit(args) {
  const logFile = path.join(os.tmpdir(), "admin-git.log");
  let code = 0;
  try {
    execSync(`git ${args} > "${logFile}" 2>&1`, {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch (e) {
    code = typeof e.status === "number" ? e.status : 1;
  }
  const out = (await readFile(logFile, "utf8").catch(() => "")).replace(/\x1b\[[0-9;]*m/g, "");
  return { code, out };
}

async function gitStatus() {
  const st = await runGit("status --porcelain");
  // 只数行数、不解析文件名:中文名会被 core.quotepath 转义成八进制,解析没意义
  const changes = st.out.split("\n").filter((l) => l.trim()).length;
  // 分隔符必须避开 shell 元字符 —— execSync 走的是 shell,`--format=%h|%s` 里的 |
  // 会被当成管道,拿回来的就是垃圾。%x1f 是 ASCII 不可见分隔符,安全且不会出现在正文里
  const last = await runGit("log -1 --format=%h%x1f%cs%x1f%s");
  const [hash, date, subject] = (last.out.trim().split("\n")[0] ?? "").split("\x1f");
  return {
    changes,
    lastCommit: hash ? { hash, date: date ?? "", subject: subject ?? "" } : null,
  };
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else {
      const st = await stat(full).catch(() => null);
      if (st) total += st.size;
    }
  }
  return total;
}

async function dashboardStats() {
  const [photos, projects, featured, trash, git] = await Promise.all([
    listPhotos(), listProjects(), listFeatured(), listTrash(), gitStatus(),
  ]);
  // 本地图片:照片本体都在 Cloudinary,这里统计的是仓库里残留的本地图与待处理图
  const localBytes =
    (await dirSize(path.join(root, "..", "photos"))) + (await dirSize(path.join(root, "inbox")));
  let cloudBytes = null;
  let cloudCredits = null;
  try {
    await ensureCloudinary();
    const u = await cloudinary.api.usage();
    // Cloudinary usage 的字段名是 usage/limit/used_percent,storage.usage 是字节数
    cloudBytes = u?.storage?.usage ?? null;
    cloudCredits = u?.credits?.used_percent ?? null;
  } catch {}
  return {
    projects: projects.length,
    photos: photos.length,
    hero: featured.length,
    trash: trash.length,
    localBytes,
    cloudBytes,
    cloudCredits,
    lastPush: git.lastCommit,
    changes: git.changes,
  };
}

// ---------- 本机设置(上传配置) / 站点设置 ----------

const adminSettingsFile = path.join(adminDir, "settings.json");
const DEFAULT_ADMIN_SETTINGS = { autoCompress: true, compressThresholdMB: 10, autoWebp: false };

async function readAdminSettings() {
  try {
    return { ...DEFAULT_ADMIN_SETTINGS, ...JSON.parse(await readFile(adminSettingsFile, "utf8")) };
  } catch {
    return { ...DEFAULT_ADMIN_SETTINGS };
  }
}

async function writeAdminSettings(patch) {
  const next = { ...(await readAdminSettings()) };
  if ("autoCompress" in patch) next.autoCompress = !!patch.autoCompress;
  if ("autoWebp" in patch) next.autoWebp = !!patch.autoWebp;
  if ("compressThresholdMB" in patch) {
    const n = Number(patch.compressThresholdMB);
    if (!Number.isFinite(n) || n <= 0) throw new Error("压缩阈值必须是正数");
    next.compressThresholdMB = n;
  }
  await writeFile(adminSettingsFile, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

const siteFile = path.join(root, "src", "content", "site", "site.md");

async function readSiteSettings() {
  const md = await readFile(siteFile, "utf8").catch(() => null);
  const fm = md ? parseFrontmatter(md) : {};
  const out = {};
  for (const k of SITE_KEYS) out[k] = fm[k] ?? "";
  return out;
}

// 留空 = 删掉该行 → 站点回落到 src/config.ts 里的默认值
async function writeSiteSettings(patch) {
  let md = await readFile(siteFile, "utf8").catch(() => null);
  if (md === null) md = "---\n---\n";
  const ops = { set: {}, unset: [] };
  for (const k of SITE_KEYS) {
    if (!(k in patch)) continue;
    const v = String(patch[k] ?? "").trim();
    if (v) ops.set[k] = v;
    else ops.unset.push(k);
  }
  const out = editFrontmatter(md, ops);
  if (out === null) throw new Error("site.md 格式异常(缺少 frontmatter)");
  await mkdir(path.dirname(siteFile), { recursive: true });
  await writeFile(siteFile, out, "utf8");
  return readSiteSettings();
}

// ---------- HTTP 服务 ----------

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const MAX_BODY_BYTES = 150 * 1024 * 1024; // 批量上传整体上限(base64 后约 110MB 原图)

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("上传内容过大(超过 150MB),请分批添加");
    }
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/api/config") {
      const env = await loadEnv();
      return json(res, 200, { cloudName: env.PUBLIC_CLOUDINARY_CLOUD_NAME ?? "" });
    }
    if (p === "/api/projects") {
      const photos = await listPhotos();
      const counts = {};
      for (const ph of photos) counts[ph.project] = (counts[ph.project] ?? 0) + 1;
      // listProjects 已按 order/date 排好序 —— 左侧列表的顺序即线上顺序
      const projects = (await listProjects()).map((pr) => ({
        id: pr.id,
        title: pr.title ?? "",
        description: pr.description ?? "",
        date: pr.date ?? "",
        location: pr.location ?? "",
        coverImage: pr.coverImage ?? "",
        visibility: pr.visibility ?? "public",
        order: typeof pr.order === "number" ? pr.order : null,
        count: counts[pr.id] ?? 0,
      }));
      return json(res, 200, projects);
    }
    if (p === "/api/photos") {
      return json(res, 200, await listPhotos());
    }
    if (p === "/api/move" && req.method === "POST") {
      const body = await readBody(req);
      const { photoIds = [], targetProject = "" } = body;
      if (!targetProject || !Array.isArray(photoIds)) {
        return json(res, 400, { error: "参数缺失:photoIds[] / targetProject" });
      }
      const results = await movePhotos(photoIds, targetProject);
      return json(res, 200, { results });
    }
    if (p === "/api/project" && req.method === "POST") {
      const body = await readBody(req);
      const title = String(body.title ?? "").trim();
      if (!title) return json(res, 400, { error: "项目标题不能为空" });
      // 统一小写:URL 大小写敏感,大写 id 会导致线上(Cloudflare)404
      const id = (String(body.id ?? "").trim() || (await autoId(title))).toLowerCase();
      if (!/^[a-zA-Z0-9-]+$/.test(id)) {
        return json(res, 400, { error: "项目 id 只能包含字母、数字和连字符" });
      }
      const created = await createProject({ id, title, ...body });
      return json(res, 200, created);
    }
    if (p === "/api/add-photo" && req.method === "POST") {
      const body = await readBody(req);
      const { files = [], project = "", featured = false } = body;
      if (!Array.isArray(files) || files.length === 0) {
        return json(res, 400, { error: "参数缺失:files[]" });
      }
      if (!featured && !project) {
        return json(res, 400, { error: "请指定归属项目(featured 或 project 二选一)" });
      }
      const results = [];
      for (const f of files) {
        if (!f?.name || !f?.data) {
          results.push({ name: f?.name ?? "?", ok: false, error: "缺少文件名或内容" });
          continue;
        }
        results.push(await addPhoto({ name: f.name, data: f.data, project, featured }));
      }
      return json(res, 200, { results });
    }
    if (p === "/api/featured") {
      if (req.method === "GET") return json(res, 200, await listFeatured());
      if (req.method === "POST") {
        const body = await readBody(req);
        const { files = [] } = body;
        if (!Array.isArray(files) || files.length === 0) {
          return json(res, 400, { error: "参数缺失:files[]" });
        }
        const results = [];
        for (const f of files) {
          if (f?.filename) results.push(await addHero(String(f.filename)));
        }
        return json(res, 200, { results });
      }
      if (req.method === "DELETE") {
        const body = await readBody(req);
        const { ids = [] } = body;
        if (!Array.isArray(ids) || ids.length === 0) {
          return json(res, 400, { error: "参数缺失:ids[]" });
        }
        return json(res, 200, { results: await removeHero(ids) });
      }
    }
    if (p === "/api/project-cover" && req.method === "POST") {
      const body = await readBody(req);
      const { projectId = "", filename = "" } = body;
      if (!projectId || !filename) {
        return json(res, 400, { error: "参数缺失:projectId / filename" });
      }
      return json(res, 200, await setProjectCover(projectId, filename));
    }
    if (p === "/api/featured-flag" && req.method === "POST") {
      const body = await readBody(req);
      const { ids = [], value = true } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return json(res, 400, { error: "参数缺失:ids[]" });
      }
      return json(res, 200, { results: await setFeaturedFlag(ids, value) });
    }
    if (p === "/api/photo" && req.method === "DELETE") {
      const body = await readBody(req);
      const { ids = [] } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return json(res, 400, { error: "参数缺失:ids[]" });
      }
      // 语义已变更:删除 = 移入回收站(云端原图保留),彻底删除走 /api/trash
      return json(res, 200, { results: await trashPhotos(ids) });
    }
    if (p === "/api/trash") {
      if (req.method === "GET") return json(res, 200, await listTrash());
      if (req.method === "DELETE") {
        const body = await readBody(req);
        const { files = [], destroy = true } = body;
        if (!Array.isArray(files) || files.length === 0) {
          return json(res, 400, { error: "参数缺失:files[]" });
        }
        return json(res, 200, { results: await purgeTrash(files, destroy) });
      }
    }
    if (p === "/api/trash-restore" && req.method === "POST") {
      const body = await readBody(req);
      const { ids = [] } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return json(res, 400, { error: "参数缺失:ids[]" });
      }
      return json(res, 200, { results: await restoreTrash(ids) });
    }
    if (p === "/api/project" && req.method === "DELETE") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      if (!id) return json(res, 400, { error: "缺少项目 id" });
      return json(res, 200, await deleteProject(id));
    }
    // ---------- 信息编辑 ----------
    if (p === "/api/photo" && req.method === "PUT") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      const collection = body.collection === "featured" ? "featured" : "photos";
      if (!id) return json(res, 400, { error: "缺少照片 id" });
      return json(res, 200, await updatePhoto(id, body, collection));
    }
    if (p === "/api/project" && req.method === "PUT") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      if (!id) return json(res, 400, { error: "缺少项目 id" });
      return json(res, 200, await updateProject(id, body));
    }
    if (p === "/api/photos-batch" && req.method === "POST") {
      const body = await readBody(req);
      const { ids = [], set = {} } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return json(res, 400, { error: "参数缺失:ids[]" });
      }
      if (
        !set ||
        typeof set !== "object" ||
        (!("tags" in set) && !("location" in set) && !("showExif" in set))
      ) {
        return json(res, 400, { error: "没有要修改的字段(支持 tags / location / showExif)" });
      }
      return json(res, 200, { results: await batchUpdatePhotos(ids, set) });
    }
    // ---------- 排序 ----------
    if (
      (p === "/api/photo-order" || p === "/api/project-order" || p === "/api/featured-order") &&
      req.method === "POST"
    ) {
      const body = await readBody(req);
      const { ids = [], orderedIds = [], projectId = "" } = body;
      const list = ids.length ? ids : orderedIds;
      if (!Array.isArray(list) || list.length === 0) {
        return json(res, 400, { error: "参数缺失:orderedIds[](完整有序 id 列表)" });
      }
      const kind =
        p === "/api/project-order" ? "project" : p === "/api/featured-order" ? "hero" : "photo";
      return json(res, 200, { results: await applyOrder(kind, list, projectId) });
    }
    // ---------- 设置 ----------
    if (p === "/api/admin-settings") {
      if (req.method === "GET") return json(res, 200, await readAdminSettings());
      if (req.method === "PUT") return json(res, 200, await writeAdminSettings(await readBody(req)));
    }
    if (p === "/api/site-settings") {
      if (req.method === "GET") return json(res, 200, await readSiteSettings());
      if (req.method === "PUT") return json(res, 200, await writeSiteSettings(await readBody(req)));
    }
    // ---------- 状态 ----------
    if (p === "/api/git-status") return json(res, 200, await gitStatus());
    if (p === "/api/dashboard") return json(res, 200, await dashboardStats());
    if (p === "/api/push" && req.method === "POST") {
      const body = await readBody(req);
      const message = String(body.message ?? "").trim() || "后台管理更新";
      const result = await pushToGithub(message);
      // 推送成功后带上 commit hash —— 前端 toast 要显示「已推送 a1b2c3d」
      if (result?.ok) {
        const after = await gitStatus();
        result.summary = { message, hash: after.lastCommit?.hash ?? "", changes: after.changes };
      }
      return json(res, 200, result);
    }
    // 静态页面(仅 / 一个页面)
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(path.join(adminDir, "index.html"), "utf8"));
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("请求出错:", e.message);
    json(res, 500, { error: e.message });
  }
});

await ensureTrashDir();

server.listen(PORT, HOST, () => {
  console.log(`\n  后台管理已启动(仅本机):http://${HOST}:${PORT}\n`);
  console.log("  - 拖拽/点选照片 → 移动到目标项目;\"新建项目\"按钮图形化建项目");
  console.log("  - 改动直接写入 src/content/*.md,完成后 git push 部署上线");
  console.log("  - 关闭服务:Ctrl+C\n");
});
