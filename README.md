# quandao-studio

本仓库是券到卡包正式短视频产线。**新会话必须以仓库文件为准，不依赖旧对话记忆。**

## 新会话启动顺序

1. 先完整读取根目录 AGENTS.md，它是工作流路由与命令入口。
2. 写导演稿前读取 mac-director/SKILL.md；接稿制作前按入口顺序完整读取 quandao-video/SKILL.md。
3. 按题目读取 spec/功能真值.json、spec/红线词表.json 和 reference/官网创作资源地图.md。产品事实不能由官网营销描述或常识补足。
4. 先检查本轮工具、本地文件和命令能力。若没有可用生图通道、Node/Remotion 环境或 TTS 凭据，明确说明缺少的能力，不得假装已执行。

两份技能是仓库内的 Markdown 规范文件，不假设它们已注册成可调用技能。不要把完整导演稿直接作为图片生成 Prompt；实际生图必须遵守技能里的逐图隔离、4:3、单场景和逐字验收要求。

## 新会话工作流启动

用户开启新会话时，请复制：

`prompts/启动工作流.md`

该文件是用户侧启动入口，用于帮助 AI 进入正确工作模式。它不是规则源，不替代技能文档；产品事实、流程步骤、验收标准仍以仓库内正式文件为准。

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
