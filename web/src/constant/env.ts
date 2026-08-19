export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// 发布 profile 可在构建时锁定所有渠道的上游地址。
export const FIXED_API_BASE_URL = (import.meta.env.VITE_FIXED_API_BASE_URL || "").trim().replace(/\/+$/, "");

// 官方插件清单地址:CI 发布到 plugins-dist 分支,经 jsDelivr 远程拉取;可用环境变量覆盖成自建来源
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";

// 431 多模态视频接口要求参考素材使用公网 URL。配置后，浏览器会把本地素材上传到该外部服务。
export const UPLOAD_BASE = (import.meta.env.VITE_UPLOAD_BASE || "").replace(/\/+$/, "");
