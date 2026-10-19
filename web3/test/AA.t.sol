// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MemoryRegistry} from "../src/MemoryRegistry.sol";

/// 极简智能账户: 一个合约, 只接受 EntryPoint 驱动。
/// 真实实现(Kernel/Safe)差异在验签与恢复, 对 Registry 而言只关心一点:
/// 调用来自该合约地址本身。
contract MockAccount {
    address public immutable entryPoint;

    constructor(address ep) {
        entryPoint = ep;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == entryPoint, "not entrypoint");
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "inner call failed");
        return ret;
    }
}

/// 极简 EntryPoint + Paymaster。
/// 关键性质: gas 从 paymaster 押金扣, 账户与用户都不出钱。
contract MockEntryPoint {
    mapping(address => uint256) public deposit;

    function depositFor(address payer) external payable {
        deposit[payer] += msg.value;
    }

    function handleOp(address account, address target, bytes calldata data, address paymaster, uint256 charge)
        external
    {
        MockAccount(account).execute(target, data);
        deposit[paymaster] -= charge;
    }
}

/// 验证 AA 代付方案对 MemoryRegistry 的影响面。
///
/// 结论(由以下用例证明): **合约一行都不用改**。
/// 因为记录归属取 `msg.sender`, 而 ERC-4337 的 userOp 就是从智能账户地址执行的,
/// 所以智能账户天然成为 owner —— 与 EOA 路径共用同一份代码。
contract AATest is Test {
    MemoryRegistry registry;
    MockEntryPoint entryPoint;
    MockAccount account;

    address paymaster = address(0x9a11);
    address relayer = address(0xBEEF);

    uint256 constant CHARGE = 0.002 ether; // 模拟一次 userOp 的 gas 成本

    function setUp() public {
        registry = new MemoryRegistry();
        entryPoint = new MockEntryPoint();
        account = new MockAccount(address(entryPoint));
        vm.deal(address(entryPoint), 1 ether);
        entryPoint.depositFor{value: 1 ether}(paymaster);
    }

    function _payload() internal pure returns (bytes memory data, bytes memory part0, bytes memory part1) {
        uint64[] memory ts = new uint64[](2);
        ts[0] = 1_700_000_000;
        ts[1] = 1_700_000_060;

        bytes32[] memory hs = new bytes32[](2);
        hs[0] = keccak256("secret-one");
        hs[1] = keccak256("secret-two");

        part0 = hex"00112233445566778899aabbccddeeff";
        part1 = hex"deadbeefcafe";

        uint32[] memory ls = new uint32[](2);
        ls[0] = uint32(part0.length);
        ls[1] = uint32(part1.length);

        bytes memory blob = abi.encodePacked(part0, part1);
        data = abi.encodeCall(MemoryRegistry.addBatchOnchain, (ts, hs, ls, blob));
    }

    /// 归属落在智能账户上, 中继方名下为空。
    function testOwnershipIsSmartAccount() public {
        (bytes memory data,,) = _payload();
        entryPoint.handleOp(address(account), address(registry), data, paymaster, CHARGE);

        assertEq(registry.count(address(account)), 2, "owner should be the smart account");
        assertEq(registry.count(relayer), 0, "relayer must own nothing");
        assertEq(registry.count(address(account)), 2);
    }

    /// 用户与账户都不持币, 费用由 paymaster 押金承担。
    function testPaymasterPaysNotUser() public {
        uint256 depositBefore = entryPoint.deposit(paymaster);
        (bytes memory data,,) = _payload();
        entryPoint.handleOp(address(account), address(registry), data, paymaster, CHARGE);

        assertEq(address(account).balance, 0, "account should never hold ETH");
        assertEq(entryPoint.deposit(paymaster), depositBefore - CHARGE, "paymaster should pay");
    }

    /// 反证: 若用普通热钱包直接代发, 记录会归到中继方名下 —— 这正是必须走 AA 的原因。
    function testPlainRelayerHijacksOwnership() public {
        (bytes memory data,,) = _payload();
        vm.prank(relayer);
        (bool ok,) = address(registry).call(data);
        assertTrue(ok);

        assertEq(registry.count(relayer), 2, "recorded under relayer");
        assertEq(registry.count(address(account)), 0, "user owns nothing -> recovery would break");
    }

    /// 换机恢复第一步: 事件里的 owner 是智能账户地址, 用它即可枚举全部历史。
    function testRecoveryEnumeratesByOwner() public {
        (bytes memory data,,) = _payload();
        vm.recordLogs();
        entryPoint.handleOp(address(account), address(registry), data, paymaster, CHARGE);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 topic = keccak256("MemoOnchain(address,uint256,uint64,bytes32,uint256,uint256)");
        uint256 found = 0;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), address(account), "owner in event");
            assertEq(uint256(logs[i].topics[2]), found, "seq must be contiguous from 0");
            found++;
        }
        assertEq(found, 2, "both records indexed");
    }

    /// 密文切片公式在真实 Solidity 编码的 calldata 上成立。
    /// (JS 侧的 extractBlobs 已与 cast 逐字节比对, 这里补上 Solidity 侧闭环)
    function testBlobSliceFormulaOnSolidityCalldata() public pure {
        (bytes memory data, bytes memory part0, bytes memory part1) = _payload();

        // blob 偏移是 calldata 中固定位置的一个 32 字节字: 4 + 第3个参数头的 3*32
        uint256 blobOff;
        assembly {
            blobOff := mload(add(data, 132))
        }
        uint256 len0 = part0.length;
        uint256 len1 = part1.length;
        uint256 contentPos = 4 + blobOff + 32;

        bytes memory got0 = new bytes(len0);
        bytes memory got1 = new bytes(len1);
        for (uint256 i = 0; i < len0; ++i) got0[i] = data[contentPos + i];
        for (uint256 i = 0; i < len1; ++i) got1[i] = data[contentPos + len0 + i];

        assertEq(keccak256(got0), keccak256(part0), "segment 0");
        assertEq(keccak256(got1), keccak256(part1), "segment 1");
    }
}
