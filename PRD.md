# 嘉立创EDA专业版"平衡铜绘制"插件需求文档

## 1. 项目概述

### 1.1 项目背景

在PCB设计与制造过程中，各层铜箔分布的均匀性直接影响电路板的成品质量。当PCB层叠结构中某一层铜箔较��而对应层铜箔较少时，会导致电镀厚度不均、蚀刻偏差、板弯板翘等一系列制造缺陷。

平衡铜（Copper Balancing / Copper Thieving），是指在PCB各层的空白区域添加非功能性铜皮图案，以平衡各层的铜密度，减少电镀不均匀和板弯板翘，提升制造良率。

本插件基于嘉立创EDA专业版扩展API开发，自动识别PCB空白区域并填充用户选定的铜皮图案。

### 1.2 适用范��

- **目标软件**：嘉立创EDA专业版
- **目标用户**：PCB Layout工程师、硬件工程师
- **适用场景**：多层PCB设计中需在空白区域补平衡铜以提高制造良率

### 1.3 术语定义

| 术语 | 说明 |
|------|------|
| 平衡铜 | 在PCB空白区域添加的非功能性铜皮图案，不与任何网络连接 |
| 铜密度 / 残铜率 | 某层铜箔面积占该层总面积的百分比，目标40-60% |
| 挖槽区域 | 封装内或板框层上的 MULTI 层（layer 12）Fill，表示铣槽/挖槽区域 |
| DRC | Design Rule Check，设计规则检查 |

## 2. 功能需求

### 2.1 已实现功能清单

| 编号 | 功能 | 说明 |
|------|------|------|
| F-01 | 图案类型 | 9种：圆形、正方形、矩形、菱形、长圆形、三角形、五边形、六边形、梯形 |
| F-02 | 图案参数 | 尺寸、第二尺寸（宽高分别设置）、水平间距、垂直间距、旋转角度 |
| F-03 | 交叉分布 | 隔行交错排列（stagger）；邻层交错（layer stagger）使相邻层偏移半步 |
| F-04 | 操作范围 | 仅当前层 / 所有信号层 / 所有阻焊层 / 信号层+阻焊层 |
| F-05 | 区域生成 | 点击画布两点框选区域，仅在该区域内填充 |
| F-06 | 自动避让 | 走线（胶囊形多边形）、焊盘（实际形状+旋转）、过孔、铜皮、已有填充 |
| F-07 | 封装内避让 | 解析封装 `.elibu` 文件，提取焊盘（支持旋转）和 MULTI 层挖槽区域 |
| F-08 | 挖槽区域避让 | 收集 MULTI 层 Fill（包括封装内和独立放置），作为障碍物避让 |
| F-09 | DRC间距 | 自动读取 DRC 规则矩阵，按图元类型分别应用安全间距 |
| F-10 | 板框支持 | 支持折线/填充/区域定义的板框，支持圆角矩形板框，支持板框槽孔 |
| F-11 | 自动DRC | 生成完成后可选自动运行 DRC 检查并报告结果 |
| F-12 | 停止生成 | 生成过程中可随时停止 |
| F-13 | 单位自适应 | 自动识��当前 EDA 单位（mil/mm/inch）并转换参数 |
| F-14 | 输入计算 | 参数输入框支持四则运算（如 `5+3` 自动计算为 `8`） |
| F-15 | 中英双语 | 自动跟随 EDA 语言设置 |

### 2.2 功能详细描述

#### 2.2.1 障碍物收集与避让

**收集的障碍物类型**：

| 类型 | 来源 | 多边形表示 |
|------|------|-----------|
| 走线 | `pcb_PrimitiveLine` | 胶囊形（线段两端圆弧） |
| 弧线 | `pcb_PrimitiveArc` | 弧线胶囊形 |
| 焊盘 | 封装文件 + `pcb_PrimitivePad` API | 实际形状（圆/矩/椭圆/多边形）+ 旋转 |
| 过孔 | `pcb_PrimitiveVia` | 圆形（实际直径） |
| 铜皮 | `pcb_PrimitivePour` | 源多边形 |
| 填充 | `pcb_PrimitiveFill`（目标层） | 源多边形 |
| 挖槽区域 | `pcb_PrimitiveFill`（MULTI层） | 源多边形（支持 CIRCLE/R/L 格式） |
| 封装内焊盘 | 封装 `.elibu` PAD 条目 | 根据封装旋转变换到世界坐标 |
| 封装内挖槽 | 封装 `.elibu` FILL 条目（layer=12） | 根据封装旋转变换到世界坐标 |
| 板框槽孔 | 板框层较小形状 | 原始多边形 |

**避让算法**：
1. 在板框 BBox 范围内以步长（图案尺寸+间距）生成网格点
2. 交叉分布时奇数行偏移半步
3. 对每个网格点：
   - 射线法检测是否在板框内
   - 检测到板边距离是否满足安全间距
   - 空间索引（>100障碍物时启用）快速查找附近障碍物
   - BBox 预过滤 + 点内检测 + 最小距离检测
   - 安全缓冲（2mil）补偿多边形近似误差

#### 2.2.2 DRC间距读取

从 `pcb_Drc.getCurrentRuleConfiguration()` 解析安全间距矩阵：
- 遍历所有铜厚规则表（`copperThickness*`）
- 矩阵行列对应：0=Track, 1=SMD Pad, 2=TH Pad, 5=Via, 6=Fill Region, 11=Board Outline
- 取所有规则表中的最大值
- 单位从 mm 转换为 mil（÷0.0254，向上取整）

#### 2.2.3 图案生成

通过 `pcb_MathPolygon.createPolygon(source)` + `pcb_PrimitiveFill.create()` 创建 Fill 图元：
- 圆形：`['CIRCLE', x, y, radius]`
- 正方形/矩形/长圆形：`['R', x, y, w, h, rotation, cornerRadius]`
- 其他形状：`[x1, y1, 'L', x2, y2, ...]` 多边形格式

批量创建（每50个一批），批次间 `setTimeout(0)` 让出UI线程。

#### 2.2.4 封装解析

通过 `sys_FileManager.getFootprintFileByFootprintUuid()` 获取 `.elibz2` 文件（ZIP格式），解压后解析 `.elibu`（JSON Lines 格式）：
- 提取 PAD 条目：焊盘形状、位置、旋转、层、孔信息
- 提取 FILL 条目（layer=12）：挖槽区域的多边形路径
- 路径格式：嵌套数组 `[['CIRCLE', cx, cy, r]]` 或 `[[x1, y1, 'L', ...]]`
- 所有本地坐标通过组件位置和旋转变换到世界坐标

### 2.3 待实现功能

| 编号 | 功能 | 优先级 |
|------|------|--------|
| F-20 | 铜密度预估 | P2 |
| F-21 | 预览模式 | P2 |
| F-22 | 配置保存与加载 | P2 |
| F-23 | 铜箔厚度选择 | P2 |

## 3. 技术架构

### 3.1 项目结构

```
src/
  index.ts                  — 入口：菜单注册、iframe管理、命令轮询
  types.ts                  — 配置接口与枚举定义
  core/
    constants.ts            — 层ID常量、单位转换系数、默认值
    polygonUtils.ts         — 几何工具：多边形解析、BBox、距离计算、偏移、旋转
    boardOutline.ts         — 板框提取：折线/填充/区域，返回板框多边形和槽孔
    obstacleCollector.ts    — 障碍物收集：填充/铜皮/走线/焊盘/过孔/挖槽区域
    clearanceEngine.ts      — 空白区域检测：网格扫描 + 空间索引 + 安全间距
    patternGenerator.ts     — 图案生成：9种图案的 Fill 图元创建
    footprintParser.ts      — 封装解析：ZIP解压 + JSON Lines 提取 PAD/FILL
iframe/
  index.html                — UI面板：内联CSS+JS，中英双语，四则运算输入
extension.json              — 扩展元数据
locales/                    — i18n翻译
```

### 3.2 通信机制

扩展与 iframe 面板通过 `window.__bc_cmd` / `window.__bc_status` 轮询通信（300ms间隔）：
- iframe → 扩展：`{ type: 'generate'|'areaGenerate'|'cancel', config }`
- 扩展 → iframe：`{ type: 'progress'|'done'|'error', message, progress }`

### 3.3 技术选型

| 技术项 | 选型 |
|--------|------|
| 开发语言 | TypeScript |
| SDK | pro-api-sdk (esbuild 打包) |
| UI | 内联 iframe (HTML+CSS+JS) |
| 封装解析 | JSZip 解压 + JSON Lines 解析 |
| 多语言 | 内联 i18n 对象 + `sys_I18n` 语言检测 |

## 4. 非功能性需求

| 指标 | 要求 |
|------|------|
| UI响应 | 交互 < 200ms |
| 空白区域计算 | 常规板（<1000图元）< 1秒 |
| 图案生成 | 常规板 < 3秒，批量创建避免阻塞UI |
| 内存 | 运行时额外 < 50MB |

## 5. 附录

### 5.1 参考资源

- [嘉立创EDA专业版扩展API指南](https://prodocs.lceda.cn/cn/api/guide/)
- [pro-api-sdk GitHub](https://github.com/easyeda/pro-api-sdk)

### 5.2 设计规范参考

- 平衡铜目标铜密度：每层 40-60%
- 平衡铜与正常线路间距建议 ≥ 0.5mm（约20mil）
- 多层板应对称层匹配填充
