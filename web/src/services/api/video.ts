import axios from "axios";
import { nanoid } from "nanoid";

import { UPLOAD_BASE } from "@/constant/env";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { getImageBlob, imageToDataUrl } from "@/services/image-storage";
import { isJimeng431VideoConfig, normalizeJimeng431Ratio, normalizeJimeng431Resolution, validateJimeng431VideoInput } from "@/lib/jimeng431-video";
import { isJimeng933VideoConfig, normalizeJimeng933Ratio, normalizeJimeng933Resolution, validateJimeng933VideoInput, type VideoImageRole, type VideoShot } from "@/lib/jimeng933-video";
import { buildJimengOfficialRequest, isJimengOfficialVideoConfig, normalizeJimengOfficialRatio } from "@/lib/jimeng-official-video";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError } from "@/lib/seedance-video";
import { optimizeVideoReferenceImageDataUrl } from "@/lib/video-reference-preprocess";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, resolveTaskModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import { deleteJimengOfficialUploadSession, uploadJimengOfficialReferences } from "./jimeng-official-r2";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; progress?: number; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    progress?: number;
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type JimengTaskResponse = {
    id?: string;
    task_id?: string;
    model?: string;
    status?: string;
    progress?: number;
    download_url?: string;
    error?: { code?: string; message?: string };
    message?: string;
};
type VideoReferencePolicy = "imageBase64Only" | "allUrlMultimodal";

const BASE64_IMAGE_ONLY_VIDEO_MODELS = new Set(["video-v1-10s", "video-v1-5s", "video-v1-15s"]);
const ALL_URL_MULTIMODAL_VIDEO_MODELS = new Set(["as-sd2.0-fast", "video-ds-2.0-fast", "video-ds-2.0"]);
const VIDEO_REFERENCE_POLICY_LIMITS = {
    imageBase64Only: { images: 9, videos: 0, audios: 0, code: "900" },
    allUrlMultimodal: { images: 4, videos: 3, audios: 1, code: "431" },
} as const;

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationInput = {
    prompt: string;
    negativePrompt?: string;
    seed?: number;
    images: ReferenceImage[];
    videos: ReferenceVideo[];
    audios: ReferenceAudio[];
    imageRoles?: Record<string, VideoImageRole>;
    shots?: VideoShot[];
};
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "jimeng933" | "jimeng431" | "jimengOfficial" | "plugin"; model: string; uploadSessionId?: string };
export type VideoGenerationTaskState =
    | { status: "pending"; remoteStatus: string; progress?: number }
    | { status: "completed"; remoteStatus: string; progress?: number; result?: VideoGenerationResult; resultUrl?: string }
    | { status: "failed"; remoteStatus: string; progress?: number; error: string };
export type VideoPollingPolicy = { delayMs: number; maxAttempts: number; timeoutMessage: string };
export type VideoRequestOptions = {
    signal?: AbortSignal;
    onReferenceImagesOptimized?: (count: number) => void;
    onTaskCreated?: (task: VideoGenerationTask) => void;
    onTaskStateChange?: (state: VideoGenerationTaskState) => void;
    idempotencyKey?: string;
};

export function readVideoSeed(config: Pick<AiConfig, "videoSeedEnabled" | "videoSeed">) {
    if (!boolConfig(config.videoSeedEnabled, false)) return undefined;
    const value = config.videoSeed.trim();
    if (!value) throw new Error("请输入 Seed");
    const seed = Number(value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4_294_967_295) throw new Error("Seed 必须是 0–4294967295 的整数");
    return seed;
}

export class VideoTaskPausedError extends Error {
    constructor(
        message: string,
        public readonly reason: "timeout" | "network" | "download",
        public readonly task: VideoGenerationTask,
    ) {
        super(message);
        this.name = "VideoTaskPausedError";
    }
}

export class VideoTaskFailedError extends Error {
    constructor(
        message: string,
        public readonly task: VideoGenerationTask,
        public readonly remoteStatus: string,
    ) {
        super(message);
        this.name = "VideoTaskFailedError";
    }
}

const VIDEO_POLLING_DELAY_MS = 5000;
const OPENAI_VIDEO_MAX_POLLING_MS = 20 * 60 * 1000;
const SEEDANCE_VIDEO_MAX_POLLING_MS = 10 * 60 * 1000;

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, input: VideoGenerationInput, options?: VideoRequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, input, options);
    options?.onTaskCreated?.(task);
    return continueVideoGenerationTask(config, task, options);
}

export async function continueVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: VideoRequestOptions): Promise<VideoGenerationResult> {
    const pollingPolicy = getVideoPollingPolicy(task);
    for (let attempt = 0; attempt < pollingPolicy.maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let state: VideoGenerationTaskState;
        try {
            state = await pollVideoGenerationTask(config, task, options);
        } catch (error) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            throw new VideoTaskPausedError(error instanceof Error ? error.message : "视频任务查询失败", "network", task);
        }
        options?.onTaskStateChange?.(state);
        if (state.status === "completed") {
            try {
                return await downloadVideoGenerationTask(config, task, state, options);
            } catch (error) {
                if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
                throw new VideoTaskPausedError(error instanceof Error ? error.message : "视频下载失败", "download", task);
            }
        }
        if (state.status === "failed") throw new VideoTaskFailedError(state.error, task, state.remoteStatus);
        if (attempt === pollingPolicy.maxAttempts - 1) throw new VideoTaskPausedError(pollingPolicy.timeoutMessage, "timeout", task);
        await delay(pollingPolicy.delayMs, options?.signal);
    }
    throw new VideoTaskPausedError("视频生成超时，请稍后重试", "timeout", task);
}

export function getVideoPollingPolicy(task: Pick<VideoGenerationTask, "provider">): VideoPollingPolicy {
    const maxDurationMs = task.provider === "seedance" ? SEEDANCE_VIDEO_MAX_POLLING_MS : OPENAI_VIDEO_MAX_POLLING_MS;
    return {
        delayMs: VIDEO_POLLING_DELAY_MS,
        maxAttempts: Math.ceil(maxDurationMs / VIDEO_POLLING_DELAY_MS),
        timeoutMessage: `${task.provider === "seedance" ? "Seedance " : ""}视频生成超时，请稍后重试`,
    };
}

export async function createVideoGenerationTask(config: AiConfig, input: VideoGenerationInput, options?: VideoRequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, input, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (isJimeng933VideoConfig(requestConfig)) return createJimeng933VideoTask(requestConfig, selectedModel, input, options);
    if (isJimeng431VideoConfig(requestConfig)) return createJimeng431VideoTask(requestConfig, selectedModel, input, options);
    if (isJimengOfficialVideoConfig(requestConfig)) return createJimengOfficialVideoTask(requestConfig, selectedModel, input, options);
    if (input.seed !== undefined) throw new Error("当前视频渠道不支持 Seed");
    if (input.shots !== undefined) throw new Error("当前视频渠道不支持结构化分镜");
    if (isSeedanceVideoConfig(requestConfig)) {
        return createSeedanceTask(requestConfig, selectedModel, input.prompt, input.images, input.videos, input.audios, options);
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, input.prompt, input.images, input.videos, input.audios, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result
            ? { status: "completed", remoteStatus: "completed", progress: 100, result }
            : { status: "failed", remoteStatus: "expired", error: "插件视频任务已失效，请重新生成" };
    }
    const requestConfig = resolveTaskModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "jimeng933") return pollJimeng933VideoTask(requestConfig, task, options);
    if (task.provider === "jimeng431") return pollJimeng431VideoTask(requestConfig, task, options);
    if (task.provider === "jimengOfficial") return pollJimengOfficialVideoTask(requestConfig, task, options);
    return task.provider === "seedance" ? pollSeedanceTask(requestConfig, task, options) : pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, input: VideoGenerationInput, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    const refs = await Promise.all(input.images.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt: input.prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoAspectRatio(config.size),
                resolution: config.vquality,
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                seed: input.seed,
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error("模型调用脚本没有返回视频");
}

export async function downloadVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, state?: VideoGenerationTaskState, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationResult> {
    if (task.provider === "plugin") {
        const result = state?.status === "completed" ? state.result : pluginVideoResults.get(task.id);
        if (!result) throw new Error("插件视频任务已失效，请重新生成");
        return result;
    }
    const requestConfig = resolveTaskModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    const completedState = state?.status === "completed" ? state : task.provider === "jimeng933" ? await pollJimeng933VideoTask(requestConfig, task, options) : task.provider === "jimeng431" ? await pollJimeng431VideoTask(requestConfig, task, options) : task.provider === "jimengOfficial" ? await pollJimengOfficialVideoTask(requestConfig, task, options) : task.provider === "seedance" ? await pollSeedanceTask(requestConfig, task, options) : await pollOpenAIVideoTask(requestConfig, task, options);
    if (completedState.status !== "completed") throw new Error(completedState.status === "failed" ? completedState.error : "视频任务尚未完成");
    if (completedState.result) return completedState.result;
    if (task.provider === "jimeng933") return downloadJimeng933VideoTask(requestConfig, task, options);
    if (task.provider === "jimeng431") return downloadJimeng431VideoTask(requestConfig, task, completedState.resultUrl, options);
    if (task.provider === "jimengOfficial") {
        return downloadJimengOfficialVideoTask(requestConfig, task, options);
    }
    if (completedState.resultUrl) return videoResultFromUrl(completedState.resultUrl, options);
    if (task.provider === "seedance") throw new Error("Seedance 任务成功但没有返回视频 URL");
    try {
        const content = await axios.get<Blob>(aiApiUrl(requestConfig, `/videos/${task.id}/content`), { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal });
        await assertVideoBlob(content.data);
        return { blob: content.data };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频下载失败"));
    }
}

async function downloadJimengOfficialVideoTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationResult> {
    try {
        const url = aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}/content`);
        const response = await axios.get<Blob>(url, { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        throw new Error(await readJimengOfficialAxiosError(error, "官方满血即梦视频下载失败"));
    }
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error("视频接口没有返回可播放的视频");
}

async function createJimengOfficialVideoTask(config: AiConfig, model: string, input: VideoGenerationInput, options?: VideoRequestOptions): Promise<VideoGenerationTask> {
    const idempotencyKey = options?.idempotencyKey || nanoid();
    const uploaded = await uploadJimengOfficialReferences(config, input, idempotencyKey, options?.signal);
    const body = buildJimengOfficialRequest({
        model: modelOptionName(model),
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        aspectRatio: normalizeJimengOfficialRatio(config.videoSize),
        generateAudio: boolConfig(config.videoGenerateAudio, true),
        seed: input.seed,
        shots: input.shots,
        imageRoles: input.imageRoles,
        references: uploaded.references,
    });
    try {
        const create = () => axios.post<JimengTaskResponse>(aiApiUrl(config, "/videos"), body, { headers: { ...aiHeaders(config, "application/json"), "Idempotency-Key": idempotencyKey }, signal: options?.signal });
        let response: Awaited<ReturnType<typeof create>>;
        try {
            response = await create();
        } catch (error) {
            if (!isRetryableJimengCreateError(error) || options?.signal?.aborted) throw error;
            response = await create();
        }
        const taskId = response.data.id || response.data.task_id;
        if (!taskId) throw new Error("官方满血即梦接口没有返回任务 ID");
        return { id: taskId, provider: "jimengOfficial", model, uploadSessionId: uploaded.sessionId };
    } catch (error) {
        if (uploaded.sessionId && isDefinitiveJimengCreateFailure(error)) await cleanupJimengOfficialUpload(config, uploaded.sessionId);
        throw new Error(await readJimengOfficialAxiosError(error, "官方满血即梦任务创建失败"));
    }
}

async function pollJimengOfficialVideoTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationTaskState> {
    try {
        const state = (await axios.get<JimengTaskResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const remoteStatus = normalizeRemoteStatus(state.status);
        const progress = normalizeProgress(state.progress);
        if (remoteStatus === "completed") {
            if (task.uploadSessionId) await cleanupJimengOfficialUpload(config, task.uploadSessionId);
            return { status: "completed", remoteStatus, progress, ...(state.download_url ? { resultUrl: state.download_url } : {}) };
        }
        if (remoteStatus === "failed") {
            if (task.uploadSessionId) await cleanupJimengOfficialUpload(config, task.uploadSessionId);
            return { status: "failed", remoteStatus, progress, error: readApiErrorMessage(state.error?.message) || readApiErrorMessage(state.message) || "官方满血即梦视频生成失败" };
        }
        return { status: "pending", remoteStatus, progress };
    } catch (error) {
        throw new Error(await readJimengOfficialAxiosError(error, "官方满血即梦任务查询失败"));
    }
}

async function createJimeng933VideoTask(config: AiConfig, model: string, input: VideoGenerationInput, options?: VideoRequestOptions): Promise<VideoGenerationTask> {
    const normalizedModel = modelOptionName(model);
    const duration = Number(config.videoSeconds);
    const resolution = normalizeJimeng933Resolution(config.vquality);
    const aspectRatio = normalizeJimeng933Ratio(config.videoSize);
    const validationInput = { ...input, model: normalizedModel, duration, resolution, aspectRatio };
    const initialError = validateJimeng933VideoInput(validationInput);
    if (initialError) throw new Error(initialError);
    assertDistinctJimeng933References(input);

    const [images, videos, audios] = await Promise.all([
        Promise.all(input.images.map(prepareJimeng933Image)),
        Promise.all(input.videos.map(prepareJimeng933Video)),
        Promise.all(input.audios.map(prepareJimeng933Audio)),
    ]);
    const preparedInput = {
        ...validationInput,
        images: images.map((item) => ({ ...item.reference, type: item.type, bytes: item.blob.size, width: item.width, height: item.height })),
        videos: videos.map((item) => ({ ...item.reference, type: item.type, bytes: item.blob.size, width: item.width, height: item.height, durationMs: item.durationMs })),
        audios: audios.map((item) => ({ ...item.reference, type: item.type, bytes: item.blob.size, durationMs: item.durationMs })),
    };
    const preparedError = validateJimeng933VideoInput(preparedInput);
    if (preparedError) throw new Error(preparedError);

    const shots = input.shots?.map(({ prompt, duration: shotDuration }) => ({ prompt, duration: shotDuration }));
    const hasReferences = images.length + videos.length + audios.length > 0;
    const commonFields = {
        model: normalizedModel,
        ...(input.prompt.trim() ? { prompt: input.prompt } : {}),
        ...(input.negativePrompt !== undefined ? { negative_prompt: input.negativePrompt } : {}),
        duration,
        resolution,
        aspect_ratio: aspectRatio,
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(shots ? { shots } : {}),
    };

    try {
        const response = hasReferences
            ? await axios.post<JimengTaskResponse>(aiApiUrl(config, "/videos"), buildJimengFormData(commonFields, input, images, videos, audios), { headers: { ...aiHeaders(config), "Idempotency-Key": options?.idempotencyKey || nanoid() }, signal: options?.signal })
            : await axios.post<JimengTaskResponse>(aiApiUrl(config, "/videos"), commonFields, { headers: { ...aiHeaders(config, "application/json"), "Idempotency-Key": options?.idempotencyKey || nanoid() }, signal: options?.signal });
        const taskId = response.data.id || response.data.task_id;
        if (!taskId) throw new Error("933 即梦接口没有返回任务 ID");
        return { id: taskId, provider: "jimeng933", model };
    } catch (error) {
        throw new Error(await readJimeng933AxiosError(error, "933 即梦任务创建失败"));
    }
}

async function pollJimeng933VideoTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationTaskState> {
    try {
        const state = (await axios.get<JimengTaskResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const remoteStatus = normalizeRemoteStatus(state.status);
        const progress = normalizeProgress(state.progress);
        if (remoteStatus === "completed") return { status: "completed", remoteStatus, progress, ...(state.download_url ? { resultUrl: state.download_url } : {}) };
        if (remoteStatus === "failed") return { status: "failed", remoteStatus, progress, error: readApiErrorMessage(state.error?.message) || readApiErrorMessage(state.message) || "933 即梦视频生成失败" };
        return { status: "pending", remoteStatus, progress };
    } catch (error) {
        throw new Error(await readJimeng933AxiosError(error, "933 即梦任务查询失败"));
    }
}

async function downloadJimeng933VideoTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationResult> {
    try {
        const url = aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}/content`);
        const response = await axios.get<Blob>(url, { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        throw new Error(await readJimeng933AxiosError(error, "933 即梦视频下载失败"));
    }
}

function jimengDownloadUrl(config: AiConfig, taskId: string, downloadUrl: string | undefined, provider: "431" | "933") {
    if (!downloadUrl) return aiApiUrl(config, `/videos/${encodeURIComponent(taskId)}/content`);
    const baseUrl = new URL(`${config.baseUrl.trim().replace(/\/+$/, "")}/`);
    const resolved = new URL(downloadUrl, baseUrl);
    if (resolved.origin !== baseUrl.origin) throw new Error(`${provider} 即梦返回了不可信的跨域下载地址，已停止发送 API Key`);
    return resolved.toString();
}

async function createJimeng431VideoTask(config: AiConfig, model: string, input: VideoGenerationInput, options?: VideoRequestOptions): Promise<VideoGenerationTask> {
    const normalizedModel = modelOptionName(model);
    const duration = Number(config.videoSeconds);
    const resolution = normalizeJimeng431Resolution(config.vquality);
    const aspectRatio = normalizeJimeng431Ratio(config.videoSize);
    const validationInput = { ...input, model: normalizedModel, duration, resolution, aspectRatio };
    const initialError = validateJimeng431VideoInput(validationInput);
    if (initialError) throw new Error(initialError);
    assertDistinctJimengReferences(input, "431");

    const [images, videos, audios] = await Promise.all([
        Promise.all(input.images.map((reference) => prepareJimengImage(reference, "431"))),
        Promise.all(input.videos.map((reference) => prepareJimengVideo(reference, "431"))),
        Promise.all(input.audios.map((reference) => prepareJimengAudio(reference, "431"))),
    ]);
    const preparedError = validateJimeng431VideoInput({
        ...validationInput,
        images: images.map((item) => ({ ...item.reference, type: item.type, bytes: item.blob.size, width: item.width, height: item.height })),
        videos: videos.map((item) => ({ ...item.reference, type: item.type, bytes: item.blob.size, width: item.width, height: item.height, durationMs: item.durationMs })),
        audios: audios.map((item) => ({ ...item.reference, type: item.type, bytes: item.blob.size, durationMs: item.durationMs })),
    });
    if (preparedError) throw new Error(preparedError);

    const fields = {
        model: normalizedModel,
        prompt: input.prompt.trim(),
        duration,
        resolution,
        aspect_ratio: aspectRatio,
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
    };
    const hasReferences = images.length + videos.length + audios.length > 0;
    const headers = { ...aiHeaders(config, hasReferences ? undefined : "application/json"), "Idempotency-Key": options?.idempotencyKey || nanoid() };
    try {
        const create = () => hasReferences
            ? axios.post<JimengTaskResponse>(aiApiUrl(config, "/videos"), buildJimengFormData(fields, input, images, videos, audios), { headers, signal: options?.signal })
            : axios.post<JimengTaskResponse>(aiApiUrl(config, "/videos"), fields, { headers, signal: options?.signal });
        let response: Awaited<ReturnType<typeof create>>;
        try {
            response = await create();
        } catch (error) {
            if (!isRetryableJimengCreateError(error) || options?.signal?.aborted) throw error;
            response = await create();
        }
        const taskId = response.data.id || response.data.task_id;
        if (!taskId) throw new Error("431 即梦接口没有返回任务 ID");
        return { id: taskId, provider: "jimeng431", model };
    } catch (error) {
        throw new Error(await readJimengAxiosError(error, "431 即梦任务创建失败", "431"));
    }
}

function isRetryableJimengCreateError(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    return !status || status === 429 || status >= 500;
}

function isDefinitiveJimengCreateFailure(error: unknown) {
    if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) return false;
    if (!axios.isAxiosError(error)) return true;
    const status = error.response?.status;
    return Boolean(status && status >= 400 && status < 500 && status !== 429);
}

async function cleanupJimengOfficialUpload(config: AiConfig, sessionId: string) {
    try {
        await deleteJimengOfficialUploadSession(config, sessionId);
    } catch {
        // Cherry 定时清理和 R2 生命周期继续兜底，不影响任务终态。
    }
}

async function pollJimeng431VideoTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationTaskState> {
    try {
        const state = (await axios.get<JimengTaskResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const remoteStatus = normalizeRemoteStatus(state.status);
        const progress = normalizeProgress(state.progress);
        if (remoteStatus === "completed") return { status: "completed", remoteStatus, progress, ...(state.download_url ? { resultUrl: state.download_url } : {}) };
        if (remoteStatus === "failed") return { status: "failed", remoteStatus, progress, error: readApiErrorMessage(state.error?.message) || readApiErrorMessage(state.message) || "431 即梦视频生成失败" };
        return { status: "pending", remoteStatus, progress };
    } catch (error) {
        throw new Error(await readJimengAxiosError(error, "431 即梦任务查询失败", "431"));
    }
}

async function downloadJimeng431VideoTask(config: AiConfig, task: VideoGenerationTask, downloadUrl?: string, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationResult> {
    try {
        const url = jimengDownloadUrl(config, task.id, downloadUrl, "431");
        const response = await axios.get<Blob>(url, { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        throw new Error(await readJimengAxiosError(error, "431 即梦视频下载失败", "431"));
    }
}

type PreparedJimengImage = { reference: ReferenceImage; blob: Blob; type: string; name: string; width: number; height: number };
type PreparedJimengVideo = { reference: ReferenceVideo; blob: Blob; type: string; name: string; width: number; height: number; durationMs: number };
type PreparedJimengAudio = { reference: ReferenceAudio; blob: Blob; type: string; name: string; durationMs: number };

async function prepareJimeng933Image(reference: ReferenceImage): Promise<PreparedJimengImage> {
    const sourceBlob = await resolveJimeng933Blob(reference.storageKey, [reference.dataUrl, reference.url], "图片", getImageBlob);
    const type = jimengMimeType(sourceBlob, reference.type);
    const blob = withBlobType(sourceBlob, type);
    const meta = await readImageBlobMeta(blob).catch(() => {
        throw new Error(`933 即梦参考图片「${reference.name}」不是有效图片，请重新上传`);
    });
    return { reference, blob, type, name: jimengFileName(reference.name, type, "image"), ...meta };
}

async function prepareJimengImage(reference: ReferenceImage, provider: "431" | "933") {
    const sourceBlob = await resolveJimengBlob(reference.storageKey, [reference.dataUrl, reference.url], "图片", getImageBlob, provider);
    const type = jimengMimeType(sourceBlob, reference.type);
    const blob = withBlobType(sourceBlob, type);
    const meta = await readImageBlobMeta(blob).catch(() => {
        throw new Error(`${provider} 即梦参考图片「${reference.name}」不是有效图片，请重新上传`);
    });
    return { reference, blob, type, name: jimengFileName(reference.name, type, "image"), ...meta };
}

async function prepareJimengVideo(reference: ReferenceVideo, provider: "431" | "933") {
    const sourceBlob = await resolveJimengBlob(reference.storageKey, [reference.url], "视频", getMediaBlob, provider);
    const type = jimengMimeType(sourceBlob, reference.type);
    const blob = withBlobType(sourceBlob, type);
    const meta = await readMediaBlobMeta(blob, "video").catch(() => {
        throw new Error(`${provider} 即梦参考视频「${reference.name}」无法读取尺寸或时长，请重新上传`);
    });
    return { reference, blob, type, name: jimengFileName(reference.name, type, "video"), width: meta.width, height: meta.height, durationMs: meta.durationMs };
}

async function prepareJimengAudio(reference: ReferenceAudio, provider: "431" | "933") {
    const sourceBlob = await resolveJimengBlob(reference.storageKey, [reference.url], "音频", getMediaBlob, provider);
    const type = jimengMimeType(sourceBlob, reference.type);
    const blob = withBlobType(sourceBlob, type);
    const meta = await readMediaBlobMeta(blob, "audio").catch(() => {
        throw new Error(`${provider} 即梦参考音频「${reference.name}」无法读取时长，请重新上传`);
    });
    return { reference, blob, type, name: jimengFileName(reference.name, type, "audio"), durationMs: meta.durationMs };
}

async function prepareJimeng933Video(reference: ReferenceVideo): Promise<PreparedJimengVideo> {
    const sourceBlob = await resolveJimeng933Blob(reference.storageKey, [reference.url], "视频", getMediaBlob);
    const type = jimengMimeType(sourceBlob, reference.type);
    const blob = withBlobType(sourceBlob, type);
    const meta = await readMediaBlobMeta(blob, "video").catch(() => {
        throw new Error(`933 即梦参考视频「${reference.name}」无法读取尺寸或时长，请重新上传`);
    });
    return { reference, blob, type, name: jimengFileName(reference.name, type, "video"), width: meta.width, height: meta.height, durationMs: meta.durationMs };
}

async function prepareJimeng933Audio(reference: ReferenceAudio): Promise<PreparedJimengAudio> {
    const sourceBlob = await resolveJimeng933Blob(reference.storageKey, [reference.url], "音频", getMediaBlob);
    const type = jimengMimeType(sourceBlob, reference.type);
    const blob = withBlobType(sourceBlob, type);
    const meta = await readMediaBlobMeta(blob, "audio").catch(() => {
        throw new Error(`933 即梦参考音频「${reference.name}」无法读取时长，请重新上传`);
    });
    return { reference, blob, type, name: jimengFileName(reference.name, type, "audio"), durationMs: meta.durationMs };
}

function buildJimengFormData(fields: Record<string, unknown>, input: VideoGenerationInput, images: PreparedJimengImage[], videos: PreparedJimengVideo[], audios: PreparedJimengAudio[]) {
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => {
        if (value === undefined) return;
        form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    images.forEach((item) => {
        const role = input.imageRoles?.[item.reference.id];
        form.append(role === "first_frame" || role === "last_frame" ? role : "images", item.blob, item.name);
    });
    videos.forEach((item) => form.append("videos", item.blob, item.name));
    audios.forEach((item) => form.append("audios", item.blob, item.name));
    return form;
}

async function resolveJimeng933Blob(storageKey: string | undefined, sources: Array<string | undefined>, label: string, readStored: (key: string) => Promise<Blob | null>) {
    if (storageKey) {
        const stored = await readStored(storageKey);
        if (stored) return stored;
    }
    for (const source of sources) {
        if (!source) continue;
        try {
            const response = await fetch(source);
            if (response.ok) return await response.blob();
        } catch {
            // 继续尝试其它可用来源。
        }
    }
    throw new Error(`933 即梦参考${label}无法读取真实文件，请重新上传本地文件`);
}

async function resolveJimengBlob(storageKey: string | undefined, sources: Array<string | undefined>, label: string, readStored: (key: string) => Promise<Blob | null>, provider: "431" | "933") {
    if (storageKey) {
        const stored = await readStored(storageKey);
        if (stored) return stored;
    }
    for (const source of sources) {
        if (!source) continue;
        try {
            const response = await fetch(source);
            if (response.ok) return await response.blob();
        } catch {
            // 继续尝试其它可用来源。
        }
    }
    throw new Error(`${provider} 即梦参考${label}无法读取真实文件，请重新上传本地文件`);
}

function assertDistinctJimeng933References(input: VideoGenerationInput) {
    const seen = new Set<string>();
    for (const reference of [...input.images, ...input.videos, ...input.audios]) {
        const key = reference.storageKey || ("dataUrl" in reference ? reference.dataUrl : reference.url);
        if (!key) continue;
        if (seen.has(key)) throw new Error("933 即梦不支持重复提交同一个参考素材");
        seen.add(key);
    }
}

function assertDistinctJimengReferences(input: VideoGenerationInput, provider: "431" | "933") {
    const seen = new Set<string>();
    for (const reference of [...input.images, ...input.videos, ...input.audios]) {
        const key = reference.storageKey || ("dataUrl" in reference ? reference.dataUrl : reference.url);
        if (!key) continue;
        if (seen.has(key)) throw new Error(`${provider} 即梦不支持重复提交同一个参考素材`);
        seen.add(key);
    }
}

function jimengFileName(name: string, type: string, fallbackPrefix: "image" | "video" | "audio") {
    const safeName = name.replace(/[\\/\0]/g, "_").trim();
    const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("jpeg") ? "jpg" : type.includes("quicktime") ? "mov" : type.includes("wav") ? "wav" : type.includes("audio") ? "mp3" : "mp4";
    const baseName = safeName.replace(/\.[a-z0-9]{2,5}$/i, "") || fallbackPrefix;
    return `${baseName}.${extension}`;
}

function jimengMimeType(blob: Blob, declaredType: string) {
    return !blob.type || blob.type === "application/octet-stream" ? declaredType : blob.type;
}

function withBlobType(blob: Blob, type: string) {
    return blob.type === type ? blob : new Blob([blob], { type });
}

function readImageBlobMeta(blob: Blob) {
    return new Promise<{ width: number; height: number }>((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        const cleanup = () => URL.revokeObjectURL(url);
        image.onload = () => {
            const result = { width: image.naturalWidth, height: image.naturalHeight };
            cleanup();
            result.width && result.height ? resolve(result) : reject(new Error("invalid image"));
        };
        image.onerror = () => {
            cleanup();
            reject(new Error("invalid image"));
        };
        image.src = url;
    });
}

function readMediaBlobMeta(blob: Blob, kind: "video" | "audio") {
    return new Promise<{ width: number; height: number; durationMs: number }>((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const media = document.createElement(kind);
        const cleanup = () => {
            media.removeAttribute("src");
            media.load();
            URL.revokeObjectURL(url);
        };
        media.onloadedmetadata = () => {
            const video = kind === "video" ? (media as HTMLVideoElement) : null;
            const result = { width: video?.videoWidth || 0, height: video?.videoHeight || 0, durationMs: Number.isFinite(media.duration) ? Math.round(media.duration * 1000) : 0 };
            cleanup();
            result.durationMs && (kind === "audio" || (result.width && result.height)) ? resolve(result) : reject(new Error("invalid media"));
        };
        media.onerror = () => {
            cleanup();
            reject(new Error("invalid media"));
        };
        media.preload = "metadata";
        media.src = url;
    });
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: VideoRequestOptions): Promise<VideoGenerationTask> {
    const policy = getVideoReferencePolicy(model);
    const limits = VIDEO_REFERENCE_POLICY_LIMITS[policy];
    assertVideoReferencePolicy(policy, references, videoReferences, audioReferences);
    let optimizedCount = 0;
    const images = await Promise.all(
        references.slice(0, limits.images).map(async (image) => {
            const result = policy === "allUrlMultimodal" ? await resolvePublicVideoReferenceImageUrl(image) : await resolveVideoReferenceImageBase64(image);
            if (result.optimized) optimizedCount += 1;
            return result.url;
        }),
    );
    if (optimizedCount) options?.onReferenceImagesOptimized?.(optimizedCount);
    const videos = policy === "allUrlMultimodal" ? await Promise.all(videoReferences.slice(0, limits.videos).map((video) => resolvePublicReferenceVideoUrl(video))) : [];
    const audios = policy === "allUrlMultimodal" ? await Promise.all(audioReferences.slice(0, limits.audios).map((audio) => resolvePublicReferenceAudioUrl(audio))) : [];
    const payload: Record<string, unknown> = {
        model: modelOptionName(model),
        prompt,
        seconds: normalizeVideoSeconds(config.videoSeconds),
        aspect_ratio: normalizeVideoAspectRatio(config.size),
    };
    if (images.length) payload.images = images;
    if (videos.length) payload.videos = videos;
    if (audios.length) payload.audios = audios;
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const remoteStatus = normalizeRemoteStatus(video.status);
        const progress = normalizeProgress(video.progress);
        const resultUrl = videoResultUrl(video);
        if (resultUrl || ["completed", "succeeded", "done"].includes(remoteStatus)) return { status: "completed", remoteStatus, progress: 100, ...(resultUrl ? { resultUrl } : {}) };
        if (["failed", "cancelled", "canceled", "expired"].includes(remoteStatus)) return { status: "failed", remoteStatus, error: readApiErrorMessage(video.error?.message) || "视频生成失败" };
        return { status: "pending", remoteStatus, progress };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务查询失败"));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: VideoRequestOptions): Promise<VideoGenerationTask> {
    const policy = getVideoReferencePolicy(model);
    assertVideoReferencePolicy(policy, references, videoReferences, audioReferences);
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const optimizedCounter = { count: 0 };
    const content = await buildSeedanceContent(policy, prompt, references, videoReferences, audioReferences, optimizedCounter);
    if (optimizedCounter.count) options?.onReferenceImagesOptimized?.(optimizedCounter.count);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务创建失败"));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data);
        const remoteStatus = normalizeRemoteStatus(state.status);
        const progress = normalizeProgress(state.progress);
        if (["succeeded", "completed", "done"].includes(remoteStatus)) {
            const url = videoResultUrl(state);
            if (!url) return { status: "failed", remoteStatus, error: "Seedance 任务成功但没有返回视频 URL" };
            return { status: "completed", remoteStatus, progress: 100, resultUrl: url };
        }
        if (["failed", "cancelled", "canceled", "expired"].includes(remoteStatus)) return { status: "failed", remoteStatus, error: readApiErrorMessage(state.error?.message) || `Seedance 视频生成${remoteStatus === "expired" ? "超时" : "失败"}` };
        return { status: "pending", remoteStatus, progress };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(policy: VideoReferencePolicy, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], optimizedCounter?: { count: number }) {
    const limits = VIDEO_REFERENCE_POLICY_LIMITS[policy];
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, limits.images)) {
        const result = policy === "allUrlMultimodal" ? await resolvePublicVideoReferenceImageUrl(image) : await resolveVideoReferenceImageBase64(image);
        if (result.optimized && optimizedCounter) optimizedCounter.count += 1;
        content.push({ type: "image_url", image_url: { url: result.url }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, limits.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolvePublicReferenceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, limits.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolvePublicReferenceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveVideoReferenceImageBase64(image: ReferenceImage) {
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl?.startsWith("data:image/")) throw new Error("参考图需要能读取为 Base64，请换一张图片或重新上传");
    const optimized = await optimizeVideoReferenceImageDataUrl(dataUrl);
    return { url: optimized.dataUrl, optimized: optimized.optimized };
}

async function resolvePublicVideoReferenceImageUrl(image: ReferenceImage) {
    const directUrl = image.url || (!image.dataUrl?.startsWith("data:") && !image.dataUrl?.startsWith("blob:") ? image.dataUrl : "");
    try {
        const dataUrl = await imageToDataUrl(image);
        if (dataUrl?.startsWith("data:image/")) {
            const optimized = await optimizeVideoReferenceImageDataUrl(dataUrl);
            if (optimized.optimized || !isPublicMediaUrl(directUrl)) {
                const blob = await (await fetch(optimized.dataUrl)).blob();
                return { url: await uploadForPublicUrl(blob, "image"), optimized: optimized.optimized };
            }
        }
    } catch (error) {
        if (!isPublicMediaUrl(directUrl)) throw error;
    }
    if (isPublicMediaUrl(directUrl)) return { url: directUrl, optimized: false };

    let blob: Blob | null = image.storageKey ? await getImageBlob(image.storageKey) : null;
    if (!blob && image.dataUrl) blob = await (await fetch(image.dataUrl)).blob();
    if (!blob && image.url?.startsWith("blob:")) blob = await (await fetch(image.url)).blob();
    if (!blob) throw new Error("参考图片必须是公网 URL，或本地已保存的图片");
    return { url: await uploadForPublicUrl(blob, "image"), optimized: false };
}

async function resolvePublicReferenceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url)) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL，或本地已保存的视频");
    return uploadForPublicUrl(blob, "video");
}

async function resolvePublicReferenceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url)) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL，或本地已保存的音频");
    return uploadForPublicUrl(blob, "audio");
}

async function videoResultFromUrl(url: string, options?: Pick<VideoRequestOptions, "signal">): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持视频生成，请使用 OpenAI 格式渠道");
}

function getVideoReferencePolicy(model: string): VideoReferencePolicy {
    const name = modelOptionName(model).trim().toLowerCase();
    if (ALL_URL_MULTIMODAL_VIDEO_MODELS.has(name)) return "allUrlMultimodal";
    if (BASE64_IMAGE_ONLY_VIDEO_MODELS.has(name)) return "imageBase64Only";
    return "imageBase64Only";
}

function assertVideoReferencePolicy(policy: VideoReferencePolicy, images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    const limits = VIDEO_REFERENCE_POLICY_LIMITS[policy];
    if (policy === "imageBase64Only") {
        if (videos.length || audios.length) throw new Error(`当前视频模型参数 ${limits.code}：最多支持 9 张图片，图片以 Base64 发送，不支持视频或音频参考`);
        if (images.length > limits.images) throw new Error(`当前视频模型参数 ${limits.code}：最多支持 9 张图片`);
        return;
    }
    if (images.length > limits.images || videos.length > limits.videos || audios.length > limits.audios) {
        throw new Error(`当前视频模型参数 ${limits.code}：最多支持 ${limits.images} 张图片、${limits.videos} 个视频、${limits.audios} 个音频，且素材会以公网 URL 发送`);
    }
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoAspectRatio(value: string) {
    if (!value || value === "auto") return "16:9";
    if (/^\d+\s*:\s*\d+$/.test(value)) return value.replace(/\s+/g, "");
    const match = value.match(/^(\d+)x(\d+)$/);
    if (match) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (width && height) return width >= height ? "16:9" : "9:16";
    }
    return ["9:16", "2:3", "3:4"].includes(value) ? "9:16" : "16:9";
}

function normalizeRemoteStatus(status: string | undefined) {
    return status?.trim().toLowerCase() || "unknown";
}

function normalizeProgress(progress: number | undefined) {
    if (typeof progress !== "number" || !Number.isFinite(progress)) return undefined;
    return Math.max(0, Math.min(100, progress));
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse | SeedanceTask) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return `服务返回了 HTML 错误页面（${value.slice(0, 80)}...）`;
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error 可能是字符串或含 message 的对象
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        const responseData = error.response?.data;
        const raw = readApiErrorMessage(responseData);
        if (raw && /get_channel_failed/i.test(raw)) return "渠道不可用或额度不足";
        return raw || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

async function readJimeng933AxiosError(error: unknown, fallback: string) {
    return readJimengAxiosError(error, fallback, "933");
}

async function readJimengOfficialAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;
        const raw = responseData instanceof Blob ? readJimeng933ErrorMessage(await responseData.text()) : readJimeng933ErrorMessage(responseData);
        return raw || (error.response?.status ? `${fallback}（${error.response.status}）` : fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

async function readJimengAxiosError(error: unknown, fallback: string, provider: "431" | "933") {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;
        const raw = responseData instanceof Blob ? readJimeng933ErrorMessage(await responseData.text()) : readJimeng933ErrorMessage(responseData);
        return raw || jimengStatusMessage(error.response?.status, fallback, provider);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function readJimeng933ErrorMessage(value: unknown): string {
    if (typeof value === "string") {
        try {
            return readJimeng933ErrorMessage(JSON.parse(value)) || value;
        } catch {
            return readApiErrorMessage(value);
        }
    }
    if (!value || typeof value !== "object") return "";
    const payload = value as { error?: unknown; message?: unknown; msg?: unknown; detail?: unknown };
    return readApiErrorMessage(payload.error) || readApiErrorMessage(payload.message) || readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.detail);
}

function jimeng933StatusMessage(status: number | undefined, fallback: string) {
    return jimengStatusMessage(status, fallback, "933");
}

function jimengStatusMessage(status: number | undefined, fallback: string, provider: "431" | "933") {
    if (status === 400) return `${fallback}：模型、时长、分辨率、比例、分镜或文本参数无效`;
    if (status === 401) return "GPTCH API Key 无效或缺失";
    if (status === 402 || status === 403) return "GPTCH 余额不足或没有模型权限";
    if (status === 413) return `${provider} 即梦请求体、文件大小或素材数量超限`;
    if (status === 415) return `${provider} 即梦请求 Content-Type 不受支持`;
    if (status === 422) return `${provider} 即梦素材内容、尺寸、时长或组合无效`;
    if (status === 429) return `${provider} 即梦请求过快或当前没有可用容量，请稍后重试`;
    if (status === 500 || status === 502 || status === 503 || status === 504) return "GPTCH 或上游服务暂时异常，请稍后查询已有任务";
    return status ? `${fallback}（${status}）` : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (blob.type.startsWith("video/")) return;
    let payload: { code?: number; msg?: string; message?: string; error?: { message?: string } };
    try {
        const text = await blob.slice(0, 65_536).text();
        if (!blob.type.includes("json") && !/^\s*[\[{]/.test(text)) return;
        payload = JSON.parse(text) as { code?: number; msg?: string; message?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || "视频下载失败");
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
    if (payload.message || payload.msg) throw new Error(readApiErrorMessage(payload) || "视频下载失败");
    throw new Error("视频下载接口返回了 JSON，而不是视频文件");
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

type PublicUploadKind = "image" | "video" | "audio";

async function uploadForPublicUrl(blob: Blob, hint: PublicUploadKind): Promise<string> {
    if (!UPLOAD_BASE) {
        throw new Error(`431 模型需要把本地${uploadKindLabel(hint)}转换为公网 URL，请配置 VITE_UPLOAD_BASE 外部上传服务`);
    }
    const ext = blob.type.split("/")[1]?.split(";")[0] || (hint === "image" ? "png" : hint === "video" ? "mp4" : "mp3");
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    return uploadToExternalServer(blob, name, hint);
}

async function uploadToExternalServer(blob: Blob, name: string, hint: PublicUploadKind) {
    const res = await fetch(`${UPLOAD_BASE}/upload?name=${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob,
    });
    if (!res.ok) throw new Error(`上传${uploadKindLabel(hint)}失败（${res.status}）`);
    const json = (await res.json()) as { url?: string };
    if (!json.url) throw new Error("上传服务未返回 URL");
    return json.url;
}

function uploadKindLabel(kind: PublicUploadKind) {
    return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}
