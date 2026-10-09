<p align="center">
  <img src="assets/banner.png" alt="Naiyi Translate Banner" width="100%">
</p>

<p align="center">
  <img src="assets/logo.png" alt="Logo" width="130" height="130">
</p>

<h1 align="center">奈译屋 · Naiyi Translate</h1>

<p align="center">
  <strong>身经百战的文献伴读助手。在 Obsidian 阅读视图就地并排对照，绝不碰你的一字一句。<br>
  看似 Simple，实则深厚，比同类工具跑得都快。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian" alt="Obsidian Plugin">
  <img src="https://img.shields.io/badge/Privacy-100%25_Local_Friendly-success" alt="Privacy First">
  <img src="https://img.shields.io/badge/Zero_Mutation-Markdown_Untouched-blue" alt="Zero Mutation">
  <img src="https://img.shields.io/badge/License-GPL--3.0-orange" alt="License GPL-3.0">
</p>

---

## 缘起：从「陪读蛙」到「奈译屋」

本项目的灵感与底层重试思路源自 Chrome 上优秀的沉浸式翻译插件 [read-frog (陪读蛙)](https://github.com/mengxi-ream/read-frog)。

浏览器里的蛙能伴读，那在沉淀人类严肃知识的 Obsidian 知识库里呢？既然一脉同源，便有了**「奈译屋 (Naiyi Translate)」**。

中文语境下的“奈译”，表面是一座静谧严谨、学贯中西的书斋；实则是对某位长者“看似简单（Naive）、实则深谙世理、谈笑风生”的会心致敬。我们摘掉了具象的眼镜与皮带，保留了学术大师的硬核底色——**知识涉猎多、响应速度快、阅历深厚且处变不惊**。

---

## 核心设计哲学

### 1. 零侵入渲染：永远不改写任何 `.md` 文件
市面上多数翻译插件粗暴地将译文直接 Append 或写入 Markdown 源文件，污染版本控制且难以还原。
* **纯 DOM 层注入**：奈译屋只在阅读视图（Reading View）的渲染管线中工作，将双语对照就地插入段落下方。
* **挥一挥衣袖**：退出阅读视图、按下停止键或清除缓存，你的笔记文件仍然干净如初，没有残留一行脏数据。

### 2. 极致轻量与速度：比同类跑得都快
文献阅读的核心是心流，任何打断（切窗口、复制粘贴、等待卡顿）都是灾难。
* **智能避障与排版兼容**：精准提取正文文本，原生绕开代码块（CodeBlock）、LaTeX 数学公式与 Mermaid 图表，同时深度适配列表项与 Markdown 表格单元格。
* **防套娃机制**：注入子树自带隔离标记，译文自身永远不会被重新采集捕获，杜绝递归渲染与算力浪费。

### 3. 本地优先与隐私安全：与 Local LLM 深度契合
* **直连 Node 网络栈**：作为桌面端插件，请求直接走 Obsidian 底层网络环境，**完全不受浏览器 CORS 跨域及私有网络预检（Private Network Access）限制**。
* **内网无缝直连**：本地运行的 Ollama、OMLX、LM Studio、vLLM 等服务监听 `127.0.0.1` 即可直接通讯，无需将端口暴露至局域网，文献与私有笔记绝不离机。

---

## 引擎矩阵与架构权衡

| 引擎 | 特性与适用场景 | 工程实现细节 |
| :--- | :--- | :--- |
| **Google** | 免费、免配置、即开即用（默认） | 官方批量接口无法实现 1:1 段落精确对齐，采用受控并发逐段流水线请求。 |
| **Microsoft Edge** | 免费、免配置、文本质量略高 | 支持安全批量翻译，通过唯一分隔符批处理后严格校验段落数组长度。 |
| **自定义 AI** | 本地 Ollama / OMLX / OpenAI 兼容端点 | 兼容本地与云端模型（如 Qwen2.5 / DeepSeek 等）。针对翻译场景默认剔除思考链（CoT），单独配置首字加载超时，延迟降至最低。 |

---

## 身经百战的流量调度：429 与限速熔断

调用免费翻译端点必然遭遇 Rate Limit。奈译屋继承并重构了自适应退避熔断协议：

* **全局熔断队列**：单次遭遇 `HTTP 429` 立即冻结**整个请求管线**（基础 5s 起步，指数翻倍，上限 5 分钟），杜绝滚雪球式全线报错；
* **单探针恢复机制**：响应携带 `Retry-After` 时严格听从服务端指示；解冻窗口期仅派出**单个探测请求**，成功后再恢复并发 `capacity`；
* **并发折叠降噪**：同一时间窗口内的并发 429 只计为一次命中，请求成功即清空退避计数器；
* **双轨重试预算**：限流退避重试（每段上限 8 次）与网络故障重试（`maxRetries`）解耦计算，限流不挤占常规重试预算；
* **坏死快速熔断**：连续 5 轮限流窗口未恢复，或遭遇 401/403/404 致命状态码时，立即中止剩余积压任务并弹出全局单次警报。

---

## 快速上手

### 安装方式

#### 推荐：通过 BRAT 插件一键安装（适用于测试与持续更新）
1. 在 Obsidian 中安装 **BRAT (Beta Reviewer's Auto-update Tester)** 插件。
2. 进入 BRAT 设置，点击 **Add Beta plugin**。
3. 输入：`Meatballovsky/obsidian-naiyi-translator` 并确认。

#### 手动安装
1. 从 [Releases](https://github.com/Meatballovsky/obsidian-naiyi-translator/releases) 页面下载最新发布的 `main.js`、`manifest.json`、`styles.css`。
2. 将文件解压放入笔记库目录：`<YourVault>/.obsidian/plugins/obsidian-naiyi-translator/`。
3. 在 Obsidian 设置中启用即可。

### 使用指南

1. 前往 **Obsidian 设置 → 第三方插件**，启用 **Naiyi Translate (奈译屋)**。
2. 打开任意外文笔记切换至 **阅读视图**，右侧边缘将出现交互悬浮球（支持拖拽吸附边缘）。
3. 点击展开悬浮球控制盘，或使用快捷命令面板（`Ctrl/Cmd + P`）：
   - `Toggle full-note translation`：全文双语对照渲染
   - `Translate selection`：仅翻译当前选中段落
   - `Clear injected translations`：一键清除当前及所有后台标签页注入的译文
   - `Cycle translation engine`：快速轮换翻译引擎

---

## 开发者备忘

- **全局作用域清除**：清除译文（Clear）会同步清理由插件创建的所有 DOM 节点；插件 Unload/Disable 时同样执行无残留自毁。
- **平滑中断与续译**：停止任务或切换 Active Leaf 不会留下任何空占位节点（Placeholder），未完成段落会在下次激活时平滑重试。
- **本地源码编译安装**（适用于贡献者与本地调试）：
  ```bash
  # 运行自动化安装脚本编译并安装到指定库
  ./scripts/install.sh "<vault 路径>"
  ```

---

## 鸣谢与开源协议

- **致谢**：底层限流调度架构与 429 退避协议灵感源自 Chrome 扩展 [read-frog (陪读蛙)](https://github.com/mengxi-ream/read-frog)。
- **开源协议**：本项目基于 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 开放源代码。
