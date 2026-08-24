import { Button, Drawer, Input, Segmented, Select, Space } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { FIXED_API_BASE_URL } from "@/constant/env";
import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { JIMENG_OFFICIAL_MODELS } from "@/lib/jimeng-official-video";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "Gemini", value: "gemini" },
    { label: "火山方舟", value: "ark" },
    { label: "933 即梦", value: "jimeng933" },
    { label: "431 即梦", value: "jimeng431" },
    { label: "官方满血即梦", value: "jimengOfficial" },
];

const capabilityOptions: Array<{ label: string; value: ModelCapability }> = [
    { label: "生图", value: "image" },
    { label: "视频", value: "video" },
    { label: "文本", value: "text" },
    { label: "音频", value: "audio" },
];

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);

    useEffect(() => {
        if (open && channel) setDraft(channel);
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = FIXED_API_BASE_URL || (!draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl);
        const models = modelsForApiFormat(draft.models, apiFormat);
        patch({ apiFormat, baseUrl, models });
    };

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => map.get(name) || { name, capability: guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        const models = modelsForApiFormat(normalizeChannelModels(draft.models), draft.apiFormat);
        onSave({ ...draft, name: draft.name.trim() || "未命名渠道", models });
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={640}
            title="编辑渠道"
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" onClick={save}>
                        保存
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">渠道名称</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">协议</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">接口地址</span>
                    <Input value={FIXED_API_BASE_URL || draft.baseUrl} disabled={Boolean(FIXED_API_BASE_URL)} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                    {draft.apiFormat === "jimengOfficial" ? <span className="mt-1 block text-xs text-stone-500">本地联调填写 Cherry 地址 http://localhost:3000（画布仍运行在 3002）；参考素材会凭预签名地址从浏览器直传 Cloudflare R2。</span> : null}
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">渠道模型</div>
                    <div className="mt-0.5 text-xs text-stone-500">已选 {draft.models.length} 个；为每个模型指定能力并可自定义调用脚本。</div>
                </div>
                <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                    选择模型
                </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                {model.name}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                                <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                    {model.script ? "脚本已设" : "调用脚本"}
                                </Button>
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">点击「选择模型」拉取或手动增加模型。</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}

function modelsForApiFormat(models: ChannelModel[], apiFormat: ApiCallFormat) {
    if (apiFormat === "jimengOfficial") {
        const existing = new Map(models.map((model) => [model.name, model]));
        return JIMENG_OFFICIAL_MODELS.map((name) => ({ ...existing.get(name), name, capability: "video" as const }));
    }
    if (apiFormat === "jimeng431") return models.filter((model) => model.name === "leonardo-seedance-2.0" || model.name === "leonardo-seedance-2.0-fast").map((model) => ({ ...model, capability: "video" as const }));
    return models;
}
