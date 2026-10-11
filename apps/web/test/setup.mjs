/**
 * 组件测试的启动引导(`node --import ./test/setup.mjs`)。
 *
 * 做两件事,都在测试进程启动时一次:
 *   1. 注册 esbuild 即时转译钩子 —— 让 `node --test` 能加载 .ts/.tsx(见 esbuild-loader.mjs);
 *   2. 装一套 jsdom 全局(window/document/navigator…),把浏览器 API 补齐,
 *      使 React 组件能真挂载、真响应事件。
 *
 * 为什么要把两者分开:转译与 DOM 是两件互不耦合的事(一个解决"能不能读源码",
 * 一个解决"有没有 window"),分开写便于单独定位问题。
 */
import { register } from 'node:module';
import { JSDOM } from 'jsdom';

register('./esbuild-loader.mjs', import.meta.url);

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true, // 提供 requestAnimationFrame
});

const { window } = dom;

// 把 jsdom 的全局摊到 globalThis 上,让组件里的裸 `document` / `window` 可用。
// Node 24 自带只读的 `navigator` getter,故用 defineProperty 覆盖而非直接赋值。
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
  writable: true,
});
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.localStorage = window.localStorage;

// 组件用 React 19 的 act 环境标志,否则会打"not wrapped in act"警告噪音。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 无 canvas:给 getContext 一个惰性桩,使 CupWidget/EyePreview 这类画布组件
// 能在测试里挂载而不抛 "not implemented"。测试只验 DOM 结构/交互,不验像素。
// 方法名全列出来(而非逐个手写),因为组件会持续新增绘制调用 —— 漏一个就整组挂。
const CTX_METHODS = [
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath',
  'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'quadraticCurveTo',
  'bezierCurveTo', 'rect', 'roundRect', 'fill', 'stroke', 'clip',
  'save', 'restore', 'translate', 'scale', 'rotate', 'transform', 'setTransform',
  'resetTransform', 'drawImage', 'putImageData', 'setLineDash', 'createPattern',
  'fillText', 'strokeText',
];
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  const ctx = {
    canvas: this,
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
  // 属性:可读可写,读时给合理默认(布尔/数值各归其类)。
  for (const key of ['fillStyle', 'strokeStyle', 'font', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin', 'globalCompositeOperation']) {
    let v = '';
    Object.defineProperty(ctx, key, {
      configurable: true,
      get: () => v,
      set: (nv) => {
        v = nv;
      },
    });
  }
  for (const key of ['lineWidth', 'globalAlpha', 'miterLimit', 'shadowBlur']) {
    let v = key === 'lineWidth' || key === 'miterLimit' ? 1 : 0;
    Object.defineProperty(ctx, key, {
      configurable: true,
      get: () => v,
      set: (nv) => {
        v = nv;
      },
    });
  }
  for (const key of ['imageSmoothingEnabled', 'shadowOffsetX', 'shadowOffsetY']) {
    let v = false;
    Object.defineProperty(ctx, key, {
      configurable: true,
      get: () => v,
      set: (nv) => {
        v = nv;
      },
    });
  }
  for (const name of CTX_METHODS) ctx[name] = () => {};
  return ctx;
};
