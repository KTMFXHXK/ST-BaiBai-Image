import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// 浏览器从 /scripts/extensions/third-party/ST-BaiBai-Image/dist/index.js 加载,
// 想 import 宿主 ST 的模块时需要算出从 dist/ 回到 ST public/ 根的相对路径。
// `@sillytavern/scripts/xxx` -> `../../../../../scripts/xxx.js`,并标为 external,
// 这样 ST 自身的代码不会被打进我们的包里,运行时浏览器直接走相对路径。
const relative_sillytavern_path = path.relative(
  path.join(__dirname, 'dist'),
  __dirname.substring(0, __dirname.lastIndexOf('public') + 'public'.length),
);

// ST 已在全局挂载的第三方库,映射到全局变量,避免重复打包。
const globals: Record<string, string> = {
  jquery: '$',
  lodash: '_',
  toastr: 'toastr',
};

const package_json = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
};
const package_version = String(package_json.version ?? '');

export default defineConfig(({ mode }) => ({
  define: {
    __BBI_VERSION__: JSON.stringify(package_version),
  },

  plugins: [
    {
      // 仅测试期生效:vitest 默认把 .vue 当 SSR 模块转译,plugin-vue 于是只产出
      // `ssrRender`(客户端渲染器会报「missing template or render function」),
      // 而且会给每个 SFC 套一层 `useSSRContext()` 包装(node 环境没有 SSR 上下文,
      // 挂载直接抛错)。这里把该次转译的 ssr 标记翻成 false,让组件按浏览器路径编译。
      // 生产构建的 ssr 本来就是 false,因此对 dist 产物零影响。
      name: 'bbi-test-client-vue',
      enforce: 'pre',
      transform(_code, id, options) {
        if (!process.env.VITEST) return null;
        if (id.endsWith('.vue') && options?.ssr) options.ssr = false;
        return null;
      },
    },
    vue(),
    {
      name: 'sillytavern-resolver',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith('@sillytavern/')) {
          return {
            id:
              path
                .join(relative_sillytavern_path, id.replace('@sillytavern/', ''))
                .replaceAll('\\', '/') + '.js',
            external: true,
          };
        }
        if (id in globals) {
          return { id, external: true };
        }
      },
    },
  ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  build: {
    rollupOptions: {
      input: 'src/index.ts',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].[hash].chunk.js',
        assetFileNames: '[name].[ext]',
        globals,
      },
      external: id => id in globals,
    },
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: mode === 'production' ? true : 'inline',
    minify: mode === 'production',
    target: 'esnext',
  },
}));
