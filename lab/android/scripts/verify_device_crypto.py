#!/usr/bin/env python3
"""Verify an Android crypto-self-test result with the simulator implementation."""
import argparse
import json
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(LAB / "crypto"))
import pipeline  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("device_result", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    source = json.loads(args.device_result.read_text(encoding="utf-8"))
    blob = bytes.fromhex(source["blob_hex"])
    kek = bytes.fromhex(source["test_kek_hex"])
    timestamp = int(source["timestamp"])
    plaintext = source["plaintext"].encode("utf-8")
    rebuilt = pipeline.encrypt_record(
        plaintext,
        kek,
        timestamp,
        nonce=bytes.fromhex(source["nonce_hex"]),
        scheme=pipeline.SCHEME_WALLET,
    )
    timestamp_rejected = False
    try:
        pipeline.decrypt_record(blob, kek, timestamp + 1)
    except ValueError:
        timestamp_rejected = True
    report = {
        "kind": "android_python_crypto_crosscheck",
        "source": str(args.device_result),
        "decrypt_matches": pipeline.decrypt_record(blob, kek, timestamp) == plaintext,
        "encrypt_blob_matches": rebuilt["blob"] == blob,
        "content_hash_matches": rebuilt["contentHash"][2:] == source["content_hash"],
        "timestamp_tamper_rejected": timestamp_rejected,
        "android_tamper_rejected": bool(source["tamper_rejected"]),
        "android_qr_roundtrip": bool(source["qr_roundtrip"]),
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    if not all(v for k, v in report.items() if k not in ("kind", "source")):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
