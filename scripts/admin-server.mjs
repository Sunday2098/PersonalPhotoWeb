// 本地后台管理服务(仅本机使用,不参与部署、不出现在摄影网站上)
//
// 用法:
//   npm run admin          # 启动后浏览器打开 http://127.0.0.1:8787
//
// 功能:
//   - 图形化把照片从一个项目移动到另一个项目(拖拽或点选)
//   - 图形化新建项目
//   - 图形化添加照片(上传前检测大小,>10MB 自动压缩;逻辑与 add-photos 一致)
//   - 直接改写 src/content/photos/*.md 与 src/content/projects/*.md,
//     改完照常用 git push 部署上线
//
// 安全:只监听 127.0.0.1,局域网/外网不可访问;无任何认证(本机即信任边界)。
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v2 as cloudinary } from "cloudinary";
import exifr from "exifr";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const photosDir = path.join(root, "src", "content", "photos");
const featuredDir = path.join(root, "src", "content", "featured");
const projectsDir = path.join(root, "src", "content", "projects");
const adminDir = path.join(root, "admin");

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

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^"|"$/g, "").replace(/^"/, "");
  }
  return out;
}

function yamlStr(v) {
  const s = String(v ?? "");
  return /[:#]\s|^\s|\s$|^[\d.:-]+$/.test(s) ? `"${s}"` : s;
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

async function listProjects() {
  const files = (await readdir(projectsDir)).filter((f) => f.endsWith(".md"));
  return Promise.all(
    files.map(async (f) => {
      const fm = parseFrontmatter(await readFile(path.join(projectsDir, f), "utf8"));
      return { ...fm, file: f };
    }),
  );
}

async function listPhotos() {
  const files = (await readdir(photosDir)).filter((f) => f.endsWith(".md"));
  return Promise.all(
    files.map(async (f) => {
      const fm = parseFrontmatter(await readFile(path.join(photosDir, f), "utf8"));
      return { id: fm.id ?? path.basename(f, ".md"), ...fm, file: f };
    }),
  );
}

// ---------- 写操作 ----------

// 移动照片:改写该 .md 的 project 行(缺失则补在 filename 行后),其余内容原样保留
async function movePhotos(photoIds, targetProject) {
  const results = [];
  for (const id of photoIds) {
    const file = path.join(photosDir, `${id}.md`);
    let md;
    try {
      md = await readFile(file, "utf8");
    } catch {
      results.push({ id, ok: false, error: "数据文件不存在" });
      continue;
    }
    const lines = md.split("\n");
    const i = lines.findIndex((l) => /^project:\s*/.test(l));
    if (i >= 0) {
      lines[i] = `project: ${yamlStr(targetProject)}`;
    } else {
      const j = lines.findIndex((l) => /^filename:\s*/.test(l));
      lines.splice(j >= 0 ? j + 1 : lines.length, 0, `project: ${yamlStr(targetProject)}`);
    }
    await writeFile(file, lines.join("\n"), "utf8");
    results.push({ id, ok: true });
  }
  return results;
}

// 新建项目:frontmatter 与现有项目 .md 同构,正文留占位
async function createProject({ id, title, description = "", date = "", location = "", coverImage = "" }) {
  const usedIds = new Set((await listProjects()).map((p) => p.id));
  if (usedIds.has(id)) throw new Error(`项目 id 已存在:${id}`);
  const frontmatter = [
    "---",
    `id: ${yamlStr(id)}`,
    `title: ${yamlStr(title)}`,
    `description: ${yamlStr(description)}`,
    `coverImage: ${coverImage ? yamlStr(coverImage) : '""'}`,
    `date: ${date ? yamlStr(date) : ""}`,
    `location: ${location ? yamlStr(location) : ""}`,
    "---",
    "",
    "(拍摄手记待补充)",
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
      const projects = (await listProjects()).map((pr) => ({
        id: pr.id,
        title: pr.title ?? "",
        description: pr.description ?? "",
        date: pr.date ?? "",
        location: pr.location ?? "",
        coverImage: pr.coverImage ?? "",
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
      const id = String(body.id ?? "").trim() || (await autoId(title));
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

server.listen(PORT, HOST, () => {
  console.log(`\n  后台管理已启动(仅本机):http://${HOST}:${PORT}\n`);
  console.log("  - 拖拽/点选照片 → 移动到目标项目;\"新建项目\"按钮图形化建项目");
  console.log("  - 改动直接写入 src/content/*.md,完成后 git push 部署上线");
  console.log("  - 关闭服务:Ctrl+C\n");
});
