import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const mcp = process.argv.includes('--mcp');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [mcp ? 'src/mcp/server.ts' : 'src/extension.ts'],
  bundle: true,
  outfile: mcp ? 'dist/mcp-server.js' : 'dist/extension.js',
  external: mcp
    ? []
    : ['ag-grid-community', 'vscode', 'cpu-features', 'pino'],
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
  console.error(`[esbuild] watching ${mcp ? 'MCP server' : 'extension'}...`);
} else {
  await esbuild.build(options);
  console.error(`[esbuild] ${mcp ? 'MCP server' : 'extension'} build done`);
}
