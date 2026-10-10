/**
 * AppShell —— 响应式分支(架构 §6.4):
 *   窄屏 (<md): Tab 切换 [杯子] / [看板] / [对话]
 *   宽屏 (>=md): 看板(内含对话卡) + 悬浮杯(可拖 / 可收圆点)
 *
 * 两种布局共用同一个 useCupData,数据源同一份。
 */
import { useEffect, useRef, useState } from 'react';
import { MockSource } from './data/mock.ts';
import { SimulatorSource } from './data/simulator.ts';
import { CloudSource } from './data/cloud.ts';
import { useCupData } from './data/useCupData.ts';
import { useChat } from './data/useChat.ts';
import { currentStateLabel } from './data/simulator.ts';
import type { DataSource } from './data/source.ts';
import { Dashboard } from './components/BoardView.tsx';
import { CupWidget } from './components/CupWidget.tsx';
import { FloatingCup } from './components/FloatingCup.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';

type Tab = 'cup' | 'board' | 'chat';

/** 窄屏底部 Tab(顺序即展示顺序) */
const TABS: { key: Tab; label: string }[] = [
  { key: 'cup', label: '杯子' },
  { key: 'board', label: '看板' },
  { key: 'chat', label: '对话' },
];

/**
 * ?cloud=<apiBase>  连后端(推荐,M1 之后):如 ?cloud=http://localhost:8788
 * ?key=<key>        写端点鉴权(R10-B 起写端点默认要 x-api-key);仅云模式有意义
 * ?mock=1           本地假数据(模拟器也没起时的兜底)
 * ?ws=ws://…        直连模拟器(不经后端)
 * 默认直连 localhost:8787 的模拟器
 */
function makeSource(): DataSource {
  const q = new URLSearchParams(location.search);
  const cloud = q.get('cloud');
  if (cloud !== null) {
    return new CloudSource({
      apiBase: cloud,
      cupId: q.get('cup') ?? undefined,
      // `?key=`(空串)与缺省同样视为未配 → undefined,不把空 key 当已配置
      apiKey: q.get('key') || undefined,
    });
  }
  if (q.get('mock') === '1') return new MockSource();
  return new SimulatorSource(q.get('ws') ?? undefined);
}

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export function App() {
  const { frame, events, state, server, report, proactive, series, history, personality, ask, goal, setGoal } =
    useCupData(makeSource);
  // 对话状态上提到这里:窄屏 Tab 与宽屏内嵌卡共享同一份记录/草稿
  const chat = useChat(ask, proactive);
  const wide = useWide();
  const [tab, setTab] = useState<Tab>('board');
  const [showCup, setShowCup] = useState(true);
  const [chatUnread, setChatUnread] = useState(false);
  // 长期性格底色:后端战报给;模拟器/mock 无战报 → normal
  const disposition = report?.disposition ?? 'normal';

  // 主动插话到、而用户没在对话 tab/宽屏看板(那儿直接看得到)→ chat tab 亮未读点
  const proactiveCount = proactive.length;
  const chatVisible = wide || tab === 'chat';
  const prevProactive = useRef(proactiveCount);
  useEffect(() => {
    const grew = proactiveCount > prevProactive.current;
    prevProactive.current = proactiveCount;
    if (grew && !chatVisible) setChatUnread(true);
  }, [proactiveCount, chatVisible]);
  // 进对话(或宽屏能看到对话卡)即已读
  useEffect(() => {
    if (chatVisible) setChatUnread(false);
  }, [chatVisible]);

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-cup-veil/60 bg-cup-mist/80 px-4 py-2 backdrop-blur">
        <h1 className="text-base font-bold text-cup-deep">🥤 杯子</h1>
        <span
          className="flex items-center gap-1.5 text-xs text-cup-ink-soft"
          title={`数据源:${state}`}
        >
          <i
            className={`inline-block h-2 w-2 rounded-full ${
              state === 'open' ? 'bg-cup-aqua' : 'bg-cup-warm'
            }`}
          />
          {currentStateLabel(state)}
        </span>
      </header>

      {/* 断线/出错:不再只靠顶部小圆点,给一条显眼的横幅(仍零依赖) */}
      {state !== 'open' && (
        <div
          className={`flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium ${
            state === 'connecting'
              ? 'bg-cup-foam text-cup-ink-soft'
              : 'bg-cup-ember/15 text-cup-ember'
          }`}
          role="status"
        >
          <i
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              state === 'connecting' ? 'bg-cup-warm' : 'bg-cup-ember'
            }`}
          />
          {state === 'connecting' ? '正在连接数据源…' : `${currentStateLabel(state)} · 数据可能不是最新的`}
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto">
        {wide ? (
          <Dashboard
            frame={frame}
            events={events}
            server={server}
            report={report}
            series={series}
            history={history}
            personality={personality}
            goal={goal}
            setGoal={setGoal}
            chat={chat}
            showChat
            disposition={disposition}
          />
        ) : tab === 'cup' ? (
          <div className="grid h-full place-items-center p-6">
            <CupWidget
              lid={frame?.lid}
              base={frame?.base}
              size={260}
              disposition={disposition}
            />
          </div>
        ) : tab === 'chat' ? (
          <div className="h-full p-4">
            <ChatPanel chat={chat} fill />
          </div>
        ) : (
          <Dashboard
            frame={frame}
            events={events}
            server={server}
            report={report}
            series={series}
            history={history}
            personality={personality}
            goal={goal}
            setGoal={setGoal}
            disposition={disposition}
          />
        )}
      </main>

      {/* 宽屏:悬浮杯。窄屏杯子 Tab 里已有,这里不显示 */}
      {wide && showCup && (
        <FloatingCup lid={frame?.lid} base={frame?.base} disposition={disposition} />
      )}

      {/* 窄屏底部 Tab;宽屏用一个小开关控制悬浮杯显隐 */}
      {!wide ? (
        <nav className="flex border-t border-cup-veil/60 bg-white/80 backdrop-blur">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
                if (key === 'chat') setChatUnread(false);
              }}
              className={`flex-1 py-3 text-sm font-medium ${
                tab === key ? 'text-cup-deep' : 'text-cup-ink-soft'
              }`}
            >
              <span className="relative inline-block">
                {label}
                {key === 'chat' && chatUnread && (
                  <>
                    <span
                      className="absolute -right-2.5 -top-1 h-1.5 w-1.5 rounded-full bg-cup-ember ring-2 ring-white/80"
                      aria-hidden="true"
                    />
                    <span className="sr-only">有新消息</span>
                  </>
                )}
              </span>
            </button>
          ))}
        </nav>
      ) : (
        <button
          onClick={() => setShowCup((v) => !v)}
          className="fixed bottom-4 left-4 z-40 rounded-full bg-white/80 px-3 py-1.5 text-xs text-cup-ink-soft shadow ring-1 ring-cup-veil/60 backdrop-blur"
        >
          {showCup ? '隐藏杯子' : '显示杯子'}
        </button>
      )}
    </div>
  );
}
