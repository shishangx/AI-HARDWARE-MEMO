// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MemoryRegistry} from "../src/MemoryRegistry.sol";

/// 测量上链的真实成本，用于回答"设备上链要花多少钱"。
///
/// 字段大小按**落地形态**取值，而非测试用的占位值：
///   cid        Arweave 标识 "ar://" + 43 字符 ≈ 48 字节
///   wrappedKey ECIES 封装的会话密钥 ≈ 108 字节
///              (临时公钥 32 + nonce 12 + 密文 48 + tag 16)
/// 这两项是链上体积的大头，直接决定 calldata 与 SSTORE 成本。
contract GasTest is Test {
    MemoryRegistry reg;
    address user = address(0xA11CE);

    // 48 字符的 Arweave 风格标识
    string constant CID = "ar://3fXj9Kq2LmNpQrStUvWxYzAbCdEfGhIjKlMnOpQrs";

    function setUp() public {
        reg = new MemoryRegistry();
    }

    function _batch(uint256 n)
        internal
        pure
        returns (uint64[] memory ts, bytes32[] memory h, string[] memory c, bytes32[] memory t, bytes[] memory k)
    {
        ts = new uint64[](n);
        h = new bytes32[](n);
        c = new string[](n);
        t = new bytes32[](n);
        k = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            ts[i] = uint64(1700000000 + i);
            h[i] = keccak256(abi.encodePacked("hash", i));
            c[i] = CID;
            t[i] = keccak256(abi.encodePacked("tag", i));
            k[i] = new bytes(108);
        }
    }

    function testGasPerBatch() public {
        uint256[4] memory sizes = [uint256(1), 5, 10, 50];
        for (uint256 s = 0; s < sizes.length; s++) {
            uint256 n = sizes[s];
            (uint64[] memory ts, bytes32[] memory h, string[] memory c, bytes32[] memory t, bytes[] memory k) =
                _batch(n);
            vm.prank(user);
            uint256 before = gasleft();
            reg.addBatch(ts, h, c, t, k);
            uint256 used = before - gasleft();
            console.log("N=%s  gas=%s  perRecord=%s", n, used, used / n);
        }
    }

    /// 只写批次根：链上体积与条数无关，是最省的做法。
    /// 代价是明细不在链上，恢复时需另取数据。
    function testGasCommitRootOnly() public {
        vm.prank(user);
        uint256 before = gasleft();
        reg.commitBatchRoot(keccak256("batch-root"), 50);
        console.log("commitBatchRoot(50 records) gas=%s", before - gasleft());
    }

    function _blob(uint256 nbytes) internal pure returns (bytes memory b) {
        b = new bytes(nbytes);
        for (uint256 j = 0; j < nbytes; j++) {
            b[j] = bytes1(uint8(0x21 + (j % 0x5E))); // 高熵填充, 模拟密文
        }
    }

    /// 密文放 calldata 的方案: 每批只为恢复索引写一个区块号,
    /// 成本仍主要来自 calldata 的固有开销(16 gas/非零字节)。
    /// 注意: gasleft() 不含固有开销, 故此处另算并相加。
    function testGasOnchainCalldata() public {
        uint256[4] memory sizes = [uint256(22 * 1024), 55 * 1024, 110 * 1024, 220 * 1024];
        for (uint256 s = 0; s < sizes.length; s++) {
            uint256 sz = sizes[s];
            (uint64[] memory ts, bytes32[] memory h,,,) = _batch(1);
            uint32[] memory lens = new uint32[](1);
            lens[0] = uint32(sz);
            bytes memory blob = _blob(sz);
            vm.prank(user);
            uint256 before = gasleft();
            reg.addBatchOnchain(ts, h, lens, blob);
            uint256 used = before - gasleft();
            uint256 intrinsic = 21000 + sz * 16; // 基础 + 非零字节
            console.log("-- payload KB:", sz / 1024);
            console.log("   exec      :", used);
            console.log("   intrinsic :", intrinsic);
            console.log("   total     :", used + intrinsic);
        }
    }
}
