import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
const DEFAULT_IGNORE = [
    "node_modules", ".git", "dist", "build", "out", "target", ".next", ".nuxt", "coverage",
    ".venv", "venv", "__pycache__", ".idea", ".vscode", ".sdlc", "vendor", ".gradle", "bin", "obj",
];
const SOURCE_EXT = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript",
    ".py": "Python", ".java": "Java", ".kt": "Kotlin", ".go": "Go", ".rs": "Rust", ".cs": "C#",
    ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".scala": "Scala", ".c": "C", ".h": "C",
    ".cpp": "C++", ".hpp": "C++", ".vue": "Vue", ".svelte": "Svelte", ".dart": "Dart", ".sql": "SQL",
};
const TEXT_EXT = new Set([".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".scss", ".sh", ".gradle"]);
const TEST_PATTERN = /(^|[\\/])(tests?|__tests__|spec|e2e)([\\/]|$)|[._-](test|spec)\.[a-z]+$|_test\.(go|py)$|^test_.*\.py$/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 20_000;
/** Rough token estimate (≈4 chars/token for code and English). */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
export function scanRepo(root, extraIgnore = []) {
    const ignore = new Set([...DEFAULT_IGNORE, ...extraIgnore]);
    const stats = {
        root, files: 0, sourceFiles: 0, testFiles: 0, totalTokens: 0, languages: {}, hasTests: false,
    };
    const walk = (dir) => {
        if (stats.files >= MAX_FILES)
            return;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of entries) {
            if (ignore.has(name) || (name.startsWith(".") && name !== ".github"))
                continue;
            const full = join(dir, name);
            let st;
            try {
                st = statSync(full);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                walk(full);
                continue;
            }
            const ext = extname(name).toLowerCase();
            const lang = SOURCE_EXT[ext];
            if (!lang && !TEXT_EXT.has(ext))
                continue;
            if (st.size > MAX_FILE_BYTES)
                continue;
            stats.files++;
            stats.totalTokens += Math.ceil(st.size / 4);
            if (lang) {
                stats.sourceFiles++;
                stats.languages[lang] = (stats.languages[lang] ?? 0) + 1;
                if (TEST_PATTERN.test(relative(root, full)))
                    stats.testFiles++;
            }
        }
    };
    walk(root);
    stats.hasTests = stats.testFiles > 0;
    detectTooling(root, stats);
    return stats;
}
function detectTooling(root, stats) {
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
        stats.packageManager = existsSync(join(root, "pnpm-lock.yaml"))
            ? "pnpm"
            : existsSync(join(root, "yarn.lock"))
                ? "yarn"
                : "npm";
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
            if (pkg.scripts?.test)
                stats.detectedTestCommand = `${stats.packageManager} test`;
        }
        catch {
            /* ignore malformed package.json */
        }
    }
    else if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
        stats.packageManager = "pip";
        stats.detectedTestCommand = "pytest";
    }
    else if (existsSync(join(root, "go.mod"))) {
        stats.packageManager = "go";
        stats.detectedTestCommand = "go test ./...";
    }
    else if (existsSync(join(root, "pom.xml"))) {
        stats.packageManager = "maven";
        stats.detectedTestCommand = "mvn test";
    }
    else if (existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"))) {
        stats.packageManager = "gradle";
        stats.detectedTestCommand = "./gradlew test";
    }
}
//# sourceMappingURL=scanner.js.map