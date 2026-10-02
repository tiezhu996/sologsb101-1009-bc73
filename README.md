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
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts
        ├── components/common/  # AbnormalTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx LeakBoard.tsx PlanList.tsx
        ├── router/index.tsx
        ├── utils/              # range.ts db.ts export.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 调压站与设备台账 | Station、Device | 新建/编辑/删除站点与设备；按压力等级与设备类型筛选；卡片回显设备数、待处置泄漏数与漏检次数 |
| `/points` | 巡检点位与标准值配置 | Point、Device、StandardVersion、RecalcBatch | 维护点位上下限/单位/关键点标记（草稿 → 按生效日期提交为新版本并生成可重试的重算批次，历史读数按巡检日期取版本）；查看版本时间线与批次进度；按模板批量复制标准值 |
| `/patrols` | 巡检录入 | Patrol、Reading、Point | 选定任务后逐点录入读数，实时偏差率与异常级别；逐点或整批保存；完成巡检、标记漏检、现场备注 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按关键点权重降序排列；勾选批量确认；浓度类点位一键派发泄漏处置单 |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading | 派单 → 填写处置措施与处置人 → 录入复检浓度判合格闭环；导出处置台账 CSV |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`standardVersions`（点位标准值版本）、`recalcBatches`（标准调整重算批次）
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` → `version(3)` 的迁移：
  - v2：补齐 `revision`、回填点位与处置单的 `stationId` 冗余列
  - v3：旧点位标准值升级为带生效日期的 **initial 初始版本**；历史读数回填判定时标准快照（`standardVersionId` / `judgedMin` / `judgedMax` / `judgedCritical` / `judgedDate`）；泄漏单补 `sourceReadingId` 等审计列；新增标准版本表与重算批次表
- **标准值版本化口径（班组交接调整）**：
  - 调整标准值不覆盖历史：每次提交生成带「生效日期」的新版本，点位档案保留最新值；
  - 历史读数按巡检日期（实际日期优先）取「生效日期 ≤ 巡检日期」的最新版本重判，新读数取最新版本；
  - 提交时先生成**重算批次**，冻结受影响读数后按 5 条一块分块重算，每块事务提交即推进检查点（`processedCount`）；某块写入失败批次置 `failed` 并记录原因，重试从断点继续，已完成读数不重算；
  - 批次对浓度类新异常读数幂等派单（`sourceReadingId` 全局唯一），重复提交命中幂等键直接复用既有批次，**不会多出泄漏单**；
  - 待处置 / 已处置的泄漏单退回「标准复核」并挡住复检，可「复核确认」恢复原状态或「关闭原单」；**已复检合格的保留原结论**不退回
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位（各含初始标准版本）→ 6 次巡检 → 11 条读数 → 3 张泄漏处置单的完整父子孙链条；播种幂等
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

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
- **版本化判定**：每条读数落库时记录命中的标准版本与区间快照；异常清单、巡检页与读数台账均按该快照还原「当时判定」，标准值调整后历史结论可追溯，不随最新标准漂移
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空
