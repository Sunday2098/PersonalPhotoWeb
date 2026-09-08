// 本地后台管理服务(仅本机使用,不参与部署、不出现在摄影网站上)
//
// 用法:
//   npm run admin          # 启动后浏览器打开 http://127.0.0.1:8787
//
// 功能:
//   - 图形化把照片从一个项目移动到另一个项目(拖拽或点选)
//   - 图形化新建项目
//   - 直接改写 src/content/photos/*.md 与 src/content/projects/*.md,
//     改完照常用 git push 部署上线
//
// 安全:只监听 127.0.0.1,局域网/外网不可访问;无任何认证(本机即信任边界)。
import { readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const photosDir = path.join(root, "src", "content", "photos");
const projectsDir = path.join(root, "src", "content", "projects");
const adminDir = path.join(root, "admin");

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

// ---------- HTTP 服务 ----------

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
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
