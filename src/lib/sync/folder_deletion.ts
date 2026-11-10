import { TFile, TFolder } from "obsidian";

import { dump, dumpError, vaultDelete } from "../utils/helpers";
import { SyncLogManager } from "./sync_log_manager";
import type FastSync from "../../main";

/**
 * 文件夹删除的唯一收口。
 *
 * 调用方看到的结果只有三种：
 * - applied：路径已经不在库里（这次删掉，或本来就不在）。幂等，ENOENT 也算 applied。
 * - deferred：目录里还有不能强制删掉的内容，删除意图保留。这不是成功。
 * - failed：空目录遇到权限或其他 IO 错误。错误会写进同步日志，不报成功，意图保留。
 *
 * 不变量：
 * - 不删除 TFile，也不对仍有文件的目录做 force 递归删除。
 * - 尚未进入哈希表、或仍有未确认本地修改的文件，会挡住所在目录的删除。
 * - 同一插件实例上，同一个路径的删除串行执行；重复删除和已经不存在的路径不再计失败。
 * - 已应用的删除记一份墓碑（取服务端 lastTime 与本地应用时刻的较大值）。
 *   更旧或没有时间的 FolderSyncModify 不能把目录建回来。更新的修改才视为对方真的重建。
 * - 删除还挂着、且没有被未同步文件挡住时，扫描不要再把这个目录报成「本地仍存在」，
 *   否则服务端 UpdateOrCreate 会把已删除目录恢复并广播回来。
 *
 * 删除测试：去掉这个模块后，接收删除、笔记/附件删除之后的父目录重试、目录修改、
 * 上传扫描、快照对账都要各自处理「空/非空、ENOENT、EPERM、乱序、重复、旧修改复活」。
 */

export type FolderDeleteStatus = "applied" | "deferred" | "failed";

export interface FolderDeleteResult {
    status: FolderDeleteStatus;
    error?: unknown;
}

export interface LocalTreeDelete {
    path: string;
    kind: "note" | "file" | "folder";
}

interface PendingDelete {
    lastTime: number;
    /** 未同步文件挡住删除时为 true，扫描不能把目录藏起来 */
    blocked: boolean;
}

interface DeletionState {
    pending: Map<string, PendingDelete>;
    /** path -> 本地应用时刻（已与服务端 lastTime 取较大值） */
    tombstones: Map<string, number>;
    queues: Map<string, Promise<void>>;
}

const states = new WeakMap<object, DeletionState>();

function stateOf(plugin: object): DeletionState {
    let state = states.get(plugin);
    if (!state) {
        state = { pending: new Map(), tombstones: new Map(), queues: new Map() };
        states.set(plugin, state);
    }
    return state;
}

/**
 * 只接受库内相对路径。拒绝绝对路径、空段和 `..`，避免删除跑出 vault。
 */
export function safeVaultPath(path: string): string | null {
    if (typeof path !== "string") return null;
    const normalized = path.replace(/\\/g, "/").trim().replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!normalized || normalized === "." || normalized.includes("\0")) return null;
    const parts = normalized.split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
    return parts.join("/");
}

function parentOf(path: string): string | null {
    const index = path.lastIndexOf("/");
    return index < 0 ? null : path.slice(0, index);
}

function depthOf(path: string): number {
    return path.split("/").length;
}

function positiveTime(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    return 0;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") return true;
    const text = errorText(error);
    return text.includes("ENOENT") || text.includes("no such file or directory");
}

function isEperm(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    if (code === "EPERM" || code === "EACCES") return true;
    const text = errorText(error);
    return text.includes("EPERM") || text.includes("EACCES") || text.includes("operation not permitted");
}

function getFolder(plugin: FastSync, path: string): TFolder | null {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    return file instanceof TFolder ? file : null;
}

function isProtectedFile(plugin: FastSync, path: string): boolean {
    if (plugin.pendingNoteModifies?.has(path)) return true;
    if (plugin.pendingUploadHashes?.has(path)) return true;
    const hash = plugin.fileHashManager?.getPathHash(path);
    return hash == null || hash === "";
}

function isKnownFolder(plugin: FastSync, path: string): boolean {
    if (stateOf(plugin).pending.has(path)) return true;
    const mtime = plugin.folderSnapshotManager?.getMtime(path);
    return typeof mtime === "number";
}

type DiskOutcome = "ok" | "missing" | "not-empty" | "denied";

type InspectKind = "protected" | "waiting-files" | "deletable";

interface Inspect {
    kind: InspectKind;
    /** 已同步且为空的子孙目录，深的在前。不含根。 */
    emptyFolders: TFolder[];
}

function inspectFolder(plugin: FastSync, root: TFolder): Inspect {
    const emptyFolders: TFolder[] = [];

    const walk = (folder: TFolder, isRoot: boolean): InspectKind => {
        let waiting = false;
        for (const child of folder.children) {
            if (child instanceof TFolder) {
                const sub = walk(child, false);
                if (sub === "protected") return "protected";
                if (sub === "waiting-files") waiting = true;
            } else if (child instanceof TFile) {
                if (isProtectedFile(plugin, child.path)) return "protected";
                waiting = true;
            } else {
                return "protected";
            }
        }
        if (waiting) return "waiting-files";
        if (!isRoot) {
            if (!isKnownFolder(plugin, folder.path)) return "protected";
            emptyFolders.push(folder);
        }
        return "deletable";
    };

    const kind = walk(root, true);
    if (kind !== "deletable") return { kind, emptyFolders: [] };
    emptyFolders.sort((a, b) => depthOf(b.path) - depthOf(a.path) || a.path.localeCompare(b.path));
    return { kind, emptyFolders };
}

function rememberPending(plugin: FastSync, path: string, lastTime: number, blocked: boolean): void {
    const pending = stateOf(plugin).pending;
    const previous = pending.get(path);
    pending.set(path, {
        lastTime: Math.max(previous?.lastTime ?? 0, lastTime),
        blocked,
    });
}

function releaseSuppression(plugin: FastSync, path: string): void {
    plugin.removeIgnoredFile(path);
    plugin.lastSyncPathDeleted.delete(path);
}

async function deleteEmptyFolder(plugin: FastSync, folder: TFolder): Promise<{ outcome: DiskOutcome; error?: unknown }> {
    const attempt = async (): Promise<{ outcome: DiskOutcome; error?: unknown }> => {
        const current = getFolder(plugin, folder.path);
        if (!current) return { outcome: "missing" };
        if (current.children.length > 0) return { outcome: "not-empty" };
        plugin.lastSyncPathDeleted.add(current.path);
        plugin.addIgnoredFile(current.path);
        try {
            // force 保持默认 false：目录仍有子项时交给上面的检查延后，不做递归强删
            await vaultDelete(plugin.app.vault, current);
            window.setTimeout(() => releaseSuppression(plugin, current.path), 500);
            return { outcome: "ok" };
        } catch (error) {
            releaseSuppression(plugin, current.path);
            if (isEnoent(error)) return { outcome: "missing", error };
            if (isEperm(error)) {
                const after = getFolder(plugin, folder.path);
                if (!after) return { outcome: "missing", error };
                if (after.children.length > 0) return { outcome: "not-empty", error };
                return { outcome: "denied", error };
            }
            throw error;
        }
    };

    const first = await attempt();
    if (first.outcome !== "denied") return first;
    const after = getFolder(plugin, folder.path);
    if (!after) return { outcome: "missing" };
    if (after.children.length > 0) return { outcome: "not-empty" };
    return attempt();
}

function markApplied(plugin: FastSync, path: string, lastTime: number): void {
    const state = stateOf(plugin);
    state.pending.delete(path);
    const tomb = Math.max(lastTime, Date.now());
    const previous = state.tombstones.get(path) ?? 0;
    state.tombstones.set(path, Math.max(previous, tomb));
    plugin.folderSnapshotManager?.removeFolder(path);
    const stored = positiveTime(lastTime);
    if (stored && plugin.localStorageManager) {
        const current = Number(plugin.localStorageManager.getMetadata("lastFolderSyncTime") || 0);
        if (stored > current) plugin.localStorageManager.setMetadata("lastFolderSyncTime", stored);
    }
}

function reportFailure(plugin: FastSync, path: string, error: unknown): void {
    plugin.folderSyncTasks.failed++;
    const message = `目录删除失败: ${path}: ${errorText(error)}`;
    dumpError(`[FastSync] ${message}`);
    SyncLogManager.getInstance().addLog("receive", "FolderDelete", message, "error", path);
}

function reportDeferred(plugin: FastSync, path: string, blocked: boolean): void {
    const message = blocked
        ? `目录含未同步文件，跳过删除: ${path}`
        : `目录非空，跳过删除，等待子项删除: ${path}`;
    dump(`[FastSync] ${message}`);
    SyncLogManager.getInstance().addLog("receive", "FolderDeleteSkipped", message, "cancelled", path);
}

async function applyNow(plugin: FastSync, path: string, lastTime: number, reportSkip: boolean): Promise<FolderDeleteResult> {
    const folder = getFolder(plugin, path);
    if (!folder) {
        markApplied(plugin, path, lastTime);
        return { status: "applied" };
    }

    const inspected = inspectFolder(plugin, folder);
    if (inspected.kind === "protected") {
        rememberPending(plugin, path, lastTime, true);
        if (reportSkip) reportDeferred(plugin, path, true);
        return { status: "deferred" };
    }
    if (inspected.kind === "waiting-files") {
        rememberPending(plugin, path, lastTime, false);
        if (reportSkip) reportDeferred(plugin, path, false);
        return { status: "deferred" };
    }

    for (const child of inspected.emptyFolders) {
        const removed = await removeOrStop(plugin, child, path, lastTime, reportSkip);
        if (removed !== "continue") return removed;
        markApplied(plugin, child.path, lastTime);
    }

    const rootNow = getFolder(plugin, path);
    if (!rootNow) {
        markApplied(plugin, path, lastTime);
        return { status: "applied" };
    }
    if (rootNow.children.length > 0) {
        const again = inspectFolder(plugin, rootNow);
        rememberPending(plugin, path, lastTime, again.kind === "protected");
        if (reportSkip) reportDeferred(plugin, path, again.kind === "protected");
        return { status: "deferred" };
    }

    const removed = await removeOrStop(plugin, rootNow, path, lastTime, reportSkip);
    if (removed !== "continue") return removed;
    markApplied(plugin, path, lastTime);
    return { status: "applied" };
}

async function removeOrStop(plugin: FastSync, folder: TFolder, rootPath: string, lastTime: number, reportSkip: boolean): Promise<FolderDeleteResult | "continue"> {
    try {
        const deleted = await deleteEmptyFolder(plugin, folder);
        if (deleted.outcome === "not-empty") {
            const again = getFolder(plugin, rootPath);
            const blocked = again ? inspectFolder(plugin, again).kind === "protected" : false;
            rememberPending(plugin, rootPath, lastTime, blocked);
            if (reportSkip) reportDeferred(plugin, rootPath, blocked);
            return { status: "deferred" };
        }
        if (deleted.outcome === "denied") {
            const error = deleted.error ?? new Error(`EPERM: operation not permitted, rmdir ${folder.path}`);
            rememberPending(plugin, rootPath, lastTime, false);
            reportFailure(plugin, folder.path, error);
            return { status: "failed", error };
        }
        return "continue";
    } catch (error) {
        rememberPending(plugin, rootPath, lastTime, false);
        reportFailure(plugin, folder.path, error);
        return { status: "failed", error };
    }
}

function enqueue(plugin: FastSync, path: string, task: () => Promise<FolderDeleteResult>): Promise<FolderDeleteResult> {
    const queues = stateOf(plugin).queues;
    const previous = queues.get(path) ?? Promise.resolve();
    const run = previous.then(task, task);
    queues.set(path, run.then(() => undefined, () => undefined));
    return run;
}

/**
 * 应用一条远端目录删除。路径非法时失败且不碰 vault。
 * 同一个路径并发调用会串行，后一次看到前一次的结果。
 */
export function applyRemoteFolderDelete(plugin: FastSync, request: { path: string; lastTime?: number }, reportSkip = true): Promise<FolderDeleteResult> {
    const path = safeVaultPath(request.path);
    if (!path) {
        const error = new Error(`非法目录路径: ${String(request.path)}`);
        reportFailure(plugin, String(request.path), error);
        return Promise.resolve({ status: "failed", error });
    }
    const requested = positiveTime(request.lastTime);
    return enqueue(plugin, path, async () => {
        const pending = stateOf(plugin).pending.get(path);
        const lastTime = Math.max(requested, pending?.lastTime ?? 0);
        // 先挂上意图，子项删除的回调才能在这次检查还没写完时找到它并排队重试
        rememberPending(plugin, path, lastTime, pending?.blocked ?? false);
        const locked = await plugin.lockManager.withLock(
            path,
            () => applyNow(plugin, path, lastTime, reportSkip),
            { maxRetries: 10, retryInterval: 50 },
        );
        if (locked == null) {
            if (reportSkip) reportDeferred(plugin, path, pending?.blocked ?? false);
            return { status: "deferred" };
        }
        if (locked.status === "applied") await onRemoteDescendantRemoved(plugin, path);
        return locked;
    });
}

/**
 * 子文件或子目录已经不在了。从深到浅重试仍挂着的祖先删除。
 * 断线再连上时只要同一个插件实例还在，挂起的删除还在，子项到达后会补上。
 */
export async function onRemoteDescendantRemoved(plugin: FastSync, childPath: string): Promise<void> {
    const path = safeVaultPath(childPath);
    if (!path) return;
    const pending = stateOf(plugin).pending;
    const ancestors: string[] = [];
    for (let cursor = parentOf(path); cursor; cursor = parentOf(cursor)) {
        if (pending.has(cursor)) ancestors.push(cursor);
    }
    for (const ancestor of ancestors) {
        const entry = pending.get(ancestor);
        if (!entry) continue;
        await applyRemoteFolderDelete(plugin, { path: ancestor, lastTime: entry.lastTime }, false);
    }
}

/**
 * 旧的或没有时间戳的目录修改不能复活已删除目录。
 * 删除意图还挂着时，修改也不取消这次删除（避免服务端把目录恢复后又被当成重建）。
 * 已应用之后，只有严格新于墓碑时间的修改才算对方真的重建。
 */
export function classifyRemoteFolderModify(plugin: FastSync, path: string, lastTime?: number): "apply" | "ignore" {
    const safe = safeVaultPath(path);
    if (!safe) return "ignore";
    const state = stateOf(plugin);
    const incoming = positiveTime(lastTime);
    let cursor: string | null = safe;
    let isSelf = true;
    while (cursor) {
        if (state.pending.has(cursor)) return "ignore";
        const tomb = state.tombstones.get(cursor);
        if (tomb !== undefined) {
            // 祖先还记着删除时，子路径的修改会把父目录一并建回来
            if (!isSelf) return "ignore";
            if (incoming <= tomb) return "ignore";
        }
        isSelf = false;
        cursor = parentOf(cursor);
    }
    return "apply";
}

/** 这次目录修改被接受，或用户在本地又建回了目录。清掉本路径和祖先上的删除记忆。 */
export function clearFolderDeletionState(plugin: FastSync, path: string): void {
    const safe = safeVaultPath(path);
    if (!safe) return;
    const state = stateOf(plugin);
    for (let cursor: string | null = safe; cursor; cursor = parentOf(cursor)) {
        state.pending.delete(cursor);
        state.tombstones.delete(cursor);
    }
}

/**
 * 挂起且没被未同步文件挡住的删除，以及已经落地的墓碑，都不要再放进上行 folders 清单。
 * 否则服务端 UpdateOrCreate 会把目录恢复并广播回来。未同步文件挡住时必须继续上报。
 */
export function shouldOmitFolderFromUpload(plugin: FastSync, path: string): boolean {
    const safe = safeVaultPath(path);
    if (!safe) return false;
    const state = stateOf(plugin);
    for (let cursor: string | null = safe; cursor; cursor = parentOf(cursor)) {
        const entry = state.pending.get(cursor);
        if (entry) return !entry.blocked;
        if (state.tombstones.has(cursor)) return true;
    }
    return false;
}

/**
 * 开启离线删除同步时，快照里「本地已经没有」的目录必须留到下一轮 delFolders，
 * 不能在对账时直接忘掉，否则服务端永远收不到删除，别的设备还会把目录推回来。
 */
export function shouldRetainMissingFolderSnapshot(offlineDeleteSyncEnabled: boolean): boolean {
    return offlineDeleteSyncEnabled === true;
}

/**
 * 本地删掉一棵目录时，按现有快照和哈希表列出要发的删除，深的在前，根目录在最后。
 * 只包含这棵树内部的合法相对路径。真正的发送仍走原来的 NoteDelete / FileDelete / FolderDelete。
 */
export function planLocalFolderTreeDelete(root: string, folderPaths: readonly string[], filePaths: readonly string[]): LocalTreeDelete[] {
    const safeRoot = safeVaultPath(root);
    if (!safeRoot) return [];
    const inTree = (candidate: string) => candidate === safeRoot || candidate.startsWith(`${safeRoot}/`);
    const folders = new Set<string>();
    for (const raw of folderPaths) {
        const candidate = safeVaultPath(raw);
        if (candidate && inTree(candidate)) folders.add(candidate);
    }
    folders.add(safeRoot);

    const ops: LocalTreeDelete[] = [];
    for (const folder of folders) ops.push({ path: folder, kind: "folder" });
    const seenFiles = new Set<string>();
    for (const raw of filePaths) {
        const candidate = safeVaultPath(raw);
        if (!candidate || candidate === safeRoot || !inTree(candidate) || seenFiles.has(candidate)) continue;
        seenFiles.add(candidate);
        ops.push({ path: candidate, kind: candidate.endsWith(".md") ? "note" : "file" });
    }
    ops.sort((a, b) => depthOf(b.path) - depthOf(a.path) || a.path.localeCompare(b.path));
    return ops;
}
