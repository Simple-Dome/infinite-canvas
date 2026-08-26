import { afterEach, describe, expect, mock, test } from "bun:test";
import axios from "axios";

import { defaultConfig, encodeChannelModel, type AiConfig } from "@/stores/use-config-store";
import { createVideoGenerationTask, downloadVideoGenerationTask, getVideoPollingPolicy, pollVideoGenerationTask, readVideoSeed, type VideoGenerationTask } from "./video";

const realAxiosPost = axios.post;
const realAxiosGet = axios.get;

afterEach(() => {
    axios.post = realAxiosPost;
    axios.get = realAxiosGet;
});

describe("readVideoSeed", () => {
    test("does not send Seed while the switch is off", () => {
        expect(readVideoSeed({ videoSeedEnabled: "false", videoSeed: "123" })).toBeUndefined();
    });

    test("keeps Seed 0 when the switch is on", () => {
        expect(readVideoSeed({ videoSeedEnabled: "true", videoSeed: "0" })).toBe(0);
    });

    test("rejects an invalid enabled Seed", () => {
        expect(() => readVideoSeed({ videoSeedEnabled: "true", videoSeed: "1.5" })).toThrow("Seed 必须是 0–4294967295 的整数");
    });

    test("accepts the 431 unsigned 32-bit maximum", () => {
        expect(readVideoSeed({ videoSeedEnabled: "true", videoSeed: "4294967295" })).toBe(4_294_967_295);
    });
});

describe("getVideoPollingPolicy", () => {
    test("polls OpenAI-compatible video tasks long enough for slow upstream completion", () => {
        const task: VideoGenerationTask = { id: "task_test", provider: "openai", model: "video-ds-2.0-fast" };

        const policy = getVideoPollingPolicy(task);

        expect(policy.delayMs).toBe(5000);
        expect(policy.maxAttempts * policy.delayMs).toBeGreaterThanOrEqual(20 * 60 * 1000);
        expect(policy.timeoutMessage).toBe("视频生成超时，请稍后重试");
    });

    test("keeps Seedance polling at the existing ten minute window", () => {
        const task: VideoGenerationTask = { id: "task_seedance", provider: "seedance", model: "seedance" };

        const policy = getVideoPollingPolicy(task);

        expect(policy.delayMs).toBe(5000);
        expect(policy.maxAttempts * policy.delayMs).toBe(10 * 60 * 1000);
        expect(policy.timeoutMessage).toBe("Seedance 视频生成超时，请稍后重试");
    });

    test("uses the long polling window for 933 Jimeng tasks", () => {
        const task: VideoGenerationTask = { id: "task_jimeng", provider: "jimeng933", model: "firefly-video-v2" };

        const policy = getVideoPollingPolicy(task);

        expect(policy.delayMs).toBe(5000);
        expect(policy.maxAttempts * policy.delayMs).toBeGreaterThanOrEqual(20 * 60 * 1000);
    });

    test("uses the long polling window for 431 Jimeng tasks", () => {
        const task: VideoGenerationTask = { id: "task_jimeng_431", provider: "jimeng431", model: "leonardo-seedance-2.0" };
        const policy = getVideoPollingPolicy(task);
        expect(policy.delayMs).toBe(5000);
        expect(policy.maxAttempts * policy.delayMs).toBeGreaterThanOrEqual(20 * 60 * 1000);
    });

    test("uses the long polling window for official Jimeng tasks", () => {
        const task: VideoGenerationTask = { id: "task_jimeng_official", provider: "jimengOfficial", model: "seedance-2.0-0826-720p" };
        const policy = getVideoPollingPolicy(task);
        expect(policy.delayMs).toBe(5000);
        expect(policy.maxAttempts * policy.delayMs).toBeGreaterThanOrEqual(20 * 60 * 1000);
    });
});

describe("official Jimeng video service", () => {
    test("creates a pure JSON official task against the configured localhost Base URL", async () => {
        const post = mock(async (url: string, body: unknown, options?: { headers?: Record<string, string> }) => {
            expect(url).toBe("http://localhost:3000/v1/videos");
            expect(options?.headers?.Authorization).toBe("Bearer local-token");
            expect(options?.headers?.["Content-Type"]).toBe("application/json");
            expect(options?.headers?.["Idempotency-Key"]).toBe("generation-json");
            expect(body).toEqual({ model: "seedance-2.0-0826-720p", prompt: "镜头前进", seconds: "15", aspect_ratio: "16:9", generate_audio: false, seed: 0, task_mode: "text" });
            return { data: { id: "task-official" } };
        });
        axios.post = post as typeof axios.post;

        const task = await createVideoGenerationTask(officialConfig(), { prompt: "镜头前进", seed: 0, images: [], videos: [], audios: [] }, { idempotencyKey: "generation-json" });

        expect(task).toEqual({ id: "task-official", provider: "jimengOfficial", model: "official::seedance-2.0-0826-720p", uploadSessionId: undefined });
        expect(post).toHaveBeenCalledTimes(1);
    });

    test("returns the upstream failed message unchanged", async () => {
        axios.get = mock(async () => ({ data: { status: "failed", progress: 35, error: { code: "UPSTREAM_REJECTED", message: "首尾帧组合不受支持" } } })) as typeof axios.get;
        const state = await pollVideoGenerationTask(officialConfig(), { id: "task-failed", provider: "jimengOfficial", model: "official::seedance-2.0-0826-720p" });
        expect(state).toEqual({ status: "failed", remoteStatus: "failed", progress: 35, error: "首尾帧组合不受支持" });
    });

    test("downloads official videos through the configured content endpoint", async () => {
        const get = mock(async (url: string, options?: { headers?: Record<string, string> }) => {
            expect(url).toBe("http://localhost:3000/v1/videos/task-completed/content");
            expect(options?.headers?.Authorization).toBe("Bearer local-token");
            return { data: new Blob(["video"], { type: "video/mp4" }) };
        });
        axios.get = get as typeof axios.get;
        const result = await downloadVideoGenerationTask(
            officialConfig(),
            { id: "task-completed", provider: "jimengOfficial", model: "official::seedance-2.0-0826-720p" },
            { status: "completed", remoteStatus: "completed", resultUrl: "https://upstream.example/video.mp4" },
        );
        expect(result.blob?.type).toBe("video/mp4");
        expect(get).toHaveBeenCalledTimes(1);
    });
});

function officialConfig(): AiConfig {
    const model = encodeChannelModel("official", "seedance-2.0-0826-720p");
    return {
        ...defaultConfig,
        model,
        videoModel: model,
        videoSize: "1280x720",
        videoGenerateAudio: "false",
        channels: [{ id: "official", name: "官方满血即梦", baseUrl: "http://localhost:3000", apiKey: "local-token", apiFormat: "jimengOfficial", models: [{ name: "seedance-2.0-0826-720p", capability: "video" }] }],
        models: [model],
    };
}
