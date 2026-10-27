# YAML 用例规范与 UI 操作指令说明

本文档为 **UI 测试助手 Skill** 的规范说明，与 browser-use 执行引擎兼容，用于**探索模式 / 任务模式**生成或手写用例时的 YAML 结构与 UI 指令参考。生成之 YAML 可由 `python -m browser_use.cli --task-file <用例路径>` 执行。

---

## 一、YAML 文档生成规范

### 1.1 顶层结构（强制）

生成或手写 YAML 时**必须**严格按以下结构，与 `TasksConfig` 一致：

| 顶层 key | 类型 | 说明 |
|----------|------|------|
| **target** | 对象 | 执行目标：入口 URL、视口、Cookie 等 |
| **tasks** | 列表 | 用例列表，每项一个 task（name + flow） |
| **import** | 列表（可选） | 从其他 YAML 引入模块，用于复用 flow |

**正确示例**：

```yaml
target:
  url: "https://app.example.com"
  viewportWidth: 1496    # 可选，默认 1496
  viewportHeight: 818    # 可选，默认 818
  cookie: null           # 可选

tasks:
  - name: "用例名称"
    description: "可选描述"
    flow:
      - aiWaitFor: "页面加载完成"
      - aiTap: "登录"
  - name: "另一条用例"
    flow:
      - goTo: "https://app.example.com/page2"
      - aiAssert: "验证页面标题"
```

**错误示例（禁止）**：

```yaml
# ❌ 使用 task 单数、flow 在顶层
task:
  name: "..."
flow:
  - aiTap: "..."
```

### 1.2 target 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 入口 URL，执行器会先打开此页 |
| viewportWidth | int | 否 | 视口宽度，默认 1496 |
| viewportHeight | int | 否 | 视口高度，默认 818 |
| cookie | string | 否 | Cookie 配置（可选） |

### 1.3 tasks 与 flow

- **tasks**：列表，每项为一条用例，包含 `name`、可选 `description`、**flow**。
- **flow**：**必须**位于每个 task 内部，为步骤列表；每步为一条 UI 操作指令（见第二节）。
- **不生成「前往网址」第一步**：`target.url` 已指定入口，flow 从 `aiWaitFor: "页面加载完成"` 或首个业务操作开始；仅当需要**切换域名**时在 flow 中使用 `goTo: "https://..."`。

### 1.4 一个用例一个文件（推荐）

- 每个测试用例**单独一个 `.yaml` 文件**，便于独立回放与批量索引。
- 输出目录（本 Skill / Hub）：探索模式 **`.skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases/`**（CaseGeneratorAgent 平铺 YAML）；若使用含 **TestAssistant** 的扩展包，可能出现 **`<RUN_TS>/exploration/{run_id}/cases/`** 层级。任务模式 **`.skill-output/ui-test-assistant-skill-output/<RUN_TS>/task/{项目名}/`**（见 [SKILL.md](../SKILL.md)）；CLI **`--log-dir`** 分别在 **`exploration/logs/`**、**`task/logs/`** 下。
- 多用例时可生成 `index.yaml` 或 `run_all.sh` 列出全部用例路径。

### 1.5 模块复用（import）

当需要复用其他 YAML 中的 flow 时，可使用顶层 **import**：

```yaml
target:
  url: "https://..."

import:
  - from: "path/to/login.yaml"
    modules: ["登录"]

tasks:
  - name: "带登录的用例"
    flow:
      - use: "登录"
      - aiTap: "进入工作台"
```

- **from**：被引用 YAML 路径（相对或绝对）。
- **modules**：要引用的 task 的 `name` 列表。
- **use**：在 flow 中通过 `use: "模块名"` 插入该 task 的 flow。

---

## 二、UI 操作指令说明书

以下指令与 browser-use 执行引擎中注册的 UI 命令一一对应，生成之步骤可由 CLI 正确解析并执行。

### 2.1 格式约束（生成时必须遵守）

- **仅使用本文档定义的 key**：不得添加未定义的子 key（如 aiTap 禁止加 `timeout`、`expect`）。
- **aiTap、aiHover、aiScroll、aiSendKeys/aiKeyboardPress、assertText**：仅单值格式，如 `aiTap: "登录"`。
- **aiAssert / aiAssertText**：仅 `aiAssert: "描述"` 或 `aiAssertText: "文本"`，禁止 `expect` 子 key。
- **aiInput**：可带可选 `locate`，格式为 `aiInput: "值"` + `locate: "元素描述"`。
- **aiWaitFor**：支持可选 `timeout`（毫秒），如不写则使用执行器默认（如 90_000）。
- **sleep**：格式为 `sleep: 毫秒数`（纯数字）。
- **goTo**：格式为 `goTo: "URL"`，用于 flow 内显式跳转（如切换域名）。

### 2.2 指令总览

| 序号 | 指令 | 格式 | 说明 |
|------|------|------|------|
| 1 | **goTo** | `goTo: "URL"` | 打开指定 URL（flow 内跳转用；入口由 target.url 指定） |
| 2 | **ai** | `ai: "自然语言任务"` | 多步执行直至完成，用于不明确/弹窗/复合流程 |
| 3 | **aiAction** | `aiAction: "自然语言描述"` | 单步 AI 规划执行，导航、组合操作、复杂任务 |
| 4 | **aiTap** | `aiTap: "点击目标描述"` | 点击按钮、链接、菜单项 |
| 5 | **aiWaitFor** | `aiWaitFor: "等待条件"` 可选 `timeout` | 动态等待，满足条件继续 |
| 6 | **waitForText** | `waitForText: "文案"` 可选 `timeout`、`interval` | 轮询直到页面出现指定文案 |
| 7 | **sleep** | `sleep: 毫秒数` | 固定时长等待 |
| 8 | **aiHover** | `aiHover: "悬停目标"` | 鼠标悬停 |
| 9 | **aiInput** | `aiInput: "值"` 可选 `locate: "元素"` | 向元素输入文本 |
| 10 | **aiAssert** | `aiAssert: "断言描述"` | 智能断言（VLM） |
| 11 | **aiAssertText** | `aiAssertText: "期望文本"` | 智能断言「页面出现某文本」 |
| 12 | **assertText** | `assertText: "期望文本"` | 精确/包含文本断言（无 VLM） |
| 13 | **aiScroll** | `aiScroll: "方向/目标"` | 页面或区域滚动 |
| 14 | **scrollToText** | `scrollToText: "文案"` | 滚动到包含该文案的元素 |
| 15 | **aiSendKeys** | `aiSendKeys: "按键"` | 键盘输入（别名 aiKeyboardPress） |
| 16 | **aiQuery** | `aiQuery: "查询描述"` | 提取页面信息 |
| 17 | **upload** | `upload: "文件路径"` | 向 input[type=file] 上传文件 |
| 18 | **jsCode** | `jsCode: "JS 代码"` | 在页面执行 JavaScript |
| 19 | **pyCode** | `pyCode: "Python 代码"` | 在 Controller 执行 Python（高级） |
| 20 | **if** | `if: {...}, then: [...], else: [...]` | 条件分支（见 2.3） |
| 21 | **use** | `use: "模块名"` | 引用 import 的模块 flow |

### 2.3 常用指令详解

#### goTo（跳转）

- **用途**：在 flow 内打开指定 URL；入口页由 `target.url` 指定，无需在第一步写 goTo。
- **格式**：`goTo: "https://..."`
- **示例**：`goTo: "https://app.example.com/settings"`

#### ai（自由任务，多步）

- **用途**：指令不明确、可能遇弹窗、复合流程、多步直至完成。
- **格式**：`ai: "自然语言任务描述"`
- **与 aiAction 区别**：ai 允许多步直到 done；aiAction 单步成功即结束。
- **示例**：`ai: "在空间列表中向下滑动，找到并点击 UI自动化专用空间"`

#### aiAction（单步 AI）

- **用途**：导航、组合操作、复杂单步。
- **格式**：`aiAction: "自然语言描述"`，可选 `locate: "元素描述"`
- **示例**：`aiAction: "在用户名输入框输入 test@example.com"`

#### aiTap（点击）

- **格式**：`aiTap: "界面可见文案"`，可选 `locate: "位置描述"`
- **示例**：`aiTap: "登录"`、`aiTap: "新增项目"`

#### aiWaitFor（动态等待）

- **格式**：`aiWaitFor: "等待条件"`，可选 `timeout: 90000`（毫秒）
- **示例**：`aiWaitFor: "页面加载完成"`、`aiWaitFor: "页面出现创建成功"`

#### waitForText（文案轮询）

- **格式**：`waitForText: "期望出现的文案"`，可选 `timeout`、`interval`（毫秒）
- **说明**：轮询页面文本，出现则通过，超时则失败。

#### aiInput（输入）

- **格式**：`aiInput: "值"`，可选 `locate: "元素描述"`
- **示例**：
  ```yaml
  - aiInput: "test@example.com"
    locate: "用户名输入框"
  ```

#### aiAssert / aiAssertText / assertText（断言）

- **aiAssert**：VLM 智能断言，如 `aiAssert: "验证登录成功"`。
- **aiAssertText**：VLM 判断页面是否出现某文本，如 `aiAssertText: "创建成功"`。
- **assertText**：无 VLM，精确/包含匹配，如 `assertText: "创建成功"`。

#### aiScroll / scrollToText（滚动）

- **aiScroll**：`aiScroll: "向下滚动"`、`aiScroll: "滚动到底部"`。
- **scrollToText**：`scrollToText: "提交按钮"`，滚动到包含该文案的元素。

#### aiSendKeys（键盘）

- **格式**：`aiSendKeys: "按键名"`（别名 `aiKeyboardPress`）。
- **示例**：`aiSendKeys: "Enter"`、`aiSendKeys: "Escape"`

#### if（条件分支）

- **格式**：`if` 下为一条命令（如 aiAssert、assertText），`then` / `else` 为命令列表。
- **示例**：
  ```yaml
  - if:
      assertText: "已登录"
    then:
      - aiTap: "进入工作台"
    else:
      - aiTap: "登录"
  ```

### 2.4 操作选择建议

| 场景 | 推荐指令 |
|------|----------|
| 用户指令不明确、可能遇弹窗 | ai |
| 复合任务、多步流程 | ai |
| 打开页面、复杂单步 | aiAction |
| flow 内切换域名 | goTo |
| 点击按钮/链接/菜单 | aiTap |
| 等待元素/状态 | aiWaitFor、waitForText |
| 固定延时 | sleep |
| 悬停 | aiHover |
| 输入文本 | aiInput 或 aiAction |
| 校验结果 | aiAssert、assertText、aiWaitFor |
| 滚动 | aiScroll、scrollToText |
| 键盘 | aiSendKeys |
| 上传文件 | upload |
| 执行脚本 | jsCode、pyCode（慎用） |

### 2.5 校验点优先使用

- **aiAssert**：复杂校验、状态、列表包含等。
- **assertText**：精确文本校验。
- **aiWaitFor**：等待 + 隐式校验（如「页面出现创建成功」）。

### 2.6 禁止的格式

```yaml
# ❌ aiTap 带 timeout
- aiTap: "登录"
  timeout: 2000

# ❌ aiAssert 带 expect
- aiAssert: "验证成功"
  expect: "页面显示成功"

# ❌ 未定义的子 key
- aiWaitFor: "页面加载"
  interval: 1000
```

---

## 三、单用例 YAML 示例

```yaml
target:
  url: "https://app.example.com/login"

tasks:
  - name: "用户登录流程"
    description: "输入用户名密码，点击登录，验证进入首页"
    flow:
      - aiWaitFor: "页面加载完成"
      - aiInput: "test@example.com"
        locate: "用户名输入框"
      - aiInput: "password123"
        locate: "密码输入框"
      - aiTap: "登录"
      - aiWaitFor: "页面出现首页"
      - aiAssert: "验证登录成功"
```

---

## 四、与执行引擎的对应关系

本规范与 browser-use 执行引擎兼容：顶层 `target` / `tasks` / `flow` 及各 UI 指令格式与引擎解析一致，生成或手写 YAML 时以本文档为准，执行行为以 browser-use 当前版本为准。实现细节（如 Config 类、命令注册）可在需要时查阅 browser-use 项目源码。
