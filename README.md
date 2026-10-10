# quandao-studio

本仓库是券到卡包正式短视频产线。**新会话必须以仓库文件为准，不依赖旧对话记忆。**

## 新会话启动顺序

1. 先完整读取根目录 AGENTS.md，它是工作流路由与命令入口。
2. 写导演稿前读取 mac-director/SKILL.md；接稿制作前按入口顺序完整读取 quandao-video/SKILL.md。
3. 按题目读取 spec/功能真值.json、spec/红线词表.json 和 reference/官网创作资源地图.md。产品事实不能由官网营销描述或常识补足。
4. 先检查本轮工具、本地文件和命令能力。若没有可用生图通道、Node/Remotion 环境或 TTS 凭据，明确说明缺少的能力，不得假装已执行。

两份技能是仓库内的 Markdown 规范文件，不假设它们已注册成可调用技能。不要把完整导演稿直接作为图片生成 Prompt；实际生图必须遵守技能里的逐图隔离、4:3、单场景和逐字验收要求。


## 新会话工作流启动提示词（复制后填写本轮任务）

将下面整段复制到新会话，并在最后填写本轮具体任务。它是**启动和执行约定**，不替代技能正文；产品事实、流程步骤、验收标准仍以仓库内相应文件为准。

```text
你现在要在券到卡包正式短视频产线 quandao-studio 中执行本轮任务。
仓库：https://github.com/Forget-lang/quandao-studio
以 main 分支当前版本为准；不要依赖旧会话记忆，也不要把摘要当作完整规范。

开始前必须：
1. 先读取仓库根目录 AGENTS.md 与 README.md，按 AGENTS.md 的工作流入口执行。
2. 若任务涉及选题、经营逻辑、口播、导演稿或分镜，完整读取 mac-director/SKILL.md。
3. 若任务涉及生图、TTS、字幕、工程、渲染、成片验收或发布，完整读取 quandao-video/SKILL.md。
4. 按本题需要读取 spec/功能真值.json、spec/红线词表.json 和 reference/官网创作资源地图.md；需要确认产品细节时，按仓库规范检查本轮实际可访问的权威来源。官网营销内容只能启发选题，不能单独作为功能事实依据。
5. 先判断本轮处于策划、导演、制作、验收还是文档维护阶段，并检查本轮实际具备哪些文件、工具和命令能力。技能文件是仓库中的 Markdown 规范，不要假设它们已注册或自动执行。

本条视频的核心创作要求：
- 口播、主画面和辅助信息必须协同设计。口播讲清问题、原因/机制、成立条件与结论；主画面呈现行业场景、人物行为和关键关系；辅助信息只补足理解缺口，不机械重复口播，也不为追求丰富而堆字。
- 从商家的具体经营问题出发，把逻辑讲明白；需要时串起商家、顾客和员工分别做什么；再自然对应到已经核实的券到卡包具体能力，解释它能帮助完成哪个环节、适用条件与限制。
- 不把视频写成按钮说明书，不把功能名罗列当作解决方案，也不机械套用固定章节模板。要讲透必要逻辑，但不啰嗦；画面信息充分，但不信息过载。
- 吸引行业商家理解并愿意进一步了解产品，是内容目标；品牌露出与营销表达必须遵守 spec/红线词表.json 及两项技能中的现行边界，不得虚构功能、经营数据、效果或保证复购/成交。
- 遵守现有统一视觉风格、导演与制作分工、逐图验收、渲染和成片验收闸门。不得擅自重写用户已确认的口播，不得绕过验收。
- 所有已发布的历史作品默认冻结；没有用户明确要求，不得追溯修改、重渲或重新验收。
- 规则有冲突时，查各文件职责与唯一真源，核实后再处理，不要复制规则正文制造第二个真源。

执行方式：
- 先简短说明：已读取哪些规范、当前工作阶段、需要执行的主要步骤与能力限制；随后直接推进本轮任务，不要只复述规则。
- 不要重复询问用户已经给出的信息。若信息不全但可以合理推进，按明确假设尽力完成并标注假设；只有阻塞执行的必要信息才提问。
- 必须区分“已计划”“已执行”“已验证”。没有实际读取文件、运行命令、检查成片或获取结果时，不得声称已完成；无法访问仓库或执行命令时，明确说明阻塞点与未验证事项。
- 若修改文档或脚本，保持规则单一来源，按 AGENTS.md / README.md 要求运行适用检查；检查尚在运行时如实说明，只有取得结果后才能报告通过。
- 完成后给出实际改动、验证结果、未完成项和相关提交/文件链接。

【本轮具体任务】
在此填写：本条视频需求、现有片名/导演稿，或需要修改/审计的具体事项。
```

## 一条片的资产与执行

每条片的源文件与归档位于 pieces/<日期>-<题材短名>/。导演稿、工程 JSON、图片、音频、词级时间戳、成片、发布文案及验收记录均属于片内档案；运行时的 video/src/*.json、video/public/images、video/public/audio 与 video/public/fonts 是生成物。

在本地克隆且配置好依赖／凭据后，按实际项目状态执行：

```sh
node scripts/use-piece.mjs <片名>
node scripts/check-reuse.mjs --piece <片名>
# 完成图片、TTS 与字幕数据后
node quandao-video/scripts/preflight.mjs
node scripts/check-visual-review.mjs --piece <片名>
node scripts/render-piece.mjs --piece <片名>
# 完整播放最终 MP4、填写 pieces/<片名>/成片验收.json 后再执行
node scripts/check-delivery-review.mjs --piece <片名>
node scripts/check-piece.mjs --piece <片名>
node scripts/check-docs.mjs
```

check-piece.mjs 退出码：0 表示文本检查通过且逐图视觉验收记录完整；1 表示硬性失败、视觉验收失败或验收记录结构错误；2 表示仍有提示词人工复核任务或视觉验收待办。--confirm-manual-review 只能确认文本提示层派单，不能绕过视觉验收闸门。图片本身必须先由人逐张检查，并将结论写入片目录的视觉验收.json。渲染完成不等于发布通过：必须完整播放当前最终 MP4、填写成片验收.json，并运行 check-delivery-review.mjs；该闸门会同时核对逐图验收状态和当前 MP4 的 SHA-256。

字幕字体的唯一源文件是 quandao-video/font/LXGWWenKai-Medium.ttf；工程副本由 scripts/use-piece.mjs 复制和校验。密钥放在本地 quandao-video/.env，严禁提交。

## 文档维护与自检

修改规则／脚本后，至少运行：

```sh
node scripts/check-docs.mjs
node scripts/check-docs.mjs --self-test
node scripts/check-piece.mjs --self-test
node scripts/check-reuse.mjs --self-test
node quandao-video/scripts/preflight.mjs --self-test
node scripts/check-visual-review.mjs --self-test
node scripts/check-delivery-review.mjs --self-test
python3 quandao-video/scripts/voiceover_utils.py --self-test
```

实际环境可用时还应执行 npm ci --prefix video、node scripts/use-piece.mjs <片名>、node quandao-video/scripts/preflight.mjs 与 npm run tsc --prefix video。自检或渲染未实际运行时，必须如实标记为未验证。
