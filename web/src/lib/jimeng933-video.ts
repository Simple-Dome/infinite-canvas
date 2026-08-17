import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export const JIMENG933_VIDEO_MODELS = ["firefly-video-v2", "firefly-video-v2-fast"] as const;
export const JIMENG933_DURATION_OPTIONS = [5, 10, 15] as const;
export const JIMENG933_RESOLUTION_OPTIONS = ["480p", "720p", "1080p"] as const;
export const JIMENG933_RATIO_OPTIONS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const JIMENG933_REFERENCE_LIMITS = {
    images: 9,
    videos: 3,
    audios: 3,
    total: 12,
    imageMaxBytes: 30_000_000,
    videoTotalMaxBytes: 50_000_000,
    audioMaxBytes: 15_000_000,
    videoMinDurationMs: 2_000,
    videoMaxDurationMs: 15_000,
    audioTotalMaxDurationMs: 15_000,
} as const;

export type VideoShot = { id: string; prompt: string; duration: number };
export type VideoImageRole = "reference" | "first_frame" | "last_frame";

export type Jimeng933VideoValidationInput = {
    model: string;
    prompt: string;
    negativePrompt?: string;
    seed?: number;
    duration: number;
    resolution: string;
    aspectRatio: string;
    images: ReferenceImage[];
    videos: ReferenceVideo[];
    audios: ReferenceAudio[];
    imageRoles?: Record<string, VideoImageRole>;
    shots?: VideoShot[];
};

const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const videoMimeTypes = new Set(["video/mp4", "video/quicktime"]);
const audioMimeTypes = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"]);
const resolutionMap: Record<string, string> = {
    "480": "480p",
    "480p": "480p",
    low: "480p",
    "720": "720p",
    "720p": "720p",
    auto: "720p",
    medium: "720p",
    high: "720p",
    "1080": "1080p",
    "1080p": "1080p",
};
const ratioMap: Record<string, string> = {
    "1280x720": "16:9",
    "720x1280": "9:16",
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
};

export function isJimeng933VideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "apiFormat">) {
    const selectedModel = config.model || config.videoModel;
    const requestConfig = "channels" in config && selectedModel.includes("::") ? resolveModelRequestConfig(config, selectedModel) : config;
    return requestConfig.apiFormat === "jimeng933";
}

export function normalizeJimeng933Resolution(value: string) {
    return resolutionMap[String(value || "").trim().toLowerCase()] || String(value || "").trim().toLowerCase();
}

export function normalizeJimeng933Ratio(value: string) {
    const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
    return ratioMap[normalized] || normalized;
}

export function validateJimeng933VideoInput(input: Jimeng933VideoValidationInput): string | null {
    if (!JIMENG933_VIDEO_MODELS.includes(input.model as (typeof JIMENG933_VIDEO_MODELS)[number])) return "933 即梦仅支持 firefly-video-v2 和 firefly-video-v2-fast 模型";
    if (!JIMENG933_DURATION_OPTIONS.includes(input.duration as (typeof JIMENG933_DURATION_OPTIONS)[number])) return "933 即梦只支持 5、10、15 秒视频";
    if (!JIMENG933_RESOLUTION_OPTIONS.includes(input.resolution as (typeof JIMENG933_RESOLUTION_OPTIONS)[number])) return "933 即梦分辨率只支持 480p、720p、1080p";
    if (input.model === "firefly-video-v2-fast" && input.resolution === "1080p") return "firefly-video-v2-fast 不支持 1080p，请选择 480p 或 720p";
    if (!JIMENG933_RATIO_OPTIONS.includes(input.aspectRatio as (typeof JIMENG933_RATIO_OPTIONS)[number])) return "933 即梦画面比例只支持 21:9、16:9、4:3、1:1、3:4、9:16";
    if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2_147_483_647)) return "933 即梦 Seed 必须是 0–2147483647 的整数";

    if (input.shots !== undefined) {
        if (input.shots.length < 2 || input.shots.length > 15) return "933 即梦分镜数量必须为 2–15 个";
        let totalDuration = 0;
        for (let index = 0; index < input.shots.length; index += 1) {
            const shot = input.shots[index];
            if (!shot.prompt.trim()) return `分镜 ${index + 1} 的提示词不能为空`;
            if (!Number.isInteger(shot.duration) || shot.duration <= 0) return `分镜 ${index + 1} 的时长必须是正整数`;
            totalDuration += shot.duration;
        }
        if (totalDuration !== input.duration) return `933 即梦分镜总时长必须等于任务时长 ${input.duration} 秒`;
    } else if (!input.prompt.trim()) {
        return "请输入视频提示词";
    }

    const totalReferences = input.images.length + input.videos.length + input.audios.length;
    if (input.images.length > JIMENG933_REFERENCE_LIMITS.images) return "933 即梦最多支持 9 张图片（包含首帧和尾帧）";
    if (input.videos.length > JIMENG933_REFERENCE_LIMITS.videos) return "933 即梦最多支持 3 个参考视频";
    if (input.audios.length > JIMENG933_REFERENCE_LIMITS.audios) return "933 即梦最多支持 3 个参考音频";
    if (totalReferences > JIMENG933_REFERENCE_LIMITS.total) return "933 即梦图片、视频和音频合计最多支持 12 个素材";
    if (input.audios.length && !input.images.length && !input.videos.length) return "933 即梦参考音频不能单独使用，请同时添加参考图片或参考视频";

    const roleCounts = input.images.reduce(
        (counts, image) => {
            const role = input.imageRoles?.[image.id];
            if (role === "first_frame") counts.first += 1;
            if (role === "last_frame") counts.last += 1;
            return counts;
        },
        { first: 0, last: 0 },
    );
    if (roleCounts.first > 1) return "933 即梦最多只能设置一张首帧图片";
    if (roleCounts.last > 1) return "933 即梦最多只能设置一张尾帧图片";

    for (let index = 0; index < input.images.length; index += 1) {
        const image = input.images[index];
        if (!imageMimeTypes.has(normalizeMimeType(image.type))) return `图片 ${index + 1} 仅支持 JPEG、PNG、WebP 格式`;
        if (image.bytes !== undefined && image.bytes <= 0) return `图片 ${index + 1} 是空文件`;
        if (image.bytes !== undefined && image.bytes > JIMENG933_REFERENCE_LIMITS.imageMaxBytes) return `图片 ${index + 1} 超过 30,000,000 字节`;
    }

    let videoBytes = 0;
    let videoDurationMs = 0;
    for (let index = 0; index < input.videos.length; index += 1) {
        const video = input.videos[index];
        if (!videoMimeTypes.has(normalizeMimeType(video.type))) return `视频 ${index + 1} 仅支持 MP4、MOV 格式`;
        if (video.bytes !== undefined && video.bytes <= 0) return `视频 ${index + 1} 是空文件`;
        videoBytes += video.bytes || 0;
        videoDurationMs += video.durationMs || 0;
        if (video.width && video.height) {
            const shortEdge = Math.min(video.width, video.height);
            const longEdge = Math.max(video.width, video.height);
            if (shortEdge < 480 || shortEdge > 720 || longEdge > 1280) return `视频 ${index + 1} 尺寸不符合要求：短边需为 480–720px，长边不能超过 1280px`;
        }
    }
    if (videoBytes > JIMENG933_REFERENCE_LIMITS.videoTotalMaxBytes) return "933 即梦参考视频合计不能超过 50,000,000 字节";
    if (input.videos.length && videoDurationMs && (videoDurationMs < JIMENG933_REFERENCE_LIMITS.videoMinDurationMs || videoDurationMs > JIMENG933_REFERENCE_LIMITS.videoMaxDurationMs)) return "933 即梦参考视频合计时长需要在 2–15 秒之间";

    let audioDurationMs = 0;
    for (let index = 0; index < input.audios.length; index += 1) {
        const audio = input.audios[index];
        if (!audioMimeTypes.has(normalizeMimeType(audio.type))) return `音频 ${index + 1} 仅支持 MP3、WAV 格式`;
        if (audio.bytes !== undefined && audio.bytes <= 0) return `音频 ${index + 1} 是空文件`;
        if (audio.bytes !== undefined && audio.bytes > JIMENG933_REFERENCE_LIMITS.audioMaxBytes) return `音频 ${index + 1} 超过 15,000,000 字节`;
        audioDurationMs += audio.durationMs || 0;
    }
    if (audioDurationMs > JIMENG933_REFERENCE_LIMITS.audioTotalMaxDurationMs) return "933 即梦参考音频合计时长不能超过 15 秒";
    return null;
}

function normalizeMimeType(value: string) {
    return value.trim().toLowerCase().split(";", 1)[0];
}
