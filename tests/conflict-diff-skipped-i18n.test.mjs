import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 回归：冲突弹窗使用的 ui.conflict.diff_skipped 必须是 $() 的合法键，
// 并且五种在用语言都有非空译文。缺键时 tsc 会让 pnpm build 失败。

const root = path.resolve(import.meta.dirname, "..");
const KEY = "ui.conflict.diff_skipped";

function transpile(relPath) {
    const sourcePath = path.join(root, relPath);
    const source = fs.readFileSync(sourcePath, "utf8");
    return ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        fileName: sourcePath,
    }).outputText;
}

function load(relPath, requireStub, extra = {}) {
    const module = { exports: {} };
    vm.runInNewContext(transpile(relPath), {
        require: requireStub,
        module,
        exports: module.exports,
        console,
        ...extra,
    });
    return module.exports;
}

const localeFiles = {
    en: "src/i18n/locales/en.ts",
    "zh-cn": "src/i18n/locales/zh-CN.ts",
    "zh-tw": "src/i18n/locales/zh-TW.ts",
    ja: "src/i18n/locales/ja.ts",
    ko: "src/i18n/locales/ko.ts",
};

const locales = {};
for (const [name, rel] of Object.entries(localeFiles)) {
    const loaded = load(rel, (id) => {
        throw new Error(`unexpected require in ${rel}: ${id}`);
    });
    locales[name] = loaded.default ?? loaded;
    const value = locales[name][KEY];
    assert.equal(typeof value, "string", `${name} missing ${KEY}`);
    assert.ok(value.trim().length > 0, `${name} ${KEY} is empty`);
}

assert.match(locales.en[KEY], /line-by-line diff was skipped/i);
assert.match(locales["zh-cn"][KEY], /已跳过逐行差异对比/);
assert.match(locales["zh-tw"][KEY], /已跳過逐行差異對比/);
assert.notEqual(locales.ja[KEY], locales.en[KEY]);
assert.notEqual(locales.ko[KEY], locales.en[KEY]);

function loadLang(localeName) {
    const requireStub = (id) => {
        if (id === "obsidian") return { moment: { locale: () => localeName } };
        if (id === "src/i18n/locales/en") return { __esModule: true, default: locales.en };
        if (id === "src/i18n/locales/zh-CN") return { __esModule: true, default: locales["zh-cn"] };
        if (id === "src/i18n/locales/zh-TW") return { __esModule: true, default: locales["zh-tw"] };
        if (id === "src/i18n/locales/ja") return { __esModule: true, default: locales.ja };
        if (id === "src/i18n/locales/ko") return { __esModule: true, default: locales.ko };
        throw new Error(`unexpected require in lang.ts: ${id}`);
    };
    return load("src/i18n/lang.ts", requireStub);
}

assert.equal(loadLang("en").$(KEY), locales.en[KEY]);
assert.equal(loadLang("zh-cn").$(KEY), locales["zh-cn"][KEY]);
assert.equal(loadLang("zh-tw").$(KEY), locales["zh-tw"][KEY]);
assert.equal(loadLang("ja").$(KEY), locales.ja[KEY]);
assert.equal(loadLang("ko").$(KEY), locales.ko[KEY]);
// 未收录的界面语言回退到英文，而不是把键名原样显示出来
assert.equal(loadLang("fr").$(KEY), locales.en[KEY]);

const modal = fs.readFileSync(path.join(root, "src/views/conflict-resolve-modal.ts"), "utf8");
assert.match(modal, /\$\("ui\.conflict\.diff_skipped"\)/);

console.log("ok  conflict diff_skipped i18n");
