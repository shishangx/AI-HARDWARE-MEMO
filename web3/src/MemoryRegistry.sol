// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title 语音备忘录的链上索引
/// @notice 只存"指针 + 摘要 + 封装密钥", 不存内容。音频密文放在去中心化存储上,
///         链上仅保留可枚举、不可篡改的索引, 使换机后能重建完整历史。
///
/// 设计取舍
/// --------
/// 1. 记录归属由 `owner` 决定, 即用户钱包地址。设备不持有链上私钥, 因此换设备
///    不会改变记录归属 —— 这是"换机可恢复"的基础。
/// 2. 只读方法 (getLogs / entries) 用于换机后枚举历史; 写入按批次进行, 以摊薄
///    用户的确认次数与 gas 成本。
/// 3. `tagHash` 存哈希而非明文, 避免把个人分类信息暴露给全链。
contract MemoryRegistry {
    struct MemoEntry {
        uint64 timestamp; // 设备侧记录时间 (秒)
        bytes32 contentHash; // 密文的内容摘要, 用于校验中继拿回的数据
        string cid; // 去中心化存储的寻址标识
        bytes32 tagHash; // 标签的分类摘要
        bytes wrappedKey; // 兼容保留字段，当前恒为空（密钥由助记词派生，勿依赖）
    }

    /// 按用户归集的记录。外部按 owner 枚举即可重建该用户的全部历史。
    mapping(address => MemoEntry[]) private _entries;
    mapping(address => uint256) public count;

    /// 批次根: 用于把一批记录压缩成一次承诺。
    /// @dev 私有。Solidity 为数组自动生成的 getter 在越界时会 **回滚** 而不是返回空,
    ///      直接用它做枚举无法安全判断"是否还有下一批"。故只暴露带边界检查的
    ///      batchCount / batchRootsOf。
    mapping(address => bytes32[]) private _batchRoots;
    mapping(address => uint256) public batchCount;

    /// 每次 addBatchOnchain 所在的区块。恢复端先分页读取这些区块，再只对命中
    /// 区块调用 eth_getLogs，避免从部署块遍历到最新块。
    /// uint64 足以容纳区块高度，且数组元素可在存储槽内紧凑排列。
    mapping(address => uint64[]) private _onchainBatchBlocks;

    event MemoAdded(address indexed owner, uint256 indexed seq, uint64 timestamp, bytes32 contentHash, string cid);
    event BatchCommitted(address indexed owner, uint256 indexed batchId, bytes32 root, uint256 count);

    error EmptyBatch();
    error LengthMismatch();
    error NotBatchOwner();

    /// @notice 写入一批记录。一次交易提交多条, 减少用户确认次数。
    function addBatch(
        uint64[] calldata timestamps,
        bytes32[] calldata contentHashes,
        string[] calldata cids,
        bytes32[] calldata tagHashes,
        bytes[] calldata wrappedKeys
    ) external {
        uint256 n = contentHashes.length;
        if (n == 0) revert EmptyBatch();
        if (timestamps.length != n || cids.length != n || tagHashes.length != n || wrappedKeys.length != n) {
            revert LengthMismatch();
        }

        for (uint256 i = 0; i < n; ++i) {
            uint256 seq = _entries[msg.sender].length;
            _entries[msg.sender].push(
                MemoEntry({
                    timestamp: timestamps[i],
                    contentHash: contentHashes[i],
                    cid: cids[i],
                    tagHash: tagHashes[i],
                    wrappedKey: wrappedKeys[i]
                })
            );
            emit MemoAdded(msg.sender, seq, timestamps[i], contentHashes[i], cids[i]);
        }
        count[msg.sender] += n;
    }

    /// @notice 密文上链事件。用于恢复时定位 calldata 中的密文位置。
    /// @dev 不存 cid —— 密文就在本笔交易的 calldata 里, 由 blobOffset/byteLength 定位。
    event MemoOnchain(
        address indexed owner,
        uint256 indexed seq,
        uint64 timestamp,
        bytes32 contentHash,
        uint256 blobOffset,
        uint256 byteLength
    );

    /// @notice 把密文直接放进交易 calldata 保管 —— 仅保存批次区块索引，不保存密文。
    ///
    /// @dev 思路: 区块历史本身就是一份公开、不可篡改、可复制的账本。密文放进
    ///      calldata 后永久留在该笔交易里, 因此不需要 Arweave 之类的专用存储
    ///      网络, 也不需要 CID。
    ///
    /// 布局: 所有密文首尾相接放进 `blob`, `lengths` 给出每条的字节数。
    ///      这样恢复端只需按偏移切片, **不需要解析 ABI 数组结构**:
    ///        1. eth_getLogs 取 MemoOnchain 事件 → 得到 transactionHash
    ///        2. eth_getTransactionByHash → 取 input
    ///        3. blob 在 input 中的位置 = 4 + (第 3 个参数头里的偏移) + 32
    ///           (该偏移是 calldata 中固定位置的一个 32 字节字, 直接读取即可)
    ///        4. 按 blobOffset / byteLength 切片
    ///
    /// 成本主要来自 calldata 16 gas/非零字节；每批额外写入一个紧凑区块索引。
    ///      对 22KB 单条, Base 上约 $0.0065 —— 比"存储索引 + Arweave"的
    ///      $0.0172 便宜约 2.6 倍, 且少一个外部依赖。
    ///
    /// ⚠ 两点必须权衡(详见文档):
    ///   1. **持久性由节点政策决定**。calldata 位于区块体内, 而 EIP-4444 计划
    ///      让节点默认修剪一年以上的区块体。归档节点会保留, 但这不是像
    ///      Arweave 那样"已付费保证永久"。对"防丢失"这类核心承诺, 需要明确
    ///      接受这一点, 或对高价值记录额外做一份备份。
    ///   2. **钱包需签更大的交易**。22KB calldata 对移动端钱包的界面与估算
    ///      是负担, 需实测确认 imToken 能否顺畅处理。
    function addBatchOnchain(
        uint64[] calldata timestamps,
        bytes32[] calldata contentHashes,
        uint32[] calldata lengths,
        bytes calldata blob
    ) external {
        uint256 n = lengths.length;
        if (n == 0) revert EmptyBatch();
        if (timestamps.length != n || contentHashes.length != n) revert LengthMismatch();

        uint256 seq = count[msg.sender];
        uint256 off = 0;
        for (uint256 i = 0; i < n; ++i) {
            emit MemoOnchain(msg.sender, seq + i, timestamps[i], contentHashes[i], off, lengths[i]);
            off += lengths[i];
        }
        require(off == blob.length, "blob length mismatch");
        count[msg.sender] = seq + n; // 整批一次写入
        _onchainBatchBlocks[msg.sender].push(uint64(block.number));
    }

    /// @notice 某用户通过 addBatchOnchain 写入的批次数量。
    function onchainBatchCount(address owner) external view returns (uint256) {
        return _onchainBatchBlocks[owner].length;
    }

    /// @notice 分页返回批次所在区块。调用方应对重复区块去重后查询日志，因为同一
    ///         用户的多笔交易可能被打包进同一个区块。
    function onchainBatchBlocksOf(address owner, uint256 offset, uint256 limit)
        external
        view
        returns (uint64[] memory page)
    {
        uint256 total = _onchainBatchBlocks[owner].length;
        if (offset >= total) return new uint64[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new uint64[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _onchainBatchBlocks[owner][i];
        }
    }

    /// @notice 记录一条"批次承诺"。链上只留根, 明细由事件承载。
    /// @dev 便于需要"先承诺、后揭示"或仅需存证完整性时使用。
    function commitBatchRoot(bytes32 root, uint256 batchCount_) external {
        if (batchCount_ == 0) revert EmptyBatch();
        uint256 batchId = _batchRoots[msg.sender].length;
        _batchRoots[msg.sender].push(root);
        batchCount[msg.sender] = batchId + 1;
        emit BatchCommitted(msg.sender, batchId, root, batchCount_);
    }

    /// @notice 读取某用户的单条记录。
    function entryAt(address owner, uint256 seq) external view returns (MemoEntry memory) {
        require(seq < _entries[owner].length, "out of range");
        return _entries[owner][seq];
    }

    /// @notice 分页读取批次根。越界返回空数组, **不回滚** —— 便于安全枚举。
    function batchRootsOf(address owner, uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        uint256 total = _batchRoots[owner].length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _batchRoots[owner][i];
        }
    }

    /// @notice 分页读取, 避免一次拉取过多导致 RPC 返回过大。
    function entriesOf(address owner, uint256 offset, uint256 limit) external view returns (MemoEntry[] memory page) {
        uint256 total = _entries[owner].length;
        if (offset >= total) return new MemoEntry[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new MemoEntry[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _entries[owner][i];
        }
    }
}
