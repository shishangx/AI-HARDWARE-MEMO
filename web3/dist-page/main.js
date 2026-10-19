"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };

  // ---- 工具 ----
  function b64urlDecode(str) {
    return MemoCrypto.b64urlDecode(str);
  }
  function strip0x(h) { return String(h || "").replace(/^0x/i, ""); }
  function short(h, n) { h = String(h || ""); n = n || 10; return h.length > n * 2 + 4 ? h.slice(0, n + 2) + "…" + h.slice(-n) : h; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function setStatus(el, kind, msg) {
    el.style.display = "block";
    el.className = "status" + (kind ? " " + kind : "");
    el.textContent = msg;
  }
  function fatal(msg) {
    $("fatal").style.display = "block";
    $("fatal").textContent = msg;
    $("boot").style.display = "none";
    $("main").style.display = "none";
  }

  // 不缓存 provider。imToken 等钱包经常在页面脚本执行**之后**才注入,
  // 若在加载时就缓存, 之后注入的 provider 永远拿不到 —— 表现为点击
  // "连接钱包"毫无反应, 也不报错, 极难定位。每次都重新读取。
  function getProvider() {
    return window.ethereum || null;
  }

  var account = null;
  var current = null;      // 当前载荷
  var mode = "submit";     // submit / recover / pair
  // 钱包读取能力探测结果。null = 尚未探测。
  var probeState = { text: null, ok: false };

  /** 探测钱包是否支持 eth_getLogs。
   *  这决定了页面是否需要自建 RPC —— 而自建 RPC 通常只能内网访问,
   *  HTTPS 页面又无法请求 http 内网地址, 因此"支持读取"能让部署简单得多。 */
  function probeRead(provider, contract) {
    probeState = { text: "检测中", ok: false };
    renderEnv();
    return provider.request({
      method: "eth_getLogs",
      params: [{ fromBlock: "latest", toBlock: "latest", address: contract }],
    }).then(function () {
      probeState = { text: "支持", ok: true };
    }).catch(function (e) {
      var msg = (e && (e.message || e.data && e.data.message)) || String(e);
      probeState = { text: "不支持（" + msg.slice(0, 40) + "）", ok: false };
    }).then(function () { renderEnv(); });
  }

  /** 环境诊断。手机端没有控制台, 出问题时只能靠页面上直接显示这些信息。 */
  function envReport() {
    var p = getProvider();
    var ua = navigator.userAgent || "";
    var looksToken = /imToken/i.test(ua);
    var flags = [];
    if (p) {
      ["isToken", "isImToken", "isMetaMask", "isTrust", "isWalletConnect"].forEach(function (k) {
        if (p[k]) flags.push(k);
      });
    }
    return {
      https: location.protocol === "https:",
      hasProvider: !!p,
      providerFlags: flags,
      ua: ua,
      looksToken: looksToken,
      host: location.host,
    };
  }

  var ZERO32 = "0x" + "0000000000000000".repeat(4);

  /** 把载荷里的紧凑记录展开成合约需要的完整字段。
   *  载荷刻意精简以压低二维码密度, 故 h/c 之外的值在此处补默认。 */
  function expandRecords(payload) {
    return (payload.records || []).map(function (r) {
      return {
        timestamp: r.t !== undefined ? r.t : r.timestamp,
        contentHash: r.h || r.contentHash,
        cid: r.c !== undefined ? r.c : (r.cid || ""),
        tagHash: r.g || r.tagHash || ZERO32,
        wrappedKey: r.k || r.wrappedKey || ZERO32,
        blob: r.b || r.blob || "",
      };
    });
  }

  /** 回退 RPC 的默认值。优先级: query 参数 > 同源 /rpc（仅本机/内网部署）。
   *
   *  托管在公开静态域名（如 github.io）时不能默认填 /rpc —— 那里没有该端点。
   *  那种场景下应当依赖"钱包直接读取", 因此留空更诚实。 */
  function defaultRpc() {
    var m = /[?&]rpc=([^&]+)/.exec(location.search);
    if (m) return decodeURIComponent(m[1]);
    var h = location.hostname;
    var isLocal = h === "localhost" || h === "127.0.0.1" || h === "::1"
      || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
      || /\.local$/.test(h);
    return isLocal ? location.origin + "/rpc" : "";
  }

  /** 起始区块。从**合约部署块**开始扫描而非 0 ——
   *  公共 RPC 普遍限制 getLogs 的范围(实测 5 万块), 从 0 查会直接被拒。
   *  十进制与 0x 十六进制都接受: 部署脚本存的是 hex, 手写 URL 常给十进制,
   *  两者混用会让扫描范围错出几百万块 —— 公共 RPC 上就是几分钟的空转。 */
  function startBlock() {
    var m = /[?&]from=([^&]+)/.exec(location.search);
    if (!m) return "0x0";
    var v = decodeURIComponent(m[1]);
    return /^0x[0-9a-fA-F]+$/.test(v) ? v : "0x" + (parseInt(v, 10) >>> 0).toString(16);
  }

  var RPC_CHUNK = 45000;   // 每批区块数, 留出余量以适配常见的 5 万块上限
  // 防止范围很小的 RPC 把一次恢复放大成数千次计费请求。当前 Alchemy
  // Base Sepolia 端点会返回 200 块上限；完整历史扫描会超过 4,900 次。
  // 超过预算时应停止并提示升级索引方案，不能静默消耗项目配额。
  var MAX_LOG_REQUESTS = 100;
  var INDEX_PAGE_SIZE = 100;

  /** 检查页面与 RPC 是否协议不匹配(会被浏览器拦截)。 */
  function mixedContentRisk(rpc) {
    if (!rpc) return false;
    return location.protocol === "https:" && /^http:\/\//i.test(rpc);
  }

  // ---- 解析与渲染 ----
  // 抽成函数是因为 fragment 变化不重新加载页面: 若只依赖首次加载执行,
  // 用户在同一个 WebView 里扫第二个码时会停留在上一份(或空白)状态。
  //
  // 两种打开方式:
  //   #p=<载荷>  设备刚录完, 让用户在 imToken 里签名上链
  //   #r=<载荷>  换机恢复: 只带 contract/chainId/owner, 页面自己去链上找回内容
  // 两者都放在 fragment 里 —— fragment 不会被发送给服务器, 因此静态托管方
  // 既看不到记录摘要, 也看不到"这个人正在做恢复"。
  function boot() {
    $("fatal").style.display = "none";
    $("main").style.display = "none";
    $("records").innerHTML = "";
    $("recovered").innerHTML = "";
    $("raw-wrap").style.display = "none";
    $("account").textContent = account || "未连接";

    var frag = location.hash.replace(/^#/, "");
    var kind = frag.indexOf("p=") === 0 ? "submit"
             : frag.indexOf("r=") === 0 ? "recover"
             : frag.indexOf("k=") === 0 ? "pair" : "";
    if (!kind) { fatal("缺少载荷：本页需要从设备生成的二维码/链接打开。"); return; }

    var payload;
    try {
      payload = JSON.parse(b64urlDecode(frag.slice(2)));
    } catch (e) {
      fatal("载荷解析失败: " + e.message);
      return;
    }
    if (!payload || payload.v !== 1) { fatal("不支持的载荷版本"); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(payload.contract || "")) { fatal("合约地址无效"); return; }

    var isRecover = kind === "recover";
    var isPair = kind === "pair";
    if (!isRecover && !isPair && (!Array.isArray(payload.records) || !payload.records.length)) {
      fatal("批次为空");
      return;
    }

    current = payload;
    mode = kind;
    $("page-subtitle").textContent = isPair
      ? "首次配对 · 验证钱包恢复签名可重现"
      : isRecover ? "换机恢复 · 同一钱包签名后本地解密"
      : "待签名批次 · 内容摘要已随载荷提供";
    document.title = isPair ? "记忆上链 · 钱包配对"
      : isRecover ? "记忆上链 · 换机恢复" : "记忆上链 · 待签名批次";
    $("boot").style.display = "none";
    $("main").style.display = "block";
    $("n-records").textContent = (payload.records || []).length + " 条";
    $("chain").textContent = payload.chainId;
    $("contract").textContent = payload.contract;
    $("rpc").value = payload.rpcUrl || defaultRpc() || "";
    $("owner").value = payload.owner || "";

    // 恢复模式没有待签批次, 只留"运行环境 + 换机恢复"两张卡
    $("card-batch").style.display = isRecover ? "none" : "block";
    $("card-submit").style.display = (!isRecover && !isPair) ? "block" : "none";
    $("card-pair").style.display = isPair ? "block" : "none";
    $("card-recover").style.display = isPair ? "none" : "block";
    $("btn-fetch").textContent = isRecover ? "恢复记录" : "读取并解密本批记录";

    if (!isRecover && !isPair) {
      // 逐条展示将要提交的内容 —— 用户应能看清自己签的是什么
      var box = $("records");
      expandRecords(payload).forEach(function (r, i) {
        var d = document.createElement("div");
        d.className = "rec";
        var when = new Date(Number(r.timestamp) * 1000);
        d.innerHTML =
          '<div class="idx">#' + i + ' · ' + esc(isNaN(when) ? String(r.timestamp) : when.toLocaleString()) + '</div>' +
          '<div class="kv"><b>存储标识</b><span class="mono">' + esc(r.cid || "") + '</span></div>' +
          '<div class="kv"><b>内容摘要</b><span class="mono">' + esc(short(r.contentHash, 12)) + '</span></div>';
        box.appendChild(d);
      });
    }

    renderEnv();
    // 恢复模式允许没有钱包: 用回退 RPC 读取即可, 因此不必在启动时就报缺 provider
    if (!isRecover) checkProviderWarn();

    var walletRecovery = payload.keyScheme === WalletPairing.KEY_SCHEME;
    $("mnemonic-wrap").style.display = walletRecovery ? "none" : "block";
    if (walletRecovery) {
      $("recover-note").innerHTML = "连接配对钱包并签署一次恢复声明，即可在本页本地重建解密密钥。"
        + "签名不会广播或上链，页面不要求钱包助记词。";
      $("btn-fetch").textContent = "钱包签名并恢复记录";
    }
    $("btn-recover-connect").style.display = walletRecovery ? "block" : "none";
  }

  /** 渲染环境诊断。手机上没有控制台, 这些信息是唯一可用的排查线索。 */
  function renderEnv() {
    var e = envReport();
    var el = $("env");
    if (!el) return;
    var rows = [
      ["协议", e.https ? "https ✓" : "http（imToken 要求 https，可能因此不注入钱包）",
       e.https ? "ok" : "warn"],
      ["钱包 provider", e.hasProvider ? "已注入 ✓" : "未检测到 ✗",
       e.hasProvider ? "ok" : "err"],
      ["页面地址", e.host, ""],
    ];
    var rpc = $("rpc") ? $("rpc").value : "";
    if (mixedContentRisk(rpc)) {
      rows.push(["回退 RPC", "页面是 https 但 RPC 是 http，会被浏览器拦截（混合内容）", "err"]);
    } else if (rpc) {
      rows.push(["回退 RPC", rpc, ""]);
    }
    // 钱包能否直接读取决定了是否需要自建 RPC —— 这是能否托管在
    // 可信静态域名上的关键, 因此值得在环境面板里显式探测。
    if (e.hasProvider && probeState.text === null) {
      rows.push(["钱包读取能力", "检测中…", ""]);
    } else if (probeState.text !== null) {
      rows.push(["钱包读取能力",
        probeState.ok ? "支持 eth_getLogs ✓（无需自建 RPC）" : "不支持，需回退 RPC",
        probeState.ok ? "ok" : "warn"]);
    }
    if (e.providerFlags.length) rows.push(["provider 标志", e.providerFlags.join(", "), "ok"]);
    el.innerHTML = rows.map(function (r) {
      return '<div class="kv ' + r[2] + '"><b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span></div>';
    }).join("") +
      '<details><summary>浏览器标识（排查用）</summary><div class="ua mono">' +
      esc(e.ua) + '</div></details>';
  }

  function checkProviderWarn() {
    if (getProvider()) return;
    setStatus(connectionStatus(), "warn",
      location.protocol === "https:"
        ? "未检测到钱包 provider。请确认本页是在 imToken 的 DApp 浏览器内打开，而不是普通浏览器。"
        : "未检测到钱包 provider，且当前是明文 http —— imToken 要求 https，"
          + "很可能因此没有注入钱包。请改用 https 地址后重试。");
  }

  // ---- 连接 ----
  function connectionStatus() {
    return mode === "pair" ? $("pair-status")
      : mode === "recover" ? $("fetch-status") : $("send-status");
  }

  function connectWallet() {
    // 每次点击都重新取 —— provider 可能在页面加载之后才注入
    var provider = getProvider();
    if (!provider) {
      setStatus(connectionStatus(), "err",
        "未检测到钱包 provider，无法连接。请查看上方“运行环境”一栏。");
      renderEnv();
      return;
    }
    setStatus(connectionStatus(), "", "正在请求钱包授权…");
    provider.request({ method: "eth_requestAccounts" })
      .then(function (accs) {
        account = accs && accs[0];
        $("account").textContent = account || "(未返回地址)";
        $("btn-send").disabled = !account;
        $("btn-pair").disabled = !account;
        if (account) {
          setStatus(connectionStatus(), "ok", "已连接：" + account);
          if (current) probeRead(provider, current.contract);
        } else {
          setStatus(connectionStatus(), "warn", "钱包未返回地址，请重试或检查是否已解锁。");
        }
      })
      .catch(function (e) {
        setStatus(connectionStatus(), "err", "连接失败或被取消: " + (e && e.message || e));
      });
  }
  $("btn-connect").onclick = connectWallet;
  $("btn-pair-connect").onclick = connectWallet;
  $("btn-recover-connect").onclick = connectWallet;

  $("btn-pair").onclick = function () {
    var provider = getProvider();
    if (!provider || !account || !current) {
      setStatus($("pair-status"), "warn", "请先连接钱包。");
      return;
    }
    $("btn-pair").disabled = true;
    setStatus($("pair-status"), "", "请在钱包中确认两次相同的恢复声明…");
    ensureChain(provider, current)
      .then(function () {
        return WalletPairing.verifyRepeatability(provider, current, account);
      })
      .then(function (result) {
        var token = WalletPairing.encodeCredential(account, result.kek, current);
        $("pair-credential").value = token;
        var qr = qrcode(0, "M");
        qr.addData(token, "Byte");
        qr.make();
        var image = document.createElement("img");
        image.alt = "Private Memo 配对凭据二维码";
        image.src = qr.createDataURL(5, 4);
        $("pair-qr").replaceChildren(image);
        $("pair-result").style.display = "block";
        setStatus($("pair-status"), "ok",
          "两次签名一致；请用 Private Memo 硬件扫描下方二维码。KEK 指纹 " + result.fingerprint);
      })
      .catch(function (e) {
        setStatus($("pair-status"), "err", "配对验证失败: " + (e && e.message || e));
      })
      .then(function () { $("btn-pair").disabled = false; });
  };

  $("btn-copy-pair").onclick = function () {
    var value = $("pair-credential").value;
    if (!value) return;
    navigator.clipboard.writeText(value).then(function () {
      setStatus($("pair-status"), "ok", "配对凭据已复制；请回到设备模拟器导入。");
    }).catch(function () {
      $("pair-credential").focus(); $("pair-credential").select();
      setStatus($("pair-status"), "warn", "无法自动复制，已选中文本，请手动复制。");
    });
  };



  // ---- 确保处于目标链 ----
  function ensureChain(provider, payload) {
    var hexChain = "0x" + Number(payload.chainId).toString(16);
    return provider.request({ method: "eth_chainId" }).then(function (cur) {
      if (String(cur).toLowerCase() === hexChain.toLowerCase()) return;
      return provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChain }],
      }).catch(function () {
        // 链未添加时补充添加 (需要 App 版本 > 2.8.4)
        if (!payload.chainInfo) throw new Error("钱包中未添加该链，且载荷未提供链信息");
        return provider.request({
          method: "wallet_addEthereumChain",
          params: [payload.chainInfo],
        });
      });
    });
  }

  // ---- 提交 ----
  $("btn-send").onclick = function () {
    var provider = getProvider();
    var payload = current;
    if (!payload) return;
    if (!provider) {
      setStatus($("send-status"), "err", "未检测到钱包 provider，无法签名。");
      renderEnv();
      return;
    }
    if (!account) {
      setStatus($("send-status"), "warn", "请先点击“连接钱包”。");
      return;
    }
    if (payload.owner && account.toLowerCase() !== payload.owner.toLowerCase()) {
      setStatus($("send-status"), "err",
        "当前钱包与设备配对钱包不一致。请切换到 " + payload.owner);
      return;
    }
    $("btn-send").disabled = true;
    setStatus($("send-status"), "", "正在准备交易…");

    var data;
    try {
      // 只允许提交携带密文的可恢复记录。二维码里的短字段 b 在 expandRecords
      // 中已展开为 blob；统一入口会校验每条记录，并返回钱包需要的 calldata 字符串。
      // 缺少密文时必须重新生成二维码，不能花 gas 写入一条永远无法恢复的记录。
      data = MinABI.encodeRecoverableBatch(expandRecords(payload));
    } catch (e) {
      setStatus($("send-status"), "err", "编码失败: " + e.message);
      $("btn-send").disabled = false;
      return;
    }

    ensureChain(provider, payload)
      .then(function () {
        setStatus($("send-status"), "", "等待钱包确认…");
        return provider.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: payload.contract, data: data }],
        });
      })
      .then(function (txHash) {
        setStatus($("send-status"), "ok", "已提交: " + txHash);
      })
      .catch(function (e) {
        var msg = (e && (e.message || e.data && e.data.message)) || String(e);
        if (e && (e.code === 4001 || /reject|cancel|denied/i.test(msg))) {
          setStatus($("send-status"), "warn", "已取消");
        } else {
          setStatus($("send-status"), "err", "失败: " + msg);
        }
      })
      .then(function () { $("btn-send").disabled = false; });
  };

  // ---- 换机恢复：枚举 → 取回 → 校验摘要 → 解密 ----
  // 三个约束决定了这里的实现:
  //  1. 公共 RPC 普遍限制 eth_getLogs 的区块范围(实测 5 万块), 从 0 查会被直接拒绝
  //     → 从部署块开始, 并分批查询
  //  2. HTTPS 页面不能请求 http 的 RPC(混合内容), 自建 RPC 通常只能内网访问
  //     → 优先用钱包读取, 失败才回退
  //  3. 手机上没有控制台 → 每一步的结论都直接显示在页面上
  //
  // 只订阅 MemoOnchain: 它的密文就在本笔交易的 calldata 里, 因此恢复端不需要
  // 任何外部存储网络。MemoAdded 那条路(cid 指向 Arweave)要等存储层落地才有意义。
  var RECOVER_TOPIC =
    "0x433330c264aec22fa879cb44629ba5271a2248e87a5d9f461afd45538b6fdbf8";

  /** 把一条 MemoOnchain 事件解成恢复端需要的字段。 */
  function parseOnchainEvent(log) {
    var body = strip0x(log.data);
    return {
      txHash: log.transactionHash,
      seq: Number(BigInt(log.topics[2])),
      timestamp: Number(BigInt("0x" + body.substr(0, 64))),
      contentHash: "0x" + body.substr(64, 64),
      blobOffset: Number(BigInt("0x" + body.substr(128, 64))),
      byteLength: Number(BigInt("0x" + body.substr(192, 64))),
    };
  }

  /** 解密出来是二进制时，转成 data URL 交给用户。
   *  Android 的 imToken WebView **不支持 blob: 协议**，所以不能走 blob 下载。 */
  function bytesToDataUrl(bytes) {
    var CHUNK = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return "data:application/octet-stream;base64," + btoa(parts.join(""));
  }

  $("btn-fetch").onclick = function () {
    var payload = current;
    if (!payload) return;

    var walletRecovery = payload.keyScheme === WalletPairing.KEY_SCHEME;
    var target = ($("owner").value || "").trim() || payload.owner || account;
    if (!/^0x[0-9a-fA-F]{40}$/.test(target || "")) {
      setStatus($("fetch-status"), "err",
        "缺少要恢复的地址：请先连接钱包，或在上方填写 owner 地址。");
      return;
    }
    var mnemonic = ($("mnemonic").value || "").trim();

    $("recovered").innerHTML = "";
    $("raw-wrap").style.display = "none";

    var topicOwner = "0x" + strip0x(target).toLowerCase().padStart(64, "0");
    var logParams = function (f, t) {
      return [{
        fromBlock: f, toBlock: t,
        address: payload.contract,
        topics: [RECOVER_TOPIC, topicOwner],
      }];
    };

    var isRangeErr = function (e) {
      var msg = (e && (e.message || e.data && e.data.message)) || String(e);
      return /range|limit|too (large|many)|exceed/i.test(msg);
    };

    /** 从报错中提取 RPC 给出的范围上限。
     *  多数实现会直接写明, 例如:
     *    "exceed maximum block range: 50000"          (publicnode)
     *    "eth_getLogs is limited to a 10,000 range"    (base-sepolia)
     *  注意第二例带千分位逗号 —— 不先去掉的话 (\d{3,}) 会匹配到 "000",
     *  解析成 0 而退化为反复减半, 多发几次无用请求。
     */
    var suggestedChunk = function (e) {
      var msg = (e && (e.message || e.data && e.data.message)) || String(e);
      // 反复去掉千分位分隔符, 直到不再变化 —— 一次只能消掉一个逗号,
      // "1,000,000" 需要两轮。解析偏小虽仍安全(只会多几次请求), 但没必要。
      var cleaned = msg;
      for (var i = 0; i < 4; i++) {
        var next = cleaned.replace(/(\d)[,_](\d{3})/g, "$1$2");
        if (next === cleaned) break;
        cleaned = next;
      }
      var m = /(\d{3,})/.exec(cleaned);
      var n = m ? parseInt(m[1], 10) : 0;
      return (n > 0 && n < 10000000) ? n : 0;
    };

    var toHex = function (n) { return "0x" + n.toString(16); };
    var toNum = function (h) { return parseInt(h, 16); };

    /** 自适应分块扫描 [from, latest]。
     *
     *  为什么不能用固定分块: 各家 RPC 的 getLogs 范围上限不同(实测 publicnode
     *  为 5 万块, 有的仅 1 万甚至 1000)。固定值要么被拒、要么请求次数过多。
     *  这里在遇到范围错误时**把分块减半并记住**, 后续分段沿用该值 ——
     *  一次探测即可, 不会每段都重试。
     *
     *  必须已知 latest: 否则无法判断是否扫完, 会陷入不断重试。
     */
    var scanLegacy = function (call) {
      var cur = toNum(startBlock());
      var out = [];
      var chunk = RPC_CHUNK;

      var step = function (latest) {
        if (cur > latest) return Promise.resolve(out);
        var end = Math.min(cur + chunk - 1, latest);
        return call("eth_getLogs", logParams(toHex(cur), toHex(end))).then(function (logs) {
          out = out.concat(logs || []);
          cur = end + 1;
          return step(latest);
        }).catch(function (e) {
          if (!isRangeErr(e) || chunk <= 1) throw e;
          // 优先采用报错里给出的上限; 没有则减半。缩小后会被记住并沿用,
          // 因此整个扫描最多只多花几次探测请求。
          var hint = suggestedChunk(e);
          chunk = hint ? Math.min(chunk, hint) : Math.max(1, Math.floor(chunk / 2));
          if (chunk >= end - cur + 1) chunk = Math.max(1, Math.floor((end - cur + 1) / 2));
          var projected = Math.ceil((latest - cur + 1) / chunk);
          if (projected > MAX_LOG_REQUESTS) {
            throw new Error(
              "RPC 将日志查询限制为每次 " + chunk + " 个区块；完整恢复预计需要 "
              + projected + " 次请求，已停止以避免大量消耗 RPC 配额。"
              + "请改用支持更大日志范围的 RPC，或升级为可分页定位记录的新合约。"
            );
          }
          return step(latest);
        });
      };

      return call("eth_blockNumber", []).then(function (latest) {
        if (typeof latest !== "string" || !/^0x[0-9a-f]+$/i.test(latest)) {
          throw new Error("无法获取最新区块（该钱包/RPC 不支持 eth_blockNumber）");
        }
        return step(toNum(latest));
      });
    };

    /** 新合约恢复路径：先从合约分页读取该 owner 的批次区块，再只查询这些区块。
     *  请求数约为 1 + ceil(批次数/100) + 去重后的批次区块数，不再随链高度增长。
     */
    var scanIndexed = function (call) {
      var ethCall = function (data) {
        return call("eth_call", [{ to: payload.contract, data: data }, "latest"]);
      };
      var markUnavailable = function (e) {
        var err = new Error((e && e.message) || String(e));
        err.code = "BATCH_INDEX_UNAVAILABLE";
        throw err;
      };

      return ethCall(MinABI.encodeOnchainBatchCount(target)).catch(markUnavailable)
        .then(function (rawCount) {
          var total;
          try { total = MinABI.decodeUint(rawCount); }
          catch (e) { return markUnavailable(e); }
          if (!total) return [];

          var blocks = [];
          var readPage = function (offset) {
            if (offset >= total) return Promise.resolve();
            var limit = Math.min(INDEX_PAGE_SIZE, total - offset);
            return ethCall(MinABI.encodeOnchainBatchBlocksOf(target, offset, limit))
              .then(function (rawPage) {
                var page = MinABI.decodeUint64Array(rawPage);
                if (!page.length) throw new Error("合约批次区块索引提前结束");
                blocks = blocks.concat(page);
                return readPage(offset + page.length);
              });
          };

          return readPage(0).then(function () {
            var seen = {};
            var unique = blocks.filter(function (block) {
              var key = String(block);
              if (seen[key]) return false;
              seen[key] = true;
              return true;
            }).sort(function (a, b) { return a - b; });

            var logs = [];
            var readBlock = function (i) {
              if (i >= unique.length) return Promise.resolve(logs);
              var block = toHex(unique[i]);
              return call("eth_getLogs", logParams(block, block)).then(function (found) {
                logs = logs.concat(found || []);
                return readBlock(i + 1);
              });
            };
            return readBlock(0);
          });
        });
    };

    var scan = function (call) {
      return scanIndexed(call).catch(function (e) {
        // 旧合约没有区块索引时保留兼容路径；它仍受 MAX_LOG_REQUESTS 保护，
        // 不会再因为 200 块范围限制发出数千次请求。
        if (e && e.code === "BATCH_INDEX_UNAVAILABLE") return scanLegacy(call);
        throw e;
      });
    };

    /** 逐条恢复：取回 calldata → 按偏移切片 → 核对链上摘要 → 解密。
     *
     *  摘要校验必须在解密**之前**。链上 contentHash 是可信锚点，因此即便中继
     *  被劫持，它也只能"查不到"，无法塞入伪造内容。
     *
     *  一条失败不影响其余 —— 部分可恢复是真实存在的情况（某条密文损坏），
     *  而且"密钥不对"与"数据损坏"在页面上必须能区分开。
     */
    var recoverEach = function (events, kek, call) {
      var rows = events.map(function (ev) {
        return { seq: ev.seq, timestamp: ev.timestamp, hashOk: null,
                 plain: null, bytes: 0, dataUrl: null, error: null };
      });
      // 多笔提交时, 事件里的 seq 是**全局**序号, 而 calldata 里的 blob 只存在于
      // 自己那一笔交易 —— 切片必须按 txHash 分组, 组内按 blobOffset 对应。
      // (桌面真跑抓到的 bug: 曾用全局 seq 索引单笔交易的 blob 数组, 第二笔起
      //  的记录全部"摘要不一致被拒"。单笔提交的测试永远测不出这条。)
      var byTx = {};
      events.forEach(function (ev, i) {
        if (!byTx[ev.txHash]) byTx[ev.txHash] = [];
        byTx[ev.txHash].push({ i: i, ev: ev });
      });
      var chain = Promise.resolve();
      Object.keys(byTx).forEach(function (txHash) {
        var group = byTx[txHash].slice().sort(function (a, b) {
          return a.ev.blobOffset - b.ev.blobOffset;
        });
        var sizes = group.map(function (g) { return g.ev.byteLength; });
        chain = chain.then(function () {
          return call("eth_getTransactionByHash", [txHash]).then(function (tx) {
            if (!tx || !tx.input) throw new Error("取不回交易 calldata");
            var blobs = MinABI.extractBlobs(tx.input, sizes);
            return group.reduce(function (p, g, idx) {
              var row = rows[g.i], ev = g.ev;
              return p.then(function () {
                var blob = MemoCrypto.unhex(blobs[idx]);
                return MemoCrypto.sha256(blob).then(function (digest) {
                  row.hashOk = MemoCrypto.hex(digest) === ev.contentHash;
                  if (!row.hashOk) throw new Error("内容摘要与链上不一致，已拒绝");
                  return MemoCrypto.decryptRecord(blob, kek, ev.timestamp);
                }).then(function (bytes) {
                  row.bytes = bytes.length;
                  try {
                    row.plain = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                  } catch (e) {
                    // 录音是二进制, 按文本解不出来 —— 那就给一个可保存的链接
                    row.dataUrl = bytesToDataUrl(bytes);
                  }
                }).catch(function (e) {
                  if (row.error === null) row.error = e.message || String(e);
                });
              });
            }, Promise.resolve());
          }).catch(function (e) {
            group.forEach(function (g) {
              var row = rows[g.i];
              if (row.error === null) row.error = e.message || String(e);
            });
          });
        });
      });
      return chain.then(function () { return rows; });
    };

    var renderRows = function (events, rows) {
      var bySeq = {};
      rows.forEach(function (r) { bySeq[r.seq] = r; });
      $("recovered").innerHTML = events.map(function (ev) {
        var row = bySeq[ev.seq];
        var when = new Date(ev.timestamp * 1000);
        var h = '<div class="rec">'
          + '<div class="idx">#' + ev.seq + ' · '
          + esc(isNaN(when) ? String(ev.timestamp) : when.toLocaleString()) + '</div>'
          + '<div class="kv"><b>链上摘要</b><span class="mono">'
          + esc(short(ev.contentHash, 10)) + '</span></div>'
          + '<div class="kv"><b>完整性</b><span>'
          + (row && row.hashOk === true ? "与链上摘要一致 ✓"
            : row && row.hashOk === false ? "与链上摘要不一致 ✗" : "未校验")
          + '</span></div>';
        if (row && row.plain) {
          h += '<div class="kv"><b>内容</b><span>' + esc(row.plain) + '</span></div>';
        } else if (row && row.dataUrl) {
          h += '<div class="kv"><b>内容</b><span>已解密 ' + row.bytes + ' 字节（二进制）· '
            + '<a href="' + row.dataUrl + '" download="memo-' + ev.seq + '.bin">保存</a></span></div>';
        } else if (row && row.error) {
          h += '<div class="kv"><b>内容</b><span>' + esc(row.error) + '</span></div>';
        }
        return h + '</div>';
      }).join("");
    };

    var finish = function (logs, via, kek) {
      if (!logs.length) {
        setStatus($("fetch-status"), "ok", "这个地址名下没有找到记录（经由" + via + "）");
        return Promise.resolve();
      }
      $("raw-wrap").style.display = "block";
      $("fetch-out").textContent = JSON.stringify(logs, null, 2);

      var events = logs.map(parseOnchainEvent).sort(function (a, b) { return a.seq - b.seq; });
      var continuous = events.every(function (e, i) {
        return i === 0 || e.seq === events[i - 1].seq + 1;
      });
      var head = "链上找到 " + events.length + " 条（经由" + via + "）"
        + (continuous ? "" : "；序号包含空档（可能存在旧格式记录）");

      if (!kek) {
        setStatus($("fetch-status"), continuous ? "ok" : "warn", head + "。提供恢复凭据即可解密。");
        renderRows(events, []);
        return Promise.resolve();
      }

      setStatus($("fetch-status"), "", head + "；正在本地校验并解密…");
      return recoverEach(events, kek, call)
        .then(function (rows) {
          renderRows(events, rows);
          var ok = rows.filter(function (r) { return r.plain || r.dataUrl; }).length;
          setStatus($("fetch-status"), ok === events.length ? "ok" : "warn",
            head + "；已解密 " + ok + "/" + events.length + " 条。");
        })
        .catch(function (e) {
          var msg = (e && e.message) || String(e);
          if (/WebCrypto 不可用/.test(msg)) {
            setStatus($("fetch-status"), "err",
              msg + " —— 当前地址不是 HTTPS，手机浏览器因此没有开放 WebCrypto。" +
              "请改用 https 地址打开本页（与助记词无关）。");
          } else {
            setStatus($("fetch-status"), "err", "解密失败：" + msg);
          }
        });
    };

    var call = null;   // 当前读取通道：钱包 或 回退 RPC
    var viaProvider = function (provider, kek) {
      call = function (method, params) {
        return provider.request({ method: method, params: params });
      };
      return scan(call).then(function (logs) { return finish(logs, "钱包", kek); });
    };

    var viaHttp = function (why, kek) {
      var url = $("rpc").value.trim();
      if (!url) {
        setStatus($("fetch-status"), "err",
          "钱包无法读取（" + why + "），且未填写 RPC 地址。");
        return Promise.resolve();
      }
      if (mixedContentRisk(url)) {
        setStatus($("fetch-status"), "err",
          "钱包无法读取，而页面是 https、RPC 是 http —— 会被浏览器拦截（混合内容）。");
        return Promise.resolve();
      }
      call = function (method, params) {
        return fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.error) throw new Error(j.error.message || "RPC 错误");
            return j.result;
          });
      };
      return scan(call).then(function (logs) { return finish(logs, "RPC", kek); })
        .catch(function (e) {
          setStatus($("fetch-status"), "err", "读取失败: " + e.message);
        });
    };

    var provider = getProvider();
    var kekPromise;
    if (walletRecovery) {
      if (!provider || !account) {
        setStatus($("fetch-status"), "warn", "请先连接配对钱包，再发起恢复签名。");
        return;
      }
      if (account.toLowerCase() !== target.toLowerCase()) {
        setStatus($("fetch-status"), "err", "当前钱包不是记录 owner，请切换到 " + target);
        return;
      }
      setStatus($("fetch-status"), "", "请在钱包中确认恢复声明（不会广播或上链）…");
      kekPromise = ensureChain(provider, payload)
        .then(function () { return WalletPairing.requestSignature(provider, payload, account); })
        .then(function (signature) {
          return WalletPairing.deriveKek(signature, payload, account);
        });
    } else {
      kekPromise = mnemonic ? MemoCrypto.kekFromMnemonic(mnemonic) : Promise.resolve(null);
    }

    kekPromise.then(function (kek) {
      // 设备明确提供了只读 RPC 时优先使用它。钱包 provider 仍负责账户连接、
      // 恢复签名和交易确认，但不再承担跨度受限的历史日志扫描。
      if ($("rpc").value.trim()) return viaHttp("设备已配置只读 RPC", kek);
      if (!provider) return viaHttp("未检测到钱包", kek);
      return viaProvider(provider, kek).catch(function (e) {
        var msg = (e && (e.message || e.data && e.data.message)) || String(e);
        return viaHttp(msg.slice(0, 50), kek);
      });
    }).catch(function (e) {
      setStatus($("fetch-status"), "err", "恢复授权失败: " + (e && e.message || e));
    });
  };

  // fragment 变化时重新解析: 同一 WebView 内连续扫码的场景
  window.addEventListener("hashchange", boot);
  boot();
})();
