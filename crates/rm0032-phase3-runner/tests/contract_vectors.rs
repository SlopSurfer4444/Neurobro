use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[test]
fn rust_contract_vector_matches_typescript_canonical_bytes() {
    let binary = env!("CARGO_BIN_EXE_rm0032-phase3-runner");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/rm0032-phase3-runner/fixtures/process-boundary-v1.json");
    let output = Command::new(binary)
        .arg("contract-vector")
        .arg(&fixture)
        .env_clear()
        .output()
        .expect("self-owned contract-vector mode must start");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let result: Value = serde_json::from_slice(&output.stdout).expect("vector result must be JSON");
    assert_eq!(
        result["schema"],
        "decadans.rm0032.contract-vector-result.v1"
    );
    assert_eq!(result["canonicalRequestBytes"], 1113);
    assert_eq!(
        result["canonicalRequestSha256"],
        "3b7f12b3dedf2d1e72aca90e49d196d8113430d08b94159dec859a59cb193929"
    );
    assert_eq!(result["refusalVectorCount"], 10);
}

#[test]
fn sidecar_persists_raw_evidence_before_ack() {
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_rm0032-phase3-runner"));
    let root = unique_test_root("success");
    fs::create_dir(&root).expect("synthetic operation root must be created");
    let marker = root.join("attempt.marker");
    let evidence = root.join("evidence.json");
    let request_path = root.join("request.json");
    let stdin = b"rust-sidecar-tracer";
    let request = json!({
        "schema": "decadans.rm0032.process-request.v1",
        "operationId": "22222222-2222-4222-8222-222222222222",
        "oneShot": true,
        "retryAuthorized": false,
        "executable": {
            "path": canonical_windows_path(&binary),
            "sha256": sha256_hex(&fs::read(&binary).expect("binary must be readable"))
        },
        "argv": ["fixture", "echo"],
        "stdin": {
            "encoding": "base64",
            "base64": "cnVzdC1zaWRlY2FyLXRyYWNlcg==",
            "bytes": stdin.len(),
            "sha256": sha256_hex(stdin)
        },
        "environment": { "inherit": false, "allowlist": [], "values": {} },
        "limits": {
            "requestBytesMax": 65536,
            "stdinBytesMax": 262144,
            "stdoutBytesMax": 1048576,
            "stderrBytesMax": 1048576,
            "evidenceBytesMax": 3145728,
            "concurrencyMax": 1,
            "childProcessMax": 1,
            "deadlineMs": 5000,
            "aggregateDeadlineMs": 420000,
            "memoryBytesMax": 268435456,
            "cpuPercentMax": 25
        },
        "containment": {
            "consumer": "phase-3-wsl-hardening-coordinator",
            "operationRoot": canonical_windows_path(&root),
            "requireCanonicalPaths": true
        },
        "attemptMarker": { "path": canonical_windows_path(&marker), "createNew": true },
        "evidence": {
            "path": canonical_windows_path(&evidence),
            "schema": "decadans.rm0032.process-evidence.v1",
            "createNew": true
        }
    });
    fs::write(
        &request_path,
        serde_json::to_vec(&request).expect("request JSON must encode"),
    )
    .expect("request must be written");

    let output = Command::new(&binary)
        .arg("run")
        .arg(&request_path)
        .env_clear()
        .output()
        .expect("sidecar run mode must start");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(marker.is_file());
    let evidence_bytes = fs::read(&evidence).expect("evidence must exist before the ack is parsed");
    let ack: Value = serde_json::from_slice(&output.stdout).expect("ack must be JSON");
    assert_eq!(ack["schema"], "decadans.rm0032.runner-ack.v1");
    assert_eq!(ack["evidenceSha256"], sha256_hex(&evidence_bytes));
    let persisted: Value = serde_json::from_slice(&evidence_bytes).expect("evidence must be JSON");
    assert_eq!(persisted["processStartCount"], 1);
    assert_eq!(persisted["terminalState"], "known-exit");
    assert_eq!(
        persisted["standardOutput"]["base64"],
        "cnVzdC1zaWRlY2FyLXRyYWNlcg=="
    );
    assert_eq!(persisted["retryPerformed"], false);

    fs::remove_dir_all(&root).expect("owned synthetic root must cleanly remove");
}

fn unique_test_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "rm0032-runner-{label}-{}-{nonce}",
        std::process::id()
    ))
}

fn canonical_windows_path(path: &Path) -> String {
    let mut text = path.to_string_lossy().replace('/', "\\");
    if text.as_bytes().get(1) == Some(&b':') {
        text.replace_range(0..1, &text[0..1].to_ascii_uppercase());
    }
    text
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
