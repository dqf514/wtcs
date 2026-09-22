import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, hasMinRole, type Experiment, type MatrixStatus } from '../api'
import { SCENARIOS, type Scenario } from '../constants'
import { POINT_META } from '../paramMeta'
import { keyReadings } from '../subsystems'
import { useCommand } from '../hooks/useCommand'
import { useTelemetry } from '../hooks/useTelemetry'
import { MiniTrend } from '../components/AnalogBar'
import { CommandButton } from '../components/CommandButton'
import { ConfirmModal } from '../components/Modal'
import { Gauge } from '../components/Gauge'
import { Tabs } from '../components/Tabs'
import {
  IconDashboard,
  IconPlay,
  IconRestore,
  IconRrs,
  IconStop,
  IconSubsystems,
  IconTraverse,
  SUBSYSTEM_ICONS,
} from '../components/icons'
import { ToggleCommandButton } from '../components/ToggleCommandButton'

function pointValue(points: { key: string; value: unknown }[] | undefined, key: string) {
  return points?.find((p) => p.key === key)?.value
}

function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 读数格式化（对齐后端 _fmt_num 思路）：|v|<1e-6 显 0，否则 toFixed 后去尾零；非数值显 -- */
function fmtNum(v: unknown, digits = 2): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '--'
  if (Math.abs(n) < 1e-6) return '0'
  let s = n.toFixed(digits)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

/** 安全状态：正常中性，异常才着色（ISA-101 颜色只表异常） */
function safetyTone(s: string): '' | 'warn' | 'danger' {
  if (s === '急停' || s === '安全停机') return 'danger'
  if (s === '报警' || s === '预警') return 'warn'
  return ''
}

/** 仪器感读数卡片：label-cap + 大字 mono 读数 + 弱化说明/迷你趋势 */
function Instr({
  label,
  value,
  unit,
  sub,
  tone = '',
  trend,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  tone?: '' | 'warn' | 'danger'
  trend?: number[]
}) {
  return (
    <div className={`instr ${tone ? `instr--${tone}` : ''}`}>
      <span className="label-cap">{label}</span>
      <span className="instr-value mono">
        {value}
        {unit && <em>{unit}</em>}
      </span>
      {sub && <span className="instr-sub">{sub}</span>}
      {trend && trend.length > 1 && <MiniTrend values={trend} height={26} alert={tone !== ''} />}
    </div>
  )
}

/** 大图标命令按钮的统一样式入口 */
function Ctl({
  icon,
  label,
  title,
  variant,
  disabled,
  confirmMessage,
  confirmDanger,
  onClick,
}: {
  icon: ReactNode
  label: string
  title: string
  variant?: 'primary' | 'danger' | ''
  disabled?: boolean
  confirmMessage?: string
  confirmDanger?: boolean
  onClick: () => void
}) {
  return (
    <CommandButton variant={variant} title={title} icon={icon} disabled={disabled} confirmMessage={confirmMessage} confirmDanger={confirmDanger} onClick={onClick}>
      {label}
    </CommandButton>
  )
}

type QuickKind = 'run' | 'acquire' | 'belt' | 'moving'

/** 各子系统的快速启停命令映射（无参数下发，使用系统当前设定值）；safety 走顶栏急停，不在此列 */
const QUICK_CMD: Record<string, { start?: string; stop?: string; kind: QuickKind; label: string }> = {
  main_fan: { start: 'start', stop: 'stop', kind: 'run', label: '风机' },
  cooling_water: { start: 'start', stop: 'stop', kind: 'run', label: '冷却水' },
  rrs: { start: 'start_belt', stop: 'stop_belt', kind: 'belt', label: '路面' },
  traverse: { stop: 'stop', kind: 'moving', label: '移测架' },
  boundary_layer: { start: 'start', stop: 'stop', kind: 'run', label: '边界层' },
  purge_air: { start: 'start', stop: 'stop', kind: 'run', label: '吹扫风' },
  exhaust: { start: 'start', stop: 'stop', kind: 'run', label: '尾气抽排' },
  compressed_air: { start: 'start', stop: 'stop', kind: 'run', label: '压缩空气' },
  acoustic: { start: 'start_acquire', stop: 'stop_acquire', kind: 'acquire', label: '声学采集' },
  pressure: { start: 'start_acquire', stop: 'stop_acquire', kind: 'acquire', label: '压力采集' },
  flow_field: { start: 'start_acquire', stop: 'stop_acquire', kind: 'acquire', label: '流场采集' },
}

/** 运行状态判定：与子系统页 pairRunning 同规则（running/acquiring 点位、皮带速度、冷却水任一冷机、移测架运动中） */
function quickRunning(points: { key: string; value: unknown }[] | undefined, kind: QuickKind): boolean | null {
  const boolPt = (k: string): boolean | undefined => {
    const v = points?.find((p) => p.key === k)?.value
    if (v === undefined || v === null) return undefined
    return v === true || v === 1 || v === 'true'
  }
  if (kind === 'acquire') return boolPt('acquiring') ?? null
  if (kind === 'moving') return boolPt('moving') ?? null
  if (kind === 'belt') {
    const n = Number(pointValue(points, 'belt_speed'))
    return Number.isFinite(n) ? n > 0.01 : null
  }
  const r = boolPt('running')
  if (r !== undefined) return r
  const chillers = ['chiller1_on', 'chiller2_on', 'chiller3_on'].map(boolPt).filter((v): v is boolean => v !== undefined)
  if (chillers.length) return chillers.some(Boolean)
  return null
}

/** 子系统卡片角落的快速启停图标按钮：状态感知（▶ 启动 / ■ 停止），点击弹窗确认后下发 */
function QuickToggle({
  name,
  running,
  startCmd,
  stopCmd,
  onSend,
}: {
  name: string
  running: boolean | null
  startCmd?: string
  stopCmd?: string
  onSend: (cmd: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const isRunning = running === true
  const cmd = isRunning ? stopCmd : startCmd
  if (!cmd) return null
  const action = isRunning ? '停止' : '启动'
  return (
    <>
      <button
        type="button"
        className={`sub-card-quick ${isRunning ? 'danger' : 'primary'}`}
        title={`${action}${name}（按当前默认参数）`}
        aria-label={`${action}${name}`}
        onClick={() => setConfirming(true)}
      >
        {isRunning ? <IconStop size={13} /> : <IconPlay size={13} />}
      </button>
      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          onSend(cmd)
        }}
        title={`${action}${name}`}
        danger={isRunning}
        confirmLabel={action}
        message={`确认${action}「${name}」？将按当前默认参数执行。`}
      />
    </>
  )
}

export function DashboardPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const { frame, connected } = useTelemetry()
  const { send } = useCommand(toast)
  const navigate = useNavigate()
  const [scenario, setScenario] = useState<Scenario>('气动实验')
  const [speed, setSpeed] = useState(40)
  const [yaw, setYaw] = useState(0)
  const [history, setHistory] = useState<{ wind_speed: number; temperature: number }[]>([])

  // 执行态势：运行中的矩阵/实验流水线进度（5s 轮询，有则显示）
  const [execs, setExecs] = useState<MatrixStatus[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])

  // 初始场景消费系统设置 default_scenario（不再硬编码）；URL ?tab= 深链优先（由 Tabs 应用）
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab')) return
    api
      .settings()
      .then((s) => {
        const d = s.default_scenario
        if (typeof d === 'string' && (SCENARIOS as readonly string[]).includes(d)) setScenario(d as Scenario)
      })
      .catch(() => {})
  }, [])

  // 关键量迷你趋势（本地时序）
  useEffect(() => {
    const load = () => api.history(90).then(setHistory).catch(() => {})
    load()
    const t = window.setInterval(load, 5000)
    return () => window.clearInterval(t)
  }, [])

  // 执行态势轮询
  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const ms = await api.matrices()
        const running = ms.filter((m) => m.exec_status === 'running' || m.exec_status === 'paused')
        const stats = await Promise.all(running.map((m) => api.matrixStatus(m.id)))
        if (stop) return
        setExecs(stats)
        setExperiments(await api.experiments())
      } catch {
        /* 轮询失败静默，下周期重试 */
      }
    }
    load()
    const t = window.setInterval(load, 5000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [])

  const overview = frame?.overview
  const subsystems = useMemo(() => frame?.subsystems ?? [], [frame])
  const canCommand = hasMinRole('操作员')
  const canMaintain = hasMinRole('维护员')
  const mainFan = subsystems.find((s) => s.id === 'main_fan')
  const rrs = subsystems.find((s) => s.id === 'rrs')
  const bl = subsystems.find((s) => s.id === 'boundary_layer')
  const acoustic = subsystems.find((s) => s.id === 'acoustic')
  const exhaust = subsystems.find((s) => s.id === 'exhaust')

  const wind = overview?.wind_speed
  const temp = overview?.temperature
  const targetSpeed = num(pointValue(mainFan?.points, 'target_speed'))
  const beltSpeed = num(pointValue(rrs?.points, 'belt_speed'))
  const balanceFx = num(pointValue(rrs?.points, 'fx'))
  const fanRunning = pointValue(mainFan?.points, 'running') === true
  const beltRunning = beltSpeed != null && beltSpeed > 0.01
  const blRunning = pointValue(bl?.points, 'running') === true
  const acousticOn = pointValue(acoustic?.points, 'acquiring') === true
  const exhaustRunning = pointValue(exhaust?.points, 'running') === true
  // 风速正常带跟随设定值（无设定值时用静态区间）
  const windNormal: [number, number] =
    targetSpeed != null && targetSpeed > 0.5
      ? [Math.max(0, targetSpeed - 3), Math.min(POINT_META.wind_speed.max, targetSpeed + 3)]
      : POINT_META.wind_speed.normal

  const safety = overview?.safety ?? ''
  const estopActive = safety === '急停'
  const windTrend = history.map((h) => h.wind_speed)
  const tempTrend = history.map((h) => h.temperature)

  const activeExp = overview?.active_experiment_id
    ? experiments.find((x) => x.id === overview.active_experiment_id)
    : undefined
  const phase = overview?.experiment_phase ?? '空闲'
  const profileRun = overview?.profile && overview.profile.state === 'running' ? overview.profile : null
  const beltNormal = POINT_META.belt_speed.normal
  const beltOut = beltSpeed != null && (beltSpeed < beltNormal[0] || beltSpeed > beltNormal[1])
  const fxNormal = POINT_META.fx.normal
  const fxOut = balanceFx != null && (balanceFx < fxNormal[0] || balanceFx > fxNormal[1])

  return (
    <div>
      {estopActive && (
        <div className="estop-bar" role="alert">
          急停已激活：风机与全部运动机构已停止。故障排除后，由维护员在「安全」区执行急停复位。
        </div>
      )}

      <header className="page-head">
        <h1>场景总控</h1>
        <div className="page-head-side">
          <span className="badge">仿真 {overview?.simulation_count ?? 0} / 真机 {overview?.real_count ?? 0}</span>
          <span className={`badge ${connected ? 'ok' : 'warn'}`}>{connected ? '实时链路已连接' : '实时链路重连中'}</span>
        </div>
      </header>

      {/* 仪表带：风速主仪表 + 关键量仪器卡（正常中性色，越限才变色） */}
      <div className="grid-instr">
        <div className="instr instr--gauge">
          {/* 顶部标题与其余仪器卡位置一致；盘下读数区不再重复标签 */}
          <span className="label-cap">风速</span>
          <Gauge
            label=""
            value={wind}
            unit="m/s"
            min={POINT_META.wind_speed.min}
            max={POINT_META.wind_speed.max}
            normal={windNormal}
            setpoint={targetSpeed}
          />
          <span className="instr-sub">
            设定 {targetSpeed != null ? `${targetSpeed.toFixed(1)} m/s` : '--'} · {fanRunning ? '风机运行中' : '风机停止'}
          </span>
          {windTrend.length > 1 && <MiniTrend values={windTrend} height={26} />}
        </div>
        <Instr
          label="供水温度"
          value={temp != null ? temp.toFixed(1) : '--'}
          unit="℃"
          sub={`正常 ${POINT_META.supply_temp.normal[0]}~${POINT_META.supply_temp.normal[1]} ℃`}
          tone={
            temp != null && (temp < POINT_META.supply_temp.normal[0] || temp > POINT_META.supply_temp.normal[1])
              ? 'warn'
              : ''
          }
          trend={tempTrend}
        />
        <Instr label="安全状态" value={safety || '--'} tone={safetyTone(safety)} sub="连锁 / 急停 / 门禁" />
        <Instr
          label="实验阶段"
          value={phase}
          sub={
            profileRun
              ? `程控：${profileRun.name} 第 ${profileRun.step_index + 1}/${profileRun.total_steps} 步`
              : activeExp
                ? `执行中：${activeExp.title}`
                : '当前无执行中实验'
          }
        />
        <Instr
          label="路面速度"
          value={beltSpeed != null ? beltSpeed.toFixed(1) : '--'}
          unit="m/s"
          tone={beltOut ? 'warn' : ''}
          sub={`偏航 ${fmtNum(pointValue(rrs?.points, 'yaw'), 1)}°`}
        />
        <Instr
          label="天平阻力 Fx"
          value={balanceFx != null ? balanceFx.toFixed(1) : '--'}
          unit="N"
          tone={fxOut ? 'warn' : ''}
          sub={`Fz ${fmtNum(pointValue(rrs?.points, 'fz'), 1)} N`}
        />
      </div>

      <div className="layout-3">
        <div className="panel">
          {/* 场景切换直接内嵌在受其控制的面板头上，所见即所切 */}
          <div className="panel-head panel-head--tabs">
            <Tabs
              tabs={SCENARIOS.map((s) => ({ key: s, label: s }))}
              value={scenario}
              onChange={(k) => setScenario(k as Scenario)}
              ariaLabel="实验场景"
            />
          </div>
          <div className="scene scene--compact">
            <svg className="scene-svg scene-svg--compact" viewBox="0 0 800 340">
              <rect x="40" y="100" width="720" height="140" rx="28" fill="var(--bg-3)" stroke="var(--line)" />
              {/* 气流线：宽度/透明度随风速数据驱动，无装饰性动画 */}
              <path
                d="M80 170 C 200 110, 320 230, 440 170 S 640 110, 720 170"
                fill="none"
                stroke="var(--chart-stroke)"
                strokeWidth={2 + Math.min(8, (wind ?? 0) / 12)}
                opacity={wind != null && wind > 0.5 ? 0.85 : 0.25}
              />
              <circle cx="120" cy="170" r="34" fill="var(--bg-0)" stroke={mainFan?.fault ? 'var(--danger)' : 'var(--muted)'} strokeWidth="3" />
              <text x="120" y="175" textAnchor="middle" fill="var(--text)" fontSize="13">风机</text>
              <rect x="350" y="130" width="130" height="80" rx="10" fill="var(--bg-0)" stroke="var(--muted)" />
              <text x="415" y="165" textAnchor="middle" fill="var(--text)" fontSize="13">试验段</text>
              <text x="415" y="185" textAnchor="middle" fill="var(--muted)" fontSize="12">{wind?.toFixed(1) ?? '--'} m/s</text>
              <rect x="560" y="145" width="90" height="50" rx="8" fill="var(--bg-0)" stroke={rrs?.fault ? 'var(--danger)' : 'var(--muted)'} />
              <text x="605" y="175" textAnchor="middle" fill="var(--text)" fontSize="12">RRS</text>
              {scenario === '声学实验' && <text x="415" y="70" textAnchor="middle" fill="var(--accent-2)" fontSize="13">麦克风阵列模式</text>}
              {scenario === 'WLTP滑行' && <text x="415" y="70" textAnchor="middle" fill="var(--warn)" fontSize="13">尾气抽排联动</text>}
            </svg>
            <div className="scene-overlay">
              <span className={`badge ${safetyTone(safety) === 'danger' ? 'danger' : safetyTone(safety) === 'warn' ? 'warn' : ''}`}>安全：{safety || '--'}</span>
              <span className="badge">阶段：{phase}</span>
              <span className="badge">Fx：{fmtNum(pointValue(rrs?.points, 'fx'), 1)}</span>
              <span className="badge">抽吸：{fmtNum(pointValue(bl?.points, 'suction_flow'), 3)}</span>
            </div>
          </div>

          {canCommand && (
            <div className="cmd-groups">
              <div className="cmd-block">
                <div className="label-cap cmd-block-head">风机控制</div>
                <div className="cmd-row">
                  <div className="actions">
                    <label className="cmd-label">目标风速</label>
                    <input
                      className="field field-sm"
                      type="number"
                      min={0}
                      max={120}
                      step={1}
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                    />
                    <span className="cmd-unit">m/s</span>
                  </div>
                  <div className="ctl-row">
                    {/* 设定风速即「按设定风速运行」：停机时=按该风速启动，运行中=平滑调整至该风速；停止独立成键 */}
                    <Ctl
                      icon={fanRunning ? <IconDashboard size={22} /> : <IconPlay size={22} />}
                      label={fanRunning ? '调整风速' : '设定风速启动'}
                      variant={fanRunning ? '' : 'primary'}
                      title={fanRunning ? `将目标风速调整为 ${speed} m/s` : `按 ${speed} m/s 设定风速并启动风机`}
                      confirmMessage={
                        fanRunning
                          ? `确认将运行中的目标风速调整为 ${speed} m/s？风机将平滑加减速至该工况。`
                          : `确认按 ${speed} m/s 启动风机？风机将升速至该工况运行。`
                      }
                      onClick={() => send('main_fan', 'set_speed', { target_speed: speed }, { confirmed: true })}
                    />
                    <Ctl
                      icon={<IconStop size={22} />}
                      label="停止风机"
                      variant="danger"
                      disabled={!fanRunning}
                      title={fanRunning ? '停止风机，风速归零' : '风机当前未运行'}
                      confirmMessage="风机停止后试验段风速将归零，进行中的气动测量会中断。"
                      confirmDanger
                      onClick={() => send('main_fan', 'stop', {}, { confirmed: true })}
                    />
                  </div>
                </div>
              </div>

              {(scenario === '气动实验' || scenario === '参观演示') && (
                <div className="cmd-block">
                  <div className="label-cap cmd-block-head">姿态与路面</div>
                  <div className="cmd-row">
                    <div className="actions">
                      <label className="cmd-label">偏航角</label>
                      <input
                        className="field field-sm"
                        type="number"
                        min={-30}
                        max={30}
                        step={0.5}
                        value={yaw}
                        onChange={(e) => setYaw(Number(e.target.value))}
                      />
                      <span className="cmd-unit">°</span>
                    </div>
                    <div className="ctl-row">
                      <Ctl
                        icon={<IconTraverse size={22} />}
                        label="设定偏航"
                        title={`将天平偏航角设定为 ${yaw}°`}
                        confirmMessage={`确认将天平偏航角设定为 ${yaw}°？`}
                        onClick={() => send('rrs', 'set_yaw', { yaw }, { confirmed: true })}
                      />
                      <ToggleCommandButton
                        running={beltRunning}
                        startLabel="启动路面"
                        stopLabel="停止路面"
                        stopHint="滚动路面将减速停止。"
                        onStart={() => send('rrs', 'start_belt', {}, { confirmed: true })}
                        onStop={() => send('rrs', 'stop_belt', {}, { confirmed: true })}
                      />
                      <ToggleCommandButton
                        running={blRunning}
                        startLabel="启动边界层"
                        stopLabel="停止边界层"
                        stopHint="边界层抽吸停止后，近地面流场品质将下降。"
                        onStart={() => send('boundary_layer', 'start', {}, { confirmed: true })}
                        onStop={() => send('boundary_layer', 'stop', {}, { confirmed: true })}
                      />
                      <Ctl
                        icon={<IconRrs size={22} />}
                        label="夹零 Tare"
                        title="将天平六分量当前读数记录为零点偏置并扣除"
                        confirmMessage="确认执行天平夹零（Tare）？六分量当前读数将作为零点偏置扣除，请在无风、模型安装完成后执行。"
                        onClick={() => send('rrs', 'tare', {}, { confirmed: true })}
                      />
                    </div>
                  </div>
                </div>
              )}

              {scenario === '声学实验' && (
                <div className="cmd-block">
                  <div className="label-cap cmd-block-head">声学</div>
                  <div className="ctl-row">
                    <ToggleCommandButton
                      running={acousticOn}
                      startLabel="声学采集"
                      stopLabel="停止采集"
                      stopHint="进行中的声学数据采集将中断。"
                      onStart={() => send('acoustic', 'start_acquire', {}, { confirmed: true })}
                      onStop={() => send('acoustic', 'stop_acquire', {}, { confirmed: true })}
                    />
                  </div>
                </div>
              )}

              {scenario === 'WLTP滑行' && (
                <div className="cmd-block">
                  <div className="label-cap cmd-block-head">环境</div>
                  <div className="ctl-row">
                    <ToggleCommandButton
                      running={exhaustRunning}
                      startLabel="尾气抽排"
                      stopLabel="停止抽排"
                      stopHint="尾气抽排停止后，WLTP 工况下舱内尾气可能积聚。"
                      onStart={() => send('exhaust', 'start', {}, { confirmed: true })}
                      onStop={() => send('exhaust', 'stop', {}, { confirmed: true })}
                    />
                    <Ctl
                      icon={<IconSubsystems size={22} />}
                      label="跟随风机"
                      title="尾气抽排跟随风机加减速"
                      onClick={() => send('exhaust', 'sync_with_fan', { fan_accel: true })}
                    />
                    <ToggleCommandButton
                      running={beltRunning}
                      startLabel="启动路面"
                      stopLabel="停止路面"
                      stopHint="滚动路面将减速停止。"
                      onStart={() => send('rrs', 'start_belt', {}, { confirmed: true })}
                      onStop={() => send('rrs', 'stop_belt', {}, { confirmed: true })}
                    />
                  </div>
                </div>
              )}

              <div className="safety-zone">
                <div className="safety-zone-title">安全</div>
                {/* 急停已提升为顶栏常驻（任何页面可及），此处保留维护员的急停复位 */}
                <span className="safety-zone-note">急停按钮常驻页面顶栏，按住 1 秒触发</span>
                {canMaintain && (
                  <Ctl
                    icon={<IconRestore size={22} />}
                    label="急停复位"
                    title="故障排除后复位急停状态"
                    confirmMessage="确认复位急停状态？请确认故障已排除、现场人员安全后再执行。"
                    confirmDanger
                    onClick={() => send('safety', 'reset_e_stop', {}, { confirmed: true })}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>全局态势</h2>
          </div>
          {/* 12 子系统实时卡片：图标 + 状态徽标 + 即时读数 + 快速启停（按当前默认参数，弹窗确认） */}
          <div className="sub-card-grid sub-card-grid--compact">
            {subsystems.map((s) => {
              const Icon = SUBSYSTEM_ICONS[s.id] ?? IconSubsystems
              const readings = keyReadings(s.points ?? [], 2)
              const quick = QUICK_CMD[s.id]
              return (
                <div
                  key={s.id}
                  className="sub-card"
                  title={`${s.name} · ${s.mode === 'simulation' ? '仿真' : '真机'} · ${s.state}${s.fault ? ` · ${s.fault_message}` : ''}`}
                  onClick={(e) => {
                    // 快速启停按钮与其确认弹窗的点击不触发卡片跳转
                    if ((e.target as HTMLElement).closest('.modal-overlay, .sub-card-quick')) return
                    navigate(`/subsystems/${s.id}`)
                  }}
                >
                  <div className="sub-card-top">
                    <span className="sub-card-icon"><Icon size={20} /></span>
                    <div>
                      <div className="sub-card-name">{s.name}</div>
                      <div className="sub-card-meta">{s.mode === 'simulation' ? '仿真' : '真机'}</div>
                    </div>
                    <span className={`sub-card-status badge ${s.fault ? 'danger' : s.ready ? '' : 'warn'}`}>
                      {s.fault ? '故障' : s.ready ? '就绪' : s.state}
                    </span>
                    {canCommand && quick && (
                      <QuickToggle
                        name={quick.label}
                        running={quickRunning(s.points, quick.kind)}
                        startCmd={quick.start}
                        stopCmd={quick.stop}
                        onSend={(cmd) => send(s.id, cmd, {}, { confirmed: true })}
                      />
                    )}
                  </div>
                  {readings.length > 0 && (
                    <div className="sub-card-readings">
                      {readings.map((r) => (
                        <span key={r.label} className="sub-card-reading">
                          <span className="label-cap">{r.label}</span>
                          <span className="mono">{r.text}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {(activeExp || execs.length > 0) && (
            <div className="exec-widget">
              {activeExp && overview && phase !== '空闲' && (
                <Link className="exec-item" to="/experiments" title="打开试验中心查看执行详情">
                  <div className="exec-head">
                    <span className="exec-name">{activeExp.title}</span>
                    <span className="badge info">{phase}</span>
                  </div>
                </Link>
              )}
              {execs.map((m) => {
                const pct = m.total_rows ? Math.round(((m.done_rows ?? 0) / m.total_rows) * 100) : 0
                return (
                  <Link key={m.matrix_id} className="exec-item" to="/experiments?tab=matrices" title="打开试验矩阵执行面板">
                    <div className="exec-head">
                      <span className="exec-name">{m.matrix_name ?? m.matrix_id}</span>
                      <span className={`badge ${m.status === 'paused' ? 'warn' : 'info'}`}>
                        {m.status === 'paused' ? '已暂停' : '执行中'} {m.progress}
                      </span>
                    </div>
                    <div className="health-bar"><i style={{ width: `${pct}%` }} /></div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
