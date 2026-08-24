import type { VideoImageRole, VideoShot } from "@/lib/jimeng933-video";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

export const JIMENG_OFFICIAL_MODELS = ["seedance-2.0-0826-480p", "seedance-2.0-0826-720p", "seedance-2.0-fast-0826-480p", "seedance-2.0-fast-0826-720p"] as const;
export const JIMENG_OFFICIAL_RATIO_OPTIONS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"] as const;

export type JimengOfficialReferenceType = "image" | "video" | "audio";
export type JimengOfficialReference = { id: string; type: JimengOfficialReferenceType; source: string };

const ratioMap: Record<string, string> = {
    "1280x720": "16:9",
    "720x1280": "9:16",
    "1024x1024": "1:1",
    "1792x1024": "16:9",
    "1024x1792": "9:16",
    auto: "adaptive",
};

export function isJimengOfficialVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "apiFormat">) {
    const selectedModel = config.model || config.videoModel;
    const requestConfig = "channels" in config && selectedModel.includes("::") ? resolveModelRequestConfig(config, selectedModel) : config;
    return requestConfig.apiFormat === "jimengOfficial";
}

export function isJimengOfficialModel(model: string) {
    return JIMENG_OFFICIAL_MODELS.includes(model as (typeof JIMENG_OFFICIAL_MODELS)[number]);
}

export function normalizeJimengOfficialRatio(value: string) {
    const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
    return ratioMap[normalized] || normalized || "16:9";
}

export function jimengOfficialModelResolution(model: string) {
    return model.endsWith("-480p") ? "480p" : model.endsWith("-720p") ? "720p" : "";
}

export function orderJimengOfficialReferences<T extends { id: string; type: JimengOfficialReferenceType }>(references: T[], imageRoles?: Record<string, VideoImageRole>) {
    return references
        .map((reference, index) => ({ reference, index, rank: jimengOfficialReferenceRank(reference, imageRoles) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(({ reference }) => reference);
}

export function buildJimengOfficialRequest(input: {
    model: string;
    prompt: string;
    negativePrompt?: string;
    aspectRatio: string;
    generateAudio: boolean;
    seed?: number;
    shots?: VideoShot[];
    imageRoles?: Record<string, VideoImageRole>;
    references: JimengOfficialReference[];
}) {
    const references = orderJimengOfficialReferences(input.references, input.imageRoles);
    const taskMode = jimengOfficialTaskMode(references, input.imageRoles);
    return {
        model: input.model,
        ...(input.prompt.trim() ? { prompt: input.prompt } : {}),
        ...(input.negativePrompt !== undefined ? { negative_prompt: input.negativePrompt } : {}),
        seconds: "15",
        aspect_ratio: normalizeJimengOfficialRatio(input.aspectRatio),
        generate_audio: input.generateAudio,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.shots !== undefined ? { shots: input.shots.map(({ prompt, duration }) => ({ prompt, duration })) } : {}),
        task_mode: taskMode,
        ...(references.length ? { references: references.map(({ type, source }) => ({ type, role: "reference" as const, source })) } : {}),
    };
}

function jimengOfficialTaskMode(references: JimengOfficialReference[], imageRoles?: Record<string, VideoImageRole>) {
    if (!references.length) return "text";
    const images = references.filter((reference) => reference.type === "image");
    if (images.some((reference) => imageRoles?.[reference.id] === "last_frame")) return "first_last_frame";
    if (images.some((reference) => imageRoles?.[reference.id] === "first_frame")) return "first_frame";
    return "references";
}

function jimengOfficialReferenceRank(reference: { id: string; type: JimengOfficialReferenceType }, imageRoles?: Record<string, VideoImageRole>) {
    if (reference.type === "image" && imageRoles?.[reference.id] === "first_frame") return 0;
    if (reference.type === "image" && imageRoles?.[reference.id] === "last_frame") return 1;
    if (reference.type === "image") return 2;
    if (reference.type === "video") return 3;
    return 4;
}
