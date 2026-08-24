import { describe, expect, test } from "bun:test";

import { JIMENG_OFFICIAL_MODELS, buildJimengOfficialRequest, isJimengOfficialModel, jimengOfficialModelResolution, normalizeJimengOfficialRatio, orderJimengOfficialReferences } from "./jimeng-official-video";

describe("official Jimeng protocol", () => {
    test("exposes only the four official models", () => {
        expect(JIMENG_OFFICIAL_MODELS).toEqual(["seedance-2.0-0826-480p", "seedance-2.0-0826-720p", "seedance-2.0-fast-0826-480p", "seedance-2.0-fast-0826-720p"]);
        expect(JIMENG_OFFICIAL_MODELS.every(isJimengOfficialModel)).toBe(true);
        expect(isJimengOfficialModel("firefly-video-v2")).toBe(false);
        expect(jimengOfficialModelResolution("seedance-2.0-fast-0826-480p")).toBe("480p");
    });

    test("normalizes canvas sizes to official aspect ratios", () => {
        expect(normalizeJimengOfficialRatio("1280x720")).toBe("16:9");
        expect(normalizeJimengOfficialRatio("720x1280")).toBe("9:16");
        expect(normalizeJimengOfficialRatio("auto")).toBe("adaptive");
        expect(normalizeJimengOfficialRatio("21 : 9")).toBe("21:9");
    });

    test("orders first frame, last frame and normal multimodal references without rejecting duplicate roles", () => {
        const references = [
            { id: "audio", type: "audio" as const, source: "https://r2/audio" },
            { id: "normal", type: "image" as const, source: "https://r2/normal" },
            { id: "last-a", type: "image" as const, source: "https://r2/last-a" },
            { id: "video", type: "video" as const, source: "https://r2/video" },
            { id: "first-a", type: "image" as const, source: "https://r2/first-a" },
            { id: "first-b", type: "image" as const, source: "https://r2/first-b" },
        ];
        expect(orderJimengOfficialReferences(references, { "first-a": "first_frame", "first-b": "first_frame", "last-a": "last_frame" }).map((item) => item.id)).toEqual(["first-a", "first-b", "last-a", "normal", "video", "audio"]);
    });

    test("builds first-last-frame JSON and preserves explicit false, zero and shot durations", () => {
        const body = buildJimengOfficialRequest({
            model: "seedance-2.0-fast-0826-720p",
            prompt: "镜头推进",
            negativePrompt: "模糊",
            aspectRatio: "adaptive",
            generateAudio: false,
            seed: 0,
            shots: [
                { id: "shot-1", prompt: "远景", duration: 7 },
                { id: "shot-2", prompt: "近景", duration: 8 },
            ],
            imageRoles: { first: "first_frame", last: "last_frame" },
            references: [
                { id: "last", type: "image", source: "https://r2/last" },
                { id: "first", type: "image", source: "https://r2/first" },
            ],
        });

        expect(body).toEqual({
            model: "seedance-2.0-fast-0826-720p",
            prompt: "镜头推进",
            negative_prompt: "模糊",
            seconds: "15",
            aspect_ratio: "adaptive",
            generate_audio: false,
            seed: 0,
            shots: [
                { prompt: "远景", duration: 7 },
                { prompt: "近景", duration: 8 },
            ],
            task_mode: "first_last_frame",
            references: [
                { type: "image", role: "reference", source: "https://r2/first" },
                { type: "image", role: "reference", source: "https://r2/last" },
            ],
        });
        expect("duration" in body).toBe(false);
        expect("resolution" in body).toBe(false);
    });

    test("uses text, references and first_frame task modes without local business validation", () => {
        const base = { model: "seedance-2.0-0826-480p", prompt: "test", aspectRatio: "16:9", generateAudio: true };
        expect(buildJimengOfficialRequest({ ...base, references: [] }).task_mode).toBe("text");
        expect(buildJimengOfficialRequest({ ...base, references: [{ id: "normal", type: "image", source: "https://r2/normal" }] }).task_mode).toBe("references");
        expect(buildJimengOfficialRequest({ ...base, imageRoles: { first: "first_frame" }, references: [{ id: "first", type: "image", source: "https://r2/first" }] }).task_mode).toBe("first_frame");
    });
});
