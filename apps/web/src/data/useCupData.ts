/**
 * 把 DataSource 接进 React 的 hook。
 *
 * 持有的状态:
 *   frame   最新一帧(杯盖/底座/事件)
 *   events  滚动事件列表(含历史,供战报/时间线用)
 *   state   连接状态
 *
 * 组件**只**用这个 hook 拿数据;DataSource 换了(hook 的 source 参数变了),
 * 组件不动。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SimulatorSource } from './simulator.ts';
import type {
  AskFn,
  ConnectionState,
  DataSource,
  LiveFrame,
  ProactiveMessage,
  ServerHistory,
  ServerPersonalityHistory,
  ServerReport,
  ServerToday,
  SetGoalFn,
  WeekSeries,
} from './source.ts';
import type { CupEvent } from '@cup/contract';
import { DAILY_GOAL_ML } from '../lib/stats.ts';
import { loadGoal } from '../lib/goal.ts';

const MAX_EVENTS = 500;
/** 主动消息滚动保留条数(杯子插话不长篇,留最近几条即可) */
const MAX_PROACTIVE = 20;

function defaultSource(): DataSource {
  const url = new URLSearchParams(location.search).get('ws');
  return new SimulatorSource(url ?? undefined);
}

export interface CupData {
  frame: LiveFrame | null;
  events: CupEvent[];
  state: ConnectionState;
  /** 后端今日快照;模拟器/本地源为 null,此时看板回退到前端现算 */
  server: ServerToday | null;
  /** 后端每日战报(文案 + 长期性格);无后端源为 null */
  report: ServerReport | null;
  /** 杯子主动搭话的滚动列表(仅 CloudSource 会推);无后端源时为空 */
  proactive: ProactiveMessage[];
  /** 近 7 天趋势(仅 CloudSource 会给);无后端源时 null,趋势卡显示空态 */
  series: WeekSeries | null;
  /** 历史战报(仅 CloudSource 会给);无后端源时 null,回看卡显示空态 */
  history: ServerHistory | null;
  /** 脾气变化史(仅 CloudSource 会给);无后端源时 null,养成卡显示空态 */
  personality: ServerPersonalityHistory | null;
  /** 问杯子一句话;不支持问答的源(纯模拟器)时为 null(没这条线) */
  ask: AskFn | null;
  /** 当前每日目标(云源以后端 /today 为准,mock 存本地);改目标后所有卡联动 */
  goal: number;
  /** 改每日目标;不支持写目标的源(纯模拟器)时为 null */
  setGoal: SetGoalFn | null;
}

export function useCupData(makeSource: () => DataSource = defaultSource): CupData {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [events, setEvents] = useState<CupEvent[]>([]);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [server, setServer] = useState<ServerToday | null>(null);
  const [report, setReport] = useState<ServerReport | null>(null);
  const [proactive, setProactive] = useState<ProactiveMessage[]>([]);
  const [series, setSeries] = useState<WeekSeries | null>(null);
  const [history, setHistory] = useState<ServerHistory | null>(null);
  const [personality, setPersonality] = useState<ServerPersonalityHistory | null>(null);
  /** 用户改过的目标(mock/离线时用);null = 没改过 → 回落到 server 或约定默认 */
  const [goalOverride, setGoalOverride] = useState<number | null>(null);
  const eventsRef = useRef<CupEvent[]>([]);
  const proactiveRef = useRef<ProactiveMessage[]>([]);

  const source = useMemo(makeSource, [makeSource]);

  useEffect(() => {
    const offFrame = source.on('frame', (f) => {
      setFrame(f);
      if (f.events.length > 0) {
        eventsRef.current = [...eventsRef.current, ...f.events].slice(-MAX_EVENTS);
        setEvents(eventsRef.current);
      }
    });
    const offState = source.on('state', setState);
    const offServer = source.on('server', setServer);
    const offReport = source.on('report', setReport);
    const offProactive = source.on('proactive', (m) => {
      proactiveRef.current = [...proactiveRef.current, m].slice(-MAX_PROACTIVE);
      setProactive(proactiveRef.current);
    });
    const offSeries = source.on('series', setSeries);
    const offHistory = source.on('history', setHistory);
    const offPersonality = source.on('personality', setPersonality);
    source.connect();
    return () => {
      offFrame();
      offState();
      offServer();
      offReport();
      offProactive();
      offSeries();
      offHistory();
      offPersonality();
      source.disconnect();
    };
  }, [source]);

  // 只有实现了 ask 的源(云 / mock)才有问答;用接口上的可选 ask,不靠强转
  const ask = useMemo<AskFn | null>(
    () => (source.ask ? (q: string) => source.ask!(q) : null),
    [source],
  );

  // 目标优先级:用户改过的(goalOverride)> 后端快照(server.goal_ml)> 本地存的(mock 离线)> 约定默认
  const goal = useMemo(
    () => goalOverride ?? server?.goal_ml ?? loadGoal(DAILY_GOAL_ML),
    [goalOverride, server?.goal_ml],
  );

  // 改目标:调源 + 成功后本地立刻反映(不等下一次 WS / 轮询)。
  // 记录 override 是因为纯 mock 源不会回推 ServerToday —— 没有它数字不会动。
  const setGoal = useMemo<SetGoalFn | null>(() => {
    if (!source.setGoal) return null;
    return async (goalMl: number) => {
      const res = await source.setGoal!(goalMl);
      if (res.ok) setGoalOverride(res.goalMl);
      return res;
    };
  }, [source]);

  return { frame, events, state, server, report, proactive, series, history, personality, ask, goal, setGoal };
}
