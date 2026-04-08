window.CLOUD_SYNC_CONFIG = Object.assign(
  {
    // 若網站仍部署在 GitHub Pages 或以 file:// 開啟，請填入 Worker URL。
    // 若前端與 Worker 同網域部署在 Cloudflare，可留空改走 location.origin。
    apiBaseUrl: '',
  },
  window.CLOUD_SYNC_CONFIG || {}
);
