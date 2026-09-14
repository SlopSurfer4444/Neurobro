#[path = "../src/main.rs"]
mod observer;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;

const FAMILIES: [&str; 8] = [
    "canonical",
    "scalar",
    "terminal",
    "framing",
    "read-bound-file",
    "create-new-durable-file",
    "deadline-resource",
    "adapter",
];

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/rm0032-phase3-runner/fixtures/phase3-native-observer-v1.json"
    ))
    .expect("invented fixture must be strict JSON")
}

fn assert_hostile_ids(group: &Value, expected: &[&str]) {
    let actual = group["hostileDescriptors"]
        .as_array()
        .expect("hostile descriptors")
        .iter()
        .map(|descriptor| descriptor["id"].as_str().expect("hostile id"))
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
    let unique = actual
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), actual.len());
}

fn assert_exact_object_keys(value: &Value, expected: &[&str]) {
    let mut actual = value
        .as_object()
        .expect("closed-shape value must be an object")
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut expected = expected.to_vec();
    actual.sort_unstable();
    expected.sort_unstable();
    assert_eq!(actual, expected);
}

fn stable_binding(handle_id: u64, final_path: &str) -> observer::StableAncestorBinding {
    observer::StableAncestorBinding {
        handle_id,
        identity: observer::StableAncestorIdentity {
            volume_serial_number: "0123456789abcdef".to_owned(),
            file_id: format!("{handle_id:032x}"),
            final_path: final_path.to_owned(),
            directory: true,
            reparse_free: true,
        },
    }
}

#[cfg(windows)]
fn with_native_temp_tree(test: impl FnOnce(&std::path::Path, &str)) {
    let parent = std::env::temp_dir();
    let leaf = format!(
        "decadans-rm0032-native-observer-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    );
    let root = parent.join(&leaf);
    std::fs::create_dir(&root).expect("create unique invented native test root");
    let canonical = std::fs::canonicalize(&root).expect("canonical invented native test root");
    let mut root_dos = canonical
        .to_string_lossy()
        .strip_prefix("\\\\?\\")
        .expect("Windows canonical temp path has native prefix")
        .to_owned();
    let drive = root_dos.as_bytes()[0].to_ascii_uppercase() as char;
    root_dos.replace_range(0..1, &drive.to_string());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        test(&root, &root_dos);
    }));
    assert_eq!(root.parent(), Some(parent.as_path()));
    assert_eq!(
        root.file_name().and_then(|name| name.to_str()),
        Some(leaf.as_str())
    );
    std::fs::remove_dir_all(&root).expect("remove exact invented native test root");
    assert!(!root.exists());
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}

#[cfg(windows)]
fn native_request(operation: &str, root: &str, target: &str, content: Option<&[u8]>) -> Vec<u8> {
    let mut request = serde_json::json!({
        "schema": observer::REQUEST_SCHEMA,
        "version": observer::VERSION,
        "consumer": observer::CONSUMER,
        "operation": operation,
        "requestId": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
        "rootPath": root,
        "targetPath": target,
    });
    if let Some(content) = content {
        request
            .as_object_mut()
            .expect("native request object")
            .insert(
                "contentBase64".to_owned(),
                Value::String(STANDARD.encode(content)),
            );
    }
    observer::canonical_json_bytes(&request).expect("canonical native test request")
}

#[cfg(windows)]
fn assert_native_terminal(stdout: &[u8], outcome: &str, stage: &str, effect: &str) {
    let terminal = observer::parse_canonical_json_value(stdout).expect("native terminal");
    observer::validate_terminal(&terminal).expect("native terminal shape");
    assert_eq!(terminal["outcome"], outcome);
    assert_eq!(terminal["failureStage"], stage);
    assert_eq!(terminal["effectState"], effect);
}

#[cfg(windows)]
fn assert_native_read_fail_closed(stdout: &[u8]) {
    let terminal = observer::parse_canonical_json_value(stdout).expect("native read terminal");
    observer::validate_terminal(&terminal).expect("native read terminal shape");
    assert!(matches!(
        terminal["outcome"].as_str(),
        Some("refused" | "unknown")
    ));
    assert!(matches!(
        terminal["failureStage"].as_str(),
        Some("pre-effect" | "read-observation")
    ));
    assert_eq!(terminal["effectState"], "none");
}

#[cfg(windows)]
fn run_native_with_binding(arguments: &[String], input: &[u8]) -> observer::ObserverRunResult {
    let raw = observer::fixture_drive_binding_record(input).expect("real fixture drive metadata");
    let calls = std::cell::Cell::new(0);
    let result = observer::run_observer_with_fixture_environment(
        arguments, input, std::time::Instant::now(),
        || {
            calls.set(calls.get() + 1);
            vec![(observer::DRIVE_BINDING_ENV.into(), raw.into())]
        },
    );
    assert_eq!(calls.get(), 1);
    result
}

#[cfg(windows)]
fn windows_native_read_evidence() {
    with_native_temp_tree(|root, root_dos| {
        let read_path = root.join("read.bin");
        let read_target = format!("{root_dos}\\read.bin");
        std::fs::write(&read_path, b"native-read-proof").expect("invented read file");
        let known = run_native_with_binding(
            &[observer::CLI_MODE.to_owned()],
            &native_request("read-bound-file", root_dos, &read_target, None),
        );
        assert_eq!(known.exit_code, 0);
        let lf = known
            .stdout
            .iter()
            .position(|byte| *byte == b'\n')
            .expect("known LF");
        let observation = observer::parse_canonical_json_value(&known.stdout[..lf])
            .expect("native read observation");
        let acknowledgment = observer::parse_canonical_json_value(&known.stdout[lf + 1..])
            .expect("native read acknowledgment");
        assert_eq!(observation["operation"], "read-bound-file");
        assert_eq!(acknowledgment["outcome"], "known");

        let directory_path = root.join("directory-target");
        std::fs::create_dir(&directory_path).expect("invented directory target");
        let directory_target = format!("{root_dos}\\directory-target");
        let directory = run_native_with_binding(
            &[observer::CLI_MODE.to_owned()],
            &native_request("read-bound-file", root_dos, &directory_target, None),
        );
        assert_native_read_fail_closed(&directory.stdout);

        let oversized_path = root.join("oversized.bin");
        std::fs::write(&oversized_path, vec![0x61; 262_145]).expect("invented oversized file");
        let oversized_target = format!("{root_dos}\\oversized.bin");
        let oversized = run_native_with_binding(
            &[observer::CLI_MODE.to_owned()],
            &native_request("read-bound-file", root_dos, &oversized_target, None),
        );
        assert_native_read_fail_closed(&oversized.stdout);
    });
}

#[cfg(windows)]
fn windows_native_create_evidence() {
    with_native_temp_tree(|root, root_dos| {
        let created_path = root.join("created.bin");
        let created_target = format!("{root_dos}\\created.bin");
        let request = native_request(
            "create-new-durable-file",
            root_dos,
            &created_target,
            Some(b"native-create-proof"),
        );
        let known = run_native_with_binding(&[observer::CLI_MODE.to_owned()], &request);
        assert_eq!(known.exit_code, 0);
        let lf = known
            .stdout
            .iter()
            .position(|byte| *byte == b'\n')
            .expect("known LF");
        let acknowledgment = observer::parse_canonical_json_value(&known.stdout[lf + 1..])
            .expect("native create acknowledgment");
        assert_eq!(acknowledgment["outcome"], "known");
        assert_eq!(
            std::fs::read(&created_path).expect("read production-created file"),
            b"native-create-proof"
        );
        std::fs::remove_file(&created_path)
            .expect("known production handles released before exact file cleanup");
        assert!(!created_path.exists());

        std::fs::write(&created_path, b"collision").expect("invented collision file");
        let collision = run_native_with_binding(&[observer::CLI_MODE.to_owned()], &request);
        assert_native_terminal(
            &collision.stdout,
            "refused",
            "create-collision",
            "not-created",
        );
        std::fs::remove_file(&created_path)
            .expect("collision path handles released before exact file cleanup");
    });
}

fn canonical_group() {
    let fixture = fixture();
    let record = fixture.as_object().expect("fixture object");
    let group_ids = fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .map(|group| group["id"].as_str().expect("group id"))
        .collect::<Vec<_>>();
    assert_eq!(group_ids, FAMILIES);
    assert_eq!(
        group_ids
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        FAMILIES.len()
    );
    assert_eq!(
        record.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "groups",
            "knownAnswerTests",
            "limits",
            "protocolLiterals",
            "schema",
            "version",
        ]
    );
    assert_eq!(
        fixture["schema"],
        "decadans.rm0032.phase3-native-observer-fixture.v1"
    );
    assert_eq!(fixture["version"], "v1");
    assert_exact_object_keys(
        &fixture["protocolLiterals"],
        &[
            "fixtureSchema",
            "requestSchema",
            "observationSchema",
            "acknowledgmentSchema",
            "preObservationRefusalSchema",
            "terminalFailureSchema",
            "version",
            "consumer",
            "cliMode",
            "stdinFraming",
            "successStdoutFraming",
            "terminalStdoutFraming",
            "recognizedExitCode",
            "reservedUnableToEmitExitCode",
        ],
    );
    for group in fixture["groups"].as_array().expect("groups") {
        assert_exact_object_keys(group, &["id", "vectors", "hostileDescriptors"]);
        for descriptor in group["hostileDescriptors"]
            .as_array()
            .expect("hostile descriptors")
        {
            let payload_key = ["utf8Base64", "hex", "bytes", "mutation"]
                .into_iter()
                .find(|key| descriptor.get(*key).is_some());
            match payload_key {
                Some(key) => assert_exact_object_keys(descriptor, &["id", key]),
                None => assert_exact_object_keys(descriptor, &["id"]),
            }
        }
        let vectors = group["vectors"].as_array().expect("group vectors");
        match group["id"].as_str().expect("group id") {
            "canonical" => assert_exact_object_keys(
                &vectors[0],
                &[
                    "knownAnswerNames",
                    "wireKnownAnswerTests",
                    "canonicalPropertyOrder",
                    "admittedEscapes",
                    "admittedNumberDomain",
                ],
            ),
            "scalar" => {
                assert_eq!(vectors.len(), 2);
                assert_exact_object_keys(
                    &vectors[0],
                    &[
                        "requestId",
                        "sha256",
                        "base64",
                        "rootPath",
                        "targetPath",
                        "trustedRootFinalPath",
                        "trustedTargetFinalPath",
                    ],
                );
                assert_exact_object_keys(
                    &vectors[1],
                    &["invalidInputPaths", "validLookalikePaths"],
                );
            }
            "terminal" => vectors
                .iter()
                .for_each(|tuple| assert_eq!(tuple.as_array().expect("terminal tuple").len(), 4)),
            "framing" => assert_exact_object_keys(
                &vectors[0],
                &[
                    "argv",
                    "stdin",
                    "stdoutSuccess",
                    "stdoutTerminal",
                    "recognizedExitCode",
                    "reservedUnableToEmitExitCode",
                ],
            ),
            "read-bound-file" => {
                assert_exact_object_keys(
                    &vectors[0],
                    &[
                        "rootFinalPath",
                        "identity",
                        "contentBase64",
                        "contentSha256",
                        "readChunkBytes",
                    ],
                );
                assert_exact_object_keys(
                    &vectors[0]["identity"],
                    &[
                        "volumeSerialNumber",
                        "fileId",
                        "size",
                        "lastWriteTime",
                        "fileAttributes",
                        "finalPath",
                    ],
                );
            }
            "create-new-durable-file" => {
                assert_exact_object_keys(
                    &vectors[0],
                    &[
                        "name",
                        "contentBase64",
                        "contentSha256",
                        "writeRequestedBytes",
                        "writeReturnedBytes",
                    ],
                );
                assert_exact_object_keys(
                    &vectors[1],
                    &[
                        "name",
                        "contentBase64",
                        "writeCallCount",
                        "writeRequestedBytes",
                        "terminal",
                        "laterAction",
                    ],
                );
                assert_exact_object_keys(
                    &vectors[2],
                    &[
                        "name",
                        "contentBase64",
                        "writeCallCount",
                        "terminal",
                        "laterAction",
                    ],
                );
                assert_exact_object_keys(&vectors[3], &["name", "terminal"]);
            }
            "deadline-resource" => {
                assert_exact_object_keys(
                    &vectors[0],
                    &[
                        "operationStartMonotonicMs",
                        "aggregateStartMonotonicMs",
                        "operationDeadlineMonotonicMs",
                        "aggregateDeadlineMonotonicMs",
                        "earliestDeadlineMonotonicMs",
                        "terminationRequestMax",
                        "drainGraceMs",
                        "ownedHandleKinds",
                    ],
                );
                assert_exact_object_keys(
                    &vectors[1],
                    &[
                        "operationStartMonotonicMs",
                        "aggregateStartMonotonicMs",
                        "operationDeadlineMonotonicMs",
                        "aggregateDeadlineMonotonicMs",
                        "earliestDeadlineMonotonicMs",
                    ],
                );
            }
            "adapter" => {
                assert_exact_object_keys(
                    &vectors[0],
                    &[
                        "acceptedBinding",
                        "evidenceRootPolicy",
                        "invocationAttemptCount",
                        "stoppedCallInvocationAttemptCount",
                        "transportProductionImplementationPresent",
                        "retryAuthorized",
                        "cleanupAuthorized",
                        "fallbackAuthorized",
                    ],
                );
                assert_exact_object_keys(
                    &vectors[0]["acceptedBinding"],
                    &[
                        "observerAbsolutePath",
                        "observerSha256",
                        "evidenceRootAbsolutePath",
                    ],
                );
            }
            _ => panic!("unexpected group"),
        }
    }
    for kat in fixture["knownAnswerTests"]
        .as_array()
        .expect("known-answer tests")
        .iter()
        .chain(
            fixture["groups"][0]["vectors"][0]["wireKnownAnswerTests"]
                .as_array()
                .expect("wire known-answer tests"),
        )
    {
        assert_exact_object_keys(kat, &["name", "canonicalUtf8Base64", "bytes", "sha256"]);
    }
    assert_eq!(
        fixture["protocolLiterals"]["fixtureSchema"],
        fixture["schema"]
    );
    assert_eq!(
        fixture["protocolLiterals"]["requestSchema"],
        observer::REQUEST_SCHEMA
    );
    assert_eq!(
        fixture["protocolLiterals"]["observationSchema"],
        observer::OBSERVATION_SCHEMA
    );
    assert_eq!(
        fixture["protocolLiterals"]["acknowledgmentSchema"],
        observer::ACKNOWLEDGMENT_SCHEMA
    );
    assert_eq!(
        fixture["protocolLiterals"]["preObservationRefusalSchema"],
        observer::PRE_OBSERVATION_REFUSAL_SCHEMA
    );
    assert_eq!(
        fixture["protocolLiterals"]["terminalFailureSchema"],
        observer::TERMINAL_SCHEMA
    );
    assert_eq!(fixture["protocolLiterals"]["version"], observer::VERSION);
    assert_eq!(fixture["protocolLiterals"]["consumer"], observer::CONSUMER);
    assert_eq!(fixture["protocolLiterals"]["cliMode"], observer::CLI_MODE);
    assert_eq!(
        fixture["limits"],
        serde_json::json!({
            "readRequestUtf8BytesMax": 65_536,
            "createNewRequestUtf8BytesMax": 393_216,
            "stdinUtf8BytesMax": 393_216,
            "boundFileBytesMax": 262_144,
            "createNewContentBytesMax": 262_144,
            "observationUtf8BytesMax": 1_048_576,
            "ackUtf8BytesMax": 65_536,
            "terminalUtf8BytesMax": 65_536,
            "successStdoutUtf8BytesMax": 1_114_113,
            "terminalStdoutUtf8BytesMax": 65_536,
            "stderrBytesMax": 0,
            "durableEvidenceUtf8BytesMax": 1_048_576,
            "pathUtf8BytesMax": 1_024,
            "operationDeadlineMsMax": 10_000,
            "aggregateDeadlineMsMax": 15_000,
            "observerInvocationCountMax": 1,
            "workingSetBytesMax": 67_108_864,
            "jobMemoryBytesMax": 134_217_728,
            "cpuHardCapPercent": 25,
            "concurrency": 1,
            "threadCountMax": 4,
            "childProcessCountMax": 0,
            "base64OfMaxContentBytes": 349_528,
            "createNewMaxEnvelopeUtf8Bytes": 353_882,
            "capAlgebra": "base64(262144)=349528-and-fixed-uuid-plus-two-escaped-1024-byte-paths-envelope<=353882<=393216"
        })
    );
    let kats = fixture["knownAnswerTests"].as_array().expect("KAT array");
    assert_eq!(kats.len(), 2);
    for kat in kats {
        let bytes = STANDARD
            .decode(kat["canonicalUtf8Base64"].as_str().expect("KAT Base64"))
            .expect("canonical Base64");
        assert_eq!(
            bytes.len() as u64,
            kat["bytes"].as_u64().expect("KAT bytes")
        );
        let request = observer::parse_canonical_request(&bytes).expect("KAT accepted");
        assert_eq!(observer::canonical_request_bytes(&request), bytes);
        assert_eq!(observer::sha256_lower(&bytes), kat["sha256"]);
    }
    let read_kat = STANDARD
        .decode(kats[0]["canonicalUtf8Base64"].as_str().expect("read KAT"))
        .expect("read KAT bytes");
    let wire_kats = fixture["groups"][0]["vectors"][0]["wireKnownAnswerTests"]
        .as_array()
        .expect("wire KAT array");
    assert_eq!(wire_kats.len(), 2);
    for kat in wire_kats {
        let bytes = STANDARD
            .decode(
                kat["canonicalUtf8Base64"]
                    .as_str()
                    .expect("wire KAT Base64"),
            )
            .expect("wire canonical Base64");
        assert_eq!(
            bytes.len() as u64,
            kat["bytes"].as_u64().expect("wire bytes")
        );
        assert_eq!(observer::sha256_lower(&bytes), kat["sha256"]);
    }
    let read_request = observer::parse_canonical_request(&read_kat).expect("read KAT request");
    let read_identity = observer::FileIdentity::from_value(
        &fixture["groups"]
            .as_array()
            .expect("groups")
            .iter()
            .find(|group| group["id"] == "read-bound-file")
            .expect("read group")["vectors"][0]["identity"],
    )
    .expect("read identity");
    let read_sha256 = observer::sha256_lower(&read_kat);
    let (wire_observation, wire_acknowledgment) = observer::read_success_values(
        &read_request,
        &read_sha256,
        &read_identity,
        &read_identity,
        b"tracer-bullet",
    )
    .expect("wire success values");
    let wire_success = observer::success_frame(&wire_observation, &wire_acknowledgment)
        .expect("wire success frame");
    assert_eq!(
        STANDARD.encode(&wire_success),
        wire_kats[0]["canonicalUtf8Base64"]
    );
    let wire_terminal = observer::correlated_terminal(
        read_request.operation(),
        read_request.request_id(),
        &read_sha256,
        "refused",
        "read-observation",
        "none",
    )
    .expect("wire terminal");
    assert_eq!(
        STANDARD.encode(observer::terminal_frame(&wire_terminal).expect("wire terminal frame")),
        wire_kats[1]["canonicalUtf8Base64"]
    );
    let canonical = fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|group| group["id"] == "canonical")
        .expect("canonical group");
    assert!(
        !canonical["vectors"]
            .as_array()
            .expect("canonical vectors")
            .is_empty()
    );
    assert_hostile_ids(
        canonical,
        &[
            "duplicate-property",
            "unicode-escape",
            "trailing-lf",
            "fraction",
            "negative-zero",
            "unsafe-integer",
            "malformed-utf8",
            "utf8-bom",
            "control-scalar",
            "oversized-read-request",
            "extra-request-schema-field",
        ],
    );
    for hostile in canonical["hostileDescriptors"]
        .as_array()
        .expect("canonical hostiles")
        .iter()
    {
        if let Some(encoded) = hostile.get("utf8Base64").and_then(Value::as_str) {
            let bytes = STANDARD.decode(encoded).expect("hostile Base64");
            assert!(observer::parse_canonical_json_value(&bytes).is_err());
        } else if let Some(hex) = hostile.get("hex").and_then(Value::as_str) {
            let bytes = (0..hex.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex byte"))
                .collect::<Vec<_>>();
            assert!(observer::parse_canonical_json_value(&bytes).is_err());
        } else if let Some(size) = hostile.get("bytes").and_then(Value::as_u64) {
            let bytes = vec![b' '; usize::try_from(size).expect("hostile byte size")];
            assert!(observer::parse_canonical_json_value(&bytes).is_err());
        } else if hostile.get("mutation").and_then(Value::as_str) == Some("add-extra-field") {
            let mut mutated =
                observer::parse_canonical_json_value(&read_kat).expect("read KAT JSON");
            mutated
                .as_object_mut()
                .expect("read request object")
                .insert("extra".to_owned(), Value::String("forbidden".to_owned()));
            let bytes = observer::canonical_json_bytes(&mutated).expect("mutated request bytes");
            assert!(observer::parse_canonical_request(&bytes).is_err());
        } else {
            panic!("unhandled canonical hostile payload");
        }
    }
    let oversized_size = canonical["hostileDescriptors"][9]["bytes"]
        .as_u64()
        .expect("oversized hostile bytes");
    assert_eq!(oversized_size, 65_537);
    let mut oversized_read_value =
        observer::parse_canonical_json_value(&read_kat).expect("read KAT JSON");
    let base_target = oversized_read_value["targetPath"]
        .as_str()
        .expect("read target")
        .to_owned();
    oversized_read_value["targetPath"] = Value::String(format!(
        "{base_target}{}",
        "x".repeat(usize::try_from(oversized_size).expect("oversized size") - read_kat.len())
    ));
    let oversized_read_bytes =
        observer::canonical_json_bytes(&oversized_read_value).expect("oversized canonical read");
    assert_eq!(oversized_read_bytes.len() as u64, oversized_size);
    assert_eq!(
        observer::sha256_lower(&oversized_read_bytes),
        "59be2b89305386c71c397f07cd7c1f7e4982dddd9916768468e7c79cd8e4b2a5"
    );
    let oversized_read =
        observer::parse_canonical_request(&oversized_read_bytes).expect("canonical request shape");
    assert_eq!(
        observer::validate_request_semantics(&oversized_read, oversized_read_bytes.len()),
        Err("request exceeds its operation-specific cap")
    );
    let oversized_run =
        observer::run_observer(&[observer::CLI_MODE.to_owned()], &oversized_read_bytes);
    assert_eq!(oversized_run.exit_code, 0);
    let oversized_terminal = observer::parse_canonical_json_value(&oversized_run.stdout)
        .expect("correlated cap terminal");
    assert_eq!(oversized_terminal["operation"], "read-bound-file");
    assert_eq!(
        oversized_terminal["requestSha256"],
        observer::sha256_lower(&oversized_read_bytes)
    );
    assert_eq!(oversized_terminal["outcome"], "refused");
    assert_eq!(oversized_terminal["failureStage"], "pre-effect");
    assert_eq!(oversized_terminal["effectState"], "none");

    let raw_over_cap = vec![b'x'; 393_217];
    let raw_run = observer::run_observer(&[observer::CLI_MODE.to_owned()], &raw_over_cap);
    assert_eq!(raw_run.exit_code, 0);
    assert_eq!(
        raw_run.stdout,
        observer::terminal_frame(&observer::pre_observation_refusal())
            .expect("pre-observation terminal")
    );
    use std::io::Write as _;
    let mut child =
        std::process::Command::new(env!("CARGO_BIN_EXE_rm0032-phase3-native-observer-v1"))
            .arg(observer::CLI_MODE)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn observer binary");
    child
        .stdin
        .take()
        .expect("observer stdin")
        .write_all(&raw_over_cap)
        .expect("write raw capped stdin");
    let raw_process = child.wait_with_output().expect("observer raw cap output");
    assert_eq!(raw_process.status.code(), Some(0));
    assert!(raw_process.stderr.is_empty());
    assert_eq!(raw_process.stdout, raw_run.stdout);
    let mut extra_request = observer::parse_canonical_json_value(&read_kat).expect("read KAT JSON");
    extra_request
        .as_object_mut()
        .expect("read request object")
        .insert("extra".to_owned(), Value::String("forbidden".to_owned()));
    let extra_bytes = observer::canonical_json_bytes(&extra_request).expect("extra request bytes");
    assert!(observer::parse_canonical_request(&extra_bytes).is_err());
}

fn drive_binding_scalar_evidence() {
    use std::ffi::OsString;
    let hash = "a".repeat(64);
    let record = serde_json::json!({
        "drive": "C:",
        "ntVolumeRoot": "\\Device\\HarddiskVolume1\\",
        "requestSha256": hash,
        "schema": observer::DRIVE_BINDING_SCHEMA,
        "volumeSerialNumber": "0123456789abcdef",
    });
    let encode = |value: &Value| String::from_utf8(
        observer::canonical_json_bytes(value).expect("canonical binding fixture"),
    ).expect("ASCII fixture");
    let raw = encode(&record);
    let binding = observer::parse_drive_binding(&raw, &hash, "C:").expect("strict binding");
    for key in ["drive", "ntVolumeRoot", "requestSha256", "schema", "volumeSerialNumber"] {
        let mut missing = record.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(observer::parse_drive_binding(&encode(&missing), &hash, "C:").is_err());
        for value in [Value::Null, Value::Bool(true), serde_json::json!(1), serde_json::json!([]), serde_json::json!({})] {
            let mut bad_type = record.clone();
            bad_type[key] = value;
            assert!(observer::parse_drive_binding(&encode(&bad_type), &hash, "C:").is_err());
        }
    }
    let mut extra = record.clone();
    extra["extra"] = Value::String("value".into());
    assert!(observer::parse_drive_binding(&encode(&extra), &hash, "C:").is_err());
    for (key, value) in [
        ("drive", "c:"), ("drive", "C"), ("drive", "CC:"), ("drive", "C:\\"),
        ("drive", "1:"), ("drive", "D:"), ("schema", "wrong"),
        ("ntVolumeRoot", "\\Device\\HarddiskVolume\\"),
        ("ntVolumeRoot", "\\Device\\HarddiskVolume1"),
        ("ntVolumeRoot", "\\Device\\HarddiskVolume1\\tail"),
        ("ntVolumeRoot", "\\Device\\HarddiskVolume1\\\\"),
        ("ntVolumeRoot", "\\\\Device\\HarddiskVolume1\\"),
        ("ntVolumeRoot", "\\device\\HarddiskVolume1\\"),
        ("ntVolumeRoot", "\\Device\\HarddiskVolume١\\"),
        ("ntVolumeRoot", "\\Device\\HarddiskVolume-1\\"),
        ("ntVolumeRoot", "\\Device\\HarddiskVolume1x\\"),
        ("ntVolumeRoot", "\\Device/HarddiskVolume1\\"),
        ("ntVolumeRoot", "\\??\\C:\\"),
        ("volumeSerialNumber", "0123456789ABCDEF"),
        ("volumeSerialNumber", "123456789abcdef"),
        ("volumeSerialNumber", "00123456789abcdef"),
        ("volumeSerialNumber", "0123456789abcdeg"),
        ("requestSha256", ""), ("requestSha256", "bad"),
    ] {
        let mut hostile = record.clone();
        hostile[key] = Value::String(value.into());
        assert!(observer::parse_drive_binding(&encode(&hostile), &hash, "C:").is_err(), "{key}={value}");
    }
    for changed_hash in ["b".repeat(64), "A".repeat(64), "a".repeat(63), "a".repeat(65)] {
        assert!(observer::parse_drive_binding(&raw, &changed_hash, "C:").is_err());
        let mut hostile = record.clone();
        hostile["requestSha256"] = Value::String(changed_hash);
        assert!(observer::parse_drive_binding(&encode(&hostile), &hash, "C:").is_err());
    }
    for drive in ["c:", "D:", "C:\\", "", "Ç:"] {
        assert!(observer::parse_drive_binding(&raw, &hash, drive).is_err());
    }
    let reversed = format!("{{{}}}", record.as_object().unwrap().iter().rev()
        .map(|(key, value)| format!("{}:{}", serde_json::to_string(key).unwrap(), serde_json::to_string(value).unwrap()))
        .collect::<Vec<_>>().join(","));
    for hostile in [
        String::new(), format!(" {raw}"), format!("{raw}\n"), format!("\u{feff}{raw}"),
        format!("{raw}{{}}"), serde_json::to_string_pretty(&record).unwrap(), reversed,
        raw.replacen("\"drive\"", "\"\\u0064rive\"", 1),
        raw.replacen("{", "{\"drive\":\"C:\",", 1),
        format!("{raw}{}", " ".repeat(1025)),
    ] {
        assert!(observer::parse_drive_binding(&hostile, &hash, "C:").is_err());
    }

    let volume = 0x0123456789abcdef;
    for suffix in ["", "Fixtures\\Case.bin", "Fixtures\\café-😀.bin", "Fixtures\\e\u{301}.bin", "Fixtures\\LONGNA~1.BIN"] {
        let observed = format!("\\Device\\HarddiskVolume1\\{suffix}");
        assert_eq!(observer::normalized_nt_to_dos(&binding, &observed, volume), Ok(format!("\\\\?\\C:\\{suffix}")));
    }
    for observed in [
        "\\Device\\HarddiskVolume10\\file", "\\Device\\HarddiskVolume1x\\file",
        "\\Device\\HarddiskVolume1", "\\Device\\HarddiskVolume1\\\\file",
        "\\device\\HarddiskVolume1\\file", "\\\\Device\\HarddiskVolume1\\file",
        "\\Device\\HarddiskVolume2\\file", "\\Device\\HarddiskVolume1\\.\\file",
        "\\Device\\HarddiskVolume1\\..\\file", "\\Device\\HarddiskVolume1\\file/child",
        "\\Device\\HarddiskVolume1\\file\0", "\\\\?\\C:\\file",
    ] {
        assert_eq!(observer::normalized_nt_to_dos(&binding, observed, volume), Err(observer::ProofFailure::DeterministicDrift));
    }
    assert!(observer::normalized_nt_to_dos(&binding, "\\Device\\HarddiskVolume1\\file", volume + 1).is_err());
    assert!(observer::normalized_nt_to_dos(&binding, &format!("\\Device\\HarddiskVolume1\\{}", "a".repeat(32_768)), volume).is_err());
    for (requested, observed) in [
        ("C:\\Fixtures\\case.bin", "\\Device\\HarddiskVolume1\\Fixtures\\Case.bin"),
        ("C:\\Fixtures\\LongName.bin", "\\Device\\HarddiskVolume1\\Fixtures\\LONGNA~1.BIN"),
        ("C:\\Fixtures\\é.bin", "\\Device\\HarddiskVolume1\\Fixtures\\e\u{301}.bin"),
    ] {
        let dos = observer::normalized_nt_to_dos(&binding, observed, volume).unwrap();
        assert_eq!(observer::validate_exact_opened_final_path(requested, &dos), Err(observer::ProofFailure::NonIdenticalSpelling));
    }

    let pair = (OsString::from(observer::DRIVE_BINDING_ENV), OsString::from(&raw));
    observer::parse_fixture_drive_binding_snapshot(vec![pair.clone()], &hash, "C:").expect("one exact key");
    for snapshot in [
        vec![], vec![pair.clone(), pair.clone()],
        vec![(observer::DRIVE_BINDING_ENV.to_ascii_lowercase().into(), raw.clone().into())],
        vec![pair.clone(), (observer::DRIVE_BINDING_ENV.to_ascii_lowercase().into(), raw.clone().into())],
        vec![(observer::DRIVE_BINDING_ENV.to_ascii_lowercase().into(), raw.clone().into()), pair.clone()],
        vec![(observer::DRIVE_BINDING_ENV.into(), "x".repeat(1025).into())],
        vec![pair.clone(), ("OTHER".into(), "x".repeat(32_767).into())],
        vec![("OTHER".into(), "x".repeat(32_767).into()), pair.clone()],
        vec![(observer::DRIVE_BINDING_ENV.into(), "é".repeat(600).into())],
    ] {
        assert!(observer::parse_fixture_drive_binding_snapshot(snapshot, &hash, "C:").is_err());
    }
    // An exact boundary, including both terminators and the unrelated key=value entry.
    let remaining = 32_767 - (1 + observer::DRIVE_BINDING_ENV.len() + raw.len() + 2 + "OTHER".len() + 2);
    observer::parse_fixture_drive_binding_snapshot(
        vec![pair.clone(), ("OTHER".into(), "x".repeat(remaining).into())], &hash, "C:",
    ).expect("exact environment block bound");
    assert!(observer::parse_fixture_drive_binding_snapshot(
        vec![pair.clone(), ("OTHER".into(), "x".repeat(remaining + 1).into())], &hash, "C:",
    ).is_err());
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        assert!(observer::parse_fixture_drive_binding_snapshot(
            vec![(observer::DRIVE_BINDING_ENV.into(), OsString::from_wide(&[0xd800]))], &hash, "C:",
        ).is_err());
    }
}

fn scalar_group() {
    drive_binding_scalar_evidence();
    let fixture = fixture();
    let groups = fixture["groups"].as_array().expect("groups array");
    let scalar = groups
        .iter()
        .find(|group| group["id"] == "scalar")
        .expect("scalar group");
    assert_hostile_ids(
        scalar,
        &[
            "request-id-lowercase",
            "sha256-uppercase",
            "base64-noncanonical",
            "path-escape",
            "path-unc",
            "path-ads",
            "path-device",
            "path-reserved",
            "path-reserved-superscript",
            "path-trailing-dot",
            "path-console-device",
            "path-illegal-component-char",
            "final-path-dot-component",
            "path-long-extended-native",
            "reparse-any-tag",
        ],
    );
    let vector = &scalar["vectors"][0];
    assert!(observer::validate_request_id(
        vector["requestId"].as_str().expect("request id")
    ));
    assert!(!observer::validate_request_id(
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    ));
    assert!(observer::validate_sha256(
        vector["sha256"].as_str().expect("sha256")
    ));
    assert!(!observer::validate_sha256(&"A".repeat(64)));
    for encoded in vector["base64"].as_array().expect("base64 vectors") {
        observer::decode_canonical_base64(encoded.as_str().expect("base64"), 262_144)
            .expect("canonical Base64 accepted");
    }
    assert!(observer::decode_canonical_base64("Zh==", 262_144).is_err());

    let root = vector["rootPath"].as_str().expect("root path");
    let target = vector["targetPath"].as_str().expect("target path");
    observer::validate_input_path_pair(root, target).expect("canonical path pair");
    for (index, path) in scalar["vectors"][1]["invalidInputPaths"]
        .as_array()
        .expect("invalid paths")
        .iter()
        .enumerate()
    {
        let expected = if index <= 2 {
            "path is not an uppercase-drive DOS absolute path"
        } else if (7..=22).contains(&index) {
            "reserved DOS path component"
        } else {
            "path component is not canonical"
        };
        assert_eq!(
            observer::validate_input_path_pair(root, path.as_str().expect("invalid path")),
            Err(expected),
            "wrong exact path refusal: {path}"
        );
    }
    for path in scalar["vectors"][1]["validLookalikePaths"]
        .as_array()
        .expect("valid lookalike paths")
    {
        observer::validate_input_path_pair(root, path.as_str().expect("valid lookalike"))
            .expect("Unicode or suffix lookalike remains legal");
    }
    let root_final = vector["trustedRootFinalPath"]
        .as_str()
        .expect("root final path");
    let target_final = vector["trustedTargetFinalPath"]
        .as_str()
        .expect("target final path");
    assert_eq!(
        observer::validate_final_containment(root_final, target_final),
        observer::FinalContainment::Contained
    );
    assert_eq!(
        observer::validate_final_containment("\\\\?\\C:\\", "\\\\?\\C:\\bound.txt"),
        observer::FinalContainment::Contained
    );
    assert_eq!(
        observer::expected_target_final_path(
            vector["rootPath"].as_str().expect("root"),
            vector["targetPath"].as_str().expect("target"),
            root_final,
        ),
        Ok(target_final.to_owned())
    );
    assert_eq!(
        observer::validate_exact_opened_final_path(
            vector["rootPath"].as_str().expect("root"),
            root_final,
        ),
        Ok(())
    );
    assert_eq!(
        observer::validate_exact_opened_final_path(
            vector["rootPath"].as_str().expect("root"),
            &root_final.replace("fixtures", "Fixtures"),
        ),
        Err(observer::ProofFailure::NonIdenticalSpelling)
    );
    for invalid_observed in [
        "C:\\fixtures\\rm0032",
        "\\\\?\\c:\\fixtures\\rm0032",
        "\\\\?\\C:/fixtures/rm0032",
        "\\\\?\\C:\\fixtures\\\\rm0032",
    ] {
        assert_eq!(
            observer::validate_exact_opened_final_path(
                vector["rootPath"].as_str().expect("root"),
                invalid_observed,
            ),
            Err(observer::ProofFailure::DeterministicDrift)
        );
    }
    assert_eq!(
        observer::expected_target_final_path(
            vector["rootPath"].as_str().expect("root"),
            vector["targetPath"].as_str().expect("target"),
            "invalid-held-root",
        ),
        Err(observer::ProofFailure::DeterministicDrift)
    );
    assert_eq!(
        observer::validate_exact_target_final_path(
            vector["rootPath"].as_str().expect("root"),
            vector["targetPath"].as_str().expect("target"),
            root_final,
            "invalid-observed-target",
        ),
        Err(observer::ProofFailure::DeterministicDrift)
    );
    assert_eq!(
        observer::validate_final_containment(
            root_final,
            &target_final.replace("fixtures", "Fixtures")
        ),
        observer::FinalContainment::NonIdentical
    );
    assert_eq!(
        observer::validate_final_containment(root_final, "\\\\?\\C:\\fixtures\\rm0032\\..\\evil"),
        observer::FinalContainment::Invalid
    );
    let long_component = "a".repeat(300);
    let long_target = format!("C:\\fixtures\\rm0032\\{long_component}");
    observer::validate_input_path_pair(root, &long_target)
        .expect("bounded long DOS input is legal");
    assert_eq!(
        observer::expected_target_final_path(root, &long_target, root_final),
        Ok(format!("{root_final}\\{long_component}"))
    );
    let maximum_content = vec![0x5a; 262_144];
    let maximum_encoded = STANDARD.encode(&maximum_content);
    assert_eq!(
        observer::decode_canonical_base64(&maximum_encoded, 262_144).expect("cap accepted"),
        maximum_content
    );
    let oversized_encoded = STANDARD.encode(vec![0x5a; 262_145]);
    assert!(observer::decode_canonical_base64(&oversized_encoded, 262_144).is_err());
}

fn terminal_group() {
    let fixture = fixture();
    let group = fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "terminal")
        .expect("terminal group");
    assert_hostile_ids(
        group,
        &[
            "terminal-wrong-consumer",
            "terminal-wrong-outcome",
            "terminal-cross-operation",
            "terminal-extra-property",
            "terminal-missing-property",
            "pre-observation-correlation-forbidden",
        ],
    );
    let request_id = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    let request_sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let legal = group["vectors"].as_array().expect("legal tuples");
    assert_eq!(legal.len(), 8);
    for tuple in legal {
        let fields = tuple.as_array().expect("tuple");
        let terminal = observer::correlated_terminal(
            fields[0].as_str().expect("operation"),
            request_id,
            request_sha,
            fields[1].as_str().expect("outcome"),
            fields[2].as_str().expect("failure stage"),
            fields[3].as_str().expect("effect state"),
        )
        .expect("legal tuple");
        observer::validate_terminal(&terminal).expect("terminal validates");
        assert_eq!(terminal.as_object().expect("terminal object").len(), 9);
    }
    assert!(
        observer::correlated_terminal(
            "create-new-durable-file",
            request_id,
            request_sha,
            "refused",
            "post-create",
            "possibly-created",
        )
        .is_err()
    );
    let refusal = observer::pre_observation_refusal();
    observer::validate_terminal(&refusal).expect("pre-observation refusal validates");
    let refusal_record = refusal.as_object().expect("refusal object");
    assert_eq!(refusal_record.len(), 5);
    assert!(!refusal_record.contains_key("operation"));
    assert!(!refusal_record.contains_key("requestId"));
    assert!(!refusal_record.contains_key("requestSha256"));
    let mut illegal_refusal = refusal.clone();
    illegal_refusal
        .as_object_mut()
        .expect("refusal object")
        .insert("requestId".to_owned(), Value::String(request_id.to_owned()));
    assert!(observer::validate_terminal(&illegal_refusal).is_err());

    let mut hostile_terminal = observer::correlated_terminal(
        "read-bound-file",
        request_id,
        request_sha,
        "refused",
        "read-observation",
        "none",
    )
    .expect("hostile baseline terminal");
    hostile_terminal["consumer"] = Value::String("wrong-consumer".to_owned());
    assert!(observer::validate_terminal(&hostile_terminal).is_err());

    let mut hostile_terminal = observer::correlated_terminal(
        "read-bound-file",
        request_id,
        request_sha,
        "refused",
        "read-observation",
        "none",
    )
    .expect("hostile baseline terminal");
    hostile_terminal
        .as_object_mut()
        .expect("terminal object")
        .remove("effectState");
    assert!(observer::validate_terminal(&hostile_terminal).is_err());

    let mut hostile_terminal = observer::correlated_terminal(
        "read-bound-file",
        request_id,
        request_sha,
        "refused",
        "read-observation",
        "none",
    )
    .expect("hostile baseline terminal");
    hostile_terminal
        .as_object_mut()
        .expect("terminal object")
        .insert("extra".to_owned(), Value::Bool(true));
    assert!(observer::validate_terminal(&hostile_terminal).is_err());

    let mut hostile_terminal = observer::correlated_terminal(
        "read-bound-file",
        request_id,
        request_sha,
        "refused",
        "read-observation",
        "none",
    )
    .expect("hostile baseline terminal");
    hostile_terminal["operation"] = Value::String("create-new-durable-file".to_owned());
    assert!(observer::validate_terminal(&hostile_terminal).is_err());
}

fn framing_group() {
    let fixture = fixture();
    let framing = fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "framing")
        .expect("framing group");
    assert_hostile_ids(
        framing,
        &[
            "success-missing-lf",
            "success-extra-lf",
            "success-trailing-lf",
            "success-truncated-observation",
            "success-truncated-ack",
            "terminal-trailing-lf",
            "stdout-oversized",
            "stderr-nonzero-marker",
            "exit-unknown",
        ],
    );
    assert_eq!(framing["vectors"][0]["argv"][0], observer::CLI_MODE);
    assert_eq!(framing["vectors"][0]["stdin"], "R-then-EOF-only");
    assert_eq!(framing["vectors"][0]["stdoutSuccess"], "O-0x0A-A-then-EOF");
    assert_eq!(framing["vectors"][0]["stdoutTerminal"], "T-then-EOF");
    assert_eq!(framing["vectors"][0]["recognizedExitCode"], 0);
    assert_eq!(framing["vectors"][0]["reservedUnableToEmitExitCode"], 64);
    assert!(observer::validate_cli_args(
        &[observer::CLI_MODE.to_owned()]
    ));
    assert!(!observer::validate_cli_args(&[]));
    assert!(!observer::validate_cli_args(&[
        observer::CLI_MODE.to_owned(),
        "extra".to_owned()
    ]));

    let observation = serde_json::json!({"kind":"observation","size":0});
    let acknowledgment = serde_json::json!({"kind":"acknowledgment","outcome":"known"});
    let observation_bytes = observer::canonical_json_bytes(&observation).expect("canonical O");
    let acknowledgment_bytes =
        observer::canonical_json_bytes(&acknowledgment).expect("canonical A");
    let success = observer::success_frame(&observation, &acknowledgment).expect("success frame");
    assert_eq!(
        success,
        [observation_bytes, vec![b'\n'], acknowledgment_bytes].concat()
    );
    assert_ne!(success.last(), Some(&b'\n'));
    let separator = success
        .iter()
        .position(|byte| *byte == b'\n')
        .expect("one LF");
    assert!(observer::parse_canonical_json_value(&success).is_err());
    assert!(observer::parse_canonical_json_value(&success[..separator / 2]).is_err());
    assert!(
        observer::parse_canonical_json_value(&success[separator + 1..success.len() - 1]).is_err()
    );
    let mut extra_lf = success.clone();
    extra_lf.insert(separator + 1, b'\n');
    assert!(observer::parse_canonical_json_value(&extra_lf[separator + 1..]).is_err());
    let oversized = serde_json::json!({"payload":"x".repeat(1_048_577)});
    assert!(observer::success_frame(&oversized, &acknowledgment).is_err());
    let terminal = observer::pre_observation_refusal();
    let terminal_frame = observer::terminal_frame(&terminal).expect("terminal frame");
    assert_eq!(
        terminal_frame,
        observer::canonical_json_bytes(&terminal).expect("canonical T")
    );
    assert_ne!(terminal_frame.last(), Some(&b'\n'));
    let mut trailing_lf = terminal_frame;
    trailing_lf.push(b'\n');
    assert!(observer::parse_canonical_json_value(&trailing_lf).is_err());
}

fn read_bound_file_group() {
    let fixture = fixture();
    let vector = &fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "read-bound-file")
        .expect("read group")["vectors"][0];
    let read_group = fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "read-bound-file")
        .expect("read group");
    assert_hostile_ids(
        read_group,
        &[
            "read-cross-path",
            "read-directory-type",
            "read-final-path-case-drift",
            "read-volume-drift",
            "read-file-id-drift",
            "read-mtime-drift",
            "read-size-drift",
            "read-attributes-drift",
            "read-zero-progress",
            "read-race-after-identity",
        ],
    );
    let identity = observer::FileIdentity::from_value(&vector["identity"])
        .expect("fixture identity validates");
    let content = STANDARD
        .decode(vector["contentBase64"].as_str().expect("content Base64"))
        .expect("content bytes");
    let proof = observer::complete_read_proof(
        vector["rootFinalPath"].as_str().expect("root final path"),
        &identity,
        &identity,
        &content,
    )
    .expect("known read proof");
    assert_eq!(proof.0, vector["contentBase64"]);
    assert_eq!(proof.1, vector["contentSha256"]);
    assert_eq!(vector["readChunkBytes"], 65_536);

    let mut drifted = identity.clone();
    drifted.last_write_time = "1".to_owned();
    assert_eq!(
        observer::complete_read_proof(
            vector["rootFinalPath"].as_str().expect("root final path"),
            &identity,
            &drifted,
            &content,
        ),
        Err(observer::ProofFailure::DeterministicDrift)
    );
    for mutated in [
        {
            let mut value = identity.clone();
            value.volume_serial_number = "ffffffffffffffff".to_owned();
            value
        },
        {
            let mut value = identity.clone();
            value.file_id = "ffffffffffffffffffffffffffffffff".to_owned();
            value
        },
        {
            let mut value = identity.clone();
            value.size = "12".to_owned();
            value
        },
        {
            let mut value = identity.clone();
            value.file_attributes = "00000021".to_owned();
            value
        },
    ] {
        assert_eq!(
            observer::complete_read_proof(
                vector["rootFinalPath"].as_str().expect("root final path"),
                &identity,
                &mutated,
                &content,
            ),
            Err(observer::ProofFailure::DeterministicDrift)
        );
    }
    let mut directory_before = identity.clone();
    directory_before.file_attributes = "00000010".to_owned();
    assert_eq!(
        observer::complete_read_proof(
            vector["rootFinalPath"].as_str().expect("root final path"),
            &directory_before,
            &directory_before,
            &content,
        ),
        Err(observer::ProofFailure::DeterministicDrift)
    );
    let mut raced_after = identity.clone();
    raced_after.file_id = "00000000000000000000000000000002".to_owned();
    assert_eq!(
        observer::complete_read_proof(
            vector["rootFinalPath"].as_str().expect("root final path"),
            &identity,
            &raced_after,
            &content,
        ),
        Err(observer::ProofFailure::DeterministicDrift)
    );
    let mut non_identical = identity.clone();
    non_identical.final_path = non_identical.final_path.replace("fixtures", "Fixtures");
    assert_eq!(
        observer::complete_read_proof(
            vector["rootFinalPath"].as_str().expect("root final path"),
            &non_identical,
            &non_identical,
            &content,
        ),
        Err(observer::ProofFailure::NonIdenticalSpelling)
    );
    assert_eq!(observer::validate_read_progress(13, &[13]), Ok(()));
    assert_eq!(
        observer::validate_read_progress(13, &[0]),
        Err(observer::ProofFailure::Incomplete)
    );
    assert_eq!(
        observer::validate_no_reparse_tag(Some(0xA000000C)),
        Err(observer::ProofFailure::DeterministicDrift)
    );
    assert_eq!(
        observer::classify_read_observation_failure(observer::ProofFailure::DeterministicDrift),
        observer::ReadObservationFailureClassification::Refused
    );
    assert_eq!(
        observer::classify_read_observation_failure(observer::ProofFailure::Incomplete),
        observer::ReadObservationFailureClassification::Unknown
    );
    assert_eq!(
        observer::classify_read_observation_failure(observer::ProofFailure::NonIdenticalSpelling),
        observer::ReadObservationFailureClassification::Unknown
    );
    assert_eq!(
        observer::validate_exact_target_final_path(
            "C:\\fixtures\\rm0032",
            "C:\\fixtures\\rm0032\\bound.txt",
            vector["rootFinalPath"].as_str().expect("root final path"),
            "\\\\?\\C:\\fixtures\\rm0032\\sibling.txt",
        ),
        Err(observer::ProofFailure::NonIdenticalSpelling)
    );
    #[cfg(windows)]
    windows_native_read_evidence();
}

fn create_new_durable_file_group() {
    let fixture = fixture();
    let create_group = fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "create-new-durable-file")
        .expect("create group");
    assert_hostile_ids(
        create_group,
        &[
            "create-last-error-ambiguous",
            "create-collision-with-write",
            "create-zero-valid-handle-extra-action",
            "create-zero-ambiguous-write",
            "create-write-false",
            "create-write-short",
            "create-flush-failure",
            "create-rewind-failure",
            "create-close-failure",
            "create-reopen-failure",
            "create-reopen-identity-drift",
            "create-hash-mismatch",
            "create-directory-type",
            "create-zero-deadline-write-order",
            "create-ordered-trace",
        ],
    );
    let vectors = create_group["vectors"].as_array().expect("create vectors");

    let content = STANDARD
        .decode(vectors[0]["contentBase64"].as_str().expect("content"))
        .expect("content bytes");
    assert_eq!(vectors[0]["name"], "nonempty-known");
    assert_eq!(vectors[0]["writeRequestedBytes"], content.len());
    assert_eq!(vectors[0]["writeReturnedBytes"], content.len());
    assert_eq!(
        vectors[0]["contentSha256"],
        observer::sha256_lower(&content)
    );
    let known = observer::classify_create_trace(
        &content,
        &observer::CreateTrace::nonempty_success(content.len()),
    );
    assert_eq!(known, observer::CreateClassification::Known);
    let mut short = observer::CreateTrace::nonempty_success(content.len());
    short.write_returned = Some(content.len() - 1);
    assert_eq!(
        observer::classify_create_trace(&content, &short),
        observer::CreateClassification::UnknownPostCreate
    );

    let zero_valid = observer::CreateTrace::zero_valid_handle();
    assert_eq!(vectors[1]["name"], "zero-valid-handle");
    assert_eq!(vectors[1]["writeCallCount"], 1);
    assert_eq!(vectors[1]["writeRequestedBytes"], 0);
    assert_eq!(
        vectors[1]["terminal"],
        serde_json::json!([
            "create-new-durable-file",
            "unknown",
            "post-create",
            "possibly-created"
        ])
    );
    assert_eq!(vectors[1]["laterAction"], "owned-handle-resource-release");
    assert_eq!(zero_valid.write_requests, vec![0]);
    assert!(zero_valid.release_root_ancestors);
    assert!(zero_valid.release_original);
    assert_eq!(
        observer::classify_create_trace(&[], &zero_valid),
        observer::CreateClassification::UnknownPostCreate
    );
    let zero_ambiguous = observer::CreateTrace::zero_ambiguity_no_handle();
    assert_eq!(vectors[2]["name"], "zero-ambiguity-no-handle");
    assert_eq!(vectors[2]["writeCallCount"], 0);
    assert_eq!(
        vectors[2]["terminal"],
        serde_json::json!([
            "create-new-durable-file",
            "unknown",
            "post-create",
            "possibly-created"
        ])
    );
    assert_eq!(
        vectors[2]["laterAction"],
        "owned-root-and-existing-ancestor-handle-resource-release-only"
    );
    assert!(zero_ambiguous.write_requests.is_empty());
    assert!(zero_ambiguous.release_root_ancestors);
    assert!(!zero_ambiguous.release_original);
    assert_eq!(
        observer::classify_create_trace(&[], &zero_ambiguous),
        observer::CreateClassification::UnknownPostCreate
    );
    let mut illegal_ambiguity = zero_ambiguous.clone();
    illegal_ambiguity.write_requests.push(0);
    assert_eq!(
        observer::classify_create_trace(&[], &illegal_ambiguity),
        observer::CreateClassification::InvalidTrace
    );
    assert_eq!(
        observer::classify_create_trace(&content, &observer::CreateTrace::collision()),
        observer::CreateClassification::RefusedCollision
    );
    assert_eq!(vectors[3]["name"], "collision");
    assert_eq!(
        vectors[3]["terminal"],
        serde_json::json!([
            "create-new-durable-file",
            "refused",
            "create-collision",
            "not-created"
        ])
    );
    let mut collision_with_write = observer::CreateTrace::collision();
    collision_with_write.write_requests.push(content.len());
    assert_eq!(
        observer::classify_create_trace(&content, &collision_with_write),
        observer::CreateClassification::InvalidTrace
    );
    #[cfg(windows)]
    {
        assert_eq!(
            observer::classify_create_open_error(80),
            observer::CreateClassification::RefusedCollision
        );
        assert_eq!(
            observer::classify_create_open_error(0),
            observer::CreateClassification::UnknownPostCreate
        );
        assert_eq!(
            observer::classify_create_open_error(183),
            observer::CreateClassification::RefusedPreEffect
        );
        assert_eq!(
            observer::classify_create_open_error(5),
            observer::CreateClassification::RefusedPreEffect
        );
    }
    let mut write_false = observer::CreateTrace::nonempty_success(content.len());
    write_false.write_returned = None;
    let mut flush_failure = observer::CreateTrace::nonempty_success(content.len());
    flush_failure.flush = false;
    let mut rewind_failure = observer::CreateTrace::nonempty_success(content.len());
    rewind_failure.rewind = false;
    let mut close_failure = observer::CreateTrace::nonempty_success(content.len());
    close_failure.release_original = false;
    let mut reopen_failure = observer::CreateTrace::nonempty_success(content.len());
    reopen_failure.reopen = false;
    let mut reopen_identity_drift = observer::CreateTrace::nonempty_success(content.len());
    reopen_identity_drift.reopened_identity = false;
    let mut hash_mismatch = observer::CreateTrace::nonempty_success(content.len());
    hash_mismatch.same_handle_readback = false;
    for hostile_trace in [
        write_false,
        flush_failure,
        rewind_failure,
        close_failure,
        reopen_failure,
        reopen_identity_drift,
        hash_mismatch,
    ] {
        assert_eq!(
            observer::classify_create_trace(&content, &hostile_trace),
            observer::CreateClassification::UnknownPostCreate
        );
    }

    use observer::NativeTraceEvent as Event;
    let root = stable_binding(1, "\\\\?\\C:\\fixtures\\rm0032");
    let ancestor = stable_binding(2, "\\\\?\\C:\\fixtures\\rm0032\\held");
    let ordered_known = vec![
        Event::Acquire {
            binding: root.clone(),
        },
        Event::Acquire {
            binding: ancestor.clone(),
        },
        Event::Clock {
            now: 9_998,
            deadline: 10_000,
        },
        Event::CreateValid { handle: 3 },
        Event::Write {
            handle: 3,
            requested: content.len(),
            returned: Some(content.len()),
        },
        Event::Flush { handle: 3 },
        Event::Identity {
            handle: 3,
            directory: false,
            reparse_free: true,
        },
        Event::Rewind { handle: 3 },
        Event::Readback { handle: 3 },
        Event::Identity {
            handle: 3,
            directory: false,
            reparse_free: true,
        },
        Event::Close { handle: 3 },
        Event::Reopen { handle: 4 },
        Event::Identity {
            handle: 4,
            directory: false,
            reparse_free: true,
        },
        Event::Readback { handle: 4 },
        Event::Clock {
            now: 9_999,
            deadline: 10_000,
        },
        Event::RevalidateAncestors {
            current: vec![root.clone(), ancestor.clone()],
        },
        Event::Close { handle: 4 },
        Event::Close { handle: 2 },
        Event::Close { handle: 1 },
        Event::Acknowledge,
    ];
    assert_eq!(
        observer::classify_ordered_create_trace(&ordered_known),
        Ok(observer::CreateClassification::Known)
    );
    let mut misordered_nonempty = ordered_known.clone();
    misordered_nonempty.swap(5, 6);
    assert_eq!(
        observer::classify_ordered_create_trace(&misordered_nonempty),
        Ok(observer::CreateClassification::UnknownPostCreate)
    );
    let mut failed_nonempty = ordered_known.clone();
    failed_nonempty.insert(6, Event::Failure);
    assert!(observer::classify_ordered_create_trace(&failed_nonempty).is_err());
    let mut late_nonempty = ordered_known.clone();
    let final_clock = late_nonempty
        .iter()
        .rposition(|event| matches!(event, Event::Clock { .. }))
        .expect("final clock");
    late_nonempty[final_clock] = Event::Clock {
        now: 10_000,
        deadline: 10_000,
    };
    assert!(observer::classify_ordered_create_trace(&late_nonempty).is_err());
    let cleanup_only_failure = vec![
        Event::Acquire {
            binding: root.clone(),
        },
        Event::Acquire {
            binding: ancestor.clone(),
        },
        Event::Clock {
            now: 9_998,
            deadline: 10_000,
        },
        Event::CreateValid { handle: 3 },
        Event::Write {
            handle: 3,
            requested: content.len(),
            returned: Some(content.len()),
        },
        Event::Flush { handle: 3 },
        Event::Failure,
        Event::Close { handle: 3 },
        Event::Close { handle: 2 },
        Event::Close { handle: 1 },
    ];
    assert_eq!(
        observer::classify_ordered_create_trace(&cleanup_only_failure),
        Ok(observer::CreateClassification::UnknownPostCreate)
    );
    let short_write_cleanup = vec![
        Event::Acquire {
            binding: root.clone(),
        },
        Event::Clock {
            now: 9_998,
            deadline: 10_000,
        },
        Event::CreateValid { handle: 3 },
        Event::Write {
            handle: 3,
            requested: content.len(),
            returned: Some(content.len() - 1),
        },
        Event::Close { handle: 3 },
        Event::Close { handle: 1 },
    ];
    assert_eq!(
        observer::classify_ordered_create_trace(&short_write_cleanup),
        Ok(observer::CreateClassification::UnknownPostCreate)
    );
    let mut short_write_extra_work = short_write_cleanup.clone();
    short_write_extra_work.insert(4, Event::Flush { handle: 3 });
    assert!(observer::classify_ordered_create_trace(&short_write_extra_work).is_err());

    let zero_trace = |deadline: u64, before: u64, after: u64| {
        let zero_root = stable_binding(10, "\\\\?\\C:\\fixtures\\rm0032");
        let zero_ancestor = stable_binding(20, "\\\\?\\C:\\fixtures\\rm0032\\held");
        vec![
            Event::Acquire { binding: zero_root },
            Event::Acquire {
                binding: zero_ancestor,
            },
            Event::Clock {
                now: before,
                deadline,
            },
            Event::CreateValid { handle: 30 },
            Event::Write {
                handle: 30,
                requested: 0,
                returned: None,
            },
            Event::Clock {
                now: after,
                deadline,
            },
            Event::Close { handle: 30 },
            Event::Close { handle: 20 },
            Event::Close { handle: 10 },
        ]
    };
    let operation_first = observer::DeadlineContext::new(0, 1_000).expect("operation first");
    assert_eq!(operation_first.earliest(), 11_000);
    let operation_zero = zero_trace(operation_first.earliest(), 10_999, 11_000);
    assert_eq!(
        observer::classify_ordered_create_trace(&operation_zero),
        Ok(observer::CreateClassification::UnknownPostCreate)
    );
    let aggregate_first = observer::DeadlineContext::new(0, 14_000).expect("aggregate first");
    assert_eq!(aggregate_first.earliest(), 15_000);
    let aggregate_zero = zero_trace(aggregate_first.earliest(), 14_999, 15_000);
    assert_eq!(
        observer::classify_ordered_create_trace(&aggregate_zero),
        Ok(observer::CreateClassification::UnknownPostCreate)
    );
    assert_eq!(
        observer::classify_ordered_create_trace(&zero_trace(11_000, 10_998, 10_999)),
        Ok(observer::CreateClassification::UnknownPostCreate)
    );
    let mut missing_pre_create_clock = operation_zero.clone();
    missing_pre_create_clock.remove(2);
    assert!(observer::classify_ordered_create_trace(&missing_pre_create_clock).is_err());
    let mut pre_write_clock = operation_zero.clone();
    pre_write_clock.insert(
        4,
        Event::Clock {
            now: 10_999,
            deadline: 11_000,
        },
    );
    assert!(observer::classify_ordered_create_trace(&pre_write_clock).is_err());
    let mut zero_extra_work = operation_zero.clone();
    zero_extra_work.insert(6, Event::Flush { handle: 30 });
    assert!(observer::classify_ordered_create_trace(&zero_extra_work).is_err());
    let mut zero_reversed_close = operation_zero.clone();
    zero_reversed_close.swap(7, 8);
    assert_eq!(
        observer::classify_ordered_create_trace(&zero_reversed_close),
        Err("native trace release is not reverse-order exact-once")
    );
    let mut zero_duplicate_close = operation_zero.clone();
    zero_duplicate_close.insert(7, Event::Close { handle: 30 });
    assert_eq!(
        observer::classify_ordered_create_trace(&zero_duplicate_close),
        Err("native trace release is not reverse-order exact-once")
    );
    let pre_dispatch_expired = vec![
        Event::Acquire {
            binding: stable_binding(10, "\\\\?\\C:\\fixtures\\rm0032"),
        },
        Event::Clock {
            now: 11_000,
            deadline: 11_000,
        },
        Event::Close { handle: 10 },
    ];
    assert_eq!(
        observer::classify_ordered_create_trace(&pre_dispatch_expired),
        Ok(observer::CreateClassification::UnknownPreEffect)
    );

    let collision_root = stable_binding(20, "\\\\?\\C:\\fixtures\\rm0032");
    let ordered_collision = vec![
        Event::Acquire {
            binding: collision_root.clone(),
        },
        Event::Write {
            handle: 0,
            requested: 1,
            returned: Some(1),
        },
    ];
    assert!(observer::classify_ordered_create_trace(&ordered_collision).is_err());
    let ordered_collision = vec![
        Event::Acquire {
            binding: collision_root.clone(),
        },
        Event::Clock {
            now: 9_998,
            deadline: 10_000,
        },
        Event::CreateInvalid,
        Event::CaptureLastError { code: 80 },
        Event::Clock {
            now: 9_999,
            deadline: 10_000,
        },
        Event::RevalidateAncestors {
            current: vec![collision_root.clone()],
        },
        Event::Close { handle: 20 },
    ];
    assert_eq!(
        observer::classify_ordered_create_trace(&ordered_collision),
        Ok(observer::CreateClassification::RefusedCollision)
    );
    let collision_without_revalidation = ordered_collision
        .iter()
        .filter(|event| !matches!(event, Event::RevalidateAncestors { .. }))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        observer::classify_ordered_create_trace(&collision_without_revalidation),
        Ok(observer::CreateClassification::UnknownPreEffect)
    );
    let mut late_collision = ordered_collision.clone();
    late_collision[4] = Event::Clock {
        now: 10_000,
        deadline: 10_000,
    };
    assert!(observer::classify_ordered_create_trace(&late_collision).is_err());
    let late_collision_cleanup = vec![
        Event::Acquire {
            binding: collision_root.clone(),
        },
        Event::Clock {
            now: 9_998,
            deadline: 10_000,
        },
        Event::CreateInvalid,
        Event::CaptureLastError { code: 80 },
        Event::Clock {
            now: 10_000,
            deadline: 10_000,
        },
        Event::Close { handle: 20 },
    ];
    assert_eq!(
        observer::classify_ordered_create_trace(&late_collision_cleanup),
        Ok(observer::CreateClassification::UnknownPreEffect)
    );
    let collision_failure_dominates = vec![
        Event::Acquire {
            binding: collision_root.clone(),
        },
        Event::Clock {
            now: 9_998,
            deadline: 10_000,
        },
        Event::CreateInvalid,
        Event::CaptureLastError { code: 80 },
        Event::Clock {
            now: 9_999,
            deadline: 10_000,
        },
        Event::RevalidateAncestors {
            current: vec![collision_root.clone()],
        },
        Event::Failure,
        Event::Close { handle: 20 },
    ];
    assert_eq!(
        observer::classify_ordered_create_trace(&collision_failure_dominates),
        Ok(observer::CreateClassification::UnknownPreEffect)
    );
    let mut wrong_binding_known = ordered_known.clone();
    let revalidation = wrong_binding_known
        .iter()
        .position(|event| matches!(event, Event::RevalidateAncestors { .. }))
        .expect("revalidation");
    wrong_binding_known[revalidation] = Event::RevalidateAncestors {
        current: vec![stable_binding(99, "\\\\?\\C:\\fixtures\\rm0032"), ancestor],
    };
    assert_eq!(
        observer::classify_ordered_create_trace(&wrong_binding_known),
        Ok(observer::CreateClassification::UnknownPostCreate)
    );
    let marker_only_known = ordered_known
        .iter()
        .filter(|event| {
            !matches!(event, Event::Acquire { .. })
                && !matches!(event, Event::Close { handle } if *handle == 1 || *handle == 2)
        })
        .map(|event| match event {
            Event::RevalidateAncestors { .. } => Event::RevalidateAncestors { current: vec![] },
            _ => event.clone(),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        observer::classify_ordered_create_trace(&marker_only_known),
        Ok(observer::CreateClassification::UnknownPostCreate)
    );
    let missing_immediate_last_error = vec![
        Event::Acquire {
            binding: stable_binding(30, "\\\\?\\C:\\fixtures\\rm0032"),
        },
        Event::Clock {
            now: 1,
            deadline: 10,
        },
        Event::CreateInvalid,
        Event::Clock {
            now: 1,
            deadline: 10,
        },
        Event::CaptureLastError { code: 80 },
        Event::Close { handle: 30 },
    ];
    assert!(observer::classify_ordered_create_trace(&missing_immediate_last_error).is_err());
    let reused_handle = vec![
        Event::Acquire {
            binding: stable_binding(40, "\\\\?\\C:\\fixtures\\rm0032"),
        },
        Event::Clock {
            now: 1,
            deadline: 10,
        },
        Event::CreateValid { handle: 40 },
        Event::Close { handle: 40 },
    ];
    assert!(observer::classify_ordered_create_trace(&reused_handle).is_err());
    #[cfg(windows)]
    windows_native_create_evidence();
}

fn deadline_resource_group() {
    let fixture = fixture();
    let vector = &fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "deadline-resource")
        .expect("deadline group")["vectors"][0];
    let deadline_group = fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "deadline-resource")
        .expect("deadline group");
    assert_hostile_ids(
        deadline_group,
        &[
            "deadline-operation-expired",
            "deadline-aggregate-precedence",
            "deadline-overflow",
            "deadline-create-open-classification-dominance",
            "deadline-late-read-refusal-dominance",
            "deadline-post-frame-known-dominance",
            "deadline-aggregate-start-before-request",
            "deadline-post-parse-known-dominance",
            "deadline-clock-fault",
            "deadline-timeout-one-latch",
            "ancestor-stable-identity-revalidation",
            "native-trace-last-error-adjacency",
            "termination-request-repeat",
            "handle-double-close",
            "handle-unknown-kind",
        ],
    );
    let deadlines = observer::DeadlineContext::new(
        vector["aggregateStartMonotonicMs"]
            .as_u64()
            .expect("aggregate start"),
        vector["operationStartMonotonicMs"]
            .as_u64()
            .expect("operation start"),
    )
    .expect("deadline context");
    assert_eq!(deadlines.operation_deadline_ms, 11_000);
    assert_eq!(deadlines.aggregate_deadline_ms, 15_000);
    assert_eq!(deadlines.earliest(), 11_000);
    assert_eq!(vector["earliestDeadlineMonotonicMs"], 11_000);
    assert_eq!(vector["terminationRequestMax"], 1);
    assert_eq!(vector["drainGraceMs"], 5_000);
    assert!(!deadlines.expired(10_999));
    assert!(deadlines.expired(11_000));
    let aggregate_first_vector = &deadline_group["vectors"][1];
    let aggregate_first = observer::DeadlineContext::new(
        aggregate_first_vector["aggregateStartMonotonicMs"]
            .as_u64()
            .expect("aggregate-first start"),
        aggregate_first_vector["operationStartMonotonicMs"]
            .as_u64()
            .expect("aggregate-first operation start"),
    )
    .expect("aggregate-first deadline context");
    assert_eq!(aggregate_first.aggregate_deadline_ms, 15_000);
    assert_eq!(aggregate_first.operation_deadline_ms, 24_000);
    assert_eq!(aggregate_first.earliest(), 15_000);
    assert!(!observer::deadline_reached(10_999_u64, 11_000_u64));
    assert!(observer::deadline_reached(11_000_u64, 11_000_u64));
    assert!(observer::deadline_reached(11_001_u64, 11_000_u64));
    assert_eq!(
        observer::classify_read_observation_failure_after_deadline(
            observer::ProofFailure::DeterministicDrift,
            true,
        ),
        observer::ReadObservationFailureClassification::Unknown
    );
    assert_eq!(
        observer::classify_read_observation_failure_after_deadline(
            observer::ProofFailure::DeterministicDrift,
            false,
        ),
        observer::ReadObservationFailureClassification::Refused
    );
    let framed = observer::success_frame(
        &serde_json::json!({"frame": "observation"}),
        &serde_json::json!({"frame": "acknowledgment"}),
    );
    assert!(observer::finalize_success_frame(framed, true).is_err());
    #[cfg(windows)]
    {
        assert_eq!(
            observer::classify_create_open_error_after_deadline(80, true),
            observer::CreateClassification::UnknownPreEffect
        );
        assert_eq!(
            observer::classify_create_open_error_after_deadline(80, false),
            observer::CreateClassification::RefusedCollision
        );
        assert_eq!(
            observer::classify_create_open_error_after_deadline(5, true),
            observer::CreateClassification::UnknownPreEffect
        );
        assert_eq!(
            observer::classify_create_open_error_after_release(80, false, true),
            observer::CreateClassification::UnknownPreEffect
        );
        assert_eq!(
            observer::classify_create_open_error_after_release(5, false, true),
            observer::CreateClassification::UnknownPreEffect
        );
        assert_eq!(
            observer::classify_create_open_error_after_release(80, true, false),
            observer::CreateClassification::UnknownPreEffect
        );
        assert_eq!(
            observer::classify_create_open_error_after_release(5, true, false),
            observer::CreateClassification::UnknownPreEffect
        );
        assert_eq!(
            observer::classify_create_open_error_after_release(0, true, true),
            observer::CreateClassification::UnknownPostCreate
        );
    }
    assert!(observer::DeadlineContext::new(u64::MAX, 0).is_err());

    let mut ledger = observer::HandleLedger::default();
    for kind in vector["ownedHandleKinds"].as_array().expect("handle kinds") {
        ledger
            .acquire(kind.as_str().expect("kind"))
            .expect("known handle kind");
    }
    for kind in vector["ownedHandleKinds"].as_array().expect("handle kinds") {
        ledger
            .close(kind.as_str().expect("kind"))
            .expect("one close");
    }
    assert!(ledger.all_released());
    assert!(ledger.close("root").is_err());
    assert!(ledger.acquire("unknown-kind").is_err());
    let mut termination = observer::TerminationRequestLatch::default();
    assert_eq!(termination.request(), Ok(()));
    assert!(termination.request().is_err());
    assert_eq!(observer::OPERATION_DEADLINE_MS, 10_000);
    assert_eq!(observer::AGGREGATE_DEADLINE_MS, 15_000);
    assert_eq!(observer::DRAIN_GRACE_MS, 5_000);

    let stable = observer::StableAncestorIdentity {
        volume_serial_number: "0123456789abcdef".to_owned(),
        file_id: "00112233445566778899aabbccddeeff".to_owned(),
        final_path: "\\\\?\\C:\\fixtures\\rm0032".to_owned(),
        directory: true,
        reparse_free: true,
    };
    assert_eq!(
        observer::validate_stable_ancestor_revalidation(
            std::slice::from_ref(&stable),
            std::slice::from_ref(&stable)
        ),
        Ok(())
    );
    for hostile in [
        observer::StableAncestorIdentity {
            volume_serial_number: "1123456789abcdef".to_owned(),
            ..stable.clone()
        },
        observer::StableAncestorIdentity {
            file_id: "10112233445566778899aabbccddeeff".to_owned(),
            ..stable.clone()
        },
        observer::StableAncestorIdentity {
            final_path: "\\\\?\\C:\\fixtures\\RM0032".to_owned(),
            ..stable.clone()
        },
        observer::StableAncestorIdentity {
            directory: false,
            ..stable.clone()
        },
        observer::StableAncestorIdentity {
            reparse_free: false,
            ..stable.clone()
        },
    ] {
        assert!(
            observer::validate_stable_ancestor_revalidation(
                std::slice::from_ref(&stable),
                std::slice::from_ref(&hostile)
            )
            .is_err()
        );
    }
    assert!(
        observer::validate_stable_ancestor_revalidation(std::slice::from_ref(&stable), &[])
            .is_err()
    );
    let stable_binding = observer::StableAncestorBinding {
        handle_id: 1,
        identity: stable.clone(),
    };
    assert_eq!(
        observer::validate_stable_ancestor_binding_revalidation(
            std::slice::from_ref(&stable_binding),
            std::slice::from_ref(&stable_binding),
        ),
        Ok(())
    );
    for hostile_binding in [
        observer::StableAncestorBinding {
            handle_id: 0,
            identity: stable.clone(),
        },
        observer::StableAncestorBinding {
            handle_id: 2,
            identity: stable.clone(),
        },
        observer::StableAncestorBinding {
            handle_id: 1,
            identity: observer::StableAncestorIdentity {
                reparse_free: false,
                ..stable.clone()
            },
        },
    ] {
        assert!(
            observer::validate_stable_ancestor_binding_revalidation(
                std::slice::from_ref(&stable_binding),
                std::slice::from_ref(&hostile_binding),
            )
            .is_err()
        );
    }
    let second_binding = observer::StableAncestorBinding {
        handle_id: 2,
        identity: observer::StableAncestorIdentity {
            file_id: "10112233445566778899aabbccddeeff".to_owned(),
            final_path: "\\\\?\\C:\\fixtures\\rm0032\\held".to_owned(),
            ..stable.clone()
        },
    };
    assert!(
        observer::validate_stable_ancestor_binding_revalidation(
            &[stable_binding.clone(), second_binding.clone()],
            &[second_binding, stable_binding],
        )
        .is_err()
    );

    let read_kat = STANDARD
        .decode(
            fixture["knownAnswerTests"][0]["canonicalUtf8Base64"]
                .as_str()
                .expect("read KAT"),
        )
        .expect("read KAT bytes");
    let expired_aggregate_start = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_millis(
            observer::AGGREGATE_DEADLINE_MS + 1,
        ))
        .expect("representable expired aggregate start");
    let expired = observer::run_observer_with_aggregate_start(
        &[observer::CLI_MODE.to_owned()],
        &read_kat,
        expired_aggregate_start,
    );
    let terminal = observer::parse_canonical_json_value(&expired.stdout).expect("expired terminal");
    assert_eq!(terminal["outcome"], "unknown");
    assert_eq!(terminal["failureStage"], "pre-effect");
}

fn drive_binding_provider_evidence() {
    let fixture = fixture();
    let arguments = vec![observer::CLI_MODE.to_owned()];
    for kat in fixture["knownAnswerTests"].as_array().unwrap() {
        let input = STANDARD.decode(kat["canonicalUtf8Base64"].as_str().unwrap()).unwrap();
        let request = observer::parse_canonical_request(&input).unwrap();
        let record = serde_json::json!({
            "drive": &request.root_path()[..2],
            "ntVolumeRoot": "\\Device\\HarddiskVolume1\\",
            "requestSha256": "0".repeat(64), // deliberately differs from the actual stdin payload
            "schema": observer::DRIVE_BINDING_SCHEMA,
            "volumeSerialNumber": "0123456789abcdef",
        });
        let raw = String::from_utf8(observer::canonical_json_bytes(&record).unwrap()).unwrap();
        for snapshot in [vec![], vec![(observer::DRIVE_BINDING_ENV.into(), raw.into())]] {
            let calls = std::cell::Cell::new(0);
            let result = observer::run_observer_with_fixture_environment(
                &arguments, &input, std::time::Instant::now(), || {
                    calls.set(calls.get() + 1);
                    snapshot
                },
            );
            assert_eq!(calls.get(), 1, "valid request takes one snapshot before binding refusal");
            assert_eq!(result.exit_code, 0);
            let terminal = observer::parse_canonical_json_value(&result.stdout).unwrap();
            observer::validate_terminal(&terminal).unwrap();
            assert_eq!(terminal["requestSha256"], observer::sha256_lower(&input));
            assert_eq!(terminal["requestId"], request.request_id());
            assert_eq!(terminal["operation"], request.operation());
            assert_eq!(terminal["outcome"], "unknown");
            assert_eq!(terminal["failureStage"], "pre-effect");
            assert_eq!(terminal["effectState"], "none");
        }
        let value = observer::parse_canonical_json_value(&input).unwrap();
        let mut malformed_inputs = vec![b"{".to_vec(), vec![b'x'; 393_217]];
        for (key, value_override) in [
            ("schema", "wrong"), ("requestId", "lowercase"),
            ("rootPath", "C:\\..\\bad"), ("targetPath", "D:\\elsewhere"),
        ] {
            let mut hostile = value.clone();
            hostile[key] = Value::String(value_override.into());
            malformed_inputs.push(observer::canonical_json_bytes(&hostile).unwrap());
        }
        for malformed in malformed_inputs {
            let baseline = observer::run_observer(&arguments, &malformed);
            let result = observer::run_observer_with_fixture_environment(
                &arguments, &malformed, std::time::Instant::now(),
                || panic!("malformed input must never request an environment snapshot"),
            );
            assert_eq!(result.stdout, baseline.stdout);
            assert_eq!(result.exit_code, baseline.exit_code);
        }
        let invalid_cli = observer::run_observer_with_fixture_environment(
            &[], &input, std::time::Instant::now(),
            || panic!("invalid CLI must never request an environment snapshot"),
        );
        assert_eq!(invalid_cli.exit_code, 64);
        let expired = observer::run_observer_with_fixture_environment(
            &arguments, &input, std::time::Instant::now() - std::time::Duration::from_millis(observer::AGGREGATE_DEADLINE_MS + 1),
            || panic!("expired request must never request an environment snapshot"),
        );
        let terminal = observer::parse_canonical_json_value(&expired.stdout).unwrap();
        assert_eq!(terminal["outcome"], "unknown");
        assert_eq!(terminal["failureStage"], "pre-effect");
    }
}

fn adapter_group() {
    drive_binding_provider_evidence();
    let fixture = fixture();
    let adapter_group = fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "adapter")
        .expect("adapter group");
    assert_hostile_ids(
        adapter_group,
        &[
            "request-wrong-consumer",
            "observation-wrong-consumer",
            "ack-wrong-consumer",
            "observation-missing-property",
            "observation-extra-property",
            "ack-missing-property",
            "ack-extra-property",
            "output-schema-drift",
            "output-version-drift",
            "cross-operation-request",
            "cross-operation-observation",
            "cross-operation-ack",
            "marker-evidence-collision",
            "evidence-truncated",
            "evidence-corrupt",
            "ack-corrupt",
            "ack-hash-mismatch",
            "late-known",
            "concurrent-invocation",
            "stopped-call",
            "evidence-root-mismatch",
            "create-output-symmetry",
            "create-terminal-matrix",
            "method-payload-fresh-observer-zero-transport",
            "request-pre-cap-allocation",
            "base64-cap-boundary",
            "create-request-symmetry",
            "bounded-request-correlation",
        ],
    );
    let adapter_vector = &adapter_group["vectors"][0];
    assert_eq!(
        adapter_vector["acceptedBinding"]["evidenceRootAbsolutePath"],
        "C:\\ProgramData\\DecadansNeurobro\\Phase3\\evidence\\native-observer-v1"
    );
    assert_eq!(
        adapter_vector["evidenceRootPolicy"],
        "exact-accepted-binding-only"
    );
    assert_eq!(adapter_vector["invocationAttemptCount"], 1);
    assert_eq!(adapter_vector["stoppedCallInvocationAttemptCount"], 0);
    assert_eq!(
        adapter_vector["transportProductionImplementationPresent"],
        false
    );
    assert_eq!(adapter_vector["retryAuthorized"], false);
    assert_eq!(adapter_vector["cleanupAuthorized"], false);
    assert_eq!(adapter_vector["fallbackAuthorized"], false);
    let read_kat = STANDARD
        .decode(
            fixture["knownAnswerTests"][0]["canonicalUtf8Base64"]
                .as_str()
                .expect("read KAT"),
        )
        .expect("read KAT bytes");
    let request = observer::parse_canonical_request(&read_kat).expect("request");
    observer::validate_request_semantics(&request, read_kat.len()).expect("request semantics");
    assert!(observer::validate_request_semantics(&request, read_kat.len() + 1).is_err());
    let identity_value = &fixture["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|candidate| candidate["id"] == "read-bound-file")
        .expect("read group")["vectors"][0]["identity"];
    let identity = observer::FileIdentity::from_value(identity_value).expect("identity");
    let content = b"tracer-bullet";
    let (observation, acknowledgment) = observer::read_success_values(
        &request,
        &observer::sha256_lower(&read_kat),
        &identity,
        &identity,
        content,
    )
    .expect("read success DTOs");
    assert_eq!(observation.as_object().expect("O").len(), 10);
    assert_eq!(acknowledgment.as_object().expect("A").len(), 9);
    assert_eq!(acknowledgment["outcome"], "known");
    assert_eq!(
        observation["requestSha256"],
        observer::sha256_lower(&read_kat)
    );
    assert_eq!(
        acknowledgment["requestSha256"],
        observer::sha256_lower(&read_kat)
    );
    assert!(
        observer::read_success_values(&request, &"0".repeat(64), &identity, &identity, content,)
            .is_err()
    );

    let read_value = observer::parse_canonical_json_value(&read_kat).expect("read request value");
    let mut wrong_schema = read_value.clone();
    wrong_schema["schema"] = Value::String("wrong-schema".to_owned());
    let mut wrong_version = read_value.clone();
    wrong_version["version"] = Value::String("v2".to_owned());
    let mut wrong_consumer = read_value.clone();
    wrong_consumer["consumer"] = Value::String("wrong-consumer".to_owned());
    let mut extra_property = read_value.clone();
    extra_property
        .as_object_mut()
        .expect("request object")
        .insert("extra".to_owned(), Value::Bool(true));
    let mut missing_property = read_value.clone();
    missing_property
        .as_object_mut()
        .expect("request object")
        .remove("targetPath");
    let mut cross_operation = read_value.clone();
    cross_operation["operation"] = Value::String("create-new-durable-file".to_owned());
    let observe_args = vec!["observe-v1".to_owned()];
    for hostile in [
        wrong_schema,
        wrong_version,
        wrong_consumer,
        extra_property,
        missing_property,
        cross_operation,
    ] {
        let hostile_bytes =
            observer::canonical_json_bytes(&hostile).expect("hostile request bytes");
        let hostile_run = observer::run_observer(&observe_args, &hostile_bytes);
        assert_eq!(hostile_run.exit_code, 0);
        let terminal = observer::parse_canonical_json_value(&hostile_run.stdout)
            .expect("correlatable semantic terminal");
        observer::validate_terminal(&terminal).expect("terminal exactness");
        assert_eq!(terminal["operation"], hostile["operation"]);
        assert_eq!(terminal["requestId"], hostile["requestId"]);
        assert_eq!(
            terminal["requestSha256"],
            observer::sha256_lower(&hostile_bytes)
        );
        assert_eq!(terminal["outcome"], "refused");
        assert_eq!(terminal["failureStage"], "pre-effect");
        assert_eq!(terminal["effectState"], "none");
    }

    let create_kat = STANDARD
        .decode(
            fixture["knownAnswerTests"][1]["canonicalUtf8Base64"]
                .as_str()
                .expect("create KAT"),
        )
        .expect("create KAT bytes");
    let create_value =
        observer::parse_canonical_json_value(&create_kat).expect("create request value");
    let mut create_wrong_schema = create_value.clone();
    create_wrong_schema["schema"] = Value::String("wrong-schema".to_owned());
    let mut create_wrong_version = create_value.clone();
    create_wrong_version["version"] = Value::String("v2".to_owned());
    let mut create_wrong_consumer = create_value.clone();
    create_wrong_consumer["consumer"] = Value::String("wrong-consumer".to_owned());
    let mut create_missing_target = create_value.clone();
    create_missing_target
        .as_object_mut()
        .expect("create request object")
        .remove("targetPath");
    let mut create_extra = create_value.clone();
    create_extra
        .as_object_mut()
        .expect("create request object")
        .insert("extra".to_owned(), Value::Bool(true));
    let mut read_as_create =
        observer::parse_canonical_json_value(&read_kat).expect("read request value");
    read_as_create["operation"] = Value::String("create-new-durable-file".to_owned());
    for (hostile, expected_bytes, expected_sha256) in [
        (
            create_wrong_schema,
            299,
            "1ed1c12b60f22098a8f941e3073c355a8c6c305a0ac574311854bb384032f2ca",
        ),
        (
            create_wrong_version,
            329,
            "3f7c4f670f75eca26e8d9734b1669cdcdf356315ebfb0c11075f1dea53754833",
        ),
        (
            create_wrong_consumer,
            307,
            "2e813018ad149d62fded462ce2cb8129c22b2577f16c00308e453baa1833a800",
        ),
        (
            create_missing_target,
            282,
            "12c152a675877afb357ac27341d3fccc060323fe4999fc0ac9c4cdb425b242df",
        ),
        (
            create_extra,
            342,
            "e76a16061b113935c36e61fd1e36411006a2d0a7dd870fd96a2f04a011f3bd81",
        ),
        (
            read_as_create,
            290,
            "1da89f2e3754204d4e4979b04c47b7e86e18e1ed7a42926a7fd7b1e64baf752e",
        ),
    ] {
        let hostile_bytes =
            observer::canonical_json_bytes(&hostile).expect("canonical create hostile");
        assert_eq!(hostile_bytes.len(), expected_bytes);
        assert_eq!(observer::sha256_lower(&hostile_bytes), expected_sha256);
        let hostile_run = observer::run_observer(&observe_args, &hostile_bytes);
        assert_eq!(hostile_run.exit_code, 0);
        let terminal = observer::parse_canonical_json_value(&hostile_run.stdout)
            .expect("create-correlated semantic terminal");
        observer::validate_terminal(&terminal).expect("terminal exactness");
        assert_eq!(terminal["operation"], "create-new-durable-file");
        assert_eq!(terminal["requestId"], hostile["requestId"]);
        assert_eq!(terminal["requestSha256"], expected_sha256);
        assert_eq!(terminal["outcome"], "refused");
        assert_eq!(terminal["failureStage"], "pre-effect");
        assert_eq!(terminal["effectState"], "none");
    }

    let mut invalid_request_id_value = read_value;
    invalid_request_id_value["requestId"] = Value::String("lowercase".to_owned());
    let invalid_request_id_bytes = observer::canonical_json_bytes(&invalid_request_id_value)
        .expect("invalid requestId request bytes");
    let invalid_request_id_run = observer::run_observer(&observe_args, &invalid_request_id_bytes);
    assert_eq!(invalid_request_id_run.exit_code, 0);
    assert_eq!(
        observer::parse_canonical_json_value(&invalid_request_id_run.stdout)
            .expect("pre-observation refusal"),
        observer::pre_observation_refusal()
    );

    let invalid_cli = observer::run_observer(&[], &read_kat);
    assert_eq!(invalid_cli.exit_code, 64);
    assert!(invalid_cli.stdout.is_empty());
    let mut invalid_request = request.clone();
    invalid_request.set_for_test("requestId", Value::String("lowercase".to_owned()));
    assert!(observer::validate_request_semantics(&invalid_request, read_kat.len()).is_err());

    for selector_args in [
        vec![""],
        vec!["unknown-selector"],
        vec!["canonical", "canonical"],
        vec!["canonical", "scalar"],
    ] {
        let selector_failure =
            std::process::Command::new(std::env::current_exe().expect("test exe"))
                .args(selector_args)
                .output()
                .expect("invalid selector subprocess");
        assert_eq!(selector_failure.status.code(), Some(2));
        assert!(
            String::from_utf8_lossy(&selector_failure.stderr)
                .contains("exactly one known nonempty family")
        );
        assert!(!String::from_utf8_lossy(&selector_failure.stdout).contains("fixture-group:"));
    }
}

fn run_family(family: &str, emit_count: bool) {
    match family {
        "canonical" => canonical_group(),
        "scalar" => scalar_group(),
        "terminal" => terminal_group(),
        "framing" => framing_group(),
        "read-bound-file" => read_bound_file_group(),
        "create-new-durable-file" => create_new_durable_file_group(),
        "deadline-resource" => deadline_resource_group(),
        "adapter" => adapter_group(),
        _ => panic!("fixture group not implemented: {family}"),
    }
    println!("fixture-group:{family}:PASS matchedTestCount=1 failedTestCount=0");
    if emit_count {
        println!("1-tests-passed");
    }
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [] => {
            FAMILIES.iter().for_each(|family| run_family(family, false));
            println!("8-tests-passed");
        }
        [family] if FAMILIES.contains(&family.as_str()) => run_family(family, true),
        _ => {
            eprintln!("observer-contract-vectors: exactly one known nonempty family is required");
            std::process::exit(2);
        }
    }
}
