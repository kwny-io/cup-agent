/**
 * Node 加载器钩子:借 esbuild 即时转译 .ts/.tsx,使 `node --test` 能直接跑组件测试。
 *
 * 为什么需要它:web 测试跑在原生 `node --test` 上,Node 24 的类型剥离**拒绝 `.tsx`**
 * (实测 `Unknown file extension ".tsx"`),而组件都是 .tsx。esbuild 已在依赖树里
 * (vite 带来),用它转译零新增运行时依赖;jsdom 只负责给 DOM,两件事互不耦合。
 *
 * 只接管 .ts/.tsx:其余(.json/.js/.mjs)交回 Node 默认加载器,避免误伤。
 * 输出 esm + jsx:automatic(对应 tsconfig 的 "jsx":"react-jsx")。
 */
import { transform } from 'esbuild';

const TS = /\.(ts|tsx)$/;

export async function load(url, context, nextLoad) {
  if (!TS.test(new URL(url).pathname)) return nextLoad(url, context);

  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const source = await readFile(fileURLToPath(url), 'utf8');

  // .tsx 用 tsx loader(认 JSX),.ts 用 ts loader。两处都开 jsx:automatic。
  const loader = url.endsWith('.tsx') ? 'tsx' : 'ts';
  const { code } = await transform(source, {
    loader,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    sourcefile: url,
    // 保留 import.meta / 顶层 await 语义;esbuild 转译不改模块图,裸导入交回 Node 解析。
  });

  return { format: 'module', source: code, shortCircuit: true };
}
