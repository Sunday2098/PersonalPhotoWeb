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
import { readdir, readFile, writeFile, access, unlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
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
  // 空串必须加引号,否则写成裸 `key: ` 会被 YAML 解析成 null(项目简介留空即此情况)
  if (s === "") return '""';
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

// ---------- 项目封面 / 首页 Hero / 精选标记 ----------

async function listFeatured() {
  const files = (await readdir(featuredDir)).filter((f) => f.endsWith(".md"));
  return Promise.all(
    files.map(async (f) => {
      const fm = parseFrontmatter(await readFile(path.join(featuredDir, f), "utf8"));
      return { id: fm.id ?? path.basename(f, ".md"), ...fm };
    }),
  );
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
  const frontmatter = [
    "---",
    `id: ${yamlStr(base)}`,
    `title: ""`,
    `filename: ${yamlStr(filename)}`,
    `date: "${date}"`,
    "---",
    "",
  ].join("\n");
  await writeFile(file, frontmatter, "utf8");
  return { filename, ok: true, exists: false };
}

// 按 frontmatter id 匹配实际文件名删除(数据文件名不一定等于 id,如 hero-1.md 的 id 是 hero-cheng-ye)
async function findFeaturedFile(id) {
  const files = (await readdir(featuredDir)).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const fm = parseFrontmatter(await readFile(path.join(featuredDir, f), "utf8"));
    if ((fm.id ?? path.basename(f, ".md")) === id) return f;
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

// ---------- 删除照片 / 删除项目 ----------

// 删除照片:删 .md(可选连同 Cloudinary 资源一起删,public_id 从 filename 解析)
async function deletePhotos(ids, destroy) {
  const results = [];
  for (const id of ids) {
    const file = path.join(photosDir, `${id}.md`);
    // 先读 filename 用于删除云端资源(个别数据文件的 id 与文件名不完全一致)
    let publicId = id;
    try {
      const fm = parseFrontmatter(await readFile(file, "utf8"));
      if (fm.filename) publicId = String(fm.filename).replace(/\.[^.]+$/, "");
    } catch {}
    let removed = false;
    try {
      await unlink(file);
      removed = true;
    } catch {}
    // 联动清理:该照片若在首页 Hero 里,按 id 或 filename 匹配并移除对应数据文件
    try {
      const feFiles = (await readdir(featuredDir)).filter((f) => f.endsWith(".md"));
      for (const f of feFiles) {
        const fm = parseFrontmatter(await readFile(path.join(featuredDir, f), "utf8"));
        const fmid = fm.id ?? path.basename(f, ".md");
        const fbase = String(fm.filename ?? "").replace(/\.[^.]+$/, "");
        if (fmid === id || fbase === id || fbase === publicId) {
          await unlink(path.join(featuredDir, f)).catch(() => {});
        }
      }
    } catch {}
    let cloud = "skipped";
    if (destroy && removed) {
      await ensureCloudinary();
      const r = await cloudinary.uploader
        .destroy(`photos/${publicId}`)
        .catch((e) => ({ result: errMessage(e) }));
      cloud = r.result; // "ok" / "not found" 均视为清理完成
    }
    results.push({ id, removed, cloud });
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
      const { ids = [], destroy = true } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return json(res, 400, { error: "参数缺失:ids[]" });
      }
      return json(res, 200, { results: await deletePhotos(ids, destroy) });
    }
    if (p === "/api/project" && req.method === "DELETE") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      if (!id) return json(res, 400, { error: "缺少项目 id" });
      return json(res, 200, await deleteProject(id));
    }
    if (p === "/api/push" && req.method === "POST") {
      const body = await readBody(req);
      const message = String(body.message ?? "").trim() || "后台管理更新";
      return json(res, 200, await pushToGithub(message));
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
