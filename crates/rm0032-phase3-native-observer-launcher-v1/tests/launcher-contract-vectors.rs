#![allow(dead_code)]

#[path = "../../rm0032-phase3-native-observer-v1/src/main.rs"]
mod accepted_observer;
#[path = "../src/main.rs"]
mod launcher;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use launcher::*;
use sha2::Digest;
use std::cell::Cell;
use std::env;
use std::sync::atomic::{AtomicUsize, Ordering};

type Group = (&'static str, fn() -> usize);
static EXECUTED_REDUCER_CASES: AtomicUsize = AtomicUsize::new(0);

fn make_context(mode: Mode, bytes: Vec<u8>) -> ProductionInvocationContext {
    let envelope = parse_canonical_wire_envelope(&bytes).expect("test envelope is canonical");
    let supervisor = ProductionInvocationContext::new_supervisor(
        envelope,
        bytes,
        canonical_observer_payload_bytes(),
    )
    .expect("supervisor context is valid");
    match mode {
        Mode::Supervisor => supervisor,
        Mode::Worker => parse_production_input(
            Mode::Worker,
            &supervisor.supervisor_handoff_bytes().unwrap(),
        )
        .expect("worker handoff is valid"),
    }
}

fn run_context(
    context: ProductionInvocationContext,
    overrides: Vec<ScriptedOverride>,
) -> (ReducerResult, ScriptedKernel) {
    EXECUTED_REDUCER_CASES.fetch_add(1, Ordering::Relaxed);
    let store = SharedScriptedLedgerStore::default();
    if context.mode == Mode::Worker {
        store.seed_supervisor(&context);
    }
    let mut kernel = ScriptedKernel::with_store(overrides, store);
    let result = run_reducer(&context, &mut kernel);
    assert_eq!(kernel.bound_contexts, vec![context]);
    (result, kernel)
}

fn run(mode: Mode, overrides: Vec<ScriptedOverride>) -> (ReducerResult, ScriptedKernel) {
    run_context(make_context(mode, canonical_envelope_bytes()), overrides)
}

fn run_closed_context(
    context: ProductionInvocationContext,
    overrides: Vec<ScriptedOverride>,
) -> (LauncherResult, ScriptedKernel) {
    EXECUTED_REDUCER_CASES.fetch_add(1, Ordering::Relaxed);
    let store = SharedScriptedLedgerStore::default();
    if context.mode == Mode::Worker {
        store.seed_supervisor(&context);
    }
    let mut kernel = ScriptedKernel::with_store(overrides, store);
    let result = run_and_close(&context, &mut kernel);
    assert_eq!(kernel.bound_contexts, vec![context]);
    (result, kernel)
}

fn run_closed(mode: Mode, overrides: Vec<ScriptedOverride>) -> (LauncherResult, ScriptedKernel) {
    run_closed_context(make_context(mode, canonical_envelope_bytes()), overrides)
}

fn case_cursor() -> usize {
    EXECUTED_REDUCER_CASES.load(Ordering::Relaxed)
}

fn cases_since(cursor: usize) -> usize {
    case_cursor() - cursor
}

fn changed(ordinal: usize, reply: KernelReply) -> Vec<ScriptedOverride> {
    vec![ScriptedOverride { ordinal, reply }]
}

fn assert_one_override(kernel: &ScriptedKernel) {
    assert_eq!(kernel.matched_override_count(), 1);
}

fn assert_override_count(kernel: &ScriptedKernel, expected: usize) {
    assert_eq!(kernel.matched_override_count(), expected);
}

struct SnapshotFailKernel {
    inner: ScriptedKernel,
}

impl LauncherKernel for SnapshotFailKernel {
    fn bind_context(&mut self, context: &ProductionInvocationContext) -> KernelReply {
        self.inner.bind_context(context)
    }

    fn invoke(&mut self, step: Step) -> KernelReply {
        self.inner.invoke(step)
    }

    fn promoted_worker_outcome(&self) -> Option<(ReducerTerminal, String)> {
        self.inner.promoted_worker_outcome()
    }

    fn worker_promotion_diagnostic(&self) -> WorkerPromotionDiagnostic {
        self.inner.worker_promotion_diagnostic()
    }

    fn snapshot_evidence(
        &mut self,
        _context: &ProductionInvocationContext,
        _child: ChildStartEvidence,
    ) -> Result<LauncherWireEvidenceV1, &'static str> {
        Err("hostile snapshot failure")
    }
}

fn assert_no_step(calls: &[Step], forbidden: Step) {
    assert!(
        !calls.contains(&forbidden),
        "forbidden call observed: {forbidden:?}"
    );
}

fn canonical_envelope_bytes() -> Vec<u8> {
    let payload = canonical_observer_payload_bytes();
    serde_json::to_vec(&WireEnvelope {
        schema: REQUEST_SCHEMA.to_owned(),
        version: "v1".to_owned(),
        request_id: "request-1".to_owned(),
        correlation_id: "correlation-1".to_owned(),
        carrier_sha256: "a".repeat(64),
        launcher_image_path: LAUNCHER_IMAGE_DOS.to_owned(),
        launcher_image_sha256: "c".repeat(64),
        observer_image_path: OBSERVER_IMAGE_DOS.to_owned(),
        observer_image_sha256: "b".repeat(64),
        evidence_root_absolute_path: ACCEPTED_EVIDENCE_ROOT_DOS.to_owned(),
        stdin_sha256: format!("{:x}", sha2::Sha256::digest(&payload)),
        stdin_byte_count: payload.len() as u64,
        deadline_ms: 10_000,
    })
    .expect("fixed envelope serializes")
}

fn canonical_observer_payload_bytes() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "consumer": OBSERVER_REQUEST_CONSUMER,
        "operation": "read-bound-file",
        "requestId": "request-1",
        "rootPath": r"\\?\C:\ProgramData\DecadansNeurobro\accepted-evidence-v1",
        "schema": OBSERVER_REQUEST_SCHEMA,
        "targetPath": r"requests\request-1.json",
        "version": "v1"
    }))
    .unwrap()
}

fn supervisor_frame_for_payload(payload: &[u8]) -> Vec<u8> {
    let mut header: WireEnvelope = serde_json::from_slice(&canonical_envelope_bytes()).unwrap();
    header.stdin_sha256 = format!("{:x}", sha2::Sha256::digest(payload));
    header.stdin_byte_count = payload.len() as u64;
    [
        serde_json::to_vec(&header).unwrap(),
        b"\n".to_vec(),
        payload.to_vec(),
    ]
    .concat()
}

fn mutate_launcher_result_wire(
    bytes: &[u8],
    mutate: impl FnOnce(&mut serde_json::Value),
) -> Vec<u8> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    mutate(&mut value);
    serde_json::to_vec(&value).unwrap()
}

fn fixed_binding() -> usize {
    let cursor = case_cursor();
    assert!(LAUNCHER_IMAGE.starts_with(r"\\?\C:\"));
    assert!(OBSERVER_IMAGE.starts_with(r"\\?\C:\"));
    assert_eq!(WORKER_ARGV, [LAUNCHER_IMAGE, WORKER_MODE]);
    assert_eq!(OBSERVER_ARGV, [OBSERVER_IMAGE, "observe-v1"]);
    assert!(!CREATE_WITH_SHELL && CREATE_HIDDEN);
    assert_eq!(
        EXACT_ENVIRONMENT_KEYS,
        ["SystemDrive", "SystemRoot", "WINDIR"]
    );
    assert_eq!(
        EXACT_ENVIRONMENT,
        [
            ("SystemDrive", "C:"),
            ("SystemRoot", r"C:\Windows"),
            ("WINDIR", r"C:\Windows"),
        ]
    );
    assert_eq!(
        EXACT_ENVIRONMENT.map(|(key, _)| key),
        EXACT_ENVIRONMENT_KEYS
    );
    assert_eq!(EXACT_WINDOWS_ROOT, r"C:\Windows");
    let worker_spec = fixed_native_launch_spec(ChildKind::Worker);
    assert_eq!(worker_spec.application, LAUNCHER_IMAGE);
    assert_eq!(worker_spec.mode, WORKER_MODE);
    assert_eq!(worker_spec.cwd, FIXED_CWD);
    assert_eq!(
        worker_spec.inherited_handle_count,
        EXACT_INHERITED_HANDLE_COUNT
    );
    assert!(worker_spec.inherit_handles);
    assert_eq!(worker_spec.attribute_count, 1);
    assert_eq!(
        worker_spec.startup_info_flags,
        FIXED_NATIVE_STARTUP_INFO_FLAGS
    );
    assert_eq!(worker_spec.creation_flags, FIXED_NATIVE_CREATION_FLAGS);
    let observer_spec = fixed_native_launch_spec(ChildKind::Observer);
    assert_eq!(observer_spec.application, OBSERVER_IMAGE);
    assert_eq!(observer_spec.mode, "observe-v1");
    assert_eq!(observer_spec.attribute_count, 2);
    assert_eq!(
        classify_process_information(true, false, false, 7, 0),
        ProcessInformationDisposition::MalformedWithProcessHandle
    );
    assert_eq!(
        classify_process_information(false, true, false, 0, 7),
        ProcessInformationDisposition::MalformedWithoutProcessHandle
    );
    assert_eq!(
        parse_mode(&["x".into(), SUPERVISE_MODE.into()]),
        Ok(Mode::Supervisor)
    );
    assert_eq!(
        parse_mode(&["x".into(), WORKER_MODE.into()]),
        Ok(Mode::Worker)
    );
    assert!(parse_mode(&["x".into()]).is_err());
    assert!(parse_mode(&["x".into(), "unknown".into()]).is_err());
    assert!(parse_mode(&["x".into(), SUPERVISE_MODE.into(), SUPERVISE_MODE.into()]).is_err());
    assert_eq!(select_groups(&[]).unwrap().len(), GROUPS.len());
    assert_eq!(select_groups(&["fixed-binding".into()]).unwrap().len(), 1);
    assert!(select_groups(&[String::new()]).is_err());
    assert!(select_groups(&["unknown".into()]).is_err());
    assert!(select_groups(&["fixed-binding".into(), "fixed-binding".into()]).is_err());

    let canonical = canonical_envelope_bytes();
    assert!(parse_canonical_wire_envelope(&canonical).is_ok());
    let payload = canonical_observer_payload_bytes();
    let supervisor_frame = [canonical.as_slice(), b"\n", payload.as_slice()].concat();
    let (positive_result, positive_kernel) =
        parse_then_run_with_kernel_factory(Mode::Supervisor, &supervisor_frame, || {
            ScriptedKernel::with_overrides(Vec::new())
        })
        .expect("canonical Supervisor deadlineMs=10_000 reaches the controlled reducer");
    assert_eq!(positive_result.terminal, ReducerTerminal::Success);
    assert!(positive_kernel.calls.contains(&Step::CreateDurableLedger));
    assert!(
        positive_kernel
            .calls
            .contains(&Step::CreateSuspendedChild(ChildKind::Worker))
    );
    assert!(positive_kernel.calls.contains(&Step::WaitForStableReap));

    let mut over_cap: WireEnvelope = serde_json::from_slice(&canonical).unwrap();
    over_cap.deadline_ms = 10_001;
    let over_cap_header = serde_json::to_vec(&over_cap).unwrap();
    assert!(parse_canonical_wire_envelope(&over_cap_header).is_err());
    let over_cap_frame = [over_cap_header, b"\n".to_vec(), payload.clone()].concat();
    let downstream_factory_calls = Cell::new(0usize);
    let over_cap_result =
        parse_then_run_with_kernel_factory(Mode::Supervisor, &over_cap_frame, || {
            downstream_factory_calls.set(downstream_factory_calls.get() + 1);
            ScriptedKernel::with_overrides(Vec::new())
        });
    assert!(over_cap_result.is_err());
    assert_eq!(
        downstream_factory_calls.get(),
        0,
        "deadlineMs=10_001 must be refused before ledger, child, and wait capabilities exist"
    );
    let with_whitespace = [canonical.as_slice(), b"\n"].concat();
    assert!(parse_canonical_wire_envelope(&with_whitespace).is_err());
    let mut unknown: serde_json::Value = serde_json::from_slice(&canonical).unwrap();
    unknown
        .as_object_mut()
        .unwrap()
        .insert("extra".into(), serde_json::json!(true));
    assert!(parse_canonical_wire_envelope(&serde_json::to_vec(&unknown).unwrap()).is_err());
    for field in [
        "launcherImagePath",
        "launcherImageSha256",
        "observerImagePath",
        "evidenceRootAbsolutePath",
    ] {
        let mut drift: serde_json::Value =
            serde_json::from_slice(&canonical_envelope_bytes()).unwrap();
        drift[field] = serde_json::json!(if field.ends_with("Sha256") {
            "d".repeat(64)
        } else {
            r"C:\alternate\same-basename.exe".to_owned()
        });
        assert!(parse_canonical_wire_envelope(&serde_json::to_vec(&drift).unwrap()).is_err());
    }
    let text = String::from_utf8(canonical).unwrap();
    let duplicate = text.replacen(
        "{\"schema\":",
        &format!("{{\"schema\":\"{REQUEST_SCHEMA}\",\"schema\":"),
        1,
    );
    assert!(parse_canonical_wire_envelope(duplicate.as_bytes()).is_err());

    let header = canonical_envelope_bytes();
    let supervisor_frame = [header.as_slice(), b"\n", payload.as_slice()].concat();
    let supervisor_context = parse_production_input(Mode::Supervisor, &supervisor_frame).unwrap();
    let handoff = supervisor_context.supervisor_handoff_bytes().unwrap();
    let worker_context = parse_production_input(Mode::Worker, &handoff).unwrap();
    assert_eq!(worker_context.canonical_request_bytes, payload);
    assert_eq!(worker_context.observer_payload_bytes, payload);
    assert!(!worker_context.canonical_request_bytes.contains(&b'\n'));
    let accepted =
        accepted_observer::parse_canonical_request(&worker_context.canonical_request_bytes)
            .expect("exact worker stdin must pass the immutable accepted observer parser");
    assert_eq!(accepted.operation(), "read-bound-file");
    assert_eq!(accepted.request_id(), "request-1");
    assert_eq!(
        accepted.root_path(),
        r"\\?\C:\ProgramData\DecadansNeurobro\accepted-evidence-v1"
    );
    assert_eq!(accepted.target_path(), r"requests\request-1.json");
    assert_eq!(accepted.content_base64(), None);
    let payload_value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert!(payload_value.get("correlationId").is_none());
    assert!(payload_value.get("carrierSha256").is_none());
    assert!(parse_production_input(Mode::Supervisor, &header).is_err());
    assert!(
        parse_production_input(
            Mode::Supervisor,
            &[supervisor_frame.as_slice(), b"\nextra"].concat()
        )
        .is_err()
    );
    assert!(
        parse_production_input(
            Mode::Supervisor,
            &supervisor_frame[..supervisor_frame.len() - 1]
        )
        .is_err()
    );
    let mut size_drift: WireEnvelope = serde_json::from_slice(&header).unwrap();
    size_drift.stdin_byte_count += 1;
    let size_drift = [
        serde_json::to_vec(&size_drift).unwrap(),
        b"\n".to_vec(),
        canonical_observer_payload_bytes(),
    ]
    .concat();
    assert!(parse_production_input(Mode::Supervisor, &size_drift).is_err());
    let mut proof_drift = handoff.clone();
    *proof_drift.last_mut().unwrap() ^= 1;
    assert!(parse_production_input(Mode::Worker, &proof_drift).is_err());

    let canonical_payload: serde_json::Value =
        serde_json::from_slice(&canonical_observer_payload_bytes()).unwrap();
    let mut payload_hostiles = Vec::new();
    for (field, value) in [
        ("schema", serde_json::json!("wrong-schema")),
        ("version", serde_json::json!("v2")),
        ("consumer", serde_json::json!("wrong-consumer")),
        ("operation", serde_json::json!("delete-file")),
        ("requestId", serde_json::json!("different-request")),
    ] {
        let mut hostile = canonical_payload.clone();
        hostile[field] = value;
        payload_hostiles.push(hostile);
    }
    let mut extra = canonical_payload.clone();
    extra["extra"] = serde_json::json!(true);
    payload_hostiles.push(extra);
    let mut missing = canonical_payload.clone();
    missing.as_object_mut().unwrap().remove("targetPath");
    payload_hostiles.push(missing);
    let mut read_with_content = canonical_payload.clone();
    read_with_content["contentBase64"] = serde_json::json!("YQ==");
    payload_hostiles.push(read_with_content);
    let mut create_without_content = canonical_payload.clone();
    create_without_content["operation"] = serde_json::json!("create-new-durable-file");
    payload_hostiles.push(create_without_content);
    for hostile in payload_hostiles {
        let hostile = serde_json::to_vec(&hostile).unwrap();
        assert!(
            parse_production_input(Mode::Supervisor, &supervisor_frame_for_payload(&hostile))
                .is_err()
        );
    }

    let mut create = canonical_payload.clone();
    create["operation"] = serde_json::json!("create-new-durable-file");
    create["contentBase64"] = serde_json::json!("YQ==");
    let create = serde_json::to_vec(&create).unwrap();
    assert!(accepted_observer::parse_canonical_request(&create).is_ok());
    assert!(
        parse_production_input(Mode::Supervisor, &supervisor_frame_for_payload(&create)).is_ok()
    );

    let noncanonical = format!(
        r#"{{"schema":"{OBSERVER_REQUEST_SCHEMA}","consumer":"{OBSERVER_REQUEST_CONSUMER}","operation":"read-bound-file","requestId":"request-1","rootPath":"\\\\?\\C:\\ProgramData\\DecadansNeurobro\\accepted-evidence-v1","targetPath":"requests\\request-1.json","version":"v1"}}"#
    )
    .into_bytes();
    assert!(accepted_observer::parse_canonical_request(&noncanonical).is_err());
    assert!(
        parse_production_input(
            Mode::Supervisor,
            &supervisor_frame_for_payload(&noncanonical)
        )
        .is_err()
    );

    let (result, kernel) = run(
        Mode::Supervisor,
        changed(1, KernelReply::Refused("fixed binding drift")),
    );
    assert_one_override(&kernel);
    assert_eq!(kernel.calls, vec![Step::ValidateFixedBinding]);
    assert_eq!(result.terminal, ReducerTerminal::Refused);
    assert_eq!(
        result.child_start_evidence,
        ChildStartEvidence::NeverStarted
    );
    assert_eq!(result.invocation_attempt_count, 1);
    let bytes = canonical_envelope_bytes();
    let envelope = parse_canonical_wire_envelope(&bytes).unwrap();
    let context = ProductionInvocationContext::new_supervisor(
        envelope,
        bytes,
        canonical_observer_payload_bytes(),
    )
    .unwrap();
    let closed = close_result(&context, result.clone());
    assert_eq!(closed.schema, RESULT_SCHEMA);
    assert_eq!(closed.request_id, "request-1");
    assert_eq!(closed.carrier_sha256, "a".repeat(64));
    assert_eq!(closed.observer_image_sha256, "b".repeat(64));
    assert_eq!(closed.stdin_sha256, context.observer_payload_sha256);
    assert_eq!(closed.deadline_ms, 10_000);
    assert_eq!(closed.ledger_identity_sha256.len(), 64);
    let serialized = serde_json::to_string(&closed).unwrap();
    assert!(!serialized.contains("evidenceRootAbsolutePath"));

    let original_context = make_context(Mode::Supervisor, canonical_envelope_bytes());
    let mut mutated: WireEnvelope =
        serde_json::from_slice(&original_context.canonical_header_bytes).unwrap();
    mutated.request_id = "request-materially-mutated".into();
    let mut mutated_payload: serde_json::Value =
        serde_json::from_slice(&original_context.observer_payload_bytes).unwrap();
    mutated_payload["requestId"] = serde_json::json!(mutated.request_id.clone());
    let mutated_payload = serde_json::to_vec(&mutated_payload).unwrap();
    mutated.stdin_sha256 = format!("{:x}", sha2::Sha256::digest(&mutated_payload));
    mutated.stdin_byte_count = mutated_payload.len() as u64;
    let mutated_header = serde_json::to_vec(&mutated).unwrap();
    let mutated_context =
        ProductionInvocationContext::new_supervisor(mutated, mutated_header, mutated_payload)
            .unwrap();
    assert_ne!(
        original_context.ledger_identity_sha256,
        mutated_context.ledger_identity_sha256
    );
    let mutated_len = mutated_context.canonical_request_bytes.len();
    let (success, kernel) = run_context(mutated_context, Vec::new());
    assert_eq!(success.terminal, ReducerTerminal::Success);
    assert!(kernel.calls.contains(&Step::Transfer(StreamKind::Stdin)));
    let (short_write, kernel) = run(
        Mode::Supervisor,
        changed(
            22,
            KernelReply::TransferComplete {
                bytes: mutated_len - 1,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(short_write.terminal, ReducerTerminal::Failed);
    assert_no_step(&kernel.calls, Step::PollProcess);
    cases_since(cursor)
}

fn held_image_handle() -> usize {
    let cursor = case_cursor();
    assert!(IMAGE_OPEN_CONTRACT.contains("non-reparse"));
    assert!(IMAGE_OPEN_CONTRACT.contains("share-read-only-no-delete"));
    let (success, baseline) = run(Mode::Supervisor, Vec::new());
    assert_eq!(success.terminal, ReducerTerminal::Success);
    assert!(success.handles_released);
    assert_eq!(
        baseline.containment_state,
        ContainmentState::ResumedExactlyOnce
    );
    assert_eq!(baseline.pipe_states, [PipeState::Retired; 3]);
    assert_eq!(baseline.calls[1], Step::FreezeImage(ImageKind::Launcher));
    assert_eq!(baseline.calls[2], Step::FreezeImage(ImageKind::Observer));
    assert_eq!(baseline.calls[29], Step::FinalIdentityAclHashReverify);
    assert_eq!(baseline.calls[31], Step::ReleaseHeldImageHandles);

    let (early_drift, kernel) = run(
        Mode::Supervisor,
        changed(4, KernelReply::Failed("launcher file-id drift")),
    );
    assert_one_override(&kernel);
    assert_eq!(
        kernel.calls.last(),
        Some(&Step::VerifyImage(ImageKind::Launcher))
    );
    assert_eq!(
        early_drift.child_start_evidence,
        ChildStartEvidence::NeverStarted
    );

    let (alias_drift, kernel) = run(
        Mode::Supervisor,
        changed(5, KernelReply::Failed("observer final-path alias")),
    );
    assert_one_override(&kernel);
    assert_eq!(alias_drift.terminal, ReducerTerminal::Failed);

    let (final_drift, kernel) = run(
        Mode::Supervisor,
        changed(30, KernelReply::Failed("final image hash drift")),
    );
    assert_one_override(&kernel);
    assert_eq!(final_drift.terminal, ReducerTerminal::Quarantined);
    assert!(!final_drift.handles_released);
    assert_no_step(&kernel.calls, Step::ReleaseHeldImageHandles);

    let (close_failure, kernel) = run(
        Mode::Supervisor,
        changed(32, KernelReply::Unknown("held handle close ambiguous")),
    );
    assert_one_override(&kernel);
    assert_eq!(close_failure.terminal, ReducerTerminal::Quarantined);
    assert!(!close_failure.handles_released);
    cases_since(cursor)
}
fn token_appcontainer() -> usize {
    let cursor = case_cursor();
    assert_eq!(TOKEN_RIGHTS, 0x008b);
    assert_eq!(RESTRICTED_TOKEN_POLICY.flags, 0);
    assert!(!RESTRICTED_TOKEN_POLICY.delete_every_enumerated_source_privilege);
    assert!(!RESTRICTED_TOKEN_POLICY.require_post_restriction_privilege_count_zero);
    assert!(RESTRICTED_TOKEN_POLICY.preserve_existing_standard_groups_and_enabled_notify);
    assert_eq!(
        REQUIRED_TOKEN_RIGHTS_DESCRIPTION,
        "TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_DEFAULT"
    );
    assert_eq!(APPCONTAINER_PACKAGE_NAME, "DecadansNeurobro.Observer.v1");
    assert_eq!(ALLOCATOR_CONTRACT.len(), 4);
    assert!(
        ALLOCATOR_CONTRACT
            .iter()
            .any(|item| item.contains("FreeSid"))
    );
    assert!(
        ALLOCATOR_CONTRACT
            .iter()
            .any(|item| item.contains("LocalFree"))
    );
    assert!(
        ALLOCATOR_CONTRACT
            .iter()
            .any(|item| item.contains("CoTaskMemFree"))
    );
    assert!(
        ALLOCATOR_CONTRACT
            .iter()
            .any(|item| item.contains("every-entry-Sid-then-array"))
    );
    let entry_sids = [
        1usize as *mut std::ffi::c_void,
        2usize as *mut std::ffi::c_void,
    ];
    let entries_array = 3usize as *mut std::ffi::c_void;
    let mut released = Vec::new();
    assert!(!release_network_isolation_allocations(
        &entry_sids,
        entries_array,
        |allocation| {
            released.push(allocation as usize);
            allocation != entry_sids[0]
        },
    ));
    assert_eq!(released, vec![1, 2, 3]);
    assert!(SURFACE_SECURITY_CONTRACT.contains("protected-non-null-dacl"));
    assert!(SURFACE_SECURITY_CONTRACT.contains("fixed-low-il"));
    assert_eq!(OBSERVER_LEAF_RIGHTS.len(), 9);
    assert!(!OBSERVER_LEAF_RIGHTS.iter().any(|right| matches!(
        *right,
        "DELETE" | "FILE_DELETE_CHILD" | "WRITE_DAC" | "WRITE_OWNER" | "FILE_EXECUTE"
    )));

    let (success, baseline) = run(Mode::Worker, Vec::new());
    assert_eq!(success.terminal, ReducerTerminal::Success);
    assert_eq!(baseline.calls[14], Step::GateSeIncreaseQuota);
    assert_eq!(
        baseline.calls[15],
        Step::CreateRestrictedPrimaryToken {
            rights: TOKEN_RIGHTS,
            policy: RESTRICTED_TOKEN_POLICY,
        }
    );
    assert_eq!(baseline.calls[16], Step::SetLowIntegrity);
    assert_eq!(baseline.calls[17], Step::DeriveRegularAppContainerSid);
    assert_eq!(baseline.calls[18], Step::VerifyAppContainerZeroCapabilities);
    assert_eq!(baseline.calls[19], Step::VerifyLoopbackNonExempt);

    let source = include_str!("../src/main.rs");
    assert!(!source.contains("DISABLE_MAX_PRIVILEGE"));
    assert!(source.contains("RESTRICTED_TOKEN_POLICY.flags,"));
    assert!(source.contains("delete_privileges.len() as u32"));
    assert!(source.contains("verify_observer_token_transform(&baseline, notify, false,"));
    assert!(source.contains("ScopedQuotaPrivilege::acquire()"));
    assert!(source.contains(".restore_verified()"));
    assert!(source.contains("native_ledger_security::create_new_ledger(&path, &record_bytes)"));
    assert!(source.contains("native_ledger_security::query_ledger_security(handle)"));
    let context = make_context(Mode::Worker, canonical_envelope_bytes());
    let store = SharedScriptedLedgerStore::default();
    store.seed_supervisor(&context);
    let mut policy_kernel = ScriptedKernel::with_store(Vec::new(), store);
    assert_eq!(policy_kernel.bind_context(&context), KernelReply::Ok);
    assert!(matches!(
        policy_kernel.invoke(Step::CreateRestrictedPrimaryToken {
            rights: TOKEN_RIGHTS,
            policy: RestrictedTokenPolicy {
                flags: 1,
                ..RESTRICTED_TOKEN_POLICY
            },
        }),
        KernelReply::Refused(_)
    ));

    for (ordinal, reason) in [
        (15, "SeIncreaseQuota absent"),
        (16, "token rights drift"),
        (19, "capability drift"),
        (20, "loopback exempt"),
    ] {
        let (result, kernel) = run(Mode::Worker, changed(ordinal, KernelReply::Refused(reason)));
        assert_one_override(&kernel);
        assert_eq!(
            result.child_start_evidence,
            ChildStartEvidence::NeverStarted
        );
        assert_no_step(
            &kernel.calls,
            Step::CreateSuspendedChild(ChildKind::Observer),
        );
    }

    let (drift, kernel) = run(
        Mode::Worker,
        changed(
            24,
            KernelReply::Failed("token/AppContainer containment drift"),
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(drift.child_start_evidence, ChildStartEvidence::Started);
    assert_eq!(kernel.calls[23], Step::VerifyObserverConfinement);
    assert_eq!(kernel.calls[24], Step::TerminateJobOnce);
    assert_eq!(kernel.calls[25], Step::WaitForStableReap);
    cases_since(cursor)
}

fn job_confinement() -> usize {
    let cursor = case_cursor();
    assert_eq!(OUTER_JOB_LIMITS.active_process_limit, 2);
    assert_eq!(INNER_JOB_LIMITS.active_process_limit, 1);
    assert_eq!(OUTER_JOB_LIMITS.process_memory_bytes, 64 * 1024 * 1024);
    assert_eq!(OUTER_JOB_LIMITS.job_memory_bytes, 128 * 1024 * 1024);
    assert_eq!(OUTER_JOB_LIMITS.cpu_rate_percent, 25);
    assert!(OUTER_JOB_LIMITS.kill_on_close);
    assert!(!OUTER_JOB_LIMITS.breakaway_allowed && !OUTER_JOB_LIMITS.inheritable);
    assert!(!SUPERVISOR_IS_OUTER_JOB_BORN);
    assert!(WORKER_MUST_ALREADY_BE_OUTER_CONTAINED);
    assert!(!OBSERVER_IS_INNER_JOB_BORN);

    let (_, supervisor) = run(Mode::Supervisor, Vec::new());
    assert_eq!(supervisor.calls[10], Step::CreateOuterJob(OUTER_JOB_LIMITS));
    assert_eq!(
        supervisor.calls[14],
        Step::CreateSuspendedChild(ChildKind::Worker)
    );
    assert_eq!(supervisor.calls[13], Step::GateSeIncreaseQuota);
    assert_eq!(supervisor.calls[15], Step::AssignOuterJob);
    assert_eq!(supervisor.calls[18], Step::ResumePrimaryThread);
    let (_, worker) = run(Mode::Worker, Vec::new());
    assert_eq!(worker.calls[11], Step::VerifyAlreadyOuterContained);
    assert_eq!(worker.calls[12], Step::CreateInnerJob(INNER_JOB_LIMITS));
    assert_eq!(
        worker.calls[21],
        Step::CreateSuspendedChild(ChildKind::Observer)
    );
    assert_eq!(worker.calls[22], Step::AssignInnerJob);

    let (create_false, kernel) = run(
        Mode::Supervisor,
        changed(
            15,
            KernelReply::CreateFalseTrustworthy {
                kind: ChildKind::Worker,
                win32_error: 5,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(
        create_false.child_start_evidence,
        ChildStartEvidence::NeverStarted
    );
    assert_eq!(create_false.child_started, "false");
    assert_no_step(&kernel.calls, Step::TerminateProcessOnce);

    let (malformed, kernel) = run(
        Mode::Supervisor,
        changed(
            15,
            KernelReply::CreateTrue {
                process_info_valid: false,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(
        malformed.child_start_evidence,
        ChildStartEvidence::Ambiguous
    );
    assert_eq!(malformed.child_started, "unknown");
    assert_no_step(&kernel.calls, Step::TerminateProcessOnce);
    assert_no_step(&kernel.calls, Step::TerminateJobOnce);
    assert_eq!(kernel.containment_state, ContainmentState::Unstarted);

    let (assign_failure, kernel) = run(
        Mode::Supervisor,
        changed(16, KernelReply::Failed("assign outer failed")),
    );
    assert_one_override(&kernel);
    assert_eq!(
        assign_failure.child_start_evidence,
        ChildStartEvidence::Started
    );
    assert_eq!(kernel.calls[16], Step::TerminateProcessOnce);
    assert_eq!(kernel.calls[17], Step::WaitForStableReap);
    assert_eq!(
        kernel
            .calls
            .iter()
            .filter(|step| **step == Step::TerminateProcessOnce)
            .count(),
        1
    );
    assert_no_step(&kernel.calls, Step::TerminateJobOnce);
    assert_eq!(
        kernel.containment_state,
        ContainmentState::SuspendedUnassigned
    );

    let (_membership_failure, kernel) = run(
        Mode::Supervisor,
        changed(17, KernelReply::Failed("outer membership false")),
    );
    assert_one_override(&kernel);
    assert_eq!(kernel.calls[17], Step::TerminateJobOnce);
    assert_eq!(kernel.calls[18], Step::WaitForStableReap);
    assert_no_step(&kernel.calls, Step::TerminateProcessOnce);
    assert_eq!(
        kernel.containment_state,
        ContainmentState::OuterAssignedPendingVerify
    );

    let (resume_failure, kernel) = run(Mode::Supervisor, changed(19, KernelReply::ResumeCount(2)));
    assert_one_override(&kernel);
    assert_eq!(resume_failure.terminal, ReducerTerminal::Unknown);
    assert_eq!(kernel.calls[19], Step::TerminateJobOnce);

    let (thread_failure, kernel) = run(
        Mode::Supervisor,
        changed(20, KernelReply::ThreadCount(THREAD_SAMPLE_LIMIT + 1)),
    );
    assert_one_override(&kernel);
    assert_eq!(thread_failure.terminal, ReducerTerminal::Failed);
    assert_eq!(kernel.calls[20], Step::TerminateJobOnce);
    cases_since(cursor)
}
fn pipes_handle_inheritance() -> usize {
    let cursor = case_cursor();
    assert_eq!(EXACT_INHERITED_HANDLE_COUNT, 3);
    assert!(PIPE_CONTRACT.contains("overlapped-local"));
    assert!(PIPE_CONTRACT.contains("exact-three-inherited"));
    let inherited = [
        TypedHandleKind::StdinRead,
        TypedHandleKind::StdoutWrite,
        TypedHandleKind::StderrWrite,
    ];
    assert_ne!(inherited[0], inherited[1]);
    assert_ne!(inherited[0], inherited[2]);
    assert_ne!(inherited[1], inherited[2]);

    let (success, baseline) = run(Mode::Supervisor, Vec::new());
    assert_eq!(success.terminal, ReducerTerminal::Success);
    assert_eq!(baseline.calls[12], Step::BeginPinnedOverlappedPipes);
    assert_eq!(baseline.calls[20], Step::StartConcurrentIo);
    assert_eq!(baseline.calls[21], Step::Transfer(StreamKind::Stdin));
    assert_eq!(baseline.calls[22], Step::Transfer(StreamKind::Stdout));
    assert_eq!(baseline.calls[23], Step::Transfer(StreamKind::Stderr));

    let (begin_failure, kernel) = run(
        Mode::Supervisor,
        changed(13, KernelReply::Failed("event alias")),
    );
    assert_one_override(&kernel);
    assert_eq!(begin_failure.terminal, ReducerTerminal::Failed);
    assert_eq!(
        begin_failure.child_start_evidence,
        ChildStartEvidence::NeverStarted
    );
    assert_no_step(&kernel.calls, Step::TerminateJobOnce);
    assert_no_step(&kernel.calls, Step::CreateSuspendedChild(ChildKind::Worker));
    assert_no_step(&kernel.calls, Step::CancelOutstandingIo);

    for (ordinal, stream) in [(23, StreamKind::Stdout), (24, StreamKind::Stderr)] {
        let (eof, kernel) = run(
            Mode::Supervisor,
            changed(
                ordinal,
                KernelReply::BrokenPipe {
                    bytes: 0,
                    canonical_frame: false,
                },
            ),
        );
        assert_one_override(&kernel);
        assert_eq!(eof.terminal, ReducerTerminal::Success, "{stream:?}");
    }

    let (cancel_race, kernel) = run(Mode::Supervisor, changed(23, KernelReply::Cancelled));
    assert_one_override(&kernel);
    assert_eq!(cancel_race.terminal, ReducerTerminal::Failed);
    assert_eq!(kernel.pipe_states, [PipeState::Retired; 3]);
    assert_eq!(kernel.calls[23], Step::TerminateJobOnce);
    assert_eq!(kernel.calls[24], Step::CancelOutstandingIo);
    assert_eq!(kernel.calls[25], Step::RetireIoCompletion);
    assert_eq!(kernel.calls[26], Step::WaitForStableReap);
    assert_no_step(&kernel.calls, Step::PollProcess);

    let (partial_submit, kernel) = run(
        Mode::Supervisor,
        changed(
            21,
            KernelReply::IoSubmitFailed {
                submitted: 1,
                pending_owned: 1,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(partial_submit.terminal, ReducerTerminal::Failed);
    assert_eq!(kernel.calls[20], Step::StartConcurrentIo);
    assert_eq!(kernel.calls[22], Step::CancelOutstandingIo);
    assert_eq!(kernel.calls[23], Step::RetireIoCompletion);
    assert_eq!(kernel.pipe_states, [PipeState::Retired; 3]);

    let overrides = vec![
        ScriptedOverride {
            ordinal: 22,
            reply: KernelReply::DeadlineReached,
        },
        ScriptedOverride {
            ordinal: 24,
            reply: KernelReply::CancelRaceRetained,
        },
    ];
    let (cancel_not_found_race, kernel) = run(Mode::Supervisor, overrides);
    assert_eq!(kernel.matched_override_count(), 2);
    assert_eq!(cancel_not_found_race.terminal, ReducerTerminal::Failed);
    let (prefix, diagnostic) = parse_io_stop_reason(&cancel_not_found_race.reason)
        .expect("accepted cancellation race must retain a valid diagnostic");
    assert_eq!(prefix, "stdin broke before every byte completed");
    assert_eq!(diagnostic.origin, IoStopOrigin::StdinTransfer);
    assert_eq!(diagnostic.cleanup, [IoCleanupOutcome::Ok; 4]);
    assert_eq!(kernel.calls[21], Step::Transfer(StreamKind::Stdin));
    assert_eq!(kernel.calls[23], Step::CancelOutstandingIo);
    assert_eq!(kernel.calls[24], Step::RetireIoCompletion);
    assert_eq!(kernel.pipe_states, [PipeState::Retired; 3]);
    assert_eq!(
        kernel
            .calls
            .iter()
            .filter(|step| **step == Step::CancelOutstandingIo)
            .count(),
        1
    );
    assert_eq!(
        kernel
            .calls
            .iter()
            .filter(|step| **step == Step::RetireIoCompletion)
            .count(),
        1
    );

    let overrides = vec![
        ScriptedOverride {
            ordinal: 22,
            reply: KernelReply::DeadlineReached,
        },
        ScriptedOverride {
            ordinal: 25,
            reply: KernelReply::Unknown("completion still pending"),
        },
    ];
    let (unretired, kernel) = run(Mode::Supervisor, overrides);
    assert_eq!(kernel.matched_override_count(), 2);
    assert_eq!(unretired.terminal, ReducerTerminal::Quarantined);
    assert_eq!(kernel.pipe_states, [PipeState::CancelPending; 3]);
    assert!(!unretired.handles_released);
    cases_since(cursor)
}

fn durable_ledger() -> usize {
    let cursor = case_cursor();
    assert!(LEDGER_DURABILITY_CLAIM.contains("write-through"));
    assert!(LEDGER_DURABILITY_CLAIM.contains("same-handle-readback"));
    assert!(LEDGER_DURABILITY_CLAIM.contains("not-power-loss-atomic"));
    let (_, baseline) = run(Mode::Supervisor, Vec::new());
    assert_eq!(baseline.calls[7], Step::CreateDurableLedger);
    assert_eq!(baseline.calls[8], Step::FlushLedgerReadback);
    assert_eq!(baseline.calls[9], Step::ReopenLedgerVerify);
    assert_eq!(
        baseline.calls[14],
        Step::CreateSuspendedChild(ChildKind::Worker)
    );

    let (collision, kernel) = run(Mode::Supervisor, changed(8, KernelReply::LedgerCollision));
    assert_one_override(&kernel);
    assert_eq!(collision.terminal, ReducerTerminal::Refused);
    assert_eq!(collision.ledger_state, "sticky-collision");
    assert!(collision.sticky);
    assert_eq!(
        collision.child_start_evidence,
        ChildStartEvidence::NeverStarted
    );
    assert_eq!(kernel.calls.last(), Some(&Step::CreateDurableLedger));

    for (ordinal, reply) in [
        (8, KernelReply::Unknown("last-error ambiguous")),
        (9, KernelReply::Failed("flush ambiguous")),
        (10, KernelReply::Unknown("reopen ambiguous")),
    ] {
        let (result, kernel) = run(Mode::Supervisor, changed(ordinal, reply));
        assert_one_override(&kernel);
        assert_eq!(result.terminal, ReducerTerminal::Unknown);
        assert_eq!(result.ledger_state, "sticky-unknown");
        assert!(result.sticky);
        assert_eq!(result.child_started, "false");
        assert_no_step(&kernel.calls, Step::CreateSuspendedChild(ChildKind::Worker));
    }

    let supervisor_context = make_context(Mode::Supervisor, canonical_envelope_bytes());
    let store = SharedScriptedLedgerStore::default();
    let mut supervisor_kernel = ScriptedKernel::with_store(Vec::new(), store.clone());
    EXECUTED_REDUCER_CASES.fetch_add(1, Ordering::Relaxed);
    let supervisor_result = run_reducer(&supervisor_context, &mut supervisor_kernel);
    assert_eq!(supervisor_result.terminal, ReducerTerminal::Success);
    let worker_context = parse_production_input(
        Mode::Worker,
        &supervisor_context.supervisor_handoff_bytes().unwrap(),
    )
    .unwrap();
    let mut worker_kernel = ScriptedKernel::with_store(Vec::new(), store.clone());
    EXECUTED_REDUCER_CASES.fetch_add(1, Ordering::Relaxed);
    let worker_result = run_reducer(&worker_context, &mut worker_kernel);
    assert_eq!(worker_result.terminal, ReducerTerminal::Success);
    assert_eq!(
        worker_context.canonical_request_bytes,
        canonical_observer_payload_bytes()
    );
    let order = store.create_order();
    assert_eq!(order.len(), 2);
    assert_eq!(
        order[0],
        supervisor_context.supervisor_ledger_identity_sha256
    );
    assert_eq!(order[1], worker_context.worker_ledger_identity_sha256);
    assert_ne!(order[0], order[1]);
    assert_eq!(worker_kernel.calls[7], Step::VerifySupervisorLedgerProof);

    let mut replay_kernel = ScriptedKernel::with_store(Vec::new(), store.clone());
    EXECUTED_REDUCER_CASES.fetch_add(1, Ordering::Relaxed);
    let replay = run_reducer(&supervisor_context, &mut replay_kernel);
    assert_eq!(replay.terminal, ReducerTerminal::Refused);
    assert_eq!(replay.ledger_state, "sticky-collision");
    assert_eq!(store.create_order(), order);
    assert_eq!(replay_kernel.calls.last(), Some(&Step::CreateDurableLedger));
    cases_since(cursor)
}
fn bounded_io() -> usize {
    let cursor = case_cursor();
    let observer_stdout = br#"{"status":"ok"}
{"acknowledged":true}"#
        .to_vec();
    assert!(validate_observer_stdout_framing(&observer_stdout));
    let worker_overrides = vec![
        ScriptedOverride {
            ordinal: 32,
            reply: KernelReply::EofBytes(observer_stdout.clone()),
        },
        ScriptedOverride {
            ordinal: 34,
            reply: KernelReply::ExitCode(7),
        },
    ];
    let (worker_result, worker_kernel) = run_closed(Mode::Worker, worker_overrides);
    assert_eq!(worker_kernel.matched_override_count(), 2);
    assert_eq!(worker_result.terminal, ReducerTerminal::Success);
    assert_eq!(
        validate_wire_evidence(&worker_result.evidence).unwrap().0,
        observer_stdout
    );
    assert_eq!(
        worker_result.evidence.exit_state,
        EvidenceExitState::Known { code: 7 }
    );
    assert_eq!(
        worker_result.evidence.stderr_state,
        EvidenceStderrState::EofZeroBytes
    );
    for malformed_stdout in [
        br#"{"status":"ok"}

{"acknowledged":true}"#
            .to_vec(),
        br#"{"status": "not-canonical"}"#.to_vec(),
        br#"{"status":"truncated""#.to_vec(),
    ] {
        assert!(!validate_observer_stdout_framing(&malformed_stdout));
        let (rejected, kernel) = run_closed(
            Mode::Worker,
            changed(32, KernelReply::EofBytes(malformed_stdout)),
        );
        assert_one_override(&kernel);
        assert_eq!(rejected.terminal, ReducerTerminal::Failed);
        assert_no_step(&kernel.calls, Step::PollProcess);
        assert_no_step(&kernel.calls, Step::ReleaseHeldImageHandles);
    }
    let (capped, capped_kernel) = run_closed(
        Mode::Worker,
        changed(
            32,
            KernelReply::Eof {
                bytes: MAX_STDOUT_BYTES + 1,
                canonical_frame: true,
            },
        ),
    );
    assert_one_override(&capped_kernel);
    assert_eq!(capped.terminal, ReducerTerminal::Failed);
    assert_eq!(capped.evidence.kind, InvocationEvidenceKind::ChildStarted);
    assert_eq!(
        capped.evidence.stdout_state,
        EvidenceStdoutState::CapExceededOrTruncated
    );
    assert_eq!(
        validate_wire_evidence(&capped.evidence).unwrap().0.len(),
        MAX_STDOUT_BYTES
    );
    assert_no_step(&capped_kernel.calls, Step::PollProcess);
    assert_no_step(&capped_kernel.calls, Step::ReleaseHeldImageHandles);

    let worker_wire = serde_json::to_vec(&worker_result).unwrap();
    assert_eq!(
        parse_canonical_launcher_result(&worker_wire).unwrap(),
        worker_result
    );
    let supervisor_context = make_context(Mode::Supervisor, canonical_envelope_bytes());
    let (promoted, supervisor_kernel) = run_closed_context(
        supervisor_context,
        changed(23, KernelReply::EofBytes(worker_wire.clone())),
    );
    assert_one_override(&supervisor_kernel);
    assert_eq!(promoted.terminal, ReducerTerminal::Success);
    assert_eq!(promoted.evidence, worker_result.evidence);
    assert_eq!(
        validate_wire_evidence(&promoted.evidence).unwrap().0,
        observer_stdout
    );
    assert_ne!(
        STANDARD.encode(&worker_wire),
        promoted.evidence.captured_stdout_base64
    );
    assert!(
        !serde_json::to_vec(&promoted)
            .unwrap()
            .windows("evidenceRootAbsolutePath".len())
            .any(|window| window == b"evidenceRootAbsolutePath")
    );
    println!(
        "canonical-outer-success-base64={}",
        STANDARD.encode(serde_json::to_vec(&promoted).unwrap())
    );

    let mut hostile_worker_wires = vec![
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]["extra"] = serde_json::json!(true);
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]
                .as_object_mut()
                .unwrap()
                .remove("stdoutState");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]["capturedStdoutBase64"] = serde_json::json!("!!!!");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]["capturedStdoutBase64"] = serde_json::json!("Zh==");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]["capturedStdoutBase64"] =
                serde_json::json!(STANDARD.encode(vec![0_u8; MAX_STDOUT_BYTES + 1]));
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]["kind"] = serde_json::json!("child-never-started");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]["stdoutState"] = serde_json::json!("not-eof-or-unknown");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]["exitState"] = serde_json::json!({"kind":"not-started"});
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["requestId"] = serde_json::json!("wrong-request");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["correlationId"] = serde_json::json!("wrong-correlation");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["carrierSha256"] = serde_json::json!("c".repeat(64));
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["observerImageSha256"] = serde_json::json!("c".repeat(64));
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["stdinSha256"] = serde_json::json!("c".repeat(64));
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["deadlineMs"] = serde_json::json!(10_001);
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["ledgerIdentitySha256"] = serde_json::json!("d".repeat(64));
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["childStarted"] = serde_json::json!("false");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["terminal"] = serde_json::json!("quarantined");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["terminal"] = serde_json::json!("failed");
            value["reason"] = serde_json::json!("started worker must not carry failure");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["reason"] = serde_json::json!("ambiguous reap or final identity/evidence state");
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["ledgerState"] = serde_json::json!("sticky-unknown");
            value["sticky"] = serde_json::json!(true);
            value["handlesReleased"] = serde_json::json!(false);
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["handlesReleased"] = serde_json::json!(false);
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidence"]["evidenceRootAbsolutePath"] =
                serde_json::json!(ACCEPTED_EVIDENCE_ROOT);
        }),
        mutate_launcher_result_wire(&worker_wire, |value| {
            value["evidenceRootAbsolutePath"] = serde_json::json!(ACCEPTED_EVIDENCE_ROOT);
        }),
        worker_wire[..worker_wire.len() - 1].to_vec(),
    ];
    let duplicate_kind = String::from_utf8(worker_wire.clone()).unwrap().replacen(
        "\"kind\":\"child-started\"",
        "\"kind\":\"child-started\",\"kind\":\"child-started\"",
        1,
    );
    hostile_worker_wires.push(duplicate_kind.into_bytes());
    for hostile in hostile_worker_wires {
        let (rejected, kernel) = run_closed_context(
            make_context(Mode::Supervisor, canonical_envelope_bytes()),
            changed(23, KernelReply::EofBytes(hostile)),
        );
        assert_one_override(&kernel);
        assert_eq!(rejected.terminal, ReducerTerminal::Quarantined);
        assert_eq!(
            rejected.evidence,
            conservative_wire_evidence(ChildStartEvidence::Ambiguous)
        );
        assert_no_step(&kernel.calls, Step::PollProcess);
        assert_no_step(&kernel.calls, Step::FinalIdentityAclHashReverify);
        assert_no_step(&kernel.calls, Step::ReleaseHeldImageHandles);
    }

    let (never_started, never_kernel) = run_closed(
        Mode::Worker,
        changed(
            22,
            KernelReply::CreateFalseTrustworthy {
                kind: ChildKind::Observer,
                win32_error: 203,
            },
        ),
    );
    assert_one_override(&never_kernel);
    assert_eq!(
        never_started.evidence,
        conservative_wire_evidence(ChildStartEvidence::NeverStarted)
    );
    let (ambiguous, ambiguous_kernel) = run_closed(
        Mode::Worker,
        changed(
            22,
            KernelReply::CreateTrue {
                process_info_valid: false,
            },
        ),
    );
    assert_one_override(&ambiguous_kernel);
    assert_eq!(
        ambiguous.evidence,
        conservative_wire_evidence(ChildStartEvidence::Ambiguous)
    );
    let failed_worker_wire = serde_json::to_vec(&never_started).unwrap();
    let unknown_worker_wire = serde_json::to_vec(&ambiguous).unwrap();
    for (label, worker_terminal) in [("failed", &never_started), ("unknown", &ambiguous)] {
        let wire = serde_json::to_vec(&worker_terminal).unwrap();
        println!("canonical-worker-{label}-base64={}", STANDARD.encode(&wire));
        let (outer, kernel) = run_closed_context(
            make_context(Mode::Supervisor, canonical_envelope_bytes()),
            changed(23, KernelReply::EofBytes(wire)),
        );
        assert_one_override(&kernel);
        assert_eq!(outer.terminal, worker_terminal.terminal);
        assert_eq!(outer.reason, worker_terminal.reason);
        assert_eq!(outer.evidence, worker_terminal.evidence);
        assert_eq!(outer.child_start_evidence, ChildStartEvidence::Started);
        assert!(outer.handles_released);
        assert!(!worker_terminal.handles_released);
        println!(
            "canonical-outer-{label}-base64={}",
            STANDARD.encode(serde_json::to_vec(&outer).unwrap())
        );
    }

    let inner_reason = never_started.reason.clone();
    let precedence_cases = [
        (
            "poll-unknown",
            25,
            KernelReply::Unknown("hostile process wait"),
            ReducerTerminal::Unknown,
            "process exit was ambiguous",
        ),
        (
            "poll-deadline",
            25,
            KernelReply::DeadlineReached,
            ReducerTerminal::Deadline,
            "process did not exit before deadline",
        ),
        (
            "final-reap",
            29,
            KernelReply::Unknown("hostile final reap"),
            ReducerTerminal::Quarantined,
            "ambiguous reap or final identity/evidence state",
        ),
        (
            "final-reverify",
            30,
            KernelReply::Failed("hostile final reverify"),
            ReducerTerminal::Quarantined,
            "ambiguous reap or final identity/evidence state",
        ),
        (
            "final-release",
            32,
            KernelReply::Unknown("hostile release"),
            ReducerTerminal::Quarantined,
            "ambiguous reap or final identity/evidence state",
        ),
        (
            "privilege-restore",
            32,
            KernelReply::Unknown("launcher quota restoration was not verified"),
            ReducerTerminal::Quarantined,
            "ambiguous reap or final identity/evidence state",
        ),
    ];
    for (label, ordinal, reply, terminal, reason) in precedence_cases {
        let overrides = vec![
            ScriptedOverride {
                ordinal: 23,
                reply: KernelReply::EofBytes(failed_worker_wire.clone()),
            },
            ScriptedOverride { ordinal, reply },
        ];
        let (outer, kernel) = run_closed_context(
            make_context(Mode::Supervisor, canonical_envelope_bytes()),
            overrides,
        );
        assert_override_count(&kernel, 2);
        assert_eq!(outer.terminal, terminal, "{label}");
        assert_eq!(parse_io_stop_reason(&outer.reason).map(|(prefix, _)| prefix)
            .unwrap_or(&outer.reason), reason, "{label}");
        assert_ne!(outer.reason, inner_reason, "{label}");
    }

    let deadline_cleanup_overrides = vec![
        ScriptedOverride {
            ordinal: 23,
            reply: KernelReply::EofBytes(failed_worker_wire.clone()),
        },
        ScriptedOverride {
            ordinal: 25,
            reply: KernelReply::DeadlineReached,
        },
        ScriptedOverride {
            ordinal: 29,
            reply: KernelReply::Unknown("hostile cleanup reap"),
        },
    ];
    let (deadline_cleanup, deadline_cleanup_kernel) = run_closed_context(
        make_context(Mode::Supervisor, canonical_envelope_bytes()),
        deadline_cleanup_overrides,
    );
    assert_override_count(&deadline_cleanup_kernel, 3);
    assert_eq!(deadline_cleanup.terminal, ReducerTerminal::Quarantined);
    assert_eq!(parse_io_stop_reason(&deadline_cleanup.reason).unwrap().0,
        "terminal I/O cleanup or reap is ambiguous");
    assert_ne!(deadline_cleanup.reason, inner_reason);

    EXECUTED_REDUCER_CASES.fetch_add(1, Ordering::Relaxed);
    let snapshot_store = SharedScriptedLedgerStore::default();
    let mut snapshot_kernel = SnapshotFailKernel {
        inner: ScriptedKernel::with_store(
            changed(23, KernelReply::EofBytes(failed_worker_wire.clone())),
            snapshot_store,
        ),
    };
    let snapshot_context = make_context(Mode::Supervisor, canonical_envelope_bytes());
    let snapshot_failure = run_and_close(&snapshot_context, &mut snapshot_kernel);
    assert_one_override(&snapshot_kernel.inner);
    assert_eq!(snapshot_failure.terminal, ReducerTerminal::Quarantined);
    assert!(snapshot_failure.reason.starts_with("invocation evidence snapshot or promotion failed;"));
    assert!(snapshot_failure.reason.contains("snapshot=snapshot-refused"));
    assert!(!snapshot_failure.reason.contains("hostile snapshot failure"));
    assert_ne!(snapshot_failure.reason, inner_reason);

    let malformed_marker = "malformed inner reason must not surface";
    let malformed_worker = mutate_launcher_result_wire(&unknown_worker_wire, |value| {
        value["reason"] = serde_json::json!(format!("{malformed_marker}{}", "x".repeat(1_025)));
    });
    let (malformed_outer, malformed_kernel) = run_closed_context(
        make_context(Mode::Supervisor, canonical_envelope_bytes()),
        changed(23, KernelReply::EofBytes(malformed_worker)),
    );
    assert_one_override(&malformed_kernel);
    assert_eq!(malformed_outer.terminal, ReducerTerminal::Quarantined);
    assert!(malformed_outer.reason.contains("reducer=stdout-transfer"));
    assert!(malformed_outer.reason.contains("promotion=malformed-frame"));
    assert_ne!(malformed_outer.reason, malformed_marker);

    let (at_cap, kernel) = run(
        Mode::Supervisor,
        changed(
            23,
            KernelReply::Eof {
                bytes: MAX_WORKER_RESULT_BYTES,
                canonical_frame: true,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(at_cap.terminal, ReducerTerminal::Success);

    let (over_cap, kernel) = run(
        Mode::Supervisor,
        changed(
            23,
            KernelReply::Eof {
                bytes: MAX_WORKER_RESULT_BYTES + 1,
                canonical_frame: true,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(over_cap.terminal, ReducerTerminal::Failed);
    assert_eq!(kernel.calls[23], Step::TerminateJobOnce);

    let (stderr, kernel) = run(
        Mode::Supervisor,
        changed(
            24,
            KernelReply::Eof {
                bytes: 1,
                canonical_frame: true,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(stderr.terminal, ReducerTerminal::Failed);

    let (stdin_broken, kernel) = run(
        Mode::Supervisor,
        changed(
            22,
            KernelReply::BrokenPipe {
                bytes: 0,
                canonical_frame: false,
            },
        ),
    );
    assert_one_override(&kernel);
    assert!(stdin_broken.sticky);
    assert_eq!(stdin_broken.terminal, ReducerTerminal::Failed);

    let (stdin_after_all, kernel) = run(
        Mode::Supervisor,
        changed(
            22,
            KernelReply::BrokenPipe {
                bytes: make_context(Mode::Supervisor, canonical_envelope_bytes())
                    .canonical_request_bytes
                    .len(),
                canonical_frame: false,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(stdin_after_all.terminal, ReducerTerminal::Success);

    let (framing, kernel) = run(
        Mode::Supervisor,
        changed(
            23,
            KernelReply::Eof {
                bytes: 1,
                canonical_frame: false,
            },
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(framing.terminal, ReducerTerminal::Failed);

    let (read_error, kernel) = run(
        Mode::Supervisor,
        changed(23, KernelReply::Failed("overlapped read error")),
    );
    assert_one_override(&kernel);
    assert_eq!(read_error.terminal, ReducerTerminal::Failed);
    assert_no_step(&kernel.calls, Step::PollProcess);
    cases_since(cursor)
}

fn deadline_drain_exit() -> usize {
    let cursor = case_cursor();
    assert_eq!(drain_cutoff(1_000, 10_000), 6_000);
    assert_eq!(drain_cutoff(9_000, 10_000), 14_000);
    assert!(deadline_wins_tie(10_000, 10_000));
    assert!(!deadline_wins_tie(9_999, 10_000));

    let (deadline, kernel) = run(Mode::Supervisor, changed(27, KernelReply::DeadlineReached));
    assert_one_override(&kernel);
    assert_eq!(deadline.terminal, ReducerTerminal::Deadline);
    assert_eq!(kernel.calls[27], Step::TerminateJobOnce);
    assert_eq!(kernel.calls[28], Step::CancelOutstandingIo);
    assert_eq!(kernel.calls[29], Step::RetireIoCompletion);
    assert_eq!(kernel.calls[30], Step::WaitForStableReap);
    assert_no_step(&kernel.calls, Step::FinalIdentityAclHashReverify);

    for reply in [KernelReply::StillActive, KernelReply::ExitCode(259)] {
        let (active, kernel) = run(Mode::Supervisor, changed(25, reply));
        assert_one_override(&kernel);
        assert_eq!(active.terminal, ReducerTerminal::Failed);
        assert_no_step(&kernel.calls, Step::VerifySignaledProcess);
    }

    let (process_deadline, kernel) =
        run(Mode::Supervisor, changed(25, KernelReply::DeadlineReached));
    assert_one_override(&kernel);
    assert_eq!(process_deadline.terminal, ReducerTerminal::Deadline);
    assert_eq!(
        parse_io_stop_reason(&process_deadline.reason).unwrap().0,
        "process did not exit before deadline"
    );
    assert_eq!(kernel.calls[25], Step::TerminateJobOnce);
    assert_eq!(kernel.calls[26], Step::CancelOutstandingIo);
    assert_eq!(kernel.calls[27], Step::RetireIoCompletion);
    assert_eq!(kernel.calls[28], Step::WaitForStableReap);
    assert_no_step(&kernel.calls, Step::VerifySignaledProcess);

    let (mismatch, kernel) = run(
        Mode::Supervisor,
        changed(26, KernelReply::Failed("wrong signaled process")),
    );
    assert_one_override(&kernel);
    assert_eq!(mismatch.terminal, ReducerTerminal::Unknown);
    assert_no_step(&kernel.calls, Step::RecheckDeadline);

    let (nonzero_exit, kernel) = run(Mode::Supervisor, changed(25, KernelReply::ExitCode(7)));
    assert_one_override(&kernel);
    assert_eq!(nonzero_exit.terminal, ReducerTerminal::Success);

    let (reap_ambiguous, kernel) = run(
        Mode::Supervisor,
        changed(29, KernelReply::Unknown("reap alias")),
    );
    assert_one_override(&kernel);
    assert_eq!(reap_ambiguous.terminal, ReducerTerminal::Quarantined);
    assert!(!reap_ambiguous.handles_released);
    assert_no_step(&kernel.calls, Step::FinalIdentityAclHashReverify);
    assert_no_step(&kernel.calls, Step::ReleaseHeldImageHandles);

    let (success, baseline) = run(Mode::Supervisor, Vec::new());
    assert_eq!(success.terminal, ReducerTerminal::Success);
    assert_eq!(baseline.calls[24], Step::PollProcess);
    assert_eq!(baseline.calls[25], Step::VerifySignaledProcess);
    assert_eq!(baseline.calls[26], Step::RecheckDeadline);
    assert_eq!(baseline.calls[27], Step::RetireIoCompletion);
    assert_eq!(baseline.calls[28], Step::WaitForStableReap);
    assert_eq!(baseline.calls[29], Step::FinalIdentityAclHashReverify);
    assert_eq!(baseline.calls[30], Step::ReopenDurableEvidence);
    assert_eq!(baseline.calls[31], Step::ReleaseHeldImageHandles);
    // Connected terminal seam: failed explicit privilege restoration returned
    // from final release must never turn into a successful invocation.
    let (restore_unknown, kernel) = run(
        Mode::Supervisor,
        changed(
            32,
            KernelReply::Unknown("launcher quota restoration was not verified"),
        ),
    );
    assert_one_override(&kernel);
    assert_eq!(kernel.calls.last(), Some(&Step::ReleaseHeldImageHandles));
    assert_eq!(restore_unknown.terminal, ReducerTerminal::Quarantined);
    assert_eq!(restore_unknown.ledger_state, "sticky-unknown");
    assert!(restore_unknown.sticky);
    cases_since(cursor)
}

fn native_create_error_observability() -> usize {
    let cursor = EXECUTED_REDUCER_CASES.load(Ordering::Relaxed);
    for (mode, role, step, label) in [
        (Mode::Supervisor, ChildKind::Worker, 15, "worker"),
        (Mode::Worker, ChildKind::Observer, 22, "observer"),
    ] {
        for code in [203, 5, 0, u32::MAX] {
            let (result, kernel) = run_closed(
                mode,
                changed(
                    step,
                    KernelReply::CreateFalseTrustworthy {
                        kind: role,
                        win32_error: code,
                    },
                ),
            );
            assert_one_override(&kernel);
            let suffix = if code == 0 { "; cause-unavailable" } else { "" };
            assert_eq!(
                result.reason,
                format!("CreateProcessAsUserW FALSE; role={label}; win32-error={code}{suffix}")
            );
            assert!(result.reason.len() < 128);
            assert_eq!(result.terminal, ReducerTerminal::Failed);
            assert_eq!(
                result.child_start_evidence,
                ChildStartEvidence::NeverStarted
            );
            assert_eq!(result.invocation_attempt_count, 1);
            assert_no_step(&kernel.calls, Step::ResumePrimaryThread);
            assert_eq!(
                kernel
                    .calls
                    .iter()
                    .filter(|s| **s == Step::CreateSuspendedChild(role))
                    .count(),
                1
            );
            if role == ChildKind::Observer {
                let wire = serde_json::to_vec(&result).unwrap();
                let (outer, kernel) =
                    run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(wire)));
                assert_one_override(&kernel);
                assert_eq!(outer.reason, result.reason);
                assert_eq!(outer.terminal, result.terminal);
                assert!(outer.handles_released);
            }
        }
        let wrong_role = if role == ChildKind::Worker {
            ChildKind::Observer
        } else {
            ChildKind::Worker
        };
        let (result, kernel) = run_closed(
            mode,
            changed(
                step,
                KernelReply::CreateFalseTrustworthy {
                    kind: wrong_role,
                    win32_error: 203,
                },
            ),
        );
        assert_one_override(&kernel);
        assert_eq!(result.terminal, ReducerTerminal::Unknown);
        assert_eq!(result.child_start_evidence, ChildStartEvidence::Ambiguous);
        assert_eq!(result.ledger_state, "sticky-unknown");
        assert!(!result.reason.contains("203"));
        assert_no_step(&kernel.calls, Step::ResumePrimaryThread);
    }
    cases_since(cursor)
}

fn native_snapshot_promotion_diagnostics() -> usize {
    fn mutate_canonical(bytes: &[u8], mutate: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let changed = mutate_launcher_result_wire(bytes, mutate);
        let typed: LauncherResult = serde_json::from_slice(&changed).unwrap();
        serde_json::to_vec(&typed).unwrap()
    }
    let cursor = case_cursor();
    let supervisor = make_context(Mode::Supervisor, canonical_envelope_bytes());
    // Real reducer output, not a hand-authored failure tuple: observer creation
    // succeeded, then confinement failed. Strict promotion must still reject it.
    let (worker, worker_kernel) = run_closed(
        Mode::Worker,
        changed(24, KernelReply::Failed("C:\\private\\profile SECRET=value")),
    );
    assert_one_override(&worker_kernel);
    assert_eq!(worker_kernel.calls[23], Step::VerifyObserverConfinement);
    assert_eq!(worker.terminal, ReducerTerminal::Failed);
    assert_eq!(worker.child_start_evidence, ChildStartEvidence::Started);
    assert_no_step(&worker_kernel.calls, Step::ResumePrimaryThread);
    let wire = serde_json::to_vec(&worker).unwrap();
    assert!(parse_canonical_launcher_result(&wire).is_ok());
    assert!(promote_worker_evidence(&supervisor, &wire).is_err());
    let (outer, kernel) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(wire.clone())));
    assert_one_override(&kernel);
    assert_eq!(outer.terminal, ReducerTerminal::Quarantined);
    assert!(outer.reason.contains("reducer=stdout-transfer"));
    assert!(outer.reason.contains("snapshot=missing-worker-promotion"));
    assert!(outer.reason.contains("promotion=terminal-tuple-rejected"));
    assert!(outer.reason.contains("bound-worker=observer-token-job-confinement"));
    assert_eq!(outer.evidence.kind, InvocationEvidenceKind::ChildStartAmbiguous);
    assert!(!outer.handles_released);
    assert_no_step(&kernel.calls, Step::PollProcess);
    assert_no_step(&kernel.calls, Step::ReleaseHeldImageHandles);

    for (ordinal, category) in [
        (25, "observer-outer-membership"),
        (26, "observer-image-reverify"),
        (27, "observer-surface-reverify"),
    ] {
        let (worker, kernel) = run_closed(Mode::Worker, changed(ordinal, KernelReply::Failed("private")));
        assert_one_override(&kernel);
        assert_eq!(worker.terminal, ReducerTerminal::Failed);
        let wire = serde_json::to_vec(&worker).unwrap();
        assert!(promote_worker_evidence(&supervisor, &wire).is_err());
        let (outer, kernel) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(wire)));
        assert_one_override(&kernel);
        assert_eq!(outer.terminal, ReducerTerminal::Quarantined);
        assert!(outer.reason.contains(&format!("bound-worker={category}")));
    }
    let (early, kernel) = run_closed(Mode::Supervisor, changed(18, KernelReply::Failed("private")));
    assert_one_override(&kernel);
    assert_eq!(kernel.calls[17], Step::VerifyImage(ImageKind::Launcher));
    assert_eq!(early.terminal, ReducerTerminal::Quarantined);
    assert!(early.reason.contains("reducer=worker-image-reverify"));
    assert!(early.reason.contains("promotion=eof-not-observed"));
    assert_no_step(&kernel.calls, Step::Transfer(StreamKind::Stdout));

    for (reply, category) in [
        (KernelReply::DeadlineReached, "eof-not-observed"),
        (KernelReply::EofBytes(b"{private-invalid".to_vec()), "malformed-frame"),
        (KernelReply::EofBytes(mutate_canonical(&wire, |v| {
            v["correlationId"] = serde_json::json!("private-correlation");
        })), "correlation-mismatch"),
        (KernelReply::EofBytes(mutate_canonical(&wire, |v| {
            v["childStarted"] = serde_json::json!("unknown");
        })), "structural-tuple-rejected"),
    ] {
        let (result, kernel) = run_closed(Mode::Supervisor, changed(23, reply));
        assert_one_override(&kernel);
        assert_eq!(result.terminal, ReducerTerminal::Quarantined);
        assert!(result.reason.contains(&format!("promotion={category}")));
        assert!(result.reason.contains("bound-worker=unavailable"));
        assert!(!result.reason.contains("private"));
        assert!(result.reason.len() < 512);
    }
    for hostile in ["C:\\private\\profile SECRET=value".to_owned(),
        "observer confinement verification failed; SECRET=value".to_owned(),
        "x".repeat(1_025)] {
        let hostile_wire = mutate_canonical(&wire, |v| {
            v["reason"] = serde_json::json!(hostile);
        });
        assert!(promote_worker_evidence(&supervisor, &hostile_wire).is_err());
        let (result, kernel) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(hostile_wire)));
        assert_one_override(&kernel);
        assert_eq!(result.terminal, ReducerTerminal::Quarantined);
        assert!(result.reason.contains("bound-worker=redacted"));
        assert!(!result.reason.contains("SECRET"));
        assert!(!result.reason.contains("private"));
        assert!(result.reason.len() < 512);
    }
    // Cleanup precedence is retained even when a useful worker category exists.
    let (cleanup, kernel) = run_closed(Mode::Supervisor, vec![
        ScriptedOverride { ordinal: 23, reply: KernelReply::EofBytes(wire) },
        ScriptedOverride { ordinal: 24, reply: KernelReply::Unknown("private cleanup") },
    ]);
    assert_override_count(&kernel, 2);
    assert_eq!(cleanup.terminal, ReducerTerminal::Quarantined);
    assert!(cleanup.reason.contains("reducer=io-cleanup"));
    assert!(cleanup.reason.contains("bound-worker=observer-token-job-confinement"));
    assert!(!cleanup.reason.contains("private"));

    // Successful canonical producer and promotion retain the identical wire and
    // reason. Diagnostics do not become a second acceptance route.
    let (success_worker, _) = run_closed(Mode::Worker, Vec::new());
    assert_eq!(success_worker.terminal, ReducerTerminal::Success);
    let success_wire = serde_json::to_vec(&success_worker).unwrap();
    assert_eq!(serde_json::to_vec(&parse_canonical_launcher_result(&success_wire).unwrap()).unwrap(), success_wire);
    assert_eq!(promote_worker_evidence(&supervisor, &success_wire).unwrap(), success_worker.evidence);
    let (success, kernel) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(success_wire)));
    assert_one_override(&kernel);
    assert_eq!(success.terminal, ReducerTerminal::Success);
    assert_eq!(success.reason, "bounded fixed launcher invocation succeeded");
    assert_eq!(success.evidence, success_worker.evidence);
    assert_eq!(kernel.worker_promotion_diagnostic(), WorkerPromotionDiagnostic::Validated);
    cases_since(cursor)
}

fn native_appcontainer_access_baseline() -> usize {
    let row = |allowed| AppContainerAccessRow {
        api_succeeded: true, requested_mask: 1, access_status: allowed,
        granted_mask: if allowed { 1 } else { 0 }, privilege_storage: vec![0; 8],
        returned_privilege_bytes: 8, immediate_error: if allowed { 0 } else { 5 },
    };
    let valid = [row(false), row(true), row(true)];
    let mut count = 0;
    // The measured token has no physical AAP group. Physical group membership
    // is deliberately not an acceptance input: this shared production seam
    // accepts its effective matrix and requires both confinement controls.
    assert!(verify_appcontainer_access_baseline(|| Ok(valid.clone())).is_ok());
    count += 1;
    assert!(verify_appcontainer_access_baseline(|| Err("fixture acquisition failed")).is_err());
    count += 1;
    for index in 0..3 {
        let mut changed = valid.clone();
        changed[index] = row(index == 0);
        assert!(verify_appcontainer_access_baseline(|| Ok(changed)).is_err());
        count += 1;
        for mutation in 0..9 {
            let mut changed = valid.clone();
            let target = &mut changed[index];
            match mutation {
                0 => { target.api_succeeded = false; target.immediate_error = 6; },
                1 => target.requested_mask = 2,
                2 => target.granted_mask = 3,
                3 => { target.privilege_storage = vec![0; 20]; target.privilege_storage[0] = 1;
                    target.returned_privilege_bytes = 20; },
                4 => target.returned_privilege_bytes = 7,
                5 => target.returned_privilege_bytes = 9,
                6 => target.privilege_storage[..4].copy_from_slice(&u32::MAX.to_ne_bytes()),
                7 => target.privilege_storage.clear(),
                8 => target.returned_privilege_bytes = usize::MAX,
                _ => unreachable!(),
            }
            assert!(verify_appcontainer_access_baseline(|| Ok(changed)).is_err());
            count += 1;
        }
    }
    count
}

fn native_io_stop_retirement() -> usize {
    let mut count = 0;
    for state in [NativeOperationState::Prepared, NativeOperationState::Pending,
        NativeOperationState::Immediate(8), NativeOperationState::Terminal(8),
        NativeOperationState::TerminalError(232), NativeOperationState::TerminalError(6),
        NativeOperationState::CancelRequested, NativeOperationState::Retired] {
        assert!(!initial_write_no_data_retirement(state));
        count += 1;
    }
    assert!(initial_write_no_data_retirement(NativeOperationState::InitialWriteNoData));
    count += 1;

    struct ObservedKernel { inner: ScriptedKernel, code: u32 }
    impl LauncherKernel for ObservedKernel {
        fn bind_context(&mut self, c: &ProductionInvocationContext) -> KernelReply { self.inner.bind_context(c) }
        fn invoke(&mut self, step: Step) -> KernelReply { self.inner.invoke(step) }
        fn snapshot_evidence(&mut self, c: &ProductionInvocationContext, child: ChildStartEvidence)
            -> Result<LauncherWireEvidenceV1, &'static str> { self.inner.snapshot_evidence(c, child) }
        fn io_stop_observation(&self) -> (Option<IoNativeDiagnostic>, Option<u32>) {
            (Some(IoNativeDiagnostic { stream: IoDiagnosticStream::Stdin,
                direction: IoDiagnosticDirection::Write, api: IoDiagnosticApi::WriteSubmit,
                state: IoDiagnosticState::InitialWriteNoData, code: 232 }), Some(self.code))
        }
    }
    let (_, baseline) = run(Mode::Worker, vec![]);
    let stop_at = baseline.calls.iter().position(|s| *s == Step::Transfer(StreamKind::Stdin)).unwrap() + 1;
    let context = make_context(Mode::Worker, canonical_envelope_bytes());
    let supervisor = make_context(Mode::Supervisor, canonical_envelope_bytes());
    let make_worker = |code, cleanup_failure: Option<usize>| {
        let store = SharedScriptedLedgerStore::default(); store.seed_supervisor(&context);
        let mut changes = changed(stop_at, KernelReply::Failed("PRIVATE=input-path"));
        if let Some(index) = cleanup_failure {
            changes.push(ScriptedOverride { ordinal: stop_at + 1 + index,
                reply: KernelReply::Unknown("PRIVATE=cleanup-path") });
        }
        let mut kernel = ObservedKernel { inner: ScriptedKernel::with_store(changes, store), code };
        let result = run_and_close(&context, &mut kernel);
        assert_eq!(kernel.inner.matched_override_count(), if cleanup_failure.is_some() { 2 } else { 1 });
        result
    };
    for code in [0, 64, 259, 0xC000_0005, u32::MAX] {
        for failure in [None, Some(0), Some(1), Some(2), Some(3)] {
            let worker = make_worker(code, failure);
            assert_eq!(worker.terminal, if failure.is_some() { ReducerTerminal::Quarantined } else { ReducerTerminal::Failed });
            let (_, observed) = parse_io_stop_reason(&worker.reason).unwrap();
            assert_eq!(observed.origin, IoStopOrigin::StdinTransfer);
            assert_eq!(observed.exit_before, Some(code)); assert_eq!(observed.exit_after, Some(code));
            for index in 0..4 { assert_eq!(observed.cleanup[index], if failure == Some(index) {
                IoCleanupOutcome::Unknown } else { IoCleanupOutcome::Ok }); }
            assert!(!worker.reason.contains("PRIVATE"));
            assert!(worker.reason.len() <= 768);
            let bytes = serde_json::to_vec(&worker).unwrap();
            assert!(promote_worker_evidence(&supervisor, &bytes).is_err());
            let (outer, _) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(bytes)));
            assert_eq!(outer.terminal, ReducerTerminal::Quarantined);
            assert!(outer.reason.contains("worker-io-stop="));
            assert!(outer.reason.contains(if failure.is_some() { "bound-worker=io-cleanup" } else { "bound-worker=stdin-transfer" }));
            assert!(outer.reason.len() <= 1_024);
            assert!(serde_json::to_vec(&outer).unwrap().len() <= MAX_WORKER_RESULT_BYTES);
            count += 1;
        }
    }
    let worker = make_worker(u32::MAX, Some(2));
    let (prefix, record) = parse_io_stop_reason(&worker.reason).unwrap();
    let value = serde_json::to_value(record).unwrap();
    let mut hostile = Vec::new();
    for mutate in [
        ("origin", serde_json::json!("PRIVATE:path")),
        ("cleanup", serde_json::json!(["ok","ok","PRIVATE","ok"])),
        ("cleanup", serde_json::json!(["ok","ok","ok"])),
        ("exit_before", serde_json::json!(4294967296u64)),
        ("exit_after", serde_json::json!(-1)),
        ("PRIVATE", serde_json::json!("private-path")),
    ] {
        let mut changed = value.clone(); changed[mutate.0] = mutate.1;
        hostile.push(format!("{prefix}; io-stop={}", serde_json::to_string(&changed).unwrap()));
    }
    for (field, replacement) in [("state", "PRIVATE"), ("api", "PRIVATE"), ("stream", "PRIVATE"),
        ("direction", "read")] {
        let mut changed = value.clone(); changed["io"][field] = serde_json::json!(replacement);
        hostile.push(format!("{prefix}; io-stop={}", serde_json::to_string(&changed).unwrap()));
    }
    hostile.push(worker.reason.replace("\"exit_before\":", "\"exit_before\":0,\"exit_before\":"));
    hostile.push(worker.reason.replace("; io-stop={", "; io-stop={ "));
    hostile.push(format!("{} PRIVATE=path", worker.reason));
    hostile.push(format!("{prefix}; io-stop={}", "x".repeat(769)));
    for reason in hostile {
        assert!(parse_io_stop_reason(&reason).is_none());
        let mut changed_worker = worker.clone(); changed_worker.reason = reason;
        let bytes = serde_json::to_vec(&changed_worker).unwrap();
        assert!(promote_worker_evidence(&supervisor, &bytes).is_err());
        let (outer, _) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(bytes)));
        assert!(outer.reason.contains("bound-worker=redacted"));
        assert!(!outer.reason.contains("worker-io-stop="));
        assert!(!outer.reason.contains("PRIVATE")); count += 1;
    }
    for structural in [false, true] {
        let mut bad = worker.clone();
        if structural { bad.child_started = "unknown".into(); } else { bad.correlation_id = "PRIVATE".into(); }
        let (outer, _) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(serde_json::to_vec(&bad).unwrap())));
        assert!(!outer.reason.contains("worker-io-stop=")); count += 1;
    }
    // Cover every origin and generic state, plus maximal-width write-submit
    // and the longer initial-write state below; never assume the observed short
    // record represents the bound.
    for origin in [IoStopOrigin::IoStart, IoStopOrigin::StdinTransfer, IoStopOrigin::StdoutTransfer,
        IoStopOrigin::StderrTransfer, IoStopOrigin::ProcessStillActive, IoStopOrigin::ProcessDeadline,
        IoStopOrigin::ProcessExit, IoStopOrigin::ProcessIdentity, IoStopOrigin::DeadlineTie] {
        for state in [IoDiagnosticState::Prepared, IoDiagnosticState::Pending, IoDiagnosticState::Immediate,
            IoDiagnosticState::Terminal, IoDiagnosticState::TerminalError, IoDiagnosticState::CancelRequested,
            IoDiagnosticState::Retired] {
            let mut worst = record; worst.origin = origin; worst.cleanup = [IoCleanupOutcome::Unexpected; 4];
            worst.io = Some(IoNativeDiagnostic { stream: IoDiagnosticStream::Stderr,
                direction: IoDiagnosticDirection::Read, api: IoDiagnosticApi::Completion, state, code: u32::MAX });
            let reason = format!("{prefix}; io-stop={}", serde_json::to_string(&worst).unwrap());
            assert!(reason.len() <= 768); assert!(parse_io_stop_reason(&reason).is_some());
            let mut wide = worker.clone(); wide.reason = reason;
            let (outer, _) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(serde_json::to_vec(&wide).unwrap())));
            assert!(outer.reason.len() <= 1_024); count += 1;
        }
    }
    for state in [IoDiagnosticState::CancelRequested, IoDiagnosticState::InitialWriteNoData] {
        let mut worst = record; worst.origin = IoStopOrigin::ProcessStillActive;
        worst.cleanup = [IoCleanupOutcome::Unexpected; 4];
        worst.io = Some(IoNativeDiagnostic { stream: IoDiagnosticStream::Stdin,
            direction: IoDiagnosticDirection::Write, api: IoDiagnosticApi::WriteSubmit, state,
            code: if state == IoDiagnosticState::InitialWriteNoData { 232 } else { u32::MAX } });
        let encoded = serde_json::to_string(&worst).unwrap();
        assert!(encoded.len() <= 512);
        let reason = format!("{prefix}; io-stop={encoded}");
        assert!(parse_io_stop_reason(&reason).is_some());
        let mut wide = worker.clone(); wide.reason = reason;
        let (outer, _) = run_closed(Mode::Supervisor, changed(23, KernelReply::EofBytes(serde_json::to_vec(&wide).unwrap())));
        assert!(outer.reason.len() <= 1_024);
        assert!(serde_json::to_vec(&outer).unwrap().len() <= MAX_WORKER_RESULT_BYTES);
        count += 1;
    }
    count
}

fn native_observer_startup_compatibility() -> usize {
    let source = ObserverTokenSnapshot { user: "test-runtime-user".into(),
        groups: vec![("S-1-5-32-545".into(), 7), ("S-1-1-0".into(), 7),
            ("S-1-5-11".into(), 7), ("S-1-5-32-544".into(), 15),
            ("test-custom-enabled".into(), 7), ("test-disabled".into(), 0),
            ("test-deny-only".into(), 16), ("S-1-5-5-1-2".into(), 0xC0000007),
            ("S-1-16-12288".into(), 96)],
        privileges: vec![((23, 0), 3), ((5, 0), 2)], integrity: "S-1-16-12288".into(),
        integrity_attributes: 96, token_type: 1 };
    let notify = (23, 0);
    let mut count = 0;
    let low = observer_expected_token(&source, notify, true).unwrap();
    for low_stage in [false, true] {
        let actual = observer_expected_token(&source, notify, low_stage).unwrap();
        assert!(verify_observer_token_transform(&source, notify, low_stage, || Ok(actual)).is_ok()); count += 1;
    }
    assert!(low.groups.contains(&("S-1-5-32-544".into(), 16)));
    assert!(low.groups.contains(&("test-custom-enabled".into(), 16)));
    assert!(low.groups.contains(&("test-disabled".into(), 0)));
    for index in 0..source.groups.len() {
        let mut hostile = low.clone(); hostile.groups[index].1 ^= 4;
        assert!(verify_observer_token_transform(&source, notify, true, || Ok(hostile)).is_err()); count += 1;
    }
    let mutations: &[fn(&mut ObserverTokenSnapshot)] = &[
        |s| s.user.push('x'), |s| s.token_type = 2, |s| s.integrity = "S-1-16-8192".into(),
        |s| s.integrity_attributes = 32, |s| s.groups.push(("unexpected".into(), 96)),
        |s| { s.groups.remove(0); }, |s| s.groups.push(s.groups[0].clone()),
        |s| s.privileges.clear(), |s| s.privileges.push(((5, 0), 2)),
        |s| s.privileges[0].1 = 2, |s| s.privileges[0].0 = (5, 0),
        |s| s.groups.last_mut().unwrap().0 = "S-1-16-8192".into(),
    ];
    for mutate in mutations {
        let mut hostile = low.clone(); mutate(&mut hostile);
        assert!(verify_observer_token_transform(&source, notify, true, || Ok(hostile)).is_err()); count += 1;
    }
    for index in 0..3 {
        for flags in [0, 16] {
            let mut missing = source.clone(); missing.groups[index].1 = flags;
            assert!(observer_expected_token(&missing, notify, true).is_err()); count += 1;
        }
    }
    for flags in [0, 1, 4, u32::MAX] {
        let mut missing = source.clone(); missing.privileges[0].1 = flags;
        assert!(observer_expected_token(&missing, notify, true).is_err()); count += 1;
    }
    let malformed: &[fn(&mut ObserverTokenSnapshot)] = &[
        |s| s.groups.push(("fake-integrity".into(), 96)),
        |s| s.groups.push(("fake-logon".into(), 0xC0000007)),
        |s| s.groups.push(("S-1-16-4096".into(), 0)),
        |s| s.groups.push(s.groups[0].clone()),
        |s| s.privileges.push(s.privileges[0]), |s| { s.privileges.remove(0); },
    ];
    for mutate in malformed {
        let mut bad = source.clone(); mutate(&mut bad);
        assert!(observer_expected_token(&bad, notify, true).is_err()); count += 1;
    }
    assert!(verify_observer_token_transform(&source, notify, true, || Err("acquisition failed")).is_err()); count += 1;
    let user = "test-runtime-user"; let package = "test-fixed-package";
    let descriptor = ObserverReadSecurity { protected: true, dacl_present: true,
        owner: "S-1-5-32-544".into(), group: "S-1-5-32-544".into(),
        aces: ["S-1-5-18", "S-1-5-32-544", user, package].iter().enumerate()
            .map(|(i,sid)| (0,0,if i<2 { OBSERVER_MAINTENANCE_MASK } else { OBSERVER_READ_MASK },(*sid).into())).collect() };
    for role in [ObserverReadRole::Image, ObserverReadRole::Cwd] {
        assert!(verify_observer_read_security(role, role == ObserverReadRole::Cwd, user, package, &descriptor).is_ok()); count += 1;
        assert!(verify_observer_read_security(role, role != ObserverReadRole::Cwd, user, package, &descriptor).is_err()); count += 1;
        for index in 0..4 {
            for mutation in 0..4 {
                let mut bad = descriptor.clone();
                match mutation { 0 => bad.aces[index].0 = 1, 1 => bad.aces[index].1 = 0x10,
                    2 => bad.aces[index].2 ^= 2, _ => bad.aces[index].3.push('x') }
                assert!(verify_observer_read_security(role, role == ObserverReadRole::Cwd, user, package, &bad).is_err()); count += 1;
            }
        }
    }
    let descriptor_mutations: &[fn(&mut ObserverReadSecurity)] = &[
        |s| s.protected = false, |s| s.dacl_present = false,
        |s| s.owner = "test-runtime-user".into(), |s| s.group = "S-1-5-18".into(),
        |s| { s.aces.pop(); }, |s| s.aces.push(s.aces[0].clone()),
        |s| s.aces[3] = s.aces[2].clone(),
    ];
    for mutate in descriptor_mutations {
        let mut bad = descriptor.clone(); mutate(&mut bad);
        assert!(verify_observer_read_security(ObserverReadRole::Image, false, user, package, &bad).is_err()); count += 1;
    }
    for (kind, flags, cwd) in [(ChildKind::Observer, 0x0008040C, FIXED_OBSERVER_CWD),
        (ChildKind::Worker, 0x08080404, FIXED_CWD)] {
        let spec = fixed_native_launch_spec(kind);
        assert_eq!((spec.creation_flags, spec.cwd), (flags, cwd));
        assert!(verify_observer_startup_binding(kind, flags, cwd).is_ok()); count += 1;
        for wrong in [0, flags ^ 8, flags ^ 0x08000000, flags | 0x10] {
            assert!(verify_observer_startup_binding(kind, wrong, cwd).is_err()); count += 1;
        }
        for wrong in ["relative", "", r"\\?\C:\ProgramData", r"\\?\C:\ProgramData\DecadansNeurobro\observer-cwd\.."] {
            assert!(verify_observer_startup_binding(kind, flags, wrong).is_err()); count += 1;
        }
    }
    count
}

const BINDING_FIXTURE_REQUEST_ID: &str = "8A1E79BC-3324-4B63-8A71-0AFA9D730C42";

fn binding_supervisor_frame(payload: &[u8]) -> Vec<u8> {
    let mut header: WireEnvelope = serde_json::from_slice(&canonical_envelope_bytes()).unwrap();
    header.request_id = BINDING_FIXTURE_REQUEST_ID.into();
    header.stdin_sha256 = format!("{:x}", sha2::Sha256::digest(payload));
    header.stdin_byte_count = payload.len() as u64;
    [serde_json::to_vec(&header).unwrap(), b"\n".to_vec(), payload.to_vec()].concat()
}

fn binding_context(root: &str, target: &str, create: bool) -> (ProductionInvocationContext, ProductionInvocationContext) {
    let mut payload = serde_json::json!({
        "consumer": OBSERVER_REQUEST_CONSUMER, "operation": "read-bound-file",
        "requestId": BINDING_FIXTURE_REQUEST_ID, "rootPath": root, "schema": OBSERVER_REQUEST_SCHEMA,
        "targetPath": target, "version": "v1"
    });
    if create {
        payload["operation"] = "create-new-durable-file".into();
        payload["contentBase64"] = STANDARD.encode(b"fixture").into();
    }
    let supervisor = parse_production_input(Mode::Supervisor,
        &binding_supervisor_frame(&serde_json::to_vec(&payload).unwrap())).unwrap();
    let worker = parse_production_input(Mode::Worker, &supervisor.supervisor_handoff_bytes().unwrap()).unwrap();
    (supervisor, worker)
}

#[derive(Clone)]
struct AnchorFixture {
    observed: DriveAnchorObservation,
    drive_type: Result<u32, &'static str>,
    open_error: bool,
    observe_error: bool,
    close_error: bool,
    types: usize,
    opens: usize,
    observations: usize,
    closes: usize,
}
impl Default for AnchorFixture {
    fn default() -> Self {
        Self { observed: DriveAnchorObservation { normalized_dos: r"\\?\C:\".into(),
            normalized_nt: r"\Device\HarddiskVolume1\".into(), volume_serial: 0x1234,
            file_id: [7;16], directory: true, delete_pending: false, reparse: false },
            drive_type: Ok(3), open_error: false, observe_error: false, close_error: false,
            types: 0, opens: 0, observations: 0, closes: 0 }
    }
}
impl DriveAnchorProvider for AnchorFixture {
    type Handle = u64;
    fn drive_type(&mut self, root: &str) -> Result<u32, &'static str> {
        assert_eq!(root, r"C:\"); self.types += 1; self.drive_type
    }
    fn open(&mut self, root: &str) -> Result<u64, &'static str> {
        assert_eq!(root, r"\\?\C:\"); self.opens += 1;
        if self.open_error { Err("fixture open failed") } else { Ok(19) }
    }
    fn observe(&mut self, handle: &u64) -> Result<DriveAnchorObservation, &'static str> {
        assert_eq!(*handle, 19); self.observations += 1;
        if self.observe_error { Err("fixture native observation failed") } else { Ok(self.observed.clone()) }
    }
    fn close(&mut self, handle: u64) -> Result<(), &'static str> {
        assert_eq!(handle, 19); self.closes += 1;
        assert_eq!(self.closes, 1, "never retry even an uncertain close");
        if self.close_error { Err("fixture close failed") } else { Ok(()) }
    }
}

// Real lifecycle seam around the real scripted reducer: parent encoder and
// held-owner methods are the same functions called by RealWin32Kernel.
struct AnchorKernel {
    inner: ScriptedKernel,
    context: ProductionInvocationContext,
    held: HeldDriveBinding<u64>,
    provider: AnchorFixture,
    fail_at: &'static str,
}
impl LauncherKernel for AnchorKernel {
    fn bind_context(&mut self, context: &ProductionInvocationContext) -> KernelReply {
        self.inner.bind_context(context)
    }
    fn invoke(&mut self, step: Step) -> KernelReply {
        let outcome = match step {
            Step::CreateSuspendedChild(ChildKind::Observer) => self.held.acquire(&mut self.provider, &self.context),
            Step::ResumePrimaryThread => {
                if self.fail_at == "resume-drift" { self.provider.observed.file_id[0] ^= 1; }
                self.held.revalidate(&mut self.provider)
            }
            Step::FinalIdentityAclHashReverify => {
                if self.fail_at == "final-drift" { self.provider.observed.volume_serial ^= 1; }
                self.held.revalidate(&mut self.provider)
            }
            Step::ReleaseHeldImageHandles => {
                if self.fail_at == "release-close" { self.provider.close_error = true; }
                // Deliberately let the real inner kernel cache evidence first:
                // the new finalizer must suppress even this hostile cache.
                let reply = self.inner.invoke(step);
                if matches!(self.fail_at, "finalizer-drift" | "finalizer-close") { return reply; }
                return if self.held.finish(&mut self.provider).is_err() {
                    KernelReply::Unknown(DRIVE_BINDING_FAILURE)
                } else if self.fail_at == "restore" {
                    KernelReply::Unknown("launcher quota restoration was not verified")
                } else { reply };
            }
            _ => Ok(()),
        };
        if outcome.is_err() { KernelReply::Unknown("observer drive binding verification failed") }
        else { self.inner.invoke(step) }
    }
    fn finalize_invocation(&mut self) -> Result<(), &'static str> {
        if self.fail_at == "finalizer-drift" { self.provider.observed.file_id[0] ^= 1; }
        if matches!(self.fail_at, "finalizer-close" | "io-close") { self.provider.close_error = true; }
        self.held.finish(&mut self.provider)
    }
    fn snapshot_evidence(&mut self, context: &ProductionInvocationContext, child: ChildStartEvidence)
        -> Result<LauncherWireEvidenceV1, &'static str>
    {
        if self.fail_at == "snapshot-close" { return Err("fixture snapshot construction failed"); }
        self.inner.snapshot_evidence(context, child)
    }
}

fn genuine_observer_success(context: &ProductionInvocationContext, create: bool) -> Vec<u8> {
    let request = accepted_observer::parse_canonical_request(&context.observer_payload_bytes).unwrap();
    let identity = accepted_observer::FileIdentity {
        volume_serial_number: "0000000000001234".into(), file_id: "07".repeat(16),
        size: "7".into(), last_write_time: "1".into(), file_attributes: "00000020".into(),
        final_path: r"\\?\C:\Fixture\leaf.txt".into(),
    };
    let (observation, acknowledgment) = if create {
        let content_hash = format!("{:x}", sha2::Sha256::digest(b"fixture"));
        accepted_observer::fixture_create_success_values(&request, &context.observer_payload_sha256,
            &identity, &content_hash, &identity, &content_hash).unwrap()
    } else {
        accepted_observer::read_success_values(&request, &context.observer_payload_sha256,
            &identity, &identity, b"fixture").unwrap()
    };
    assert_eq!(acknowledgment["outcome"], "known");
    accepted_observer::success_frame(&observation, &acknowledgment).unwrap()
}

fn native_observer_normalized_nt_binding() -> usize {
    let (_, context) = binding_context(r"C:\Fixture", r"C:\Fixture\leaf.txt", false);
    let mut count = 0;
    for root in ["", r"c:\Fixture", r"\\?\C:\Fixture", r"\\host\share", r"C:/Fixture",
        r"C:\Fixture\", r"C:\.", r"C:\..", r"C:\CON", r"C:\COM¹", r"C:\Fixture.",
        r"C:\Fixture ", r"C:\a:b", "C:\\a\u{80}", r"C:\a?", r"C:\a*"] {
        let target = format!(r"{root}\leaf.txt");
        assert_eq!(validate_drive_binding_paths(root, &target).is_ok(),
            accepted_observer::validate_input_path_pair(root, &target).is_ok());
        if root.chars().any(|c| matches!(c as u32, 0..=31 | 127..=159)) {
            // The real outer parser rejects controls before a context exists;
            // do not unwrap that earlier refusal to reach the anchor fixture.
            let mut payload: serde_json::Value = serde_json::from_slice(&context.observer_payload_bytes).unwrap();
            payload["rootPath"] = root.into(); payload["targetPath"] = target.into();
            assert!(parse_production_input(Mode::Supervisor,
                &binding_supervisor_frame(&serde_json::to_vec(&payload).unwrap())).is_err());
            count += 1;
            continue;
        }
        let (_, bad) = binding_context(root, &target, false);
        let mut held = HeldDriveBinding::default(); let mut provider = AnchorFixture::default();
        assert!(held.acquire(&mut provider, &bad).is_err());
        assert_eq!((provider.types, provider.opens, provider.closes), (0,0,0)); count += 1;
    }
    for (root, target) in [(r"C:\Fixture", r"D:\Fixture\leaf"), (r"C:\Fixture", r"C:\Fixture"),
        (r"C:\Fixture", r"C:\Fixture2\leaf"), (r"C:\Fixture", r"C:\fixture\leaf"),
        (r"C:\", r"C:\leaf"), (r"C:\Long~1", r"C:\Long~1\leaf"), (r"C:\Тест", r"C:\Тест\leaf")] {
        assert_eq!(validate_drive_binding_paths(root, target).is_ok(),
            accepted_observer::validate_input_path_pair(root, target).is_ok()); count += 1;
    }
    for drive_type in [Err("type unavailable"), Ok(0), Ok(1), Ok(2), Ok(4), Ok(5), Ok(6), Ok(u32::MAX)] {
        let mut provider = AnchorFixture { drive_type, ..Default::default() };
        let mut held = HeldDriveBinding::default();
        assert!(held.acquire(&mut provider, &context).is_err());
        assert_eq!((provider.types, provider.opens), (1,0)); count += 1;
    }
    for mutate in [
        (|c: &mut ProductionInvocationContext| c.mode = Mode::Supervisor) as fn(&mut ProductionInvocationContext),
        |c| c.observer_payload_sha256 = "0".repeat(64),
        |c| c.canonical_request_bytes.push(b' '),
        |c| c.envelope.stdin_byte_count += 1,
        |c| c.envelope.request_id.push('x'),
    ] {
        let mut bad = context.clone(); mutate(&mut bad);
        let mut provider = AnchorFixture::default(); let mut held = HeldDriveBinding::default();
        assert!(held.acquire(&mut provider, &bad).is_err()); assert_eq!(provider.opens,0); count += 1;
    }
    let mutations: &[fn(&mut DriveAnchorObservation)] = &[
        |o| o.normalized_dos = r"\\?\D:\".into(), |o| o.normalized_dos.push('x'),
        |o| o.normalized_nt = r"\Device\HarddiskVolume1\sub\".into(),
        |o| o.normalized_nt = r"\Device\Mup\host\share\".into(),
        |o| o.normalized_nt = r"\Device\HarddiskVolume\".into(),
        |o| o.normalized_nt = r"\Device\HarddiskVolume１\".into(),
        |o| o.normalized_nt.push('\0'), |o| o.normalized_nt = "x".repeat(1025),
        |o| o.directory = false, |o| o.delete_pending = true, |o| o.reparse = true,
    ];
    for mutate in mutations {
        let mut provider = AnchorFixture::default(); mutate(&mut provider.observed);
        let mut held = HeldDriveBinding::default();
        assert!(held.acquire(&mut provider, &context).is_err());
        assert_eq!(provider.closes,0); assert!(held.finish(&mut provider).is_err());
        assert_eq!(provider.closes,1); assert!(held.finish(&mut provider).is_err()); count += 1;
    }
    for stage in ["open", "observe", "close"] {
        let mut provider = AnchorFixture::default();
        provider.open_error = stage == "open"; provider.observe_error = stage == "observe";
        provider.close_error = stage == "close";
        let mut held = HeldDriveBinding::default();
        assert_eq!(held.acquire(&mut provider, &context).is_ok(), stage == "close");
        assert!(held.finish(&mut provider).is_err());
        assert_eq!(provider.closes, usize::from(stage != "open")); count += 1;
    }
    let mut provider = AnchorFixture::default(); let mut held = HeldDriveBinding::default();
    held.acquire(&mut provider, &context).unwrap();
    let raw = held.generated(&context).unwrap().canonical_record().to_owned();
    assert!(raw.is_ascii() && raw.len() <=1024 && raw.encode_utf16().count() <=1024);
    let binding = accepted_observer::parse_drive_binding(&raw, &context.observer_payload_sha256, "C:").unwrap();
    assert_eq!(accepted_observer::normalized_nt_to_dos(&binding,
        r"\Device\HarddiskVolume1\Fixture\leaf.txt",0x1234).unwrap(),r"\\?\C:\Fixture\leaf.txt");
    for (name, volume) in [(r"\Device\HarddiskVolume10\Fixture\leaf.txt",0x1234),
        (r"\Device\HarddiskVolume1\Fixture\leaf.txt",0x1235), (r"\Fixture\leaf.txt",0x1234)] {
        assert!(accepted_observer::normalized_nt_to_dos(&binding,name,volume).is_err()); count +=1;
    }
    for (hash, drive) in [("0".repeat(64),"C:"), (context.observer_payload_sha256.clone(),"D:")] {
        assert!(accepted_observer::parse_drive_binding(&raw,&hash,drive).is_err()); count +=1;
    }
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for key in ["drive","ntVolumeRoot","requestSha256","schema","volumeSerialNumber"] {
        let mut bad = value.clone(); bad.as_object_mut().unwrap().remove(key);
        assert!(accepted_observer::parse_drive_binding(&serde_json::to_string(&bad).unwrap(),
            &context.observer_payload_sha256,"C:").is_err()); count +=1;
    }
    let mut unknown = value.clone(); unknown["extra"] = true.into();
    for bad in [format!(" {raw}"), raw.replace("\"drive\":\"C:\"", "\"drive\":\"C:\",\"drive\":\"C:\""),
        raw.replace("0000000000001234","000000000000ABCD"),
        raw.replace("\"schema\":\"decadans.", "\"schema\":\"private."),
        serde_json::to_string(&unknown).unwrap(), "x".repeat(1025)] {
        assert!(accepted_observer::parse_drive_binding(&bad,&context.observer_payload_sha256,"C:").is_err()); count +=1;
    }
    held.revalidate(&mut provider).unwrap(); held.finish(&mut provider).unwrap();
    held.finish(&mut provider).unwrap(); assert_eq!((provider.opens,provider.closes),(1,1));
    assert!(held.generated(&context).is_err()); count +=1;

    for create in [false,true] {
        let (supervisor, context) = binding_context(r"C:\Fixture",r"C:\Fixture\leaf.txt",create);
        let frame = genuine_observer_success(&context,create);
        for fail_at in ["none","resume-drift","final-drift","release-close","finalizer-drift","finalizer-close","restore","snapshot-close"] {
            let store = SharedScriptedLedgerStore::default(); store.seed_supervisor(&context);
            let inner = ScriptedKernel::with_store(vec![ScriptedOverride {
                ordinal:32, reply:KernelReply::EofBytes(frame.clone()) }],store);
            let mut provider = AnchorFixture::default();
            provider.close_error = fail_at == "snapshot-close";
            let mut kernel = AnchorKernel { inner, context:context.clone(), held:HeldDriveBinding::default(),
                provider, fail_at };
            EXECUTED_REDUCER_CASES.fetch_add(1,Ordering::Relaxed);
            let result = run_and_close(&context,&mut kernel);
            assert_eq!(kernel.provider.closes,1);
            assert_eq!(result.child_start_evidence,ChildStartEvidence::Started);
            if fail_at == "none" {
                assert_eq!(result.terminal,ReducerTerminal::Success);
                assert!(promote_worker_evidence(&supervisor,&serde_json::to_vec(&result).unwrap()).is_ok());
            } else {
                assert_ne!(result.terminal,ReducerTerminal::Success);
                assert!(result.sticky && !result.handles_released);
                if !matches!(fail_at,"resume-drift" | "snapshot-close") {
                    assert_eq!(validate_wire_evidence(&result.evidence).unwrap().0,frame);
                }
                assert!(promote_worker_evidence(&supervisor,&serde_json::to_vec(&result).unwrap()).is_err());
                let store = SharedScriptedLedgerStore::default();
                let mut outer = ScriptedKernel::with_store(vec![ScriptedOverride { ordinal:23,
                    reply:KernelReply::EofBytes(serde_json::to_vec(&result).unwrap()) }],store);
                EXECUTED_REDUCER_CASES.fetch_add(1,Ordering::Relaxed);
                assert_ne!(run_and_close(&supervisor,&mut outer).terminal,ReducerTerminal::Success);
            }
            count +=1;
        }
    }
    // The finalizer cannot erase the initial stop origin or its four cleanup
    // observations, even when its own checked close independently fails.
    let store = SharedScriptedLedgerStore::default(); store.seed_supervisor(&context);
    let inner = ScriptedKernel::with_store(vec![ScriptedOverride {
        ordinal:31, reply:KernelReply::Failed("PRIVATE=untrusted-io-detail") }],store);
    let mut kernel = AnchorKernel { inner, context:context.clone(), held:HeldDriveBinding::default(),
        provider:AnchorFixture::default(), fail_at:"io-close" };
    EXECUTED_REDUCER_CASES.fetch_add(1,Ordering::Relaxed);
    let result = run_and_close(&context,&mut kernel);
    assert_eq!(result.terminal,ReducerTerminal::Quarantined);
    let (_, diagnostic) = parse_io_stop_reason(&result.reason).unwrap();
    assert_eq!(diagnostic.origin,IoStopOrigin::StdinTransfer);
    assert_eq!(diagnostic.cleanup,[IoCleanupOutcome::Ok;4]);
    assert!(!result.reason.contains("PRIVATE"));
    assert!(result.sticky && !result.handles_released);
    assert_eq!(kernel.provider.closes,1); count +=1;
    let (baseline, scripted) = run_context(context.clone(),vec![]);
    assert_eq!(baseline.terminal,ReducerTerminal::Success);
    for failed_step in [
        Step::CreateSuspendedChild(ChildKind::Observer), Step::AssignInnerJob,
        Step::VerifyObserverConfinement, Step::ResumePrimaryThread,
        Step::StartConcurrentIo, Step::Transfer(StreamKind::Stdin),
        Step::RecheckDeadline, Step::ReleaseHeldImageHandles,
    ] {
        let ordinal = scripted.calls.iter().position(|step| *step == failed_step).unwrap()+1;
        let store = SharedScriptedLedgerStore::default(); store.seed_supervisor(&context);
        let inner = ScriptedKernel::with_store(vec![ScriptedOverride {
            ordinal, reply:KernelReply::Unknown("fixture existing lifecycle failure") }],store);
        let mut kernel = AnchorKernel { inner, context:context.clone(), held:HeldDriveBinding::default(),
            provider:AnchorFixture::default(), fail_at:"none" };
        EXECUTED_REDUCER_CASES.fetch_add(1,Ordering::Relaxed);
        let result = run_and_close(&context,&mut kernel);
        assert_ne!(result.terminal,ReducerTerminal::Success);
        assert_eq!((kernel.provider.opens,kernel.provider.closes),(1,1));
        assert!(!result.handles_released); count +=1;
    }
    count
}

const GROUPS: [Group; 14] = [
    ("native-observer-normalized-nt-binding", native_observer_normalized_nt_binding),
    ("native-observer-startup-compatibility", native_observer_startup_compatibility),
    ("native-io-stop-retirement", native_io_stop_retirement),
    ("native-appcontainer-access-baseline", native_appcontainer_access_baseline),
    ("native-snapshot-promotion-diagnostics", native_snapshot_promotion_diagnostics),
    (
        "native-create-error-observability",
        native_create_error_observability,
    ),
    ("fixed-binding", fixed_binding),
    ("held-image-handle", held_image_handle),
    ("token-appcontainer", token_appcontainer),
    ("job-confinement", job_confinement),
    ("pipes-handle-inheritance", pipes_handle_inheritance),
    ("durable-ledger", durable_ledger),
    ("bounded-io", bounded_io),
    ("deadline-drain-exit", deadline_drain_exit),
];

fn select_groups(selectors: &[String]) -> Result<Vec<Group>, &'static str> {
    match selectors {
        [] => Ok(GROUPS.to_vec()),
        [selector] if !selector.is_empty() => {
            let selected: Vec<Group> = GROUPS
                .iter()
                .copied()
                .filter(|(name, _)| name == selector)
                .collect();
            if selected.len() == 1 {
                Ok(selected)
            } else {
                Err("unknown selector")
            }
        }
        _ => Err("duplicate or explicitly empty selector"),
    }
}

fn main() {
    let selectors: Vec<String> = env::args().skip(1).collect();
    let selected = select_groups(&selectors).unwrap_or_else(|reason| {
        eprintln!("exactly one known nonempty selector is required when filtering: {reason}");
        std::process::exit(2);
    });

    let mut total = 0;
    for (name, group) in selected {
        let count = group();
        assert!(count > 0, "selector {name} matched no vectors");
        println!("selector={name} matched-vectors={count} status=PASS");
        total += count;
    }
    println!("matched-vector-total={total} status=PASS");
}
