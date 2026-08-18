import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Webview 前端构建：
// - 开发模式: vite dev server（HMR），webview 加载 http://localhost:5173
// - 生产模式: 输出到 ../webview-dist（相对路径资源，插件 asWebviewUri 加载）
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './', // 相对路径，适配 webview 的 vscode-webview:// 资源加载
  build: {
    outDir: '../webview-dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    // webview CSP 需要 inline，这里关闭单独 html 构建行为（保持单入口）
    rollupOptions: {
      input: 'index.html',
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      // webview 开发模式加载需要（VSCode 不允许 eval 等，宽松 CSP 由宿主控制）
      'Access-Control-Allow-Origin': '*',
    },
  },
});
