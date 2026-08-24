import { useEffect, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2, Square, Volume2 } from "lucide-react";
import { Button, Switch, Tooltip } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { isJimeng933FastVideoModel, normalizeVideoResolutionValue } from "@/components/video-settings-panel";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { boolConfig } from "@/lib/seedance-video";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { NodeGenerationContext } from "./canvas-node-generation";
import type { NodeGenerationInput } from "./canvas-node-generation";
import { isJimeng933VideoConfig } from "@/lib/jimeng933-video";
import { isJimengOfficialVideoConfig } from "@/lib/jimeng-official-video";
import { CanvasExpandedGenerationPanel } from "./canvas-expanded-generation-panel";
import { CanvasReferenceThumbnailStrip } from "./canvas-reference-thumbnail-strip";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // 插件节点用 useBuiltinPanel.mode 指定生成类型
    videoStructure?: NodeGenerationContext;
    inputs?: NodeGenerationInput[];
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], onImageSettingsOpenChange, modeOverride, videoStructure, inputs = [], expanded = false, onExpandedChange }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(node.metadata?.prompt || "");
    const hasStoryboard = mode === "video" && Boolean(videoStructure?.shots?.length);
    const isJimengOfficial = mode === "video" && isJimengOfficialVideoConfig(config);

    // 仅在切换到其它节点时恢复对应提示词;同一节点生成完成后继续保留当前输入。
    useEffect(() => {
        setPrompt(node.metadata?.prompt || "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (!isEditingExistingContent) onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if ((!text && !hasStoryboard) || isRunning) return;
        onGenerate(node.id, mode, text);
    };
    const changeVideoModel = (model: string) => onConfigChange(node.id, { model, ...(isJimeng933FastVideoModel(config, model) && normalizeVideoResolutionValue(config.vquality) === "1080" ? { vquality: "720" } : {}) });

    const panel = (
        <div
            data-canvas-no-zoom
            className={expanded ? "flex h-full min-h-0 flex-col" : "relative rounded-2xl border p-3 shadow-2xl backdrop-blur"}
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {!expanded ? (
                <Tooltip title="展开编辑面板">
                    <Button type="text" className="!absolute !right-2 !top-2 !z-20 !grid !size-8 !min-w-8 !place-items-center !rounded-lg !p-0" icon={<Maximize2 className="size-3.5" />} onClick={() => onExpandedChange?.(true)} aria-label="展开编辑面板" />
                </Tooltip>
            ) : null}
            <CanvasReferenceThumbnailStrip inputs={inputs} expanded={expanded} />
            <CanvasPromptChipInput
                value={prompt}
                references={mentionReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                fill={expanded}
                className={expanded ? "thin-scrollbar h-full min-h-0 w-full cursor-text rounded-xl px-3 py-2 text-sm leading-5 outline-none" : "thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 pr-10 text-sm leading-5 outline-none"}
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent)}
            />

            {mode === "video" && videoStructure ? <VideoStructureSummary context={videoStructure} duration={Number(config.videoSeconds)} supported={isJimeng933VideoConfig(config) || isJimengOfficial} validateLocally={!isJimengOfficial} theme={theme} /> : null}

            <div className="mt-2 flex min-w-0 shrink-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={changeVideoModel} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasVideoSettingsPopover config={config} model={config.model} scaleOverride={expanded ? 1 : undefined} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                            <label className="flex h-10 shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs" style={{ color: theme.node.muted }} title="是否让视频模型生成声音">
                                <Volume2 className="size-3.5" />
                                <span>声音</span>
                                <Switch size="small" checked={boolConfig(config.videoGenerateAudio, true)} onChange={(checked) => onConfigChange(node.id, { generateAudio: String(checked) })} />
                            </label>
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasTextSettingsPopover config={config} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} />
                        </>
                    )}
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={isRunning}
                    disabled={!isRunning && !prompt.trim() && !hasStoryboard}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={isRunning ? "停止生成" : "生成"}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">停止</span>
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
        </div>
    );

    return expanded ? <CanvasExpandedGenerationPanel title={node.title || "节点"} onClose={() => onExpandedChange?.(false)}>{panel}</CanvasExpandedGenerationPanel> : panel;
}

function VideoStructureSummary({ context, duration, supported, validateLocally, theme }: { context: NodeGenerationContext; duration: number; supported: boolean; validateLocally: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const roles = Object.values(context.imageRoles);
    const first = roles.filter((role) => role === "first_frame").length;
    const last = roles.filter((role) => role === "last_frame").length;
    const conflict = validateLocally && (first > 1 || last > 1 || Boolean(context.storyboardError) || Boolean(context.shots && context.storyboardDuration !== duration));
    if (!first && !last && !context.storyboardCount) return null;
    return (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11px]" style={{ borderColor: theme.node.stroke, color: conflict ? theme.frame.conflict : theme.node.muted }}>
            <span>首帧 {first}</span><span>尾帧 {last}</span>
            {context.storyboardCount ? <span>分镜 {context.shots?.length || 0} 镜 / {context.storyboardDuration} 秒</span> : null}
            {!supported ? <span className="ml-auto">当前渠道不支持首尾帧与结构化分镜</span> : conflict ? <span className="ml-auto">请修正配置后再生成</span> : null}
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        videoSize: node.metadata?.videoSize || globalConfig.videoSize || defaultConfig.videoSize,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoSeedEnabled: node.metadata?.seedEnabled || globalConfig.videoSeedEnabled || defaultConfig.videoSeedEnabled,
        videoSeed: node.metadata?.seed || globalConfig.videoSeed || defaultConfig.videoSeed,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean) {
    if (mode === "video") return "描述要生成的视频内容";
    if (mode === "audio") return "描述要生成的音频内容";
    if (mode === "image") return hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoSize") return { videoSize: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoSeedEnabled") return { seedEnabled: value };
    if (key === "videoSeed") return { seed: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
