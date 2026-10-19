// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MemoryRegistry} from "../src/MemoryRegistry.sol";

contract MemoryRegistryTest is Test {
    MemoryRegistry reg;

    address user = address(0xA11CE); // 用户钱包地址 (记录的归属)
    address other = address(0xB0B);

    event MemoAdded(address indexed owner, uint256 indexed seq, uint64 timestamp, bytes32 contentHash, string cid);

    function setUp() public {
        reg = new MemoryRegistry();
    }

    function _single(uint64 ts, bytes32 hash, string memory cid)
        internal
        pure
        returns (uint64[] memory, bytes32[] memory, string[] memory, bytes32[] memory, bytes[] memory)
    {
        uint64[] memory ts_ = new uint64[](1);
        bytes32[] memory h_ = new bytes32[](1);
        string[] memory c_ = new string[](1);
        bytes32[] memory t_ = new bytes32[](1);
        bytes[] memory k_ = new bytes[](1);
        ts_[0] = ts;
        h_[0] = hash;
        c_[0] = cid;
        t_[0] = keccak256("memo");
        k_[0] = hex"deadbeef";
        return (ts_, h_, c_, t_, k_);
    }

    /// 写入后可按序号读出, 且序列号从 0 开始连续递增
    function testAddBatchStoresAndIndexes() public {
        (uint64[] memory ts, bytes32[] memory h, string[] memory c, bytes32[] memory t, bytes[] memory k) =
            _single(1_700_000_000, keccak256("a"), "cid-a");

        vm.expectEmit(true, true, false, true, address(reg));
        emit MemoAdded(user, 0, 1_700_000_000, keccak256("a"), "cid-a");

        vm.prank(user);
        reg.addBatch(ts, h, c, t, k);

        assertEq(reg.count(user), 1, "count should be 1");
        MemoryRegistry.MemoEntry memory e = reg.entryAt(user, 0);
        assertEq(e.timestamp, 1_700_000_000);
        assertEq(e.contentHash, keccak256("a"));
        assertEq(e.cid, "cid-a");
        assertEq(e.wrappedKey, hex"deadbeef");
    }

    /// 同一批次多条: 序号连续, 计数正确
    function testBatchKeepsSequentialOrder() public {
        uint64[] memory ts = new uint64[](3);
        bytes32[] memory h = new bytes32[](3);
        string[] memory c = new string[](3);
        bytes32[] memory t = new bytes32[](3);
        bytes[] memory k = new bytes[](3);
        for (uint256 i = 0; i < 3; ++i) {
            ts[i] = 100 + uint64(i);
            h[i] = keccak256(abi.encodePacked("h", i));
            // 注意: abi.encodePacked 会把 uint256 编成 32 字节二进制, 不是十进制字符串
            c[i] = string(abi.encodePacked("cid-", vm.toString(i)));
            t[i] = bytes32(uint256(i));
            k[i] = hex"01";
        }
        vm.prank(user);
        reg.addBatch(ts, h, c, t, k);

        vm.prank(user);
        reg.addBatch(ts, h, c, t, k);

        assertEq(reg.count(user), 6);
        // 追加以保证顺序: 第 4 条 (seq=3) 应该是第二批的第一条
        assertEq(reg.entryAt(user, 3).cid, "cid-0");
        assertEq(reg.entryAt(user, 5).cid, "cid-2");
    }

    /// 换机恢复的核心: 新设备凭 owner 地址即可枚举全部历史
    function testEnumerateAllForOwner() public {
        for (uint256 i = 0; i < 5; ++i) {
            (uint64[] memory ts, bytes32[] memory h, string[] memory c, bytes32[] memory t, bytes[] memory k) = _single(
                uint64(1000 + i), keccak256(abi.encodePacked(i)), string(abi.encodePacked("cid", vm.toString(i)))
            );
            vm.prank(user);
            reg.addBatch(ts, h, c, t, k);
        }

        MemoryRegistry.MemoEntry[] memory all = reg.entriesOf(user, 0, 100);
        assertEq(all.length, 5, "should recover all 5 entries");
        assertEq(all[0].cid, "cid0");
        assertEq(all[4].cid, "cid4");
    }

    /// 分页读取, 越界返回空而不是回滚
    function testPaginationAndOutOfRange() public {
        (uint64[] memory ts, bytes32[] memory h, string[] memory c, bytes32[] memory t, bytes[] memory k) =
            _single(1, keccak256("a"), "x");
        vm.prank(user);
        reg.addBatch(ts, h, c, t, k);

        assertEq(reg.entriesOf(user, 0, 0).length, 0, "limit 0");
        assertEq(reg.entriesOf(user, 5, 10).length, 0, "offset beyond end");
        assertEq(reg.entriesOf(user, 0, 10).length, 1, "clamped to total");
    }

    /// 不同用户的历史完全隔离 —— 防止越权读取
    function testIsolationBetweenOwners() public {
        (uint64[] memory ts, bytes32[] memory h, string[] memory c, bytes32[] memory t, bytes[] memory k) =
            _single(1, keccak256("a"), "mine");
        vm.prank(user);
        reg.addBatch(ts, h, c, t, k);

        assertEq(reg.count(other), 0);
        assertEq(reg.entriesOf(other, 0, 10).length, 0);
        assertEq(reg.entriesOf(user, 0, 10).length, 1);
    }

    /// 批次承诺: 只留根, 且必须能安全枚举。
    /// 回归点: Solidity 给数组自动生成的 public getter 在越界时回滚而非返回零,
    /// 直接暴露该数组会导致"探测下一批"直接失败。故改用 batchCount + batchRootsOf。
    function testCommitBatchRoot() public {
        vm.prank(user);
        reg.commitBatchRoot(keccak256("root-1"), 12);
        vm.prank(user);
        reg.commitBatchRoot(keccak256("root-2"), 8);

        assertEq(reg.batchCount(user), 2);

        bytes32[] memory all = reg.batchRootsOf(user, 0, 100);
        assertEq(all.length, 2);
        assertEq(all[0], keccak256("root-1"));
        assertEq(all[1], keccak256("root-2"));

        // 越界必须返回空, 不回滚 —— 这样调用方才能安全探测
        assertEq(reg.batchRootsOf(user, 2, 5).length, 0, "offset at end");
        assertEq(reg.batchRootsOf(user, 99, 5).length, 0, "offset beyond end");
        assertEq(reg.batchRootsOf(other, 0, 5).length, 0, "other owner");
    }

    /// 空批次与长度不匹配必须拒绝, 避免链上写入空洞
    function testReverts() public {
        uint64[] memory empty = new uint64[](0);
        bytes32[] memory emptyH = new bytes32[](0);
        string[] memory emptyC = new string[](0);
        bytes32[] memory emptyT = new bytes32[](0);
        bytes[] memory emptyK = new bytes[](0);

        vm.prank(user);
        vm.expectRevert(MemoryRegistry.EmptyBatch.selector);
        reg.addBatch(empty, emptyH, emptyC, emptyT, emptyK);

        vm.prank(user);
        vm.expectRevert(MemoryRegistry.EmptyBatch.selector);
        reg.commitBatchRoot(bytes32(0), 0);

        // 长度不匹配
        (uint64[] memory ts, bytes32[] memory h,, bytes32[] memory t, bytes[] memory k) =
            _single(1, keccak256("a"), "x");
        string[] memory tooFew = new string[](0);
        vm.prank(user);
        vm.expectRevert(MemoryRegistry.LengthMismatch.selector);
        reg.addBatch(ts, h, tooFew, t, k);
    }

    /// 事件可用于轻量索引: 换机时按 owner 过滤 MemoAdded 即可
    function testEventsCarryEnumerationFields() public {
        (uint64[] memory ts, bytes32[] memory h, string[] memory c, bytes32[] memory t, bytes[] memory k) =
            _single(42, keccak256("z"), "cid-z");
        vm.recordLogs();
        vm.prank(user);
        reg.addBatch(ts, h, c, t, k);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == MemoAdded.selector) {
                found = true;
                // topic[1] = owner, topic[2] = seq
                assertEq(address(uint160(uint256(logs[i].topics[1]))), user);
                assertEq(uint256(logs[i].topics[2]), 0);
            }
        }
        assertTrue(found, "MemoAdded should be emitted");
    }

    function _onchainBatch(uint64 timestamp)
        internal
        pure
        returns (uint64[] memory ts, bytes32[] memory hashes, uint32[] memory lengths, bytes memory blob)
    {
        ts = new uint64[](1);
        hashes = new bytes32[](1);
        lengths = new uint32[](1);
        blob = hex"010203";
        ts[0] = timestamp;
        hashes[0] = keccak256(blob);
        lengths[0] = uint32(blob.length);
    }

    /// 恢复索引按批次记录区块并支持分页；同区块多笔交易允许产生重复区块号，
    /// 由读取端去重后只查一次日志。
    function testOnchainBatchBlockIndexPagination() public {
        (uint64[] memory ts, bytes32[] memory h, uint32[] memory lens, bytes memory blob) = _onchainBatch(100);

        vm.roll(1_000);
        vm.prank(user);
        reg.addBatchOnchain(ts, h, lens, blob);

        vm.roll(1_200);
        vm.prank(user);
        reg.addBatchOnchain(ts, h, lens, blob);
        vm.prank(user);
        reg.addBatchOnchain(ts, h, lens, blob);

        assertEq(reg.onchainBatchCount(user), 3);
        assertEq(reg.onchainBatchCount(other), 0);

        uint64[] memory first = reg.onchainBatchBlocksOf(user, 0, 2);
        assertEq(first.length, 2);
        assertEq(first[0], 1_000);
        assertEq(first[1], 1_200);

        uint64[] memory last = reg.onchainBatchBlocksOf(user, 2, 100);
        assertEq(last.length, 1);
        assertEq(last[0], 1_200);
        assertEq(reg.onchainBatchBlocksOf(user, 3, 1).length, 0);
        assertEq(reg.onchainBatchBlocksOf(user, 0, 0).length, 0);
        assertEq(reg.onchainBatchBlocksOf(other, 0, 10).length, 0);
    }

    /// 旧的 CID 存储路径不能污染 calldata 批次索引。
    function testLegacyBatchDoesNotCreateOnchainIndex() public {
        (uint64[] memory ts, bytes32[] memory h, string[] memory c, bytes32[] memory t, bytes[] memory k) =
            _single(1, keccak256("a"), "cid-a");
        vm.prank(user);
        reg.addBatch(ts, h, c, t, k);
        assertEq(reg.onchainBatchCount(user), 0);
    }
}
