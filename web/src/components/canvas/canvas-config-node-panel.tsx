import type { CSSProperties } from "react";
import { Image as ImageIcon, LoaderCircle, Maximize2, MessageSquare, Music2, Play, Settings2, Square, Video } from "lucide-react";
import { Button, Segmented, Tooltip } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { isJimeng933FastVideoModel, normalizeVideoResolutionValue } from "@/components/video-settings-panel";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { NodeGenerationContext, NodeGenerationInput } from "./canvas-node-generation";
import { CanvasConfigComposer } from "./canvas-config-composer";
import { CanvasExpandedGenerationPanel } from "./canvas-expanded-generation-panel";
import { isJimengOfficialVideoConfig } from "@/lib/jimeng-official-video";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    videoStructure?: NodeGenerationContext;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
    inputs: NodeGenerationInput[];
    composerValue: string;
    onComposerChange: (value: string) => void;
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
};

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, videoStructure, onConfigChange, onGenerate, onStop, onComposerToggle, inputs, composerValue, onComposerChange, expanded = false, onExpandedChange }: CanvasConfigNodePanelProps) {
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    const isJimengOfficial = mode === "video" && isJimengOfficialVideoConfig(config);
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const frameRoles = Object.values(videoStructure?.imageRoles || {});
    const firstFrameCount = frameRoles.filter((role) => role === "first_frame").length;
    const lastFrameCount = frameRoles.filter((role) => role === "last_frame").length;
    const storyboardMismatch = !isJimengOfficial && Boolean(videoStructure?.shots && videoStructure.storyboardDuration !== Number(config.videoSeconds));
    const conflictChipStyle = { ...chipStyle, borderColor: theme.frame.conflict, color: theme.frame.conflict };
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const canGenerate = hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput || (mode === "video" && Boolean(videoStructure?.shots?.length)));

    const panel = (
        <div className={expanded ? "flex h-full min-h-0 w-full flex-col text-sm" : "flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm"} style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className={`mb-2 flex shrink-0 items-center justify-between gap-3 ${expanded ? "pr-12" : ""}`}>
                <div className="shrink-0 text-sm font-semibold">生成配置</div>
                <div className="ml-auto flex cursor-default items-center gap-1" onMouseDown={(event) => event.stopPropagation()}>
                    {!expanded ? (
                        <Tooltip title="展开编辑面板">
                            <Button type="text" className="!grid !size-8 !min-w-8 !place-items-center !rounded-lg !p-0" icon={<Maximize2 className="size-3.5" />} onClick={() => onExpandedChange?.(true)} aria-label="展开编辑面板" />
                        </Tooltip>
                    ) : null}
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-md !p-0.5"
                        value={mode}
                        onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
                        options={[
                            {
                                value: "image",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <ImageIcon className="size-3.5" />
                                        生图
                                    </span>
                                ),
                            },
                            {
                                value: "text",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <MessageSquare className="size-3.5" />
                                        文本
                                    </span>
                                ),
                            },
                            {
                                value: "video",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Video className="size-3.5" />
                                        视频
                                    </span>
                                ),
                            },
                            {
                                value: "audio",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="size-3.5" />
                                        音频
                                    </span>
                                ),
                            },
                        ]}
                    />
                </div>
            </div>

            {expanded ? <CanvasConfigComposer value={composerValue} inputs={inputs} onChange={onComposerChange} variant="embedded" /> : null}

            <div className="mb-2 flex shrink-0 flex-wrap gap-1.5">
                <InputChip label="提示词" value={`${inputSummary.textCount} 个`} style={chipStyle} />
                <InputChip label="参考图" value={`${inputSummary.imageCount} 张`} style={chipStyle} />
                <InputChip label="参考视频" value={`${inputSummary.videoCount} 个`} style={chipStyle} />
                <InputChip label="参考音频" value={`${inputSummary.audioCount} 个`} style={chipStyle} />
                {mode === "video" && videoStructure?.storyboardCount ? <InputChip label="分镜" value={`${videoStructure.shots?.length || 0} 镜 / ${videoStructure.storyboardDuration} 秒`} style={storyboardMismatch || (!isJimengOfficial && videoStructure.storyboardError) ? conflictChipStyle : chipStyle} /> : null}
                {mode === "video" && firstFrameCount ? <InputChip label="首帧" value={`${firstFrameCount} 张`} style={!isJimengOfficial && firstFrameCount > 1 ? conflictChipStyle : chipStyle} /> : null}
                {mode === "video" && lastFrameCount ? <InputChip label="尾帧" value={`${lastFrameCount} 张`} style={!isJimengOfficial && lastFrameCount > 1 ? conflictChipStyle : chipStyle} /> : null}
                {!expanded ? (
                    <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]" style={chipStyle} onMouseDown={(event) => event.stopPropagation()} onClick={onComposerToggle}>
                        <Settings2 className="size-3.5" />
                        组装提示词
                    </button>
                ) : null}
            </div>

            <div className="mb-2 grid min-w-0 cursor-default grid-cols-[minmax(0,1fr)_148px] items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                <ModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model, ...(mode === "video" && isJimeng933FastVideoModel(config, model) && normalizeVideoResolutionValue(config.vquality) === "1080" ? { vquality: "720" } : {}) })} capability={mode} onMissingConfig={() => openConfigDialog(true)} fullWidth />
                {mode === "video" ? (
                    <CanvasVideoSettingsPopover config={config} model={config.model} scaleOverride={expanded ? 1 : undefined} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                ) : mode === "image" ? (
                    <CanvasImageSettingsPopover config={config} placement="topRight" autoAdjustOverflow={false} buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} />
                ) : mode === "audio" ? (
                    <CanvasAudioSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                ) : (
                    <CanvasTextSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} />
                )}
            </div>

            <Button
                type="primary"
                className="mt-auto !h-9 !w-full !cursor-pointer !rounded-lg"
                danger={isRunning}
                disabled={!isRunning && !canGenerate}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id))}
            >
                <span className="inline-flex items-center gap-1.5">
                    {isRunning ? (
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                            <span>停止</span>
                        </>
                    ) : (
                        <>
                            <Play className="size-4" />
                            <span>开始生成</span>
                        </>
                    )}
                </span>
            </Button>
        </div>
    );

    return expanded ? <CanvasExpandedGenerationPanel title={node.title || "生成配置"} onClose={() => onExpandedChange?.(false)}>{panel}</CanvasExpandedGenerationPanel> : panel;
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
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
