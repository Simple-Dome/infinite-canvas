import { type ReactNode } from "react";
import { Slider, Switch } from "antd";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { JIMENG431_DURATION_OPTIONS, JIMENG431_RATIO_OPTIONS, JIMENG431_RESOLUTION_OPTIONS, isJimeng431VideoConfig, normalizeJimeng431Ratio, normalizeJimeng431Resolution } from "@/lib/jimeng431-video";
import { JIMENG933_DURATION_OPTIONS, JIMENG933_RATIO_OPTIONS, JIMENG933_RESOLUTION_OPTIONS, isJimeng933VideoConfig, normalizeJimeng933Ratio, normalizeJimeng933Resolution } from "@/lib/jimeng933-video";
import { JIMENG_OFFICIAL_RATIO_OPTIONS, isJimengOfficialVideoConfig, jimengOfficialModelResolution, normalizeJimengOfficialRatio } from "@/lib/jimeng-official-video";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceDurationOptions, seedancePixelLabel, seedanceRatioOptions, seedanceResolutionOptions } from "@/lib/seedance-video";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];

const sizeOptions = [
    { value: "1280x720", label: "横屏", width: 1280, height: 720 },
    { value: "720x1280", label: "竖屏", width: 720, height: 1280 },
    { value: "1024x1024", label: "方形", width: 1024, height: 1024 },
    { value: "1792x1024", label: "宽屏", width: 1792, height: 1024 },
    { value: "1024x1792", label: "长图", width: 1024, height: 1792 },
    { value: "auto", label: "auto", width: 0, height: 0 },
];

const secondOptions = Array.from({ length: 15 }, (_, index) => index + 1);

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = sizeOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSecondOptions = secondOptions.map((value) => String(value));
type VideoSettingsPanelProps = {
    config: AiConfig;
    model: string;
    onConfigChange: (key: "vquality" | "videoSize" | "videoSeconds" | "videoGenerateAudio" | "videoSeedEnabled" | "videoSeed" | "videoWatermark", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, model, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const requestConfig = resolveModelRequestConfig(config, model);
    if (isJimengOfficialVideoConfig(requestConfig)) {
        return <JimengOfficialVideoSettingsPanel config={config} model={model} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} />;
    }
    if (isSeedanceVideoConfig(requestConfig)) {
        return <SeedanceVideoSettingsPanel config={config} model={model} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} />;
    }

    const isJimeng431 = isJimeng431VideoConfig(requestConfig);
    const isJimeng933 = isJimeng933VideoConfig(requestConfig);
    const seconds = config.videoSeconds || "5";
    const size = normalizeVideoSizeValue(config.videoSize);
    const dimensions = readSizeDimensions(size);
    const resolution = isJimeng431 ? normalizeJimeng431Resolution(config.vquality) : isJimeng933 ? normalizeJimeng933Resolution(config.vquality) : normalizeVideoResolutionValue(config.vquality);
    const ratio = isJimeng431 ? normalizeJimeng431Ratio(config.videoSize) : normalizeJimeng933Ratio(config.videoSize);
    const currentResolutionOptions = isJimeng431 ? JIMENG431_RESOLUTION_OPTIONS.map(optionItem) : isJimeng933 ? JIMENG933_RESOLUTION_OPTIONS.map(optionItem) : resolutionOptions;
    const currentRatioOptions = isJimeng431 ? JIMENG431_RATIO_OPTIONS : isJimeng933 ? JIMENG933_RATIO_OPTIONS : null;
    const currentDurationOptions = isJimeng431 ? JIMENG431_DURATION_OPTIONS : isJimeng933 ? JIMENG933_DURATION_OPTIONS : null;
    const invalidResolution = !currentResolutionOptions.some((item) => item.value.replace(/p$/, "") === resolution.replace(/p$/, ""));
    const invalidRatio = Boolean(currentRatioOptions && !currentRatioOptions.includes(ratio as never));
    const invalidDuration = Boolean(currentDurationOptions && !currentDurationOptions.includes(Number(seconds) as never));
    const fast1080Disabled = isJimeng933FastVideoModel(config, model);
    const generateAudio = boolConfig(config.videoGenerateAudio, true);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
        onConfigChange("videoSize", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                <SettingGroup title="清晰度" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {currentResolutionOptions.map((item) => (
                            <OptionPill key={item.value} selected={resolution.replace(/p$/, "") === item.value.replace(/p$/, "")} disabled={fast1080Disabled && item.value.replace(/p$/, "") === "1080"} title={fast1080Disabled && item.value.replace(/p$/, "") === "1080" ? "Fast 模型不支持 1080p" : undefined} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                    {invalidResolution ? <InvalidSettingHint>当前保存的 {config.vquality || "空值"} 不受此模型支持，请重新选择</InvalidSettingHint> : null}
                </SettingGroup>
                <SettingGroup title="尺寸" color={theme.node.muted}>
                    {currentRatioOptions ? (
                        <div className="grid grid-cols-3 gap-2.5">
                            {currentRatioOptions.map((value) => (
                                <button key={value} type="button" className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80" style={{ borderColor: ratio === value ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={() => onConfigChange("videoSize", value)}>
                                    <SizePreview width={ratioPreview(value).width} height={ratioPreview(value).height} color={theme.node.text} />
                                    <span>{ratioLabel(value)}</span>
                                    <span className="text-[10px] leading-none opacity-55">{value}</span>
                                </button>
                            ))}
                        </div>
                    ) : <><div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={size === "auto"} theme={theme} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={size === "auto"} theme={theme} onChange={(value) => updateDimension("height", value)} />
                    </div>
                    <div className="grid grid-cols-3 gap-2.5">
                        {sizeOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[78px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: size === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("videoSize", item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.label}</span>
                                {item.value === "auto" ? null : (
                                    <span className="text-[11px] leading-none opacity-55">
                                        {item.value}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div></>}
                    {invalidRatio ? <InvalidSettingHint>当前保存的 {config.videoSize || "空值"} 不受此模型支持，请重新选择</InvalidSettingHint> : null}
                </SettingGroup>
                <SettingGroup title="视频时长" color={theme.node.muted}>
                    {currentDurationOptions ? <div className="grid grid-cols-3 gap-2.5">
                        {currentDurationOptions.map((value) => <OptionPill key={value} selected={Number(seconds) === value} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>{value}s</OptionPill>)}
                    </div> : <div className="flex items-center gap-3">
                        <Slider
                            className="flex-1"
                            min={1}
                            max={15}
                            value={clampVideoSeconds(seconds)}
                            tooltip={{ open: false }}
                            onChange={(value) => onConfigChange("videoSeconds", String(value))}
                        />
                        <span className="w-9 text-right text-sm" style={{ color: theme.node.text }}>
                            {clampVideoSeconds(seconds)}s
                        </span>
                    </div>}
                    {invalidDuration ? <InvalidSettingHint>当前保存的 {seconds} 秒不受此模型支持，请重新选择</InvalidSettingHint> : null}
                </SettingGroup>
                <SettingGroup title="输出" color={theme.node.muted}>
                    <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                        <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                        <SeedControl config={config} max={isJimeng431 ? 4_294_967_295 : 2_147_483_647} theme={theme} onConfigChange={onConfigChange} />
                    </div>
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

function JimengOfficialVideoSettingsPanel({ config, model, onConfigChange, theme, showTitle, className }: VideoSettingsPanelProps) {
    const ratio = normalizeJimengOfficialRatio(config.videoSize);
    const resolution = jimengOfficialModelResolution(modelOptionName(model));
    const generateAudio = boolConfig(config.videoGenerateAudio, true);
    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                <SettingGroup title="清晰度（由模型决定）" color={theme.node.muted}>
                    <div className="flex h-9 items-center justify-center rounded-full border text-sm" style={{ borderColor: theme.node.text, color: theme.node.text }}>
                        {resolution || "由模型决定"}
                    </div>
                </SettingGroup>
                <SettingGroup title="尺寸" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {JIMENG_OFFICIAL_RATIO_OPTIONS.map((value) => (
                            <button key={value} type="button" className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80" style={{ borderColor: ratio === value ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={() => onConfigChange("videoSize", value)}>
                                <SizePreview width={ratioPreview(value).width} height={ratioPreview(value).height} color={theme.node.text} />
                                <span>{ratioLabel(value)}</span>
                                <span className="text-[10px] leading-none opacity-55">{value}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title="视频时长" color={theme.node.muted}>
                    <div className="flex h-9 items-center justify-center rounded-full border text-sm" style={{ borderColor: theme.node.text, color: theme.node.text }}>15s（固定）</div>
                </SettingGroup>
                <SettingGroup title="输出" color={theme.node.muted}>
                    <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                        <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                        <SeedControl config={config} theme={theme} onConfigChange={onConfigChange} />
                    </div>
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

function SeedanceVideoSettingsPanel({ config, onConfigChange, theme, showTitle, className }: VideoSettingsPanelProps) {
    const resolution = normalizeSeedanceResolution(config.vquality);
    const ratio = normalizeSeedanceRatio(config.videoSize);
    const duration = normalizeSeedanceDuration(config.videoSeconds);
    const generateAudio = boolConfig(config.videoGenerateAudio, true);
    const watermark = boolConfig(config.videoWatermark, false);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                <SettingGroup title="分辨率" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceResolutionOptions.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title="比例" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                                style={{ borderColor: ratio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("videoSize", item.value)}
                            >
                                <SizePreview width={ratioPreview(item.value).width} height={ratioPreview(item.value).height} color={theme.node.text} />
                                <span>{item.label}</span>
                                <span className="text-[10px] leading-none opacity-55">{item.value === "adaptive" ? "adaptive" : seedancePixelLabel(resolution, item.value)}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title="时长" color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {seedanceDurationOptions.map((value) => (
                            <OptionPill key={value} selected={duration === value} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                {value === -1 ? "智能" : `${value}s`}
                            </OptionPill>
                        ))}
                    </div>
                    <NumberInput value={String(duration)} min={-1} max={15} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} />
                </SettingGroup>
                <SettingGroup title="输出" color={theme.node.muted}>
                    <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                        <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                        <SeedControl config={config} theme={theme} onConfigChange={onConfigChange} />
                        <SwitchRow label="添加水印" checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} />
                    </div>
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    return `${normalizeVideoResolutionValue(value)}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = normalizeSeedanceRatio(value);
    if (value === "adaptive" || value === "auto") return "自适应";
    if (ratio === value) return seedanceRatioOptions.find((item) => item.value === ratio)?.label || ratio;
    const size = normalizeVideoSizeValue(value);
    return sizeOptions.find((item) => item.value === size)?.label || size;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return "智能";
    return `${value || "5"}s`;
}

function clampVideoSeconds(value: string) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return 5;
    return Math.min(15, Math.max(1, parsed));
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    if (value === "1:1") return "1024x1024";
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "480p" || value === "low") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

export function isJimeng933FastVideoModel(config: AiConfig, model: string) {
    const requestConfig = resolveModelRequestConfig(config, model);
    return requestConfig.apiFormat === "jimeng933" && modelOptionName(model) === "firefly-video-v2-fast";
}

function OptionPill({ selected, disabled = false, title, theme, onClick, children }: { selected: boolean; disabled?: boolean; title?: string; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} title={title} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function NumberInput({ value, min, max, disabled = false, theme, onChange }: { value: string; min: number; max: number; disabled?: boolean; theme: CanvasTheme; onChange: (value: string) => void }) {
    return <input type="number" min={min} max={max} disabled={disabled} className="h-9 rounded-full border bg-transparent px-3 text-center text-sm outline-none disabled:cursor-not-allowed disabled:opacity-40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }} value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />;
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function ratioPreview(ratio: string) {
    if (ratio === "9:16") return { width: 9, height: 16 };
    if (ratio === "1:1") return { width: 1, height: 1 };
    if (ratio === "4:3") return { width: 4, height: 3 };
    if (ratio === "3:4") return { width: 3, height: 4 };
    if (ratio === "21:9") return { width: 21, height: 9 };
    if (ratio === "adaptive") return { width: 0, height: 0 };
    return { width: 16, height: 9 };
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-3">
            <span className="text-sm" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="small" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}

function SeedControl({ config, max = 2_147_483_647, theme, onConfigChange }: Pick<VideoSettingsPanelProps, "config" | "theme" | "onConfigChange"> & { max?: number }) {
    const enabled = boolConfig(config.videoSeedEnabled, false);
    return (
        <div className="grid gap-2">
            <SwitchRow label="固定 Seed" checked={enabled} theme={theme} onChange={(checked) => onConfigChange("videoSeedEnabled", String(checked))} />
            {enabled ? <NumberInput value={config.videoSeed || "0"} min={0} max={max} theme={theme} onChange={(value) => onConfigChange("videoSeed", value)} /> : null}
        </div>
    );
}

function optionItem(value: string) {
    return { value, label: value };
}

function ratioLabel(value: string) {
    if (value === "16:9") return "横屏";
    if (value === "9:16") return "竖屏";
    if (value === "1:1") return "方形";
    if (value === "4:3") return "标准横屏";
    if (value === "3:4") return "标准竖屏";
    if (value === "adaptive") return "自适应";
    return "宽银幕";
}

function InvalidSettingHint({ children }: { children: ReactNode }) {
    return <div className="text-xs text-red-500 dark:text-red-400">{children}</div>;
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}
