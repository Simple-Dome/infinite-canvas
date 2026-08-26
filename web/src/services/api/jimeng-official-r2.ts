import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { orderJimengOfficialReferences, type JimengOfficialReference, type JimengOfficialReferenceType } from "@/lib/jimeng-official-video";
import type { VideoImageRole } from "@/lib/jimeng933-video";

type UploadSource = {
    id: string;
    name: string;
    type: JimengOfficialReferenceType;
    mimeType: string;
    storageKey?: string;
    sources: string[];
};
type PreparedUpload = UploadSource & { clientFileId: string; blob: Blob; contentType: string };
type PresignedFile = { client_file_id: string; object_key: string; put_url: string; put_headers?: Record<string, string> };
type PresignResponse = { session_id: string; expires_at?: number; files: PresignedFile[] };
type CompletedFile = { client_file_id: string; object_key: string; source_url: string; source_expires_at?: number };
type CompleteResponse = { session_id: string; files: CompletedFile[] };

export type JimengOfficialUploadResult = { sessionId?: string; references: JimengOfficialReference[] };

export async function uploadJimengOfficialReferences(
    config: Pick<AiConfig, "baseUrl" | "apiKey">,
    input: { images: ReferenceImage[]; videos: ReferenceVideo[]; audios: ReferenceAudio[]; imageRoles?: Record<string, VideoImageRole> },
    idempotencyKey: string,
    signal?: AbortSignal,
): Promise<JimengOfficialUploadResult> {
    const sources = orderJimengOfficialReferences(toUploadSources(input), input.imageRoles);
    if (!sources.length) return { references: [] };

    const prepared = await Promise.all(
        sources.map(async (source) => {
            try {
                return await prepareUpload(source);
            } catch (error) {
                if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
                throw new Error(`读取官方即梦参考${kindLabel(source.type)}「${source.name}」失败：浏览器无法读取本地素材。请重新上传该素材后再试（可能是本地 Blob URL 或 IndexedDB 文件已失效）`);
            }
        }),
    );
    const presigned = await requestJson<PresignResponse>(buildJimengOfficialR2ApiUrl(config.baseUrl, "/api/canvas/r2/uploads/presign"), {
        method: "POST",
        headers: authHeaders(config.apiKey, idempotencyKey),
        body: JSON.stringify({
            files: prepared.map((file) => ({ client_file_id: file.clientFileId, name: file.name, content_type: file.contentType, size: file.blob.size, kind: file.type })),
        }),
        signal,
    });
    assertPresignResponse(presigned, prepared);
    const presignedById = new Map(presigned.files.map((file) => [file.client_file_id, file]));

    try {
        await mapWithConcurrency(prepared, 3, async (file) => {
            const signed = presignedById.get(file.clientFileId)!;
            let response: Response;
            try {
                response = await fetch(signed.put_url, {
                    method: "PUT",
                    headers: signed.put_headers || { "Content-Type": file.contentType },
                    body: file.blob,
                    signal,
                });
            } catch (error) {
                if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
                throw new Error(`上传${kindLabel(file.type)}「${file.name}」到 Cloudflare R2 失败：浏览器无法访问 R2。请检查 bucket CORS 是否允许当前 Canvas 来源（${currentOrigin()}）执行 PUT，或重新发起上传获取新的签名`);
            }
            if (!response.ok) throw new Error(`上传${kindLabel(file.type)}「${file.name}」到 Cloudflare R2 失败（${response.status}）`);
        });

        const completed = await requestJson<CompleteResponse>(buildJimengOfficialR2ApiUrl(config.baseUrl, "/api/canvas/r2/uploads/complete"), {
            method: "POST",
            headers: authHeaders(config.apiKey, idempotencyKey),
            body: JSON.stringify({ session_id: presigned.session_id }),
            signal,
        });
        assertCompleteResponse(completed, prepared, presigned.session_id);
        const completedById = new Map(completed.files.map((file) => [file.client_file_id, file]));
        return {
            sessionId: presigned.session_id,
            references: prepared.map((file) => ({ id: file.id, type: file.type, source: completedById.get(file.clientFileId)!.source_url })),
        };
    } catch (error) {
        await deleteJimengOfficialUploadSession(config, presigned.session_id).catch(() => undefined);
        throw error;
    }
}

export async function deleteJimengOfficialUploadSession(config: Pick<AiConfig, "baseUrl" | "apiKey">, sessionId: string, signal?: AbortSignal) {
    const response = await fetch(buildJimengOfficialR2ApiUrl(config.baseUrl, `/api/canvas/r2/uploads/${encodeURIComponent(sessionId)}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal,
    });
    if (!response.ok) throw new Error(`清理官方即梦临时素材失败（${response.status}）`);
}

export function buildJimengOfficialR2ApiUrl(baseUrl: string, path: string) {
    const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${root}${path}`;
}

function toUploadSources(input: { images: ReferenceImage[]; videos: ReferenceVideo[]; audios: ReferenceAudio[] }) {
    return [
        ...input.images.map((item): UploadSource => ({ id: item.id, name: item.name, type: "image", mimeType: item.type, storageKey: item.storageKey, sources: [item.dataUrl, item.url || ""] })),
        ...input.videos.map((item): UploadSource => ({ id: item.id, name: item.name, type: "video", mimeType: item.type, storageKey: item.storageKey, sources: [item.url] })),
        ...input.audios.map((item): UploadSource => ({ id: item.id, name: item.name, type: "audio", mimeType: item.type, storageKey: item.storageKey, sources: [item.url] })),
    ];
}

async function prepareUpload(source: UploadSource): Promise<PreparedUpload> {
    let blob = source.storageKey ? await (source.type === "image" ? getImageBlob(source.storageKey) : getMediaBlob(source.storageKey)) : null;
    for (const value of source.sources) {
        if (blob || !value) continue;
        try {
            const response = await fetch(value);
            if (response.ok) blob = await response.blob();
        } catch {
            // 继续尝试同一素材的其它本地来源。
        }
    }
    if (!blob) throw new Error(`官方满血即梦参考${kindLabel(source.type)}「${source.name}」无法读取，请重新上传`);
    const contentType = blob.type || source.mimeType || "application/octet-stream";
    return { ...source, clientFileId: `${source.type}:${source.id}`, blob, contentType };
}

function authHeaders(apiKey: string, idempotencyKey: string) {
    return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey };
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await fetch(url, init);
    } catch (error) {
        if (init.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        throw new Error("官方即梦素材控制接口请求失败：请检查 Base URL、API Key 以及 Canvas 页面跨域配置");
    }
    const text = await response.text();
    let payload: unknown;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = text;
    }
    if (!response.ok) throw new Error(readErrorMessage(payload) || `官方满血即梦素材接口请求失败（${response.status}）`);
    return payload as T;
}

function currentOrigin() {
    return typeof window === "undefined" ? "当前页面来源" : window.location.origin;
}

function assertPresignResponse(response: PresignResponse, prepared: PreparedUpload[]) {
    if (!response.session_id) throw new Error("官方满血即梦素材接口没有返回上传会话 ID");
    const files = new Map((response.files || []).map((file) => [file.client_file_id, file]));
    const missing = prepared.find((file) => !files.get(file.clientFileId)?.put_url);
    if (missing) throw new Error(`官方满血即梦素材接口没有返回「${missing.name}」的上传地址`);
}

function assertCompleteResponse(response: CompleteResponse, prepared: PreparedUpload[], sessionId: string) {
    if (response.session_id !== sessionId) throw new Error("官方满血即梦素材接口返回了错误的上传会话");
    const files = new Map((response.files || []).map((file) => [file.client_file_id, file]));
    const missing = prepared.find((file) => !files.get(file.clientFileId)?.source_url);
    if (missing) throw new Error(`官方满血即梦素材接口没有返回「${missing.name}」的访问地址`);
}

function readErrorMessage(payload: unknown): string {
    if (typeof payload === "string") return payload;
    if (!payload || typeof payload !== "object") return "";
    const value = payload as { error?: string | { message?: string }; message?: string; msg?: string; detail?: string };
    return (typeof value.error === "string" ? value.error : value.error?.message) || value.message || value.msg || value.detail || "";
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
    let index = 0;
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (index < items.length) {
                const item = items[index++];
                await run(item);
            }
        }),
    );
}

function kindLabel(kind: JimengOfficialReferenceType) {
    return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}
