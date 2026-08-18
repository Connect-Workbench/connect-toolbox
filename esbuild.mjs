import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // ag-grid 供 webview 使用，通过 asWebviewUri 直接引 node_modules 里的文件，不打进主 bundle
  external: ['ag-grid-community'],
  // vscode 由宿主提供；cpu-features 是 ssh2 的可选原生加速模块，
  // 保持 external，运行时 require 失败后 ssh2 自动回退纯 JS 实现
  // pino 含 worker/transport 逻辑，external 后运行时从 node_modules 加载最稳
  external: ['vscode', 'cpu-features', 'pino'],
  // ssh2 自编译的 sshcrypto.node 加速模块：复制到产物目录并重写引用；
  // 跨平台加载失败时 ssh2 自动回退 poly1305.js 纯 JS 实现
  loader: { '.node': 'file' },
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await esbuild.build(options);
  console.log('[esbuild] build done');
}
