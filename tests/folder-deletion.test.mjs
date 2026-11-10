import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 合成库，不碰用户笔记。覆盖空目录、嵌套非空、乱序、重复/ENOENT、断线重连、
// 旧修改不复活、未同步文件不被强删、EPERM 不算成功。

const root = path.resolve(import.meta.dirname, "..");
const logs = [];

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

class TFolder {
    constructor(folderPath, children = []) {
        this.path = folderPath;
        this.children = children;
        this.parent = null;
    }
}
class TFile {
    constructor(filePath) {
        this.path = filePath;
        this.parent = null;
        this.stat = { mtime: 1, size: 1, ctime: 1 };
    }
}

const obsidian = {
    TFolder,
    TFile,
    TAbstractFile: class {},
    normalizePath: (value) => String(value).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, ""),
    Notice: class { setMessage() {} hide() {} },
    Platform: { isMobile: false, isDesktop: true },
    App: class {},
    Menu: class {},
    MenuItem: class {},
};

const helpers = {
    hashContent: (value) => `h:${value}`,
    hashContentAsync: async (value) => `h:${value}`,
    hashArrayBuffer: () => "hab",
    hashFileAsync: async () => "hf",
    dump: () => undefined,
    dumpError: () => undefined,
    isFolderSyncPathExcluded: (candidate) => String(candidate).startsWith(".obsidian"),
    isPathExcluded: (candidate) => String(candidate).startsWith(".obsidian"),
    vaultDelete: async (vault, file, force) => vault.delete(file, force),
    checkAndNotifyCaseConflict: () => false,
    getPluginDir: () => ".obsidian/plugins/fast-note-sync",
    getSafeCtime: () => 1,
    sleep: async () => undefined,
    debounce: (fn) => fn,
    showSyncNotice: () => undefined,
    isLargeBinarySyncRisk: () => false,
    describeBinarySyncLimit: () => "",
    logMemorySnapshot: () => undefined,
    LocalStateFileMirror: class {
        scheduleWrite() {}
        flush() {}
        async read() { return null; }
    },
};

const syncLog = {
    SyncLogManager: {
        getInstance: () => ({
            addLog: (...args) => logs.push(args),
        }),
    },
};

function load(relPath, requireStub) {
    const module = { exports: {} };
    vm.runInNewContext(transpile(relPath), {
        require: requireStub,
        module,
        exports: module.exports,
        console,
        window: { setTimeout, clearTimeout },
        setTimeout,
        clearTimeout,
        Date,
    });
    return module.exports;
}

const deletionRequire = (id) => {
    if (id === "obsidian") return obsidian;
    if (id === "../utils/helpers") return helpers;
    if (id === "./sync_log_manager") return syncLog;
    if (id === "../../main") return {};
    throw new Error(`unexpected require in folder_deletion: ${id}`);
};
const deletion = load("src/lib/sync/folder_deletion.ts", deletionRequire);

const sentDeletes = [];
const operatorRequire = (id) => {
    if (id === "obsidian") return obsidian;
    if (id === "../utils/types") return {};
    if (id === "../utils/helpers") return helpers;
    if (id === "./sync_log_manager") return syncLog;
    if (id === "./folder_deletion") return deletion;
    if (id === "./operator_note") return {
        noteDeleteByPath: async (filePath) => sentDeletes.push({ action: "NoteDelete", path: filePath }),
    };
    if (id === "./operator_file") return {
        fileDeleteByPath: async (filePath) => sentDeletes.push({ action: "FileDelete", path: filePath }),
    };
    if (id === "../../main") return {};
    throw new Error(`unexpected require in operator_folder: ${id}`);
};
const folderOps = load("src/lib/sync/operator_folder.ts", operatorRequire);

const noteRequire = (id) => {
    if (id === "obsidian") return obsidian;
    if (id === "../utils/types") return {};
    if (id === "../utils/helpers") return helpers;
    if (id === "./folder_deletion") return deletion;
    if (id === "./sync_log_manager") return syncLog;
    if (id === "../../main") return {};
    throw new Error(`unexpected require in operator_note: ${id}`);
};
const noteOps = load("src/lib/sync/operator_note.ts", noteRequire);

const fileRequire = (id) => {
    if (id === "obsidian") return obsidian;
    if (id === "../utils/types") return {};
    if (id === "../utils/helpers") return helpers;
    if (id === "./folder_deletion") return deletion;
    if (id === "../storage/file_cloud_preview") return { FileCloudPreview: { isRestrictedType: () => false } };
    if (id === "./sync_log_manager") return syncLog;
    if (id === "../api/http_api_service") return { HttpApiService: class {} };
    if (id === "../../main") return {};
    throw new Error(`unexpected require in operator_file: ${id}`);
};
const fileOps = load("src/lib/sync/operator_file.ts", fileRequire);

const snapshotRequire = (id) => {
    if (id === "obsidian") return obsidian;
    if (id === "../utils/helpers") return helpers;
    if (id === "../sync/folder_deletion") return deletion;
    if (id === "../../main") return {};
    throw new Error(`unexpected require in folder_snapshot_manager: ${id}`);
};
const snapshotMod = load("src/lib/storage/folder_snapshot_manager.ts", snapshotRequire);

function makeVault(deleteImpl) {
    const nodes = new Map();
    const calls = [];
    const vault = {
        getAbstractFileByPath: (candidate) => nodes.get(candidate) ?? null,
        getFileByPath: (candidate) => {
            const node = nodes.get(candidate);
            return node instanceof TFile ? node : null;
        },
        getFolderByPath: (candidate) => {
            const node = nodes.get(candidate);
            return node instanceof TFolder ? node : null;
        },
        getAllLoadedFiles: () => [...nodes.values()],
        create: async (candidate) => {
            calls.push({ op: "create", path: candidate });
            const file = new TFile(candidate);
            nodes.set(candidate, file);
            return file;
        },
        createFolder: async (candidate) => {
            calls.push({ op: "createFolder", path: candidate });
            if (nodes.has(candidate)) return nodes.get(candidate);
            const folder = new TFolder(candidate, []);
            nodes.set(candidate, folder);
            const parentPath = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : "";
            const parent = parentPath ? nodes.get(parentPath) : null;
            if (parent instanceof TFolder) {
                folder.parent = parent;
                parent.children.push(folder);
            }
            return folder;
        },
        delete: async (file, force) => {
            calls.push({ op: "delete", path: file.path, force: force === true });
            if (force === true) throw new Error(`unexpected force delete ${file.path}`);
            if (deleteImpl) return deleteImpl(file, calls);
            if (!nodes.has(file.path)) {
                const error = new Error(`ENOENT: no such file or directory, lstat '${file.path}'`);
                error.code = "ENOENT";
                throw error;
            }
            nodes.delete(file.path);
            if (file.parent instanceof TFolder) {
                file.parent.children = file.parent.children.filter((child) => child !== file);
            }
        },
    };
    function addFolder(folderPath) {
        const folder = new TFolder(folderPath, []);
        nodes.set(folderPath, folder);
        const parentPath = folderPath.includes("/") ? folderPath.slice(0, folderPath.lastIndexOf("/")) : "";
        const parent = parentPath ? nodes.get(parentPath) : null;
        if (parent instanceof TFolder) {
            folder.parent = parent;
            parent.children.push(folder);
        }
        return folder;
    }
    function addFile(filePath) {
        const file = new TFile(filePath);
        nodes.set(filePath, file);
        const parentPath = filePath.slice(0, filePath.lastIndexOf("/"));
        const parent = nodes.get(parentPath);
        if (parent instanceof TFolder) {
            file.parent = parent;
            parent.children.push(file);
        }
        return file;
    }
    return { nodes, vault, calls, addFolder, addFile };
}

function makePlugin(vault, options = {}) {
    const snapshot = new Map(options.folders ?? []);
    const hashes = new Map(options.hashes ?? []);
    return {
        settings: {
            syncEnabled: true,
            readonlySyncEnabled: false,
            offlineDeleteSyncEnabled: true,
            vault: "synthetic",
            cloudPreviewEnabled: false,
            ...(options.settings ?? {}),
        },
        app: {
            vault: vault.vault,
            loadLocalStorage: () => null,
            saveLocalStorage: () => undefined,
        },
        lockManager: {
            async withLock(_key, task) {
                return await task();
            },
        },
        addIgnoredFile() {},
        removeIgnoredFile() {},
        isIgnoredFile: () => false,
        lastSyncPathDeleted: new Set(),
        lastSyncPathRenamed: new Set(),
        lastSyncMtime: new Map(),
        folderSnapshotManager: {
            getMtime: (candidate) => snapshot.has(candidate) ? snapshot.get(candidate) : null,
            getAllPaths: () => [...snapshot.keys()],
            removeFolder: (candidate) => snapshot.delete(candidate),
            setFolderMtime: (candidate, mtime) => snapshot.set(candidate, mtime),
            snapshot,
        },
        fileHashManager: {
            getPathHash: (candidate) => hashes.has(candidate) ? hashes.get(candidate) : null,
            getAllPaths: () => [...hashes.keys()],
            removeFileHash: (candidate) => hashes.delete(candidate),
            hashes,
        },
        pendingNoteModifies: new Map(options.pendingNotes ?? []),
        pendingUploadHashes: new Map(options.pendingFiles ?? []),
        folderSyncTasks: { failed: 0 },
        noteSyncTasks: { failed: 0 },
        fileSyncTasks: { failed: 0 },
        localStorageManager: {
            meta: { lastFolderSyncTime: 0, lastNoteSyncTime: 0, lastFileSyncTime: 0, isInitSync: false },
            getMetadata(key) { return this.meta[key]; },
            setMetadata(key, value) { this.meta[key] = value; },
            savePending() {},
        },
        recordSyncCompleted() {},
        websocket: {
            async SendMessage(action, data, _before, after) {
                sentDeletes.push({ action, path: data.path });
                after?.();
            },
        },
    };
}

function errno(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function test(name, fn) {
    logs.length = 0;
    sentDeletes.length = 0;
    try {
        await fn();
        console.log(`ok  ${name}`);
    } catch (error) {
        console.error(`FAIL ${name}`);
        throw error;
    }
}

await test("空目录在线删除", async () => {
    const vault = makeVault();
    vault.addFolder("empty");
    const plugin = makePlugin(vault, { folders: [["empty", 1]] });
    const result = await deletion.applyRemoteFolderDelete(plugin, { path: "empty", lastTime: 50 });
    assert.equal(result.status, "applied");
    assert.equal(vault.nodes.has("empty"), false);
    assert.equal(plugin.folderSyncTasks.failed, 0);
    assert.equal(plugin.folderSnapshotManager.getMtime("empty"), null);
    assert.equal(vault.calls.some((call) => call.force), false);
});

await test("已同步的空子目录随父目录一起删除", async () => {
    const vault = makeVault();
    vault.addFolder("proj");
    vault.addFolder("proj/old");
    const plugin = makePlugin(vault, { folders: [["proj", 1], ["proj/old", 1]] });
    const result = await deletion.applyRemoteFolderDelete(plugin, { path: "proj", lastTime: 80 });
    assert.equal(result.status, "applied");
    assert.equal(vault.nodes.has("proj"), false);
    assert.equal(vault.nodes.has("proj/old"), false);
    assert.equal(plugin.folderSyncTasks.failed, 0);
});

await test("嵌套非空目录乱序删除后整棵消失", async () => {
    const orders = [
        ["root", "sub", "file"],
        ["file", "sub", "root"],
        ["root", "file", "sub"],
        ["sub", "file", "root"],
        ["file", "root"],
    ];
    for (const order of orders) {
        const vault = makeVault();
        vault.addFolder("proj");
        vault.addFolder("proj/sub");
        vault.addFile("proj/sub/a.md");
        const plugin = makePlugin(vault, {
            folders: [["proj", 1], ["proj/sub", 1]],
            hashes: [["proj/sub/a.md", "hash-a"]],
        });
        for (const step of order) {
            if (step === "root") await deletion.applyRemoteFolderDelete(plugin, { path: "proj", lastTime: 90 });
            if (step === "sub") await deletion.applyRemoteFolderDelete(plugin, { path: "proj/sub", lastTime: 90 });
            if (step === "file") {
                const file = vault.nodes.get("proj/sub/a.md");
                await vault.vault.delete(file);
                await deletion.onRemoteDescendantRemoved(plugin, "proj/sub/a.md");
            }
        }
        assert.equal(vault.nodes.has("proj/sub/a.md"), false, order.join(">"));
        assert.equal(vault.nodes.has("proj/sub"), false, order.join(">"));
        assert.equal(vault.nodes.has("proj"), false, order.join(">"));
        assert.equal(plugin.folderSyncTasks.failed, 0, order.join(">"));
        assert.equal(vault.calls.some((call) => call.force), false, order.join(">"));
    }
});

await test("子文件还在时目录删除只挂起，笔记删除到达后补删", async () => {
    const vault = makeVault();
    vault.addFolder("box");
    vault.addFile("box/a.md");
    const plugin = makePlugin(vault, { folders: [["box", 1]], hashes: [["box/a.md", "hash-a"]] });
    const deferred = await folderOps.receiveFolderSyncDelete({ path: "box", lastTime: 100, pageIndex: 0 }, plugin);
    assert.equal(deferred, undefined);
    assert.equal(vault.nodes.has("box"), true);
    assert.equal(vault.nodes.has("box/a.md"), true);
    assert.equal(plugin.folderSyncTasks.failed, 0);
    assert.equal(deletion.shouldOmitFolderFromUpload(plugin, "box"), true);
    await noteOps.receiveNoteSyncDelete({ path: "box/a.md", lastTime: 100, pageIndex: 0 }, plugin);
    assert.equal(vault.nodes.has("box/a.md"), false);
    assert.equal(vault.nodes.has("box"), false);
    assert.equal(plugin.noteSyncTasks.failed, 0);
    assert.equal(plugin.folderSyncTasks.failed, 0);
});

await test("附件删除乱序后补上父目录", async () => {
    const vault = makeVault();
    vault.addFolder("pics");
    vault.addFile("pics/a.png");
    const plugin = makePlugin(vault, { folders: [["pics", 1]], hashes: [["pics/a.png", "hash-p"]] });
    await folderOps.receiveFolderSyncDelete({ path: "pics", lastTime: 110 }, plugin);
    assert.equal(vault.nodes.has("pics/a.png"), true);
    await fileOps.receiveFileSyncDelete({ path: "pics/a.png", lastTime: 110 }, plugin);
    assert.equal(vault.nodes.has("pics/a.png"), false);
    assert.equal(vault.nodes.has("pics"), false);
    assert.equal(plugin.fileSyncTasks.failed, 0);
});

await test("重复删除与 ENOENT 都是幂等成功", async () => {
    const vault = makeVault();
    vault.addFolder("once");
    const plugin = makePlugin(vault, { folders: [["once", 1]] });
    const first = await deletion.applyRemoteFolderDelete(plugin, { path: "once", lastTime: 5 });
    const second = await deletion.applyRemoteFolderDelete(plugin, { path: "once", lastTime: 5 });
    assert.equal(first.status, "applied");
    assert.equal(second.status, "applied");
    assert.equal(vault.calls.filter((call) => call.op === "delete").length, 1);
    assert.equal(plugin.folderSyncTasks.failed, 0);

    const ghost = makeVault(async (file) => {
        throw errno("ENOENT", `ENOENT: no such file or directory, lstat '${file.path}'`);
    });
    ghost.addFolder("gone");
    const ghostPlugin = makePlugin(ghost, { folders: [["gone", 1]] });
    const missing = await deletion.applyRemoteFolderDelete(ghostPlugin, { path: "gone", lastTime: 6 });
    assert.equal(missing.status, "applied");
    assert.equal(ghostPlugin.folderSyncTasks.failed, 0);
    assert.equal(logs.some((entry) => entry[3] === "error"), false);
    assert.equal(deletion.shouldOmitFolderFromUpload(ghostPlugin, "gone"), true);
});

await test("并发删除同一个空目录只删一次且不记失败", async () => {
    const vault = makeVault(async (file) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (!vault.nodes.has(file.path)) throw errno("ENOENT", "ENOENT");
        vault.nodes.delete(file.path);
        if (file.parent) file.parent.children = file.parent.children.filter((child) => child !== file);
    });
    vault.addFolder("race");
    const plugin = makePlugin(vault, { folders: [["race", 1]] });
    const [left, right] = await Promise.all([
        deletion.applyRemoteFolderDelete(plugin, { path: "race", lastTime: 7 }),
        deletion.applyRemoteFolderDelete(plugin, { path: "race", lastTime: 7 }),
    ]);
    assert.equal(left.status, "applied");
    assert.equal(right.status, "applied");
    assert.equal(vault.calls.length, 1);
    assert.equal(plugin.folderSyncTasks.failed, 0);
    assert.equal(vault.nodes.has("race"), false);
});

await test("断线重连后挂起的删除仍能在子项到达时完成", async () => {
    const vault = makeVault();
    vault.addFolder("offline");
    vault.addFile("offline/n.md");
    const plugin = makePlugin(vault, { folders: [["offline", 1]], hashes: [["offline/n.md", "h"]] });
    const first = await deletion.applyRemoteFolderDelete(plugin, { path: "offline", lastTime: 20 });
    assert.equal(first.status, "deferred");
    // 连接丢掉，插件实例还在，不另开一份删除状态
    const again = await deletion.applyRemoteFolderDelete(plugin, { path: "offline", lastTime: 20 });
    assert.equal(again.status, "deferred");
    assert.equal(vault.nodes.has("offline"), true);
    const file = vault.nodes.get("offline/n.md");
    await vault.vault.delete(file);
    await deletion.onRemoteDescendantRemoved(plugin, "offline/n.md");
    assert.equal(vault.nodes.has("offline"), false);
    assert.equal(plugin.folderSyncTasks.failed, 0);
});

await test("旧笔记推送不会把已删除目录建回来", async () => {
    const vault = makeVault();
    vault.addFolder("old");
    const plugin = makePlugin(vault, { folders: [["old", 1]] });
    plugin.fileHashManager.setFileHash = (filePath, hash) => plugin.fileHashManager.hashes.set(filePath, hash);
    await folderOps.receiveFolderSyncDelete({ path: "old", lastTime: 1000 }, plugin);
    assert.equal(vault.nodes.has("old"), false);
    await noteOps.receiveNoteSyncModify({
        path: "old/a.md",
        content: "stale",
        contentHash: "h",
        mtime: 500,
        ctime: 500,
        lastTime: 500,
    }, plugin);
    assert.equal(vault.nodes.has("old"), false);
    assert.equal(vault.nodes.has("old/a.md"), false);
    assert.equal(vault.calls.some((call) => call.op === "create" || call.op === "createFolder"), false);
});

await test("更旧的目录修改不能把已删除目录建回来", async () => {
    const vault = makeVault();
    vault.addFolder("old");
    const plugin = makePlugin(vault, { folders: [["old", 1]] });
    await folderOps.receiveFolderSyncDelete({ path: "old", lastTime: 1000 }, plugin);
    assert.equal(vault.nodes.has("old"), false);
    await folderOps.receiveFolderSyncModify({ path: "old", lastTime: 1000, mtime: 1000 }, plugin);
    await folderOps.receiveFolderSyncModify({ path: "old", lastTime: 500, mtime: 500 }, plugin);
    await folderOps.receiveFolderSyncModify({ path: "old" }, plugin);
    assert.equal(vault.nodes.has("old"), false);
    assert.equal(vault.calls.some((call) => call.op === "createFolder"), false);
    const future = Date.now() + 60_000;
    await folderOps.receiveFolderSyncModify({ path: "old", lastTime: future, mtime: future }, plugin);
    assert.equal(vault.nodes.has("old"), true);
});

await test("删除还挂着时，更新的修改也不取消删除", async () => {
    const vault = makeVault();
    vault.addFolder("pend");
    vault.addFile("pend/a.md");
    const plugin = makePlugin(vault, { folders: [["pend", 1]], hashes: [["pend/a.md", "h"]] });
    await deletion.applyRemoteFolderDelete(plugin, { path: "pend", lastTime: 30 });
    assert.equal(deletion.classifyRemoteFolderModify(plugin, "pend", Date.now() + 60_000), "ignore");
    const file = vault.nodes.get("pend/a.md");
    await vault.vault.delete(file);
    await deletion.onRemoteDescendantRemoved(plugin, "pend/a.md");
    assert.equal(vault.nodes.has("pend"), false);
});

await test("未同步文件挡住目录删除，且目录仍会上报", async () => {
    const vault = makeVault();
    vault.addFolder("keep");
    vault.addFile("keep/new.md");
    const plugin = makePlugin(vault, { folders: [["keep", 1]] });
    const result = await deletion.applyRemoteFolderDelete(plugin, { path: "keep", lastTime: 40 });
    assert.equal(result.status, "deferred");
    assert.equal(vault.nodes.has("keep/new.md"), true);
    assert.equal(vault.nodes.has("keep"), true);
    assert.equal(vault.calls.some((call) => call.op === "delete"), false);
    assert.equal(deletion.shouldOmitFolderFromUpload(plugin, "keep"), false);
    assert.equal(plugin.folderSyncTasks.failed, 0);
    assert.equal(logs.some((entry) => entry[1] === "FolderDeleteSkipped" && entry[3] === "cancelled"), true);
});

await test("有未确认本地修改的文件同样挡住删除", async () => {
    const vault = makeVault();
    vault.addFolder("edit");
    vault.addFile("edit/a.md");
    const plugin = makePlugin(vault, {
        folders: [["edit", 1]],
        hashes: [["edit/a.md", "h"]],
        pendingNotes: [["edit/a.md", "local"]],
    });
    const result = await deletion.applyRemoteFolderDelete(plugin, { path: "edit", lastTime: 41 });
    assert.equal(result.status, "deferred");
    assert.equal(vault.calls.some((call) => call.op === "delete"), false);
    assert.equal(deletion.shouldOmitFolderFromUpload(plugin, "edit"), false);
});

await test("未进快照的新建空目录挡住父目录删除", async () => {
    const vault = makeVault();
    vault.addFolder("parent");
    vault.addFolder("parent/fresh");
    const plugin = makePlugin(vault, { folders: [["parent", 1]] });
    const result = await deletion.applyRemoteFolderDelete(plugin, { path: "parent", lastTime: 42 });
    assert.equal(result.status, "deferred");
    assert.equal(vault.nodes.has("parent/fresh"), true);
    assert.equal(vault.nodes.has("parent"), true);
});

await test("已同步文件不会被目录删除强制清掉，腾空后才删目录", async () => {
    const vault = makeVault();
    vault.addFolder("wait");
    vault.addFile("wait/a.md");
    vault.addFile("wait/b.md");
    const plugin = makePlugin(vault, {
        folders: [["wait", 1]],
        hashes: [["wait/a.md", "ha"], ["wait/b.md", "hb"]],
    });
    const deferred = await deletion.applyRemoteFolderDelete(plugin, { path: "wait", lastTime: 43 });
    assert.equal(deferred.status, "deferred");
    assert.equal(deletion.shouldOmitFolderFromUpload(plugin, "wait"), true);
    assert.equal(vault.calls.some((call) => call.op === "delete"), false);
    const first = vault.nodes.get("wait/a.md");
    await vault.vault.delete(first);
    await deletion.onRemoteDescendantRemoved(plugin, "wait/a.md");
    assert.equal(vault.nodes.has("wait"), true);
    assert.equal(vault.nodes.has("wait/b.md"), true);
    const second = vault.nodes.get("wait/b.md");
    await vault.vault.delete(second);
    await deletion.onRemoteDescendantRemoved(plugin, "wait/b.md");
    assert.equal(vault.nodes.has("wait"), false);
});

await test("空目录 EPERM 可见且不报成功，重试一次仍失败就停下", async () => {
    let attempts = 0;
    const vault = makeVault(async () => {
        attempts += 1;
        throw errno("EPERM", "EPERM: operation not permitted, rmdir 'locked'");
    });
    vault.addFolder("locked");
    const plugin = makePlugin(vault, { folders: [["locked", 1]] });
    const result = await deletion.applyRemoteFolderDelete(plugin, { path: "locked", lastTime: 44 });
    assert.equal(result.status, "failed");
    assert.equal(attempts, 2);
    assert.equal(vault.nodes.has("locked"), true);
    assert.equal(plugin.folderSyncTasks.failed, 1);
    assert.equal(plugin.folderSnapshotManager.getMtime("locked"), 1);
    const errorLog = logs.find((entry) => entry[1] === "FolderDelete" && entry[3] === "error");
    assert.ok(errorLog, "missing error log");
    assert.match(String(errorLog[2]), /EPERM/);
    assert.equal(logs.some((entry) => entry[3] === "success"), false);
});

await test("瞬时 EPERM 重试成功后不记失败", async () => {
    let attempts = 0;
    const vault = makeVault(async (file) => {
        attempts += 1;
        if (attempts === 1) throw errno("EPERM", "EPERM: operation not permitted, rmdir 'flaky'");
        vault.nodes.delete(file.path);
    });
    vault.addFolder("flaky");
    const plugin = makePlugin(vault, { folders: [["flaky", 1]] });
    const result = await deletion.applyRemoteFolderDelete(plugin, { path: "flaky", lastTime: 45 });
    assert.equal(result.status, "applied");
    assert.equal(attempts, 2);
    assert.equal(plugin.folderSyncTasks.failed, 0);
    assert.equal(vault.nodes.has("flaky"), false);
    assert.equal(logs.some((entry) => entry[3] === "error"), false);
});

await test("非法路径不碰 vault", async () => {
    const vault = makeVault();
    vault.addFolder("safe");
    const plugin = makePlugin(vault);
    for (const bad of ["../etc/passwd", "a/../../b", "a//../b", "", ".", "foo/../bar"]) {
        const result = await deletion.applyRemoteFolderDelete(plugin, { path: bad, lastTime: 1 });
        assert.equal(result.status, "failed", bad);
    }
    // 前导斜杠在 Obsidian 里会收成库内相对路径，不能因此删到库外
    const inside = await deletion.applyRemoteFolderDelete(plugin, { path: "/etc/passwd", lastTime: 1 });
    assert.equal(inside.status, "applied");
    assert.equal(vault.calls.length, 0);
    assert.equal(vault.nodes.has("safe"), true);
});

await test("本地删目录时按深度发送子项，离线删除开着时保留快照", async () => {
    const vault = makeVault();
    const plugin = makePlugin(vault, {
        folders: [["proj", 1], ["proj/sub", 1], ["other", 1]],
        hashes: [["proj/sub/a.md", "h"], ["proj/pic.png", "p"], ["proj.md", "nope"], ["elsewhere/x.md", "z"]],
    });
    const folder = new TFolder("proj");
    await folderOps.folderDelete(folder, plugin, true);
    assert.deepEqual(sentDeletes.map((item) => `${item.action}:${item.path}`), [
        "NoteDelete:proj/sub/a.md",
        "FileDelete:proj/pic.png",
        "FolderDelete:proj/sub",
        "FolderDelete:proj",
    ]);
    assert.equal(plugin.folderSnapshotManager.getMtime("proj"), 1);
    assert.equal(plugin.folderSnapshotManager.getMtime("proj/sub"), 1);
});

await test("离线删除关闭时，文件夹删除发出后从快照去掉", async () => {
    const vault = makeVault();
    const plugin = makePlugin(vault, {
        settings: { offlineDeleteSyncEnabled: false },
        folders: [["solo", 1]],
    });
    await folderOps.folderDelete(new TFolder("solo"), plugin, true);
    assert.deepEqual(sentDeletes.map((item) => item.action), ["FolderDelete"]);
    assert.equal(plugin.folderSnapshotManager.getMtime("solo"), null);
});

await test("子项发送失败仍继续发送目录删除", async () => {
    const vault = makeVault();
    const plugin = makePlugin(vault, {
        folders: [["tree", 1]],
        hashes: [["tree/a.md", "h"]],
    });
    // operator_folder 用的是加载时的 noteDeleteByPath 桩。这里另载一份会抛错的桩。
    const failingRequire = (id) => {
        if (id === "./operator_note") return { noteDeleteByPath: async () => { throw new Error("note send failed"); } };
        return operatorRequire(id);
    };
    const failingOps = load("src/lib/sync/operator_folder.ts", failingRequire);
    await failingOps.folderDelete(new TFolder("tree"), plugin, true);
    assert.equal(sentDeletes.some((item) => item.action === "FolderDelete" && item.path === "tree"), true);
});

await test("快照对账在离线删除开启时保留已消失目录，关闭时去掉，排除路径始终去掉", async () => {
    function manager(offline) {
        const vault = makeVault();
        vault.addFolder("kept");
        const plugin = makePlugin(vault, { settings: { offlineDeleteSyncEnabled: offline } });
        plugin.app.vault.configDir = ".obsidian";
        plugin.app.vault.getName = () => "synthetic";
        const instance = new snapshotMod.FolderSnapshotManager(plugin);
        instance.setFolderMtime("kept", 1);
        instance.setFolderMtime("gone", 1);
        instance.setFolderMtime(".obsidian/cache", 1);
        instance.reconcileWithVault();
        return instance;
    }
    const kept = new Set(manager(true).getAllPaths());
    assert.equal(kept.has("kept"), true);
    assert.equal(kept.has("gone"), true);
    assert.equal(kept.has(".obsidian/cache"), false);
    const dropped = new Set(manager(false).getAllPaths());
    assert.equal(dropped.has("kept"), true);
    assert.equal(dropped.has("gone"), false);
});

await test("计划删除不带出树外路径", async () => {
    const ops = deletion.planLocalFolderTreeDelete(
        "proj",
        ["proj", "proj/sub", "proj-more", "../proj", "proj/../../etc"],
        ["proj/sub/a.md", "proj.md", "proj/pic.png", "other/a.md"],
    );
    assert.equal(
        [...ops].map((item) => `${item.kind}:${item.path}`).join("|"),
        "note:proj/sub/a.md|file:proj/pic.png|folder:proj/sub|folder:proj",
    );
    assert.equal(deletion.planLocalFolderTreeDelete("../x", [], []).length, 0);
});

console.log(`\n${"folder deletion tests passed"}`);
