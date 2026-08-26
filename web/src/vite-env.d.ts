/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
    // 发布 profile 可锁定 Canvas API 与文档入口。
    readonly VITE_FIXED_API_BASE_URL?: string;
    readonly VITE_DOCS_URL?: string;
    // 逗号分隔的本地开发插件 URL,每次启动重新拉取(不缓存、不落库)
    readonly VITE_DEV_PLUGINS?: string;
    // 统计分析（可选，构建期注入）：每家一个独立变量，填了谁就启用谁，可同时启用多家
    // GA4 衡量 ID（G-XXXX）
    readonly VITE_ANALYTICS_GA4_ID?: string;
    // 百度统计站点 ID
    readonly VITE_ANALYTICS_BAIDU_ID?: string;
}
