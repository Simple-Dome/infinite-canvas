import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";

/**
 * Resolve a media value to a readable Blob before handing it to a download
 * helper. Passing a cross-origin URL directly to FileSaver can open the URL in
 * a new tab when CORS is unavailable, so callers must never use that fallback.
 */
export async function resolveDownloadBlob(url: string | undefined, storageKey?: string, signal?: AbortSignal) {
    const stored = await readStoredDownloadBlob(storageKey);
    if (stored) return stored;
    if (!url) throw new Error("没有可下载的媒体内容");

    let response: Response;
    try {
        response = await fetch(url, { credentials: "omit", redirect: "follow", signal });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error("远程媒体不允许浏览器读取，已阻止打开原始地址；请重新下载到本地后再试");
    }
    if (!response.ok) throw new Error(`远程媒体下载失败（${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("远程媒体返回了空文件");
    if (blob.type.includes("text/html")) throw new Error("远程媒体返回了网页内容，无法作为文件下载");
    return blob;
}

export async function readStoredDownloadBlob(storageKey?: string) {
    if (!storageKey) return null;
    return storageKey.startsWith("image:") ? getImageBlob(storageKey) : getMediaBlob(storageKey);
}
