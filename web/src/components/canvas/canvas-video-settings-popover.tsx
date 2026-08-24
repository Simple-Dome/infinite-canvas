import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { isJimengOfficialVideoConfig, jimengOfficialModelResolution, normalizeJimengOfficialRatio } from "@/lib/jimeng-official-video";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { useCanvasViewport } from "./infinite-canvas";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    model: string;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    scaleOverride?: number;
};

export function CanvasVideoSettingsPopover({ config, model, onConfigChange, buttonClassName, placement = "topLeft", scaleOverride }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const viewport = useCanvasViewport();
    const scale = scaleOverride ?? viewport.k;
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const isJimengOfficial = isJimengOfficialVideoConfig(resolveModelRequestConfig(config, model));
    const syncPosition = useCallback(() => setButtonRect(buttonRef.current?.getBoundingClientRect() || null), []);

    useLayoutEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(syncPosition);
        return () => cancelAnimationFrame(frame);
    }, [open, scale, syncPosition, viewport.x, viewport.y]);

    useEffect(() => {
        if (!open) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open, syncPosition]);

    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} scale={scale} theme={theme} config={config} model={model} onConfigChange={onConfigChange} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {isJimengOfficial ? `${jimengOfficialModelResolution(modelOptionName(model))} · ${videoSizeLabel(normalizeJimengOfficialRatio(config.videoSize))} · 15s` : `${videoResolutionLabel(config.vquality)} · ${videoSizeLabel(config.videoSize)} · ${videoSecondsLabel(config.videoSeconds)}`}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    scale,
    theme,
    config,
    model,
    onConfigChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    scale: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    model: string;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const safeScale = Math.max(scale, 0.05);
    const visualWidth = width * safeScale;
    const visualGap = gap * safeScale;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - visualWidth / 2 : alignRight ? buttonRect.right - visualWidth : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const availableHeight = topPlacement ? buttonRect.top - visualGap - margin : window.innerHeight - buttonRect.bottom - visualGap - margin;
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - visualWidth - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + visualGap } : { top: buttonRect.bottom + visualGap }),
        maxHeight: Math.max(1, availableHeight / safeScale),
        transform: `scale(${safeScale})`,
        transformOrigin: topPlacement ? "bottom left" : "top left",
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <VideoSettingsPanel config={config} model={model} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
        </div>,
        document.body,
    );
}
