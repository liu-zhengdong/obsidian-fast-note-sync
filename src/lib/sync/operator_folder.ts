import { TFolder, normalizePath } from "obsidian";

import { SyncEndData, FolderSyncRenameMessage } from "../utils/types";
import { hashContent, dump, dumpError, isFolderSyncPathExcluded, isPathExcluded, vaultDelete, checkAndNotifyCaseConflict } from "../utils/helpers";
import { SyncLogManager } from "./sync_log_manager";
import { applyRemoteFolderDelete, classifyRemoteFolderModify, clearFolderDeletionState, planLocalFolderTreeDelete } from "./folder_deletion";
import { noteDeleteByPath } from "./operator_note";
import { fileDeleteByPath } from "./operator_file";
import type FastSync from "../../main";


/**
 * 文件夹修改/创建事件处理
 */
export const folderModify = async function (folder: TFolder, plugin: FastSync, eventEnter: boolean = false) {
    if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
    if (eventEnter && plugin.isIgnoredFile(folder.path)) return
    if (isFolderSyncPathExcluded(folder.path, plugin)) return
    // 用户又把目录建回来了，取消挂着的远端删除记忆，允许重新上传
    clearFolderDeletionState(plugin, folder.path)

    await plugin.lockManager.withLock(folder.path, async () => {
        plugin.addIgnoredFile(folder.path)
        try {
            const now = Date.now();
            const data = {
                vault: plugin.settings.vault,
                path: folder.path,
                pathHash: hashContent(folder.path),
            }
            void plugin.websocket.SendMessage("FolderModify", data, undefined, () => {
                plugin.folderSnapshotManager.setFolderMtime(folder.path, now)
            })
            dump(`Folder modify send`, data.path, data.pathHash)
        } finally {
            plugin.removeIgnoredFile(folder.path)
        }
    }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 文件夹删除事件处理
 */
export const folderDelete = async function (folder: TFolder, plugin: FastSync, eventEnter: boolean = false) {
    if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
    if (eventEnter && plugin.isIgnoredFile(folder.path)) return
    if (isFolderSyncPathExcluded(folder.path, plugin)) return

    // --- 新增：删除拦截 ---
    if (plugin.lastSyncPathDeleted.has(folder.path)) {
        dump(`Folder delete intercepted: ${folder.path}`)
        return
    }

    await emitLocalFolderTreeDelete(folder.path, plugin)
}

/**
 * 按已跟踪的快照和哈希，把一棵本地目录的删除发完。深的路径在前，根目录在最后。
 * 服务端 FolderDelete 只标记这一层，子笔记、附件和子目录仍要走各自原来的删除消息。
 */
async function emitLocalFolderTreeDelete(root: string, plugin: FastSync): Promise<void> {
    const folderPaths = (plugin.folderSnapshotManager?.getAllPaths() ?? []).filter((candidate) => !isFolderSyncPathExcluded(candidate, plugin))
    const filePaths = (plugin.fileHashManager?.getAllPaths() ?? []).filter((candidate) => !isPathExcluded(candidate, plugin))
    const ops = planLocalFolderTreeDelete(root, folderPaths, filePaths)
    for (const op of ops) {
        try {
            if (op.kind === "note") await noteDeleteByPath(op.path, plugin)
            else if (op.kind === "file") await fileDeleteByPath(op.path, plugin)
            else await sendFolderDeleteMessage(op.path, plugin)
        } catch (error) {
            dumpError(`[FastSync] Failed to send folder-tree delete: ${op.path}`, error)
        }
    }
}

async function sendFolderDeleteMessage(folderPath: string, plugin: FastSync): Promise<void> {
    if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
    if (isFolderSyncPathExcluded(folderPath, plugin)) return
    if (plugin.lastSyncPathDeleted.has(folderPath)) return

    await plugin.lockManager.withLock(folderPath, async () => {
        plugin.addIgnoredFile(folderPath)
        try {
            const data = {
                vault: plugin.settings.vault,
                path: folderPath,
                pathHash: hashContent(folderPath),
            }
            void plugin.websocket.SendMessage("FolderDelete", data, undefined, () => {
                // 离线删除开着时留下快照，下一轮 delFolders 才能补发没送到的删除。
                // 关掉时没有 delFolders，发出去就忘掉，避免 missingFolders 把目录从服务端要回来。
                if (!plugin.settings.offlineDeleteSyncEnabled) {
                    plugin.folderSnapshotManager.removeFolder(folderPath)
                }
            })
            dump(`Folder delete send`, folderPath)
        } finally {
            plugin.removeIgnoredFile(folderPath)
        }
    }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 按路径字符串发送文件夹删除消息（用于无法获取 TFolder 对象的场景，如 rename 后旧路径已不存在）
 * Send folder delete message by path string (for scenarios where TFolder object is unavailable, e.g., old path after rename)
 */
export const folderDeleteByPath = async function (folderPath: string, plugin: FastSync) {
    if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
    if (isFolderSyncPathExcluded(folderPath, plugin)) return
    if (plugin.lastSyncPathDeleted.has(folderPath)) return

    await emitLocalFolderTreeDelete(folderPath, plugin)
}

/**
 * 文件夹重命名事件处理
 */
export const folderRename = async function (folder: TFolder, oldPath: string, plugin: FastSync, eventEnter: boolean = false) {
    if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
    if (eventEnter && plugin.isIgnoredFile(folder.path)) return
    const newExcluded = isFolderSyncPathExcluded(folder.path, plugin)
    const oldExcluded = isFolderSyncPathExcluded(oldPath, plugin)

    // Cross-exclusion-boundary rename handling
    // 跨排除边界重命名处理
    if (newExcluded && !oldExcluded) {
        // Moving from normal folder to excluded folder: delete old path on server
        // 从正常文件夹移至排除文件夹：删除服务端旧路径
        void folderDeleteByPath(oldPath, plugin)
        return
    }
    if (!newExcluded && oldExcluded) {
        // Moving from excluded folder to normal folder: create new folder on server
        // 从排除文件夹移至正常文件夹：在服务端创建新文件夹
        void folderModify(folder, plugin, true)
        return
    }
    if (newExcluded && oldExcluded) {
        // Both paths excluded: do nothing
        // 两个路径均被排除：不处理
        return
    }

    // --- 新增：重命名拦截 ---
    if (plugin.lastSyncPathRenamed.has(folder.path)) {
        dump(`Folder rename intercepted: ${folder.path}`)
        return
    }

    await plugin.lockManager.withLock(folder.path, async () => {
        plugin.addIgnoredFile(folder.path)
        try {
            const now = Date.now();
            const data = {
                vault: plugin.settings.vault,
                path: folder.path,
                pathHash: hashContent(folder.path),
                oldPath: oldPath,
                oldPathHash: hashContent(oldPath),
            }
            void plugin.websocket.SendMessage("FolderRename", data, undefined, () => {
                plugin.folderSnapshotManager.removeFolder(oldPath)
                plugin.folderSnapshotManager.setFolderMtime(folder.path, now)
            })
            dump(`Folder rename send`, data.path, data.pathHash)
        } finally {
            plugin.removeIgnoredFile(folder.path)
        }
    }, { maxRetries: 5, retryInterval: 50 });
}

/**
 * 接收服务端文件夹修改通知
 */
export const receiveFolderSyncModify = async function (data: { path: string, mtime?: number, lastTime?: number, pathHash?: string, pageIndex?: number }, plugin: FastSync) {
    if (plugin.settings.syncEnabled == false) return
    if (isFolderSyncPathExcluded(data.path, plugin)) {
        plugin.recordSyncCompleted('folder', data.pageIndex)
        return
    }
    dump(`Receive folder modify:`, data.path, data.pathHash)

    const normalizedPath = normalizePath(data.path)
    let ignoredStaleModify = false

    try {
        await plugin.lockManager.withLock(normalizedPath, async () => {
            plugin.addIgnoredFile(normalizedPath)
            try {
                if (classifyRemoteFolderModify(plugin, normalizedPath, data.lastTime) === "ignore") {
                    ignoredStaleModify = true
                    dump(`Ignore stale folder modify after delete: ${normalizedPath}`)
                    return
                }
                const existingFolder = plugin.app.vault.getAbstractFileByPath(normalizedPath)
                if (!existingFolder) {
                    try {
                        await plugin.app.vault.createFolder(normalizedPath)
                    } catch (e) {
                        if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'FolderModify')) {
                            // 文件夹可能因并发创建已存在（Linux 上会抛 "Folder already exists"），忽略此错误
                            // Folder may already exist due to concurrent creation (Linux throws "Folder already exists"), ignore
                            dump(`Folder create ignored (may already exist): ${normalizedPath}`, e)
                        }
                    }
                }
                clearFolderDeletionState(plugin, normalizedPath)
                plugin.folderSnapshotManager.setFolderMtime(normalizedPath, data.mtime || Date.now())
            } finally {
                window.setTimeout(() => {
                    plugin.removeIgnoredFile(normalizedPath)
                }, 500);
            }
        }, { maxRetries: 5, retryInterval: 100 });
    } catch (e) {
        dumpError(`[FastSync] Failed to receiveFolderSyncModify: ${normalizedPath}`, e);
        if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'FolderModify')) {
            SyncLogManager.getInstance().addLog('receive', 'FolderModify', e instanceof Error ? e.message : String(e), 'error', data.path);
        }
        plugin.folderSyncTasks.failed++
    } finally {
        // 实时更新同步时间戳，与 note 端保持一致
        // Update sync timestamp in real time, consistent with note side
        if (!ignoredStaleModify && data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFolderSyncTime"))) {
            plugin.localStorageManager.setMetadata("lastFolderSyncTime", data.lastTime)
        }
        plugin.recordSyncCompleted('folder', data.pageIndex)
    }
}

/**
 * 接收服务端文件夹删除通知
 */
export const receiveFolderSyncDelete = async function (data: { path: string, lastTime?: number, pathHash?: string, pageIndex?: number }, plugin: FastSync) {
    if (plugin.settings.syncEnabled == false) return
    if (isFolderSyncPathExcluded(data.path, plugin)) {
        plugin.recordSyncCompleted('folder', data.pageIndex)
        return
    }
    const normalizedPath = normalizePath(data.path)
    dump(`Receive folder delete:`, normalizedPath, data.pathHash)

    try {
        // 非空就挂起，等子项自己的删除把目录腾空后再删；ENOENT 视为已经达成。
        // 不在这里推进 lastFolderSyncTime，避免一次跳过把删除水位线抬过、服务端不再重发。
        await applyRemoteFolderDelete(plugin, { path: normalizedPath, lastTime: data.lastTime })
    } catch (e) {
        dumpError(`[FastSync] Failed to receiveFolderSyncDelete: ${data.path}`, e);
        SyncLogManager.getInstance().addLog('receive', 'FolderDelete', e instanceof Error ? e.message : String(e), 'error', data.path);
        plugin.folderSyncTasks.failed++
    } finally {
        plugin.recordSyncCompleted('folder', data.pageIndex)
    }
}

/**
 * 接收服务端文件夹重命名通知
 */
export const receiveFolderSyncRename = async function (data: FolderSyncRenameMessage, plugin: FastSync) {
    if (plugin.settings.syncEnabled == false) return
    if (isFolderSyncPathExcluded(data.path, plugin) || isFolderSyncPathExcluded(data.oldPath, plugin)) {
        plugin.recordSyncCompleted('folder', data.pageIndex)
        return
    }

    dump(`Receive folder rename:`, data.oldPath, "->", data.path)

    const normalizedOldPath = normalizePath(data.oldPath)
    const normalizedNewPath = normalizePath(data.path)

    try {
        await plugin.lockManager.withLock(normalizedNewPath, async () => {
            const folder = plugin.app.vault.getAbstractFileByPath(normalizedOldPath)
            if (folder instanceof TFolder) {
                plugin.addIgnoredFile(normalizedNewPath)
                plugin.addIgnoredFile(normalizedOldPath)

                // 记录新路径
                plugin.lastSyncPathRenamed.add(normalizedNewPath)

                try {
                    const target = plugin.app.vault.getAbstractFileByPath(normalizedNewPath)
                    if (target) {
                        await vaultDelete(plugin.app.vault, target, true)
                    }

                    await plugin.app.vault.rename(folder, normalizedNewPath)
                    plugin.folderSnapshotManager.removeFolder(normalizedOldPath)
                    plugin.folderSnapshotManager.setFolderMtime(normalizedNewPath, data.mtime || Date.now())
                } finally {
                    window.setTimeout(() => {
                        plugin.removeIgnoredFile(normalizedNewPath)
                        plugin.removeIgnoredFile(normalizedOldPath)
                        plugin.lastSyncPathRenamed.delete(normalizedNewPath)
                    }, 500);
                }
            } else {
                const target = plugin.app.vault.getAbstractFileByPath(normalizedNewPath)
                if (!target) {
                    try {
                        await plugin.app.vault.createFolder(normalizedNewPath)
                    } catch (e) {
                        if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'FolderRename')) {
                            dump(`Folder create ignored (may already exist): ${normalizedNewPath}`, e)
                        }
                    }
                    plugin.folderSnapshotManager.setFolderMtime(normalizedNewPath, data.mtime || Date.now())
                }
            }
        }, { maxRetries: 10, retryInterval: 100 });
    } catch (e) {
        dumpError(`[FastSync] Failed to receiveFolderSyncRename: ${normalizedOldPath} -> ${normalizedNewPath}`, e);
        if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'FolderRename')) {
            SyncLogManager.getInstance().addLog('receive', 'FolderRename', e instanceof Error ? e.message : String(e), 'error', data.path);
        }
        plugin.folderSyncTasks.failed++
    } finally {
        // 实时更新同步时间戳，与 note 端保持一致
        // Update sync timestamp in real time, consistent with note side
        if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFolderSyncTime"))) {
            plugin.localStorageManager.setMetadata("lastFolderSyncTime", data.lastTime)
        }
        plugin.recordSyncCompleted('folder', data.pageIndex)
    }
}

/**
 * 接收文件夹同步结束通知
 */
export const receiveFolderSyncEnd = async function (data: unknown, plugin: FastSync) {
    if (plugin.settings.syncEnabled == false) return
    dump(`Receive folder end:`, data)

    const syncData = data as SyncEndData
    // 更新任务统计信息，用于进度条计算 (Update task stats for progress bar)
    plugin.folderSyncTasks.needUpload = syncData.needUploadCount || 0
    plugin.folderSyncTasks.needModify = syncData.needModifyCount || 0
    plugin.folderSyncTasks.needSyncMtime = syncData.needSyncMtimeCount || 0
    plugin.folderSyncTasks.needDelete = syncData.needDeleteCount || 0

    // 无条件更新 lastFolderSyncTime，确保包含服务端本轮同步后的所有异步操作（如 SyncResourceFID）
    // Unconditionally update lastFolderSyncTime to cover all async server-side ops after this sync round (e.g., SyncResourceFID)
    plugin.localStorageManager.setMetadata("lastFolderSyncTime", syncData.lastTime)
    plugin.syncTypeCompleteCount++
}
