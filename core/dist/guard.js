import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
/**
 * Commands the pipeline never runs, whatever the stage. Agents work locally;
 * publishing, pushing, destructive history/file operations and approving budget stay with the human.
 */
const GIT = String.raw `\bgit(\s+-{1,2}[\w-]+(\s+\S+)?)*\s+`; // tolerates `git -C dir push`, `git --no-pager push`
const DENY = [
    [/\bsudo\b|\bdoas\b/, "sudo is not allowed"],
    [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)[a-z]*\s+(\/|~|\$HOME|\.\.?)\/?\*?(\s|$)/i, "recursive delete of root/home/parent"],
    [new RegExp(GIT + "push\\b"), "pushing is left to the human"],
    [new RegExp(GIT + "reset\\s+--hard\\b"), "git reset --hard discards work"],
    [new RegExp(GIT + "clean\\s+-[a-z]*f", "i"), "git clean -f deletes untracked files"],
    [new RegExp(GIT + "(checkout|restore)\\s+(--\\s+)?\\.(\\s|$)"), "discarding all local changes"],
    [new RegExp(GIT + "branch\\s+-D\\b"), "force-deleting branches"],
    [new RegExp(GIT + "(commit|tag|rebase|merge|stash\\s+(drop|clear))\\b"), "version control is left to the human"],
    [/\b(npm|pnpm|yarn|bun)\b[^|;&\n]*\spublish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/, "publishing packages"],
    [/\bgh\s+(release|pr\s+(create|merge|close|edit)|repo\s+(create|delete|edit|rename)|api|workflow\s+run|secret|auth)\b/, "GitHub write operations are left to the human"],
    [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, "piping downloads into a shell"],
    [/\bmkfs\b|\bdd\s+if=/, "disk-level operations"],
    [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
    [/\bchmod\s+-R\s+777\b/, "world-writable permissions"],
    [/\bdocker\s+system\s+prune\b/, "docker system prune"],
    [/\b(kubectl|helm|terraform)\s+(apply|delete|destroy|install|upgrade)\b/, "infrastructure changes"],
    // The cost gate: only the human approves, and pipeline bookkeeping is not editable by agents.
    [/(\bsdlc-estimate\b|estimate\.js\b)[^|;&\n]*\s['"]?(approve|record)\b/, "approving budget or recording spend is reserved for the human/orchestrator"],
    [/approval\.key\b|\.config\/sdlc\b/, "the approval-signing key is off limits"],
];
const BOOKKEEPING = /\b(approval|actuals|plan)\.json\b|\bledger\.jsonl\b|\bsdlc\.config\.json\b/;
const PURE_READ = /^\s*(cat|head|tail|grep|rg|jq|wc|less|ls|stat)\b[^>]*$/;
/** Read-only stages may run only inspection commands. */
const READ_ONLY_ALLOW = /^\s*(git(\s+--no-pager)?\s+(status|log|diff|show|blame|ls-files|rev-parse|grep)\b|ls\b|cat\b|head\b|tail\b|wc\b|find\b|grep\b|rg\b|tree\b|pwd\b|echo\b|node\s+--version|npm\s+(ls|view|outdated)\b|(npx\s+--no-install\s+)?sdlc-estimate\s+(verify|status)\b)/;
/** Ways to write or execute from an otherwise harmless inspection command. */
const READ_ONLY_ESCAPES = [
    [/>/, "output redirection writes files"], // checked after removing harmless 2>&1 and >/dev/null forms
    [/<\(/, "process substitution"],
    [/(^|[^&])&([^&]|$)/, "background execution"],
    [/\$\(|`/, "command substitution"],
    [/\s--pre(-glob)?\b|\s-O\S*|--open-files-in-pager|--output\b|\bgit\s+(.*\s)?-c\s|\btree\b.*\s-o\b|--ext-diff|--textconv/, "flags that run commands or write files"],
    [/\bfind\b.*\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/, "find actions that modify or execute"],
    [/\btee\b|\bsed\s+-i|\bxargs\b/, "commands that write or execute"],
];
export function checkCommand(cmd, access, opts = {}) {
    for (const [re, reason] of DENY)
        if (re.test(cmd))
            return { allow: false, reason: `Blocked by SDLC guard: ${reason}` };
    if (BOOKKEEPING.test(cmd) && !cmd.split(/&&|\|\||;|\||\n/).every((p) => PURE_READ.test(p))) {
        return { allow: false, reason: "Blocked by SDLC guard: pipeline bookkeeping files (approval/plan/actuals/ledger/config) may only be read" };
    }
    if (access === "read-only") {
        const extra = (opts.readOnlyAllow ?? []).map((c) => c.trim()).filter(Boolean);
        const parts = cmd.split(/&&|\|\||;|\||\n/).map((p) => p.trim()).filter(Boolean);
        const allowed = (p) => READ_ONLY_ALLOW.test(p) || extra.some((c) => p === c || p.startsWith(c + " "));
        if (!parts.every(allowed)) {
            return { allow: false, reason: "Blocked by SDLC guard: this stage is read-only; only inspection commands (and the configured test commands) are allowed" };
        }
        const stripped = cmd.replace(/\s*(\d?&?>{1,2}\s*\/dev\/null|\d>&\d)/g, " ");
        for (const [re, reason] of READ_ONLY_ESCAPES) {
            if (re.test(stripped))
                return { allow: false, reason: `Blocked by SDLC guard: read-only stage — ${reason}` };
        }
    }
    return { allow: true };
}
/** Resolve symlinks of the deepest existing ancestor so links cannot point a write outside its checks. */
function realish(p) {
    let cur = p;
    const tail = [];
    while (!existsSync(cur) && dirname(cur) !== cur) {
        tail.unshift(basename(cur));
        cur = dirname(cur);
    }
    try {
        return join(realpathSync(cur), ...tail);
    }
    catch {
        return p;
    }
}
/** True when any path segment is `.git` (case-insensitive file systems treat .GIT as .git). */
function hasGitSegment(p) {
    return p.split(sep).some((seg) => seg.toLowerCase() === ".git");
}
function inside(child, parent) {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
/**
 * Where a stage may write.
 *  - Every stage: Markdown reports inside its own run directory; never the run's JSON bookkeeping,
 *    other runs, the ledger, .git, .env files, sdlc.config.json, or anything outside the repo.
 *  - Read-only stages: nothing else.
 *  - Write stages: the rest of the repository.
 */
export function checkWritePath(path, access, repoRoot, runDir) {
    const root = realish(resolve(repoRoot));
    const run = realish(resolve(runDir));
    const abs = realish(resolve(root, path));
    const deny = (why) => ({ allow: false, reason: `Blocked by SDLC guard: ${why}` });
    if (!inside(abs, root))
        return deny("writing outside the repository");
    if (inside(abs, run)) {
        return extname(abs).toLowerCase() === ".md" ? { allow: true } : deny("only Markdown reports may be written in the run directory");
    }
    // Everything else under the pipeline's state directory (other runs, ledger) is off limits.
    const stateDir = dirname(dirname(run)); // <repo>/.sdlc for the default ".sdlc/runs/<id>"
    if (inside(abs, dirname(run)) || (stateDir !== root && inside(abs, stateDir)))
        return deny("pipeline state is managed by the orchestrator");
    if (access === "read-only")
        return deny(`read-only stage may only write its report inside ${runDir}`);
    if (hasGitSegment(relative(root, abs)))
        return deny("writing into .git");
    if (/^\.env(\..*)?$/.test(basename(abs)))
        return deny(".env files hold secrets");
    if (basename(abs) === "sdlc.config.json" && dirname(abs) === root)
        return deny("the pipeline config is changed by the human");
    return { allow: true };
}
/**
 * Write rules for IDE sessions (Claude Code hook), where the stage is unknown:
 * stay in the repo, never touch .git/.env/config, and leave pipeline bookkeeping (JSON) to sdlc-estimate.
 */
export function checkWritePathIde(path, repoRoot, artifactsDir = ".sdlc/runs") {
    const root = realish(resolve(repoRoot));
    const abs = realish(resolve(root, path));
    const deny = (why) => ({ allow: false, reason: `Blocked by SDLC guard: ${why}` });
    if (!inside(abs, root))
        return deny("writing outside the repository");
    if (hasGitSegment(relative(root, abs)))
        return deny("writing into .git");
    if (/^\.env(\..*)?$/.test(basename(abs)))
        return deny(".env files hold secrets");
    if (basename(abs) === "sdlc.config.json" && dirname(abs) === root)
        return deny("the pipeline config is changed by the human");
    const state = resolve(root, dirname(artifactsDir));
    if (inside(abs, state) && extname(abs).toLowerCase() !== ".md")
        return deny("pipeline bookkeeping is written only by sdlc-estimate");
    return { allow: true };
}
/** Reads agents must not make (secrets). */
export function checkReadPath(path) {
    if (/approval\.key$|[\\/]\.config[\\/]sdlc([\\/]|$)/.test(path))
        return { allow: false, reason: "Blocked by SDLC guard: the approval-signing key is off limits" };
    return /^\.env(\..*)?$/.test(basename(path)) && !/\.(example|sample|template)$/.test(path)
        ? { allow: false, reason: "Blocked by SDLC guard: .env files hold secrets" }
        : { allow: true };
}
//# sourceMappingURL=guard.js.map