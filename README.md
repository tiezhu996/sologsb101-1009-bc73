# 燃气调压站巡检与泄漏处置台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环。核心动作：建站与设备、配巡检点位标准值、录巡检读数、判异常分级、派处置单复检、跟踪漏检。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22809**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Arco Design 2.66 | 表格、表单、Modal、Tag、Badge、Progress |
| 状态管理 | Zustand 4.5 | `stationStore` / `patrolStore` / `leakStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1009/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbgaspress
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts standard.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts standardStore.ts
        ├── components/common/  # AbnormalTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx LeakBoard.tsx PlanList.tsx
        ├── router/index.tsx
        ├── utils/              # range.ts db.ts export.ts standardVersion.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

> 另有 `frontend/scripts/verify-standard-version.ts`：基于 fake-indexeddb 的集成验证（旧数据升级、版本判定、批次重试恢复、派单幂等、退回复核）。

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 调压站与设备台账 | Station、Device | 新建/编辑/删除站点与设备；按压力等级与设备类型筛选；卡片回显设备数、待处置泄漏数与漏检次数 |
| `/points` | 巡检点位与标准值配置 | Point、Device、StandardVersion、RecalcBatch | 维护点位上下限/单位/关键点；班组交接调整先入草稿、选生效日期后生成新版本与重算批次（分块写入/失败重试/进度恢复）；查看版本时间线；按模板批量复制 |
| `/patrols` | 巡检录入 | Patrol、Reading、Point | 选定任务后逐点录入读数，实时偏差率与异常级别；逐点或整批保存；完成巡检、标记漏检、现场备注 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按关键点权重降序排列；勾选批量确认；浓度类点位一键派发泄漏处置单 |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading | 派单 → 填写处置措施与处置人 → 录入复检浓度判合格闭环；导出处置台账 CSV |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`standardVersions`、`recalcBatches`
- **标准值版本化**：点位标准值不再被直接覆盖。班组交接调整时，先在 `/points` 页维护草稿并选择**生效日期**，提交后生成一条带生效日期的 `standardVersions` 新版本，并同步点位表上的当前标准。历史读数按**巡检日期**取「生效日期 ≤ 巡检日期」的最新版本判定，新读数用最新版本；每条读数固化判定快照（`standardVersionId` / `judgeStandardMin` / `judgeStandardMax` / `judgeIsCritical` / `judgeEffectiveDate`），各页展示与 CSV 导出均可追溯当时判定
- **调整重算批次**：每次标准调整生成一个 `recalcBatches` 批次，按 25 条/块分块事务写入，单块失败自动重试 2 次，仍失败则整块标记「失败」并持久化进度（状态：待执行 / 进行中 / 已完成 / 部分失败）。批次面板可手动「重试失败项并恢复进度」；应用启动时自动续跑未完成批次，刷新不丢进度
- **派单幂等**：`leaks.dispatchKey` 为唯一索引（读数派单 `r:<readingId>`、手工派单 `m:<deviceId>:<foundTime>`）。重复点击或批量重复提交由数据库唯一约束原子兜底，不会多出泄漏单
- **标准复核**：批次全部重算成功后，受影响设备上「待处置 / 已处置」的泄漏单自动退回 `标准复核` 并挡住复检；复核可选「维持原结论」（恢复退回前状态）或「误报关闭」（按已复检闭环）。已复检（合格 / 不合格）的处置单保留原结论，不参与退回
- **数据结构版本**：`DB_VERSION = 4`：
  - v1 → v2：补齐 `revision`、回填点位与处置单的 `stationId` 冗余列、重算历史读数
  - v2 → v3：旧数据首次打开时把现行标准值升级为**初始版本**（生效日不晚于该点位最早巡检日期），读数补判定快照，泄漏单补派单键 / 来源读数 / 复核字段
  - v3 → v4：`dispatchKey` 升级为唯一索引（重复键保留最早一张）
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位（12 个标准版本，含 1 条班组调整版本）→ 6 次巡检 → 11 条读数 → 3 张泄漏处置单的完整父子孙链条；播种幂等
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`、`gbgaspress:recalc-fail`（仅重算故障注入自测）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

### 本地自测

```bash
cd frontend
npm run verify     # fake-indexeddb 集成验证：旧数据升级 / 版本判定 / 批次重试恢复 / 派单幂等 / 退回复核
```

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22809
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 偏差率：读数落在标准区间内为 `0`；越限时按越限幅度相对边界值计算百分比
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空
- 版本口径：历史读数按巡检日期取「生效日期 ≤ 巡检日期」的最新标准版本判定并固化快照；新读数（未填实际巡检日期时）用最新版本；标准调整只影响未复检闭环的泄漏单（退回标准复核），已复检结论保留
