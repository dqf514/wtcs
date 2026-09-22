# 合肥汽车风洞 WTCS 完整版（Web 先行）

建设期交付**完整可运行 Web 测控系统**；现场子系统上线只需：改配置 → 实现真机适配器 → 连通性测试。

## 文档

- [投产架构规划](docs/投产架构规划.md)：联调 / 试运行 / 投产的目标架构、基础设施、数据架构与验收标准
- [部署说明](docs/部署说明.md)：Linux 服务器安装、nginx、systemd、备份恢复、升级与运维

## 功能清单

- 深色 / 浅色主题切换（登录页与顶栏均可切换，本地记忆）
- 场景化运行总控（气动 / 声学 / WLTP / 参观），ISA-101 风格模拟量指示（正常区间带 + 设定值标线 + 迷你趋势）
- 全局报警横幅（分级计数 + 未确认提示 + 可选声音），告警分级 / 去重 / 确认 / 自动恢复
- 试验矩阵管理：工况表编辑、版本历史、一键执行、暂停 / 恢复 / 中止、进度与 ETA、执行互斥
- 实验数据资产：采集 run 绑定配置快照（SHA-256 可复现声明）、天平六分量 / 压力 / 声学采样入库、Cd/Cl 自动解算、ECharts 曲线回放
- 12 子系统仿真 + ICD 契约 + 连通性测试，命令参数中文化 + 单位 + 范围校验 + 武装态二次确认
- 防误触急停（按住 1 秒触发），命令 min_role 权限前后端强制
- 数字孪生：几何示意 + 健康基线（EMA 基线 + z-score 偏差评估，联动告警）+ 摄像（预留）
- AI 巡检（分级规则引擎）+ 语义层自然语言只读查询（回答可溯源到测点与时间窗）
- 实验报告一键生成：run 统计 + 内嵌 SVG 图表 + 可复现声明，支持打印
- 总控大屏：纯展示远读布局（强制深色、大字号、无操作控件、3 秒无操作隐藏光标），四种显示模式 `?mode=overview|matrix|trends|alerts`，支持多屏切片 `?part=1/2`、子系统子集 `?subs=...`、自动轮换 `?rotate=30`、`?kiosk=1` 裸屏
- 完整系统设置：通用 / 遥测与存储（保留策略 + 存储占用 + 一键清理）/ 备份（手动 + 自动 + 下载 + 恢复）/ 网络 / AI 与健康 / 系统信息与改密
- 安全：bcrypt 密码哈希、JWT 全端点鉴权（含 WebSocket）、审计日志真实角色记录
- 可运维：全量日志（控制台 + 轮转文件）、遥测循环异常保护、aiosqlite + WAL、定时备份与保留清理
- 开放接口：/api/open/points（测点语义元数据）、/api/open/latest（当前值快照）、MQTT 发布器（可选，需 paho-mqtt）
- SQLite 持久化（实验、矩阵、run 数据、审计、报告、时序、告警、健康基线）

## 启动

```powershell
# 后端
cd wtcs-web\backend
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 前端
cd wtcs-web\frontend
npm install
npm run dev
```

- 前端：http://127.0.0.1:5173
- API 文档：http://127.0.0.1:8000/docs
- 账号：operator / maintainer / admin / customer ，密码 `wtcs123`

也可双击 `start-backend.bat` / `start-frontend.bat`。

## 两年后对接

1. 在 `backend/app/adapters/real/` 按 ICD 实现协议
2. 修改 `backend/config/subsystems.yaml` 的 `mode` / `endpoint`
3. `$env:WTCS_FORCE_SIMULATION="false"`
4. 前端「连通性」页验收

## 页面地图

| 路由 | 说明 |
|------|------|
| `/` | 总控台（仪表盘 + 大图标命令 + 全局态势） |
| `/subsystems` | 子系统（图标卡片 + 详情 Modal：点位/命令/连通性） |
| `/experiments` | 试验中心（实验 / 试验矩阵，?tab= 切换） |
| `/data` | 数据中心（分析报告 / 审计日志 / 数据查询 / 统计分析） |
| `/insight` | 智能洞察（数字孪生与健康基线 / AI 巡检与问答） |
| `/screen` | 大屏（纯展示；`?mode=` overview/matrix/trends/alerts，`?part=1/2` 矩阵切片，`?subs=` 子系统子集，`?rotate=30` 自动轮换，`?kiosk=1` 裸屏） |

多屏部署示例：电视 A 首页设 `/screen?kiosk=1&mode=matrix&part=1/2`，电视 B 设 `/screen?kiosk=1&mode=matrix&part=2/2`；等待区单屏轮播设 `/screen?kiosk=1&rotate=30`。
| `/settings` | 系统设置（通用 / 存储 / 备份 / 网络 / AI 与健康 / 系统） |

旧路由（/matrices /connectivity /reports /audit /twin /ai）自动重定向到对应新位置。全局快捷键：`Ctrl+K` 命令面板（页面/子系统/操作直达）。
