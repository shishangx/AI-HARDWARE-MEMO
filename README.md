# AI-HARDWARE / Private Memo

> 文档归档整理：2026-10-15。本 README 为唯一操作入口；资料内容的实验日期与验收边界见正文。

| 资料 | 唯一保留位置 |
| :--- | :--- |
| 调研报告：定位、市场假设、硬件与模型、实测证据、成本 | [docs/research/调研报告.md](docs/research/调研报告.md) |
| 架构设计：数据路径、钱包协议、恢复、安全边界、外观概念 | [docs/architecture/架构设计.md](docs/architecture/架构设计.md) |
| 路演 PPT：保留 V4.1 原文件 | [docs/presentations/Private_Memo_PitchDeck_V4.1.pptx](docs/presentations/Private_Memo_PitchDeck_V4.1.pptx) |
| PPT 使用说明与原讲稿 | [docs/presentations/README.md](docs/presentations/README.md) |
| Android 离线真机实验：构建、部署与原始结果 | [lab/android/README.md](lab/android/README.md) |

团队名：忆核 MEMCORE
团队宣言：让每一段记忆，只属于你，始终找得回。

端侧语音备忘录原型：

```text
录音并本地保存 → 本地 ASR / 可选 HTTPS Provider → 转写文本加密 → 二维码
                                                               ↓
                                                        imToken 签名上链
                                                               ↓
                                                        钱包签名恢复解密
```

当前已验证：模拟器完成本地录音、转写文本加密、钱包签名配对、Base Sepolia 测试网提交与恢复；Seeker Android 真机在断网状态完成 Paraformer、SenseVoice、R2T2 CPU 转写、真实麦克风录音、VAD、AES-GCM/HKDF 与二维码自检，并在 Wi-Fi 下完成局域网 Whisper 真机转写。

当前未实现：原始 WAV 上链、BLE、安全元件、Passkey/AA 产品接入、伴聊/TTS、Android 端真实钱包交易广播与恢复、RK3576 真板验证。Android 原型已增加摄像头实时扫描配对二维码、Wi-Fi 设置、局域网 Whisper 和可选外部语音 Provider。

## 0. Android 离线真机实验

没有 RK3576 开发板期间，项目增加了一个 Android arm64 实验载体，用来验证“完整模型能否在约 8GB 的移动设备上离线运行”，而不是模拟 RK3576 的具体性能。

2026-10-15 在 Solana Mobile Seeker（MT6878、Android 15、约 8GB RAM）上的结果：

| 验证项 | 结果 |
| :--- | :--- |
| 三模型 | Paraformer、SenseVoice、R2T2 均完成完整模型加载与真实转写；统一 6.74s 样本各跑 3 轮，9 次零失败 |
| CPU 实时率 | Paraformer RTF 中位数 0.014；SenseVoice 0.037；R2T2 0.676 |
| 内存 | 三轮样本最大 PSS：约 245MB / 441MB / 3.05GB |
| 录音与 VAD | 真机麦克风生成 16kHz 单声道 WAV；纯静音无转写，语音–静音–语音正确分为 2 段 |
| 加密与二维码 | Android 往返、篡改拒绝、二维码编解码通过；与 Python 实现逐字节交叉验证通过 |
| 离线边界 | 每次结果均记录飞行模式开启、无活动网络、应用未获 `INTERNET` 权限 |

原始 JSON、录音、二维码、模型哈希和限制见[真机实验报告](lab/android/results/device/REPORT.md)。这些数据证明当前软件链可在 8GB arm64 Android 上运行，但不证明 RK3576 的 CPU/NPU、功耗、散热、GPIO、屏幕或电池达标。

## 1. 启动模拟环境

### 前置条件

- macOS + OrbStack
- VM：`companion-dev`（Ubuntu ARM64）
- VM 内已安装模型：`~/companion-lab/models`
- 默认使用 Base Sepolia，不需要启动 anvil

### 启动

在仓库根目录执行：

```bash
cd AI-HARDWARE
orb list
bash lab/start_simulator.sh
```

保持终端运行，在浏览器打开：

```text
http://localhost:8099/
```

### 停止

在运行模拟器的终端按 `Ctrl+C`。

### 启动失败检查

```bash
orb list
ls ~/companion-lab/models
ls lab/r2t2/build/ubuntu-arm64/bin
```

`lab/.pairing` 保存模拟器配对状态，重启后仍显示“已配对”是正常现象。

## 2. 当前测试流程

1. 打开 `http://localhost:8099/`。
2. 设置 → 钱包签名配对。
3. 用 imToken 扫码，对同一恢复声明签名两次。
4. 将配对凭据粘贴回模拟器。
5. 录音 → 转文字 → 生成上链二维码。
6. 用 imToken 扫码并确认交易。
7. 打开恢复二维码，用同一钱包签名一次并解密。

当前上链的是**加密转写文本**，不是原始录音文件。

### 模型切换（原型实验）

模拟器支持在页面设置中切换 `R2T2`、`Paraformer` 和 `SenseVoice`，用于在同一环境中比较识别效果和运行表现。当前默认模型是 `R2T2`。

模型切换是原型实验能力，不代表量产默认模型已经确定。选型时先比较识别准确率，再比较内存、实时率、功耗和温度；后续还要验证 ASR 与本地 RAG 同时运行的资源占用。完整决策规则见[技术方案](docs/architecture/架构设计.md#3-本地音频与模型生命周期)和[调研报告](docs/research/调研报告.md)。


## 3. 配置启动参数

`lab/start_simulator.sh` 默认配置：

| 参数 | 默认值 |
|---|---|
| 端口 | `8099` |
| 链 | Base Sepolia (`84532`) |
| 合约 | `0x2737FAedBf625BF32069A7a076A6C42644292278` |
| 部署块 | `0x2df3da5` |
| 页面 | `https://ai-hardware-gamma.vercel.app/` |
| RPC | `https://base-sepolia.publicnode.com` |

只有在更换合约、页面或 RPC 时才需要覆盖默认值。平时直接执行上一节的启动命令即可。

例如：

```bash
CONTRACT=0x新的合约地址 \
DEPLOY_BLOCK=0x新的部署区块 \
PAGE_URL=https://新的页面地址/ \
RPC_URL=https://新的RPC地址 \
CHAIN_ID=84532 \
bash lab/start_simulator.sh
```

这些变量只对本次启动生效，不会修改脚本默认配置：

| 变量 | 用途 |
|---|---|
| `CONTRACT` | MemoryRegistry 合约地址 |
| `DEPLOY_BLOCK` | 旧合约兼容扫描的起始区块；索引版恢复不做全区间扫描 |
| `PAGE_URL` | imToken 打开的 HTTPS 页面 |
| `RPC_URL` | 实验阶段的只读 RPC 回退；正式产品不配置 |
| `CHAIN_ID` | 链 ID；Base Sepolia 为 `84532` |

Android 实验包从 `lab/android/.env` 的 `base-sepolia-node` 读取测试用只读 RPC。生成提交或恢复二维码时，该地址会进入网页 query；恢复页先通过新版合约分页读取钱包的批次区块，再只对实际命中的区块查询日志，不再扫描从部署至今的全部区块。正式产品不携带该配置：签名、广播、`eth_call`、`eth_getLogs` 和交易读取都使用 imToken 注入的 provider。修改 `web3/app/` 后须重新运行 `web3/tools/make_deploy_bundle.sh` 并完整部署 `web3/dist-page/`。

## 4. 移植到 Linux ARM64 / RK3576

> 以下是移植步骤，尚未在 RK3576 真板完成验证。

### 4.1 复制代码和模型

保留以下目录：

```text
lab/server.py
lab/mic_rt.py
lab/crypto/
lab/ui/
lab/r2t2/
web3/tools/make_payload.py
```

当前代码从以下目录加载 Paraformer、VAD、SenseVoice 和降噪模型：

```text
~/companion-lab/models
```

启动必需：

```text
Paraformer + silero_vad.onnx
```

### 4.2 安装运行依赖

```text
Python 3
NumPy
sherpa-onnx
cryptography
segno
ALSA / arecord
```

验证录音设备：

```bash
arecord -l
arecord -D <设备名> -f S16_LE -r 16000 -c 1 test.wav
```

### 4.3 编译 R2T2

不要复制 Mac 或 VM 的 `.so`。在目标板重新编译 native 扩展和 llama.cpp，并设置：

```bash
export LD_LIBRARY_PATH=/path/to/r2t2/build/ubuntu-arm64/bin
```

模型放在：

```text
lab/r2t2/models/gguf/
```

### 4.4 启动板端服务

```bash
cd AI-HARDWARE/lab
python3 server.py \
  --host 0.0.0.0 \
  --port 8099 \
  --device <设备名> \
  --contract <合约地址> \
  --chain-id 84532 \
  --deploy-block <部署区块> \
  --page-url https://<可信页面>/ \
  --rpc-url https://<公共RPC>
```

浏览器访问：

```text
http://<板端IP>:8099/
```

imToken 扫码打开的是 `--page-url` 指定的公网 HTTPS 页面，不是板端 HTTP 页面。

### 4.5 真板验收指标

必须实测：

```text
启动峰值 RSS/PSS
ASR RTF 与 P95 延迟
连续运行稳定性
功耗与温度
模型加载时间
```

OrbStack 只能验证 Linux ARM64 用户态，不能代替 RK3576 的 CPU、NPU、内存带宽和散热测试。


## 5. 配对、恢复与本地状态

配对：在设置中生成钱包签名配对码，用 imToken 对同一恢复声明签名两次；手机随后显示签名数据二维码，带摄像头的硬件直接扫描导入。模拟器保留粘贴回退。配对本身不广播交易、不消耗 gas。两次签名用于确认同声明签名可重现；真机及钱包升级兼容性仍须验收。

日常：录音并停止 → 转文字 → 生成上链二维码 → imToken 扫码 → 确认 `addBatchOnchain`。当前备份转写文本密文，不上传原始 WAV。生成二维码不等于交易已确认。同一条文本每次都会使用新的时间戳和随机 AES-GCM nonce，因而生成不同的密文、摘要和二维码；每次实际广播都会形成一条独立链上记录。

恢复：钱包与二维码 → 恢复链上记录 → 原配对钱包扫码 → 恢复声明签名一次 → 查询 owner 的事件与交易 → 核对摘要 → 浏览器本地解密。关闭网页后，可随时从设备重新生成恢复二维码；恢复不依赖浏览器历史或保存交易哈希。恢复读取本身不消耗 gas，不输入钱包助记词。

| 操作 / 文件 | 行为与注意点 |
| :--- | :--- |
| 更换配对钱包 | 长按“已配对钱包”卡片并二次确认清除，再用新钱包签两次；旧记录仍须旧钱包恢复，不自动迁移 |
| 清除配对 | 隐藏入口为长按已配对钱包卡片；删除设备 KEK 与 owner，不删除录音、转写或链上记录 |
| `lab/.pairing` | 明文实验配对文件，重启保留；不要用于量产 |
| `lab/recordings/` | 本地原始及降噪 WAV、索引与登记信息 |
| `lab/sessions/` | 独立录音 / 结构化实验 JSONL |
| `web3/app/` / `web3/dist-page/` | 页面源文件 / 发布产物；不是两份独立维护的文档 |

## 6. 静态页面部署与本地回归

从 `AI-HARDWARE/` 执行：

```bash
cd web3
bash tools/make_deploy_bundle.sh
```

部署整个 `dist-page/`，必须包含 `index.html`、`styles.css`、`main.js`、`abi.js`、`crypto.js`、`wallet_pairing.js`、`qrcode.js`、`bip39_english.txt`、`vercel.json` 九个文件，避免页面、二维码库与协议版本混用。使用钱包认可的公网可信 HTTPS 域名和 HTTPS RPC；私网 IP、自签页面或共享隧道不能替代完整 imToken 真机验收。页面错误时检查安全上下文、provider 注入、目标链和 RPC 配置。

量产设备只引用产品自有域名和版本化路径（例如 `https://wallet.example.com/v1/`），不写死托管商域名。主备静态托管部署同一构建产物并核对 SHA-256，通过 DNS 切换；已售设备使用的协议版本必须在支持周期内持续可访问。WalletConnect 不进入当前产品路线。

以下测试命令从 `AI-HARDWARE/` 执行；按脚本准备 Foundry / Node / Python 依赖，部分脚本需要本地 EVM 环境。它们用于代码复测，本次归档只做文档与文件完整性检查。

```bash
python3 lab/crypto/pipeline.py
cd web3
forge test
node tools/verify_abi.mjs
node tools/crypto_crosslang.mjs
node tools/wallet_pairing_e2e.mjs
node tools/blob_payload_e2e.mjs
node tools/e2e.mjs
node tools/recovery_e2e.mjs
```

## 7. R2T2 本地复测

`lab/r2t2/` 保存固定版本源码、模型、两个平台的构建及 Python 环境。OrbStack 通过 `/mnt/mac` 直接读取同一份权重，不重复复制进 VM。

| 路径 | 内容 |
| :--- | :--- |
| `lab/r2t2/models/gguf/` | 官方 Q4 主模型与 Q8 mmproj，合计约 1.36GiB |
| `lab/r2t2/source/Confucius4-R2T2/` | 官方推理源码与 native 扩展 |
| `lab/r2t2/source/llama.cpp/` | 官方指定 commit `ad6c66839af3c5646fba8c6c2e2087a1e4e38948` |
| `lab/r2t2/build/macos-arm64/` / `build/ubuntu-arm64/` | 分平台构建产物，不跨平台复制 `.so` |
| `lab/r2t2/env/` | 各平台 Python 环境 |
| `lab/r2t2/bench.py` / `results/` | 基准脚本 / 原始结果，不属于可删除的重复文档 |

在 Ubuntu `companion-dev` 内运行（历史环境为 Ubuntu 26.04、aarch64、9 vCPU、15GiB RAM、16GiB swap）：

```bash
R2T2_PROJECT=/mnt/mac/Users/imtoken-ljm/Desktop/test1/AI_PRJ/idea/AI-HARDWARE/lab/r2t2
LD_LIBRARY_PATH="$R2T2_PROJECT/build/ubuntu-arm64/bin" \
  "$R2T2_PROJECT/env/ubuntu-arm64/bin/python" "$R2T2_PROJECT/bench.py" \
  --native-dir "$R2T2_PROJECT/source/Confucius4-R2T2/r2t2_llama/native" \
  --model "$R2T2_PROJECT/models/gguf/Confucius4-R2T2-Q4_K_M.gguf" \
  --mmproj "$R2T2_PROJECT/models/gguf/mmproj-Confucius4-R2T2-Q8_0.gguf" \
  --audio "$R2T2_PROJECT/source/Confucius4-R2T2/resources/test.wav" \
  --ctx 2048 --batch 512 --threads 8 --runs 3 --cpu-only
```

在 macOS 用本机项目路径、`env/macos-arm64-py312/bin/python`、`build/macos-arm64/bin`，并以 `DYLD_LIBRARY_PATH` 替换 `LD_LIBRARY_PATH`。native 扩展按平台 ABI 选择；模型只验证过少量样例，不能据此评价中文整体准确率。完整实测表合并在调研报告 §6。

## 8. 历史脚本与文档归档

当前模拟器只用 `lab/start_simulator.sh` 和 8099，不需要启动 anvil 或旧的 8101。`lab/archive/` 与 `web3/archive/` 仅保留早期实验脚本，不是当前流程入口。

| 历史脚本 | 曾经用途 / 当前替代 |
| :--- | :--- |
| `lab/archive/run.sh` | 独立 ASR / 会话调试；当前 ASR 集成到 `lab/server.py` |
| `lab/archive/serve.sh` | 独立 LLM 服务实验，不属于首版伴聊功能 |
| `web3/archive/lan.sh` | 早期本地链与局域网页面，当前用公网测试网与 HTTPS 页面 |
| `web3/archive/https.sh` / `lanhttps.sh` | 早期隧道 / 证书变体；只作历史参考 |
| `web3/archive/local_recover_setup.mjs` / `lan_phone_setup.mjs` | 早期局域网恢复与真机准备实验 |

### 文档归并记录

| 原文件 | 合并或保留位置 |
| :--- | :--- |
| `调研报告_端侧AI伴聊硬件与imToken生态融合.md`、`invest-report.md`、`ideas.md` | 调研报告：合并定位、用户、商业和风险假设，移除过期实现断言 |
| `R2T2与HF榜单_2026-09-26_检索原文.md`、`R2T2本地资源实测_2026-09-26.md` | 调研报告 §5/6：保留来源、完整资源表与证据边界 |
| `TypeSafe判断设计_端侧AI硬件与ASR选型.md` | 调研报告 §8：保留判断流程与硬规则，删除无实测依据的示例概率 / 分数 |
| `技术方案_离线设备上链与换机恢复.md`、`产品方案_钱包签名配对与恢复.md` | 架构设计：以新钱包方案统一协议，旧方案仅保留兼容边界；成本归调研 |
| `lab/README.md`、`lab/r2t2/README.md`、`web3/README.md`、`web3/archive/README.md` | 本 README：合并启动、使用、部署、复测与历史脚本说明 |
| `Private_Memo_PitchDeck_V4_1_讲稿备注.md` | `docs/presentations/README.md`，保留完整原讲稿并标明历史口径 |
| `Private_Memo_PitchDeck_Optimized_V4_1.pptx` | 移至 `docs/presentations/Private_Memo_PitchDeck_V4.1.pptx`，原文件字节不变 |
| `Private_Memo_PitchDeck_Optimized_V4.pptx`、`.~Private_Memo_PitchDeck_Optimized_V4_1.pptx` | 旧版 / Office 临时文件不进入现行资料目录，原件在下述历史包内 |
| `design/外观概念-v1.txt`、三视图 PNG | 文字和完整提示词并入架构附录，唯一图片移至 `docs/architecture/assets/` |

清理前 19 个原文件保存在 AI-HARDWARE 目录之外、工作区 `.archives/` 下的[历史归档包](../.archives/AI-HARDWARE-docs-before-cleanup-2026-10-15.zip)，包内含 SHA-256 清单。它仅用于追溯 / 恢复，不是现行资料入口；不包括代码、模型、录音、配对状态或钱包配置的全量备份。

文档今后按主题直接更新上述唯一文件，不增加 `v2`、`最终版` 或重复来源摘录。PPT 如更新则替换演示目录中的当前文件，历史原件继续单独归档。代码、模型、实验数据与第三方依赖文档保持原位。
