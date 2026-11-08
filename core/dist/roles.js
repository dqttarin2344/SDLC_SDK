import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES_DIR } from "./config.js";
function parseFrontmatter(src) {
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
    if (!m)
        return { meta: {}, body: src };
    const meta = {};
    for (const line of m[1].split("\n")) {
        const i = line.indexOf(":");
        if (i > 0)
            meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { meta, body: m[2].trim() };
}
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
export function loadRole(name, dir = ROLES_DIR) {
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, `${name}.md`), "utf8"));
    return {
        name: meta.name ?? name,
        stage: meta.stage,
        title: meta.title ?? name,
        description: meta.description ?? "",
        claudeTools: list(meta["claude-tools"]),
        copilotTools: list(meta["copilot-tools"]),
        next: meta.next || undefined,
        back: meta.back || undefined,
        body,
    };
}
export function loadRoles(dir = ROLES_DIR) {
    return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => loadRole(f.replace(/\.md$/, ""), dir));
}
//# sourceMappingURL=roles.js.map