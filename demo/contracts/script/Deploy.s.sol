// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ZkApiVault} from "zkapi-contracts/ZkApiVault.sol";
import {Groth16ProofAdapter} from "zkapi-contracts/adapters/Groth16ProofAdapter.sol";

/// @title DemoBillingToken – billing token for the local demo.
/// @notice Uses 6 decimals so the protocol's integer credit amounts line up
///         with the integration's credit model (1 credit = 1 micro-USD): one
///         whole token = 1,000,000 credits = $1. A wallet then displays the
///         balance directly in dollars (e.g. 5 ZKAPI = $5), instead of an
///         arbitrary scale. Exposes a public `mint` for funding.
contract DemoBillingToken is ERC20 {
    constructor() ERC20("zkAPI Demo Credit", "ZKAPI") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title DeployScript – Local demo deployment for the zkAPI EF stack.
/// @notice Deploys an ERC20 billing token, the circuit-specific Groth16
///         verifier, and the ZkApiVault, then writes a
///         deployment manifest JSON to $OUTPUT_PATH with the exact keys the
///         demo harness reads: {vault, billingToken, treasury, noteTtl}.
/// @dev    Reads four environment variables:
///           PRIVATE_KEY – deployer key (becomes vault owner).
///           TREASURY    – operator payout address.
///           MINT_AMOUNT – billing tokens minted to the deployer (depositor).
///           OUTPUT_PATH – absolute path for the deployment manifest JSON.
///           STATE_SIGNING_KEY_X/Y – deployment-pinned Baby-JubJub key.
///           CLEARANCE_SIGNING_KEY_X/Y – deployment-pinned Baby-JubJub key.
contract DeployScript is Script {
    uint64 internal constant NOTE_TTL = 30 days;
    uint128 internal constant REQUEST_CHARGE_CAP = 1_000_000;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 mintAmount = vm.envOr("MINT_AMOUNT", uint256(0));
        string memory outputPath = vm.envString("OUTPUT_PATH");
        address deployer = vm.addr(deployerKey);
        uint256 stateKeyX = vm.envUint("STATE_SIGNING_KEY_X");
        uint256 stateKeyY = vm.envUint("STATE_SIGNING_KEY_Y");
        uint256 clearanceKeyX = vm.envUint("CLEARANCE_SIGNING_KEY_X");
        uint256 clearanceKeyY = vm.envUint("CLEARANCE_SIGNING_KEY_Y");
        address poseidonLibrary = vm.envOr("POSEIDON_ADDRESS", address(0));
        // Treasury receives the operator's consumed amount on settlement. Keep
        // it separate from the depositor so consumption is visible in the demo.
        address treasury = vm.envOr("TREASURY", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));

        vm.startBroadcast(deployerKey);

        DemoBillingToken billingToken = new DemoBillingToken();
        if (mintAmount > 0) {
            billingToken.mint(deployer, mintAmount);
        }

        Groth16ProofAdapter proofAdapter = new Groth16ProofAdapter();

        ZkApiVault vault = new ZkApiVault(
            address(billingToken),
            treasury,
            NOTE_TTL,
            REQUEST_CHARGE_CAP,
            address(proofAdapter),
            stateKeyX,
            stateKeyY,
            clearanceKeyX,
            clearanceKeyY,
            deployer
        );

        vm.stopBroadcast();

        string memory manifest = "deployment";
        vm.serializeAddress(manifest, "vault", address(vault));
        vm.serializeAddress(manifest, "billingToken", address(billingToken));
        vm.serializeAddress(manifest, "proofAdapter", address(proofAdapter));
        vm.serializeAddress(manifest, "poseidonLibrary", poseidonLibrary);
        vm.serializeAddress(manifest, "treasury", treasury);
        vm.serializeUint(manifest, "requestChargeCap", REQUEST_CHARGE_CAP);
        vm.serializeUint(manifest, "stateSigningKeyX", stateKeyX);
        vm.serializeUint(manifest, "stateSigningKeyY", stateKeyY);
        vm.serializeUint(manifest, "clearanceSigningKeyX", clearanceKeyX);
        vm.serializeUint(manifest, "clearanceSigningKeyY", clearanceKeyY);
        string memory serialized = vm.serializeUint(manifest, "noteTtl", uint256(NOTE_TTL));
        vm.writeJson(serialized, outputPath);

        console2.log("vault       ", address(vault));
        console2.log("billingToken", address(billingToken));
        console2.log("treasury    ", treasury);
        console2.log("proofAdapter", address(proofAdapter));
        console2.log("noteTtl     ", uint256(NOTE_TTL));
        console2.log("manifest    ", outputPath);
    }
}
