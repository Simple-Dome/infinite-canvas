import { afterEach, describe, expect, mock, test } from "bun:test";

import { buildJimengOfficialR2ApiUrl, deleteJimengOfficialUploadSession, uploadJimengOfficialReferences } from "./jimeng-official-r2";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("official Jimeng R2 upload", () => {
    test("builds signer endpoints from the configured localhost Base URL", () => {
        expect(buildJimengOfficialR2ApiUrl("http://localhost:3002", "/api/canvas/r2/uploads/presign")).toBe("http://localhost:3002/api/canvas/r2/uploads/presign");
        expect(buildJimengOfficialR2ApiUrl("http://localhost:3002/v1/", "/api/canvas/r2/uploads/presign")).toBe("http://localhost:3002/api/canvas/r2/uploads/presign");
    });

    test("does not call the signer when the generation has no references", async () => {
        const fetchMock = mock(() => Promise.reject(new Error("unexpected fetch")));
        globalThis.fetch = fetchMock as typeof fetch;
        const result = await uploadJimengOfficialReferences({ baseUrl: "http://localhost:3002", apiKey: "token" }, { images: [], videos: [], audios: [] }, "generation-1");
        expect(result).toEqual({ references: [] });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("presigns through Base URL, uploads bytes directly to R2 and completes in frame-role order", async () => {
        let presignBody: { files: Array<{ client_file_id: string; kind: string; content_type: string; size: number }> } | undefined;
        const putHeaders: Headers[] = [];
        const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith("data:")) return realFetch(input, init);
            if (url === "http://localhost:3002/api/canvas/r2/uploads/presign") {
                const headers = new Headers(init?.headers);
                expect(headers.get("Authorization")).toBe("Bearer new-api-token");
                expect(headers.get("Idempotency-Key")).toBe("generation-2");
                presignBody = JSON.parse(String(init?.body));
                return Response.json({
                    session_id: "session-1",
                    files: presignBody!.files.map((file) => ({ client_file_id: file.client_file_id, object_key: `temp/${file.client_file_id}`, put_url: `https://r2.test/put/${file.client_file_id}`, put_headers: { "Content-Type": file.content_type } })),
                });
            }
            if (url.startsWith("https://r2.test/put/")) {
                const headers = new Headers(init?.headers);
                putHeaders.push(headers);
                expect(headers.has("Authorization")).toBe(false);
                expect(init?.body).toBeInstanceOf(Blob);
                return new Response(null, { status: 200 });
            }
            if (url === "http://localhost:3002/api/canvas/r2/uploads/complete") {
                expect(JSON.parse(String(init?.body))).toEqual({ session_id: "session-1" });
                return Response.json({
                    session_id: "session-1",
                    files: presignBody!.files.map((file) => ({ client_file_id: file.client_file_id, object_key: `temp/${file.client_file_id}`, source_url: `https://r2.test/read/${file.client_file_id}` })),
                });
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        globalThis.fetch = fetchMock as typeof fetch;

        const result = await uploadJimengOfficialReferences(
            { baseUrl: "http://localhost:3002/v1", apiKey: "new-api-token" },
            {
                images: [
                    { id: "normal", name: "normal.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" },
                    { id: "last", name: "last.png", type: "image/png", dataUrl: "data:image/png;base64,AQ==" },
                    { id: "first", name: "first.png", type: "image/png", dataUrl: "data:image/png;base64,Ag==" },
                ],
                videos: [{ id: "video", name: "video.mp4", type: "video/mp4", url: "data:video/mp4;base64,Aw==" }],
                audios: [{ id: "audio", name: "audio.mp3", type: "audio/mpeg", url: "data:audio/mpeg;base64,BA==" }],
                imageRoles: { first: "first_frame", last: "last_frame" },
            },
            "generation-2",
        );

        expect(presignBody?.files.map((file) => file.client_file_id)).toEqual(["image:first", "image:last", "image:normal", "video:video", "audio:audio"]);
        expect(result.sessionId).toBe("session-1");
        expect(result.references.map((reference) => reference.id)).toEqual(["first", "last", "normal", "video", "audio"]);
        expect(putHeaders).toHaveLength(5);
    });

    test("cleans a session through the configured Base URL with only the New API token", async () => {
        const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
            expect(String(input)).toBe("http://localhost:3002/api/canvas/r2/uploads/session%2Fone");
            expect(init?.method).toBe("DELETE");
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-a");
            return new Response(null, { status: 204 });
        });
        globalThis.fetch = fetchMock as typeof fetch;
        await deleteJimengOfficialUploadSession({ baseUrl: "http://localhost:3002", apiKey: "token-a" }, "session/one");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("cleans the upload session when a direct R2 upload fails", async () => {
        const requests: string[] = [];
        const fetchMock = mock(async (input: string | URL | Request) => {
            const url = String(input);
            requests.push(url);
            if (url.startsWith("data:")) return realFetch(input);
            if (url.endsWith("/api/canvas/r2/uploads/presign")) {
                return Response.json({ session_id: "failed-session", files: [{ client_file_id: "image:image-1", object_key: "temp/image-1", put_url: "https://r2.test/failed" }] });
            }
            if (url === "https://r2.test/failed") return new Response(null, { status: 500 });
            if (url.endsWith("/api/canvas/r2/uploads/failed-session")) return new Response(null, { status: 204 });
            throw new Error(`unexpected fetch ${url}`);
        });
        globalThis.fetch = fetchMock as typeof fetch;

        await expect(
            uploadJimengOfficialReferences(
                { baseUrl: "http://localhost:3002", apiKey: "token" },
                { images: [{ id: "image-1", name: "image.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }], videos: [], audios: [] },
                "generation-3",
            ),
        ).rejects.toThrow("上传图片「image.png」到 Cloudflare R2 失败（500）");
        expect(requests).toContain("http://localhost:3002/api/canvas/r2/uploads/failed-session");
    });
});
