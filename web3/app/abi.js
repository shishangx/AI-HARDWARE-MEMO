/*
 * MemoryRegistry 的最小 ABI 编码器。
 *
 * 为什么手写而不引入 ethers/viem: 这个页面最终要在 imToken 的 WebView 里打开,
 * 且设备端产物应当是"一个可长期自查的静态文件"。为一个函数引入完整 web3 库不值得,
 * 但手写编码一旦出错就是"静默写坏数据", 因此必须用 cast 逐字节校验
 * (见 tools/verify_abi.mjs)。
 *
 * 同时兼容浏览器 (挂到 window.MinABI) 与 Node (module.exports),
 * 使同一份代码既能被页面加载, 也能被校验脚本调用 —— 避免两处实现漂移。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MinABI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // keccak256("addBatch(uint64[],bytes32[],string[],bytes32[],bytes[])")[0:4]
  // 由 cast sig 取得; 若合约函数签名变更必须同步更新, 校验脚本会拦截不一致。
  var ADD_BATCH_SELECTOR = "2709cfbb";

  // keccak256("addBatchOnchain(uint64[],bytes32[],uint32[],bytes)")[0:4]
  // 密文随 calldata 上链的方案。
  var ADD_ONCHAIN_SELECTOR = "bdbfa2e1";

  // keccak256("onchainBatchCount(address)")[0:4]
  var ONCHAIN_BATCH_COUNT_SELECTOR = "053a4325";

  // keccak256("onchainBatchBlocksOf(address,uint256,uint256)")[0:4]
  var ONCHAIN_BATCH_BLOCKS_SELECTOR = "7f08677f";

  var encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

  function utf8Hex(str) {
    if (encoder) {
      var bytes = encoder.encode(str);
      var out = "";
      for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
      return out;
    }
    // Node 兜底
    return Buffer.from(str, "utf8").toString("hex");
  }

  function strip(hex) {
    var h = String(hex || "").trim();
    if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
    return h.toLowerCase();
  }

  function word(n) {
    return n.toString(16).padStart(64, "0");
  }

  function bytes32Word(hex) {
    var h = strip(hex);
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("bytes32 需要 32 字节: " + hex);
    return h;
  }

  function addressWord(address) {
    var h = strip(address);
    if (!/^[0-9a-f]{40}$/.test(h)) throw new Error("address 需要 20 字节: " + address);
    return h.padStart(64, "0");
  }

  function encodeOnchainBatchCount(owner) {
    return "0x" + ONCHAIN_BATCH_COUNT_SELECTOR + addressWord(owner);
  }

  function encodeOnchainBatchBlocksOf(owner, offset, limit) {
    return "0x" + ONCHAIN_BATCH_BLOCKS_SELECTOR + addressWord(owner)
      + word(Number(offset)) + word(Number(limit));
  }

  function decodeUint(hex) {
    var h = strip(hex);
    if (h.length < 64) throw new Error("ABI uint 返回值为空或被截断");
    var n = BigInt("0x" + h.slice(0, 64));
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ABI uint 超出安全整数范围");
    return Number(n);
  }

  function decodeUint64Array(hex) {
    var h = strip(hex);
    if (h.length < 128) throw new Error("ABI uint64[] 返回值为空或被截断");
    var offset = decodeUint("0x" + h.slice(0, 64));
    var base = offset * 2;
    if (base + 64 > h.length) throw new Error("ABI uint64[] 偏移越界");
    var count = decodeUint("0x" + h.slice(base, base + 64));
    if (base + 64 + count * 64 > h.length) throw new Error("ABI uint64[] 数据被截断");
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push(decodeUint("0x" + h.slice(base + 64 + i * 64, base + 128 + i * 64)));
    }
    return out;
  }

  /** 字符串/字节 -> ABI 动态部分: 长度字 + 右侧零填充至 32 字节边界 */
  function dynamicBytes(hexNo0x) {
    var h = hexNo0x;
    var len = h.length / 2;
    var padLen = Math.ceil(len / 32) * 32 * 2;
    return word(len) + (padLen > h.length ? h.padEnd(padLen, "0") : h);
  }

  /**
   * 编码 addBatch(uint64[],bytes32[],string[],bytes32[],bytes[]).
   * @param {Array} entries 每项: {timestamp, contentHash, cid, tagHash, wrappedKey}
   * @returns {string} 0x 开头的调用数据
   */
  function encodeAddBatch(entries) {
    if (!entries || !entries.length) throw new Error("批次不能为空");
    var n = entries.length;

    // 五个动态参数的尾部数据。每个尾部内部下标 / 长度均按 ABI 规则计算。
    var tails = [];

    // 1) uint64[] timestamps
    var t1 = word(n);
    for (var i = 0; i < n; i++) t1 += word(Number(entries[i].timestamp));
    tails.push(t1);

    // 2) bytes32[] contentHashes
    var t2 = word(n);
    for (var j = 0; j < n; j++) t2 += bytes32Word(entries[j].contentHash);
    tails.push(t2);

    // 3) string[] cids —— 元素是动态类型, 故需要二级偏移表
    // 注意: ABI 规定元素偏移相对"偏移表起点"计数, **不含**长度字。
    // 故首元素偏移为 n*32, 而非 (1+n)*32 —— 后者会静默编码出错误数据。
    var headSize = n * 32;
    var offsets3 = [];
    var body3 = "";
    var cursor3 = headSize;
    for (var k = 0; k < n; k++) {
      offsets3.push(cursor3);
      var piece = dynamicBytes(utf8Hex(entries[k].cid || ""));
      body3 += piece;
      cursor3 += piece.length / 2;
    }
    tails.push(word(n) + offsets3.map(word).join("") + body3);

    // 4) bytes32[] tagHashes
    var t4 = word(n);
    for (var m = 0; m < n; m++) t4 += bytes32Word(entries[m].tagHash);
    tails.push(t4);

    // 5) bytes[] wrappedKeys —— 同 string[], 二级偏移, 基准同上
    var offsets5 = [];
    var body5 = "";
    var cursor5 = headSize;
    for (var p = 0; p < n; p++) {
      offsets5.push(cursor5);
      var kb = dynamicBytes(strip(entries[p].wrappedKey || ""));
      body5 += kb;
      cursor5 += kb.length / 2;
    }
    tails.push(word(n) + offsets5.map(word).join("") + body5);

    // 头部: 每个尾部相对参数区起点的偏移
    var offsets = [];
    var cursor = 5 * 32;
    for (var q = 0; q < tails.length; q++) {
      offsets.push(cursor);
      cursor += tails[q].length / 2;
    }

    return "0x" + ADD_BATCH_SELECTOR + offsets.map(word).join("") + tails.join("");
  }

  /** 编码 commitBatchRoot(bytes32,uint256) */
  function encodeCommitBatchRoot(root, batchCount) {
    return "0x00527028" + bytes32Word(root) + word(Number(batchCount));
  }

  /**
   * 编码 addBatchOnchain(uint64[],bytes32[],uint32[],bytes)。
   *
   * 布局: 所有密文首尾相接放进一个 `blob`, `lengths` 给出每条的字节数。
   * 这样恢复端只需按偏移切片, 不必解析 ABI 数组结构 —— 见 blobLayout()。
   *
   * @param {Array} entries 每项: {timestamp, contentHash, payloadHex}
   * @returns {{data: string, blobOffset: number, sizes: number[]}}
   *          blobOffset 为 blob 的**长度字**在 calldata 中的字节偏移,
   *          正文起点是其 +32。
   */
  function encodeAddBatchOnchain(entries) {
    if (!entries || !entries.length) throw new Error("批次不能为空");
    var n = entries.length;

    var lengths = [];
    var blobHex = "";
    for (var i = 0; i < n; i++) {
      var h = strip(entries[i].payloadHex || "");
      if (h.length % 2) throw new Error("payloadHex 长度须为偶数");
      lengths.push(h.length / 2);
      blobHex += h;
    }

    // uint64[] timestamps
    var tA = word(n);
    for (var a = 0; a < n; a++) tA += word(Number(entries[a].timestamp));

    // bytes32[] contentHashes
    var tB = word(n);
    for (var b = 0; b < n; b++) tB += bytes32Word(entries[b].contentHash);

    // uint32[] lengths
    var tC = word(n);
    for (var c = 0; c < n; c++) tC += word(lengths[c]);

    // bytes blob
    var tD = dynamicBytes(blobHex);

    var tails = [tA, tB, tC, tD];
    var offsets = [];
    var cursor = tails.length * 32;      // 4 个参数 -> 头部 4*32 字节
    for (var q = 0; q < tails.length; q++) {
      offsets.push(cursor);
      cursor += tails[q].length / 2;
    }

    // blob 的偏移字位于第 4 个参数的头里: 选择器(4) + 3*32, 值为 offsets[3]
    var blobOffset = 4 + 3 * 32;
    return {
      data: "0x" + ADD_ONCHAIN_SELECTOR + offsets.map(word).join("") + tails.join(""),
      blobOffset: blobOffset,
      sizes: lengths,
    };
  }

  /**
   * 页面提交入口：只接受包含密文的记录，并直接返回 eth_sendTransaction 需要的 data。
   *
   * 页面内部把二维码里的短字段 `b` 展开为 `blob`。把校验和字段映射集中到这里，
   * 可避免字段名漂移后静默退回只写摘要、无法恢复的旧提交路径。
   */
  function encodeRecoverableBatch(entries) {
    if (!entries || !entries.length) throw new Error("批次不能为空");
    var onchainEntries = entries.map(function (entry, i) {
      var blob = entry.blob || "";
      if (!blob) {
        throw new Error("记录 #" + i + " 不含链上密文，请回到设备重新生成二维码");
      }
      return {
        timestamp: entry.timestamp,
        contentHash: entry.contentHash,
        payloadHex: blob,
      };
    });
    return encodeAddBatchOnchain(onchainEntries).data;
  }

  /**
   * 从交易 calldata 中切出各条密文 —— 恢复路径的核心。
   *
   * 依赖一个稳定的事实: blob 的偏移是 calldata 中**固定位置**的一个 32 字节字
   * (选择器 4 字节 + 前三个参数各 32 字节), 直接读取即可, 无需解析数组。
   */
  function extractBlobs(inputHex, sizes) {
    var h = strip(inputHex);
    var offWordPos = (4 + 3 * 32) * 2;               // 转成十六进制字符下标
    var blobOff = parseInt(h.substr(offWordPos, 64), 16);
    var blobLen = parseInt(h.substr((4 + blobOff) * 2, 64), 16);
    var start = (4 + blobOff + 32) * 2;
    var blobHex = h.substr(start, blobLen * 2);

    var out = [];
    var cur = 0;
    for (var i = 0; i < sizes.length; i++) {
      out.push("0x" + blobHex.substr(cur * 2, sizes[i] * 2));
      cur += sizes[i];
    }
    return out;
  }

  /** 计算批次根: keccak 不可用时退化为"内容摘要的拼接哈希"由链下算好传入 */
  function hexToBytes(hex) {
    var h = strip(hex);
    if (h.length % 2) h = "0" + h;
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  return {
    ADD_BATCH_SELECTOR: ADD_BATCH_SELECTOR,
    ADD_ONCHAIN_SELECTOR: ADD_ONCHAIN_SELECTOR,
    ONCHAIN_BATCH_COUNT_SELECTOR: ONCHAIN_BATCH_COUNT_SELECTOR,
    ONCHAIN_BATCH_BLOCKS_SELECTOR: ONCHAIN_BATCH_BLOCKS_SELECTOR,
    encodeAddBatch: encodeAddBatch,
    encodeAddBatchOnchain: encodeAddBatchOnchain,
    encodeOnchainBatchCount: encodeOnchainBatchCount,
    encodeOnchainBatchBlocksOf: encodeOnchainBatchBlocksOf,
    decodeUint: decodeUint,
    decodeUint64Array: decodeUint64Array,
    encodeRecoverableBatch: encodeRecoverableBatch,
    extractBlobs: extractBlobs,
    encodeCommitBatchRoot: encodeCommitBatchRoot,
    utf8Hex: utf8Hex,
    hexToBytes: hexToBytes,
  };
});
