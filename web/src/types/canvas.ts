export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Storyboard = "storyboard",
    Audio = "audio",
    Group = "group",
}

export type CanvasStoryboardOrderMode = "list" | "custom";

export type CanvasStoryboardShot = {
    id: string;
    prompt: string;
    duration: number;
    order?: number;
};

export type CanvasVideoFrameRole = "first_frame" | "last_frame";

// 节点类型放开为字符串,内置类型用 CanvasNodeType,插件类型为 "<pluginId>:<name>"
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "recoverable" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasRemoteVideoTask = {
    id: string;
    provider: "openai" | "seedance" | "jimeng933" | "jimeng431" | "plugin";
    model: string;
    remoteStatus: string;
    remoteProgress?: number;
    displayProgress?: number;
    autoResume: boolean;
    createdAt: number;
    lastCheckedAt?: number;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    videoSize?: string;
    quality?: string;
    background?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    seedEnabled?: string;
    seed?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    groupId?: string;
    interactive?: boolean; // 插件节点「交互 ⇄ 移动」开关状态(见 CanvasNodeDefinition.interactionToggle)
    remoteVideoTask?: CanvasRemoteVideoTask;
    storyboardShots?: CanvasStoryboardShot[];
    storyboardOrderMode?: CanvasStoryboardOrderMode;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    targetRole?: CanvasVideoFrameRole;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
