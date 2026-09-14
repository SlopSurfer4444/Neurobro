use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::mem::size_of;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::ptr::null;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_NO_MORE_FILES, FILETIME, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE, SYSTEMTIME,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateMutexW, GetCurrentProcess, OpenThread, ReleaseMutex,
    ResumeThread, THREAD_SUSPEND_RESUME,
};
use windows_sys::Win32::System::Time::FileTimeToSystemTime;

const CONTRACT_VECTOR_RESULT_SCHEMA: &str = "decadans.rm0032.contract-vector-result.v1";
const PROCESS_REQUEST_SCHEMA: &str = "decadans.rm0032.process-request.v1";
const PROCESS_EVIDENCE_SCHEMA: &str = "decadans.rm0032.process-evidence.v1";
const RUNNER_ACK_SCHEMA: &str = "decadans.rm0032.runner-ack.v1";
const ATTEMPT_MARKER_SCHEMA: &str = "decadans.rm0032.attempt-marker.v1";
const PROCESS_CONSUMER: &str = "phase-3-wsl-hardening-coordinator";
const REQUEST_BYTES_MAX: usize = 65_536;
const STDIN_BYTES_MAX: usize = 262_144;
const STDOUT_BYTES_MAX: usize = 1_048_576;
const STDERR_BYTES_MAX: usize = 1_048_576;
const EVIDENCE_BYTES_MAX: usize = 3_145_728;
const AGGREGATE_DEADLINE_MS: u64 = 420_000;
const MEMORY_BYTES_MAX: u64 = 268_435_456;
const CPU_PERCENT_MAX: u64 = 25;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessRequest {
    schema: String,
    operation_id: String,
    one_shot: bool,
    retry_authorized: bool,
    executable: ExecutableBinding,
    argv: Vec<String>,
    stdin: StdinBinding,
    environment: EnvironmentBinding,
    limits: LimitBinding,
    containment: ContainmentBinding,
    attempt_marker: CreateNewPath,
    evidence: EvidencePath,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutableBinding {
    path: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StdinBinding {
    encoding: String,
    base64: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentBinding {
    inherit: bool,
    allowlist: Vec<String>,
    values: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LimitBinding {
    request_bytes_max: u64,
    stdin_bytes_max: u64,
    stdout_bytes_max: u64,
    stderr_bytes_max: u64,
    evidence_bytes_max: u64,
    concurrency_max: u64,
    child_process_max: u64,
    deadline_ms: u64,
    aggregate_deadline_ms: u64,
    memory_bytes_max: u64,
    cpu_percent_max: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContainmentBinding {
    consumer: String,
    operation_root: String,
    require_canonical_paths: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateNewPath {
    path: String,
    create_new: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidencePath {
    path: String,
    schema: String,
    #[serde(rename = "createNew")]
    create_new: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawStreamEvidence {
    base64: String,
    bytes: u64,
    sha256: String,
    complete: bool,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessEvidence {
    schema: String,
    request_bytes: u64,
    request_sha256: String,
    executable_sha256_observed: String,
    argv: Vec<String>,
    stdin_bytes: u64,
    stdin_sha256: String,
    started_utc: String,
    finished_utc: String,
    process_start_count: u64,
    terminal_state: String,
    exit_code_known: bool,
    exit_code: Option<i32>,
    output_complete: bool,
    standard_output: RawStreamEvidence,
    standard_error: RawStreamEvidence,
    retry_performed: bool,
    cleanup_performed: bool,
}

#[derive(Debug)]
struct ProcessOutcome {
    started_utc: String,
    finished_utc: String,
    process_start_count: u64,
    terminal_state: String,
    exit_code_known: bool,
    exit_code: Option<i32>,
    standard_output: CapturedStream,
    standard_error: CapturedStream,
}

#[derive(Debug)]
struct CapturedStream {
    bytes: Vec<u8>,
    complete: bool,
    truncated: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FaultMode {
    None,
    MarkerFlushFailure,
    EvidenceCreateRace,
    EvidenceWriteFailure,
    EvidenceFlushFailure,
    EvidenceReadbackFailure,
    TruncatedEvidence,
    CorruptAck,
    SwallowAck,
    SpawnRefusal,
    JobCreateRefusal,
    ResourceControlRefusal,
    UnassignedKillUncertainty,
    UnassignedWaitUncertainty,
    ResumeRefusal,
    StartUncertainty,
    WaitUncertainty,
}

fn main() -> ExitCode {
    match run_cli() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(io::stderr().lock(), "{error}");
            ExitCode::from(64)
        }
    }
}

fn run_cli() -> Result<(), String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match arguments.as_slice() {
        [mode, fixture_path] if mode == "contract-vector" => {
            run_contract_vector(Path::new(fixture_path))
        }
        [mode, request_path] if mode == "run" => {
            run_process_boundary(Path::new(request_path), FaultMode::None)
        }
        [mode, fault, request_path] if mode == "test-run" => {
            run_process_boundary(Path::new(request_path), parse_fault_mode(fault)?)
        }
        [mode, behavior] if mode == "fixture" => run_fixture(behavior, None),
        [mode, behavior, parameter] if mode == "fixture" => run_fixture(behavior, Some(parameter)),
        _ => Err("cli-contract-refused: expected one exact supported mode".to_string()),
    }
}

fn parse_fault_mode(value: &str) -> Result<FaultMode, String> {
    match value {
        "evidence-create-race" => Ok(FaultMode::EvidenceCreateRace),
        "marker-flush-failure" => Ok(FaultMode::MarkerFlushFailure),
        "evidence-write-failure" => Ok(FaultMode::EvidenceWriteFailure),
        "evidence-flush-failure" => Ok(FaultMode::EvidenceFlushFailure),
        "evidence-readback-failure" => Ok(FaultMode::EvidenceReadbackFailure),
        "truncated-evidence" => Ok(FaultMode::TruncatedEvidence),
        "corrupt-ack" => Ok(FaultMode::CorruptAck),
        "swallow-ack" => Ok(FaultMode::SwallowAck),
        "spawn-refusal" => Ok(FaultMode::SpawnRefusal),
        "job-create-refusal" => Ok(FaultMode::JobCreateRefusal),
        "resource-control-refusal" => Ok(FaultMode::ResourceControlRefusal),
        "unassigned-kill-uncertainty" => Ok(FaultMode::UnassignedKillUncertainty),
        "unassigned-wait-uncertainty" => Ok(FaultMode::UnassignedWaitUncertainty),
        "resume-refusal" => Ok(FaultMode::ResumeRefusal),
        "start-uncertainty" => Ok(FaultMode::StartUncertainty),
        "wait-uncertainty" => Ok(FaultMode::WaitUncertainty),
        _ => Err("test-fault-refused: unknown deterministic fault".to_string()),
    }
}

fn run_fixture(behavior: &str, parameter: Option<&String>) -> Result<(), String> {
    match behavior {
        "echo" => {
            let mut bytes = Vec::new();
            io::stdin()
                .lock()
                .read_to_end(&mut bytes)
                .map_err(|error| format!("fixture-stdin-read-failed: {error}"))?;
            io::stdout()
                .lock()
                .write_all(&bytes)
                .map_err(|error| format!("fixture-stdout-write-failed: {error}"))?;
            io::stdout()
                .lock()
                .flush()
                .map_err(|error| format!("fixture-stdout-flush-failed: {error}"))?;
            Ok(())
        }
        "stderr" => {
            io::stderr()
                .lock()
                .write_all(b"synthetic-stderr")
                .map_err(|error| format!("fixture-stderr-write-failed: {error}"))?;
            io::stderr()
                .lock()
                .flush()
                .map_err(|error| format!("fixture-stderr-flush-failed: {error}"))?;
            Ok(())
        }
        "nonzero" => {
            io::stderr()
                .lock()
                .write_all(b"synthetic-nonzero")
                .map_err(|error| format!("fixture-stderr-write-failed: {error}"))?;
            Err("fixture-nonzero-exit".to_string())
        }
        "sleep" => {
            let milliseconds = parse_fixture_count(parameter, "sleep")?;
            thread::sleep(Duration::from_millis(milliseconds as u64));
            Ok(())
        }
        "flood-stdout" => {
            let bytes = parse_fixture_count(parameter, "flood-stdout")?;
            write_repeated(&mut io::stdout().lock(), bytes, b'O')
        }
        "flood-stderr" => {
            let bytes = parse_fixture_count(parameter, "flood-stderr")?;
            write_repeated(&mut io::stderr().lock(), bytes, b'E')
        }
        "payload" => {
            let bytes = parse_fixture_count(parameter, "payload")?;
            write_deterministic_payload(&mut io::stdout().lock(), bytes)
        }
        "binary" => {
            io::stdout()
                .lock()
                .write_all(&[0x00, 0xff, 0xfe, 0x80])
                .map_err(|error| format!("fixture-binary-write-failed: {error}"))?;
            io::stdout()
                .lock()
                .flush()
                .map_err(|error| format!("fixture-binary-flush-failed: {error}"))
        }
        "write-sentinel" => write_fixture_sentinel(parameter),
        "environment" => {
            let mut names: Vec<String> = env::vars_os()
                .map(|(name, _)| name.to_string_lossy().to_string())
                .collect();
            names.sort();
            let bytes = canonical_json_bytes(&Value::Array(
                names.into_iter().map(Value::String).collect(),
            ))?;
            io::stdout()
                .lock()
                .write_all(&bytes)
                .map_err(|error| format!("fixture-environment-write-failed: {error}"))?;
            Ok(())
        }
        _ => Err("fixture-behavior-refused: unknown self-owned fixture behavior".to_string()),
    }
}

fn write_fixture_sentinel(parameter: Option<&String>) -> Result<(), String> {
    let path = Path::new(parameter.ok_or_else(|| "fixture-sentinel-path-missing".to_string())?);
    let current =
        env::current_dir().map_err(|error| format!("fixture-current-directory-failed: {error}"))?;
    if path
        .parent()
        .is_none_or(|parent| !windows_paths_equal(parent, &current))
    {
        return Err("fixture-sentinel-containment-refused".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("fixture-sentinel-create-new-failed: {error}"))?;
    file.write_all(b"child-executed")
        .map_err(|error| format!("fixture-sentinel-write-failed: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("fixture-sentinel-flush-failed: {error}"))
}

fn parse_fixture_count(parameter: Option<&String>, behavior: &str) -> Result<usize, String> {
    parameter
        .ok_or_else(|| format!("fixture-parameter-missing: {behavior}"))?
        .parse::<usize>()
        .map_err(|_| format!("fixture-parameter-invalid: {behavior}"))
}

fn write_repeated(writer: &mut impl Write, count: usize, byte: u8) -> Result<(), String> {
    let chunk = [byte; 8192];
    let mut remaining = count;
    while remaining > 0 {
        let amount = remaining.min(chunk.len());
        writer
            .write_all(&chunk[..amount])
            .map_err(|error| format!("fixture-stream-write-failed: {error}"))?;
        remaining -= amount;
    }
    writer
        .flush()
        .map_err(|error| format!("fixture-stream-flush-failed: {error}"))
}

fn write_deterministic_payload(writer: &mut impl Write, count: usize) -> Result<(), String> {
    let mut offset = 0_usize;
    let mut chunk = [0_u8; 8192];
    while offset < count {
        let amount = (count - offset).min(chunk.len());
        for (index, byte) in chunk[..amount].iter_mut().enumerate() {
            *byte = (((offset + index) * 31 + 17) % 251) as u8;
        }
        writer
            .write_all(&chunk[..amount])
            .map_err(|error| format!("fixture-payload-write-failed: {error}"))?;
        offset += amount;
    }
    writer
        .flush()
        .map_err(|error| format!("fixture-payload-flush-failed: {error}"))
}

fn run_process_boundary(request_path: &Path, fault: FaultMode) -> Result<(), String> {
    let _admission = SidecarAdmission::acquire()?;
    let (request, request_bytes, stdin_bytes, request_sha256) =
        load_and_validate_request(request_path)?;
    if fault != FaultMode::None {
        let current_executable = env::current_exe()
            .map_err(|error| format!("test-fault-current-executable-failed: {error}"))?;
        if request.argv.first().map(String::as_str) != Some("fixture")
            || !windows_paths_equal(Path::new(&request.executable.path), &current_executable)
            || request.executable.sha256 != sha256_file(&current_executable)?
        {
            return Err(
                "test-fault-live-authority-refused: faults require the exact self-owned fixture"
                    .to_string(),
            );
        }
    }
    let marker_bytes = canonical_json_bytes(&serde_json::json!({
        "createdUtc": utc_now()?,
        "operationId": request.operation_id,
        "requestBytes": request_bytes.len(),
        "requestSha256": request_sha256,
        "schema": ATTEMPT_MARKER_SCHEMA,
    }))?;
    if fault == FaultMode::MarkerFlushFailure {
        let mut marker_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&request.attempt_marker.path)
            .map_err(|error| format!("attempt-marker-create-new-failed: {error}"))?;
        marker_file
            .write_all(&marker_bytes)
            .map_err(|error| format!("attempt-marker-write-failed: {error}"))?;
        return Err("synthetic-attempt-marker-flush-failure".to_string());
    }
    create_new_durable(
        Path::new(&request.attempt_marker.path),
        &marker_bytes,
        "attempt-marker",
    )?;

    if fault == FaultMode::EvidenceCreateRace {
        create_new_durable(
            Path::new(&request.evidence.path),
            b"synthetic-create-race",
            "synthetic-evidence-race",
        )?;
    }
    let mut evidence_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&request.evidence.path)
        .map_err(|error| format!("evidence-create-new-failed: {error}"))?;
    evidence_file
        .sync_all()
        .map_err(|error| format!("evidence-reservation-flush-failed: {error}"))?;

    let outcome = if fault == FaultMode::SpawnRefusal {
        let now = utc_now()?;
        ProcessOutcome {
            started_utc: now.clone(),
            finished_utc: now,
            process_start_count: 0,
            terminal_state: "spawn-refused".to_string(),
            exit_code_known: false,
            exit_code: None,
            standard_output: complete_stream(Vec::new()),
            standard_error: complete_stream(b"synthetic-spawn-refusal".to_vec()),
        }
    } else {
        execute_child(&request, &stdin_bytes, fault)?
    };

    let standard_output = raw_stream_evidence(outcome.standard_output);
    let standard_error = raw_stream_evidence(outcome.standard_error);
    let evidence = ProcessEvidence {
        schema: PROCESS_EVIDENCE_SCHEMA.to_string(),
        request_bytes: request_bytes.len() as u64,
        request_sha256: request_sha256.clone(),
        executable_sha256_observed: request.executable.sha256.clone(),
        argv: request.argv.clone(),
        stdin_bytes: request.stdin.bytes,
        stdin_sha256: request.stdin.sha256.clone(),
        started_utc: outcome.started_utc,
        finished_utc: outcome.finished_utc,
        process_start_count: outcome.process_start_count,
        terminal_state: outcome.terminal_state,
        exit_code_known: outcome.exit_code_known,
        exit_code: outcome.exit_code,
        output_complete: standard_output.complete && standard_error.complete,
        standard_output,
        standard_error,
        retry_performed: false,
        cleanup_performed: false,
    };
    validate_evidence_invariants(&evidence)?;
    let evidence_value = serde_json::to_value(&evidence)
        .map_err(|error| format!("evidence-value-failed: {error}"))?;
    let full_evidence_bytes = canonical_json_bytes(&evidence_value)?;
    if full_evidence_bytes.len() > EVIDENCE_BYTES_MAX {
        return Err("evidence-size-exceeded".to_string());
    }
    if fault == FaultMode::EvidenceWriteFailure {
        return Err("synthetic-evidence-write-failure".to_string());
    }

    let bytes_to_persist = if fault == FaultMode::TruncatedEvidence {
        &full_evidence_bytes[..full_evidence_bytes.len().saturating_sub(1)]
    } else {
        &full_evidence_bytes
    };
    evidence_file
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("evidence-seek-failed: {error}"))?;
    evidence_file
        .set_len(0)
        .map_err(|error| format!("evidence-truncate-failed: {error}"))?;
    evidence_file
        .write_all(bytes_to_persist)
        .map_err(|error| format!("evidence-write-failed: {error}"))?;
    if fault == FaultMode::EvidenceFlushFailure {
        return Err("synthetic-evidence-flush-failure".to_string());
    }
    evidence_file
        .sync_all()
        .map_err(|error| format!("evidence-flush-failed: {error}"))?;
    let persisted_size = evidence_file
        .metadata()
        .map_err(|error| format!("evidence-metadata-failed: {error}"))?
        .len() as usize;
    if persisted_size != bytes_to_persist.len() {
        return Err(format!(
            "evidence-size-readback-mismatch: {persisted_size} != {}",
            bytes_to_persist.len()
        ));
    }
    drop(evidence_file);
    if fault == FaultMode::EvidenceReadbackFailure {
        return Err("synthetic-evidence-readback-failure".to_string());
    }
    let persisted_bytes = fs::read(&request.evidence.path)
        .map_err(|error| format!("evidence-readback-failed: {error}"))?;
    if persisted_bytes != bytes_to_persist {
        return Err("evidence-byte-readback-mismatch".to_string());
    }
    let evidence_sha256 = sha256_hex(&persisted_bytes);

    if fault == FaultMode::SwallowAck {
        return Ok(());
    }
    if fault == FaultMode::CorruptAck {
        io::stdout()
            .lock()
            .write_all(b"{\"schema\":")
            .map_err(|error| format!("synthetic-corrupt-ack-write-failed: {error}"))?;
        io::stdout()
            .lock()
            .flush()
            .map_err(|error| format!("synthetic-corrupt-ack-flush-failed: {error}"))?;
        return Ok(());
    }

    let ack = serde_json::json!({
        "schema": RUNNER_ACK_SCHEMA,
        "evidencePath": request.evidence.path,
        "evidenceBytes": persisted_bytes.len(),
        "evidenceSha256": evidence_sha256,
        "processStartCount": evidence.process_start_count,
        "terminalState": evidence.terminal_state,
        "exitCodeKnown": evidence.exit_code_known,
        "exitCode": evidence.exit_code,
        "outputComplete": evidence.output_complete,
        "retryPerformed": false,
        "runnerPeakWorkingSetBytes": runner_peak_working_set_bytes()?,
    });
    let ack_bytes = canonical_json_bytes(&ack)?;
    io::stdout()
        .lock()
        .write_all(&ack_bytes)
        .map_err(|error| format!("ack-write-failed: {error}"))?;
    io::stdout()
        .lock()
        .flush()
        .map_err(|error| format!("ack-flush-failed: {error}"))?;
    Ok(())
}

fn load_and_validate_request(
    request_path: &Path,
) -> Result<(ProcessRequest, Vec<u8>, Vec<u8>, String), String> {
    let metadata = fs::symlink_metadata(request_path)
        .map_err(|error| format!("request-metadata-failed: {error}"))?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(
            "request-shape-refused: request must be a regular non-reparse file".to_string(),
        );
    }
    if metadata.len() == 0 || metadata.len() as usize > REQUEST_BYTES_MAX {
        return Err("request-size-refused".to_string());
    }
    let request_bytes =
        fs::read(request_path).map_err(|error| format!("request-read-failed: {error}"))?;
    if request_bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err("request-bom-refused".to_string());
    }
    std::str::from_utf8(&request_bytes).map_err(|_| "request-utf8-refused".to_string())?;
    let value: Value = serde_json::from_slice(&request_bytes)
        .map_err(|error| format!("request-json-refused: {error}"))?;
    if canonical_json_bytes(&value)? != request_bytes {
        return Err("request-canonical-bytes-refused".to_string());
    }
    let request: ProcessRequest = serde_json::from_value(value)
        .map_err(|error| format!("request-schema-refused: {error}"))?;
    let stdin_bytes = validate_request(&request)?;
    let request_sha256 = sha256_hex(&request_bytes);
    Ok((request, request_bytes, stdin_bytes, request_sha256))
}

fn validate_request(request: &ProcessRequest) -> Result<Vec<u8>, String> {
    let stdin_bytes = validate_static_request(request)?;
    validate_runtime_paths(request)?;
    Ok(stdin_bytes)
}

fn validate_static_request(request: &ProcessRequest) -> Result<Vec<u8>, String> {
    if request.schema != PROCESS_REQUEST_SCHEMA
        || !request.one_shot
        || request.retry_authorized
        || !is_uppercase_uuid_v4(&request.operation_id)
    {
        return Err("request-identity-refused".to_string());
    }
    if request.containment.consumer != PROCESS_CONSUMER
        || !request.containment.require_canonical_paths
        || !request.attempt_marker.create_new
        || !request.evidence.create_new
        || request.evidence.schema != PROCESS_EVIDENCE_SCHEMA
    {
        return Err("request-policy-refused".to_string());
    }
    validate_limits(&request.limits)?;
    validate_hash(&request.executable.sha256, "executable")?;
    validate_hash(&request.stdin.sha256, "stdin")?;
    validate_canonical_windows_path(&request.executable.path, "executable")?;
    validate_canonical_windows_path(&request.containment.operation_root, "operation-root")?;
    validate_canonical_windows_path(&request.attempt_marker.path, "attempt-marker")?;
    validate_canonical_windows_path(&request.evidence.path, "evidence")?;
    let lexical_root = Path::new(&request.containment.operation_root);
    let lexical_marker = Path::new(&request.attempt_marker.path);
    let lexical_evidence = Path::new(&request.evidence.path);
    if lexical_marker
        .parent()
        .is_none_or(|parent| !windows_paths_equal(parent, lexical_root))
        || lexical_evidence
            .parent()
            .is_none_or(|parent| !windows_paths_equal(parent, lexical_root))
        || windows_paths_equal(lexical_marker, lexical_evidence)
        || windows_paths_equal(Path::new(&request.executable.path), lexical_evidence)
    {
        return Err("path-containment-refused".to_string());
    }

    if request.argv.is_empty() || request.argv.len() > 64 {
        return Err("argv-cardinality-refused".to_string());
    }
    for argument in &request.argv {
        if argument.len() > 4_096
            || argument
                .chars()
                .any(|character| matches!(character, '\0' | '\r' | '\n'))
        {
            return Err("argv-element-refused".to_string());
        }
    }
    if request.stdin.encoding != "base64" {
        return Err("stdin-encoding-refused".to_string());
    }
    let stdin_bytes = BASE64
        .decode(&request.stdin.base64)
        .map_err(|_| "stdin-base64-refused".to_string())?;
    if BASE64.encode(&stdin_bytes) != request.stdin.base64
        || stdin_bytes.len() as u64 != request.stdin.bytes
        || stdin_bytes.len() > STDIN_BYTES_MAX
        || sha256_hex(&stdin_bytes) != request.stdin.sha256
    {
        return Err("stdin-binding-refused".to_string());
    }
    validate_environment(&request.environment, &request.executable.path)?;
    Ok(stdin_bytes)
}

fn validate_limits(limits: &LimitBinding) -> Result<(), String> {
    if limits.request_bytes_max != REQUEST_BYTES_MAX as u64
        || limits.stdin_bytes_max != STDIN_BYTES_MAX as u64
        || limits.stdout_bytes_max != STDOUT_BYTES_MAX as u64
        || limits.stderr_bytes_max != STDERR_BYTES_MAX as u64
        || limits.evidence_bytes_max != EVIDENCE_BYTES_MAX as u64
        || limits.concurrency_max != 1
        || limits.child_process_max != 1
        || !(1_000..=120_000).contains(&limits.deadline_ms)
        || limits.aggregate_deadline_ms != AGGREGATE_DEADLINE_MS
        || limits.memory_bytes_max != MEMORY_BYTES_MAX
        || limits.cpu_percent_max != CPU_PERCENT_MAX
    {
        return Err("limit-binding-refused".to_string());
    }
    Ok(())
}

fn validate_environment(environment: &EnvironmentBinding, executable: &str) -> Result<(), String> {
    if environment.inherit {
        return Err("environment-inheritance-refused".to_string());
    }
    let windows_names = ["SystemRoot", "WINDIR"];
    if windows_names.iter().any(|name| {
        environment.allowlist.iter().any(|entry| entry == name)
            || environment.values.contains_key(*name)
    }) {
        if executable != r"C:\Program Files\WSL\wsl.exe"
            || environment.allowlist != windows_names
            || environment.values.len() != windows_names.len()
            || windows_names.iter().any(|name| {
                environment.values.get(*name).map(String::as_str) != Some(r"C:\Windows")
            })
        {
            return Err("wsl-environment-binding-refused".to_string());
        }
        return Ok(());
    }
    let permitted: BTreeSet<&str> = ["LANG", "LC_ALL", "NO_COLOR", "RM0032_FIXTURE_MODE"]
        .into_iter()
        .collect();
    let mut previous: Option<&str> = None;
    let mut allowlist = BTreeSet::new();
    for name in &environment.allowlist {
        if !permitted.contains(name.as_str()) || is_sensitive_environment_name(name) {
            return Err("environment-name-refused".to_string());
        }
        if previous.is_some_and(|prior| prior >= name.as_str()) || !allowlist.insert(name.as_str())
        {
            return Err("environment-order-refused".to_string());
        }
        previous = Some(name);
    }
    let value_names: BTreeSet<&str> = environment.values.keys().map(String::as_str).collect();
    if value_names != allowlist {
        return Err("environment-value-set-refused".to_string());
    }
    for value in environment.values.values() {
        if value.len() > 4_096
            || value
                .chars()
                .any(|character| matches!(character, '\0' | '\r' | '\n'))
        {
            return Err("environment-value-refused".to_string());
        }
    }
    Ok(())
}

fn validate_runtime_paths(request: &ProcessRequest) -> Result<(), String> {
    let executable = Path::new(&request.executable.path);
    let executable_metadata = fs::symlink_metadata(executable)
        .map_err(|error| format!("executable-metadata-refused: {error}"))?;
    if !executable_metadata.is_file() || is_reparse(&executable_metadata) {
        return Err("executable-shape-refused".to_string());
    }
    let executable_resolved = fs::canonicalize(executable)
        .map_err(|error| format!("executable-resolve-refused: {error}"))?;
    if !windows_paths_equal(&executable_resolved, executable) {
        return Err("executable-reparse-refused".to_string());
    }
    if sha256_file(executable)? != request.executable.sha256 {
        return Err("executable-hash-refused".to_string());
    }

    let root = Path::new(&request.containment.operation_root);
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("operation-root-metadata-refused: {error}"))?;
    if !root_metadata.is_dir() || is_reparse(&root_metadata) {
        return Err("operation-root-shape-refused".to_string());
    }
    let root_resolved = fs::canonicalize(root)
        .map_err(|error| format!("operation-root-resolve-refused: {error}"))?;
    if !windows_paths_equal(&root_resolved, root) {
        return Err("operation-root-reparse-refused".to_string());
    }
    let marker = Path::new(&request.attempt_marker.path);
    let evidence = Path::new(&request.evidence.path);
    for (label, path) in [("attempt-marker", marker), ("evidence", evidence)] {
        if path
            .parent()
            .is_none_or(|parent| !windows_paths_equal(parent, root))
        {
            return Err(format!("{label}-containment-refused"));
        }
        match fs::symlink_metadata(path) {
            Ok(_) => return Err(format!("{label}-exists-refused")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{label}-absence-unknown: {error}")),
        }
    }
    if windows_paths_equal(marker, evidence) || windows_paths_equal(executable, evidence) {
        return Err("path-role-collision-refused".to_string());
    }
    Ok(())
}

fn execute_child(
    request: &ProcessRequest,
    stdin_bytes: &[u8],
    fault: FaultMode,
) -> Result<ProcessOutcome, String> {
    let started_utc = utc_now()?;
    let job_result = if fault == FaultMode::JobCreateRefusal {
        Err("synthetic-job-create-refusal".to_string())
    } else {
        Job::create(request)
    };
    let job = match job_result {
        Ok(job) => job,
        Err(error) => {
            return resource_control_refusal_outcome(started_utc, 0, error);
        }
    };
    let mut command = Command::new(&request.executable.path);
    command
        .args(&request.argv)
        .current_dir(&request.containment.operation_root)
        .env_clear()
        .envs(&request.environment.values)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let finished_utc = utc_now()?;
            return Ok(ProcessOutcome {
                started_utc,
                finished_utc,
                process_start_count: 0,
                terminal_state: "spawn-refused".to_string(),
                exit_code_known: false,
                exit_code: None,
                standard_output: complete_stream(Vec::new()),
                standard_error: complete_stream(format!("spawn-refused: {error}").into_bytes()),
            });
        }
    };

    if let Err(error) = job.assign(&child, fault) {
        return terminate_unassigned_suspended_child(&mut child, started_utc, error, fault);
    }

    if fault == FaultMode::ResumeRefusal {
        terminate_owned_child(&job, &mut child)?;
        let _ = wait_for_owned_child(&mut child, Duration::from_secs(5))?;
        return resource_control_refusal_outcome(
            started_utc,
            1,
            "synthetic-resume-refusal".to_string(),
        );
    }
    if let Err(error) = resume_suspended_primary_thread(&child) {
        terminate_owned_child(&job, &mut child)?;
        let _ = wait_for_owned_child(&mut child, Duration::from_secs(5))?;
        return resource_control_refusal_outcome(started_utc, 1, error);
    }

    if fault == FaultMode::StartUncertainty {
        terminate_owned_child(&job, &mut child)?;
        let _ = wait_for_owned_child(&mut child, Duration::from_secs(5))?;
        return Ok(ProcessOutcome {
            started_utc,
            finished_utc: utc_now()?,
            process_start_count: 1,
            terminal_state: "unknown".to_string(),
            exit_code_known: false,
            exit_code: None,
            standard_output: complete_stream(Vec::new()),
            standard_error: complete_stream(b"synthetic-start-uncertainty".to_vec()),
        });
    }

    if fault == FaultMode::WaitUncertainty {
        terminate_owned_child(&job, &mut child)?;
        let _ = wait_for_owned_child(&mut child, Duration::from_secs(5))?;
        return Ok(ProcessOutcome {
            started_utc,
            finished_utc: utc_now()?,
            process_start_count: 1,
            terminal_state: "unknown".to_string(),
            exit_code_known: false,
            exit_code: None,
            standard_output: complete_stream(Vec::new()),
            standard_error: complete_stream(b"synthetic-wait-uncertainty".to_vec()),
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child-stdout-missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "child-stderr-missing".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "child-stdin-missing".to_string())?;
    let stdout_exceeded = Arc::new(AtomicBool::new(false));
    let stderr_exceeded = Arc::new(AtomicBool::new(false));
    let stdout_thread = spawn_capture(stdout, STDOUT_BYTES_MAX, Arc::clone(&stdout_exceeded));
    let stderr_thread = spawn_capture(stderr, STDERR_BYTES_MAX, Arc::clone(&stderr_exceeded));
    let stdin_owned = stdin_bytes.to_vec();
    let stdin_thread = thread::spawn(move || -> io::Result<()> {
        let mut handle = stdin;
        handle.write_all(&stdin_owned)?;
        handle.flush()?;
        Ok(())
    });

    let deadline = Instant::now() + Duration::from_millis(request.limits.deadline_ms);
    let mut terminal_override: Option<&'static str> = None;
    let mut known_status = None;
    loop {
        if stdout_exceeded.load(Ordering::SeqCst) {
            terminal_override = Some("stdout-cap-killed");
            terminate_owned_child(&job, &mut child)?;
            break;
        }
        if stderr_exceeded.load(Ordering::SeqCst) {
            terminal_override = Some("stderr-cap-killed");
            terminate_owned_child(&job, &mut child)?;
            break;
        }
        if Instant::now() >= deadline {
            terminal_override = Some("deadline-killed");
            terminate_owned_child(&job, &mut child)?;
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                known_status = Some(status);
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(2)),
            Err(error) => {
                terminal_override = Some("unknown");
                terminate_owned_child(&job, &mut child)?;
                let _ = error;
                break;
            }
        }
    }
    if known_status.is_none() {
        known_status = wait_for_owned_child(&mut child, Duration::from_secs(5))?;
    }

    let stdin_result = stdin_thread
        .join()
        .map_err(|_| "stdin-thread-panicked".to_string())?;
    let standard_output = stdout_thread
        .join()
        .map_err(|_| "stdout-thread-panicked".to_string())??;
    let standard_error = stderr_thread
        .join()
        .map_err(|_| "stderr-thread-panicked".to_string())??;
    let finished_utc = utc_now()?;

    if stdin_result.is_err() && terminal_override.is_none() {
        terminal_override = Some("unknown");
    }
    let (terminal_state, exit_code_known, exit_code) = if let Some(state) = terminal_override {
        (state.to_string(), false, None)
    } else if let Some(status) = known_status {
        match status.code() {
            Some(code) => ("known-exit".to_string(), true, Some(code)),
            None => ("unknown".to_string(), false, None),
        }
    } else {
        ("unknown".to_string(), false, None)
    };
    Ok(ProcessOutcome {
        started_utc,
        finished_utc,
        process_start_count: 1,
        terminal_state,
        exit_code_known,
        exit_code,
        standard_output,
        standard_error,
    })
}

fn spawn_capture<R: Read + Send + 'static>(
    mut reader: R,
    maximum: usize,
    exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<Result<CapturedStream, String>> {
    thread::spawn(move || {
        let mut captured = Vec::with_capacity(maximum.min(65_536));
        let mut buffer = [0_u8; 8192];
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| format!("stream-read-failed: {error}"))?;
            if count == 0 {
                return Ok(CapturedStream {
                    bytes: captured,
                    complete: !exceeded.load(Ordering::SeqCst),
                    truncated: exceeded.load(Ordering::SeqCst),
                });
            }
            let remaining = maximum.saturating_sub(captured.len());
            let retained = count.min(remaining);
            captured.extend_from_slice(&buffer[..retained]);
            if retained < count {
                exceeded.store(true, Ordering::SeqCst);
                return Ok(CapturedStream {
                    bytes: captured,
                    complete: false,
                    truncated: true,
                });
            }
        }
    })
}

fn terminate_owned_child(job: &Job, child: &mut Child) -> Result<(), String> {
    if !job.terminate(0xE003_0032) {
        child
            .kill()
            .map_err(|error| format!("owned-child-termination-failed: {error}"))?;
    }
    Ok(())
}

fn resource_control_refusal_outcome(
    started_utc: String,
    process_start_count: u64,
    error: String,
) -> Result<ProcessOutcome, String> {
    Ok(ProcessOutcome {
        started_utc,
        finished_utc: utc_now()?,
        process_start_count,
        terminal_state: "resource-control-refused".to_string(),
        exit_code_known: false,
        exit_code: None,
        standard_output: complete_stream(Vec::new()),
        standard_error: complete_stream(format!("resource-control-refused: {error}").into_bytes()),
    })
}

fn terminate_unassigned_suspended_child(
    child: &mut Child,
    started_utc: String,
    resource_error: String,
    fault: FaultMode,
) -> Result<ProcessOutcome, String> {
    if matches!(
        fault,
        FaultMode::UnassignedKillUncertainty | FaultMode::UnassignedWaitUncertainty
    ) {
        child
            .kill()
            .map_err(|error| format!("fixture-safety-kill-failed: {error}"))?;
        match wait_for_owned_child(child, Duration::from_secs(5))? {
            Some(_) => {}
            None => return Err("fixture-safety-wait-incomplete".to_string()),
        }
        let injected_detail = match fault {
            FaultMode::UnassignedKillUncertainty => {
                "synthetic-unassigned-child-kill-result-unknown"
            }
            FaultMode::UnassignedWaitUncertainty => {
                "synthetic-unassigned-child-wait-result-unknown"
            }
            _ => unreachable!(),
        };
        return unknown_pre_execution_outcome(
            started_utc,
            format!(
                "resource-control-refused: {resource_error}; {injected_detail}; fixture-safety-teardown-observed"
            ),
        );
    }
    if let Err(kill_error) = child.kill() {
        return unknown_pre_execution_outcome(
            started_utc,
            format!(
                "resource-control-refused: {resource_error}; unassigned-child-kill-unknown: {kill_error}"
            ),
        );
    }
    match wait_for_owned_child(child, Duration::from_secs(5)) {
        Ok(Some(_)) => resource_control_refusal_outcome(started_utc, 1, resource_error),
        Ok(None) => unknown_pre_execution_outcome(
            started_utc,
            format!("resource-control-refused: {resource_error}; unassigned-child-wait-unknown"),
        ),
        Err(wait_error) => unknown_pre_execution_outcome(
            started_utc,
            format!(
                "resource-control-refused: {resource_error}; unassigned-child-wait-unknown: {wait_error}"
            ),
        ),
    }
}

fn unknown_pre_execution_outcome(
    started_utc: String,
    detail: String,
) -> Result<ProcessOutcome, String> {
    Ok(ProcessOutcome {
        started_utc,
        finished_utc: utc_now()?,
        process_start_count: 1,
        terminal_state: "unknown".to_string(),
        exit_code_known: false,
        exit_code: None,
        standard_output: incomplete_stream(Vec::new()),
        standard_error: CapturedStream {
            bytes: detail.into_bytes(),
            complete: false,
            truncated: true,
        },
    })
}

fn resume_suspended_primary_thread(child: &Child) -> Result<(), String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "thread-snapshot-failed: {}",
            io::Error::last_os_error()
        ));
    }
    let snapshot = ScopedHandle { handle: snapshot };
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let first = unsafe { Thread32First(snapshot.handle, &mut entry) };
    if first == 0 {
        return Err(format!(
            "thread-snapshot-first-failed: {}",
            io::Error::last_os_error()
        ));
    }
    let mut owned_thread_ids = Vec::new();
    loop {
        if entry.th32OwnerProcessID == child.id() {
            owned_thread_ids.push(entry.th32ThreadID);
        }
        let next = unsafe { Thread32Next(snapshot.handle, &mut entry) };
        if next == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_NO_MORE_FILES {
                return Err(format!("thread-snapshot-next-failed: win32={code}"));
            }
            break;
        }
    }
    if owned_thread_ids.len() != 1 {
        return Err(format!(
            "suspended-primary-thread-cardinality-refused: {}",
            owned_thread_ids.len()
        ));
    }
    let thread_handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, owned_thread_ids[0]) };
    if thread_handle.is_null() {
        return Err(format!(
            "suspended-primary-thread-open-failed: {}",
            io::Error::last_os_error()
        ));
    }
    let thread_handle = ScopedHandle {
        handle: thread_handle,
    };
    let previous_suspend_count = unsafe { ResumeThread(thread_handle.handle) };
    if previous_suspend_count == u32::MAX {
        return Err(format!(
            "suspended-primary-thread-resume-failed: {}",
            io::Error::last_os_error()
        ));
    }
    if previous_suspend_count != 1 {
        return Err(format!(
            "suspended-primary-thread-count-refused: {previous_suspend_count}"
        ));
    }
    Ok(())
}

fn wait_for_owned_child(
    child: &mut Child,
    maximum: Duration,
) -> Result<Option<std::process::ExitStatus>, String> {
    let deadline = Instant::now() + maximum;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(2)),
            Ok(None) => return Err("owned-child-terminal-state-unknown".to_string()),
            Err(error) => return Err(format!("owned-child-wait-failed: {error}")),
        }
    }
}

struct Job {
    handle: HANDLE,
}

struct SidecarAdmission {
    handle: HANDLE,
}

impl SidecarAdmission {
    fn acquire() -> Result<Self, String> {
        let name: Vec<u16> = "Local\\DecadansRm0032Phase3RunnerV1"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe { CreateMutexW(null(), 1, name.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "sidecar-admission-create-failed: {}",
                io::Error::last_os_error()
            ));
        }
        let last_error = unsafe { GetLastError() };
        if last_error == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            }
            return Err("sidecar-concurrency-refused".to_string());
        }
        Ok(Self { handle })
    }
}

impl Drop for SidecarAdmission {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                ReleaseMutex(self.handle);
                CloseHandle(self.handle);
            }
        }
    }
}

struct ScopedHandle {
    handle: HANDLE,
}

impl Drop for ScopedHandle {
    fn drop(&mut self) {
        if self.handle != INVALID_HANDLE_VALUE && !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

impl Job {
    fn create(request: &ProcessRequest) -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(format!("job-create-failed: {}", io::Error::last_os_error()));
        }
        let job = Self { handle };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.ProcessMemoryLimit = request.limits.memory_bytes_max as usize;
        let limits_set = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if limits_set == 0 {
            return Err(format!("job-limit-failed: {}", io::Error::last_os_error()));
        }
        let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            ..Default::default()
        };
        cpu.Anonymous.CpuRate = (request.limits.cpu_percent_max * 100) as u32;
        let cpu_set = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectCpuRateControlInformation,
                &cpu as *const _ as *const c_void,
                size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
            )
        };
        if cpu_set == 0 {
            return Err(format!(
                "job-cpu-limit-failed: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(job)
    }

    fn assign(&self, child: &Child, fault: FaultMode) -> Result<(), String> {
        if matches!(
            fault,
            FaultMode::ResourceControlRefusal
                | FaultMode::UnassignedKillUncertainty
                | FaultMode::UnassignedWaitUncertainty
        ) {
            return Err("synthetic-resource-control-refusal".to_string());
        }
        let process_handle = child.as_raw_handle() as HANDLE;
        let assigned = unsafe { AssignProcessToJobObject(self.handle, process_handle) };
        if assigned == 0 {
            return Err(format!("job-assign-failed: {}", io::Error::last_os_error()));
        }
        Ok(())
    }

    fn terminate(&self, code: u32) -> bool {
        unsafe { TerminateJobObject(self.handle, code) != 0 }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

fn complete_stream(bytes: Vec<u8>) -> CapturedStream {
    CapturedStream {
        bytes,
        complete: true,
        truncated: false,
    }
}

fn incomplete_stream(bytes: Vec<u8>) -> CapturedStream {
    CapturedStream {
        bytes,
        complete: false,
        truncated: true,
    }
}

fn raw_stream_evidence(stream: CapturedStream) -> RawStreamEvidence {
    RawStreamEvidence {
        base64: BASE64.encode(&stream.bytes),
        bytes: stream.bytes.len() as u64,
        sha256: sha256_hex(&stream.bytes),
        complete: stream.complete,
        truncated: stream.truncated,
    }
}

fn validate_evidence_invariants(evidence: &ProcessEvidence) -> Result<(), String> {
    if evidence.retry_performed || evidence.cleanup_performed || evidence.process_start_count > 1 {
        return Err("evidence-one-shot-invariant-failed".to_string());
    }
    if evidence.output_complete
        != (evidence.standard_output.complete && evidence.standard_error.complete)
        || evidence.standard_output.complete == evidence.standard_output.truncated
        || evidence.standard_error.complete == evidence.standard_error.truncated
    {
        return Err("evidence-output-invariant-failed".to_string());
    }
    if evidence.terminal_state == "known-exit" {
        if evidence.process_start_count != 1
            || !evidence.exit_code_known
            || evidence.exit_code.is_none()
            || !evidence.output_complete
        {
            return Err("evidence-known-exit-invariant-failed".to_string());
        }
    } else if evidence.exit_code_known || evidence.exit_code.is_some() {
        return Err("evidence-unknown-exit-invariant-failed".to_string());
    }
    match evidence.terminal_state.as_str() {
        "known-exit" => {}
        "spawn-refused" | "containment-refused" if evidence.process_start_count == 0 => {}
        "resource-control-refused" if evidence.process_start_count <= 1 => {}
        "deadline-killed" | "stdout-cap-killed" | "stderr-cap-killed" | "unknown"
            if evidence.process_start_count == 1 => {}
        _ => return Err("evidence-terminal-start-invariant-failed".to_string()),
    }
    Ok(())
}

fn create_new_durable(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("{label}-create-new-failed: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("{label}-write-failed: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("{label}-flush-failed: {error}"))?;
    let observed = file
        .metadata()
        .map_err(|error| format!("{label}-metadata-failed: {error}"))?
        .len() as usize;
    if observed != bytes.len() {
        return Err(format!(
            "{label}-size-mismatch: {observed} != {}",
            bytes.len()
        ));
    }
    Ok(())
}

fn validate_hash(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{label}-sha256-format-refused"));
    }
    Ok(())
}

fn validate_canonical_windows_path(value: &str, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_uppercase()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || value.contains('/')
        || value.chars().any(|character| character <= '\u{001f}')
        || value.starts_with("\\\\")
        || Path::new(value)
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        || Path::new(value)
            .components()
            .collect::<PathBuf>()
            .to_string_lossy()
            != value
    {
        return Err(format!("{label}-canonical-path-refused"));
    }
    Ok(())
}

fn windows_paths_equal(left: &Path, right: &Path) -> bool {
    normalize_windows_path(left).eq_ignore_ascii_case(&normalize_windows_path(right))
}

fn normalize_windows_path(path: &Path) -> String {
    path.to_string_lossy()
        .strip_prefix("\\\\?\\")
        .unwrap_or(&path.to_string_lossy())
        .replace('/', "\\")
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("hash-open-failed: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("hash-read-failed: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let bytes = digest.finalize();
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn is_sensitive_environment_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "TOKEN",
        "KEY",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "SESSION",
        "COOKIE",
        "TELEGRAM",
        "CREDENTIAL",
        "AUTH",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn is_uppercase_uuid_v4(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    for (index, byte) in value.bytes().enumerate() {
        match index {
            8 | 13 | 18 | 23 if byte == b'-' => {}
            14 if byte == b'4' => {}
            19 if matches!(byte, b'8' | b'9' | b'A' | b'B') => {}
            8 | 13 | 18 | 23 | 14 | 19 => return false,
            _ if byte.is_ascii_digit() || matches!(byte, b'A'..=b'F') => {}
            _ => return false,
        }
    }
    true
}

fn utc_now() -> Result<String, String> {
    let mut file_time = FILETIME::default();
    unsafe {
        GetSystemTimePreciseAsFileTime(&mut file_time);
    }
    let mut system_time = SYSTEMTIME::default();
    let converted = unsafe { FileTimeToSystemTime(&file_time, &mut system_time) };
    if converted == 0 {
        return Err(format!("utc-clock-failed: {}", io::Error::last_os_error()));
    }
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        system_time.wYear,
        system_time.wMonth,
        system_time.wDay,
        system_time.wHour,
        system_time.wMinute,
        system_time.wSecond,
        system_time.wMilliseconds
    ))
}

fn runner_peak_working_set_bytes() -> Result<u64, String> {
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    let result = unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if result == 0 {
        return Err(format!(
            "working-set-read-failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(counters.PeakWorkingSetSize as u64)
}

fn run_contract_vector(fixture_path: &Path) -> Result<(), String> {
    let fixture_bytes =
        fs::read(fixture_path).map_err(|error| format!("fixture-read-failed: {error}"))?;
    let fixture: Value = serde_json::from_slice(&fixture_bytes)
        .map_err(|error| format!("fixture-json-failed: {error}"))?;
    let vector = fixture
        .get("vectors")
        .and_then(Value::as_array)
        .and_then(|vectors| vectors.first())
        .ok_or_else(|| "fixture-vector-missing".to_string())?;
    let request = vector
        .get("request")
        .ok_or_else(|| "fixture-request-missing".to_string())?;
    let canonical_request = canonical_json_bytes(request)?;
    let request_hash = sha256_hex(&canonical_request);

    let expected_bytes = vector
        .get("canonicalRequestBytes")
        .and_then(Value::as_u64)
        .ok_or_else(|| "fixture-expected-bytes-missing".to_string())?;
    let expected_hash = vector
        .get("canonicalRequestSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "fixture-expected-hash-missing".to_string())?;
    if canonical_request.len() as u64 != expected_bytes || request_hash != expected_hash {
        return Err("fixture-canonical-binding-mismatch".to_string());
    }

    let accepted: ProcessRequest = serde_json::from_value(request.clone())
        .map_err(|error| format!("fixture-request-schema-failed: {error}"))?;
    validate_static_request(&accepted)
        .map_err(|error| format!("fixture-accepted-vector-refused: {error}"))?;
    let refusal_vectors = fixture
        .get("refusalVectors")
        .and_then(Value::as_array)
        .ok_or_else(|| "fixture-refusal-vectors-missing".to_string())?;
    for vector in refusal_vectors {
        let mut candidate = request.clone();
        apply_fixture_mutation(&mut candidate, vector)?;
        let refused = serde_json::from_value::<ProcessRequest>(candidate)
            .map_err(|error| format!("schema-refused: {error}"))
            .and_then(|parsed| validate_static_request(&parsed));
        if refused.is_ok() {
            return Err(format!(
                "fixture-refusal-vector-accepted: {}",
                vector
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            ));
        }
    }

    let result = Value::Object(Map::from_iter([
        (
            "canonicalRequestBytes".to_string(),
            Value::from(canonical_request.len() as u64),
        ),
        (
            "canonicalRequestSha256".to_string(),
            Value::String(request_hash),
        ),
        (
            "refusalVectorCount".to_string(),
            Value::from(refusal_vectors.len() as u64),
        ),
        (
            "schema".to_string(),
            Value::String(CONTRACT_VECTOR_RESULT_SCHEMA.to_string()),
        ),
    ]));
    let bytes = canonical_json_bytes(&result)?;
    io::stdout()
        .lock()
        .write_all(&bytes)
        .map_err(|error| format!("stdout-write-failed: {error}"))?;
    io::stdout()
        .lock()
        .flush()
        .map_err(|error| format!("stdout-flush-failed: {error}"))?;
    Ok(())
}

fn apply_fixture_mutation(candidate: &mut Value, vector: &Value) -> Result<(), String> {
    let action = vector
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "fixture-mutation-action-missing".to_string())?;
    let path = vector
        .get("path")
        .and_then(Value::as_array)
        .ok_or_else(|| "fixture-mutation-path-missing".to_string())?;
    if path.is_empty() {
        return Err("fixture-mutation-path-empty".to_string());
    }
    let mut parent = candidate;
    for segment in &path[..path.len() - 1] {
        let key = segment
            .as_str()
            .ok_or_else(|| "fixture-mutation-segment-invalid".to_string())?;
        parent = parent
            .get_mut(key)
            .ok_or_else(|| format!("fixture-mutation-parent-missing: {key}"))?;
    }
    let leaf = path[path.len() - 1]
        .as_str()
        .ok_or_else(|| "fixture-mutation-leaf-invalid".to_string())?;
    let record = parent
        .as_object_mut()
        .ok_or_else(|| "fixture-mutation-parent-not-object".to_string())?;
    match action {
        "remove" => {
            if record.remove(leaf).is_none() {
                return Err("fixture-mutation-remove-missing".to_string());
            }
        }
        "add" | "replace" => {
            let replacement = vector
                .get("value")
                .cloned()
                .ok_or_else(|| "fixture-mutation-value-missing".to_string())?;
            if action == "replace" && !record.contains_key(leaf) {
                return Err("fixture-mutation-replace-missing".to_string());
            }
            if action == "add" && record.contains_key(leaf) {
                return Err("fixture-mutation-add-exists".to_string());
            }
            record.insert(leaf.to_string(), replacement);
        }
        _ => return Err("fixture-mutation-action-refused".to_string()),
    }
    Ok(())
}

fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    write_canonical_json(value, &mut output)?;
    Ok(output)
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), String> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(boolean) => output.extend_from_slice(if *boolean { b"true" } else { b"false" }),
        Value::Number(number) => {
            if number.as_i64().is_none() && number.as_u64().is_none() {
                return Err("canonical-number-refused: only integers are supported".to_string());
            }
            output.extend_from_slice(number.to_string().as_bytes());
        }
        Value::String(text) => output.extend_from_slice(
            serde_json::to_string(text)
                .map_err(|error| format!("canonical-string-failed: {error}"))?
                .as_bytes(),
        ),
        Value::Array(values) => {
            output.push(b'[');
            for (index, entry) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write_canonical_json(entry, output)?;
            }
            output.push(b']');
        }
        Value::Object(record) => {
            output.push(b'{');
            let mut keys: Vec<&String> = record.keys().collect();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|error| format!("canonical-key-failed: {error}"))?
                        .as_bytes(),
                );
                output.push(b':');
                write_canonical_json(&record[key], output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod wsl_environment_tests {
    use super::*;

    fn fixed() -> EnvironmentBinding {
        EnvironmentBinding {
            inherit: false,
            allowlist: vec!["SystemRoot".into(), "WINDIR".into()],
            values: BTreeMap::from([
                ("SystemRoot".into(), r"C:\Windows".into()),
                ("WINDIR".into(), r"C:\Windows".into()),
            ]),
        }
    }

    #[test]
    fn fixed_pair_is_bound_to_vendor_wsl_without_inheritance() {
        let wsl = r"C:\Program Files\WSL\wsl.exe";
        assert!(validate_environment(&fixed(), wsl).is_ok());
        for other in [r"C:\Windows\System32\wsl.exe", r"C:\Program Files\Git\mingw64\bin\git.exe"] {
            assert!(validate_environment(&fixed(), other).is_err());
        }
        let mut inherited = fixed();
        inherited.inherit = true;
        assert!(validate_environment(&inherited, wsl).is_err());
        for value in [r"D:\Windows", "C:\\Windows\0", "C:\\Windows\n", ""] {
            let mut changed = fixed();
            changed.values.insert("SystemRoot".into(), value.into());
            assert!(validate_environment(&changed, wsl).is_err());
        }
    }

    #[test]
    fn partial_extra_duplicate_and_misordered_pairs_are_refused() {
        let wsl = r"C:\Program Files\WSL\wsl.exe";
        let mut missing = fixed();
        missing.values.remove("WINDIR");
        assert!(validate_environment(&missing, wsl).is_err());
        let mut single = fixed();
        single.allowlist.pop();
        single.values.remove("WINDIR");
        assert!(validate_environment(&single, wsl).is_err());
        let mut extra = fixed();
        extra.allowlist.insert(0, "LANG".into());
        extra.values.insert("LANG".into(), "C".into());
        assert!(validate_environment(&extra, wsl).is_err());
        let mut reversed = fixed();
        reversed.allowlist.reverse();
        assert!(validate_environment(&reversed, wsl).is_err());
        let mut duplicate = fixed();
        duplicate.allowlist.push("WINDIR".into());
        assert!(validate_environment(&duplicate, wsl).is_err());
        let empty = EnvironmentBinding { inherit: false, allowlist: vec![], values: BTreeMap::new() };
        assert!(validate_environment(&empty, wsl).is_ok());
    }
}
