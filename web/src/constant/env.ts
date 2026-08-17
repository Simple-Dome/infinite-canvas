export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// 官方插件清单地址:CI 发布到 plugins-dist 分支,经 jsDelivr 远程拉取;可用环境变量覆盖成自建来源
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";

// 431 多模态视频接口要求参考素材使用公网 URL。配置后，浏览器会把本地素材上传到该外部服务。
export const UPLOAD_BASE = (import.meta.env.VITE_UPLOAD_BASE || "").replace(/\/+$/, "");
