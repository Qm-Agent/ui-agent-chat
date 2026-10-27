# 任务模式 - 用例生成

任务模式中，当用户提供测试步骤、需求文档或可读取的文档链接时，按本文档流程生成 UI 测试用例。输出到 **工作区根**下 **`.skill-output/ui-test-assistant-skill-output/<RUN_TS>/task/{project_name}/`**（`<RUN_TS>` 与目录分栏约定见上级 [SKILL.md](../SKILL.md)）。

---

## 使用示例

**触发方式**：`/ui-test-assistant-skill` 进入任务模式。

**用户输入示例**：

> 帮我测试下 https://example.com/service-market，账号 ${TEST_USERNAME} 和密码 ${TEST_PASSWORD} 从本地配置文件读取；进入服务体验，点击开始体验，在对话框输入：冒泡排序

**说明**：账号和密码从 **`{技能根}/config/.env`** 读取（TEST_USERNAME、TEST_PASSWORD），须列入 SENSITIVE_VARIABLES。Agent 将按步骤生成用例：登录（占位符）→ 进入服务体验 → 点击开始体验 → 在对话框输入「冒泡排序」→ 校验点，输出到 **`<RUN_TS>/task/service-market/`** 并执行；执行时 `--log-dir` 使用 **`<RUN_TS>/task/logs/<子目录>/`**，并 `export DOTENV_PATH="{技能根}/config/.env"`。

---

## 一、文档读取

### 1.1 文档来源

| 来源 | 方法 |
|------|------|
| **在线文档链接** | 仅在用户已安装并授权对应文档连接器时读取；否则请用户导出文件或粘贴正文 |
| **PDF** | 使用 pdfplumber 或 PyMuPDF 提取文本；图片需 OCR 或视觉描述 |
| **DOC/DOCX** | 使用 python-docx 提取文本与图片 |
| **本地文件 (.md 等)** | 直接读取 |
| **用户粘贴 / IDE 文本** | 使用用户提供的文本 |

### 1.2 文档类型

- **UED 交互稿**：优先用于 UI 用例，含页面结构、元素、流程
- **需求文档**：提取场景与预期行为

### 1.3 解析失败降级

- PDF/DOC 或在线文档连接器读取失败 → 提示用户导出本地文件或粘贴正文
- 图片识别失败 → 正文照常参与生成
- 文档过大 → 分块、摘要或请用户指定范围

---

## 二、生成流程三阶段

### 2.1 生成前

- 确认文档已转为统一 Markdown
- 识别文档类型（交互稿/需求文档）
- 确定项目名（用于输出目录 **`<RUN_TS>/task/{项目名}/`**）

### 2.2 生成中

1. **提取元素**：从文档中提取页面结构、可操作元素（按钮、输入框、链接、菜单等）
2. **映射操作**：将元素映射到支持的 UI 操作指令（见第三节）
3. **补充校验点**：在关键操作后添加 aiAssert、assertText、aiWaitFor 等校验
4. **控件级校验**：
   - 搜索框：正常搜索、空搜索、无结果、联想等
   - 输入框：超长字符、特殊字符（`<>"'&`、emoji）、空值、格式校验
   - 按钮/表单：提交成功/失败、列表刷新、禁用状态

### 2.3 生成后

- 执行 Output Checklist
- 检查 **`config/.env`**（技能根下）是否存在；**仅当不存在时**从 **`config/.env.example`** 复制或创建模板；若已存在则**绝不覆盖**，保留用户已有配置（如 BU_OPENAI_API_BASE、BU_OPENAI_API_KEY）
- 可选生成 index.yaml 或 run_all.sh 列出全部用例路径
- 告知用户「用例已保存至 **`<RUN_TS>/task/{项目名}/`**，日志将写入 **`<RUN_TS>/task/logs/`**」；**若 `config/.env` 已满足 OpenAI-compatible provider（或 alternative compatible provider）有效组合，直接执行**，**不要**因库内 Gemini 默认叙事而要求用户额外配置 **`BU_OPENAI_*`**

---

## 三、YAML 结构与 UI 操作

### 3.1 YAML 结构强制规则

1. **顶层仅允许两个 key**：`target` 和 `tasks`（均为复数）
2. **tasks 必须是列表**：每项一个用例
3. **flow 必须位于 task 内部**：flow 是每个 task 的子 key
4. **禁止**：`task`（单数）、顶层 `flow`

**正确结构**：

```yaml
target:
  url: "https://..."

tasks:
  - name: "用例名"
    description: "描述"
    flow:
      - aiWaitFor: "..."
      - aiTap: "..."
```

### 3.2 一个用例一个 YAML 文档

每个测试用例单独一个 `.yaml` 文件，便于独立回放和管理。

### 3.3 不生成「前往网址」第一步

`target.url` 已指定入口，flow 从 `aiWaitFor` 或首个业务操作开始，不要写 `aiAction: "前往 url"`。

### 3.4 支持的 UI 操作（12 种）

| 序号 | 指令 | 格式 | 说明 |
|------|------|------|------|
| 1 | aiAction | `- aiAction: "自然语言描述"` | AI 规划执行，导航、组合操作、复杂任务 |
| 2 | aiTap | `- aiTap: "点击目标描述"` | 点击按钮、链接、菜单项 |
| 3 | aiWaitFor | `- aiWaitFor: "等待条件"` | 动态等待，满足条件继续 |
| 4 | sleep | `- sleep: 毫秒数` | 固定时间等待 |
| 5 | aiHover | `- aiHover: "悬停目标描述"` | 鼠标悬停 |
| 6 | aiInput | `- aiInput: "值"` 可选 `locate: "元素描述"` | 向元素输入文本 |
| 7 | aiAssert | `- aiAssert: "断言描述"` | 智能断言 |
| 8 | assertText | `- assertText: "期望文本"` | 文本断言 |
| 9 | aiScroll | `- aiScroll: "方向/目标"` | 全局滚动 |
| 10 | aiKeyboardPress | `- aiKeyboardPress: "按键"` | 键盘操作 |
| 11 | aiQuery | `- aiQuery: "查询描述"` | 查询页面信息 |
| 12 | ai | `- ai: "自然语言任务描述"` | 自由任务，多步执行。用于指令不明确、可能遇弹窗、复合流程 |

### 3.5 格式约束

- 仅使用上述定义的格式，不得添加未定义的子 key
- aiTap、aiHover、aiScroll、aiKeyboardPress、assertText：仅单值格式，**禁止**添加 `timeout`、`expect`
- aiAssert：仅 `aiAssert: "断言描述"`，**禁止**添加 `expect`
- aiInput：可带 `locate`，格式为 `aiInput: "值"` + `locate: "元素描述"`
- sleep：格式为 `sleep: 毫秒数`（纯数字）

### 3.6 指令选择建议

| 场景 | 推荐指令 |
|------|----------|
| 用户指令不明确、可能遇弹窗 | ai |
| 复合任务、多步流程 | ai |
| 打开页面、复杂操作 | aiAction |
| 点击按钮/链接/菜单 | aiTap |
| 等待元素出现 | aiWaitFor |
| 输入文本 | aiInput 或 aiAction |
| 校验结果 | aiAssert、assertText、aiWaitFor |

### 3.7 单用例 YAML 示例

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

## 四、.env 公用配置

### 4.1 位置

`.env` 放在 **`{技能根}/config/.env`**（与 **`config/.env.example`** 同目录），探索模式与任务模式共用。**不在** `<RUN_TS>/task/` 或 `.skill-output/` 下重复创建。

### 4.2 模板内容（仅当 `config/.env` 不存在时创建）

**重要**：仅当 **`config/.env`** **不存在**时从 **`config/.env.example`** 复制或按下方创建；若已存在，**不得用下方模板覆盖**，以免清空用户已填的 BU_OPENAI_API_BASE、BU_OPENAI_API_KEY 等。需要更新登录账号时，只增量修改 USERNAME/PASSWORD，保留其余配置。

```env
## 模型配置
BU_OPENAI_API_BASE=
BU_OPENAI_API_KEY=
# 默认模型
BU_ACTOR_MODEL=qwen3.7-plus
BU_PLANNER_MODEL=qwen3.7-plus
BU_ASSERTER_MODEL=qwen3.7-plus
BU_PAGE_EXTRACTION_LLM=qwen3.7-plus
BU_LOCATING_LLM=qwen3.7-plus
BU_CODING_LLM=qwen3.7-plus

# 本用例登录（由用户在对话中提供，仅保存在本地 .env）
USERNAME=
PASSWORD=

SENSITIVE_VARIABLES=USERNAME,PASSWORD
ANONYMIZED_TELEMETRY=false
```

### 4.3 配置说明

| 变量 | 必填 | 说明 |
|------|------|------|
| BU_OPENAI_API_BASE | 与 Key 成对 | OpenAI-compatible `/v1` API 地址 |
| BU_OPENAI_API_KEY | 与 BASE 成对 | 用户自己的 API Key |
| BU_ACTOR_MODEL 等 | 必填 | 服务端支持的视觉模型名 |
| ANONYMIZED_TELEMETRY | 可选 | 设为 `false` 可关闭遥测（见默认模板） |
| USERNAME | 需登录时 | 登录账号，YAML 中用 `${USERNAME}` |
| PASSWORD | 需登录时 | 登录密码，YAML 中用 `${PASSWORD}` |
| SENSITIVE_VARIABLES | 需登录时必配 | 账号/密码变量名，逗号分隔；列入后全程加密不传给模型，未配置则强制执行失败 |

### 4.4 加载方式

browser-use 按以下顺序加载 .env：

1. 当前工作目录：`cwd/.env`
2. 环境变量指定：`DOTENV_PATH=<路径>`

**推荐**：在工作区根执行 CLI，并设置 `DOTENV_PATH="<工作区根>/skills/ui-test-assistant-skill/config/.env"`（路径按实际技能根），或依赖项目根 `.env`。

---

## 五、输出目录

| 项目 | 路径 |
|------|------|
| 任务模式用例 | `.skill-output/ui-test-assistant-skill-output/<RUN_TS>/task/{project_name}/` |
| 任务执行日志 | `.skill-output/ui-test-assistant-skill-output/<RUN_TS>/task/logs/<子目录>/` |
| 用例文件 | `01-xxx.yaml`、`02-xxx.yaml` 等 |
| 可选 | `index.yaml` 或 `run_all.sh` 列出全部用例 |

---

## 六、Output Checklist

生成完成后确认：

- [ ] YAML 结构正确：target + tasks，flow 在 task 内部
- [ ] 每个用例至少一个校验点（aiAssert、assertText、aiWaitFor）
- [ ] 步骤描述界面可见元素，避免抽象
- [ ] 输出目录为 **`<RUN_TS>/task/{项目名}/`**
- [ ] **`{技能根}/config/.env`** 存在或已从 **`config/.env.example`** 创建
- [ ] 执行用例时 `--log-dir` 落在 **`<RUN_TS>/task/logs/`** 下
